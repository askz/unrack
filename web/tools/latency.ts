// Round-trip latency of the production transport against a real DSP, per request kind:
// a status query, a meter poll, and a gain write (Out 1 rewritten with its current value,
// so nothing audible changes). Through the ESP32 bridge it also reports how much of each
// round trip the bridge spent on USB (write) and waiting for the DSP (reply), from
// /api/health; the rest is Wi-Fi and the bridge's own queues.
//
//   npm run hw:latency -- /dev/hidrawN
//   OPENDSP_TOKEN=… npm run hw:latency -- ws://opendsp.local/ws [count]
import { RequestChannel } from "../src/transport/channel.ts";
import { Dsp } from "../src/dsp.ts";
import { gainRawToDb, getStatusFrame } from "../src/protocol/control.ts";
import { TARGET_USAGE, linkFor } from "./links.ts";

const OUT1 = 0x04;
const DEFAULT_COUNT = 200;

const target = process.argv[2];
const count = Number(process.argv[3] ?? DEFAULT_COUNT);
if (!target || !Number.isInteger(count) || count < 1) {
  console.error(`usage: latency ${TARGET_USAGE} [count]`);
  process.exit(2);
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

interface GateTotals { ok: number; writeMs: number; replyMs: number }

/** Cumulative gate timing of the bridge, or null for a hidraw target. */
async function gateTotals(): Promise<GateTotals | null> {
  if (!/^wss?:\/\//.test(target!)) return null;
  const url = new URL("/api/health", target!.replace(/^ws/, "http"));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.OPENDSP_TOKEN?.trim()}` } });
  const { transactions } = (await response.json()) as { transactions: { ok: number; meanWriteMs?: number; meanReplyMs?: number } };
  return {
    ok: transactions.ok,
    writeMs: (transactions.meanWriteMs ?? 0) * transactions.ok,
    replyMs: (transactions.meanReplyMs ?? 0) * transactions.ok,
  };
}

async function measure(label: string, run: () => Promise<unknown>): Promise<void> {
  const before = await gateTotals();
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((sum, x) => sum + x, 0) / samples.length;
  const fmt = (ms: number) => ms.toFixed(1).padStart(6);
  console.log(`${label.padEnd(12)} mean ${fmt(mean)}  p50 ${fmt(percentile(samples, 0.5))}  p90 ${fmt(percentile(samples, 0.9))}  p99 ${fmt(percentile(samples, 0.99))}  max ${fmt(samples[samples.length - 1]!)} ms`);
  const after = await gateTotals();
  if (before && after && after.ok > before.ok) {
    const n = after.ok - before.ok;
    const write = (after.writeMs - before.writeMs) / n;
    const reply = (after.replyMs - before.replyMs) / n;
    console.log(`${"".padEnd(12)} bridge: USB write ${write.toFixed(1)} ms, DSP reply ${reply.toFixed(1)} ms, rest (Wi-Fi, queues) ${(mean - write - reply).toFixed(1)} ms`);
  }
}

async function main(): Promise<void> {
  const link = linkFor(target!);
  await link.open();
  const channel = new RequestChannel(link);
  const dsp = new Dsp(channel);
  try {
    await dsp.identify();
    const gainDb = gainRawToDb((await dsp.presetImage()).outputs[0]!.gainRaw);
    console.log(`${count} sequential requests each, via ${target}`);
    await measure("status", () => channel.request(getStatusFrame(), { attempts: 1 }));
    await measure("meters", () => dsp.levels());
    await measure("gain write", () => dsp.setLevelDb(OUT1, gainDb));
    console.log("stats:", JSON.stringify(channel.stats));
  } finally {
    channel.close();
    await link.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

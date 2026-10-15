// Hardware smoke test: runs the production transport stack (RequestChannel, Dsp,
// Connection) against a real DSP 4x4 Mini Pro through Linux hidraw, or through the
// ESP32 bridge over Wi-Fi.
//
//   npm run hw:smoke -- /dev/hidrawN
//   OPENDSP_TOKEN=… npm run hw:smoke -- ws://opendsp.local/ws
//
// It changes Out 1 gain and several EQ/dynamics/routing parameters during the test
// and restores them (undo), then re-recalls the active preset (discarding unsaved
// live edits).
import { Connection, type ConnectionPhase } from "../src/state/connection.ts";
import type { LinkProvider } from "../src/transport/platform.ts";
import type { Dsp } from "../src/dsp.ts";
import { gainRawToDb } from "../src/protocol/control.ts";
import { PeqType, Slope } from "../src/protocol/commands.ts";
import { defaultCalibration } from "../src/eq/calibration.ts";
import type { PeqBand } from "../src/eq/types.ts";
import { Editor, createEditorState } from "../src/state/editor.ts";
import { modelFromReadback } from "../src/state/hydrate.ts";
import { sameValue, type DeviceModel } from "../src/state/model.ts";
import { paramKey, readParam, type ParamRef, type ParamValue } from "../src/state/params.ts";
import { TARGET_USAGE, linkFor } from "./links.ts";

const OUT1 = 0x04;
const RAMP_STEPS = 60;

const target = process.argv[2];
if (!target) {
  console.error(`usage: hw-smoke ${TARGET_USAGE}`);
  process.exit(2);
}

const failures: string[] = [];
function check(condition: boolean, label: string): void {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures.push(label);
}

const since = (started: number) => `${(performance.now() - started).toFixed(0)} ms`;

async function out1GainDb(dsp: Dsp): Promise<number> {
  return gainRawToDb((await dsp.presetImage()).outputs[0]!.gainRaw);
}

async function main(): Promise<void> {
  const provider: LinkProvider = {
    supported: () => true,
    pick: async () => linkFor(target!),
    existing: async () => linkFor(target!),
    onAttach: () => () => {},
  };
  let syncMs = 0;
  const connection = new Connection(provider, {
    sync: async (dsp) => {
      const started = performance.now();
      await dsp.presetImage();
      await dsp.presetNames();
      await dsp.activePreset();
      syncMs = performance.now() - started;
    },
    started: () => {},
    ended: () => {},
  });
  const phases: ConnectionPhase[] = [];
  connection.onChange((snapshot) => {
    if (phases[phases.length - 1] !== snapshot.phase) phases.push(snapshot.phase);
  });

  try {
    await exercise(connection, phases, () => syncMs);
  } finally {
    await connection.dispose();
  }
}

async function exercise(connection: Connection, phases: ConnectionPhase[], syncMs: () => number): Promise<void> {
  let started = performance.now();
  await connection.connect();
  console.log(`connect: ${phases.join(" → ")} in ${since(started)} (sync ${syncMs().toFixed(0)} ms)`);
  check(connection.snapshot.phase === "ready", `connected (${connection.snapshot.error || connection.snapshot.info?.firmware})`);
  const dsp = connection.dsp;
  if (!dsp) return;

  const originalGain = await out1GainDb(dsp);
  console.log(`Out1 gain before: ${originalGain} dB`);

  // meters on the background lane while a fader-style burst goes on the control lane
  let metering = true;
  let meterPolls = 0;
  const meterLoop = (async () => {
    while (metering) {
      await dsp.levels();
      meterPolls++;
    }
  })();

  started = performance.now();
  const ramp = Array.from({ length: RAMP_STEPS }, (_, i) => -12 + (12 * i) / (RAMP_STEPS - 1));
  await Promise.all(ramp.map((db) => dsp.setLevelDb(OUT1, db)));
  const rampMs = performance.now() - started;
  const afterRamp = await out1GainDb(dsp);
  check(afterRamp === 0, `ramp of ${RAMP_STEPS} coalesced writes lands on the last value (${afterRamp} dB) in ${rampMs.toFixed(0)} ms`);

  await dsp.setLevelDb(OUT1, -6.5);
  check((await out1GainDb(dsp)) === -6.5, "single write reads back exactly (-6.5 dB)");
  await dsp.setLevelDb(OUT1, originalGain);
  check((await out1GainDb(dsp)) === originalGain, `gain restored to ${originalGain} dB`);

  metering = false;
  await meterLoop;
  check(meterPolls > 0, `meters kept polling during writes (${meterPolls} polls)`);

  await exerciseEditor(dsp);

  const slot = await dsp.activePreset();
  const retriesBefore = connection.snapshot.stats.retries;
  started = performance.now();
  await dsp.recallPreset(slot);
  const recallMs = performance.now() - started;
  check(connection.snapshot.stats.retries === retriesBefore, `recall preset ${slot + 1} acked in ${recallMs.toFixed(0)} ms without a re-send`);
  started = performance.now();
  await connection.resync();
  check(connection.snapshot.phase === "ready", `resync after recall in ${since(started)}`);

  const { stats } = connection.snapshot;
  console.log("stats:", JSON.stringify(stats));
  check(stats.failures === 0, "no failed transactions");
  check(stats.retries === 0, "no retries");
  check(stats.strayReports === 0 && stats.badReports === 0, "no stray or corrupt reports");
  check(stats.coalesced > 0, `writes coalesced (${stats.coalesced})`);
}

/** Readback of the parameters that the device reports (mute and PEQ bypass have no readback). */
function comparable(model: DeviceModel, ref: ParamRef): unknown {
  const value = readParam(model, ref);
  if (ref.kind === "peq" && value !== null) return { ...(value as PeqBand), bypass: undefined };
  return value;
}

const EDITS: { ref: ParamRef; value: ParamValue }[] = [
  { ref: { kind: "peq", ch: OUT1, band: 2 }, value: { freqHz: 1000, gainDb: -4.5, bwOct: 0.7, type: PeqType.PEAK, bypass: false } },
  { ref: { kind: "peq", ch: OUT1, band: 5 }, value: { freqHz: 7300, gainDb: 3.3, bwOct: 1.8, type: PeqType.HIGH_SHELF, bypass: false } },
  { ref: { kind: "hpf", ch: OUT1 }, value: { freqHz: 85, slope: Slope.LK24 } },
  { ref: { kind: "delay", ch: OUT1 }, value: 3.21 },
  { ref: { kind: "comp", ch: OUT1 }, value: { thresholdDb: -12.5, ratioIndex: 9, kneeDb: 3, attackMs: 20, releaseMs: 300 } },
  { ref: { kind: "gate", ch: 0 }, value: { thresholdDb: -70, attackMs: 5, holdMs: 50, releaseMs: 200 } },
  { ref: { kind: "gain", ch: 1 }, value: -9.7 },
  { ref: { kind: "routing", ch: OUT1 + 1 }, value: 0b0011 },
];

/** Edits through the Editor must read back from the device exactly as the model holds them; undo restores them. */
async function exerciseEditor(dsp: Dsp): Promise<void> {
  const initial = modelFromReadback(await dsp.presetImage(), defaultCalibration);
  const state = createEditorState(initial);
  const errors: string[] = [];
  const editor = new Editor(state, { dsp: () => dsp, cal: defaultCalibration, onError: (label) => errors.push(label) });

  const delivered = await Promise.all(EDITS.map(({ ref, value }) => editor.set(ref, value, { merge: false })));
  check(delivered.every(Boolean) && errors.length === 0, `${EDITS.length} editor writes acknowledged`);

  const afterEdit = modelFromReadback(await dsp.presetImage(), defaultCalibration);
  const mismatches = EDITS.filter(({ ref }) => !sameValue(comparable(afterEdit, ref), comparable(state.model, ref)));
  check(mismatches.length === 0, `device readback equals the editor model for every edit${mismatches.length ? ` (mismatch: ${mismatches.map((m) => paramKey(m.ref)).join(", ")})` : ""}`);
  for (const { ref } of mismatches) {
    console.log(`      ${paramKey(ref)} model  ${JSON.stringify(comparable(state.model, ref))}`);
    console.log(`      ${paramKey(ref)} device ${JSON.stringify(comparable(afterEdit, ref))}`);
  }

  for (let i = 0; i < EDITS.length; i++) await editor.undo();
  const afterUndo = modelFromReadback(await dsp.presetImage(), defaultCalibration);
  const notRestored = EDITS.filter(({ ref }) => !sameValue(comparable(afterUndo, ref), comparable(initial, ref)));
  check(notRestored.length === 0, `undo restored every parameter on the device${notRestored.length ? ` (not restored: ${notRestored.map((m) => paramKey(m.ref)).join(", ")})` : ""}`);
}

main()
  .catch((error: unknown) => {
    failures.push(String(error));
    console.error(error);
  })
  .finally(() => {
    console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
    process.exit(failures.length ? 1 : 0);
  });

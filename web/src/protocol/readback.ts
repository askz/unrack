// Decoders for the device's readback replies (decoded from observed traffic):
//  - 0x40 level poll: 8 channel meters, 3 bytes each (a packed 32-bit linear level word).
//  - 0x27/0x24 channel-state: nine 50-byte pages reconstruct the 450-byte preset
//    image (preset name @+2; input records 24B @16/40/64/88; output records 74B
//    @112/186/260/334). Gain: input @+18, output @+66 (16-bit, level-raw scale).
import type { Reply } from "./frame.ts";

// The 0x40 reply carries one 32-bit linear DSP level word per channel, read from the DSP by
// the firmware (loop at 0x13d8) and packed by the 0x40 handler (0x5fce) as
// [bits23..16, bits31..24, bits15..8]; bits 7..0 are dropped. Full scale is 2^24 (8.24
// fixed-point, as the coefficients). Idle hardware sits near -87 dBFS (inputs) and
// -75 dBFS (outputs), so the meter spans [-72..0] dBFS.
const LEVEL_FULL_SCALE = 2 ** 24;
const METER_FLOOR_DB = -72;

const levelWord = (data: Uint8Array, channel: number) =>
  (((data[3 * channel + 1] ?? 0) << 24) | ((data[3 * channel] ?? 0) << 16) | ((data[3 * channel + 2] ?? 0) << 8)) >>> 0;

/** 8 channel levels in dBFS (-Infinity when silent) from a 0x40 reply. Order: In A–D, Out 1–4. */
export function levelsDbFromReply(r: Reply): number[] | null {
  if (r.code !== 0x40 || r.data.length < 24) return null;
  return Array.from({ length: 8 }, (_, i) => 20 * Math.log10(levelWord(r.data, i) / LEVEL_FULL_SCALE));
}

/** 8 channel levels (0..1, linear in dB over [-72..0] dBFS) from a 0x40 reply. */
export function levelsFromReply(r: Reply): number[] | null {
  return levelsDbFromReply(r)?.map((db) => Math.max(0, Math.min(1, 1 - db / METER_FLOOR_DB))) ?? null;
}

// Record field offsets — all probe-verified against known written values (set
// distinctive values, read back, match). Raw values only; the store applies
// calibration/unit conversions. NOTE: mute is NOT in this image (it's separate
// live state, likely the 0x22 flags table) — not hydrated from here.
export interface PeqBandRaw { gainRaw: number; freqIdx: number; qRaw: number; type: number; }
export interface InputReadback {
  name: string; gainRaw: number; polarity: boolean;
  gate: { atkRaw: number; relRaw: number; holdRaw: number; thrRaw: number };
}
export interface OutputReadback {
  name: string; gainRaw: number; polarity: boolean; routingMask: number; delaySamples: number;
  hpfRaw: number; lpfRaw: number; hpfSlope: number; lpfSlope: number;
  bands: PeqBandRaw[];
  comp: { ratioIndex: number; kneeRaw: number; atkRaw: number; relRaw: number; thrRaw: number };
}
export interface PresetReadback { presetName: string; inputs: InputReadback[]; outputs: OutputReadback[]; }

/** Reconstruct the 450-byte preset image from nine 0x24 pages (data = [idx, …50B]). */
export function reconstructPresetImage(pages: Uint8Array[]): Uint8Array {
  const img = new Uint8Array(450);
  for (let i = 0; i < 9; i++) {
    const p = pages[i];
    if (p && p.length >= 50) img.set(p.subarray(0, 50), i * 50);
  }
  return img;
}

export function parsePresetImage(img: Uint8Array): PresetReadback {
  const str = (o: number, len: number) => new TextDecoder().decode(img.slice(o, o + len)).replace(/\0[\s\S]*$/, "").trim();
  const u16 = (o: number) => (img[o] ?? 0) | ((img[o + 1] ?? 0) << 8);
  const u8 = (o: number) => img[o] ?? 0;

  // input record (24 B): name@0(10) gate@10(atk,rel,hold,thr) gain@18 polarity@20
  const inputs = [16, 40, 64, 88].map((b) => ({
    name: str(b, 10), gainRaw: u16(b + 18), polarity: u8(b + 20) !== 0,
    gate: { atkRaw: u16(b + 10), relRaw: u16(b + 12), holdRaw: u16(b + 14), thrRaw: u16(b + 16) },
  }));

  // output record (74 B): name@0(8) routing@8 hpfFreq@10 lpfFreq@12 hpfSlope@14
  // lpfSlope@15 bands@16(7×[freq16,q16,gain8,type8]) comp@58 gain@66 polarity@68 delay@70
  const outputs = [112, 186, 260, 334].map((b) => ({
    name: str(b, 8), routingMask: u8(b + 8), gainRaw: u16(b + 66), polarity: u8(b + 68) !== 0,
    delaySamples: u16(b + 70), hpfRaw: u16(b + 10), lpfRaw: u16(b + 12), hpfSlope: u8(b + 14), lpfSlope: u8(b + 15),
    bands: Array.from({ length: 7 }, (_, j) => {
      const o = b + 16 + j * 6; // band record: [gain16, freq16, q8, type8]
      return { gainRaw: u16(o), freqIdx: u16(o + 2), qRaw: u8(o + 4), type: u8(o + 5) };
    }),
    comp: { ratioIndex: u8(b + 58), kneeRaw: u8(b + 59), atkRaw: u16(b + 60), relRaw: u16(b + 62), thrRaw: u16(b + 64) },
  }));

  return { presetName: str(2, 14), inputs, outputs };
}

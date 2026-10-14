// Device model in engineering units. Mirrors the editor: 4 inputs (A–D) + 4 outputs
// (1–4); outputs have PEQ/crossover/delay/compressor, inputs have a noise gate.
// Channel index = device address (in 0x00–03, out 0x04–07). Plain JSON-safe data:
// it is what undo history records and what preset files contain.
import type { ChannelEq, PeqBand } from "../eq/types.ts";
import { PeqType, Slope } from "../protocol/commands.ts";
import { defaultCalibration as cal } from "../eq/calibration.ts";

export interface Compressor { thresholdDb: number; ratioIndex: number; kneeDb: number; attackMs: number; releaseMs: number; }
export interface Gate { thresholdDb: number; attackMs: number; holdMs: number; releaseMs: number; }

export interface Channel {
  index: number;       // 0x00..0x07
  name: string;
  isOutput: boolean;
  gainDb: number;
  /** null = unknown: the device has no mute readback. */
  mute: boolean | null;
  polarity: boolean;   // invert
  eq?: ChannelEq;      // outputs
  delayMs?: number;    // outputs
  comp?: Compressor;   // outputs
  gate?: Gate;         // inputs
}

export interface DeviceModel {
  presetName: string;
  channels: Channel[];  // 8, indexed by device address
  routing: number[];    // Out1..4 input bitmasks (InA=1 … InD=8)
}

export const CHANNEL_COUNT = 8;
export const OUT_BASE = 0x04;
export const OUTPUT_COUNT = 4;
export const BAND_COUNT = 7;
const IN_NAMES = ["In A", "In B", "In C", "In D"];
const OUT_NAMES = ["Out 1", "Out 2", "Out 3", "Out 4"];

/** Fixed label of a channel address ("In A" … "Out 4"), independent of user names. */
export function channelLabel(index: number): string {
  return (index >= OUT_BASE ? OUT_NAMES[index - OUT_BASE] : IN_NAMES[index]) ?? `Channel ${index}`;
}

// Factory defaults, as read back from a factory-reset unit: band centres at PEQ
// indexes 31…270 (40 Hz … 10 kHz), Q raw 25, crossovers bypassed at the scale ends,
// dynamics times raw 49/99/499. Every value is exactly representable on the device.
const FACTORY_BAND_INDEXES = [31, 71, 118, 161, 200, 240, 270];
const FACTORY_Q_RAW = 25;
const XOVER_MIN_RAW = 0;
const XOVER_MAX_RAW = 300;

/** Factory centre frequency of each PEQ band (used for new channels and band reset). */
export const DEFAULT_BAND_FREQS = FACTORY_BAND_INDEXES.map((index) => cal.peqIndexToHz(index));

export function defaultBand(freqHz: number): PeqBand {
  return { freqHz, gainDb: 0, bwOct: cal.qToBwOct(cal.rawToQ(FACTORY_Q_RAW), freqHz), type: PeqType.PEAK, bypass: false };
}

export function defaultEq(): ChannelEq {
  return {
    bands: DEFAULT_BAND_FREQS.map((f) => defaultBand(f)),
    hpf: { freqHz: cal.xoverRawToHz(XOVER_MIN_RAW), slope: Slope.BYPASS },
    lpf: { freqHz: cal.xoverRawToHz(XOVER_MAX_RAW), slope: Slope.BYPASS },
  };
}

export function defaultChannel(index: number): Channel {
  const isOutput = index >= OUT_BASE;
  return {
    index, isOutput,
    name: isOutput ? OUT_NAMES[index - OUT_BASE]! : IN_NAMES[index]!,
    gainDb: 0, mute: false, polarity: false,
    eq: isOutput ? defaultEq() : undefined,
    delayMs: isOutput ? 0 : undefined,
    comp: isOutput ? { thresholdDb: 20, ratioIndex: 0, kneeDb: 0, attackMs: 50, releaseMs: 500 } : undefined,
    gate: isOutput ? undefined : { thresholdDb: -90, attackMs: 50, holdMs: 100, releaseMs: 500 },
  };
}

export function defaultModel(): DeviceModel {
  return {
    presetName: "",
    channels: Array.from({ length: CHANNEL_COUNT }, (_, i) => defaultChannel(i)),
    routing: [0x01, 0x02, 0x04, 0x08],
  };
}

/** Deep copy of JSON-safe model data (works on reactive proxies too). */
export function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** Structural equality of JSON-safe model data (independent of key order; undefined fields are ignored). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!sameValue(left[key], right[key])) return false;
  }
  return true;
}

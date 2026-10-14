// Parameter registry: every device parameter the editor can change, with where it
// lives in the model, its valid range, how to quantize it to the device's real
// resolution (so the UI shows exactly what the device stores), and how to send it.
import type { Dsp } from "../dsp.ts";
import type { Calibration } from "../eq/calibration.ts";
import type { Crossover, PeqBand } from "../eq/types.ts";
import { gainDbToRaw, gainRawToDb, GAIN_MAX_RAW } from "../protocol/control.ts";
import { msToSamples, samplesToMs, thresholdDbToRaw, thresholdRawToDb } from "../protocol/blocks.ts";
import { Ratio } from "../protocol/commands.ts";
import { BAND_COUNT, CHANNEL_COUNT, OUT_BASE, channelLabel, type Compressor, type DeviceModel, type Gate } from "./model.ts";

export type ParamKind = "gain" | "mute" | "polarity" | "delay" | "routing" | "peq" | "hpf" | "lpf" | "comp" | "gate";
export interface ParamRef { kind: ParamKind; ch: number; band?: number }
export type ParamValue = number | boolean | PeqBand | Crossover | Compressor | Gate;
/** A value for one parameter; null means "unknown, leave as is". */
export interface ParamAssignment { ref: ParamRef; value: ParamValue | null }

export class ParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParamError";
  }
}

export interface Range { min: number; max: number; unit: string; integer?: boolean }

const MAX_DELAY_SAMPLES = 32640;

export const GAIN_RANGE: Range = { min: gainRawToDb(0), max: gainRawToDb(GAIN_MAX_RAW), unit: "dB" };
export const DELAY_RANGE: Range = { min: 0, max: samplesToMs(MAX_DELAY_SAMPLES), unit: "ms" };
export const ROUTING_RANGE: Range = { min: 0, max: 15, unit: "", integer: true };
export const FREQ_RANGE: Range = { min: 19.7, max: 20200, unit: "Hz" };
export const PEQ_GAIN_RANGE: Range = { min: -12, max: 12, unit: "dB" };
export const BANDWIDTH_RANGE: Range = { min: 0.05, max: 8, unit: "oct" };
export const PEQ_TYPE_RANGE: Range = { min: 0, max: 6, unit: "", integer: true };
export const SLOPE_RANGE: Range = { min: 0, max: 10, unit: "", integer: true };
export const COMP_RANGES: Readonly<Record<keyof Compressor, Range>> = {
  thresholdDb: { min: -90, max: 20, unit: "dB" },
  ratioIndex: { min: 0, max: Ratio.length - 1, unit: "", integer: true },
  kneeDb: { min: 0, max: 12, unit: "dB", integer: true },
  attackMs: { min: 1, max: 999, unit: "ms", integer: true },
  releaseMs: { min: 10, max: 3000, unit: "ms", integer: true },
};
export const GATE_RANGES: Readonly<Record<keyof Gate, Range>> = {
  thresholdDb: { min: -90, max: 0, unit: "dB" },
  attackMs: { min: 1, max: 999, unit: "ms", integer: true },
  holdMs: { min: 10, max: 999, unit: "ms", integer: true },
  releaseMs: { min: 1, max: 3000, unit: "ms", integer: true },
};

const EPSILON = 1e-9;
const QUANT_Q_MIN_RAW = 1;

// ---- validation / normalization helpers ----

const format = (value: number) => String(Math.round(value * 1000) / 1000);

function checkNumber(label: string, value: unknown, range: Range): string[] {
  if (typeof value !== "number" || !Number.isFinite(value)) return [`${label} must be a number`];
  if (range.integer && !Number.isInteger(value)) return [`${label} must be a whole number`];
  if (value < range.min - EPSILON || value > range.max + EPSILON) {
    return [`${label} ${format(value)} is outside ${format(range.min)}..${format(range.max)}${range.unit ? ` ${range.unit}` : ""}`];
  }
  return [];
}

function checkBoolean(label: string, value: unknown, nullable = false): string[] {
  if (typeof value === "boolean" || (nullable && value === null)) return [];
  return [`${label} must be ${nullable ? "true, false or null" : "true or false"}`];
}

function checkRecord(label: string, value: unknown, ranges: Readonly<Record<string, Range>>): string[] {
  if (typeof value !== "object" || value === null) return [`${label} is missing`];
  const record = value as Record<string, unknown>;
  return Object.entries(ranges).flatMap(([field, range]) => checkNumber(`${label} ${field}`, record[field], range));
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ParamError(`${label} must be a number`);
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new ParamError(`${label} must be true or false`);
  return value;
}

function clampTo(value: number, range: Range): number {
  const clamped = Math.min(range.max, Math.max(range.min, value));
  return range.integer ? Math.round(clamped) : clamped;
}

const quantizeThreshold = (db: number) => thresholdRawToDb(thresholdDbToRaw(db));

function normalizeBand(value: ParamValue, cal: Calibration): PeqBand {
  const band = value as PeqBand;
  const freqHz = cal.peqIndexToHz(cal.peqHzToIndex(finite(band.freqHz, "frequency")));
  const type = clampTo(finite(band.type, "type"), PEQ_TYPE_RANGE);
  const gainDb = cal.peqGainRawToDb(cal.peqGainDbToRaw(finite(band.gainDb, "gain"), type), type);
  const bandwidth = clampTo(finite(band.bwOct, "bandwidth"), BANDWIDTH_RANGE);
  const qRaw = Math.max(QUANT_Q_MIN_RAW, cal.qToRaw(cal.bwOctToQ(bandwidth, freqHz)));
  const bwOct = cal.qToBwOct(cal.rawToQ(qRaw), freqHz);
  const bypass = band.bypass === null ? null : bool(band.bypass, "bypass");
  return { freqHz, gainDb, bwOct, type, bypass };
}

function normalizeCrossover(value: ParamValue, cal: Calibration): Crossover {
  const crossover = value as Crossover;
  return {
    freqHz: cal.xoverRawToHz(cal.xoverHzToRaw(finite(crossover.freqHz, "frequency"))),
    slope: clampTo(finite(crossover.slope, "slope"), SLOPE_RANGE),
  };
}

function normalizeCompressor(value: ParamValue): Compressor {
  const comp = value as Compressor;
  return {
    thresholdDb: quantizeThreshold(clampTo(finite(comp.thresholdDb, "threshold"), COMP_RANGES.thresholdDb)),
    ratioIndex: clampTo(finite(comp.ratioIndex, "ratio"), COMP_RANGES.ratioIndex),
    kneeDb: clampTo(finite(comp.kneeDb, "knee"), COMP_RANGES.kneeDb),
    attackMs: clampTo(finite(comp.attackMs, "attack"), COMP_RANGES.attackMs),
    releaseMs: clampTo(finite(comp.releaseMs, "release"), COMP_RANGES.releaseMs),
  };
}

function normalizeGate(value: ParamValue): Gate {
  const gate = value as Gate;
  return {
    thresholdDb: quantizeThreshold(clampTo(finite(gate.thresholdDb, "threshold"), GATE_RANGES.thresholdDb)),
    attackMs: clampTo(finite(gate.attackMs, "attack"), GATE_RANGES.attackMs),
    holdMs: clampTo(finite(gate.holdMs, "hold"), GATE_RANGES.holdMs),
    releaseMs: clampTo(finite(gate.releaseMs, "release"), GATE_RANGES.releaseMs),
  };
}

function checkBand(label: string, value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [`${label} is missing`];
  const band = value as Record<string, unknown>;
  return [
    ...checkNumber(`${label} frequency`, band.freqHz, FREQ_RANGE),
    ...checkNumber(`${label} gain`, band.gainDb, PEQ_GAIN_RANGE),
    ...checkNumber(`${label} bandwidth`, band.bwOct, BANDWIDTH_RANGE),
    ...checkNumber(`${label} type`, band.type, PEQ_TYPE_RANGE),
    ...checkBoolean(`${label} bypass`, band.bypass, true),
  ];
}

function checkCrossover(label: string, value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [`${label} is missing`];
  const crossover = value as Record<string, unknown>;
  return [
    ...checkNumber(`${label} frequency`, crossover.freqHz, FREQ_RANGE),
    ...checkNumber(`${label} slope`, crossover.slope, SLOPE_RANGE),
  ];
}

// ---- registry ----

interface ParamSpec {
  appliesTo(ch: number): boolean;
  path(ref: ParamRef): (string | number)[];
  describe(ref: ParamRef): string;
  check(label: string, value: unknown): string[];
  normalize(value: ParamValue, cal: Calibration): ParamValue;
  send(dsp: Dsp, ref: ParamRef, value: ParamValue, cal: Calibration): Promise<unknown>;
}

const anyChannel = (ch: number) => ch >= 0 && ch < CHANNEL_COUNT;
const outputOnly = (ch: number) => ch >= OUT_BASE && ch < CHANNEL_COUNT;
const inputOnly = (ch: number) => ch >= 0 && ch < OUT_BASE;
const channelPath = (field: string) => (ref: ParamRef) => ["channels", ref.ch, field];

const SPECS: Readonly<Record<ParamKind, ParamSpec>> = {
  gain: {
    appliesTo: anyChannel,
    path: channelPath("gainDb"),
    describe: () => "gain",
    check: (label, value) => checkNumber(label, value, GAIN_RANGE),
    normalize: (value) => gainRawToDb(gainDbToRaw(finite(value, "gain"))),
    send: (dsp, ref, value) => dsp.setLevelDb(ref.ch, value as number),
  },
  mute: {
    appliesTo: anyChannel,
    path: channelPath("mute"),
    describe: () => "mute",
    check: (label, value) => checkBoolean(label, value, true),
    normalize: (value) => bool(value, "mute"),
    send: (dsp, ref, value) => dsp.mute(ref.ch, value as boolean),
  },
  polarity: {
    appliesTo: anyChannel,
    path: channelPath("polarity"),
    describe: () => "polarity",
    check: (label, value) => checkBoolean(label, value),
    normalize: (value) => bool(value, "polarity"),
    send: (dsp, ref, value) => dsp.setPolarity(ref.ch, value as boolean),
  },
  delay: {
    appliesTo: outputOnly,
    path: channelPath("delayMs"),
    describe: () => "delay",
    check: (label, value) => checkNumber(label, value, DELAY_RANGE),
    normalize: (value) => samplesToMs(msToSamples(finite(value, "delay"))),
    send: (dsp, ref, value) => dsp.delayMs(ref.ch, value as number),
  },
  routing: {
    appliesTo: outputOnly,
    path: (ref) => ["routing", ref.ch - OUT_BASE],
    describe: () => "routing",
    check: (label, value) => checkNumber(label, value, ROUTING_RANGE),
    normalize: (value) => clampTo(finite(value, "routing"), ROUTING_RANGE),
    send: (dsp, ref, value) => dsp.routing(ref.ch, value as number),
  },
  peq: {
    appliesTo: outputOnly,
    path: (ref) => ["channels", ref.ch, "eq", "bands", ref.band ?? -1],
    describe: (ref) => `PEQ band ${(ref.band ?? 0) + 1}`,
    check: checkBand,
    normalize: normalizeBand,
    send: (dsp, ref, value, cal) => {
      const band = value as PeqBand;
      return dsp.peqBand(ref.ch, ref.band ?? 0, {
        freqHz: band.freqHz,
        q: cal.bwOctToQ(band.bwOct, band.freqHz),
        gainRaw: cal.peqGainDbToRaw(band.gainDb, band.type),
        type: band.type,
        bypass: band.bypass === true,
      });
    },
  },
  hpf: {
    appliesTo: outputOnly,
    path: (ref) => ["channels", ref.ch, "eq", "hpf"],
    describe: () => "high-pass",
    check: checkCrossover,
    normalize: normalizeCrossover,
    send: (dsp, ref, value, cal) => {
      const crossover = value as Crossover;
      return dsp.crossoverHpf(ref.ch, cal.xoverHzToRaw(crossover.freqHz), crossover.slope);
    },
  },
  lpf: {
    appliesTo: outputOnly,
    path: (ref) => ["channels", ref.ch, "eq", "lpf"],
    describe: () => "low-pass",
    check: checkCrossover,
    normalize: normalizeCrossover,
    send: (dsp, ref, value, cal) => {
      const crossover = value as Crossover;
      return dsp.crossoverLpf(ref.ch, cal.xoverHzToRaw(crossover.freqHz), crossover.slope);
    },
  },
  comp: {
    appliesTo: outputOnly,
    path: channelPath("comp"),
    describe: () => "compressor",
    check: (label, value) => checkRecord(label, value, COMP_RANGES),
    normalize: normalizeCompressor,
    send: (dsp, ref, value) => dsp.compressor(ref.ch, value as Compressor),
  },
  gate: {
    appliesTo: inputOnly,
    path: channelPath("gate"),
    describe: () => "gate",
    check: (label, value) => checkRecord(label, value, GATE_RANGES),
    normalize: normalizeGate,
    send: (dsp, ref, value) => dsp.gate(ref.ch, value as Gate),
  },
};

function specFor(ref: ParamRef): ParamSpec {
  const spec = SPECS[ref.kind];
  if (!spec || !spec.appliesTo(ref.ch)) throw new ParamError(`no ${ref.kind} parameter on channel ${ref.ch}`);
  if (ref.kind === "peq" && (ref.band === undefined || ref.band < 0 || ref.band >= BAND_COUNT)) {
    throw new ParamError(`PEQ band must be 0..${BAND_COUNT - 1}`);
  }
  return spec;
}

function readPath(root: unknown, path: readonly (string | number)[]): unknown {
  let node = root;
  for (const segment of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string | number, unknown>)[segment];
  }
  return node;
}

// ---- public API ----

export function paramKey(ref: ParamRef): string {
  return ref.band === undefined ? `${ref.kind}:${ref.ch}` : `${ref.kind}:${ref.ch}:${ref.band}`;
}

/** Every parameter of the device, in a stable order (inputs first, then outputs). */
export function allParams(): ParamRef[] {
  const refs: ParamRef[] = [];
  for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
    refs.push({ kind: "gain", ch }, { kind: "mute", ch }, { kind: "polarity", ch });
    if (ch < OUT_BASE) {
      refs.push({ kind: "gate", ch });
      continue;
    }
    refs.push({ kind: "delay", ch }, { kind: "routing", ch }, { kind: "hpf", ch }, { kind: "lpf", ch });
    for (let band = 0; band < BAND_COUNT; band++) refs.push({ kind: "peq", ch, band });
    refs.push({ kind: "comp", ch });
  }
  return refs;
}

/** Human label, e.g. "Out 1 PEQ band 3"; nameOf gives the channel names (default: fixed labels). */
export function describeParam(ref: ParamRef, nameOf: (ch: number) => string = channelLabel): string {
  return `${nameOf(ref.ch) || channelLabel(ref.ch)} ${specFor(ref).describe(ref)}`;
}

/** Current value in the model; null for values the device cannot report (mute). */
export function readParam(model: DeviceModel, ref: ParamRef): ParamValue | null {
  const value = readPath(model, specFor(ref).path(ref));
  if (value === undefined) throw new ParamError(`${describeParam(ref)} is missing from the model`);
  return value as ParamValue | null;
}

export function writeParam(model: DeviceModel, ref: ParamRef, value: ParamValue | null): void {
  const path = specFor(ref).path(ref);
  const parent = readPath(model, path.slice(0, -1));
  if (typeof parent !== "object" || parent === null) throw new ParamError(`${describeParam(ref)} has no place in the model`);
  (parent as Record<string | number, unknown>)[path[path.length - 1]!] = value;
}

/** Clamp to the valid range and quantize to the device's resolution. Throws ParamError on wrong types. */
export function normalizeParam(ref: ParamRef, value: ParamValue, cal: Calibration): ParamValue {
  return specFor(ref).normalize(value, cal);
}

/** Validation issues for an untrusted value (e.g. from a file); empty when valid. */
export function checkParam(ref: ParamRef, value: unknown): string[] {
  return specFor(ref).check(describeParam(ref), value);
}

/** Look up an untrusted value (e.g. a parsed file) at a parameter's model location. */
export function readUntrusted(root: unknown, ref: ParamRef): unknown {
  return readPath(root, specFor(ref).path(ref));
}

export function sendParam(dsp: Dsp, ref: ParamRef, value: ParamValue, cal: Calibration): Promise<unknown> {
  return specFor(ref).send(dsp, ref, value, cal);
}

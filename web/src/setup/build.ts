// Recipe -> device parameters. A recipe only writes what it owns: routing, crossovers,
// gain, polarity, PEQ band 1 (low shelf) and band 7 (high shelf) of the outputs, plus
// delay and limiter while their switches are on. Inputs, mute and PEQ bands 2 to 6 are
// never written, so the user's own EQ survives a setup change.
import { qToBwOct } from "../eq/biquad.ts";
import type { Crossover, PeqBand } from "../eq/types.ts";
import { PeqType, Ratio, Slope } from "../protocol/commands.ts";
import { BAND_COUNT, DEFAULT_BAND_FREQS, defaultBand, defaultEq, type Compressor } from "../state/model.ts";
import { GAIN_RANGE, type ParamAssignment } from "../state/params.ts";
import {
  ENVIRONMENTS, LAYOUTS, alignmentDelaysMs, bandCount, spareOutputs, usedOutputs,
  type Environment, type OutputSlot, type Recipe, type Role, type SlopeId,
} from "./recipe.ts";

export interface SetupResult {
  assignments: ParamAssignment[];
  /** Display name per output address ("Top L", "Spare", ...). */
  names: Record<number, string>;
  /** Addresses of the outputs left silent. */
  spare: number[];
}

export interface BuildOptions {
  /** Highest output gain the UI may set; null = the device maximum. */
  gainCeilingDb?: number | null;
}

const SHELF_Q = 0.7;
const SUBSONIC_SLOPE = Slope.BW24;
const LIMIT_RATIO = Ratio.indexOf("Limit");
const SPARE_NAME = "Spare";
const SLOPE_CODES: Readonly<Record<SlopeId, number>> = { LR24: Slope.LK24, LR12: Slope.LK12 };
const ROUTE_A = 1;
const ROUTE_B = 2;

/** Limiter attack / release (ms) by role: slow for low frequencies, fast for high ones. */
const LIMITER_TIMES: Readonly<Record<Role, { attackMs: number; releaseMs: number }>> = {
  sub: { attackMs: 20, releaseMs: 400 },
  low: { attackMs: 20, releaseMs: 400 },
  kick: { attackMs: 10, releaseMs: 200 },
  mid: { attackMs: 10, releaseMs: 200 },
  main: { attackMs: 5, releaseMs: 200 },
  fill: { attackMs: 5, releaseMs: 200 },
  top: { attackMs: 2, releaseMs: 100 },
  high: { attackMs: 2, releaseMs: 100 },
};

const OFF_EQ = defaultEq();

function routingMask(slot: OutputSlot, recipe: Recipe): number {
  if (recipe.source === "mono") return ROUTE_A;
  if (slot.side === "L") return ROUTE_A;
  if (slot.side === "R") return ROUTE_B;
  return ROUTE_A | ROUTE_B;
}

function highPass(slot: OutputSlot, recipe: Recipe): Crossover {
  if (slot.band > 0) return { freqHz: recipe.crossoversHz[slot.band - 1]!, slope: SLOPE_CODES[recipe.slope] };
  if (recipe.subsonic.enabled) return { freqHz: recipe.subsonic.freqHz, slope: SUBSONIC_SLOPE };
  return { ...OFF_EQ.hpf };
}

function lowPass(slot: OutputSlot, recipe: Recipe, topBand: number): Crossover {
  if (slot.band < topBand) return { freqHz: recipe.crossoversHz[slot.band]!, slope: SLOPE_CODES[recipe.slope] };
  return { ...OFF_EQ.lpf };
}

function shelf(type: number, freqHz: number, gainDb: number): PeqBand {
  return { freqHz, gainDb, bwOct: qToBwOct(SHELF_Q, freqHz), type, bypass: false };
}

function lowBand(slot: OutputSlot, environment: Environment, gainDb: number): PeqBand {
  return slot.band === 0 ? shelf(PeqType.LOW_SHELF, environment.lowHz, gainDb) : defaultBand(DEFAULT_BAND_FREQS[0]!);
}

function highBand(slot: OutputSlot, topBand: number, environment: Environment, gainDb: number): PeqBand {
  return slot.band === topBand ? shelf(PeqType.HIGH_SHELF, environment.highHz, gainDb) : defaultBand(DEFAULT_BAND_FREQS[BAND_COUNT - 1]!);
}

function limiter(role: Role, recipe: Recipe): Compressor {
  return {
    thresholdDb: recipe.protection.thresholdDb[role] ?? 0,
    ratioIndex: LIMIT_RATIO,
    kneeDb: 0,
    ...LIMITER_TIMES[role],
  };
}

/** The assignments of a valid recipe (check it with checkRecipe first). */
export function buildSetup(recipe: Recipe, options: BuildOptions = {}): SetupResult {
  const layout = LAYOUTS[recipe.layout];
  const environment = ENVIRONMENTS[recipe.environment.id];
  const topBand = bandCount(layout) - 1;
  const maxGain = Math.min(GAIN_RANGE.max, options.gainCeilingDb ?? GAIN_RANGE.max);
  const delays = alignmentDelaysMs(recipe);
  const assignments: ParamAssignment[] = [];
  const names: Record<number, string> = {};

  for (const { ch, index, slot } of usedOutputs(layout)) {
    const trim = recipe.trimsDb[slot.role] ?? 0;
    assignments.push(
      { ref: { kind: "routing", ch }, value: routingMask(slot, recipe) },
      { ref: { kind: "hpf", ch }, value: highPass(slot, recipe) },
      { ref: { kind: "lpf", ch }, value: lowPass(slot, recipe, topBand) },
      { ref: { kind: "gain", ch }, value: Math.max(GAIN_RANGE.min, Math.min(maxGain, trim)) },
      { ref: { kind: "polarity", ch }, value: recipe.invert.includes(slot.role) },
      { ref: { kind: "peq", ch, band: 0 }, value: lowBand(slot, environment, recipe.environment.lowDb) },
      { ref: { kind: "peq", ch, band: BAND_COUNT - 1 }, value: highBand(slot, topBand, environment, recipe.environment.highDb) },
    );
    if (recipe.alignment.enabled) assignments.push({ ref: { kind: "delay", ch }, value: delays[index] ?? 0 });
    if (recipe.protection.enabled) assignments.push({ ref: { kind: "comp", ch }, value: limiter(slot.role, recipe) });
    names[ch] = slot.name;
  }

  const spare = spareOutputs(layout);
  for (const ch of spare) {
    assignments.push({ ref: { kind: "routing", ch }, value: 0 });
    names[ch] = SPARE_NAME;
  }
  return { assignments, names, spare };
}

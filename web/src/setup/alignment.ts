// Time alignment geometry: the path from each speaker to the ears, the delays that line
// the arrivals up at one alignment point, and how well neighbouring bands add up across
// the crowd at their crossover. Pure functions over a Rig (a recipe's layout, crossovers
// and alignment), shared by recipe.ts, the tuning and the Setup view.
import type { OutputSlot } from "./recipe.ts";

/** "positions": delays from speaker heights and the crowd; "direct": from measured distances. */
export type AlignmentMode = "positions" | "direct";
/** One value per output, Out 1 to Out 4. */
export type PerOutput<T> = [T, T, T, T];

export interface SpeakerPosition {
  /** Distance from the stage edge toward the crowd; negative = behind the edge. */
  xM: number;
  /** Height of the acoustic centre above the floor. */
  heightM: number;
}

export interface Crowd {
  /** From the stage edge. */
  startM: number;
  endM: number;
  earHeightM: number;
}

/** Per-output arrays are indexed by output (Out 1 to Out 4); spare outputs are ignored. */
export interface Alignment {
  enabled: boolean;
  tempC: number;
  mode: AlignmentMode;
  /** Direct mode: straight distance from the listening spot to each speaker. */
  distancesM: PerOutput<number>;
  speakers: PerOutput<SpeakerPosition>;
  crowd: Crowd;
  /** Alignment point (distance from the stage edge); null = the suggested point. */
  pointM: number | null;
  /** By-ear fine-tune offsets added to the geometric delays. */
  offsetsMs: PerOutput<number>;
}

/** What the alignment math needs from a recipe. */
export interface Rig {
  /** Out 1 to Out 4; null = spare. */
  outputs: readonly (OutputSlot | null)[];
  crossoversHz: readonly number[];
  alignment: Alignment;
}

/** How two neighbouring bands sum at their crossover at one crowd position. */
export type CouplingState = "adds" | "weak" | "cancels";

/** One crowd position and the worst crossover phase there. */
export interface CoverageSample {
  xM: number;
  worstPhaseDeg: number;
  state: CouplingState;
}

/** Coupling across the whole crowd. */
export interface Coverage {
  samples: CoverageSample[];
  /** Length of crowd at "adds" or "weak". */
  coupledM: number;
  totalM: number;
}

/** Output indexes (0 to 3) of two neighbouring bands and the crossover between them. */
export interface BandPair {
  lower: number;
  upper: number;
  crossoverHz: number;
}

/** Within 3 dB of full summation. */
export const ADDS_MAX_DEG = 90;
/** Beyond this the two bands no longer reinforce each other. */
export const COUPLED_MAX_DEG = 120;
/** Spacing of the crowd positions evaluated (m). */
export const SAMPLE_STEP_M = 0.1;
/** Keeps a very deep crowd fast to evaluate (the suggestion is quadratic in samples). */
const MAX_SAMPLES = 501;

/** Speed of sound in air (m/s) at a temperature in degrees Celsius. */
export function speedOfSound(tempC: number): number {
  return 331.3 + 0.606 * tempC;
}

/** Straight path (m) from a speaker to ears at earHeightM, pointM from the stage edge. */
export function pathLengthM(speaker: SpeakerPosition, pointM: number, earHeightM: number): number {
  return Math.hypot(pointM - speaker.xM, speaker.heightM - earHeightM);
}

const usedIndexes = (rig: Rig): number[] => rig.outputs.flatMap((output, index) => (output ? [index] : []));

/** Delays (ms) that make every path arrive with the longest one. */
function delaysForPaths(pathsM: number[], speed: number): number[] {
  const longest = Math.max(...pathsM);
  return pathsM.map((path) => ((longest - path) / speed) * 1000);
}

/** Per-output list from values of the used outputs (in output order); null for spares. */
function byOutput(rig: Rig, used: number[], values: number[]): (number | null)[] {
  return rig.outputs.map((_, index) => {
    const position = used.indexOf(index);
    return position < 0 ? null : values[position]!;
  });
}

/** Crowd positions from start to end in even steps of SAMPLE_STEP_M (larger beyond MAX_SAMPLES). */
export function crowdSamplesM(crowd: Crowd): number[] {
  const length = Math.max(0, crowd.endM - crowd.startM);
  const count = Math.min(MAX_SAMPLES, Math.floor(length / SAMPLE_STEP_M + 1e-9) + 1);
  if (count <= 1) return [crowd.startM];
  const step = length / (count - 1);
  return Array.from({ length: count }, (_, i) => crowd.startM + i * step);
}

/** Every used output of each band with every used output of the band above, at their crossover. */
export function bandPairs(rig: Rig): BandPair[] {
  const used = usedIndexes(rig);
  return rig.crossoversHz.flatMap((crossoverHz, k) => {
    const lowers = used.filter((index) => rig.outputs[index]!.band === k);
    const uppers = used.filter((index) => rig.outputs[index]!.band === k + 1);
    return lowers.flatMap((lower) => uppers.map((upper) => ({ lower, upper, crossoverHz })));
  });
}

/** Classifies a crossover phase difference (degrees, either sign). */
export function couplingState(phaseDeg: number): CouplingState {
  const size = Math.abs(phaseDeg);
  if (size <= ADDS_MAX_DEG) return "adds";
  if (size <= COUPLED_MAX_DEG) return "weak";
  return "cancels";
}

/** Geometric delay per output (ms) aligning every used output at pointM; null for spares. */
export function geometricDelaysMs(rig: Rig, pointM: number): (number | null)[] {
  const { speakers, crowd, tempC } = rig.alignment;
  const used = usedIndexes(rig);
  const paths = used.map((index) => pathLengthM(speakers[index]!, pointM, crowd.earHeightM));
  return byOutput(rig, used, delaysForPaths(paths, speedOfSound(tempC)));
}

/** Per pair, at each position: lower path minus upper path (m). */
function pairDifferencesM(rig: Rig, pairs: BandPair[], positionsM: number[]): number[][] {
  const { speakers, crowd } = rig.alignment;
  const path = (index: number, xM: number) => pathLengthM(speakers[index]!, xM, crowd.earHeightM);
  return pairs.map(({ lower, upper }) => positionsM.map((xM) => path(lower, xM) - path(upper, xM)));
}

/** Worst |phase| (degrees) over all pairs at each of the first `count` positions, with the delays aligned at position `at`. */
function worstPhasesDeg(pairs: BandPair[], differences: number[][], at: number, count: number, speed: number): number[] {
  const phases = new Array<number>(count).fill(0);
  pairs.forEach((pair, p) => {
    const row = differences[p]!;
    const degreesPerMetre = (360 * pair.crossoverHz) / speed;
    for (let i = 0; i < count; i++) phases[i] = Math.max(phases[i]!, Math.abs((row[i]! - row[at]!) * degreesPerMetre));
  });
  return phases;
}

/**
 * How the bands add up across the crowd with the geometric delays aligned at pointM
 * (offsets are left out: they cancel the cabinets' own delay). Null without a crossover.
 */
export function coverage(rig: Rig, pointM: number): Coverage | null {
  const pairs = bandPairs(rig);
  if (pairs.length === 0) return null;
  const { crowd, tempC } = rig.alignment;
  const positions = crowdSamplesM(crowd);
  const differences = pairDifferencesM(rig, pairs, [...positions, pointM]);
  const phases = worstPhasesDeg(pairs, differences, positions.length, positions.length, speedOfSound(tempC));
  const samples = positions.map((xM, i) => ({ xM, worstPhaseDeg: phases[i]!, state: couplingState(phases[i]!) }));
  const totalM = Math.max(0, crowd.endM - crowd.startM);
  const coupled = samples.filter((sample) => sample.state !== "cancels").length;
  return { samples, coupledM: (totalM * coupled) / samples.length, totalM };
}

/** The crowd position that, as alignment point, keeps the most crowd coupled; ties go to the middle. Null without a crossover. */
export function suggestedPointM(rig: Rig): number | null {
  const pairs = bandPairs(rig);
  if (pairs.length === 0) return null;
  const { crowd, tempC } = rig.alignment;
  const positions = crowdSamplesM(crowd);
  const differences = pairDifferencesM(rig, pairs, positions);
  const speed = speedOfSound(tempC);
  const middle = (crowd.startM + Math.max(crowd.startM, crowd.endM)) / 2;
  let best = positions[0]!;
  let bestCount = -1;
  positions.forEach((xM, at) => {
    const count = worstPhasesDeg(pairs, differences, at, positions.length, speed).filter((deg) => deg <= COUPLED_MAX_DEG).length;
    if (count > bestCount || (count === bestCount && Math.abs(xM - middle) < Math.abs(best - middle))) {
      best = xM;
      bestCount = count;
    }
  });
  return best;
}

/** The alignment point in use: the chosen one kept inside the crowd, else the suggestion, else the middle. */
export function effectivePointM(rig: Rig): number {
  const { crowd, pointM } = rig.alignment;
  const end = Math.max(crowd.startM, crowd.endM);
  if (pointM !== null) return Math.min(end, Math.max(crowd.startM, pointM));
  return suggestedPointM(rig) ?? (crowd.startM + end) / 2;
}

/** Delay per output (ms): geometric or direct-distance delay plus the offset, shifted so the smallest is 0; null for spares. */
export function outputDelaysMs(rig: Rig): (number | null)[] {
  const { mode, distancesM, offsetsMs, tempC } = rig.alignment;
  const used = usedIndexes(rig);
  const base = mode === "positions"
    ? geometricDelaysMs(rig, effectivePointM(rig))
    : byOutput(rig, used, delaysForPaths(used.map((index) => distancesM[index]!), speedOfSound(tempC)));
  const raw = used.map((index) => base[index]! + offsetsMs[index]!);
  const lowest = Math.min(...raw);
  return byOutput(rig, used, raw.map((delay) => delay - lowest));
}

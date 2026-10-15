// What the demo DSP's meters show: a music-like program on In A and In B (a kick at
// 124 BPM, slow swells and some random motion, correlated but not identical between the
// two), followed through each channel's gain and mute and through the routing. EQ,
// crossovers, delay, compressor, gate and polarity are not modelled.

/** Idle levels of the hardware meters, in dBFS. */
export const INPUT_FLOOR_DB = -87;
export const OUTPUT_FLOOR_DB = -75;
/** Level of the test tone on every input while it plays. */
export const TONE_DB = -12;

const INPUT_COUNT = 4;
const BEAT_MS = 60_000 / 124;
const SWELL_MS = 16 * BEAT_MS;

/** The state the meters depend on. Gains and mutes: In A to D, then Out 1 to 4. */
export interface DemoMix {
  gainsDb: number[];
  mutes: boolean[];
  /** Input bitmask per output (In A = 1 … In D = 8). */
  routing: number[];
  toneOn: boolean;
}

/** A repeatable pseudo-random value in [0, 1) for an integer step and a seed. */
function hash(step: number, seed: number): number {
  const x = Math.sin(step * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Smooth noise in [-0.5, 0.5] that changes about once per period. */
function wobble(timeMs: number, periodMs: number, seed: number): number {
  const t = timeMs / periodMs;
  const step = Math.floor(t);
  const fraction = t - step;
  const ease = fraction * fraction * (3 - 2 * fraction);
  return hash(step, seed) * (1 - ease) + hash(step + 1, seed) * ease - 0.5;
}

/** In A and In B before their gain, in dBFS. */
export function programDb(timeMs: number): [number, number] {
  const beat = (timeMs % BEAT_MS) / BEAT_MS;
  const kick = Math.exp(-6 * beat);
  const swell = 0.5 - 0.5 * Math.cos((2 * Math.PI * timeMs) / SWELL_MS);
  const common = -30 + 10 * swell + 12 * kick + 4 * wobble(timeMs, 180, 1);
  return [common + 3 * wobble(timeMs, 120, 2), common + 3 * wobble(timeMs, 120, 3)];
}

const toPower = (db: number) => 10 ** (db / 10);
const clamp = (db: number, floor: number) => Math.min(0, Math.max(floor, db));

/** The eight meter levels in dBFS (In A to D, Out 1 to 4) at a moment. */
export function meterLevels(mix: DemoMix, timeMs: number): number[] {
  const [a, b] = programDb(timeMs);
  const sources = mix.toneOn ? Array.from({ length: INPUT_COUNT }, () => TONE_DB) : [a, b, INPUT_FLOOR_DB, INPUT_FLOOR_DB];
  const inputs = sources.map((db, i) => (mix.mutes[i] ? -Infinity : db + (mix.gainsDb[i] ?? 0)));
  const outputs = mix.routing.map((mask, o) => {
    const ch = INPUT_COUNT + o;
    const power = inputs.reduce((sum, db, i) => (mask & (1 << i) ? sum + toPower(db) : sum), 0);
    return mix.mutes[ch] || power === 0 ? -Infinity : 10 * Math.log10(power) + (mix.gainsDb[ch] ?? 0);
  });
  return [...inputs.map((db) => clamp(db, INPUT_FLOOR_DB)), ...outputs.map((db) => clamp(db, OUTPUT_FLOOR_DB))];
}

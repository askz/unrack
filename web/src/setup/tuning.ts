// By-ear fine tuning of the time alignment (polarity-null method): with one band
// inverted, a sine at the crossover is quietest when the two bands arrive together.
// Planning only: which pairs to tune, the tone, and the parameter changes that start,
// adjust and end a session. tuning.svelte.ts runs it against the device.
import { TONE_FREQS } from "../protocol/commands.ts";
import { OUT_BASE, OUTPUT_COUNT, type DeviceModel } from "../state/model.ts";
import type { ParamAssignment } from "../state/params.ts";
import type { StorageLike } from "../state/settings.ts";
import { outputDelaysMs, type Rig } from "./alignment.ts";
import { OFFSET_RANGE, type OutputSlot } from "./recipe.ts";

/** localStorage key of the snapshot of an unfinished session. */
export const TUNING_SESSION_KEY = "opendsp-4x4.tuning-session";
/** One device delay sample at 48 kHz. */
const DELAY_TOLERANCE_MS = 1000 / 48000;
const OUTPUTS = Array.from({ length: OUTPUT_COUNT }, (_, i) => OUT_BASE + i);

/** One pair to tune: a lower-band output against an upper-band one. */
export interface TuningStep {
  /** Index of the crossover between the two bands. */
  crossover: number;
  crossoverHz: number;
  /** Output index (0 to 3) of the lower band: its offset is adjusted. */
  lower: number;
  /** Output indexes it can be tuned against; the first is the default. */
  uppers: number[];
}

/** The output states a session changes, kept so they can be put back. */
export interface TuningSnapshot {
  mutes: (boolean | null)[];
  polarities: boolean[];
  delaysMs: number[];
}

/** What decides whether a session can start. */
export interface TuningContext {
  connected: boolean;
  /** The setup form has no problems. */
  valid: boolean;
  rig: Rig;
  model: DeviceModel;
}

/** From the highest crossover down, each lower-band output once, against the upper outputs on its side when there are any. */
export function tuningSteps(outputs: readonly (OutputSlot | null)[], crossoversHz: readonly number[]): TuningStep[] {
  const used = outputs.flatMap((slot, index) => (slot ? [{ slot, index }] : []));
  const steps: TuningStep[] = [];
  for (let crossover = crossoversHz.length - 1; crossover >= 0; crossover--) {
    const uppers = used.filter((output) => output.slot.band === crossover + 1);
    for (const lower of used.filter((output) => output.slot.band === crossover)) {
      const sameSide = uppers.filter((output) => output.slot.side === lower.slot.side);
      steps.push({
        crossover,
        crossoverHz: crossoversHz[crossover]!,
        lower: lower.index,
        uppers: (sameSide.length > 0 ? sameSide : uppers).map((output) => output.index),
      });
    }
  }
  return steps;
}

/** Index into TONE_FREQS of the sine closest to a frequency (on a log scale). */
export function nearestToneIndex(hz: number): number {
  let best = 0;
  TONE_FREQS.forEach((freq, index) => {
    if (Math.abs(Math.log(freq / hz)) < Math.abs(Math.log(TONE_FREQS[best]! / hz))) best = index;
  });
  return best;
}

/** Half a period either side of the start: the null found is then on the right cycle. */
export function offsetLimits(startMs: number, toneHz: number): { min: number; max: number } {
  const halfPeriodMs = 500 / toneHz;
  return { min: Math.max(OFFSET_RANGE.min, startMs - halfPeriodMs), max: Math.min(OFFSET_RANGE.max, startMs + halfPeriodMs) };
}

/** The mutes, polarities and delays of the four outputs. */
export function snapshotOf(model: DeviceModel): TuningSnapshot {
  return {
    mutes: OUTPUTS.map((ch) => model.channels[ch]!.mute),
    polarities: OUTPUTS.map((ch) => model.channels[ch]!.polarity),
    delaysMs: OUTPUTS.map((ch) => model.channels[ch]!.delayMs ?? 0),
  };
}

/** Only the pair plays, the lower output with its polarity flipped. */
export function startAssignments(snapshot: TuningSnapshot, lower: number, upper: number): ParamAssignment[] {
  const mutes = OUTPUTS.map((ch, i): ParamAssignment => ({ ref: { kind: "mute", ch }, value: i !== lower && i !== upper }));
  return [...mutes, { ref: { kind: "polarity", ch: OUT_BASE + lower }, value: !snapshot.polarities[lower] }];
}

/** The delays of every used output with one output's offset changed. */
export function offsetAssignments(rig: Rig, index: number, offsetMs: number): ParamAssignment[] {
  const offsetsMs = [...rig.alignment.offsetsMs] as Rig["alignment"]["offsetsMs"];
  offsetsMs[index] = offsetMs;
  const delays = outputDelaysMs({ ...rig, alignment: { ...rig.alignment, offsetsMs } });
  return delays.flatMap((ms, i): ParamAssignment[] => (ms === null ? [] : [{ ref: { kind: "delay", ch: OUT_BASE + i }, value: ms }]));
}

/** Back to the snapshot (unknown mutes become unmuted); the delays too unless they are kept. */
export function restoreAfterTuning(snapshot: TuningSnapshot, keepDelays: boolean): ParamAssignment[] {
  return OUTPUTS.flatMap((ch, i): ParamAssignment[] => [
    { ref: { kind: "mute", ch }, value: snapshot.mutes[i] ?? false },
    { ref: { kind: "polarity", ch }, value: snapshot.polarities[i]! },
    ...(keepDelays ? [] : [{ ref: { kind: "delay", ch }, value: snapshot.delaysMs[i]! } satisfies ParamAssignment]),
  ]);
}

/** Why fine tuning cannot start now, or null when it can. */
export function tuningBlocker(context: TuningContext): string | null {
  const { rig, model } = context;
  if (!context.connected) return "Connect the device first";
  if (!rig.alignment.enabled) return "Switch time alignment on first";
  if (tuningSteps(rig.outputs, rig.crossoversHz).length === 0) return "This layout has no crossover to tune";
  if (!context.valid) return "Fix the problems in the setup first";
  const applied = outputDelaysMs(rig).every((ms, i) =>
    ms === null || Math.abs((model.channels[OUT_BASE + i]!.delayMs ?? 0) - ms) <= DELAY_TOLERANCE_MS);
  return applied ? null : "Apply the setup first: the device delays differ from it";
}

const fourOf = (value: unknown, check: (entry: unknown) => boolean): boolean =>
  Array.isArray(value) && value.length === OUTPUT_COUNT && value.every(check);

/** The snapshot of an unfinished session, or null when there is none or it is unreadable. */
export function loadTuningSnapshot(storage: StorageLike | null): TuningSnapshot | null {
  let data: unknown;
  try {
    data = JSON.parse(storage?.getItem(TUNING_SESSION_KEY) ?? "null");
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { mutes, polarities, delaysMs } = data as Record<string, unknown>;
  const valid = fourOf(mutes, (m) => m === null || typeof m === "boolean")
    && fourOf(polarities, (p) => typeof p === "boolean")
    && fourOf(delaysMs, (d) => typeof d === "number" && Number.isFinite(d));
  return valid ? ({ mutes, polarities, delaysMs } as TuningSnapshot) : null;
}

/** Keeps the snapshot so a reload during a session can still put the outputs back. */
export function saveTuningSnapshot(storage: StorageLike | null, snapshot: TuningSnapshot): void {
  try {
    storage?.setItem(TUNING_SESSION_KEY, JSON.stringify(snapshot));
  } catch {
    // storage full or denied: the session still works, it just cannot be put back after a reload
  }
}

/** Forgets the snapshot once the session has ended. */
export function clearTuningSnapshot(storage: StorageLike | null): void {
  try {
    storage?.setItem(TUNING_SESSION_KEY, "null");
  } catch {
    // storage denied: nothing was saved either
  }
}

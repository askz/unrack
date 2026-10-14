// Group mute actions on the four outputs (mute all / unmute all, solo) as parameter
// assignments the editor applies in one undo step.
import { OUT_BASE, OUTPUT_COUNT, type DeviceModel } from "./model.ts";
import type { ParamAssignment } from "./params.ts";

/** Mute state of Out 1..4; null = unknown (the device has no mute readback). */
export type MuteSnapshot = (boolean | null)[];

const OUTPUTS = Array.from({ length: OUTPUT_COUNT }, (_, i) => OUT_BASE + i);
const mute = (ch: number, on: boolean): ParamAssignment => ({ ref: { kind: "mute", ch }, value: on });

export function outputMutes(model: DeviceModel): MuteSnapshot {
  return OUTPUTS.map((ch) => model.channels[ch]!.mute);
}

export function muteAllAssignments(): ParamAssignment[] {
  return OUTPUTS.map((ch) => mute(ch, true));
}

/** Back to a snapshot; unknown entries, or no snapshot at all, become unmuted. */
export function restoreAssignments(snapshot: MuteSnapshot | null): ParamAssignment[] {
  return OUTPUTS.map((ch, i) => mute(ch, snapshot?.[i] ?? false));
}

/** Soloed outputs play; every other output is muted. */
export function soloAssignments(soloed: ReadonlySet<number>): ParamAssignment[] {
  return OUTPUTS.map((ch) => mute(ch, !soloed.has(ch)));
}

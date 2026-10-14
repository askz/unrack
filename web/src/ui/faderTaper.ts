// Gain fader geometry: travel follows the device's own level scale (raw 0..400), so
// 0 dB sits at 70 % and the coarse range below -20 dB takes the bottom fifth.
import { GAIN_MAX_RAW, gainDbToRaw, gainDbToRawContinuous, gainRawToDb } from "../protocol/control.ts";

export const FADER_TICKS_DB = [12, 6, 0, -6, -12, -20, -40, -60] as const;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function dbToPosition(db: number): number {
  return clamp01(gainDbToRawContinuous(db) / GAIN_MAX_RAW);
}

export function positionToDb(position: number): number {
  return gainRawToDb(clamp01(position) * GAIN_MAX_RAW);
}

/** Step a gain by deltaDb; a step that would round back to the same device value moves one device step instead. */
export function stepGainDb(db: number, deltaDb: number): number {
  if (deltaDb === 0) return db;
  const fromRaw = gainDbToRaw(db);
  let raw = gainDbToRaw(db + deltaDb);
  if (raw === fromRaw) raw = fromRaw + Math.sign(deltaDb);
  return gainRawToDb(Math.max(0, Math.min(GAIN_MAX_RAW, raw)));
}

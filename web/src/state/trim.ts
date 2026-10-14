// Shifting all output gains by one offset while keeping their differences. Each gain
// is clamped to the device range (or a lower ceiling) and the caller learns if any was.
import { GAIN_RANGE } from "./params.ts";

export function trimmedGains(base: readonly number[], offsetDb: number, maxDb: number = GAIN_RANGE.max): { gains: number[]; clamped: boolean } {
  let clamped = false;
  const gains = base.map((db) => {
    const target = db + offsetDb;
    const limited = Math.min(maxDb, Math.max(GAIN_RANGE.min, target));
    if (limited !== target) clamped = true;
    return limited;
  });
  return { gains, clamped };
}

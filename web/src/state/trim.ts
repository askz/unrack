// Shifting all output gains by one offset while keeping their differences. Each gain
// is clamped to the device range (or a lower ceiling, one for all or one per output)
// and the caller learns if any was.
import { GAIN_RANGE } from "./params.ts";

export function trimmedGains(
  base: readonly number[],
  offsetDb: number,
  maxDb: number | readonly number[] = GAIN_RANGE.max,
): { gains: number[]; clamped: boolean } {
  let clamped = false;
  const gains = base.map((db, i) => {
    const target = db + offsetDb;
    const max = Math.min(GAIN_RANGE.max, typeof maxDb === "number" ? maxDb : maxDb[i] ?? GAIN_RANGE.max);
    const limited = Math.min(max, Math.max(GAIN_RANGE.min, target));
    if (limited !== target) clamped = true;
    return limited;
  });
  return { gains, clamped };
}

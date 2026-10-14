/** CSS colour of a frequency band: warm for low, cool for high; the accent when there is only one band. */
export function bandColour(bands: number, band: number): string {
  if (bands === 1) return "var(--accent)";
  return `var(--band-${Math.round((band * 3) / (bands - 1))})`;
}

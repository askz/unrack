// The look chosen in Settings, as a theme name and CSS properties for the document
// root: density (control height and gaps), text size and channel colours.
import { CHANNEL_COUNT } from "../state/model.ts";
import type { Settings } from "../state/settings.ts";

export interface Appearance {
  theme: "dark" | "light";
  /** CSS properties (custom properties and font-size) for the root element. */
  vars: Record<string, string>;
}

const DENSITY: Readonly<Record<Settings["density"], { controlPx: number; gapPx: number }>> = {
  compact: { controlPx: 24, gapPx: 6 },
  comfortable: { controlPx: 28, gapPx: 8 },
  touch: { controlPx: 40, gapPx: 12 },
};

const TEXT_PX: Readonly<Record<Settings["textSize"], number>> = { small: 12, normal: 13, large: 15 };

export function appearanceVars(settings: Settings, prefersLight: boolean): Appearance {
  const theme = settings.theme === "system" ? (prefersLight ? "light" : "dark") : settings.theme;
  const density = DENSITY[settings.density];
  const vars: Record<string, string> = {
    "--control-h": `${density.controlPx}px`,
    "--gap": `${density.gapPx}px`,
    "font-size": `${TEXT_PX[settings.textSize]}px`,
  };
  for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
    const colour = settings.colors[ch];
    if (colour) vars[`--ch-${ch}`] = colour;
  }
  return { theme, vars };
}

// Preferences of this browser (not device state), stored as JSON and validated field
// by field: a corrupt or outdated stored value only loses the fields that are wrong.
import { CHANNEL_COUNT } from "./model.ts";
import { GAIN_RANGE } from "./params.ts";

export const SETTINGS_STORAGE_KEY = "opendsp-4x4.settings";
export const SETTINGS_VERSION = 1;
export const NAME_MAX_LENGTH = 16;

export const GAIN_STEPS_DB = [0.1, 0.5, 1, 3] as const;
/** Frequency steps per octave (30 = the device's own resolution). */
export const FREQ_STEP_DIVISIONS = [30, 12, 6, 3] as const;
export const EQ_RANGES_DB = [12, 18, 24] as const;
export const PEAK_HOLDS_MS = [0, 1200, 3000] as const;
export const EQ_WIDTHS = ["q", "octaves"] as const;
export const THEMES = ["dark", "light", "system"] as const;
export const DENSITIES = ["compact", "comfortable", "touch"] as const;
export const TEXT_SIZES = ["small", "normal", "large"] as const;
export const DISTANCE_UNITS = ["m", "ft"] as const;
export const TEMPERATURE_UNITS = ["C", "F"] as const;
export const START_VIEWS = ["last", "overview"] as const;

/** Channel marker colours: the defaults of In A … Out 4, then four extras. */
export const CHANNEL_PALETTE = [
  "#d97aa6", "#d9925a", "#cfc05a", "#8fc25a", "#5aa7d9", "#7f8ad9", "#a97fd9", "#5ac2b4",
  "#e07a7a", "#c9c9c9", "#7ad9d0", "#b48a5a",
] as const;

export interface Settings {
  version: typeof SETTINGS_VERSION;
  /** Display name per channel address; "" = the device's name. */
  names: string[];
  colors: string[];
  /** Channel addresses left out of the tabs and the Overview. */
  hidden: number[];
  gainStepDb: (typeof GAIN_STEPS_DB)[number];
  freqStepDivisions: (typeof FREQ_STEP_DIVISIONS)[number];
  eqWidth: (typeof EQ_WIDTHS)[number];
  eqRangeDb: (typeof EQ_RANGES_DB)[number];
  peakHoldMs: (typeof PEAK_HOLDS_MS)[number];
  theme: (typeof THEMES)[number];
  density: (typeof DENSITIES)[number];
  textSize: (typeof TEXT_SIZES)[number];
  distanceUnit: (typeof DISTANCE_UNITS)[number];
  temperatureUnit: (typeof TEMPERATURE_UNITS)[number];
  /** Highest output gain the UI may set; null = no limit. */
  gainCeilingDb: number | null;
  startView: (typeof START_VIEWS)[number];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

function perChannel<T>(value: unknown, parse: (entry: unknown, index: number) => T): T[] {
  const list: unknown[] = Array.isArray(value) ? value : [];
  return Array.from({ length: CHANNEL_COUNT }, (_, index) => parse(list[index], index));
}

function parseName(entry: unknown): string {
  return typeof entry === "string" ? entry.trim().slice(0, NAME_MAX_LENGTH) : "";
}

function parseColor(entry: unknown, index: number): string {
  return oneOf<string>(entry, CHANNEL_PALETTE, CHANNEL_PALETTE[index]!);
}

function parseHidden(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const valid = value.filter((ch): ch is number => Number.isInteger(ch) && ch >= 0 && ch < CHANNEL_COUNT);
  return [...new Set(valid)].sort((a, b) => a - b);
}

function parseCeiling(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < GAIN_RANGE.min || value > GAIN_RANGE.max) return null;
  return Math.round(value * 10) / 10;
}

export function parseSettings(raw: unknown): Settings {
  const data = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    version: SETTINGS_VERSION,
    names: perChannel(data.names, parseName),
    colors: perChannel(data.colors, parseColor),
    hidden: parseHidden(data.hidden),
    gainStepDb: oneOf(data.gainStepDb, GAIN_STEPS_DB, 0.5),
    freqStepDivisions: oneOf(data.freqStepDivisions, FREQ_STEP_DIVISIONS, 30),
    eqWidth: oneOf(data.eqWidth, EQ_WIDTHS, "q"),
    eqRangeDb: oneOf(data.eqRangeDb, EQ_RANGES_DB, 18),
    peakHoldMs: oneOf(data.peakHoldMs, PEAK_HOLDS_MS, 1200),
    theme: oneOf(data.theme, THEMES, "dark"),
    density: oneOf(data.density, DENSITIES, "comfortable"),
    textSize: oneOf(data.textSize, TEXT_SIZES, "normal"),
    distanceUnit: oneOf(data.distanceUnit, DISTANCE_UNITS, "m"),
    temperatureUnit: oneOf(data.temperatureUnit, TEMPERATURE_UNITS, "C"),
    gainCeilingDb: parseCeiling(data.gainCeilingDb),
    startView: oneOf(data.startView, START_VIEWS, "last"),
  };
}

export function defaultSettings(): Settings {
  return parseSettings(undefined);
}

/** Never throws: unreadable or corrupt storage gives the defaults. */
export function loadSettings(storage: StorageLike | null): Settings {
  if (!storage) return defaultSettings();
  try {
    const text = storage.getItem(SETTINGS_STORAGE_KEY);
    return parseSettings(text === null ? undefined : JSON.parse(text));
  } catch {
    return defaultSettings();
  }
}

/** False when the settings could not be stored (no storage, quota, privacy mode). */
export function saveSettings(storage: StorageLike | null, settings: Settings): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

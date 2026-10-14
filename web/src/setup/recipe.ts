// A setup recipe: speaker layout + environment + a few system parameters, as plain
// JSON-safe data. Built-in and custom presets are recipes; build.ts turns one into
// device parameters. Validation here never throws: it lists readable problems, each
// tied to the form field it concerns.
import { OUT_BASE, OUTPUT_COUNT } from "../state/model.ts";
import { COMP_RANGES, DELAY_RANGE, GAIN_RANGE, PEQ_GAIN_RANGE, type Range } from "../state/params.ts";

export const RECIPE_VERSION = 1;

export type LayoutId = "2.0" | "2.1" | "2.2" | "top-kick-sub" | "top-kick-sub-mono" | "biamp" | "4way";
export type Role = "main" | "fill" | "top" | "kick" | "sub" | "low" | "mid" | "high";
export type EnvironmentId = "neutral" | "indoor" | "outdoor" | "club" | "speech" | "background";
export type Side = "L" | "R" | "mono";
export type SlopeId = "LR24" | "LR12";
export type SourceId = "stereo" | "mono";

export interface Recipe {
  version: typeof RECIPE_VERSION;
  layout: LayoutId;
  /** stereo: A = left, B = right; mono: A only. */
  source: SourceId;
  /** Ascending, one per split between two bands. */
  crossoversHz: number[];
  slope: SlopeId;
  subsonic: { enabled: boolean; freqHz: number };
  /** Missing role = 0 dB. */
  trimsDb: Partial<Record<Role, number>>;
  invert: Role[];
  /** distancesM is indexed by output (Out 1 to Out 4); spare outputs are ignored. */
  alignment: { enabled: boolean; tempC: number; distancesM: [number, number, number, number] };
  /** Missing role = 0 dB. */
  protection: { enabled: boolean; thresholdDb: Partial<Record<Role, number>> };
  environment: { id: EnvironmentId; lowDb: number; highDb: number };
}

export interface OutputSlot {
  role: Role;
  side: Side;
  /** Frequency band, 0 = lowest. */
  band: number;
  /** Display name given to the output when the setup is applied. */
  name: string;
}

export interface Layout {
  id: LayoutId;
  name: string;
  description: string;
  /** Out 1 to Out 4; null = spare (silent). */
  outputs: readonly (OutputSlot | null)[];
  /** Default crossover frequencies; their count fixes the number of bands. */
  crossoversHz: readonly number[];
}

export interface Environment {
  id: EnvironmentId;
  name: string;
  hint: string;
  lowHz: number;
  highHz: number;
  lowDb: number;
  highDb: number;
}

export interface RecipeProblem {
  /** Form field the problem belongs to, e.g. "crossoversHz.1" or "trimsDb.sub". */
  field: string;
  message: string;
}

export const ROLES: readonly Role[] = ["main", "fill", "top", "kick", "sub", "low", "mid", "high"];
export const ROLE_NAMES: Readonly<Record<Role, string>> = {
  main: "Main", fill: "Fill", top: "Top", kick: "Kick", sub: "Sub", low: "Low", mid: "Mid", high: "High",
};
export const SOURCES: readonly SourceId[] = ["stereo", "mono"];
export const SLOPES: readonly SlopeId[] = ["LR24", "LR12"];

const slot = (role: Role, side: Side, band: number, name: string): OutputSlot => ({ role, side, band, name });

export const LAYOUTS: Readonly<Record<LayoutId, Layout>> = {
  "2.0": {
    id: "2.0", name: "2.0 stereo", description: "Stereo mains and stereo fills, full range",
    outputs: [slot("main", "L", 0, "Main L"), slot("main", "R", 0, "Main R"), slot("fill", "L", 0, "Fill L"), slot("fill", "R", 0, "Fill R")],
    crossoversHz: [],
  },
  "2.1": {
    id: "2.1", name: "2.1", description: "Stereo tops and one sub",
    outputs: [slot("top", "L", 1, "Top L"), slot("top", "R", 1, "Top R"), slot("sub", "mono", 0, "Sub"), null],
    crossoversHz: [100],
  },
  "2.2": {
    id: "2.2", name: "2.2", description: "Stereo tops and stereo subs",
    outputs: [slot("top", "L", 1, "Top L"), slot("top", "R", 1, "Top R"), slot("sub", "L", 0, "Sub L"), slot("sub", "R", 0, "Sub R")],
    crossoversHz: [100],
  },
  "top-kick-sub": {
    id: "top-kick-sub", name: "Top / Kick / Sub", description: "Stereo tops, a kick bin and a sub",
    outputs: [slot("top", "L", 2, "Top L"), slot("top", "R", 2, "Top R"), slot("kick", "mono", 1, "Kick"), slot("sub", "mono", 0, "Sub")],
    crossoversHz: [90, 180],
  },
  "top-kick-sub-mono": {
    id: "top-kick-sub-mono", name: "Top / Kick / Sub, mono", description: "One top, a kick bin and a sub",
    outputs: [slot("top", "mono", 2, "Top"), slot("kick", "mono", 1, "Kick"), slot("sub", "mono", 0, "Sub"), null],
    crossoversHz: [90, 180],
  },
  biamp: {
    id: "biamp", name: "Bi-amp stereo", description: "Two-way speakers, woofer and tweeter amplified apart",
    outputs: [slot("low", "L", 0, "Low L"), slot("high", "L", 1, "High L"), slot("low", "R", 0, "Low R"), slot("high", "R", 1, "High R")],
    crossoversHz: [1600],
  },
  "4way": {
    id: "4way", name: "4-way mono", description: "One four-way system: sub, low, mid and high",
    outputs: [slot("sub", "mono", 0, "Sub"), slot("low", "mono", 1, "Low"), slot("mid", "mono", 2, "Mid"), slot("high", "mono", 3, "High")],
    crossoversHz: [90, 250, 1600],
  },
};
export const LAYOUT_IDS = Object.keys(LAYOUTS) as LayoutId[];

export const ENVIRONMENTS: Readonly<Record<EnvironmentId, Environment>> = {
  neutral: { id: "neutral", name: "Neutral", hint: "Flat: only your own EQ", lowHz: 60, highHz: 10000, lowDb: 0, highDb: 0 },
  indoor: { id: "indoor", name: "Indoor", hint: "Less low end, the room adds its own", lowHz: 60, highHz: 10000, lowDb: -3, highDb: -1 },
  outdoor: { id: "outdoor", name: "Outdoor", hint: "More lows and air, nothing reflects them back", lowHz: 60, highHz: 8000, lowDb: 3, highDb: 2 },
  club: { id: "club", name: "Club", hint: "Heavy low end and a little sparkle", lowHz: 60, highHz: 10000, lowDb: 4, highDb: 1.5 },
  speech: { id: "speech", name: "Speech", hint: "Cuts rumble, lifts voice clarity", lowHz: 150, highHz: 4000, lowDb: -6, highDb: 2 },
  background: { id: "background", name: "Background", hint: "Full sound at low volume", lowHz: 100, highHz: 8000, lowDb: 3, highDb: 2 },
};
export const ENVIRONMENT_IDS = Object.keys(ENVIRONMENTS) as EnvironmentId[];

export const CROSSOVER_RANGE: Range = { min: 20, max: 20000, unit: "Hz" };
export const SUBSONIC_RANGE: Range = { min: 20, max: 80, unit: "Hz" };
export const TEMPERATURE_RANGE: Range = { min: -20, max: 45, unit: "C" };
export const DISTANCE_RANGE: Range = { min: 0, max: 250, unit: "m" };
export const SHELF_RANGE: Range = PEQ_GAIN_RANGE;
export const TRIM_RANGE: Range = GAIN_RANGE;
export const THRESHOLD_RANGE: Range = COMP_RANGES.thresholdDb;
/** Neighbouring crossovers must be at least a third of an octave apart. */
const MIN_CROSSOVER_RATIO = Math.pow(2, 1 / 3);
const EPSILON = 1e-9;
const DEFAULT_SUBSONIC_HZ = 30;
const DEFAULT_TEMP_C = 20;

// ---- construction ----

export function defaultRecipe(layout: LayoutId = "2.1"): Recipe {
  return {
    version: RECIPE_VERSION,
    layout,
    source: "stereo",
    crossoversHz: [...LAYOUTS[layout].crossoversHz],
    slope: "LR24",
    subsonic: { enabled: false, freqHz: DEFAULT_SUBSONIC_HZ },
    trimsDb: {},
    invert: [],
    alignment: { enabled: false, tempC: DEFAULT_TEMP_C, distancesM: [0, 0, 0, 0] },
    protection: { enabled: false, thresholdDb: {} },
    environment: { id: "neutral", lowDb: 0, highDb: 0 },
  };
}

const copy = (recipe: Recipe): Recipe => JSON.parse(JSON.stringify(recipe)) as Recipe;

/** Another layout: its default crossovers, every other field kept. */
export function withLayout(recipe: Recipe, layout: LayoutId): Recipe {
  return { ...copy(recipe), layout, crossoversHz: [...LAYOUTS[layout].crossoversHz] };
}

/** Another environment with its default shelf gains. */
export function withEnvironment(recipe: Recipe, id: EnvironmentId): Recipe {
  const environment = ENVIRONMENTS[id];
  return { ...copy(recipe), environment: { id, lowDb: environment.lowDb, highDb: environment.highDb } };
}

// ---- layout queries ----

export function usedOutputs(layout: Layout): { ch: number; index: number; slot: OutputSlot }[] {
  return layout.outputs.flatMap((output, index) => (output ? [{ ch: OUT_BASE + index, index, slot: output }] : []));
}

/** Addresses of the outputs the layout leaves silent. */
export function spareOutputs(layout: Layout): number[] {
  return layout.outputs.flatMap((output, index) => (output ? [] : [OUT_BASE + index]));
}

/** Roles of a layout, each once, in output order. */
export function layoutRoles(layout: Layout): Role[] {
  return [...new Set(usedOutputs(layout).map((output) => output.slot.role))];
}

export function bandCount(layout: Layout): number {
  return layout.crossoversHz.length + 1;
}

/** Speed of sound in air (m/s) at a temperature in degrees Celsius. */
export function speedOfSound(tempC: number): number {
  return 331.3 + 0.606 * tempC;
}

/** Delay per output (ms) that aligns every used output on the farthest one; null for spare outputs. */
export function alignmentDelaysMs(recipe: Recipe): (number | null)[] {
  const layout = LAYOUTS[recipe.layout];
  const used = usedOutputs(layout);
  const farthest = Math.max(...used.map((output) => recipe.alignment.distancesM[output.index] ?? 0));
  const speed = speedOfSound(recipe.alignment.tempC);
  return Array.from({ length: OUTPUT_COUNT }, (_, index) => {
    if (!layout.outputs[index]) return null;
    return ((farthest - (recipe.alignment.distancesM[index] ?? 0)) / speed) * 1000;
  });
}

// ---- validation ----

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isLayoutId = (value: unknown): value is LayoutId => typeof value === "string" && (LAYOUT_IDS as string[]).includes(value);
const isRole = (value: unknown): value is Role => typeof value === "string" && (ROLES as string[]).includes(value);
const inRange = (value: number, range: Range) => value >= range.min - EPSILON && value <= range.max + EPSILON;

function formatValue(value: number, unit: string): string {
  if (unit === "Hz" && value >= 1000) return `${value / 1000} kHz`;
  return `${value}${unit === "C" ? " °C" : ` ${unit}`}`;
}

const between = (range: Range) => `between ${formatValue(range.min, range.unit)} and ${formatValue(range.max, range.unit)}`;

type Report = (field: string, message: string) => void;

function checkCrossovers(value: unknown, layout: Layout, report: Report): void {
  const count = layout.crossoversHz.length;
  if (!Array.isArray(value) || value.length !== count) {
    report("crossoversHz", `${layout.name} needs ${count} crossover frequenc${count === 1 ? "y" : "ies"}`);
    return;
  }
  value.forEach((hz: unknown, i) => {
    const field = `crossoversHz.${i}`;
    const name = `Crossover ${i + 1}`;
    if (!isNumber(hz)) report(field, `${name} must be a number`);
    else if (!inRange(hz, CROSSOVER_RANGE)) report(field, `${name} must be ${between(CROSSOVER_RANGE)}`);
    else if (i > 0 && isNumber(value[i - 1]) && hz < (value[i - 1] as number) * MIN_CROSSOVER_RATIO - EPSILON) {
      report(field, `${name} must be at least 1/3 octave above crossover ${i}`);
    }
  });
}

function checkSubsonic(value: unknown, report: Report): void {
  if (!isObject(value) || typeof value.enabled !== "boolean") {
    report("subsonic", "The subsonic filter settings are invalid");
  } else if (!isNumber(value.freqHz)) {
    report("subsonic.freqHz", "The subsonic frequency must be a number");
  } else if (value.enabled && !inRange(value.freqHz, SUBSONIC_RANGE)) {
    report("subsonic.freqHz", `The subsonic frequency must be ${between(SUBSONIC_RANGE)}`);
  }
}

/** A role -> number map (trims, thresholds). Unknown keys are ignored. */
function checkRoleNumbers(field: string, value: unknown, what: string, range: Range, checkRanges: boolean, report: Report): void {
  if (!isObject(value)) {
    report(field, `The ${what} settings are invalid`);
    return;
  }
  for (const role of ROLES) {
    const entry = value[role];
    if (entry === undefined) continue;
    const name = `${ROLE_NAMES[role]} ${what}`;
    if (!isNumber(entry)) report(`${field}.${role}`, `${name} must be a number`);
    else if (checkRanges && !inRange(entry, range)) report(`${field}.${role}`, `${name} must be ${between(range)}`);
  }
}

function checkAlignment(value: unknown, recipe: Record<string, unknown>, layout: Layout | null, report: Report): void {
  if (!isObject(value) || typeof value.enabled !== "boolean" || !Array.isArray(value.distancesM) || value.distancesM.length !== OUTPUT_COUNT) {
    report("alignment", "The time alignment settings are invalid");
    return;
  }
  let valid = true;
  if (!isNumber(value.tempC)) {
    report("alignment.tempC", "The temperature must be a number");
    valid = false;
  } else if (value.enabled && !inRange(value.tempC, TEMPERATURE_RANGE)) {
    report("alignment.tempC", `The temperature must be ${between(TEMPERATURE_RANGE)}`);
    valid = false;
  }
  const indexes = layout ? usedOutputs(layout).map((output) => output.index) : [0, 1, 2, 3];
  for (const index of indexes) {
    const distance: unknown = value.distancesM[index];
    const field = `alignment.distancesM.${index}`;
    if (!isNumber(distance)) {
      report(field, `The distance of Out ${index + 1} must be a number`);
      valid = false;
    } else if (value.enabled && !inRange(distance, DISTANCE_RANGE)) {
      report(field, `The distance of Out ${index + 1} must be ${between(DISTANCE_RANGE)}`);
      valid = false;
    }
  }
  if (!value.enabled || !valid || !layout) return;
  const delays = alignmentDelaysMs({ ...(recipe as unknown as Recipe), alignment: value as Recipe["alignment"] });
  const longest = Math.max(...delays.map((delay) => delay ?? 0));
  if (longest > DELAY_RANGE.max + EPSILON) {
    report("alignment.delay", `The speakers are too far apart: the nearest one would need ${longest.toFixed(0)} ms of delay (at most ${DELAY_RANGE.max.toFixed(0)} ms)`);
  }
}

function checkProtection(value: unknown, report: Report): void {
  if (!isObject(value) || typeof value.enabled !== "boolean") {
    report("protection", "The protection settings are invalid");
    return;
  }
  checkRoleNumbers("protection.thresholdDb", value.thresholdDb, "limiter threshold", THRESHOLD_RANGE, value.enabled, report);
}

function checkEnvironment(value: unknown, report: Report): void {
  if (!isObject(value)) {
    report("environment", "The environment settings are invalid");
    return;
  }
  if (typeof value.id !== "string" || !(ENVIRONMENT_IDS as string[]).includes(value.id)) {
    report("environment.id", `Unknown environment ${String(value.id)}`);
  }
  for (const [key, name] of [["lowDb", "Low shelf"], ["highDb", "High shelf"]] as const) {
    const gain = value[key];
    if (!isNumber(gain)) report(`environment.${key}`, `${name} must be a number`);
    else if (!inRange(gain, SHELF_RANGE)) report(`environment.${key}`, `${name} must be ${between(SHELF_RANGE)}`);
  }
}

/** Readable problems of an untrusted recipe; empty = valid. Never throws. */
export function checkRecipe(raw: unknown): RecipeProblem[] {
  if (!isObject(raw)) return [{ field: "recipe", message: "This is not a setup" }];
  const problems: RecipeProblem[] = [];
  const report: Report = (field, message) => problems.push({ field, message });

  if (raw.version !== RECIPE_VERSION) report("version", `Unsupported setup version ${String(raw.version)} (this app reads version ${RECIPE_VERSION})`);
  const layout = isLayoutId(raw.layout) ? LAYOUTS[raw.layout] : null;
  if (!layout) report("layout", `Unknown layout ${String(raw.layout)}`);
  if (!(SOURCES as unknown[]).includes(raw.source)) report("source", `Unknown source ${String(raw.source)}`);
  if (!(SLOPES as unknown[]).includes(raw.slope)) report("slope", `Unknown slope ${String(raw.slope)}`);
  if (layout) checkCrossovers(raw.crossoversHz, layout, report);
  checkSubsonic(raw.subsonic, report);
  checkRoleNumbers("trimsDb", raw.trimsDb, "trim", TRIM_RANGE, true, report);
  if (!Array.isArray(raw.invert) || !raw.invert.every((role) => typeof role === "string")) {
    report("invert", "The polarity settings are invalid");
  }
  checkAlignment(raw.alignment, raw, layout, report);
  checkProtection(raw.protection, report);
  checkEnvironment(raw.environment, report);
  return problems;
}

// ---- repair of stored drafts ----

function roleNumbers(value: unknown): Partial<Record<Role, number>> {
  if (!isObject(value)) return {};
  const result: Partial<Record<Role, number>> = {};
  for (const role of ROLES) {
    const entry = value[role];
    if (isNumber(entry)) result[role] = entry;
  }
  return result;
}

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

const numberOr = (value: unknown, fallback: number) => (isNumber(value) ? value : fallback);
const booleanOr = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

/**
 * A stored draft as a usable recipe: null when it is not a recipe of this version
 * with a known layout. Wrong-typed fields get their default; out-of-range values are
 * kept so the form can show them as problems. A wrong crossover count gets the
 * layout's defaults (the form has one field per crossover of the layout).
 */
export function coerceRecipe(raw: unknown): Recipe | null {
  if (!isObject(raw) || raw.version !== RECIPE_VERSION || !isLayoutId(raw.layout)) return null;
  const base = defaultRecipe(raw.layout);
  const crossovers = raw.crossoversHz;
  const subsonic = isObject(raw.subsonic) ? raw.subsonic : {};
  const alignment = isObject(raw.alignment) && Array.isArray(raw.alignment.distancesM) && raw.alignment.distancesM.length === OUTPUT_COUNT
    ? raw.alignment
    : null;
  const protection = isObject(raw.protection) ? raw.protection : {};
  const environment = isObject(raw.environment) ? raw.environment : {};
  return {
    version: RECIPE_VERSION,
    layout: raw.layout,
    source: pick(raw.source, SOURCES, base.source),
    crossoversHz: Array.isArray(crossovers) && crossovers.length === base.crossoversHz.length && crossovers.every(isNumber)
      ? [...crossovers]
      : base.crossoversHz,
    slope: pick(raw.slope, SLOPES, base.slope),
    subsonic: { enabled: booleanOr(subsonic.enabled, false), freqHz: numberOr(subsonic.freqHz, base.subsonic.freqHz) },
    trimsDb: roleNumbers(raw.trimsDb),
    invert: Array.isArray(raw.invert) ? [...new Set(raw.invert.filter(isRole))] : [],
    alignment: alignment
      ? {
        enabled: booleanOr(alignment.enabled, false),
        tempC: numberOr(alignment.tempC, base.alignment.tempC),
        distancesM: (alignment.distancesM as unknown[]).map((d) => numberOr(d, 0)) as Recipe["alignment"]["distancesM"],
      }
      : base.alignment,
    protection: { enabled: booleanOr(protection.enabled, false), thresholdDb: roleNumbers(protection.thresholdDb) },
    environment: {
      id: pick(environment.id, ENVIRONMENT_IDS, base.environment.id),
      lowDb: numberOr(environment.lowDb, base.environment.lowDb),
      highDb: numberOr(environment.highDb, base.environment.highDb),
    },
  };
}

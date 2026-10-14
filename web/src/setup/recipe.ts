// A setup recipe: speaker layout + environment + a few system parameters, as plain
// JSON-safe data. Built-in and custom presets are recipes; build.ts turns one into
// device parameters. Validation here never throws: it lists readable problems, each
// tied to the form field it concerns.
import { OUT_BASE, OUTPUT_COUNT } from "../state/model.ts";
import { COMP_RANGES, DELAY_RANGE, GAIN_RANGE, PEQ_GAIN_RANGE, type Range } from "../state/params.ts";
import { outputDelaysMs, type Alignment, type AlignmentMode, type PerOutput, type Rig, type SpeakerPosition } from "./alignment.ts";

export const RECIPE_VERSION = 2;

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
  alignment: Alignment;
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
export const POSITION_RANGE: Range = { min: -50, max: 250, unit: "m" };
export const HEIGHT_RANGE: Range = { min: 0, max: 30, unit: "m" };
export const CROWD_RANGE: Range = { min: 0, max: 250, unit: "m" };
export const EAR_HEIGHT_RANGE: Range = { min: 0.5, max: 2.5, unit: "m" };
export const OFFSET_RANGE: Range = { min: -20, max: 20, unit: "ms" };
export const MIN_CROWD_DEPTH_M = 1;
export const ALIGNMENT_MODES: readonly AlignmentMode[] = ["positions", "direct"];
export const SHELF_RANGE: Range = PEQ_GAIN_RANGE;
export const TRIM_RANGE: Range = GAIN_RANGE;
export const THRESHOLD_RANGE: Range = COMP_RANGES.thresholdDb;
/** Neighbouring crossovers must be at least a third of an octave apart. */
const MIN_CROSSOVER_RATIO = Math.pow(2, 1 / 3);
const EPSILON = 1e-9;
const DEFAULT_SUBSONIC_HZ = 30;
const DEFAULT_TEMP_C = 20;
/** Usual height of the acoustic centre by speaker kind. */
const DEFAULT_HEIGHT_M: Readonly<Record<Role, number>> = {
  sub: 0.4, kick: 0.6, top: 2, main: 2, fill: 1.5, low: 1.5, mid: 1.5, high: 1.5,
};
const SPARE_HEIGHT_M = 1.5;
const DEFAULT_CROWD = { startM: 2, endM: 20, earHeightM: 1.7 };

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
    alignment: defaultAlignment(layout),
    protection: { enabled: false, thresholdDb: {} },
    environment: { id: "neutral", lowDb: 0, highDb: 0 },
  };
}

/** Every speaker at the stage edge, at the usual height of its kind. */
export function defaultSpeakers(layout: LayoutId): PerOutput<SpeakerPosition> {
  return LAYOUTS[layout].outputs.map((output) => ({
    xM: 0,
    heightM: output ? DEFAULT_HEIGHT_M[output.role] : SPARE_HEIGHT_M,
  })) as PerOutput<SpeakerPosition>;
}

/** Alignment off, positions mode, role-based heights, default crowd, suggested point, no offsets. */
export function defaultAlignment(layout: LayoutId): Alignment {
  return {
    enabled: false,
    tempC: DEFAULT_TEMP_C,
    mode: "positions",
    distancesM: [0, 0, 0, 0],
    speakers: defaultSpeakers(layout),
    crowd: { ...DEFAULT_CROWD },
    pointM: null,
    offsetsMs: [0, 0, 0, 0],
  };
}

const copy = (recipe: Recipe): Recipe => JSON.parse(JSON.stringify(recipe)) as Recipe;

/** Another layout: its default crossovers and speaker positions (offsets cleared), every other field kept. */
export function withLayout(recipe: Recipe, layout: LayoutId): Recipe {
  const next = copy(recipe);
  return {
    ...next,
    layout,
    crossoversHz: [...LAYOUTS[layout].crossoversHz],
    alignment: { ...next.alignment, speakers: defaultSpeakers(layout), offsetsMs: [0, 0, 0, 0] },
  };
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

/** The parts of a recipe the alignment math uses. */
export function rigOf(recipe: Recipe): Rig {
  return { outputs: LAYOUTS[recipe.layout].outputs, crossoversHz: recipe.crossoversHz, alignment: recipe.alignment };
}

/** Delay per output (ms) of the time alignment, offsets included; null for spare outputs. */
export function alignmentDelaysMs(recipe: Recipe): (number | null)[] {
  return outputDelaysMs(rigOf(recipe));
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

const isPerOutput = (value: unknown): value is unknown[] => Array.isArray(value) && value.length === OUTPUT_COUNT;

function hasAlignmentShape(value: unknown): value is Record<string, unknown> {
  return isObject(value) && typeof value.enabled === "boolean" && (ALIGNMENT_MODES as unknown[]).includes(value.mode)
    && isPerOutput(value.distancesM) && isPerOutput(value.offsetsMs)
    && isPerOutput(value.speakers) && value.speakers.every(isObject)
    && isObject(value.crowd) && "pointM" in value;
}

function checkAlignment(value: unknown, recipe: Record<string, unknown>, layout: Layout | null, report: Report): void {
  if (!hasAlignmentShape(value)) {
    report("alignment", "The time alignment settings are invalid");
    return;
  }
  const on = value.enabled as boolean;
  let valid = true;
  const checkNumber = (field: string, entry: unknown, name: string, range: Range, checkRange: boolean): void => {
    if (!isNumber(entry)) {
      report(field, `${name} must be a number`);
      valid = false;
    } else if (checkRange && !inRange(entry, range)) {
      report(field, `${name} must be ${between(range)}`);
      valid = false;
    }
  };
  const indexes = layout ? usedOutputs(layout).map((output) => output.index) : [0, 1, 2, 3];
  checkNumber("alignment.tempC", value.tempC, "The temperature", TEMPERATURE_RANGE, on);
  if (value.mode === "direct") {
    const distances = value.distancesM as unknown[];
    for (const i of indexes) checkNumber(`alignment.distancesM.${i}`, distances[i], `The distance of Out ${i + 1}`, DISTANCE_RANGE, on);
  } else {
    const speakers = value.speakers as Record<string, unknown>[];
    for (const i of indexes) {
      checkNumber(`alignment.speakers.${i}.xM`, speakers[i]!.xM, `The position of Out ${i + 1}`, POSITION_RANGE, on);
      checkNumber(`alignment.speakers.${i}.heightM`, speakers[i]!.heightM, `The height of Out ${i + 1}`, HEIGHT_RANGE, on);
    }
    const crowd = value.crowd as Record<string, unknown>;
    checkNumber("alignment.crowd.startM", crowd.startM, "The start of the crowd", CROWD_RANGE, on);
    checkNumber("alignment.crowd.endM", crowd.endM, "The end of the crowd", CROWD_RANGE, on);
    checkNumber("alignment.crowd.earHeightM", crowd.earHeightM, "The ear height", EAR_HEIGHT_RANGE, on);
    const startM = crowd.startM as number;
    const endM = crowd.endM as number;
    if (valid && on && endM < startM + MIN_CROWD_DEPTH_M - EPSILON) {
      report("alignment.crowd.endM", `The crowd must end at least ${MIN_CROWD_DEPTH_M} m after it starts`);
      valid = false;
    }
    if (value.pointM !== null) {
      checkNumber("alignment.pointM", value.pointM, "The alignment point", CROWD_RANGE, false);
      const pointM = value.pointM as number;
      if (valid && on && (pointM < startM - EPSILON || pointM > endM + EPSILON)) {
        report("alignment.pointM", "The alignment point must be inside the crowd area");
        valid = false;
      }
    }
  }
  const offsets = value.offsetsMs as unknown[];
  for (const i of indexes) checkNumber(`alignment.offsetsMs.${i}`, offsets[i], `The fine-tune offset of Out ${i + 1}`, OFFSET_RANGE, on);
  if (!on || !valid || !layout) return;
  const crossovers = Array.isArray(recipe.crossoversHz) && recipe.crossoversHz.every(isNumber) && recipe.crossoversHz.length === layout.crossoversHz.length
    ? (recipe.crossoversHz as number[])
    : [...layout.crossoversHz];
  const delays = outputDelaysMs({ outputs: layout.outputs, crossoversHz: crossovers, alignment: value as unknown as Alignment });
  const longest = Math.max(...delays.map((delay) => delay ?? 0));
  if (longest > DELAY_RANGE.max + EPSILON) {
    report("alignment.delay", `The speakers are too far apart: one of them would need ${longest.toFixed(0)} ms of delay (at most ${DELAY_RANGE.max.toFixed(0)} ms)`);
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

function perOutputNumbers(value: unknown, fallback: PerOutput<number>): PerOutput<number> {
  if (!Array.isArray(value) || value.length !== OUTPUT_COUNT) return [...fallback] as PerOutput<number>;
  return value.map((entry: unknown, i) => numberOr(entry, fallback[i]!)) as PerOutput<number>;
}

function coerceAlignment(raw: unknown, layout: LayoutId): Alignment {
  const base = defaultAlignment(layout);
  if (!isObject(raw)) return base;
  const speakers = Array.isArray(raw.speakers) && raw.speakers.length === OUTPUT_COUNT
    ? raw.speakers.map((entry: unknown, i) => {
      const fallback = base.speakers[i]!;
      return isObject(entry) ? { xM: numberOr(entry.xM, fallback.xM), heightM: numberOr(entry.heightM, fallback.heightM) } : { ...fallback };
    }) as PerOutput<SpeakerPosition>
    : base.speakers;
  const crowd = isObject(raw.crowd) ? raw.crowd : {};
  return {
    enabled: booleanOr(raw.enabled, false),
    tempC: numberOr(raw.tempC, base.tempC),
    mode: pick(raw.mode, ALIGNMENT_MODES, base.mode),
    distancesM: perOutputNumbers(raw.distancesM, base.distancesM),
    speakers,
    crowd: {
      startM: numberOr(crowd.startM, base.crowd.startM),
      endM: numberOr(crowd.endM, base.crowd.endM),
      earHeightM: numberOr(crowd.earHeightM, base.crowd.earHeightM),
    },
    pointM: isNumber(raw.pointM) ? raw.pointM : null,
    offsetsMs: perOutputNumbers(raw.offsetsMs, base.offsetsMs),
  };
}

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
    alignment: coerceAlignment(raw.alignment, raw.layout),
    protection: { enabled: booleanOr(protection.enabled, false), thresholdDb: roleNumbers(protection.thresholdDb) },
    environment: {
      id: pick(environment.id, ENVIRONMENT_IDS, base.environment.id),
      lowDb: numberOr(environment.lowDb, base.environment.lowDb),
      highDb: numberOr(environment.highDb, base.environment.highDb),
    },
  };
}

// ---- older versions ----

/** A version 1 recipe as version 2: its distances become direct mode (same delays), new fields get defaults. Anything else is returned as is. */
export function upgradeRecipe(raw: unknown): unknown {
  if (!isObject(raw) || raw.version !== 1) return raw;
  const layout = isLayoutId(raw.layout) ? raw.layout : "2.1";
  const alignment = isObject(raw.alignment) ? { ...defaultAlignment(layout), ...raw.alignment, mode: "direct" } : raw.alignment;
  return { ...raw, version: RECIPE_VERSION, alignment };
}

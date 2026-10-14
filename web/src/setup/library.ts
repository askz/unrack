// Setup presets: read-only built-ins, custom presets and the form draft kept in this
// browser, and setup files. Stored data is checked when read: an unreadable entry is
// dropped instead of breaking the Setup tab. File import is strict.
import type { StorageLike } from "../state/settings.ts";
import { LAYOUTS, LAYOUT_IDS, checkRecipe, coerceRecipe, defaultRecipe, withEnvironment, type LayoutId, type Recipe } from "./recipe.ts";

export const CUSTOM_PRESETS_KEY = "opendsp-4x4.setup-presets";
export const DRAFT_KEY = "opendsp-4x4.setup-draft";
export const SETUP_FILE_FORMAT = "opendsp-4x4/setup";
export const SETUP_FILE_VERSION = 1;
export const SETUP_FILE_EXTENSION = ".setup.json";
export const PRESET_NAME_MAX_LENGTH = 40;

export interface SetupPreset {
  id: string;
  name: string;
  recipe: Recipe;
  builtin: boolean;
}

export class SetupFileError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.length === 1 ? issues[0]! : `${issues.length} problems, first: ${issues[0]}`);
    this.name = "SetupFileError";
    this.issues = issues;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const SUBSONIC_HZ = 30;

function builtin(id: string, name: string, recipe: Recipe): SetupPreset {
  return { id: `builtin:${id}`, name, recipe, builtin: true };
}

function withSubsonic(recipe: Recipe): Recipe {
  return { ...recipe, subsonic: { enabled: true, freqHz: SUBSONIC_HZ } };
}

const named = (layout: LayoutId, environment: Parameters<typeof withEnvironment>[1]) => withEnvironment(defaultRecipe(layout), environment);

export const BUILTIN_PRESETS: readonly SetupPreset[] = [
  ...LAYOUT_IDS.map((layout) => builtin(layout, LAYOUTS[layout].name, defaultRecipe(layout))),
  builtin("2.1-outdoor", "2.1 Outdoor", withSubsonic(named("2.1", "outdoor"))),
  builtin("2.1-indoor", "2.1 Indoor", named("2.1", "indoor")),
  builtin("tks-outdoor", "Top/Kick/Sub Outdoor", withSubsonic(named("top-kick-sub", "outdoor"))),
  builtin("tks-club", "Top/Kick/Sub Club", withSubsonic(named("top-kick-sub", "club"))),
  builtin("2.0-speech", "2.0 Speech", named("2.0", "speech")),
];

function readJson(storage: StorageLike | null, key: string): unknown {
  if (!storage) return undefined;
  try {
    const text = storage.getItem(key);
    return text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function writeJson(storage: StorageLike | null, key: string, value: unknown): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Custom presets of this browser; entries that are not valid any more are left out. */
export function loadCustomPresets(storage: StorageLike | null): SetupPreset[] {
  const data = readJson(storage, CUSTOM_PRESETS_KEY);
  if (!Array.isArray(data)) return [];
  const presets: SetupPreset[] = [];
  for (const entry of data) {
    if (!isObject(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") continue;
    const name = entry.name.trim().slice(0, PRESET_NAME_MAX_LENGTH);
    if (!name || presets.some((preset) => preset.id === entry.id) || checkRecipe(entry.recipe).length > 0) continue;
    const recipe = coerceRecipe(entry.recipe);
    if (recipe) presets.push({ id: entry.id, name, recipe, builtin: false });
  }
  return presets;
}

export function saveCustomPresets(storage: StorageLike | null, presets: readonly SetupPreset[]): boolean {
  return writeJson(storage, CUSTOM_PRESETS_KEY, presets.map(({ id, name, recipe }) => ({ id, name, recipe })));
}

/** First free "custom:N" id. */
export function newPresetId(existing: readonly SetupPreset[]): string {
  const taken = new Set(existing.map((preset) => preset.id));
  let n = 1;
  while (taken.has(`custom:${n}`)) n++;
  return `custom:${n}`;
}

/** The stored form draft; null when there is none or it is not a recipe of this version. */
export function loadDraft(storage: StorageLike | null): Recipe | null {
  return coerceRecipe(readJson(storage, DRAFT_KEY));
}

export function saveDraft(storage: StorageLike | null, recipe: Recipe): boolean {
  return writeJson(storage, DRAFT_KEY, recipe);
}

export function serializeSetupFile(name: string, recipe: Recipe): string {
  const file = { format: SETUP_FILE_FORMAT, version: SETUP_FILE_VERSION, name, recipe };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** "Club-night.setup.json" */
export function setupFileName(name: string): string {
  const base = name.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "setup";
  return `${base}${SETUP_FILE_EXTENSION}`;
}

/** A setup file's name and recipe; throws SetupFileError listing every problem. */
export function parseSetupFile(text: string): { name: string; recipe: Recipe } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SetupFileError(["The file is not valid JSON"]);
  }
  if (!isObject(data) || data.format !== SETUP_FILE_FORMAT) throw new SetupFileError(["This is not an openDSP-4x4 setup file"]);
  if (data.version !== SETUP_FILE_VERSION) {
    throw new SetupFileError([`Unsupported setup file version ${String(data.version)} (this app reads version ${SETUP_FILE_VERSION})`]);
  }
  const problems = checkRecipe(data.recipe);
  const recipe = problems.length === 0 ? coerceRecipe(data.recipe) : null;
  if (!recipe) throw new SetupFileError(problems.map((problem) => problem.message));
  const name = typeof data.name === "string" ? data.name.trim().slice(0, PRESET_NAME_MAX_LENGTH) : "";
  return { name: name || "Imported setup", recipe };
}

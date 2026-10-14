// The Setup tab's form: the recipe being edited (kept across reloads), the preset it
// started from, and this browser's custom presets.
import { sameValue } from "../state/model.ts";
import type { StorageLike } from "../state/settings.ts";
import {
  BUILTIN_PRESETS, PRESET_NAME_MAX_LENGTH, loadCustomPresets, loadDraft, newPresetId, parseSetupFile,
  saveCustomPresets, saveDraft, serializeSetupFile, setupFileName, type SetupPreset,
} from "./library.ts";
import { LAYOUTS, checkRecipe, defaultRecipe, type Recipe } from "./recipe.ts";

const SELECTED_KEY = "opendsp-4x4.setup-selected";
const DEFAULT_PRESET_ID = "builtin:2.1";

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const copy = (recipe: Recipe): Recipe => JSON.parse(JSON.stringify(recipe)) as Recipe;

class SetupDraft {
  private readonly storage = browserStorage();
  customs = $state<SetupPreset[]>([]);
  presetId = $state(DEFAULT_PRESET_ID);
  recipe = $state<Recipe>(defaultRecipe());

  constructor() {
    this.customs = loadCustomPresets(this.storage);
    const stored = this.storage?.getItem(SELECTED_KEY);
    if (stored && this.presetById(stored)) this.presetId = stored;
    this.recipe = loadDraft(this.storage) ?? copy(this.selected?.recipe ?? defaultRecipe());
  }

  get presets(): SetupPreset[] { return [...BUILTIN_PRESETS, ...this.customs]; }
  get selected(): SetupPreset | undefined { return this.presetById(this.presetId); }
  /** The form differs from the preset it started from. */
  get modified(): boolean { return !this.selected || !sameValue($state.snapshot(this.recipe), this.selected.recipe); }

  presetById(id: string): SetupPreset | undefined {
    return this.presets.find((preset) => preset.id === id);
  }

  /** Load a preset into the form (unsaved form changes are replaced). */
  choose(id: string): void {
    const preset = this.presetById(id);
    if (!preset) return;
    this.select(id);
    this.update(copy(preset.recipe));
  }

  update(recipe: Recipe): void {
    this.recipe = recipe;
    saveDraft(this.storage, $state.snapshot(this.recipe) as Recipe);
  }

  /** Change the form through a function that edits a copy. */
  edit(change: (recipe: Recipe) => void): void {
    const next = copy($state.snapshot(this.recipe) as Recipe);
    change(next);
    this.update(next);
  }

  revert(): void {
    if (this.selected) this.update(copy(this.selected.recipe));
  }

  /** Store the form as a custom preset; a custom preset with the same name is replaced. False when the form is invalid. */
  saveAs(name: string): boolean {
    const trimmed = name.trim().slice(0, PRESET_NAME_MAX_LENGTH);
    const recipe = copy($state.snapshot(this.recipe) as Recipe);
    if (!trimmed || checkRecipe(recipe).length > 0) return false;
    const existing = this.customs.find((preset) => preset.name.toLowerCase() === trimmed.toLowerCase());
    const id = existing?.id ?? newPresetId(this.customs);
    const preset: SetupPreset = { id, name: trimmed, recipe, builtin: false };
    this.setCustoms(existing ? this.customs.map((p) => (p.id === id ? preset : p)) : [...this.customs, preset]);
    this.select(id);
    return true;
  }

  /** Delete a custom preset; the form keeps its content. */
  remove(id: string): void {
    if (!this.customs.some((preset) => preset.id === id)) return;
    this.setCustoms(this.customs.filter((preset) => preset.id !== id));
    if (this.presetId === id) this.select(`builtin:${this.recipe.layout}`);
  }

  /** Add a setup file as a custom preset and load it. Throws SetupFileError. */
  importFile(text: string): void {
    const { name, recipe } = parseSetupFile(text);
    let unique = name;
    for (let n = 2; this.customs.some((preset) => preset.name === unique) || BUILTIN_PRESETS.some((p) => p.name === unique); n++) {
      unique = `${name} (${n})`;
    }
    const preset: SetupPreset = { id: newPresetId(this.customs), name: unique, recipe, builtin: false };
    this.setCustoms([...this.customs, preset]);
    this.choose(preset.id);
  }

  /** The form as a setup file, named after the selected preset (or the layout). */
  exportFile(): { name: string; text: string } {
    const name = this.selected && !this.modified ? this.selected.name : LAYOUTS[this.recipe.layout].name;
    return { name: setupFileName(name), text: serializeSetupFile(name, $state.snapshot(this.recipe) as Recipe) };
  }

  private select(id: string): void {
    this.presetId = id;
    try {
      this.storage?.setItem(SELECTED_KEY, id);
    } catch {
      // storage full or unavailable: the selection is only lost on reload
    }
  }

  private setCustoms(presets: SetupPreset[]): void {
    this.customs = presets;
    saveCustomPresets(this.storage, $state.snapshot(this.customs) as SetupPreset[]);
  }
}

export const setupDraft = new SetupDraft();

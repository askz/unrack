import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_PRESETS, CUSTOM_PRESETS_KEY, DRAFT_KEY, SetupFileError, loadCustomPresets, loadDraft, newPresetId,
  parseSetupFile, saveCustomPresets, saveDraft, serializeSetupFile, setupFileName, type SetupPreset,
} from "../src/setup/library.ts";
import { LAYOUT_IDS, checkRecipe, defaultRecipe, withEnvironment } from "../src/setup/recipe.ts";
import type { StorageLike } from "../src/state/settings.ts";

class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null { return this.items.get(key) ?? null; }
  setItem(key: string, value: string): void { this.items.set(key, value); }
}

function issuesOf(text: string): string[] {
  try {
    parseSetupFile(text);
  } catch (error) {
    assert.ok(error instanceof SetupFileError);
    return error.issues;
  }
  assert.fail("the file was accepted");
}

test("built-in presets: one per layout plus the named ones, all valid, unique ids", () => {
  const ids = BUILTIN_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const layout of LAYOUT_IDS) assert.ok(BUILTIN_PRESETS.some((p) => p.recipe.layout === layout && p.recipe.environment.id === "neutral"), layout);
  for (const name of ["2.1 Outdoor", "2.1 Indoor", "Top/Kick/Sub Outdoor", "Top/Kick/Sub Club", "2.0 Speech"]) {
    assert.ok(BUILTIN_PRESETS.some((p) => p.name === name), name);
  }
  for (const preset of BUILTIN_PRESETS) {
    assert.deepEqual(checkRecipe(preset.recipe), [], preset.name);
    assert.equal(preset.builtin, true);
  }
});

test("custom presets round trip through storage", () => {
  const storage = new MemoryStorage();
  const presets: SetupPreset[] = [
    { id: "custom:1", name: "Garden party", recipe: withEnvironment(defaultRecipe("2.1"), "outdoor"), builtin: false },
    { id: "custom:2", name: "Bar", recipe: defaultRecipe("2.2"), builtin: false },
  ];
  assert.equal(saveCustomPresets(storage, presets), true);
  assert.deepEqual(loadCustomPresets(storage), presets);
  assert.equal(newPresetId(presets), "custom:3");
  assert.equal(newPresetId([]), "custom:1");
});

test("unreadable custom presets: corrupt storage is empty, an invalid entry is dropped", () => {
  const storage = new MemoryStorage();
  assert.deepEqual(loadCustomPresets(null), []);
  storage.setItem(CUSTOM_PRESETS_KEY, "{not json");
  assert.deepEqual(loadCustomPresets(storage), []);
  const good = { id: "custom:1", name: "Good", recipe: defaultRecipe() };
  const badRecipe = { id: "custom:2", name: "Bad", recipe: { ...defaultRecipe(), crossoversHz: [5] } };
  const noName = { id: "custom:3", name: " ", recipe: defaultRecipe() };
  storage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify([good, badRecipe, noName, 42]));
  assert.deepEqual(loadCustomPresets(storage).map((p) => p.name), ["Good"]);
});

test("the form draft round trips; a foreign draft is null", () => {
  const storage = new MemoryStorage();
  assert.equal(loadDraft(storage), null);
  const draft = { ...defaultRecipe("biamp"), crossoversHz: [5] };
  assert.equal(saveDraft(storage, draft), true);
  assert.deepEqual(loadDraft(storage), draft, "an invalid value is kept so the form shows it");
  storage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, layout: "5.1" }));
  assert.equal(loadDraft(storage), null);
  storage.setItem(DRAFT_KEY, "][");
  assert.equal(loadDraft(storage), null);
});

test("setup files round trip and have a safe name", () => {
  const recipe = withEnvironment(defaultRecipe("top-kick-sub"), "club");
  const text = serializeSetupFile("Club night", recipe);
  assert.equal(JSON.parse(text).format, "opendsp-4x4/setup");
  assert.deepEqual(parseSetupFile(text), { name: "Club night", recipe });
  assert.equal(setupFileName("Club night / v2"), "Club-night-v2.setup.json");
  assert.equal(setupFileName("  "), "setup.setup.json");
});

test("setup file import is strict and lists the problems", () => {
  assert.deepEqual(issuesOf("nope"), ["The file is not valid JSON"]);
  assert.deepEqual(issuesOf(JSON.stringify({ format: "opendsp-4x4/preset", version: 1 })), ["This is not an openDSP-4x4 setup file"]);
  assert.deepEqual(issuesOf(JSON.stringify({ format: "opendsp-4x4/setup", version: 9, name: "x", recipe: defaultRecipe() })),
    ["Unsupported setup file version 9 (this app reads version 1)"]);
  const bad = { ...defaultRecipe(), crossoversHz: [5], environment: { id: "neutral", lowDb: 40, highDb: 0 } };
  assert.deepEqual(issuesOf(JSON.stringify({ format: "opendsp-4x4/setup", version: 1, name: "x", recipe: bad })), [
    "Crossover 1 must be between 20 Hz and 20 kHz",
    "Low shelf must be between -12 dB and 12 dB",
  ]);
});

test("a version 1 setup (file, stored preset, draft) loads in direct mode", () => {
  const v1 = { ...defaultRecipe("2.1"), version: 1, alignment: { enabled: true, tempC: 20, distancesM: [10, 10, 6.57, 0] } };
  const file = JSON.stringify({ format: "opendsp-4x4/setup", version: 1, name: "Old", recipe: v1 });
  assert.equal(parseSetupFile(file).recipe.alignment.mode, "direct");
  const storage = new MemoryStorage();
  storage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify([{ id: "custom:1", name: "Old", recipe: v1 }]));
  assert.equal(loadCustomPresets(storage)[0]?.recipe.alignment.mode, "direct");
  storage.setItem(DRAFT_KEY, JSON.stringify(v1));
  assert.deepEqual(loadDraft(storage)?.alignment.distancesM, [10, 10, 6.57, 0]);
});

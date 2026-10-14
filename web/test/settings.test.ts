import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHANNEL_PALETTE, SETTINGS_STORAGE_KEY, defaultSettings, loadSettings, parseSettings, saveSettings, type StorageLike,
} from "../src/state/settings.ts";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

test("default settings match the spec", () => {
  const settings = defaultSettings();
  assert.equal(settings.version, 1);
  assert.equal(settings.gainStepDb, 0.5);
  assert.equal(settings.freqStepDivisions, 30);
  assert.equal(settings.eqWidth, "q");
  assert.equal(settings.eqRangeDb, 18);
  assert.equal(settings.peakHoldMs, 1200);
  assert.equal(settings.theme, "dark");
  assert.equal(settings.density, "comfortable");
  assert.equal(settings.textSize, "normal");
  assert.equal(settings.distanceUnit, "m");
  assert.equal(settings.temperatureUnit, "C");
  assert.equal(settings.gainCeilingDb, null);
  assert.equal(settings.startView, "last");
  assert.deepEqual(settings.names, ["", "", "", "", "", "", "", ""]);
  assert.deepEqual(settings.colors, CHANNEL_PALETTE.slice(0, 8));
  assert.deepEqual(settings.hidden, []);
});

test("invalid fields fall back to their defaults one by one", () => {
  const settings = parseSettings({
    gainStepDb: 3,
    theme: "purple",
    peakHoldMs: 3000,
    names: ["Top L", 5, "  Sub  ", "a".repeat(40)],
    colors: ["#5ac2b4", "red"],
    hidden: [7, 7, 2, 9, -1, 1.5, "3"],
    gainCeilingDb: 50,
  });
  assert.equal(settings.gainStepDb, 3);
  assert.equal(settings.theme, "dark");
  assert.equal(settings.peakHoldMs, 3000);
  assert.deepEqual(settings.names.slice(0, 5), ["Top L", "", "Sub", "a".repeat(16), ""]);
  assert.equal(settings.colors[0], "#5ac2b4");
  assert.equal(settings.colors[1], CHANNEL_PALETTE[1]);
  assert.deepEqual(settings.hidden, [2, 7]);
  assert.equal(settings.gainCeilingDb, null, "outside the gain range");
});

test("anything that is not a settings object gives the defaults", () => {
  for (const raw of [undefined, null, 42, "x", [1]]) assert.deepEqual(parseSettings(raw), defaultSettings());
});

test("the gain ceiling is kept in 0.1 dB steps", () => {
  assert.equal(parseSettings({ gainCeilingDb: 3.04 }).gainCeilingDb, 3);
  assert.equal(parseSettings({ gainCeilingDb: -6 }).gainCeilingDb, -6);
  assert.equal(parseSettings({ gainCeilingDb: Number.NaN }).gainCeilingDb, null);
});

test("settings survive a save and load, and broken storage never throws", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadSettings(storage), defaultSettings());
  const changed = { ...defaultSettings(), gainStepDb: 1 as const };
  assert.equal(saveSettings(storage, changed), true);
  assert.equal(loadSettings(storage).gainStepDb, 1);

  storage.data.set(SETTINGS_STORAGE_KEY, "{not json");
  assert.deepEqual(loadSettings(storage), defaultSettings());
  assert.deepEqual(loadSettings(null), defaultSettings());
  assert.equal(saveSettings(null, changed), false);

  const broken: StorageLike = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("quota exceeded"); },
  };
  assert.deepEqual(loadSettings(broken), defaultSettings());
  assert.equal(saveSettings(broken, changed), false);
});

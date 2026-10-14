import { test } from "node:test";
import assert from "node:assert/strict";
import { TONE_FREQS } from "../src/protocol/commands.ts";
import { OUT_BASE, defaultModel } from "../src/state/model.ts";
import type { StorageLike } from "../src/state/settings.ts";
import { LAYOUTS, alignmentDelaysMs, defaultRecipe, rigOf, type LayoutId, type Recipe } from "../src/setup/recipe.ts";
import {
  TUNING_SESSION_KEY, clearTuningSnapshot, loadTuningSnapshot, nearestToneIndex, offsetAssignments, offsetLimits,
  restoreAfterTuning, saveTuningSnapshot, snapshotOf, startAssignments, tuningBlocker, tuningSteps,
  type TuningContext, type TuningSnapshot,
} from "../src/setup/tuning.ts";

class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null { return this.items.get(key) ?? null; }
  setItem(key: string, value: string): void { this.items.set(key, value); }
}

const stepsOf = (layout: LayoutId) => tuningSteps(LAYOUTS[layout].outputs, LAYOUTS[layout].crossoversHz)
  .map((step) => [step.lower, step.uppers, step.crossoverHz]);

function snapshot(): TuningSnapshot {
  return { mutes: [null, true, false, false], polarities: [false, false, true, false], delaysMs: [1, 1, 0, 0] };
}

function directRecipe(distancesM: Recipe["alignment"]["distancesM"] = [0, 0, 0, 0]): Recipe {
  const recipe = defaultRecipe("2.1");
  recipe.alignment = { ...recipe.alignment, enabled: true, tempC: 20, mode: "direct", distancesM };
  return recipe;
}

test("tuning steps go from the highest crossover down, against the same side when there is one", () => {
  assert.deepEqual(stepsOf("2.1"), [[2, [0, 1], 100]]);
  assert.deepEqual(stepsOf("2.2"), [[2, [0], 100], [3, [1], 100]]);
  assert.deepEqual(stepsOf("top-kick-sub"), [[2, [0, 1], 180], [3, [2], 90]]);
  assert.deepEqual(stepsOf("biamp"), [[0, [1], 1600], [2, [3], 1600]]);
  assert.deepEqual(stepsOf("4way"), [[2, [3], 1600], [1, [2], 250], [0, [1], 90]]);
  assert.deepEqual(stepsOf("2.0"), []);
});

test("the tone is the device sine nearest the crossover, and the offset stays within half a period", () => {
  assert.equal(TONE_FREQS[nearestToneIndex(100)], 100);
  assert.equal(TONE_FREQS[nearestToneIndex(90)], 100);
  assert.equal(TONE_FREQS[nearestToneIndex(180)], 200);
  assert.equal(TONE_FREQS[nearestToneIndex(1600)], 1600);
  assert.deepEqual(offsetLimits(0, 100), { min: -5, max: 5 });
  assert.deepEqual(offsetLimits(18, 100), { min: 13, max: 20 }, "clamped to the offset range");
});

test("snapshot of the device outputs", () => {
  const model = defaultModel();
  model.channels[OUT_BASE + 1]!.mute = null;
  model.channels[OUT_BASE + 2]!.polarity = true;
  model.channels[OUT_BASE + 2]!.delayMs = 4;
  assert.deepEqual(snapshotOf(model), { mutes: [false, null, false, false], polarities: [false, false, true, false], delaysMs: [0, 0, 4, 0] });
});

test("starting mutes all but the pair and flips the lower output's polarity", () => {
  assert.deepEqual(startAssignments(snapshot(), 2, 0), [
    { ref: { kind: "mute", ch: OUT_BASE }, value: false },
    { ref: { kind: "mute", ch: OUT_BASE + 1 }, value: true },
    { ref: { kind: "mute", ch: OUT_BASE + 2 }, value: false },
    { ref: { kind: "mute", ch: OUT_BASE + 3 }, value: true },
    { ref: { kind: "polarity", ch: OUT_BASE + 2 }, value: false },
  ]);
});

test("an offset change re-sends the delays of the used outputs", () => {
  const assignments = offsetAssignments(rigOf(directRecipe([10, 10, 6.57, 0])), 2, -12);
  assert.deepEqual(assignments.map((a) => a.ref.ch), [OUT_BASE, OUT_BASE + 1, OUT_BASE + 2]);
  const value = (ch: number) => assignments.find((a) => a.ref.ch === ch)!.value as number;
  assert.ok(Math.abs(value(OUT_BASE) - 2) < 0.02, "a negative sub offset delays the tops");
  assert.equal(value(OUT_BASE + 2), 0);
});

test("ending restores mutes (unknown ones unmuted) and polarity, and the delays unless kept", () => {
  const kept = restoreAfterTuning(snapshot(), true);
  assert.equal(kept.some((a) => a.ref.kind === "delay"), false);
  assert.deepEqual(kept.filter((a) => a.ref.kind === "mute").map((a) => a.value), [false, true, false, false]);
  assert.deepEqual(kept.filter((a) => a.ref.kind === "polarity").map((a) => a.value), [false, false, true, false]);
  assert.deepEqual(restoreAfterTuning(snapshot(), false).filter((a) => a.ref.kind === "delay").map((a) => a.value), [1, 1, 0, 0]);
});

test("fine tuning needs a connected device with the setup applied", () => {
  const model = defaultModel();
  const recipe = directRecipe();
  const blocker = (patch: Partial<TuningContext> = {}) =>
    tuningBlocker({ connected: true, busy: false, valid: true, rig: rigOf(recipe), model, ...patch });
  assert.equal(blocker(), null, "all distances 0: every delay is 0, as on the device");
  assert.equal(blocker({ connected: false }), "Connect the device first");
  assert.equal(blocker({ busy: true }), "Wait for the device to finish");
  assert.equal(blocker({ rig: rigOf({ ...recipe, alignment: { ...recipe.alignment, enabled: false } }) }), "Switch time alignment on first");
  assert.equal(blocker({ rig: rigOf({ ...defaultRecipe("2.0"), alignment: recipe.alignment }) }), "This layout has no crossover to tune");
  assert.equal(blocker({ valid: false }), "Fix the problems in the setup first");
  const measured = directRecipe([10, 10, 6.57, 0]);
  assert.match(blocker({ rig: rigOf(measured) }) ?? "", /^Apply the setup first/);
  model.channels[OUT_BASE + 2]!.delayMs = alignmentDelaysMs(measured)[2]!;
  assert.equal(blocker({ rig: rigOf(measured) }), null);
});

test("the session snapshot survives a reload until it is cleared", () => {
  const storage = new MemoryStorage();
  assert.equal(loadTuningSnapshot(storage), null);
  saveTuningSnapshot(storage, snapshot());
  assert.deepEqual(loadTuningSnapshot(storage), snapshot());
  clearTuningSnapshot(storage);
  assert.equal(loadTuningSnapshot(storage), null);
  storage.setItem(TUNING_SESSION_KEY, JSON.stringify({ mutes: [1], polarities: [], delaysMs: [] }));
  assert.equal(loadTuningSnapshot(storage), null);
  storage.setItem(TUNING_SESSION_KEY, "{broken");
  assert.equal(loadTuningSnapshot(storage), null);
  assert.equal(loadTuningSnapshot(null), null);
});

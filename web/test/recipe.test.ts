import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LAYOUTS, LAYOUT_IDS, alignmentDelaysMs, checkRecipe, coerceRecipe, defaultRecipe, layoutRoles, spareOutputs,
  speedOfSound, usedOutputs, withEnvironment, withLayout, type Recipe,
} from "../src/setup/recipe.ts";

const fieldsOf = (recipe: unknown) => checkRecipe(recipe).map((problem) => problem.field);

function recipeWith(patch: (recipe: Recipe) => void, layout: Recipe["layout"] = "2.1"): Recipe {
  const recipe = defaultRecipe(layout);
  patch(recipe);
  return recipe;
}

test("every layout has four outputs whose bands cover every crossover", () => {
  for (const id of LAYOUT_IDS) {
    const layout = LAYOUTS[id];
    assert.equal(layout.outputs.length, 4, id);
    const bands = new Set(usedOutputs(layout).map((output) => output.slot.band));
    assert.deepEqual([...bands].sort(), Array.from({ length: layout.crossoversHz.length + 1 }, (_, i) => i), id);
  }
  assert.deepEqual(spareOutputs(LAYOUTS["2.1"]), [7]);
  assert.deepEqual(spareOutputs(LAYOUTS["top-kick-sub-mono"]), [7]);
  assert.deepEqual(layoutRoles(LAYOUTS["top-kick-sub"]), ["top", "kick", "sub"]);
});

test("changing the layout resets the crossovers and keeps the rest", () => {
  const recipe = recipeWith((r) => {
    r.trimsDb.sub = -3;
    r.environment = { id: "outdoor", lowDb: 3, highDb: 2 };
  });
  const next = withLayout(recipe, "4way");
  assert.deepEqual(next.crossoversHz, [90, 250, 1600]);
  assert.equal(next.layout, "4way");
  assert.equal(next.trimsDb.sub, -3);
  assert.deepEqual(next.environment, recipe.environment);
  assert.deepEqual(recipe.crossoversHz, [100], "the original recipe is untouched");
});

test("picking an environment fills its shelf gains", () => {
  assert.deepEqual(withEnvironment(defaultRecipe(), "outdoor").environment, { id: "outdoor", lowDb: 3, highDb: 2 });
  assert.deepEqual(withEnvironment(defaultRecipe(), "speech").environment, { id: "speech", lowDb: -6, highDb: 2 });
});

test("time alignment delays the nearer speakers relative to the farthest one", () => {
  assert.ok(Math.abs(speedOfSound(20) - 343.42) < 1e-9);
  const recipe = recipeWith((r) => {
    r.alignment = { enabled: true, tempC: 20, distancesM: [10, 10, 6.57, 99] };
  });
  const delays = alignmentDelaysMs(recipe);
  assert.equal(delays[0], 0);
  assert.equal(delays[1], 0);
  assert.ok(Math.abs(delays[2]! - 10) < 0.02, `got ${delays[2]}`);
  assert.equal(delays[3], null, "spare outputs have no delay, and their distance is ignored");
});

test("the default recipe of every layout is valid", () => {
  for (const id of LAYOUT_IDS) assert.deepEqual(checkRecipe(defaultRecipe(id)), [], id);
});

test("structure problems: version, layout, source, slope, environment", () => {
  assert.deepEqual(fieldsOf(null), ["recipe"]);
  assert.deepEqual(fieldsOf({ ...defaultRecipe(), version: 2 }), ["version"]);
  assert.deepEqual(fieldsOf({ ...defaultRecipe(), layout: "5.1" }), ["layout"]);
  assert.deepEqual(fieldsOf({ ...defaultRecipe(), source: "left" }), ["source"]);
  assert.deepEqual(fieldsOf({ ...defaultRecipe(), slope: "BW24" }), ["slope"]);
  assert.deepEqual(fieldsOf(recipeWith((r) => { (r.environment as { id: string }).id = "beach"; })), ["environment.id"]);
});

test("crossovers: count, range and spacing", () => {
  assert.deepEqual(fieldsOf(recipeWith((r) => { r.crossoversHz = [90, 180]; })), ["crossoversHz"]);
  assert.deepEqual(fieldsOf(recipeWith((r) => { r.crossoversHz = [10]; })), ["crossoversHz.0"]);
  assert.deepEqual(fieldsOf(recipeWith((r) => { r.crossoversHz = [90, 100]; }, "top-kick-sub")), ["crossoversHz.1"]);
  assert.deepEqual(fieldsOf(recipeWith((r) => { r.crossoversHz = [90, 114]; }, "top-kick-sub")), [], "a third of an octave is enough");
});

test("subsonic, alignment and protection ranges count only while switched on", () => {
  const off = recipeWith((r) => {
    r.subsonic.freqHz = 200;
    r.alignment.tempC = 99;
    r.protection.thresholdDb.top = 50;
  });
  assert.deepEqual(fieldsOf(off), []);
  const on = recipeWith((r) => {
    Object.assign(r, off);
    r.subsonic.enabled = true;
    r.alignment.enabled = true;
    r.protection.enabled = true;
  });
  assert.deepEqual(fieldsOf(on), ["subsonic.freqHz", "alignment.tempC", "protection.thresholdDb.top"]);
});

test("trims, shelves, distances and the 680 ms delay limit", () => {
  assert.deepEqual(fieldsOf(recipeWith((r) => { r.trimsDb.sub = 20; })), ["trimsDb.sub"]);
  assert.deepEqual(fieldsOf(recipeWith((r) => { r.environment.lowDb = 13; })), ["environment.lowDb"]);
  assert.deepEqual(fieldsOf(recipeWith((r) => { r.environment.highDb = -12.5; })), ["environment.highDb"]);
  assert.deepEqual(fieldsOf(recipeWith((r) => { r.alignment = { enabled: true, tempC: 20, distancesM: [0, 0, 300, 0] }; })),
    ["alignment.distancesM.2"]);
  assert.deepEqual(fieldsOf(recipeWith((r) => { r.alignment = { enabled: true, tempC: 20, distancesM: [250, 0, 1, 0] }; })),
    ["alignment.delay"], "250 m of difference is about 728 ms");
});

test("inverting a role the layout does not have is not an error", () => {
  assert.deepEqual(fieldsOf(recipeWith((r) => { r.invert = ["kick", "sub"]; })), []);
  assert.deepEqual(fieldsOf(recipeWith((r) => { (r as { invert: unknown }).invert = "sub"; })), ["invert"]);
});

test("a wrong type is a problem, not a crash", () => {
  assert.deepEqual(fieldsOf(recipeWith((r) => { (r.trimsDb as Record<string, unknown>).sub = "loud"; })), ["trimsDb.sub"]);
  assert.deepEqual(fieldsOf(recipeWith((r) => { (r as { alignment: unknown }).alignment = 3; })), ["alignment"]);
});

test("coerceRecipe keeps values, repairs shapes and rejects foreign data", () => {
  assert.equal(coerceRecipe("nope"), null);
  assert.equal(coerceRecipe({ ...defaultRecipe(), version: 2 }), null);
  assert.equal(coerceRecipe({ ...defaultRecipe(), layout: "5.1" }), null);
  const repaired = coerceRecipe({ ...defaultRecipe("2.2"), alignment: 3, trimsDb: { sub: 30, top: "x" } });
  assert.ok(repaired);
  assert.deepEqual(repaired.alignment, defaultRecipe().alignment);
  assert.deepEqual(repaired.trimsDb, { sub: 30 }, "out of range is kept (shown as a problem), wrong type dropped");
  assert.equal(repaired.layout, "2.2");
});

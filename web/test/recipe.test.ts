import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LAYOUTS, LAYOUT_IDS, alignmentDelaysMs, checkRecipe, coerceRecipe, defaultRecipe, layoutRoles, spareOutputs,
  upgradeRecipe, usedOutputs, withEnvironment, withLayout, type Recipe,
} from "../src/setup/recipe.ts";
import { speedOfSound } from "../src/setup/alignment.ts";

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
    r.alignment = { ...r.alignment, enabled: true, tempC: 20, mode: "direct", distancesM: [10, 10, 6.57, 99] };
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
  assert.deepEqual(fieldsOf({ ...defaultRecipe(), version: 3 }), ["version"]);
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
  const direct = (distancesM: Recipe["alignment"]["distancesM"], offsetsMs: Recipe["alignment"]["offsetsMs"] = [0, 0, 0, 0]) =>
    fieldsOf(recipeWith((r) => { r.alignment = { ...r.alignment, enabled: true, tempC: 20, mode: "direct", distancesM, offsetsMs }; }));
  assert.deepEqual(direct([0, 0, 300, 0]), ["alignment.distancesM.2"]);
  assert.deepEqual(direct([250, 0, 1, 0]), ["alignment.delay"], "250 m of difference is about 728 ms");
  assert.deepEqual(direct([230, 230, 0, 0]), [], "about 670 ms");
  assert.deepEqual(direct([230, 230, 0, 0], [0, 0, 15, 0]), ["alignment.delay"], "the offset counts");
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
  assert.equal(coerceRecipe({ ...defaultRecipe(), version: 3 }), null);
  assert.equal(coerceRecipe({ ...defaultRecipe(), layout: "5.1" }), null);
  const repaired = coerceRecipe({ ...defaultRecipe("2.2"), alignment: 3, trimsDb: { sub: 30, top: "x" } });
  assert.ok(repaired);
  assert.deepEqual(repaired.alignment, defaultRecipe("2.2").alignment);
  assert.deepEqual(repaired.trimsDb, { sub: 30 }, "out of range is kept (shown as a problem), wrong type dropped");
  assert.equal(repaired.layout, "2.2");
});

test("new recipes use positions with default heights by speaker kind; a layout change resets positions", () => {
  const alignment = defaultRecipe("top-kick-sub").alignment;
  assert.equal(alignment.mode, "positions");
  assert.deepEqual(alignment.speakers.map((s) => s.heightM), [2, 2, 0.6, 0.4]);
  assert.deepEqual(alignment.speakers.map((s) => s.xM), [0, 0, 0, 0]);
  assert.deepEqual(alignment.crowd, { startM: 2, endM: 20, earHeightM: 1.7 });
  assert.equal(alignment.pointM, null);
  assert.deepEqual(alignment.offsetsMs, [0, 0, 0, 0]);
  const moved = withLayout(recipeWith((r) => {
    r.alignment.offsetsMs = [1, 1, 1, 1];
    r.alignment.crowd.endM = 30;
  }), "4way");
  assert.deepEqual(moved.alignment.speakers.map((s) => s.heightM), [0.4, 1.5, 1.5, 1.5]);
  assert.deepEqual(moved.alignment.offsetsMs, [0, 0, 0, 0]);
  assert.equal(moved.alignment.crowd.endM, 30);
});

test("positions validation: speakers, crowd depth, point inside the crowd, offsets", () => {
  const on = (patch: (alignment: Recipe["alignment"]) => void) => fieldsOf(recipeWith((r) => {
    r.alignment.enabled = true;
    patch(r.alignment);
  }));
  assert.deepEqual(on(() => {}), []);
  assert.deepEqual(on((a) => { a.speakers[2].heightM = 31; }), ["alignment.speakers.2.heightM"]);
  assert.deepEqual(on((a) => { a.speakers[0].xM = -60; }), ["alignment.speakers.0.xM"]);
  assert.deepEqual(on((a) => { a.speakers[3].heightM = 99; }), [], "a spare output is ignored");
  assert.deepEqual(on((a) => { a.crowd.endM = 2.5; }), ["alignment.crowd.endM"]);
  assert.deepEqual(on((a) => { a.crowd.earHeightM = 3; }), ["alignment.crowd.earHeightM"]);
  assert.deepEqual(on((a) => { a.pointM = 25; }), ["alignment.pointM"]);
  assert.deepEqual(on((a) => { a.pointM = 8; }), []);
  assert.deepEqual(on((a) => { a.offsetsMs[2] = 21; }), ["alignment.offsetsMs.2"]);
  assert.deepEqual(on((a) => { a.mode = "direct"; a.speakers[2].heightM = 31; }), [], "positions are not checked in direct mode");
  assert.deepEqual(fieldsOf(recipeWith((r) => { (r.alignment as { mode: string }).mode = "laser"; })), ["alignment"]);
  assert.deepEqual(fieldsOf(recipeWith((r) => { (r.alignment.speakers[1] as { xM: unknown }).xM = "far"; })), ["alignment.speakers.1.xM"]);
});

test("a version 1 recipe upgrades to direct mode with the same delays", () => {
  const v1 = { ...defaultRecipe("2.1"), version: 1, alignment: { enabled: true, tempC: 20, distancesM: [10, 10, 6.57, 0] } };
  const upgraded = upgradeRecipe(v1);
  assert.deepEqual(checkRecipe(upgraded), []);
  const recipe = coerceRecipe(upgraded)!;
  assert.equal(recipe.version, 2);
  assert.equal(recipe.alignment.mode, "direct");
  assert.deepEqual(recipe.alignment.distancesM, [10, 10, 6.57, 0]);
  assert.deepEqual(recipe.alignment.offsetsMs, [0, 0, 0, 0]);
  assert.deepEqual(recipe.alignment.speakers, defaultRecipe("2.1").alignment.speakers);
  assert.ok(Math.abs(alignmentDelaysMs(recipe)[2]! - 10) < 0.02);
  assert.equal(upgradeRecipe("x"), "x");
  assert.deepEqual(upgradeRecipe(defaultRecipe()), defaultRecipe(), "version 2 is unchanged");
});

test("coerceRecipe repairs each alignment field on its own", () => {
  const raw = { ...defaultRecipe(), alignment: { ...defaultRecipe().alignment, speakers: "x", pointM: "far", mode: "laser", offsetsMs: [1, "a", 2, 3] } };
  const alignment = coerceRecipe(raw)!.alignment;
  assert.deepEqual(alignment.speakers, defaultRecipe().alignment.speakers);
  assert.equal(alignment.pointM, null);
  assert.equal(alignment.mode, "positions");
  assert.deepEqual(alignment.offsetsMs, [1, 0, 2, 3]);
});

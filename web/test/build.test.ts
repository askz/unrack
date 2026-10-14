import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSetup } from "../src/setup/build.ts";
import { LAYOUT_IDS, defaultRecipe, type LayoutId, type Recipe } from "../src/setup/recipe.ts";
import { DEFAULT_BAND_FREQS, defaultBand, defaultEq } from "../src/state/model.ts";
import { PeqType, Ratio, Slope } from "../src/protocol/commands.ts";
import type { ParamAssignment, ParamKind } from "../src/state/params.ts";
import type { Crossover, PeqBand } from "../src/eq/types.ts";
import type { Compressor } from "../src/state/model.ts";

const OFF_HPF = defaultEq().hpf;
const OFF_LPF = defaultEq().lpf;
const LIMIT = Ratio.indexOf("Limit");

function recipe(layout: LayoutId, patch: (r: Recipe) => void = () => {}): Recipe {
  const r = defaultRecipe(layout);
  patch(r);
  return r;
}

function valueOf(assignments: ParamAssignment[], kind: ParamKind, ch: number, band?: number): unknown {
  return assignments.find((a) => a.ref.kind === kind && a.ref.ch === ch && a.ref.band === band)?.value;
}

const routing = (assignments: ParamAssignment[]) => [4, 5, 6, 7].map((ch) => valueOf(assignments, "routing", ch));
const crossover = (assignments: ParamAssignment[], kind: "hpf" | "lpf", ch: number) => valueOf(assignments, kind, ch) as Crossover | undefined;

test("routing per layout: L = A, R = B, mono = A+B, spare = none", () => {
  const expected: Record<LayoutId, unknown[]> = {
    "2.0": [1, 2, 1, 2],
    "2.1": [1, 2, 3, 0],
    "2.2": [1, 2, 1, 2],
    "top-kick-sub": [1, 2, 3, 3],
    "top-kick-sub-mono": [3, 3, 3, 0],
    biamp: [1, 1, 2, 2],
    "4way": [3, 3, 3, 3],
  };
  for (const id of LAYOUT_IDS) assert.deepEqual(routing(buildSetup(defaultRecipe(id)).assignments), expected[id], id);
});

test("a mono source routes every used output from A only", () => {
  assert.deepEqual(routing(buildSetup(recipe("2.1", (r) => { r.source = "mono"; })).assignments), [1, 1, 1, 0]);
});

test("crossovers: each band gets the split below as high-pass and the split above as low-pass", () => {
  const { assignments } = buildSetup(defaultRecipe("4way"));
  const lr24 = (freqHz: number) => ({ freqHz, slope: Slope.LK24 });
  assert.deepEqual([4, 5, 6, 7].map((ch) => crossover(assignments, "hpf", ch)), [OFF_HPF, lr24(90), lr24(250), lr24(1600)]);
  assert.deepEqual([4, 5, 6, 7].map((ch) => crossover(assignments, "lpf", ch)), [lr24(90), lr24(250), lr24(1600), OFF_LPF]);

  const twoWay = buildSetup(recipe("2.1", (r) => { r.slope = "LR12"; r.crossoversHz = [120]; })).assignments;
  assert.deepEqual(crossover(twoWay, "hpf", 4), { freqHz: 120, slope: Slope.LK12 }, "top");
  assert.deepEqual(crossover(twoWay, "lpf", 4), OFF_LPF);
  assert.deepEqual(crossover(twoWay, "lpf", 6), { freqHz: 120, slope: Slope.LK12 }, "sub");
  assert.deepEqual(crossover(twoWay, "hpf", 6), OFF_HPF);

  const fullRange = buildSetup(defaultRecipe("2.0")).assignments;
  assert.deepEqual([4, 5, 6, 7].map((ch) => [crossover(fullRange, "hpf", ch), crossover(fullRange, "lpf", ch)]),
    Array(4).fill([OFF_HPF, OFF_LPF]));
});

test("the subsonic filter goes on the lowest band only", () => {
  const { assignments } = buildSetup(recipe("top-kick-sub", (r) => { r.subsonic = { enabled: true, freqHz: 32 }; }));
  assert.deepEqual(crossover(assignments, "hpf", 7), { freqHz: 32, slope: Slope.BW24 }, "sub");
  assert.deepEqual(crossover(assignments, "hpf", 6), { freqHz: 90, slope: Slope.LK24 }, "kick keeps its crossover");
});

test("spare outputs only get their routing switched off", () => {
  const { assignments, spare, names } = buildSetup(defaultRecipe("2.1"));
  assert.deepEqual(assignments.filter((a) => a.ref.ch === 7).map((a) => [a.ref.kind, a.value]), [["routing", 0]]);
  assert.deepEqual(spare, [7]);
  assert.deepEqual(names, { 4: "Top L", 5: "Top R", 6: "Sub", 7: "Spare" });
});

test("a setup never touches inputs, mute or PEQ bands 2 to 6", () => {
  for (const id of LAYOUT_IDS) {
    const everything = recipe(id, (r) => {
      r.subsonic.enabled = true;
      r.alignment.enabled = true;
      r.protection.enabled = true;
    });
    for (const { ref } of buildSetup(everything).assignments) {
      assert.ok(ref.ch >= 4, `${id}: input ${ref.ch}`);
      assert.notEqual(ref.kind, "mute", id);
      if (ref.kind === "peq") assert.ok(ref.band === 0 || ref.band === 6, `${id}: band ${ref.band}`);
    }
  }
});

test("environment shelves: low shelf on the lowest band, high shelf on the top band, flat elsewhere", () => {
  const r = recipe("2.1", (r) => { r.environment = { id: "outdoor", lowDb: 3, highDb: 2 }; });
  const { assignments } = buildSetup(r);
  const band = (ch: number, index: number) => valueOf(assignments, "peq", ch, index) as PeqBand;
  assert.equal(band(6, 0).type, PeqType.LOW_SHELF);
  assert.equal(band(6, 0).freqHz, 60);
  assert.equal(band(6, 0).gainDb, 3);
  assert.equal(band(6, 0).bypass, false);
  assert.deepEqual(band(6, 6), defaultBand(DEFAULT_BAND_FREQS[6]!), "the sub has no high shelf");
  assert.equal(band(4, 6).type, PeqType.HIGH_SHELF);
  assert.equal(band(4, 6).freqHz, 8000);
  assert.equal(band(4, 6).gainDb, 2);
  assert.deepEqual(band(4, 0), defaultBand(DEFAULT_BAND_FREQS[0]!), "the tops have no low shelf");

  const fullRange = buildSetup(recipe("2.0", (r) => { r.environment = { id: "club", lowDb: 4, highDb: 1.5 }; })).assignments;
  assert.equal((valueOf(fullRange, "peq", 4, 0) as PeqBand).type, PeqType.LOW_SHELF, "full range outputs get both");
  assert.equal((valueOf(fullRange, "peq", 4, 6) as PeqBand).type, PeqType.HIGH_SHELF);
});

test("trims and polarity by role, trims clamped to the gain ceiling", () => {
  const r = recipe("top-kick-sub", (r) => {
    r.trimsDb = { sub: -6, top: 4 };
    r.invert = ["kick", "high"];
  });
  const { assignments } = buildSetup(r);
  assert.deepEqual([4, 5, 6, 7].map((ch) => valueOf(assignments, "gain", ch)), [4, 4, 0, -6]);
  assert.deepEqual([4, 5, 6, 7].map((ch) => valueOf(assignments, "polarity", ch)), [false, false, true, false]);
  const capped = buildSetup(r, { gainCeilingDb: 2 }).assignments;
  assert.deepEqual([4, 5, 6, 7].map((ch) => valueOf(capped, "gain", ch)), [2, 2, 0, -6]);
});

test("delay only with time alignment on", () => {
  assert.equal(buildSetup(defaultRecipe("2.1")).assignments.some((a) => a.ref.kind === "delay"), false);
  const { assignments } = buildSetup(recipe("2.1", (r) => {
    r.alignment = { ...r.alignment, enabled: true, tempC: 20, mode: "direct", distancesM: [10, 10, 6.5658, 0] };
  }));
  assert.equal(valueOf(assignments, "delay", 4), 0);
  assert.ok(Math.abs((valueOf(assignments, "delay", 6) as number) - 10) < 0.001);
  assert.equal(valueOf(assignments, "delay", 7), undefined, "spare");
});

test("limiter only with protection on, with times by role", () => {
  assert.equal(buildSetup(defaultRecipe("4way")).assignments.some((a) => a.ref.kind === "comp"), false);
  const { assignments } = buildSetup(recipe("4way", (r) => {
    r.protection = { enabled: true, thresholdDb: { sub: -4 } };
  }));
  const comp = (ch: number) => valueOf(assignments, "comp", ch) as Compressor;
  assert.deepEqual(comp(4), { thresholdDb: -4, ratioIndex: LIMIT, kneeDb: 0, attackMs: 20, releaseMs: 400 });
  assert.deepEqual(comp(5), { thresholdDb: 0, ratioIndex: LIMIT, kneeDb: 0, attackMs: 20, releaseMs: 400 }, "low");
  assert.deepEqual([comp(6).attackMs, comp(6).releaseMs], [10, 200], "mid");
  assert.deepEqual([comp(7).attackMs, comp(7).releaseMs], [2, 100], "high");
});

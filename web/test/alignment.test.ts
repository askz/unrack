import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADDS_MAX_DEG, COUPLED_MAX_DEG, bandPairs, couplingState, coverage, crowdSamplesM, effectivePointM, geometricDelaysMs,
  outputDelaysMs, pathLengthM, speedOfSound, suggestedPointM, type Alignment, type Rig,
} from "../src/setup/alignment.ts";
import { LAYOUTS, type LayoutId } from "../src/setup/recipe.ts";

/** Air temperature at which sound travels at 343 m/s. */
const TEMP_343 = (343 - 331.3) / 0.606;

function near(actual: number | null | undefined, expected: number, tolerance = 0.01): void {
  assert.ok(typeof actual === "number" && Math.abs(actual - expected) <= tolerance, `got ${actual}, expected ${expected}`);
}

function alignment(patch: Partial<Alignment> = {}): Alignment {
  return {
    enabled: true, tempC: TEMP_343, mode: "positions", distancesM: [0, 0, 0, 0],
    speakers: [{ xM: 0, heightM: 4 }, { xM: 0, heightM: 4 }, { xM: 0, heightM: 0.4 }, { xM: 0, heightM: 1.5 }],
    crowd: { startM: 2, endM: 20, earHeightM: 1.7 }, pointM: null, offsetsMs: [0, 0, 0, 0],
    ...patch,
  };
}

function rig(layout: LayoutId, patch: Partial<Alignment> = {}): Rig {
  return { outputs: LAYOUTS[layout].outputs, crossoversHz: LAYOUTS[layout].crossoversHz, alignment: alignment(patch) };
}

test("speed of sound and the straight path from a speaker to the ears", () => {
  near(speedOfSound(20), 343.42, 1e-9);
  near(pathLengthM({ xM: 0, heightM: 4 }, 2, 1.7), Math.hypot(2, 2.3), 1e-12);
  near(pathLengthM({ xM: -3, heightM: 1.7 }, 5, 1.7), 8, 1e-12);
});

test("a floor sub under flown tops needs more delay close to the stage than far away", () => {
  const delays = (pointM: number) => geometricDelaysMs(rig("2.1"), pointM);
  assert.deepEqual(delays(2).slice(0, 2), [0, 0], "the tops are farthest");
  near(delays(2)[2], 1.93);
  near(delays(5)[2], 0.98);
  near(delays(10)[2], 0.52);
  near(delays(20)[2], 0.26);
  assert.equal(delays(2)[3], null, "spare output");
});

test("tops on stands with seated ears midway: the heights cancel out", () => {
  const stand = rig("2.1", {
    speakers: [{ xM: 0, heightM: 2 }, { xM: 0, heightM: 2 }, { xM: 0, heightM: 0.4 }, { xM: 0, heightM: 1.5 }],
    crowd: { startM: 2, endM: 20, earHeightM: 1.2 },
  });
  for (const pointM of [2, 5, 10, 20]) near(geometricDelaysMs(stand, pointM)[2], 0, 1e-9);
});

test("offsets add to the geometric delays, and the smallest delay is always 0", () => {
  const base = geometricDelaysMs(rig("2.1"), 10);
  const plus = outputDelaysMs(rig("2.1", { pointM: 10, offsetsMs: [0, 0, 1.5, 0] }));
  near(plus[0], 0, 1e-9);
  near(plus[2], base[2]! + 1.5, 1e-9);
  const minus = outputDelaysMs(rig("2.1", { pointM: 10, offsetsMs: [0, 0, -3, 0] }));
  near(minus[2], 0, 1e-9);
  near(minus[0], 3 - base[2]!, 1e-9);
  near(minus[1], 3 - base[2]!, 1e-9);
  assert.equal(minus[3], null);
});

test("direct mode aligns measured distances on the farthest speaker", () => {
  const delays = outputDelaysMs(rig("2.1", { mode: "direct", tempC: 20, distancesM: [10, 10, 6.57, 99] }));
  assert.deepEqual(delays.slice(0, 2), [0, 0]);
  near(delays[2], 10, 0.02);
  assert.equal(delays[3], null, "a spare output's distance is ignored");
});

test("band pairs: each output with every output of the band above, at their crossover", () => {
  assert.deepEqual(bandPairs(rig("2.1")), [{ lower: 2, upper: 0, crossoverHz: 100 }, { lower: 2, upper: 1, crossoverHz: 100 }]);
  assert.deepEqual(bandPairs(rig("top-kick-sub")), [
    { lower: 3, upper: 2, crossoverHz: 90 },
    { lower: 2, upper: 0, crossoverHz: 180 },
    { lower: 2, upper: 1, crossoverHz: 180 },
  ]);
  assert.deepEqual(bandPairs(rig("2.0")), []);
});

test("coupling states at 90 and 120 degrees, and crowd sampling", () => {
  assert.equal(couplingState(ADDS_MAX_DEG), "adds");
  assert.equal(couplingState(-ADDS_MAX_DEG - 0.1), "weak");
  assert.equal(couplingState(COUPLED_MAX_DEG), "weak");
  assert.equal(couplingState(COUPLED_MAX_DEG + 0.1), "cancels");
  const samples = crowdSamplesM({ startM: 2, endM: 20, earHeightM: 1.7 });
  assert.equal(samples.length, 181);
  near(samples[1]! - samples[0]!, 0.1, 1e-9);
  near(samples[180], 20, 1e-9);
  assert.equal(crowdSamplesM({ startM: 0, endM: 250, earHeightM: 1.7 }).length, 501, "a deep crowd is capped");
  assert.deepEqual(crowdSamplesM({ startM: 5, endM: 4, earHeightM: 1.7 }), [5]);
});

test("a sub straight behind the tops at ear height is coupled everywhere; the tie goes to the middle", () => {
  const behind = rig("2.1", {
    speakers: [{ xM: 0, heightM: 1.7 }, { xM: 0, heightM: 1.7 }, { xM: -3, heightM: 1.7 }, { xM: 0, heightM: 1.5 }],
  });
  const result = coverage(behind, 10)!;
  assert.ok(result.samples.every((sample) => sample.state === "adds"));
  near(result.coupledM, 18, 1e-9);
  near(result.totalM, 18, 1e-9);
  near(suggestedPointM(behind), 11, 1e-9);
});

test("the suggested point keeps the most crowd coupled", () => {
  const tower = rig("2.1", {
    speakers: [{ xM: 0, heightM: 8 }, { xM: 0, heightM: 8 }, { xM: 0, heightM: 0.4 }, { xM: 0, heightM: 1.5 }],
    crowd: { startM: 1, endM: 40, earHeightM: 1.7 },
  });
  const atBack = coverage(tower, 40)!;
  assert.equal(atBack.samples[atBack.samples.length - 1]!.state, "adds");
  assert.equal(atBack.samples[0]!.state, "cancels", "aligned at the back, the front cancels");
  const best = suggestedPointM(tower)!;
  const bestCoupled = coverage(tower, best)!.coupledM;
  for (const pointM of crowdSamplesM(tower.alignment.crowd)) {
    assert.ok(coverage(tower, pointM)!.coupledM <= bestCoupled + 1e-9, `${pointM} m beats the suggestion`);
  }
  assert.ok(bestCoupled < atBack.totalM, "this rig cannot be coupled everywhere");
});

test("without a crossover there is no coverage; the point defaults to the middle and stays in the crowd", () => {
  assert.equal(coverage(rig("2.0"), 10), null);
  assert.equal(suggestedPointM(rig("2.0")), null);
  assert.equal(effectivePointM(rig("2.0")), 11);
  assert.equal(effectivePointM(rig("2.1", { pointM: 50 })), 20);
  assert.equal(effectivePointM(rig("2.1", { pointM: 7.5 })), 7.5);
});

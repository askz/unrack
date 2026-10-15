import { test } from "node:test";
import assert from "node:assert/strict";
import { INPUT_FLOOR_DB, OUTPUT_FLOOR_DB, TONE_DB, meterLevels, programDb, type DemoMix } from "../src/transport/demoLevels.ts";

function mix(overrides: Partial<DemoMix> = {}): DemoMix {
  return {
    gainsDb: new Array<number>(8).fill(0),
    mutes: new Array<boolean>(8).fill(false),
    routing: [1, 2, 4, 8],
    toneOn: false,
    ...overrides,
  };
}

test("the program on In A and In B stays between the floor and full scale, and moves", () => {
  let lowest = Infinity;
  let highest = -Infinity;
  let differs = false;
  for (let timeMs = 0; timeMs < 8000; timeMs += 50) {
    const [a, b] = programDb(timeMs);
    lowest = Math.min(lowest, a, b);
    highest = Math.max(highest, a, b);
    if (Math.abs(a - b) > 0.5) differs = true;
  }
  assert.ok(lowest > -40, `lowest ${lowest}`);
  assert.ok(highest < -3, `highest ${highest}`);
  assert.ok(highest - lowest > 10, "it moves like music, not a steady level");
  assert.ok(differs, "left and right are not identical");
});

test("In C and In D sit at the idle floor", () => {
  const levels = meterLevels(mix(), 1234);
  assert.equal(levels[2], INPUT_FLOOR_DB);
  assert.equal(levels[3], INPUT_FLOOR_DB);
});

test("an output routed from one input shows that input plus its gain", () => {
  const levels = meterLevels(mix({ gainsDb: [0, 0, 0, 0, -3, 0, 0, 0] }), 1234);
  assert.ok(Math.abs(levels[4]! - (levels[0]! - 3)) < 1e-9);
  assert.ok(Math.abs(levels[5]! - levels[1]!) < 1e-9);
});

test("the test tone puts every input at -12 dBFS", () => {
  const levels = meterLevels(mix({ toneOn: true }), 1234);
  assert.deepEqual(levels.slice(0, 4), [TONE_DB, TONE_DB, TONE_DB, TONE_DB]);
});

test("two routed inputs add up as power", () => {
  const levels = meterLevels(mix({ toneOn: true, routing: [3, 2, 4, 8] }), 0);
  assert.ok(Math.abs(levels[4]! - (TONE_DB + 10 * Math.log10(2))) < 1e-9);
});

test("input gain comes before the meters and the routing", () => {
  const levels = meterLevels(mix({ toneOn: true, gainsDb: [-6, 0, 0, 0, 3, 0, 0, 0] }), 0);
  assert.equal(levels[0], TONE_DB - 6);
  assert.equal(levels[4], TONE_DB - 6 + 3);
});

test("muting an input or an output drops it to the floor", () => {
  const inputMuted = meterLevels(mix({ toneOn: true, mutes: [true, false, false, false, false, false, false, false] }), 0);
  assert.equal(inputMuted[0], INPUT_FLOOR_DB);
  assert.equal(inputMuted[4], OUTPUT_FLOOR_DB, "Out 1 only takes In A");
  const outputMuted = meterLevels(mix({ toneOn: true, mutes: [false, false, false, false, false, true, false, false] }), 0);
  assert.equal(outputMuted[5], OUTPUT_FLOOR_DB);
  assert.equal(outputMuted[1], TONE_DB, "the input meter is before the output mute");
});

test("an output with no input routed sits at the floor", () => {
  const levels = meterLevels(mix({ toneOn: true, routing: [0, 2, 4, 8] }), 0);
  assert.equal(levels[4], OUTPUT_FLOOR_DB);
});

test("levels never go above full scale", () => {
  const levels = meterLevels(mix({ toneOn: true, routing: [15, 15, 15, 15], gainsDb: new Array<number>(8).fill(12) }), 0);
  assert.ok(levels.every((db) => db <= 0));
  assert.equal(levels[4], 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { dbToPosition, positionToDb, stepGainDb, FADER_TICKS_DB } from "../src/ui/faderTaper.ts";
import { GAIN_RANGE } from "../src/state/params.ts";

test("the fader follows the device's level scale", () => {
  assert.equal(dbToPosition(0), 0.7);
  assert.equal(dbToPosition(-20), 0.2);
  assert.equal(dbToPosition(GAIN_RANGE.min), 0);
  assert.equal(dbToPosition(GAIN_RANGE.max), 1);
  assert.equal(dbToPosition(99), 1);
  assert.equal(dbToPosition(-99), 0);
});

test("fader position and dB convert both ways", () => {
  for (let db = GAIN_RANGE.min; db <= GAIN_RANGE.max; db += 0.7) {
    assert.ok(Math.abs(positionToDb(dbToPosition(db)) - db) < 1e-9, `at ${db} dB`);
  }
  assert.equal(positionToDb(-1), GAIN_RANGE.min);
  assert.equal(positionToDb(2), GAIN_RANGE.max);
});

test("ticks cover the range from top to bottom", () => {
  assert.equal(FADER_TICKS_DB[0], GAIN_RANGE.max);
  assert.equal(FADER_TICKS_DB[FADER_TICKS_DB.length - 1], GAIN_RANGE.min);
});

test("gain steps always move at least one device step and never stick", () => {
  assert.equal(stepGainDb(0, 0.5), 0.5);
  assert.equal(stepGainDb(0, -0.05), -0.1, "smaller than the resolution still moves one device step");
  assert.equal(stepGainDb(-20, -0.1), -20.5, "below -20 dB the device steps are 0.5 dB");
  assert.equal(stepGainDb(-20.5, 0.1), -20);
  assert.equal(stepGainDb(GAIN_RANGE.max, 1), GAIN_RANGE.max);
  assert.equal(stepGainDb(GAIN_RANGE.min, -1), GAIN_RANGE.min);
  assert.equal(stepGainDb(3, 0), 3);
});

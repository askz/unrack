import { test } from "node:test";
import assert from "node:assert/strict";
import { muteAllAssignments, outputMutes, restoreAssignments, soloAssignments } from "../src/state/solo.ts";
import { trimmedGains } from "../src/state/trim.ts";
import { defaultModel, OUT_BASE } from "../src/state/model.ts";

test("mute all mutes every output and unmute all restores the snapshot", () => {
  const model = defaultModel();
  model.channels[OUT_BASE + 1]!.mute = true;
  model.channels[OUT_BASE + 2]!.mute = null;
  const snapshot = outputMutes(model);
  assert.deepEqual(snapshot, [false, true, null, false]);
  assert.deepEqual(muteAllAssignments().map((a) => [a.ref.kind, a.ref.ch, a.value]), [
    ["mute", 4, true], ["mute", 5, true], ["mute", 6, true], ["mute", 7, true],
  ]);
  assert.deepEqual(restoreAssignments(snapshot).map((a) => a.value), [false, true, false, false], "unknown becomes unmuted");
  assert.deepEqual(restoreAssignments(null).map((a) => a.value), [false, false, false, false]);
});

test("solo mutes every output that is not soloed", () => {
  assert.deepEqual(soloAssignments(new Set([OUT_BASE + 2])).map((a) => a.value), [true, true, false, true]);
  assert.deepEqual(soloAssignments(new Set([OUT_BASE, OUT_BASE + 3])).map((a) => a.value), [false, true, true, false]);
});

test("trim keeps the differences between outputs", () => {
  assert.deepEqual(trimmedGains([0, -3, -10, 6], -2), { gains: [-2, -5, -12, 4], clamped: false });
});

test("trim clamps at the ends of the range and at a ceiling, and says so", () => {
  assert.deepEqual(trimmedGains([10, 0, -3, -59], 4), { gains: [12, 4, 1, -55], clamped: true });
  assert.deepEqual(trimmedGains([0, -59], -3), { gains: [-3, -60], clamped: true });
  assert.deepEqual(trimmedGains([0, 2], 3, 3), { gains: [3, 3], clamped: true });
});

test("trim can take one limit per output", () => {
  assert.deepEqual(trimmedGains([0, 5], 2, [1, 5]), { gains: [1, 5], clamped: true });
  assert.deepEqual(trimmedGains([0, 5], -2, [1, 5]), { gains: [-2, 3], clamped: false });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeChanges, previewModel } from "../src/setup/review.ts";
import { defaultCalibration as cal } from "../src/eq/calibration.ts";
import { bwOctToQ, qToBwOct } from "../src/eq/biquad.ts";
import { defaultModel } from "../src/state/model.ts";
import { PeqType, Ratio, Slope } from "../src/protocol/commands.ts";
import type { ParamAssignment } from "../src/state/params.ts";

const xoverHz = (hz: number) => cal.xoverRawToHz(cal.xoverHzToRaw(hz));

test("one readable line per changed parameter", () => {
  const model = defaultModel();
  const assignments: ParamAssignment[] = [
    { ref: { kind: "routing", ch: 6 }, value: 3 },
    { ref: { kind: "gain", ch: 6 }, value: -6 },
    { ref: { kind: "hpf", ch: 6 }, value: { freqHz: 90, slope: Slope.LK24 } },
    { ref: { kind: "delay", ch: 5 }, value: 2.35 },
    { ref: { kind: "polarity", ch: 7 }, value: true },
    { ref: { kind: "comp", ch: 4 }, value: { thresholdDb: 0, ratioIndex: Ratio.indexOf("Limit"), kneeDb: 0, attackMs: 2, releaseMs: 100 } },
    { ref: { kind: "routing", ch: 7 }, value: 0 },
  ];
  assert.deepEqual(describeChanges(model, assignments, cal), [
    "Out 3 routing: C → A+B",
    "Out 3 gain: 0.0 dB → -6.0 dB",
    `Out 3 high-pass: Off → ${xoverHz(90).toFixed(1)} Hz, Linkwitz-Riley 24`,
    "Out 2 delay: 0.00 ms → 2.35 ms",
    "Out 4 polarity: normal → inverted",
    "Out 1 compressor: 1:1.0 at +20.0 dB, 50 / 500 ms → Limit at 0.0 dB, 2 / 100 ms",
    "Out 4 routing: D → none",
  ]);
});

test("PEQ bands show type, frequency, gain and Q", () => {
  const model = defaultModel();
  const shelf = { freqHz: 60, gainDb: 3, bwOct: qToBwOct(0.7, 60), type: PeqType.LOW_SHELF, bypass: false };
  const [line] = describeChanges(model, [{ ref: { kind: "peq", ch: 4, band: 0 }, value: shelf }], cal);
  const before = model.channels[4]!.eq!.bands[0]!;
  const after = previewModel(model, [{ ref: { kind: "peq", ch: 4, band: 0 }, value: shelf }], cal).channels[4]!.eq!.bands[0]!;
  const q = (band: typeof before) => bwOctToQ(band.bwOct, band.freqHz).toFixed(1);
  assert.equal(line, `Out 1 PEQ band 1: Peak ${before.freqHz.toFixed(1)} Hz 0.0 dB Q ${q(before)} → Low shelf ${after.freqHz.toFixed(1)} Hz +3.0 dB Q ${q(after)}`);
});

test("values equal to the model after device quantization are not changes", () => {
  const model = defaultModel();
  const sameAfterRounding: ParamAssignment[] = [
    { ref: { kind: "gain", ch: 4 }, value: 0.02 },
    { ref: { kind: "routing", ch: 4 }, value: 1 },
    { ref: { kind: "lpf", ch: 4 }, value: { ...model.channels[4]!.eq!.lpf } },
    { ref: { kind: "delay", ch: 4 }, value: 0.001 },
  ];
  assert.deepEqual(describeChanges(model, sameAfterRounding, cal), []);
});

test("channel names come from nameOf", () => {
  const lines = describeChanges(defaultModel(), [{ ref: { kind: "gain", ch: 6 }, value: -3 }], cal, (ch) => (ch === 6 ? "Sub" : ""));
  assert.deepEqual(lines, ["Sub gain: 0.0 dB → -3.0 dB"]);
});

test("previewModel applies normalized values to a copy", () => {
  const model = defaultModel();
  const original = JSON.stringify(model);
  const preview = previewModel(model, [{ ref: { kind: "gain", ch: 4 }, value: -20.04 }, { ref: { kind: "mute", ch: 4 }, value: null }], cal);
  assert.equal(JSON.stringify(model), original);
  assert.equal(preview.channels[4]!.gainDb, -20);
  assert.equal(preview.channels[4]!.mute, false, "null values are left as they are");
});

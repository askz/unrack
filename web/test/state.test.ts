import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCalibration as cal } from "../src/eq/calibration.ts";
import { History } from "../src/state/history.ts";
import { Editor, createEditorState, type EditorState } from "../src/state/editor.ts";
import { modelFromReadback } from "../src/state/hydrate.ts";
import { parsePresetFile, presetFileName, serializePresetFile, PresetFileError } from "../src/state/presetFile.ts";
import { allParams, checkParam, normalizeParam, paramKey, readParam, ParamError, GAIN_RANGE } from "../src/state/params.ts";
import { clone, defaultModel, sameValue, OUT_BASE } from "../src/state/model.ts";
import type { PeqBand } from "../src/eq/types.ts";
import { Dsp } from "../src/dsp.ts";
import { RequestChannel } from "../src/transport/channel.ts";
import { Command } from "../src/protocol/commands.ts";
import { parsePresetImage, reconstructPresetImage } from "../src/protocol/readback.ts";
import { MockDsp } from "../src/transport/mock.ts";
import { defaultPresetPages } from "../src/transport/factory-pages.ts";

const OUT1 = OUT_BASE;
const OUT2 = OUT_BASE + 1;

// ---- params ----

test("normalize clamps to range and quantizes to the device resolution", () => {
  assert.equal(normalizeParam({ kind: "gain", ch: 0 }, 3.14159, cal), 3.1);
  assert.equal(normalizeParam({ kind: "gain", ch: 0 }, 40, cal), GAIN_RANGE.max);
  assert.equal(normalizeParam({ kind: "delay", ch: OUT1 }, 1.01, cal), 1); // 48 samples
  assert.equal(normalizeParam({ kind: "routing", ch: OUT1 }, 99, cal), 15);
  const band = normalizeParam({ kind: "peq", ch: OUT1, band: 0 }, { freqHz: 1000, gainDb: 30, bwOct: 1, type: 0, bypass: false }, cal) as PeqBand;
  assert.equal(band.gainDb, 12);
  assert.equal(band.freqHz, cal.peqIndexToHz(cal.peqHzToIndex(1000)));
  const again = normalizeParam({ kind: "peq", ch: OUT1, band: 0 }, band, cal);
  assert.deepEqual(again, band, "normalizing is idempotent");
});

test("normalize rejects wrong types and parameters that do not exist", () => {
  assert.throws(() => normalizeParam({ kind: "gain", ch: 0 }, Number.NaN, cal), ParamError);
  assert.throws(() => normalizeParam({ kind: "mute", ch: 0 }, 1, cal), ParamError);
  assert.throws(() => normalizeParam({ kind: "gate", ch: OUT1 }, { thresholdDb: 0, attackMs: 1, holdMs: 10, releaseMs: 1 }, cal), ParamError);
  assert.throws(() => normalizeParam({ kind: "peq", ch: OUT1, band: 7 }, 0, cal), ParamError);
});

test("checkParam explains out-of-range and missing values", () => {
  assert.deepEqual(checkParam({ kind: "gain", ch: 0 }, 0), []);
  assert.match(checkParam({ kind: "gain", ch: 0 }, 50)[0]!, /In A gain 50 is outside/);
  assert.match(checkParam({ kind: "comp", ch: OUT1 }, undefined)[0]!, /Out 1 compressor is missing/);
  assert.deepEqual(checkParam({ kind: "mute", ch: 0 }, null), [], "unknown mute is allowed");
});

test("every parameter of a default model is readable and valid", () => {
  const model = defaultModel();
  const refs = allParams();
  assert.equal(refs.length, 4 * 4 + 4 * (3 + 4 + 7 + 1));
  assert.equal(new Set(refs.map(paramKey)).size, refs.length);
  for (const ref of refs) assert.deepEqual(checkParam(ref, readParam(model, ref)), [], paramKey(ref));
});

test("the default model is the factory default and exactly representable on the device", () => {
  const model = defaultModel();
  for (const ref of allParams()) {
    const value = readParam(model, ref);
    if (value !== null) assert.deepEqual(normalizeParam(ref, value, cal), value, paramKey(ref));
  }
  const image = parsePresetImage(reconstructPresetImage(defaultPresetPages()));
  const fromDevice = modelFromReadback(image, cal);
  const bands = (m: typeof model) => m.channels[OUT1]!.eq!.bands.map(({ freqHz, gainDb, bwOct, type }) => ({ freqHz, gainDb, bwOct, type }));
  assert.deepEqual(bands(fromDevice), bands(model));
  assert.deepEqual(fromDevice.channels[0]!.gate, model.channels[0]!.gate);
  assert.deepEqual(fromDevice.channels[OUT1]!.comp, model.channels[OUT1]!.comp);
});

// ---- history ----

test("history merges a gesture on one parameter, and seal() splits it", () => {
  let now = 0;
  const history = new History<number>({ now: () => now });
  history.record("gain", [{ key: "g", before: 0, after: 1 }], "g");
  now = 100;
  history.record("gain", [{ key: "g", before: 1, after: 2 }], "g");
  assert.deepEqual(history.undo()!.changes, [{ key: "g", before: 0, after: 2 }]);
  history.redo();
  history.seal();
  history.record("gain", [{ key: "g", before: 2, after: 3 }], "g");
  assert.equal(history.undo()!.changes[0]!.before, 2);
});

test("history does not merge across the window or different parameters", () => {
  let now = 0;
  const history = new History<number>({ now: () => now, mergeWindowMs: 500 });
  history.record("a", [{ key: "a", before: 0, after: 1 }], "a");
  now = 600;
  history.record("a", [{ key: "a", before: 1, after: 2 }], "a");
  history.record("b", [{ key: "b", before: 0, after: 1 }], "b");
  assert.equal(history.undo()!.label, "b");
  assert.equal(history.undo()!.changes[0]!.before, 1);
  assert.equal(history.undo()!.changes[0]!.before, 0);
  assert.equal(history.undo(), undefined);
});

test("a new edit clears the redo stack", () => {
  const history = new History<number>();
  history.record("a", [{ key: "a", before: 0, after: 1 }]);
  history.undo();
  assert.equal(history.redoLabel, "a");
  history.record("b", [{ key: "b", before: 0, after: 1 }]);
  assert.equal(history.redoLabel, null);
});

// ---- editor ----

async function editorWithDevice(device = new MockDsp()) {
  await device.open();
  const dsp = new Dsp(new RequestChannel(device));
  const state: EditorState = createEditorState(defaultModel());
  const errors: string[] = [];
  let connected = true;
  const editor = new Editor(state, { dsp: () => (connected ? dsp : null), cal, onError: (label) => errors.push(label) });
  return { device, state, editor, errors, disconnect: () => { connected = false; } };
}

test("set applies, sends and clears the sync entry once acked", async () => {
  const { device, state, editor } = await editorWithDevice();
  const done = editor.set({ kind: "gain", ch: OUT1 }, -6);
  assert.equal(state.model.channels[OUT1]!.gainDb, -6);
  assert.equal(state.sync["gain:4"]?.status, "pending");
  assert.equal(await done, true);
  assert.equal(state.sync["gain:4"], undefined);
  assert.deepEqual(device.receivedCodes(), [Command.LEVEL]);
  assert.equal(state.modified, true);
  assert.equal(state.undoLabel, "Out 1 gain");
});

test("an unchanged value is neither sent nor recorded", async () => {
  const { device, state, editor } = await editorWithDevice();
  await editor.set({ kind: "gain", ch: OUT1 }, 0);
  const comp = state.model.channels[OUT1]!.comp!;
  const reordered = { releaseMs: comp.releaseMs, attackMs: comp.attackMs, kneeDb: comp.kneeDb, ratioIndex: comp.ratioIndex, thresholdDb: comp.thresholdDb };
  await editor.set({ kind: "comp", ch: OUT1 }, reordered);
  assert.equal(device.received.length, 0);
  assert.equal(state.undoLabel, null);
});

test("sameValue ignores key order and compares nested data", () => {
  assert.equal(sameValue({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }), true);
  assert.equal(sameValue({ a: 1 }, { a: 2 }), false);
  assert.equal(sameValue([1, 2], [2, 1]), false);
  assert.equal(sameValue(null, false), false);
  assert.equal(sameValue({ a: null }, { a: null }), true);
});

test("undo and redo restore the value on the device", async () => {
  const { device, state, editor } = await editorWithDevice();
  await editor.set({ kind: "delay", ch: OUT2 }, 5);
  await editor.undo();
  assert.equal(state.model.channels[OUT2]!.delayMs, 0);
  assert.equal(state.redoLabel, "Out 2 delay");
  await editor.redo();
  assert.equal(state.model.channels[OUT2]!.delayMs, 5);
  assert.deepEqual(device.receivedCodes(), [Command.DELAY, Command.DELAY, Command.DELAY]);
});

test("linked outputs mirror EQ edits, and one undo reverts both", async () => {
  const { state, editor } = await editorWithDevice();
  await editor.link(OUT1, OUT2);
  const band = { freqHz: 250, gainDb: -4, bwOct: 0.5, type: 0, bypass: false };
  await editor.set({ kind: "peq", ch: OUT1, band: 2 }, band);
  const mirrored = state.model.channels[OUT2]!.eq!.bands[2]!;
  assert.equal(mirrored.gainDb, -4);
  await editor.undo();
  assert.equal(state.model.channels[OUT1]!.eq!.bands[2]!.gainDb, 0);
  assert.equal(state.model.channels[OUT2]!.eq!.bands[2]!.gainDb, 0);
  editor.unlink(OUT2);
  assert.deepEqual(state.links, {});
});

test("gain is not mirrored across an EQ link", async () => {
  const { state, editor } = await editorWithDevice();
  await editor.link(OUT1, OUT2);
  await editor.set({ kind: "gain", ch: OUT1 }, -3);
  assert.equal(state.model.channels[OUT2]!.gainDb, 0);
});

test("a rejected write is marked failed and reported", async () => {
  const { device, state, editor, errors } = await editorWithDevice();
  device.unresponsive = true;
  const delivered = await editor.set({ kind: "polarity", ch: 0 }, true);
  assert.equal(delivered, false);
  assert.equal(state.sync["polarity:0"]?.status, "failed");
  assert.deepEqual(errors, ["In A polarity"]);
  device.unresponsive = false;
  assert.equal(await editor.resendUnsynced(), true);
  assert.deepEqual(state.sync, {});
});

test("edits while disconnected are kept and marked offline", async () => {
  const { device, state, editor, disconnect } = await editorWithDevice();
  disconnect();
  await editor.set({ kind: "mute", ch: 1 }, true);
  assert.equal(state.model.channels[1]!.mute, true);
  assert.equal(state.sync["mute:1"]?.status, "offline");
  assert.equal(device.received.length, 0);
});

test("load replaces the model and forgets history and sync state", async () => {
  const { state, editor } = await editorWithDevice();
  await editor.set({ kind: "gain", ch: 0 }, 4);
  const fresh = defaultModel();
  fresh.presetName = "Loaded";
  editor.load(fresh);
  assert.equal(state.model.presetName, "Loaded");
  assert.equal(state.model.channels[0]!.gainDb, 0);
  assert.equal(state.undoLabel, null);
  assert.equal(state.modified, false);
});

test("copyEq copies crossovers and bands as one undo step", async () => {
  const { state, editor } = await editorWithDevice();
  await editor.set({ kind: "hpf", ch: OUT1 }, { freqHz: 80, slope: 8 });
  await editor.set({ kind: "peq", ch: OUT1, band: 0 }, { freqHz: 60, gainDb: 3, bwOct: 1, type: 0, bypass: false });
  await editor.copyEq(OUT1, OUT2);
  assert.deepEqual(state.model.channels[OUT2]!.eq, state.model.channels[OUT1]!.eq);
  await editor.undo();
  assert.equal(state.model.channels[OUT2]!.eq!.hpf.slope, 0);
});

test("setMany with a merge key is one undo step per gesture", async () => {
  const { state, editor } = await editorWithDevice();
  const trim = (db: number) => [OUT1, OUT2].map((ch) => ({ ref: { kind: "gain" as const, ch }, value: db }));
  await editor.setMany("Trim outputs", trim(-1), { mergeKey: "trim" });
  await editor.setMany("Trim outputs", trim(-2), { mergeKey: "trim" });
  editor.seal();
  await editor.setMany("Trim outputs", trim(-3), { mergeKey: "trim" });
  await editor.undo();
  assert.equal(state.model.channels[OUT1]!.gainDb, -2);
  await editor.undo();
  assert.equal(state.model.channels[OUT1]!.gainDb, 0);
  assert.equal(state.model.channels[OUT2]!.gainDb, 0);
  assert.equal(state.undoLabel, null);
});

// ---- hydrate ----

test("readback of a factory-default unit: 0 dB everywhere, mute and bypass unknown", () => {
  const image = parsePresetImage(reconstructPresetImage(defaultPresetPages()));
  const model = modelFromReadback(image, cal);
  assert.equal(model.presetName, "Default Preset");
  assert.deepEqual(model.channels.map((ch) => ch.gainDb), new Array(8).fill(0));
  assert.deepEqual(model.channels.map((ch) => ch.mute), new Array(8).fill(null));
  assert.ok(model.channels[OUT1]!.eq!.bands.every((band) => band.bypass === null));
  assert.equal(model.channels[OUT1]!.eq!.lpf.freqHz, cal.xoverRawToHz(300));
  const previous = defaultModel();
  previous.channels[2]!.mute = true;
  assert.equal(modelFromReadback(image, cal, previous).channels[2]!.mute, true, "known mute survives a resync");
});

// ---- preset files ----

test("a preset file round-trips every parameter", () => {
  const model = defaultModel();
  model.presetName = "Club / Main";
  model.channels[OUT1]!.gainDb = -3.5;
  model.channels[OUT2]!.eq!.bands[4]!.gainDb = 2.5;
  model.channels[0]!.mute = null;
  const text = serializePresetFile(model, new Date("2026-09-23T10:00:00Z"));
  const parsed = parsePresetFile(text);
  assert.equal(parsed.presetName, "Club / Main");
  assert.equal(parsed.assignments.length, allParams().length);
  const restored = defaultModel();
  for (const { ref, value } of parsed.assignments) {
    const target = clone(value);
    if (target !== null) assert.deepEqual(readParam(model, ref), target, paramKey(ref));
  }
  assert.equal(parsed.assignments.find((a) => paramKey(a.ref) === "mute:0")!.value, null);
  assert.ok(restored);
  assert.equal(presetFileName("Club / Main", new Date("2026-09-23T10:00:00Z")), "Club-Main-2026-09-23.dsp4x4.json");
});

test("a preset file with bad values is rejected with every problem listed", () => {
  const model = defaultModel();
  const file = JSON.parse(serializePresetFile(model));
  file.model.channels[OUT1].gainDb = 99;
  file.model.channels[OUT2].eq.bands[0].type = "peak";
  delete file.model.channels[0].gate;
  try {
    parsePresetFile(JSON.stringify(file));
    assert.fail("expected a PresetFileError");
  } catch (error) {
    assert.ok(error instanceof PresetFileError);
    assert.equal(error.issues.length, 3);
    assert.match(error.issues.join("\n"), /Out 1 gain 99 is outside/);
    assert.match(error.issues.join("\n"), /Out 2 PEQ band 1 type must be a number/);
    assert.match(error.issues.join("\n"), /In A gate is missing/);
  }
});

test("files that are not presets are refused", () => {
  assert.throws(() => parsePresetFile("{nope"), /not valid JSON/);
  assert.throws(() => parsePresetFile(JSON.stringify({ hello: 1 })), /not an openDSP-4x4 preset file/);
  assert.throws(() => parsePresetFile(JSON.stringify({ format: "opendsp-4x4/preset", version: 9, model: {} })), /unsupported preset file version 9/);
});

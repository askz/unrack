import { test } from "node:test";
import assert from "node:assert/strict";
import { ToneSource } from "../src/protocol/commands.ts";
import { OUT_BASE, defaultModel, type DeviceModel } from "../src/state/model.ts";
import type { ParamAssignment } from "../src/state/params.ts";
import type { StorageLike } from "../src/state/settings.ts";
import { defaultRecipe, rigOf, type Recipe } from "../src/setup/recipe.ts";
import {
  TUNING_SESSION_KEY, loadTuningSnapshot, nearestToneIndex, offsetAssignments, restoreAfterTuning, snapshotOf,
  startAssignments, tuningSteps, type TuningSnapshot,
} from "../src/setup/tuning.ts";
import { TuningRunner, type TuningDevice, type TuningState } from "../src/setup/tuningRunner.ts";

class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null { return this.items.get(key) ?? null; }
  setItem(key: string, value: string): void { this.items.set(key, value); }
}

interface Deferred {
  promise: Promise<boolean>;
  resolve(confirmed: boolean): void;
}

function deferred(): Deferred {
  let resolve!: (confirmed: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  return { promise, resolve };
}

type Result = boolean | Deferred;
const resultOf = (next: Result | undefined): Promise<boolean> =>
  next === undefined ? Promise.resolve(true) : typeof next === "boolean" ? Promise.resolve(next) : next.promise;

/** Records every call in order; applyGroup and testTone confirm unless a result is queued. */
class FakeDevice implements TuningDevice {
  connected = true;
  model: DeviceModel = defaultModel();
  readonly calls: string[] = [];
  readonly applied: ParamAssignment[][] = [];
  readonly issues: string[] = [];
  readonly applyResults: Result[] = [];
  readonly toneResults: Result[] = [];

  beginGroup(label: string): void { this.calls.push(`begin ${label}`); }
  endGroup(): void { this.calls.push("end"); }
  applyGroup(label: string, assignments: ParamAssignment[]): Promise<boolean> {
    this.calls.push(`apply ${label}`);
    this.applied.push(assignments);
    return resultOf(this.applyResults.shift());
  }
  testTone(source: number, freqIndex = 0): Promise<boolean> {
    this.calls.push(source === ToneSource.OFF ? "tone off" : `tone ${source}:${freqIndex}`);
    return resultOf(this.toneResults.shift());
  }
  resetOutputSnapshots(): void { this.calls.push("reset snapshots"); }
  report(label: string, message: string): void { this.issues.push(`${label}: ${message}`); }
}

const PAIR = "Sub ↔ Top L";
const LABEL = `Fine-tune ${PAIR}`;
const SINE = `tone ${ToneSource.SINE}:${nearestToneIndex(100)}`;
const STARTED = ["reset snapshots", `begin ${LABEL}`, `apply ${LABEL}`, SINE];
const ENDED = ["tone off", `apply ${LABEL}`, "end", "reset snapshots"];

function recipe(subOffsetMs = 0): Recipe {
  const r = defaultRecipe("2.1");
  r.alignment = { ...r.alignment, enabled: true, tempC: 20, mode: "direct", distancesM: [0, 0, 0, 0], offsetsMs: [0, 0, subOffsetMs, 0] };
  return r;
}

const STEP = tuningSteps(rigOf(recipe()).outputs, rigOf(recipe()).crossoversHz)[0]!;

function setup(stored: TuningSnapshot | null = null) {
  const device = new FakeDevice();
  device.model.channels[OUT_BASE]!.polarity = true;
  device.model.channels[OUT_BASE + 2]!.delayMs = 3;
  const storage = new MemoryStorage();
  if (stored) storage.setItem(TUNING_SESSION_KEY, JSON.stringify(stored));
  const state: TuningState = { running: null, starting: false, offsetMs: 0, interrupted: null };
  const offsets: [number, number][] = [];
  const runner = new TuningRunner({ device, storage, state, storeOffset: (output, ms) => offsets.push([output, ms]) });
  const snapshot = snapshotOf(device.model);
  const start = (subOffsetMs = 0) => runner.start(recipe(subOffsetMs), STEP, 0, PAIR);
  return { device, storage, state, offsets, runner, snapshot, start };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("the pair to tune is the sub against Top L at 100 Hz", () => {
  assert.equal(STEP.lower, 2);
  assert.deepEqual(STEP.uppers, [0, 1]);
  assert.equal(STEP.crossoverHz, 100);
});

test("start plays the tone only once the device confirmed the mutes and the polarity flip", async () => {
  const { device, storage, state, snapshot, start } = setup();
  const muted = deferred();
  device.applyResults.push(muted);
  const started = start();
  await flush();
  assert.deepEqual(device.calls, STARTED.slice(0, 3));
  assert.deepEqual(device.applied[0], startAssignments(snapshot, 2, 0));
  assert.deepEqual(loadTuningSnapshot(storage), snapshot, "saved before anything is changed");
  assert.equal(state.starting, true);
  assert.equal(state.running?.pairName, PAIR);
  muted.resolve(true);
  await started;
  assert.deepEqual(device.calls, STARTED);
  assert.equal(state.starting, false);
  assert.equal(state.running?.toneHz, 100);
});

test("an unconfirmed mute or polarity write cancels the start without a tone", async () => {
  const { device, storage, state, snapshot, start } = setup();
  device.applyResults.push(false);
  await start();
  assert.deepEqual(device.calls, [...STARTED.slice(0, 3), ...ENDED]);
  assert.deepEqual(device.applied[1], restoreAfterTuning(snapshot, false));
  assert.deepEqual(device.issues, [`${LABEL}: Could not mute the other outputs; the fine-tuning was cancelled`]);
  assert.equal(state.running, null);
  assert.equal(state.starting, false);
  assert.equal(state.interrupted, null);
  assert.equal(loadTuningSnapshot(storage), null);
});

test("a failed tone command cancels the session", async () => {
  const { device, state, snapshot, start } = setup();
  device.toneResults.push(false);
  await start();
  assert.deepEqual(device.calls, [...STARTED, ...ENDED]);
  assert.deepEqual(device.applied[1], restoreAfterTuning(snapshot, false));
  assert.deepEqual(device.issues, [`${LABEL}: Could not start the tone; the fine-tuning was cancelled`]);
  assert.equal(state.running, null);
});

test("cancel while the start is awaited plays no tone", async () => {
  const { device, storage, state, start, runner } = setup();
  const muted = deferred();
  device.applyResults.push(muted);
  const started = start();
  await flush();
  const cancelled = runner.cancel();
  muted.resolve(true);
  await Promise.all([started, cancelled]);
  assert.deepEqual(device.calls, [...STARTED.slice(0, 3), ...ENDED]);
  assert.equal(state.running, null);
  assert.equal(loadTuningSnapshot(storage), null);
});

test("a lost link while the start is awaited plays no tone and keeps the snapshot", async () => {
  const { device, storage, state, snapshot, start, runner } = setup();
  const muted = deferred();
  device.applyResults.push(muted);
  const started = start();
  await flush();
  device.connected = false;
  runner.interrupt();
  muted.resolve(false);
  await started;
  assert.deepEqual(device.calls, [...STARTED.slice(0, 3), "end", "reset snapshots"]);
  assert.deepEqual(device.issues, []);
  assert.deepEqual(state.interrupted, snapshot);
  assert.deepEqual(loadTuningSnapshot(storage), snapshot);
});

test("start is refused while disconnected, running or with an interrupted session", async () => {
  const offline = setup();
  offline.device.connected = false;
  await offline.start();
  assert.deepEqual(offline.device.calls, []);

  const waiting = setup(offline.snapshot);
  await waiting.start();
  assert.deepEqual(waiting.device.calls, []);

  const running = setup();
  await running.start();
  await running.start();
  assert.deepEqual(running.device.calls, STARTED);
});

test("Done turns the tone off before restoring, keeps the delays and stores the offset", async () => {
  const { device, storage, state, offsets, snapshot, start, runner } = setup();
  await start();
  runner.setOffset(1.234);
  await runner.done();
  assert.deepEqual(device.calls, [...STARTED, `apply ${LABEL}`, ...ENDED]);
  assert.deepEqual(device.applied.at(-1), restoreAfterTuning(snapshot, true));
  assert.deepEqual(offsets, [[2, 1.23]]);
  assert.equal(state.running, null);
  assert.equal(state.interrupted, null);
  assert.equal(loadTuningSnapshot(storage), null);
});

test("Cancel turns the tone off before restoring everything, the offset untouched", async () => {
  const { device, storage, offsets, snapshot, start, runner } = setup();
  await start();
  runner.setOffset(2);
  await runner.cancel();
  assert.deepEqual(device.calls, [...STARTED, `apply ${LABEL}`, ...ENDED]);
  assert.deepEqual(device.applied.at(-1), restoreAfterTuning(snapshot, false));
  assert.deepEqual(offsets, []);
  assert.equal(loadTuningSnapshot(storage), null);
});

test("an unconfirmed restore keeps the snapshot and offers the restore", async () => {
  const { device, storage, state, snapshot, start, runner } = setup();
  await start();
  device.applyResults.push(false);
  await runner.cancel();
  assert.deepEqual(device.calls, [...STARTED, ...ENDED]);
  assert.equal(state.running, null);
  assert.deepEqual(state.interrupted, snapshot);
  assert.deepEqual(loadTuningSnapshot(storage), snapshot);
});

test("nothing is unmuted until the device confirmed the tone is off", async () => {
  const { device, start, runner } = setup();
  await start();
  const silenced = deferred();
  device.toneResults.push(silenced);
  const cancelled = runner.cancel();
  await flush();
  assert.deepEqual(device.calls, [...STARTED, "tone off"]);
  silenced.resolve(true);
  await cancelled;
  assert.deepEqual(device.calls, [...STARTED, ...ENDED]);
});

test("an unconfirmed tone off leaves the outputs muted and offers the restore", async () => {
  const { device, storage, state, snapshot, start, runner } = setup();
  await start();
  device.toneResults.push(false);
  await runner.cancel();
  assert.deepEqual(device.calls, [...STARTED, "tone off", "end", "reset snapshots"], "no restore writes");
  assert.deepEqual(device.issues, [`${LABEL}: Could not stop the tone; the other outputs stay muted`]);
  assert.equal(state.running, null);
  assert.deepEqual(state.interrupted, snapshot);
  assert.deepEqual(loadTuningSnapshot(storage), snapshot);
});

test("a new session waits until the previous one's restore is confirmed", async () => {
  const { device, storage, snapshot, start, runner } = setup();
  await start();
  const restored = deferred();
  device.applyResults.push(restored);
  const cancelled = runner.cancel();
  await flush();
  await start();
  assert.deepEqual(device.calls, [...STARTED, ...ENDED], "refused while the restore is unconfirmed");
  restored.resolve(true);
  await cancelled;
  assert.equal(loadTuningSnapshot(storage), null);
  await start();
  assert.deepEqual(device.calls, [...STARTED, ...ENDED, ...STARTED]);
  assert.deepEqual(loadTuningSnapshot(storage), snapshot);
});

test("a lost link ends the group without sending anything", async () => {
  const { device, storage, state, snapshot, start, runner } = setup();
  runner.interrupt();
  assert.deepEqual(device.calls, [], "no session: nothing to do");
  await start();
  device.connected = false;
  runner.interrupt();
  assert.deepEqual(device.calls, [...STARTED, "end", "reset snapshots"]);
  assert.equal(state.running, null);
  assert.deepEqual(state.interrupted, snapshot);
  assert.deepEqual(loadTuningSnapshot(storage), snapshot);
});

test("Restore hides the notice while in flight and brings it back if it is not confirmed", async () => {
  const stored = snapshotOf(defaultModel());
  stored.polarities[2] = true;
  const { device, storage, state, runner } = setup(stored);
  assert.deepEqual(state.interrupted, stored, "loaded from storage");
  const restored = deferred();
  device.applyResults.push(restored);
  const pending = runner.restoreInterrupted();
  assert.equal(state.interrupted, null);
  await runner.restoreInterrupted();
  await flush();
  assert.deepEqual(device.calls, ["tone off", "apply Restore after fine-tuning", "end", "reset snapshots"], "sent once");
  assert.deepEqual(device.applied[0], restoreAfterTuning(stored, false));
  restored.resolve(false);
  await pending;
  assert.deepEqual(state.interrupted, stored);
  assert.deepEqual(loadTuningSnapshot(storage), stored);

  await runner.restoreInterrupted();
  assert.equal(state.interrupted, null);
  assert.equal(loadTuningSnapshot(storage), null);
});

test("Restore waits for a connection", async () => {
  const stored = snapshotOf(defaultModel());
  const { device, state, runner } = setup(stored);
  device.connected = false;
  await runner.restoreInterrupted();
  assert.deepEqual(device.calls, []);
  assert.deepEqual(state.interrupted, stored);
});

test("Dismiss turns the tone off when connected and forgets the snapshot", () => {
  const stored = snapshotOf(defaultModel());
  const online = setup(stored);
  online.runner.dismissInterrupted();
  assert.deepEqual(online.device.calls, ["tone off"]);
  assert.equal(online.state.interrupted, null);
  assert.equal(loadTuningSnapshot(online.storage), null);

  const offline = setup(stored);
  offline.device.connected = false;
  offline.runner.dismissInterrupted();
  assert.deepEqual(offline.device.calls, []);
  assert.equal(offline.state.interrupted, null);
  assert.equal(loadTuningSnapshot(offline.storage), null);
});

test("the offset stays within half a period of the start and is rounded to 0.01 ms", async () => {
  const { device, state, start, runner } = setup();
  await start(2);
  assert.equal(state.offsetMs, 2);
  assert.deepEqual(state.running?.limits, { min: -3, max: 7 });
  runner.setOffset(12);
  assert.equal(state.offsetMs, 7);
  assert.deepEqual(device.applied.at(-1), offsetAssignments(rigOf(recipe(2)), 2, 7));
  runner.setOffset(-12);
  assert.equal(state.offsetMs, -3);
  runner.setOffset(1.23456);
  assert.equal(state.offsetMs, 1.23);
  const sent = device.applied.length;
  runner.setOffset(1.231);
  assert.equal(device.applied.length, sent, "same offset: nothing sent");
});

test("no offset change without a session", () => {
  const { device, runner } = setup();
  runner.setOffset(1);
  assert.deepEqual(device.calls, []);
});

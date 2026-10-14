// The sequencing of a by-ear fine-tuning session against the device, behind a small
// facade so it can be tested without Svelte. Start mutes all but the pair and flips the
// lower output's polarity, then plays the sine; each offset change re-sends the delays;
// Done keeps the delays and stores the offset in the setup, Cancel puts everything back.
// A session is one undo step. What it changed stays in storage until the device has
// confirmed it is put back, so it can still be restored after a reload or a lost link.
import { TONE_FREQS, ToneSource } from "../protocol/commands.ts";
import type { DeviceModel } from "../state/model.ts";
import type { ParamAssignment } from "../state/params.ts";
import type { StorageLike } from "../state/settings.ts";
import type { Rig } from "./alignment.ts";
import { rigOf, type Recipe } from "./recipe.ts";
import {
  clearTuningSnapshot, loadTuningSnapshot, nearestToneIndex, offsetAssignments, offsetLimits, restoreAfterTuning,
  saveTuningSnapshot, snapshotOf, startAssignments, type TuningSnapshot, type TuningStep,
} from "./tuning.ts";

/** The session in progress: the pair, the tone, the offset range and what to put back. */
export interface RunningTuning {
  /** "Sub ↔ Top L" */
  pairName: string;
  step: TuningStep;
  upper: number;
  toneHz: number;
  limits: { min: number; max: number };
  rig: Rig;
  snapshot: TuningSnapshot;
}

/** What the runner needs from the device store. */
export interface TuningDevice {
  readonly connected: boolean;
  readonly model: DeviceModel;
  beginGroup(label: string): void;
  endGroup(): void;
  /** Resolves true once the device confirmed every write. */
  applyGroup(label: string, assignments: ParamAssignment[]): Promise<boolean>;
  /** Resolves true once the device confirmed the command. */
  testTone(source: number, freqIndex?: number): Promise<boolean>;
  /** Forget the solo and mute-all states, so they cannot later re-mute outputs. */
  resetOutputSnapshots(): void;
  /** Add an entry to the issue log. */
  report(label: string, message: string): void;
}

/** Where the runner keeps what the UI shows (reactive state in the app). */
export interface TuningState {
  running: RunningTuning | null;
  /** Waiting for the device to confirm the mutes and polarity: the tone is not on yet. */
  starting: boolean;
  offsetMs: number;
  /** What a session that did not end (reload, lost link, unconfirmed restore) had changed. */
  interrupted: TuningSnapshot | null;
}

export interface TuningRunnerDeps {
  device: TuningDevice;
  storage: StorageLike | null;
  state: TuningState;
  /** Keep the offset found for an output in the setup draft. */
  storeOffset(output: number, offsetMs: number): void;
}

const OFFSET_DECIMALS = 2;
const RESTORE_LABEL = "Restore after fine-tuning";

const labelOf = (run: RunningTuning) => `Fine-tune ${run.pairName}`;

/** Runs one session at a time; every method is safe to call in any state. */
export class TuningRunner {
  private readonly device: TuningDevice;
  private readonly storage: StorageLike | null;
  private readonly state: TuningState;
  private readonly storeOffset: TuningRunnerDeps["storeOffset"];
  /** Ends and restores waiting for the device: their outcome decides whether the snapshot is kept. */
  private settling = 0;

  constructor(deps: TuningRunnerDeps) {
    this.device = deps.device;
    this.storage = deps.storage;
    this.state = deps.state;
    this.storeOffset = deps.storeOffset;
    this.state.interrupted = loadTuningSnapshot(this.storage);
  }

  async start(recipe: Recipe, step: TuningStep, upper: number, pairName: string): Promise<void> {
    const { device, state } = this;
    if (state.running || state.interrupted || this.settling > 0 || !device.connected) return;
    const rig = rigOf(recipe);
    const snapshot = snapshotOf(device.model);
    saveTuningSnapshot(this.storage, snapshot);
    const toneIndex = nearestToneIndex(step.crossoverHz);
    const toneHz = TONE_FREQS[toneIndex]!;
    const startMs = rig.alignment.offsetsMs[step.lower] ?? 0;
    const run: RunningTuning = { pairName, step, upper, toneHz, limits: offsetLimits(startMs, toneHz), rig, snapshot };
    device.resetOutputSnapshots();
    device.beginGroup(labelOf(run));
    state.offsetMs = startMs;
    state.running = run;
    state.starting = true;

    // the tone plays on every unmuted routed output, so it waits for the device to confirm the mutes
    const muted = await device.applyGroup(labelOf(run), startAssignments(snapshot, step.lower, upper));
    if (state.running !== run) return;
    if (!muted) return this.abort(run, "Could not mute the other outputs; the fine-tuning was cancelled");
    const playing = await device.testTone(ToneSource.SINE, toneIndex);
    if (state.running !== run) return;
    state.starting = false;
    if (!playing) return this.abort(run, "Could not start the tone; the fine-tuning was cancelled");
  }

  setOffset(ms: number): void {
    const run = this.state.running;
    if (!run) return;
    const next = Number(Math.min(run.limits.max, Math.max(run.limits.min, ms)).toFixed(OFFSET_DECIMALS));
    if (next === this.state.offsetMs) return;
    this.state.offsetMs = next;
    void this.device.applyGroup(labelOf(run), offsetAssignments(run.rig, run.step.lower, next));
  }

  /** Keep the delays and store the offset in the setup. */
  done(): Promise<void> {
    const run = this.state.running;
    if (!run) return Promise.resolve();
    this.storeOffset(run.step.lower, this.state.offsetMs);
    return this.finish(run, true);
  }

  cancel(): Promise<void> {
    const run = this.state.running;
    return run ? this.finish(run, false) : Promise.resolve();
  }

  /** Put back what an interrupted session changed; the notice comes back if the device does not confirm it. */
  async restoreInterrupted(): Promise<void> {
    const snapshot = this.state.interrupted;
    if (!snapshot || this.state.running || !this.device.connected) return;
    this.state.interrupted = null;
    await this.settle(snapshot, [
      this.device.testTone(ToneSource.OFF),
      this.device.applyGroup(RESTORE_LABEL, restoreAfterTuning(snapshot, false)),
    ]);
  }

  /** Forget an interrupted session: the tone goes off, the outputs stay as they are. */
  dismissInterrupted(): void {
    if (!this.state.interrupted) return;
    if (this.device.connected) void this.device.testTone(ToneSource.OFF);
    this.state.interrupted = null;
    clearTuningSnapshot(this.storage);
  }

  /** The link went away: nothing can be sent, and the readback on reconnect clears the undo group. */
  interrupt(): void {
    const run = this.state.running;
    if (!run) return;
    this.close();
    this.state.interrupted = run.snapshot;
  }

  private async abort(run: RunningTuning, message: string): Promise<void> {
    this.device.report(labelOf(run), message);
    await this.finish(run, false);
  }

  private async finish(run: RunningTuning, keepDelays: boolean): Promise<void> {
    // the tone goes off before anything is unmuted (the device handles commands in order)
    const sends = [
      this.device.testTone(ToneSource.OFF),
      this.device.applyGroup(labelOf(run), restoreAfterTuning(run.snapshot, keepDelays)),
    ];
    this.close();
    await this.settle(run.snapshot, sends);
  }

  private close(): void {
    this.device.endGroup();
    this.device.resetOutputSnapshots();
    this.state.running = null;
    this.state.starting = false;
  }

  /** Forget the snapshot only once the device confirmed it is put back. */
  private async settle(snapshot: TuningSnapshot, sends: Promise<boolean>[]): Promise<void> {
    this.settling++;
    try {
      const confirmed = (await Promise.all(sends)).every(Boolean);
      if (confirmed) clearTuningSnapshot(this.storage);
      else this.state.interrupted = snapshot;
    } finally {
      this.settling--;
    }
  }
}

// A by-ear fine-tuning session on the device. Start mutes all but the pair, flips the
// lower output's polarity and plays the sine; each offset change re-sends the delays;
// Done keeps the delays and stores the offset in the setup, Cancel puts everything back.
// A session is one undo step. What it changed stays in localStorage until it ends, so
// it can be put back after a reload or a lost connection.
import { TONE_FREQS, ToneSource } from "../protocol/commands.ts";
import { device } from "../state/device.svelte.ts";
import { browserStorage } from "../state/storage.ts";
import type { Rig } from "./alignment.ts";
import { setupDraft } from "./draft.svelte.ts";
import { rigOf, type Recipe } from "./recipe.ts";
import {
  clearTuningSnapshot, loadTuningSnapshot, nearestToneIndex, offsetAssignments, offsetLimits, restoreAfterTuning,
  saveTuningSnapshot, snapshotOf, startAssignments, type TuningSnapshot, type TuningStep,
} from "./tuning.ts";

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

const OFFSET_DECIMALS = 2;

class TuningSession {
  private readonly storage = browserStorage();
  running = $state.raw<RunningTuning | null>(null);
  offsetMs = $state(0);
  /** What a session that did not end (reload, lost connection) had changed. */
  interrupted = $state.raw<TuningSnapshot | null>(null);

  constructor() {
    this.interrupted = loadTuningSnapshot(this.storage);
  }

  start(recipe: Recipe, step: TuningStep, upper: number, pairName: string): void {
    if (this.running || this.interrupted || !device.connected) return;
    const rig = rigOf(recipe);
    const snapshot = snapshotOf(device.edit.model);
    saveTuningSnapshot(this.storage, snapshot);
    const toneIndex = nearestToneIndex(step.crossoverHz);
    const toneHz = TONE_FREQS[toneIndex]!;
    const startMs = rig.alignment.offsetsMs[step.lower] ?? 0;
    const label = `Fine-tune ${pairName}`;
    device.beginGroup(label);
    device.applyGroup(label, startAssignments(snapshot, step.lower, upper));
    device.testTone(ToneSource.SINE, toneIndex);
    this.offsetMs = startMs;
    this.running = { pairName, step, upper, toneHz, limits: offsetLimits(startMs, toneHz), rig, snapshot };
  }

  setOffset(ms: number): void {
    const run = this.running;
    if (!run) return;
    const next = Number(Math.min(run.limits.max, Math.max(run.limits.min, ms)).toFixed(OFFSET_DECIMALS));
    if (next === this.offsetMs) return;
    this.offsetMs = next;
    device.applyGroup(`Fine-tune ${run.pairName}`, offsetAssignments(run.rig, run.step.lower, next));
  }

  /** Keep the delays and store the offset in the setup. */
  done(): void {
    const run = this.running;
    if (!run) return;
    const offset = this.offsetMs;
    this.finish(run, true);
    setupDraft.edit((recipe) => { recipe.alignment.offsetsMs[run.step.lower] = offset; });
  }

  cancel(): void {
    const run = this.running;
    if (run) this.finish(run, false);
  }

  restoreInterrupted(): void {
    const snapshot = this.interrupted;
    if (!snapshot || !device.connected) return;
    device.testTone(ToneSource.OFF);
    device.applyGroup("Restore after fine-tuning", restoreAfterTuning(snapshot, false));
    this.dismissInterrupted();
  }

  dismissInterrupted(): void {
    this.interrupted = null;
    clearTuningSnapshot(this.storage);
  }

  private finish(run: RunningTuning, keepDelays: boolean): void {
    const reached = device.connected;
    device.testTone(ToneSource.OFF);
    device.applyGroup(`Fine-tune ${run.pairName}`, restoreAfterTuning(run.snapshot, keepDelays));
    device.endGroup();
    this.running = null;
    if (reached) clearTuningSnapshot(this.storage);
    else this.interrupted = run.snapshot;
  }
}

export const tuning = new TuningSession();

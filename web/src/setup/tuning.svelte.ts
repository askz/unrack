// The app's by-ear fine-tuning session: reactive state for the UI around the
// TuningRunner (tuningRunner.ts), which does the sequencing against the device. A lost
// link ends a running session as interrupted.
import { untrack } from "svelte";
import { device } from "../state/device.svelte.ts";
import { browserStorage } from "../state/storage.ts";
import { setupDraft } from "./draft.svelte.ts";
import type { Recipe } from "./recipe.ts";
import type { TuningSnapshot, TuningStep } from "./tuning.ts";
import { TuningRunner, type RunningTuning, type TuningDevice, type TuningState } from "./tuningRunner.ts";

/** Title of the controls that reload or replace the live state, disabled while a session runs. */
export const TUNING_LOCKED = "Finish or cancel the fine-tuning first";
/** Title of the controls that replace the live state while an interrupted session waits for Restore or Dismiss. */
export const TUNING_INTERRUPTED = "Restore or dismiss the interrupted fine-tuning first";

class SessionState implements TuningState {
  running = $state.raw<RunningTuning | null>(null);
  starting = $state(false);
  offsetMs = $state(0);
  interrupted = $state.raw<TuningSnapshot | null>(null);
}

const deviceFacade: TuningDevice = {
  get connected() { return device.connected; },
  get model() { return device.edit.model; },
  beginGroup: (label) => device.beginGroup(label),
  endGroup: () => device.endGroup(),
  applyGroup: (label, assignments) => device.applyGroup(label, assignments),
  testTone: (source, freqIndex) => device.testTone(source, freqIndex),
  resetOutputSnapshots: () => device.resetOutputSnapshots(),
  report: (label, message) => device.reportIssue(label, message),
};

class TuningSession {
  private readonly state = new SessionState();
  private readonly runner = new TuningRunner({
    device: deviceFacade,
    storage: browserStorage(),
    state: this.state,
    storeOffset: (output, offsetMs) => setupDraft.edit((recipe) => { recipe.alignment.offsetsMs[output] = offsetMs; }),
  });

  constructor() {
    $effect.root(() => {
      $effect(() => {
        const linked = device.phase === "ready" || device.phase === "syncing";
        if (!linked) untrack(() => this.runner.interrupt());
      });
      $effect(() => {
        const simulated = device.simulated;
        untrack(() => this.runner.useSimulated(simulated));
      });
    });
  }

  get running(): RunningTuning | null { return this.state.running; }
  /** The device has not confirmed the mutes and polarity yet: the tone is not playing. */
  get starting(): boolean { return this.state.starting; }
  get offsetMs(): number { return this.state.offsetMs; }
  /** What a session that did not end (reload, lost connection, unconfirmed restore) had changed. */
  get interrupted(): TuningSnapshot | null { return this.state.interrupted; }
  /** Why controls that replace the live state are locked now, or null (offline edits are replaced by the readback anyway). */
  get lock(): string | null {
    if (this.state.running) return TUNING_LOCKED;
    return this.state.interrupted && device.connected ? TUNING_INTERRUPTED : null;
  }

  start(recipe: Recipe, step: TuningStep, upper: number, pairName: string): void {
    void this.runner.start(recipe, step, upper, pairName);
  }
  setOffset(ms: number): void { this.runner.setOffset(ms); }
  /** Keep the delays and store the offset in the setup. */
  done(): void { void this.runner.done(); }
  cancel(): void { void this.runner.cancel(); }
  restoreInterrupted(): void { void this.runner.restoreInterrupted(); }
  dismissInterrupted(): void { this.runner.dismissInterrupted(); }
}

/** The app's one fine-tuning session, ended as interrupted when the device link goes away. */
export const tuning = new TuningSession();

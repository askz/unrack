# Time alignment round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Speaker positions with heights, a live side-view diagram of the alignment point and crowd coverage, and a guided by-ear fine tuning, in the Setup tab's time alignment.

**Architecture:** Pure math in `web/src/setup/alignment.ts` (geometry, delays, coverage, suggested point) and `web/src/setup/tuning.ts` (session planning), both unit tested. `recipe.ts` moves to version 2 and upgrades version 1 data. The undo `History` gains groups so a tuning session is one step. Svelte components (`AlignmentSection`, `AlignmentDiagram`, `TuningPanel`) and one reactive store (`tuning.svelte.ts`) sit on top.

**Tech Stack:** Svelte 5 (runes), TypeScript 5.7 (strict, `noUncheckedIndexedAccess`), Vite 6, `node --test` with `--experimental-strip-types`.

Spec: `docs/superpowers/specs/2026-10-14-time-alignment-positions-tuning-design.md`.

## Global Constraints

- Work in `web/`. Tests: `npm test` (all) or `node --experimental-strip-types --test test/<file>.test.ts`. Typecheck: `npm run typecheck` (fails on warnings). Build: `npm run build`.
- Never stage or commit `docs/FIRMWARE.md` (the user's uncommitted work). Always `git add` explicit paths.
- No new device command. Every device edit goes through the `Editor` (via `device`).
- Code comments only for constraints the code cannot show. Match the surrounding style (short header comment per file, `/** */` on exported items).
- UI copy: plain sentences, no em dashes.
- Coupling thresholds: "adds" up to 90 degrees, "weak" up to 120, "cancels" beyond. Crowd sampled every 0.1 m, at most 501 samples.
- Tuning: offset steps 0.1 ms (Shift 1 ms), limited to the start offset +- half a period of the tone, and to -20..+20 ms.
- localStorage key for a running session: `opendsp-4x4.tuning-session`.

## File structure

| File | Responsibility |
|---|---|
| `web/src/state/history.ts` (modify) | Undo groups: `beginGroup` / `endGroup` / `grouping` |
| `web/src/state/editor.ts` (modify) | Expose groups |
| `web/src/state/device.svelte.ts` (modify) | Expose groups, public `applyGroup`, no undo while grouping |
| `web/src/state/storage.ts` (create) | `browserStorage()` shared by the stores |
| `web/src/setup/alignment.ts` (create) | Alignment types and pure math |
| `web/src/setup/recipe.ts` (modify) | Recipe v2: alignment fields, defaults, validation, repair, upgrade, `rigOf` |
| `web/src/setup/library.ts` (modify) | Upgrade version 1 data on load and import |
| `web/src/setup/tuning.ts` (create) | Tuning steps, tone, assignments, blocker, saved snapshot |
| `web/src/ui/units.ts` (create) | m/ft and C/F conversions |
| `web/src/setup/bandColour.ts` (create) | Band colour shared by `LayoutCard` and the diagram |
| `web/src/setup/AlignmentDiagram.svelte` (create) | SVG side view |
| `web/src/setup/AlignmentSection.svelte` (create) | The whole Time alignment section |
| `web/src/setup/tuning.svelte.ts` (create) | Session store running against the device |
| `web/src/setup/TuningPanel.svelte` (create) | Tuning UI and interrupted-session notice |
| `web/src/views/SetupView.svelte` (modify) | Uses `AlignmentSection` |

---

### Task 1: Undo groups

**Files:**
- Modify: `web/src/state/history.ts`
- Modify: `web/src/state/editor.ts:66-118`
- Modify: `web/src/state/device.svelte.ts:157-167,239-242`
- Test: `web/test/state.test.ts` (history and editor sections)

**Interfaces:**
- Produces: `History.beginGroup(label: string): void`, `History.endGroup(): void`, `History.grouping: boolean`, `HistoryOptions<V>.same?: (a: V, b: V) => boolean`; `Editor.beginGroup(label)`, `Editor.endGroup()`, `Editor.grouping`; `device.beginGroup(label)`, `device.endGroup()`, `device.applyGroup(label: string, assignments: ParamAssignment[]): void` (now public).

- [ ] **Step 1: Write the failing tests**

In `web/test/state.test.ts`, after the test `"a new edit clears the redo stack"`, add:

```ts
test("a history group is one entry across time and keys; ending it drops changes that came back", () => {
  let now = 0;
  const history = new History<number>({ now: () => now, mergeWindowMs: 500 });
  history.record("before", [{ key: "x", before: 0, after: 1 }]);
  history.beginGroup("session");
  assert.equal(history.grouping, true);
  history.record("mute", [{ key: "m", before: 0, after: 1 }], "m");
  now = 5000;
  history.record("delay", [{ key: "d", before: 0, after: 2 }]);
  history.record("delay", [{ key: "d", before: 2, after: 3 }], "d");
  history.record("unmute", [{ key: "m", before: 1, after: 0 }]);
  history.endGroup();
  assert.equal(history.grouping, false);
  const entry = history.undo()!;
  assert.equal(entry.label, "session");
  assert.deepEqual(entry.changes, [{ key: "d", before: 0, after: 3 }]);
  assert.equal(history.undo()!.label, "before");
});

test("a group that ends where it started leaves no entry; undo ends a group", () => {
  const history = new History<number>();
  history.beginGroup("cancelled");
  history.record("a", [{ key: "a", before: 0, after: 1 }]);
  history.record("a", [{ key: "a", before: 1, after: 0 }]);
  history.endGroup();
  assert.equal(history.undoLabel, null);
  history.beginGroup("open");
  history.record("b", [{ key: "b", before: 0, after: 1 }]);
  history.undo();
  assert.equal(history.grouping, false);
  history.record("c", [{ key: "c", before: 0, after: 1 }]);
  assert.equal(history.undoLabel, "c");
});
```

After the test `"undo and redo restore the value on the device"`, add:

```ts
test("an editor group is one undo step with its label", async () => {
  const { state, editor } = await editorWithDevice();
  editor.beginGroup("Fine-tune Sub ↔ Top L");
  await editor.setMany("Tuning", [{ ref: { kind: "mute", ch: OUT2 }, value: true }, { ref: { kind: "polarity", ch: OUT1 }, value: true }]);
  await editor.setMany("Tuning", [{ ref: { kind: "delay", ch: OUT1 }, value: 2 }]);
  await editor.setMany("Tuning", [{ ref: { kind: "mute", ch: OUT2 }, value: false }, { ref: { kind: "polarity", ch: OUT1 }, value: false }]);
  editor.endGroup();
  assert.equal(editor.grouping, false);
  assert.equal(state.undoLabel, "Fine-tune Sub ↔ Top L");
  await editor.undo();
  assert.equal(state.model.channels[OUT1]!.delayMs, 0);
  assert.equal(state.undoLabel, null);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd web && node --experimental-strip-types --test test/state.test.ts`
Expected: FAIL, `history.beginGroup is not a function`.

- [ ] **Step 3: Implement groups in `History`**

Replace `web/src/state/history.ts` from `export interface HistoryOptions {` to the end with:

```ts
export interface HistoryOptions<V> {
  limit?: number;
  mergeWindowMs?: number;
  now?: () => number;
  /** Value equality; when a group ends, its changes that came back to their start are dropped. */
  same?: (a: V, b: V) => boolean;
}

const DEFAULT_LIMIT = 200;
const DEFAULT_MERGE_WINDOW_MS = 1000;

export class History<V> {
  private readonly undoStack: HistoryEntry<V>[] = [];
  private readonly redoStack: HistoryEntry<V>[] = [];
  private readonly limit: number;
  private readonly mergeWindowMs: number;
  private readonly now: () => number;
  private readonly same: (a: V, b: V) => boolean;
  private sealed = true;
  private group: { label: string; entry: HistoryEntry<V> | null } | null = null;

  constructor(options: HistoryOptions<V> = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.mergeWindowMs = options.mergeWindowMs ?? DEFAULT_MERGE_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.same = options.same ?? ((a, b) => Object.is(a, b));
  }

  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  get grouping(): boolean {
    return this.group !== null;
  }

  /** Until endGroup(), every record joins one entry with this label, whatever its merge key or timing. */
  beginGroup(label: string): void {
    this.group = { label, entry: null };
    this.sealed = true;
  }

  /** Close the group: changes back at their start value are dropped, an entry left empty is removed. */
  endGroup(): void {
    const entry = this.group?.entry ?? null;
    this.group = null;
    this.sealed = true;
    if (!entry) return;
    entry.changes = entry.changes.filter((change) => !this.same(change.before, change.after));
    if (entry.changes.length === 0 && this.undoStack[this.undoStack.length - 1] === entry) this.undoStack.pop();
  }

  /** Record changes. With a mergeKey, extends the previous entry if it is the same ongoing edit. */
  record(label: string, changes: Change<V>[], mergeKey?: string): void {
    if (changes.length === 0) return;
    const at = this.now();
    this.redoStack.length = 0;
    if (this.group) {
      if (this.group.entry) this.merge(this.group.entry, changes, at);
      else this.group.entry = this.push({ label: this.group.label, changes: [...changes], lastAt: at });
      return;
    }
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && !this.sealed && mergeKey !== undefined && top.mergeKey === mergeKey && at - top.lastAt <= this.mergeWindowMs) {
      this.merge(top, changes, at);
      return;
    }
    this.push({ label, changes, mergeKey, lastAt: at });
    this.sealed = mergeKey === undefined;
  }

  /** End the current gesture: the next edit starts a new entry even within the merge window. */
  seal(): void {
    this.sealed = true;
  }

  /** Undo and redo end an open group. */
  undo(): HistoryEntry<V> | undefined {
    this.group = null;
    const entry = this.undoStack.pop();
    if (entry) this.redoStack.push(entry);
    this.sealed = true;
    return entry;
  }

  redo(): HistoryEntry<V> | undefined {
    this.group = null;
    const entry = this.redoStack.pop();
    if (entry) this.undoStack.push(entry);
    this.sealed = true;
    return entry;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.group = null;
    this.sealed = true;
  }

  private push(entry: HistoryEntry<V>): HistoryEntry<V> {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    return entry;
  }

  private merge(entry: HistoryEntry<V>, changes: Change<V>[], at: number): void {
    for (const change of changes) {
      const existing = entry.changes.find((c) => c.key === change.key);
      if (existing) existing.after = change.after;
      else entry.changes.push(change);
    }
    entry.lastAt = at;
  }
}
```

- [ ] **Step 4: Expose groups in `Editor`**

In `web/src/state/editor.ts`, change the constructor line:

```ts
    this.history = new History<Value>({ now: deps.now, same: sameValue });
```

and add after `seal()`:

```ts
  /** Edits until endGroup() form one undo step with this label (a guided session). */
  beginGroup(label: string): void {
    this.history.beginGroup(label);
  }

  endGroup(): void {
    this.history.endGroup();
    this.refreshLabels();
  }

  get grouping(): boolean {
    return this.history.grouping;
  }
```

- [ ] **Step 5: Expose groups in `device`**

In `web/src/state/device.svelte.ts`, replace `undo()` and `redo()` with:

```ts
  undo(): void {
    if (this.editor.grouping) return; // a guided session is one step, ended by its Done or Cancel
    this.clearSolo();
    void this.editor.undo();
  }
  redo(): void {
    if (this.editor.grouping) return;
    this.clearSolo();
    void this.editor.redo();
  }
  /** Edits until endGroup() form one undo step with this label. */
  beginGroup(label: string): void { this.editor.beginGroup(label); }
  endGroup(): void { this.editor.endGroup(); }
```

and make `applyGroup` public:

```ts
  /** Several edits as one undo step (inside a group, part of the group's step). */
  applyGroup(label: string, assignments: ParamAssignment[]): void {
    this.guard(label, () => this.editor.setMany(label, assignments));
    this.editor.seal();
  }
```

- [ ] **Step 6: Run tests and typecheck**

Run: `cd web && npm test && npm run typecheck`
Expected: all tests PASS (the 3 new ones included); `svelte-check found 0 errors and 0 warnings`.

- [ ] **Step 7: Commit**

```bash
git add web/src/state/history.ts web/src/state/editor.ts web/src/state/device.svelte.ts web/test/state.test.ts
git commit -m "feat(web): undo groups for guided sessions"
```

---

### Task 2: Alignment math

**Files:**
- Create: `web/src/setup/alignment.ts`
- Test: `web/test/alignment.test.ts`

**Interfaces:**
- Consumes: `OutputSlot` (type) from `web/src/setup/recipe.ts`.
- Produces (all exported from `alignment.ts`): types `AlignmentMode`, `SpeakerPosition`, `Crowd`, `PerOutput<T>`, `Alignment`, `Rig`, `CouplingState`, `CoverageSample`, `Coverage`, `BandPair`; constants `ADDS_MAX_DEG = 90`, `COUPLED_MAX_DEG = 120`, `SAMPLE_STEP_M = 0.1`; functions `speedOfSound(tempC)`, `pathLengthM(speaker, pointM, earHeightM)`, `crowdSamplesM(crowd): number[]`, `bandPairs(rig): BandPair[]`, `couplingState(phaseDeg)`, `geometricDelaysMs(rig, pointM): (number | null)[]`, `coverage(rig, pointM): Coverage | null`, `suggestedPointM(rig): number | null`, `effectivePointM(rig): number`, `outputDelaysMs(rig): (number | null)[]`.

- [ ] **Step 1: Write the failing tests**

Create `web/test/alignment.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd web && node --experimental-strip-types --test test/alignment.test.ts`
Expected: FAIL, cannot find module `../src/setup/alignment.ts`.

- [ ] **Step 3: Implement `alignment.ts`**

Create `web/src/setup/alignment.ts`:

```ts
// Time alignment geometry: the path from each speaker to the ears, the delays that line
// the arrivals up at one alignment point, and how well neighbouring bands add up across
// the crowd at their crossover. Pure functions over a Rig (a recipe's layout, crossovers
// and alignment), shared by recipe.ts, the tuning and the Setup view.
import type { OutputSlot } from "./recipe.ts";

export type AlignmentMode = "positions" | "direct";
export type PerOutput<T> = [T, T, T, T];

export interface SpeakerPosition {
  /** Distance from the stage edge toward the crowd; negative = behind the edge. */
  xM: number;
  /** Height of the acoustic centre above the floor. */
  heightM: number;
}

export interface Crowd {
  /** From the stage edge. */
  startM: number;
  endM: number;
  earHeightM: number;
}

/** Per-output arrays are indexed by output (Out 1 to Out 4); spare outputs are ignored. */
export interface Alignment {
  enabled: boolean;
  tempC: number;
  mode: AlignmentMode;
  /** Direct mode: straight distance from the listening spot to each speaker. */
  distancesM: PerOutput<number>;
  speakers: PerOutput<SpeakerPosition>;
  crowd: Crowd;
  /** Alignment point (distance from the stage edge); null = the suggested point. */
  pointM: number | null;
  /** By-ear fine-tune offsets added to the geometric delays. */
  offsetsMs: PerOutput<number>;
}

/** What the alignment math needs from a recipe. */
export interface Rig {
  /** Out 1 to Out 4; null = spare. */
  outputs: readonly (OutputSlot | null)[];
  crossoversHz: readonly number[];
  alignment: Alignment;
}

export type CouplingState = "adds" | "weak" | "cancels";

export interface CoverageSample {
  xM: number;
  worstPhaseDeg: number;
  state: CouplingState;
}

export interface Coverage {
  samples: CoverageSample[];
  /** Length of crowd at "adds" or "weak". */
  coupledM: number;
  totalM: number;
}

/** Output indexes (0 to 3) of two neighbouring bands and the crossover between them. */
export interface BandPair {
  lower: number;
  upper: number;
  crossoverHz: number;
}

/** Within 3 dB of full summation. */
export const ADDS_MAX_DEG = 90;
/** Beyond this the two bands no longer reinforce each other. */
export const COUPLED_MAX_DEG = 120;
export const SAMPLE_STEP_M = 0.1;
/** Keeps a very deep crowd fast to evaluate (the suggestion is quadratic in samples). */
const MAX_SAMPLES = 501;

/** Speed of sound in air (m/s) at a temperature in degrees Celsius. */
export function speedOfSound(tempC: number): number {
  return 331.3 + 0.606 * tempC;
}

export function pathLengthM(speaker: SpeakerPosition, pointM: number, earHeightM: number): number {
  return Math.hypot(pointM - speaker.xM, speaker.heightM - earHeightM);
}

const usedIndexes = (rig: Rig): number[] => rig.outputs.flatMap((output, index) => (output ? [index] : []));

/** Delays (ms) that make every path arrive with the longest one. */
function delaysForPaths(pathsM: number[], speed: number): number[] {
  const longest = Math.max(...pathsM);
  return pathsM.map((path) => ((longest - path) / speed) * 1000);
}

/** Per-output list from values of the used outputs (in output order); null for spares. */
function byOutput(rig: Rig, used: number[], values: number[]): (number | null)[] {
  return rig.outputs.map((_, index) => {
    const position = used.indexOf(index);
    return position < 0 ? null : values[position]!;
  });
}

/** Crowd positions from start to end in even steps of SAMPLE_STEP_M (larger beyond MAX_SAMPLES). */
export function crowdSamplesM(crowd: Crowd): number[] {
  const length = Math.max(0, crowd.endM - crowd.startM);
  const count = Math.min(MAX_SAMPLES, Math.floor(length / SAMPLE_STEP_M + 1e-9) + 1);
  if (count <= 1) return [crowd.startM];
  const step = length / (count - 1);
  return Array.from({ length: count }, (_, i) => crowd.startM + i * step);
}

/** Every used output of each band with every used output of the band above, at their crossover. */
export function bandPairs(rig: Rig): BandPair[] {
  const used = usedIndexes(rig);
  return rig.crossoversHz.flatMap((crossoverHz, k) => {
    const lowers = used.filter((index) => rig.outputs[index]!.band === k);
    const uppers = used.filter((index) => rig.outputs[index]!.band === k + 1);
    return lowers.flatMap((lower) => uppers.map((upper) => ({ lower, upper, crossoverHz })));
  });
}

export function couplingState(phaseDeg: number): CouplingState {
  const size = Math.abs(phaseDeg);
  if (size <= ADDS_MAX_DEG) return "adds";
  if (size <= COUPLED_MAX_DEG) return "weak";
  return "cancels";
}

/** Geometric delay per output (ms) aligning every used output at pointM; null for spares. */
export function geometricDelaysMs(rig: Rig, pointM: number): (number | null)[] {
  const { speakers, crowd, tempC } = rig.alignment;
  const used = usedIndexes(rig);
  const paths = used.map((index) => pathLengthM(speakers[index]!, pointM, crowd.earHeightM));
  return byOutput(rig, used, delaysForPaths(paths, speedOfSound(tempC)));
}

/** Per pair, at each position: lower path minus upper path (m). */
function pairDifferencesM(rig: Rig, pairs: BandPair[], positionsM: number[]): number[][] {
  const { speakers, crowd } = rig.alignment;
  const path = (index: number, xM: number) => pathLengthM(speakers[index]!, xM, crowd.earHeightM);
  return pairs.map(({ lower, upper }) => positionsM.map((xM) => path(lower, xM) - path(upper, xM)));
}

/** Worst |phase| (degrees) over all pairs at each of the first `count` positions, with the delays aligned at position `at`. */
function worstPhasesDeg(pairs: BandPair[], differences: number[][], at: number, count: number, speed: number): number[] {
  const phases = new Array<number>(count).fill(0);
  pairs.forEach((pair, p) => {
    const row = differences[p]!;
    const degreesPerMetre = (360 * pair.crossoverHz) / speed;
    for (let i = 0; i < count; i++) phases[i] = Math.max(phases[i]!, Math.abs((row[i]! - row[at]!) * degreesPerMetre));
  });
  return phases;
}

/**
 * How the bands add up across the crowd with the geometric delays aligned at pointM
 * (offsets are left out: they cancel the cabinets' own delay). Null without a crossover.
 */
export function coverage(rig: Rig, pointM: number): Coverage | null {
  const pairs = bandPairs(rig);
  if (pairs.length === 0) return null;
  const { crowd, tempC } = rig.alignment;
  const positions = crowdSamplesM(crowd);
  const differences = pairDifferencesM(rig, pairs, [...positions, pointM]);
  const phases = worstPhasesDeg(pairs, differences, positions.length, positions.length, speedOfSound(tempC));
  const samples = positions.map((xM, i) => ({ xM, worstPhaseDeg: phases[i]!, state: couplingState(phases[i]!) }));
  const totalM = Math.max(0, crowd.endM - crowd.startM);
  const coupled = samples.filter((sample) => sample.state !== "cancels").length;
  return { samples, coupledM: (totalM * coupled) / samples.length, totalM };
}

/** The crowd position that, as alignment point, keeps the most crowd coupled; ties go to the middle. Null without a crossover. */
export function suggestedPointM(rig: Rig): number | null {
  const pairs = bandPairs(rig);
  if (pairs.length === 0) return null;
  const { crowd, tempC } = rig.alignment;
  const positions = crowdSamplesM(crowd);
  const differences = pairDifferencesM(rig, pairs, positions);
  const speed = speedOfSound(tempC);
  const middle = (crowd.startM + Math.max(crowd.startM, crowd.endM)) / 2;
  let best = positions[0]!;
  let bestCount = -1;
  positions.forEach((xM, at) => {
    const count = worstPhasesDeg(pairs, differences, at, positions.length, speed).filter((deg) => deg <= COUPLED_MAX_DEG).length;
    if (count > bestCount || (count === bestCount && Math.abs(xM - middle) < Math.abs(best - middle))) {
      best = xM;
      bestCount = count;
    }
  });
  return best;
}

/** The alignment point in use: the chosen one kept inside the crowd, else the suggestion, else the middle. */
export function effectivePointM(rig: Rig): number {
  const { crowd, pointM } = rig.alignment;
  const end = Math.max(crowd.startM, crowd.endM);
  if (pointM !== null) return Math.min(end, Math.max(crowd.startM, pointM));
  return suggestedPointM(rig) ?? (crowd.startM + end) / 2;
}

/** Delay per output (ms): geometric or direct-distance delay plus the offset, shifted so the smallest is 0; null for spares. */
export function outputDelaysMs(rig: Rig): (number | null)[] {
  const { mode, distancesM, offsetsMs, tempC } = rig.alignment;
  const used = usedIndexes(rig);
  const base = mode === "positions"
    ? geometricDelaysMs(rig, effectivePointM(rig))
    : byOutput(rig, used, delaysForPaths(used.map((index) => distancesM[index]!), speedOfSound(tempC)));
  const raw = used.map((index) => base[index]! + offsetsMs[index]!);
  const lowest = Math.min(...raw);
  return byOutput(rig, used, raw.map((delay) => delay - lowest));
}
```

- [ ] **Step 4: Run the tests**

Run: `cd web && node --experimental-strip-types --test test/alignment.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Typecheck**

Run: `cd web && npm run typecheck`
Expected: 0 errors, 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add web/src/setup/alignment.ts web/test/alignment.test.ts
git commit -m "feat(web): alignment geometry, coverage and suggested point"
```

---

### Task 3: Recipe version 2

**Files:**
- Modify: `web/src/setup/recipe.ts`
- Modify: `web/src/setup/library.ts:74-136`
- Test: `web/test/recipe.test.ts`, `web/test/build.test.ts:121-129`, `web/test/library.test.ts`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: `RECIPE_VERSION = 2`; `Recipe.alignment: Alignment`; ranges `POSITION_RANGE`, `HEIGHT_RANGE`, `CROWD_RANGE`, `EAR_HEIGHT_RANGE`, `OFFSET_RANGE` (all `Range`), `MIN_CROWD_DEPTH_M = 1`; `defaultSpeakers(layout: LayoutId): PerOutput<SpeakerPosition>`; `defaultAlignment(layout: LayoutId): Alignment`; `rigOf(recipe: Recipe): Rig`; `alignmentDelaysMs(recipe: Recipe)` (same name and result type as before); `upgradeRecipe(raw: unknown): unknown`. `speedOfSound` is no longer exported by `recipe.ts` (it lives in `alignment.ts`).

- [ ] **Step 1: Update the existing tests to the version 2 shape**

In `web/test/recipe.test.ts`:

Replace the import block with:

```ts
import {
  LAYOUTS, LAYOUT_IDS, alignmentDelaysMs, checkRecipe, coerceRecipe, defaultRecipe, layoutRoles, spareOutputs,
  upgradeRecipe, usedOutputs, withEnvironment, withLayout, type Recipe,
} from "../src/setup/recipe.ts";
import { speedOfSound } from "../src/setup/alignment.ts";
```

In `"time alignment delays the nearer speakers relative to the farthest one"` replace the `r.alignment = ...` line with:

```ts
    r.alignment = { ...r.alignment, enabled: true, tempC: 20, mode: "direct", distancesM: [10, 10, 6.57, 99] };
```

In `"structure problems: ..."` replace `version: 2` with `version: 3`. In `"coerceRecipe keeps values, ..."` replace `version: 2` with `version: 3`, and replace

```ts
  assert.deepEqual(repaired.alignment, defaultRecipe().alignment);
```

with

```ts
  assert.deepEqual(repaired.alignment, defaultRecipe("2.2").alignment);
```

In `"trims, shelves, distances and the 680 ms delay limit"` replace the two alignment assertions with:

```ts
  const direct = (distancesM: Recipe["alignment"]["distancesM"], offsetsMs: Recipe["alignment"]["offsetsMs"] = [0, 0, 0, 0]) =>
    fieldsOf(recipeWith((r) => { r.alignment = { ...r.alignment, enabled: true, tempC: 20, mode: "direct", distancesM, offsetsMs }; }));
  assert.deepEqual(direct([0, 0, 300, 0]), ["alignment.distancesM.2"]);
  assert.deepEqual(direct([250, 0, 1, 0]), ["alignment.delay"], "250 m of difference is about 728 ms");
  assert.deepEqual(direct([230, 230, 0, 0]), [], "about 670 ms");
  assert.deepEqual(direct([230, 230, 0, 0], [0, 0, 15, 0]), ["alignment.delay"], "the offset counts");
```

In `web/test/build.test.ts` `"delay only with time alignment on"`, replace the `r.alignment = ...` line with:

```ts
    r.alignment = { ...r.alignment, enabled: true, tempC: 20, mode: "direct", distancesM: [10, 10, 6.5658, 0] };
```

- [ ] **Step 2: Add the new recipe tests**

Append to `web/test/recipe.test.ts`:

```ts
test("new recipes use positions with default heights by speaker kind; a layout change resets positions", () => {
  const alignment = defaultRecipe("top-kick-sub").alignment;
  assert.equal(alignment.mode, "positions");
  assert.deepEqual(alignment.speakers.map((s) => s.heightM), [2, 2, 0.6, 0.4]);
  assert.deepEqual(alignment.speakers.map((s) => s.xM), [0, 0, 0, 0]);
  assert.deepEqual(alignment.crowd, { startM: 2, endM: 20, earHeightM: 1.7 });
  assert.equal(alignment.pointM, null);
  assert.deepEqual(alignment.offsetsMs, [0, 0, 0, 0]);
  const moved = withLayout(recipeWith((r) => {
    r.alignment.offsetsMs = [1, 1, 1, 1];
    r.alignment.crowd.endM = 30;
  }), "4way");
  assert.deepEqual(moved.alignment.speakers.map((s) => s.heightM), [0.4, 1.5, 1.5, 1.5]);
  assert.deepEqual(moved.alignment.offsetsMs, [0, 0, 0, 0]);
  assert.equal(moved.alignment.crowd.endM, 30);
});

test("positions validation: speakers, crowd depth, point inside the crowd, offsets", () => {
  const on = (patch: (alignment: Recipe["alignment"]) => void) => fieldsOf(recipeWith((r) => {
    r.alignment.enabled = true;
    patch(r.alignment);
  }));
  assert.deepEqual(on(() => {}), []);
  assert.deepEqual(on((a) => { a.speakers[2].heightM = 31; }), ["alignment.speakers.2.heightM"]);
  assert.deepEqual(on((a) => { a.speakers[0].xM = -60; }), ["alignment.speakers.0.xM"]);
  assert.deepEqual(on((a) => { a.speakers[3].heightM = 99; }), [], "a spare output is ignored");
  assert.deepEqual(on((a) => { a.crowd.endM = 2.5; }), ["alignment.crowd.endM"]);
  assert.deepEqual(on((a) => { a.crowd.earHeightM = 3; }), ["alignment.crowd.earHeightM"]);
  assert.deepEqual(on((a) => { a.pointM = 25; }), ["alignment.pointM"]);
  assert.deepEqual(on((a) => { a.pointM = 8; }), []);
  assert.deepEqual(on((a) => { a.offsetsMs[2] = 21; }), ["alignment.offsetsMs.2"]);
  assert.deepEqual(on((a) => { a.mode = "direct"; a.speakers[2].heightM = 31; }), [], "positions are not checked in direct mode");
  assert.deepEqual(fieldsOf(recipeWith((r) => { (r.alignment as { mode: string }).mode = "laser"; })), ["alignment"]);
  assert.deepEqual(fieldsOf(recipeWith((r) => { (r.alignment.speakers[1] as { xM: unknown }).xM = "far"; })), ["alignment.speakers.1.xM"]);
});

test("a version 1 recipe upgrades to direct mode with the same delays", () => {
  const v1 = { ...defaultRecipe("2.1"), version: 1, alignment: { enabled: true, tempC: 20, distancesM: [10, 10, 6.57, 0] } };
  const upgraded = upgradeRecipe(v1);
  assert.deepEqual(checkRecipe(upgraded), []);
  const recipe = coerceRecipe(upgraded)!;
  assert.equal(recipe.version, 2);
  assert.equal(recipe.alignment.mode, "direct");
  assert.deepEqual(recipe.alignment.distancesM, [10, 10, 6.57, 0]);
  assert.deepEqual(recipe.alignment.offsetsMs, [0, 0, 0, 0]);
  assert.deepEqual(recipe.alignment.speakers, defaultRecipe("2.1").alignment.speakers);
  assert.ok(Math.abs(alignmentDelaysMs(recipe)[2]! - 10) < 0.02);
  assert.equal(upgradeRecipe("x"), "x");
  assert.deepEqual(upgradeRecipe(defaultRecipe()), defaultRecipe(), "version 2 is unchanged");
});

test("coerceRecipe repairs each alignment field on its own", () => {
  const raw = { ...defaultRecipe(), alignment: { ...defaultRecipe().alignment, speakers: "x", pointM: "far", mode: "laser", offsetsMs: [1, "a", 2, 3] } };
  const alignment = coerceRecipe(raw)!.alignment;
  assert.deepEqual(alignment.speakers, defaultRecipe().alignment.speakers);
  assert.equal(alignment.pointM, null);
  assert.equal(alignment.mode, "positions");
  assert.deepEqual(alignment.offsetsMs, [1, 0, 2, 3]);
});
```

- [ ] **Step 3: Add the library test**

Append to `web/test/library.test.ts`:

```ts
test("a version 1 setup (file, stored preset, draft) loads in direct mode", () => {
  const v1 = { ...defaultRecipe("2.1"), version: 1, alignment: { enabled: true, tempC: 20, distancesM: [10, 10, 6.57, 0] } };
  const file = JSON.stringify({ format: "opendsp-4x4/setup", version: 1, name: "Old", recipe: v1 });
  assert.equal(parseSetupFile(file).recipe.alignment.mode, "direct");
  const storage = new MemoryStorage();
  storage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify([{ id: "custom:1", name: "Old", recipe: v1 }]));
  assert.equal(loadCustomPresets(storage)[0]?.recipe.alignment.mode, "direct");
  storage.setItem(DRAFT_KEY, JSON.stringify(v1));
  assert.deepEqual(loadDraft(storage)?.alignment.distancesM, [10, 10, 6.57, 0]);
});
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `cd web && npm test`
Expected: FAIL in `recipe.test.ts` (`upgradeRecipe` is not exported), `library.test.ts` and `build.test.ts`.

- [ ] **Step 5: Implement version 2 in `recipe.ts`**

In `web/src/setup/recipe.ts`:

1. Imports: below the existing imports add

```ts
import { outputDelaysMs, type Alignment, type AlignmentMode, type PerOutput, type Rig, type SpeakerPosition } from "./alignment.ts";
```

2. `export const RECIPE_VERSION = 2;`

3. In `interface Recipe` replace the `distancesM` comment and the `alignment` line with:

```ts
  alignment: Alignment;
```

4. After `export const DISTANCE_RANGE ...` add:

```ts
export const POSITION_RANGE: Range = { min: -50, max: 250, unit: "m" };
export const HEIGHT_RANGE: Range = { min: 0, max: 30, unit: "m" };
export const CROWD_RANGE: Range = { min: 0, max: 250, unit: "m" };
export const EAR_HEIGHT_RANGE: Range = { min: 0.5, max: 2.5, unit: "m" };
export const OFFSET_RANGE: Range = { min: -20, max: 20, unit: "ms" };
export const MIN_CROWD_DEPTH_M = 1;
export const ALIGNMENT_MODES: readonly AlignmentMode[] = ["positions", "direct"];
```

5. After `const DEFAULT_TEMP_C = 20;` add:

```ts
/** Usual height of the acoustic centre by speaker kind. */
const DEFAULT_HEIGHT_M: Readonly<Record<Role, number>> = {
  sub: 0.4, kick: 0.6, top: 2, main: 2, fill: 1.5, low: 1.5, mid: 1.5, high: 1.5,
};
const SPARE_HEIGHT_M = 1.5;
const DEFAULT_CROWD = { startM: 2, endM: 20, earHeightM: 1.7 };
```

6. Replace the `alignment:` line of `defaultRecipe` with `alignment: defaultAlignment(layout),` and add after `defaultRecipe`:

```ts
/** Every speaker at the stage edge, at the usual height of its kind. */
export function defaultSpeakers(layout: LayoutId): PerOutput<SpeakerPosition> {
  return LAYOUTS[layout].outputs.map((output) => ({
    xM: 0,
    heightM: output ? DEFAULT_HEIGHT_M[output.role] : SPARE_HEIGHT_M,
  })) as PerOutput<SpeakerPosition>;
}

export function defaultAlignment(layout: LayoutId): Alignment {
  return {
    enabled: false,
    tempC: DEFAULT_TEMP_C,
    mode: "positions",
    distancesM: [0, 0, 0, 0],
    speakers: defaultSpeakers(layout),
    crowd: { ...DEFAULT_CROWD },
    pointM: null,
    offsetsMs: [0, 0, 0, 0],
  };
}
```

7. Replace `withLayout` with:

```ts
/** Another layout: its default crossovers and speaker positions (offsets cleared), every other field kept. */
export function withLayout(recipe: Recipe, layout: LayoutId): Recipe {
  const next = copy(recipe);
  return {
    ...next,
    layout,
    crossoversHz: [...LAYOUTS[layout].crossoversHz],
    alignment: { ...next.alignment, speakers: defaultSpeakers(layout), offsetsMs: [0, 0, 0, 0] },
  };
}
```

8. Replace `speedOfSound` and `alignmentDelaysMs` with:

```ts
/** The parts of a recipe the alignment math uses. */
export function rigOf(recipe: Recipe): Rig {
  return { outputs: LAYOUTS[recipe.layout].outputs, crossoversHz: recipe.crossoversHz, alignment: recipe.alignment };
}

/** Delay per output (ms) of the time alignment, offsets included; null for spare outputs. */
export function alignmentDelaysMs(recipe: Recipe): (number | null)[] {
  return outputDelaysMs(rigOf(recipe));
}
```

9. Replace `checkAlignment` with:

```ts
const isPerOutput = (value: unknown): value is unknown[] => Array.isArray(value) && value.length === OUTPUT_COUNT;

function hasAlignmentShape(value: unknown): value is Record<string, unknown> {
  return isObject(value) && typeof value.enabled === "boolean" && (ALIGNMENT_MODES as unknown[]).includes(value.mode)
    && isPerOutput(value.distancesM) && isPerOutput(value.offsetsMs)
    && isPerOutput(value.speakers) && value.speakers.every(isObject)
    && isObject(value.crowd) && "pointM" in value;
}

function checkAlignment(value: unknown, recipe: Record<string, unknown>, layout: Layout | null, report: Report): void {
  if (!hasAlignmentShape(value)) {
    report("alignment", "The time alignment settings are invalid");
    return;
  }
  const on = value.enabled as boolean;
  let valid = true;
  const checkNumber = (field: string, entry: unknown, name: string, range: Range, checkRange: boolean): void => {
    if (!isNumber(entry)) {
      report(field, `${name} must be a number`);
      valid = false;
    } else if (checkRange && !inRange(entry, range)) {
      report(field, `${name} must be ${between(range)}`);
      valid = false;
    }
  };
  const indexes = layout ? usedOutputs(layout).map((output) => output.index) : [0, 1, 2, 3];
  checkNumber("alignment.tempC", value.tempC, "The temperature", TEMPERATURE_RANGE, on);
  if (value.mode === "direct") {
    const distances = value.distancesM as unknown[];
    for (const i of indexes) checkNumber(`alignment.distancesM.${i}`, distances[i], `The distance of Out ${i + 1}`, DISTANCE_RANGE, on);
  } else {
    const speakers = value.speakers as Record<string, unknown>[];
    for (const i of indexes) {
      checkNumber(`alignment.speakers.${i}.xM`, speakers[i]!.xM, `The position of Out ${i + 1}`, POSITION_RANGE, on);
      checkNumber(`alignment.speakers.${i}.heightM`, speakers[i]!.heightM, `The height of Out ${i + 1}`, HEIGHT_RANGE, on);
    }
    const crowd = value.crowd as Record<string, unknown>;
    checkNumber("alignment.crowd.startM", crowd.startM, "The start of the crowd", CROWD_RANGE, on);
    checkNumber("alignment.crowd.endM", crowd.endM, "The end of the crowd", CROWD_RANGE, on);
    checkNumber("alignment.crowd.earHeightM", crowd.earHeightM, "The ear height", EAR_HEIGHT_RANGE, on);
    const startM = crowd.startM as number;
    const endM = crowd.endM as number;
    if (valid && on && endM < startM + MIN_CROWD_DEPTH_M - EPSILON) {
      report("alignment.crowd.endM", `The crowd must end at least ${MIN_CROWD_DEPTH_M} m after it starts`);
      valid = false;
    }
    if (value.pointM !== null) {
      checkNumber("alignment.pointM", value.pointM, "The alignment point", CROWD_RANGE, false);
      const pointM = value.pointM as number;
      if (valid && on && (pointM < startM - EPSILON || pointM > endM + EPSILON)) {
        report("alignment.pointM", "The alignment point must be inside the crowd area");
        valid = false;
      }
    }
  }
  const offsets = value.offsetsMs as unknown[];
  for (const i of indexes) checkNumber(`alignment.offsetsMs.${i}`, offsets[i], `The fine-tune offset of Out ${i + 1}`, OFFSET_RANGE, on);
  if (!on || !valid || !layout) return;
  const crossovers = Array.isArray(recipe.crossoversHz) && recipe.crossoversHz.every(isNumber) && recipe.crossoversHz.length === layout.crossoversHz.length
    ? (recipe.crossoversHz as number[])
    : [...layout.crossoversHz];
  const delays = outputDelaysMs({ outputs: layout.outputs, crossoversHz: crossovers, alignment: value as unknown as Alignment });
  const longest = Math.max(...delays.map((delay) => delay ?? 0));
  if (longest > DELAY_RANGE.max + EPSILON) {
    report("alignment.delay", `The speakers are too far apart: the nearest one would need ${longest.toFixed(0)} ms of delay (at most ${DELAY_RANGE.max.toFixed(0)} ms)`);
  }
}
```

10. In the repair section, add before `coerceRecipe`:

```ts
function perOutputNumbers(value: unknown, fallback: PerOutput<number>): PerOutput<number> {
  if (!Array.isArray(value) || value.length !== OUTPUT_COUNT) return [...fallback] as PerOutput<number>;
  return value.map((entry: unknown, i) => numberOr(entry, fallback[i]!)) as PerOutput<number>;
}

function coerceAlignment(raw: unknown, layout: LayoutId): Alignment {
  const base = defaultAlignment(layout);
  if (!isObject(raw)) return base;
  const speakers = Array.isArray(raw.speakers) && raw.speakers.length === OUTPUT_COUNT
    ? raw.speakers.map((entry: unknown, i) => {
      const fallback = base.speakers[i]!;
      return isObject(entry) ? { xM: numberOr(entry.xM, fallback.xM), heightM: numberOr(entry.heightM, fallback.heightM) } : { ...fallback };
    }) as PerOutput<SpeakerPosition>
    : base.speakers;
  const crowd = isObject(raw.crowd) ? raw.crowd : {};
  return {
    enabled: booleanOr(raw.enabled, false),
    tempC: numberOr(raw.tempC, base.tempC),
    mode: pick(raw.mode, ALIGNMENT_MODES, base.mode),
    distancesM: perOutputNumbers(raw.distancesM, base.distancesM),
    speakers,
    crowd: {
      startM: numberOr(crowd.startM, base.crowd.startM),
      endM: numberOr(crowd.endM, base.crowd.endM),
      earHeightM: numberOr(crowd.earHeightM, base.crowd.earHeightM),
    },
    pointM: isNumber(raw.pointM) ? raw.pointM : null,
    offsetsMs: perOutputNumbers(raw.offsetsMs, base.offsetsMs),
  };
}
```

In `coerceRecipe`, delete the `const alignment = ...` statement and replace the `alignment: alignment ? {...} : base.alignment,` property with:

```ts
    alignment: coerceAlignment(raw.alignment, raw.layout),
```

11. Append at the end of the file:

```ts
// ---- older versions ----

/** A version 1 recipe as version 2: its distances become direct mode (same delays), new fields get defaults. Anything else is returned as is. */
export function upgradeRecipe(raw: unknown): unknown {
  if (!isObject(raw) || raw.version !== 1) return raw;
  const layout = isLayoutId(raw.layout) ? raw.layout : "2.1";
  const alignment = isObject(raw.alignment) ? { ...defaultAlignment(layout), ...raw.alignment, mode: "direct" } : raw.alignment;
  return { ...raw, version: RECIPE_VERSION, alignment };
}
```

- [ ] **Step 6: Upgrade on load in `library.ts`**

In `web/src/setup/library.ts`, add `upgradeRecipe` to the import from `./recipe.ts`, then:

In `loadCustomPresets`, replace the two lines using `entry.recipe` with:

```ts
    const raw = upgradeRecipe(entry.recipe);
    if (!name || presets.some((preset) => preset.id === entry.id) || checkRecipe(raw).length > 0) continue;
    const recipe = coerceRecipe(raw);
```

Replace the body of `loadDraft` with:

```ts
  return coerceRecipe(upgradeRecipe(readJson(storage, DRAFT_KEY)));
```

In `parseSetupFile`, replace the two lines using `data.recipe` with:

```ts
  const raw = upgradeRecipe(data.recipe);
  const problems = checkRecipe(raw);
  const recipe = problems.length === 0 ? coerceRecipe(raw) : null;
```

Change the `loadDraft` doc comment to `/** The stored form draft (older versions upgraded); null when there is none or it is not a recipe. */`.

- [ ] **Step 7: Run tests and typecheck**

Run: `cd web && npm test && npm run typecheck`
Expected: all PASS; 0 errors, 0 warnings. (`SetupView.svelte` still compiles: it reads `alignment.tempC` and `alignment.distancesM`, which still exist. New recipes now default to positions mode, so its distance table has no effect until Task 5; that is expected between tasks.)

- [ ] **Step 8: Commit**

```bash
git add web/src/setup/recipe.ts web/src/setup/library.ts web/test/recipe.test.ts web/test/build.test.ts web/test/library.test.ts
git commit -m "feat(web): recipe v2 with speaker positions, crowd and offsets"
```

---

### Task 4: Tuning planning

**Files:**
- Create: `web/src/setup/tuning.ts`
- Test: `web/test/tuning.test.ts`

**Interfaces:**
- Consumes: `outputDelaysMs`, `Rig` (Task 2); `OFFSET_RANGE`, `OutputSlot`, `rigOf`, `alignmentDelaysMs`, `defaultRecipe`, `LAYOUTS` (Task 3); `TONE_FREQS` (`protocol/commands.ts`); `DeviceModel`, `OUT_BASE`, `OUTPUT_COUNT` (`state/model.ts`); `ParamAssignment` (`state/params.ts`); `StorageLike` (`state/settings.ts`).
- Produces: `TUNING_SESSION_KEY`; types `TuningStep { crossover: number; crossoverHz: number; lower: number; uppers: number[] }`, `TuningSnapshot { mutes: (boolean | null)[]; polarities: boolean[]; delaysMs: number[] }`, `TuningContext { connected: boolean; valid: boolean; rig: Rig; model: DeviceModel }`; functions `tuningSteps(outputs, crossoversHz): TuningStep[]`, `nearestToneIndex(hz): number`, `offsetLimits(startMs, toneHz): { min: number; max: number }`, `snapshotOf(model): TuningSnapshot`, `startAssignments(snapshot, lower, upper): ParamAssignment[]`, `offsetAssignments(rig, index, offsetMs): ParamAssignment[]`, `restoreAfterTuning(snapshot, keepDelays): ParamAssignment[]`, `tuningBlocker(context): string | null`, `saveTuningSnapshot(storage, snapshot): void`, `loadTuningSnapshot(storage): TuningSnapshot | null`, `clearTuningSnapshot(storage): void`.

- [ ] **Step 1: Write the failing tests**

Create `web/test/tuning.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TONE_FREQS } from "../src/protocol/commands.ts";
import { OUT_BASE, defaultModel } from "../src/state/model.ts";
import type { StorageLike } from "../src/state/settings.ts";
import { LAYOUTS, alignmentDelaysMs, defaultRecipe, rigOf, type LayoutId, type Recipe } from "../src/setup/recipe.ts";
import {
  TUNING_SESSION_KEY, clearTuningSnapshot, loadTuningSnapshot, nearestToneIndex, offsetAssignments, offsetLimits,
  restoreAfterTuning, saveTuningSnapshot, snapshotOf, startAssignments, tuningBlocker, tuningSteps,
  type TuningContext, type TuningSnapshot,
} from "../src/setup/tuning.ts";

class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null { return this.items.get(key) ?? null; }
  setItem(key: string, value: string): void { this.items.set(key, value); }
}

const stepsOf = (layout: LayoutId) => tuningSteps(LAYOUTS[layout].outputs, LAYOUTS[layout].crossoversHz)
  .map((step) => [step.lower, step.uppers, step.crossoverHz]);

function snapshot(): TuningSnapshot {
  return { mutes: [null, true, false, false], polarities: [false, false, true, false], delaysMs: [1, 1, 0, 0] };
}

function directRecipe(distancesM: Recipe["alignment"]["distancesM"] = [0, 0, 0, 0]): Recipe {
  const recipe = defaultRecipe("2.1");
  recipe.alignment = { ...recipe.alignment, enabled: true, tempC: 20, mode: "direct", distancesM };
  return recipe;
}

test("tuning steps go from the highest crossover down, against the same side when there is one", () => {
  assert.deepEqual(stepsOf("2.1"), [[2, [0, 1], 100]]);
  assert.deepEqual(stepsOf("2.2"), [[2, [0], 100], [3, [1], 100]]);
  assert.deepEqual(stepsOf("top-kick-sub"), [[2, [0, 1], 180], [3, [2], 90]]);
  assert.deepEqual(stepsOf("biamp"), [[0, [1], 1600], [2, [3], 1600]]);
  assert.deepEqual(stepsOf("4way"), [[2, [3], 1600], [1, [2], 250], [0, [1], 90]]);
  assert.deepEqual(stepsOf("2.0"), []);
});

test("the tone is the device sine nearest the crossover, and the offset stays within half a period", () => {
  assert.equal(TONE_FREQS[nearestToneIndex(100)], 100);
  assert.equal(TONE_FREQS[nearestToneIndex(90)], 100);
  assert.equal(TONE_FREQS[nearestToneIndex(180)], 200);
  assert.equal(TONE_FREQS[nearestToneIndex(1600)], 1600);
  assert.deepEqual(offsetLimits(0, 100), { min: -5, max: 5 });
  assert.deepEqual(offsetLimits(18, 100), { min: 13, max: 20 }, "clamped to the offset range");
});

test("snapshot of the device outputs", () => {
  const model = defaultModel();
  model.channels[OUT_BASE + 1]!.mute = null;
  model.channels[OUT_BASE + 2]!.polarity = true;
  model.channels[OUT_BASE + 2]!.delayMs = 4;
  assert.deepEqual(snapshotOf(model), { mutes: [false, null, false, false], polarities: [false, false, true, false], delaysMs: [0, 0, 4, 0] });
});

test("starting mutes all but the pair and flips the lower output's polarity", () => {
  assert.deepEqual(startAssignments(snapshot(), 2, 0), [
    { ref: { kind: "mute", ch: OUT_BASE }, value: false },
    { ref: { kind: "mute", ch: OUT_BASE + 1 }, value: true },
    { ref: { kind: "mute", ch: OUT_BASE + 2 }, value: false },
    { ref: { kind: "mute", ch: OUT_BASE + 3 }, value: true },
    { ref: { kind: "polarity", ch: OUT_BASE + 2 }, value: false },
  ]);
});

test("an offset change re-sends the delays of the used outputs", () => {
  const assignments = offsetAssignments(rigOf(directRecipe([10, 10, 6.57, 0])), 2, -12);
  assert.deepEqual(assignments.map((a) => a.ref.ch), [OUT_BASE, OUT_BASE + 1, OUT_BASE + 2]);
  const value = (ch: number) => assignments.find((a) => a.ref.ch === ch)!.value as number;
  assert.ok(Math.abs(value(OUT_BASE) - 2) < 0.02, "a negative sub offset delays the tops");
  assert.equal(value(OUT_BASE + 2), 0);
});

test("ending restores mutes (unknown ones unmuted) and polarity, and the delays unless kept", () => {
  const kept = restoreAfterTuning(snapshot(), true);
  assert.equal(kept.some((a) => a.ref.kind === "delay"), false);
  assert.deepEqual(kept.filter((a) => a.ref.kind === "mute").map((a) => a.value), [false, true, false, false]);
  assert.deepEqual(kept.filter((a) => a.ref.kind === "polarity").map((a) => a.value), [false, false, true, false]);
  assert.deepEqual(restoreAfterTuning(snapshot(), false).filter((a) => a.ref.kind === "delay").map((a) => a.value), [1, 1, 0, 0]);
});

test("fine tuning needs a connected device with the setup applied", () => {
  const model = defaultModel();
  const recipe = directRecipe();
  const blocker = (patch: Partial<TuningContext> = {}) => tuningBlocker({ connected: true, valid: true, rig: rigOf(recipe), model, ...patch });
  assert.equal(blocker(), null, "all distances 0: every delay is 0, as on the device");
  assert.equal(blocker({ connected: false }), "Connect the device first");
  assert.equal(blocker({ rig: rigOf({ ...recipe, alignment: { ...recipe.alignment, enabled: false } }) }), "Switch time alignment on first");
  assert.equal(blocker({ rig: rigOf({ ...defaultRecipe("2.0"), alignment: recipe.alignment }) }), "This layout has no crossover to tune");
  assert.equal(blocker({ valid: false }), "Fix the problems in the setup first");
  const measured = directRecipe([10, 10, 6.57, 0]);
  assert.match(blocker({ rig: rigOf(measured) }) ?? "", /^Apply the setup first/);
  model.channels[OUT_BASE + 2]!.delayMs = alignmentDelaysMs(measured)[2]!;
  assert.equal(blocker({ rig: rigOf(measured) }), null);
});

test("the session snapshot survives a reload until it is cleared", () => {
  const storage = new MemoryStorage();
  assert.equal(loadTuningSnapshot(storage), null);
  saveTuningSnapshot(storage, snapshot());
  assert.deepEqual(loadTuningSnapshot(storage), snapshot());
  clearTuningSnapshot(storage);
  assert.equal(loadTuningSnapshot(storage), null);
  storage.setItem(TUNING_SESSION_KEY, JSON.stringify({ mutes: [1], polarities: [], delaysMs: [] }));
  assert.equal(loadTuningSnapshot(storage), null);
  storage.setItem(TUNING_SESSION_KEY, "{broken");
  assert.equal(loadTuningSnapshot(storage), null);
  assert.equal(loadTuningSnapshot(null), null);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd web && node --experimental-strip-types --test test/tuning.test.ts`
Expected: FAIL, cannot find module `../src/setup/tuning.ts`.

- [ ] **Step 3: Implement `tuning.ts`**

Create `web/src/setup/tuning.ts`:

```ts
// By-ear fine tuning of the time alignment (polarity-null method): with one band
// inverted, a sine at the crossover is quietest when the two bands arrive together.
// Planning only: which pairs to tune, the tone, and the parameter changes that start,
// adjust and end a session. tuning.svelte.ts runs it against the device.
import { TONE_FREQS } from "../protocol/commands.ts";
import { OUT_BASE, OUTPUT_COUNT, type DeviceModel } from "../state/model.ts";
import type { ParamAssignment } from "../state/params.ts";
import type { StorageLike } from "../state/settings.ts";
import { outputDelaysMs, type Rig } from "./alignment.ts";
import { OFFSET_RANGE, type OutputSlot } from "./recipe.ts";

export const TUNING_SESSION_KEY = "opendsp-4x4.tuning-session";
/** One device delay sample at 48 kHz. */
const DELAY_TOLERANCE_MS = 1000 / 48000;
const OUTPUTS = Array.from({ length: OUTPUT_COUNT }, (_, i) => OUT_BASE + i);

export interface TuningStep {
  /** Index of the crossover between the two bands. */
  crossover: number;
  crossoverHz: number;
  /** Output index (0 to 3) of the lower band: its offset is adjusted. */
  lower: number;
  /** Output indexes it can be tuned against; the first is the default. */
  uppers: number[];
}

/** The output states a session changes, kept so they can be put back. */
export interface TuningSnapshot {
  mutes: (boolean | null)[];
  polarities: boolean[];
  delaysMs: number[];
}

export interface TuningContext {
  connected: boolean;
  /** The setup form has no problems. */
  valid: boolean;
  rig: Rig;
  model: DeviceModel;
}

/** From the highest crossover down, each lower-band output once, against the upper outputs on its side when there are any. */
export function tuningSteps(outputs: readonly (OutputSlot | null)[], crossoversHz: readonly number[]): TuningStep[] {
  const used = outputs.flatMap((slot, index) => (slot ? [{ slot, index }] : []));
  const steps: TuningStep[] = [];
  for (let crossover = crossoversHz.length - 1; crossover >= 0; crossover--) {
    const uppers = used.filter((output) => output.slot.band === crossover + 1);
    for (const lower of used.filter((output) => output.slot.band === crossover)) {
      const sameSide = uppers.filter((output) => output.slot.side === lower.slot.side);
      steps.push({
        crossover,
        crossoverHz: crossoversHz[crossover]!,
        lower: lower.index,
        uppers: (sameSide.length > 0 ? sameSide : uppers).map((output) => output.index),
      });
    }
  }
  return steps;
}

/** Index into TONE_FREQS of the sine closest to a frequency (on a log scale). */
export function nearestToneIndex(hz: number): number {
  let best = 0;
  TONE_FREQS.forEach((freq, index) => {
    if (Math.abs(Math.log(freq / hz)) < Math.abs(Math.log(TONE_FREQS[best]! / hz))) best = index;
  });
  return best;
}

/** Half a period either side of the start: the null found is then on the right cycle. */
export function offsetLimits(startMs: number, toneHz: number): { min: number; max: number } {
  const halfPeriodMs = 500 / toneHz;
  return { min: Math.max(OFFSET_RANGE.min, startMs - halfPeriodMs), max: Math.min(OFFSET_RANGE.max, startMs + halfPeriodMs) };
}

export function snapshotOf(model: DeviceModel): TuningSnapshot {
  return {
    mutes: OUTPUTS.map((ch) => model.channels[ch]!.mute),
    polarities: OUTPUTS.map((ch) => model.channels[ch]!.polarity),
    delaysMs: OUTPUTS.map((ch) => model.channels[ch]!.delayMs ?? 0),
  };
}

/** Only the pair plays, the lower output with its polarity flipped. */
export function startAssignments(snapshot: TuningSnapshot, lower: number, upper: number): ParamAssignment[] {
  const mutes = OUTPUTS.map((ch, i): ParamAssignment => ({ ref: { kind: "mute", ch }, value: i !== lower && i !== upper }));
  return [...mutes, { ref: { kind: "polarity", ch: OUT_BASE + lower }, value: !snapshot.polarities[lower] }];
}

/** The delays of every used output with one output's offset changed. */
export function offsetAssignments(rig: Rig, index: number, offsetMs: number): ParamAssignment[] {
  const offsetsMs = [...rig.alignment.offsetsMs] as Rig["alignment"]["offsetsMs"];
  offsetsMs[index] = offsetMs;
  const delays = outputDelaysMs({ ...rig, alignment: { ...rig.alignment, offsetsMs } });
  return delays.flatMap((ms, i): ParamAssignment[] => (ms === null ? [] : [{ ref: { kind: "delay", ch: OUT_BASE + i }, value: ms }]));
}

/** Back to the snapshot (unknown mutes become unmuted); the delays too unless they are kept. */
export function restoreAfterTuning(snapshot: TuningSnapshot, keepDelays: boolean): ParamAssignment[] {
  return OUTPUTS.flatMap((ch, i): ParamAssignment[] => [
    { ref: { kind: "mute", ch }, value: snapshot.mutes[i] ?? false },
    { ref: { kind: "polarity", ch }, value: snapshot.polarities[i]! },
    ...(keepDelays ? [] : [{ ref: { kind: "delay", ch }, value: snapshot.delaysMs[i]! } satisfies ParamAssignment]),
  ]);
}

/** Why fine tuning cannot start now, or null when it can. */
export function tuningBlocker(context: TuningContext): string | null {
  const { rig, model } = context;
  if (!context.connected) return "Connect the device first";
  if (!rig.alignment.enabled) return "Switch time alignment on first";
  if (tuningSteps(rig.outputs, rig.crossoversHz).length === 0) return "This layout has no crossover to tune";
  if (!context.valid) return "Fix the problems in the setup first";
  const applied = outputDelaysMs(rig).every((ms, i) =>
    ms === null || Math.abs((model.channels[OUT_BASE + i]!.delayMs ?? 0) - ms) <= DELAY_TOLERANCE_MS);
  return applied ? null : "Apply the setup first: the device delays differ from it";
}

const fourOf = (value: unknown, check: (entry: unknown) => boolean): boolean =>
  Array.isArray(value) && value.length === OUTPUT_COUNT && value.every(check);

export function loadTuningSnapshot(storage: StorageLike | null): TuningSnapshot | null {
  let data: unknown;
  try {
    data = JSON.parse(storage?.getItem(TUNING_SESSION_KEY) ?? "null");
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { mutes, polarities, delaysMs } = data as Record<string, unknown>;
  const valid = fourOf(mutes, (m) => m === null || typeof m === "boolean")
    && fourOf(polarities, (p) => typeof p === "boolean")
    && fourOf(delaysMs, (d) => typeof d === "number" && Number.isFinite(d));
  return valid ? ({ mutes, polarities, delaysMs } as TuningSnapshot) : null;
}

export function saveTuningSnapshot(storage: StorageLike | null, snapshot: TuningSnapshot): void {
  try {
    storage?.setItem(TUNING_SESSION_KEY, JSON.stringify(snapshot));
  } catch {
    // storage full or denied: the session still works, it just cannot be put back after a reload
  }
}

export function clearTuningSnapshot(storage: StorageLike | null): void {
  try {
    storage?.setItem(TUNING_SESSION_KEY, "null");
  } catch {
    // storage denied: nothing was saved either
  }
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd web && node --experimental-strip-types --test test/tuning.test.ts && npm run typecheck`
Expected: PASS (8 tests); 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add web/src/setup/tuning.ts web/test/tuning.test.ts
git commit -m "feat(web): by-ear tuning plan (pairs, tone, assignments, saved snapshot)"
```

---

### Task 5: Time alignment section with the live diagram

**Files:**
- Create: `web/src/ui/units.ts`, `web/test/units.test.ts`
- Create: `web/src/setup/bandColour.ts`
- Modify: `web/src/setup/LayoutCard.svelte:4,25-29,48,63`
- Create: `web/src/setup/AlignmentDiagram.svelte`
- Create: `web/src/setup/AlignmentSection.svelte`
- Modify: `web/src/views/SetupView.svelte`

**Interfaces:**
- Consumes: Task 2 (`coverage`, `effectivePointM`, `pathLengthM`, `speedOfSound`, `suggestedPointM`, `AlignmentMode`, `CouplingState`, `Rig`), Task 3 (ranges, `rigOf`, `alignmentDelaysMs`, `bandCount`, `usedOutputs`, `LAYOUTS`, `Recipe`, `ALIGNMENT_MODES`).
- Produces: `metresToShown(m, unit)`, `shownToMetres(v, unit)`, `celsiusToShown(c, unit)`, `shownToCelsius(v, unit)`, types `DistanceUnit`, `TemperatureUnit` (`ui/units.ts`); `bandColour(bands: number, band: number): string`; component `AlignmentDiagram` with props `{ rig: Rig; names: readonly (string | null)[]; bands: number; unit: DistanceUnit; onpoint: (pointM: number | null) => void }`; component `AlignmentSection` with props `{ recipe: Recipe; problemAt: (field: string) => string | undefined; valid: boolean }`. `AlignmentSection` renders `TuningPanel` (Task 6); in this task it does not yet.

- [ ] **Step 1: Write the failing units test**

Create `web/test/units.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { celsiusToShown, metresToShown, shownToCelsius, shownToMetres } from "../src/ui/units.ts";

test("distance and temperature units convert both ways", () => {
  assert.equal(metresToShown(3, "m"), 3);
  assert.ok(Math.abs(metresToShown(3.048, "ft") - 10) < 1e-9);
  assert.ok(Math.abs(shownToMetres(10, "ft") - 3.048) < 1e-9);
  assert.equal(shownToMetres(3, "m"), 3);
  assert.equal(celsiusToShown(20, "F"), 68);
  assert.equal(shownToCelsius(68, "F"), 20);
  assert.equal(celsiusToShown(20, "C"), 20);
});
```

Run: `cd web && node --experimental-strip-types --test test/units.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 2: Implement `units.ts`**

Create `web/src/ui/units.ts`:

```ts
// Display units chosen in Settings. Values are stored metric and converted at the edges.
import type { Settings } from "../state/settings.ts";

export type DistanceUnit = Settings["distanceUnit"];
export type TemperatureUnit = Settings["temperatureUnit"];

const FEET_PER_METRE = 1 / 0.3048;

export const metresToShown = (metres: number, unit: DistanceUnit): number => (unit === "m" ? metres : metres * FEET_PER_METRE);
export const shownToMetres = (shown: number, unit: DistanceUnit): number => (unit === "m" ? shown : shown / FEET_PER_METRE);
export const celsiusToShown = (celsius: number, unit: TemperatureUnit): number => (unit === "C" ? celsius : (celsius * 9) / 5 + 32);
export const shownToCelsius = (shown: number, unit: TemperatureUnit): number => (unit === "C" ? shown : ((shown - 32) * 5) / 9);
```

Run: `cd web && node --experimental-strip-types --test test/units.test.ts`
Expected: PASS.

- [ ] **Step 3: Share the band colour**

Create `web/src/setup/bandColour.ts`:

```ts
/** CSS colour of a frequency band: warm for low, cool for high; the accent when there is only one band. */
export function bandColour(bands: number, band: number): string {
  if (bands === 1) return "var(--accent)";
  return `var(--band-${Math.round((band * 3) / (bands - 1))})`;
}
```

In `web/src/setup/LayoutCard.svelte`: add `import { bandColour } from "./bandColour.ts";` under the existing import; delete the local `function bandColour(band: number) { ... }`; replace both calls `bandColour(output.band)` with `bandColour(bandCount(layout), output.band)`.

- [ ] **Step 4: Create `AlignmentDiagram.svelte`**

Create `web/src/setup/AlignmentDiagram.svelte`:

```svelte
<script lang="ts">
  // Side view of the time alignment: speakers at their height and distance from the stage
  // edge, the crowd on the floor coloured by how well neighbouring bands add up at their
  // crossover, and the alignment point (drag it, or focus it and use the arrow keys).
  import { formatFixed } from "../ui/format.ts";
  import { metresToShown, type DistanceUnit } from "../ui/units.ts";
  import { bandColour } from "./bandColour.ts";
  import {
    coverage, effectivePointM, pathLengthM, speedOfSound, suggestedPointM, type CouplingState, type Rig,
  } from "./alignment.ts";

  interface Props {
    rig: Rig;
    /** Display name per output (Out 1 to Out 4); null = spare. */
    names: readonly (string | null)[];
    bands: number;
    unit: DistanceUnit;
    /** New alignment point (m), or null to follow the suggestion. */
    onpoint: (pointM: number | null) => void;
  }

  let { rig, names, bands, unit, onpoint }: Props = $props();

  const HEIGHT = 200;
  const PAD = { left: 16, right: 16, top: 30, bottom: 30 };
  const STRIP_H = 8;
  const BOX = 14;
  const POINT_STEP_M = 0.1;
  const POINT_STEP_SHIFT_M = 1;
  const STATES: readonly CouplingState[] = ["adds", "weak", "cancels"];
  const STATE_NAMES: Record<CouplingState, string> = { adds: "adds up", weak: "weak", cancels: "cancels" };

  let width = $state(480);
  let svg = $state<SVGSVGElement>();
  let dragging = false;

  const alignment = $derived(rig.alignment);
  const crowd = $derived(alignment.crowd);
  const crowdEnd = $derived(Math.max(crowd.startM, crowd.endM));
  const pointM = $derived(effectivePointM(rig));
  const suggested = $derived(suggestedPointM(rig));
  const result = $derived(coverage(rig, pointM));
  const speed = $derived(speedOfSound(alignment.tempC));

  /** Used outputs at the same position share one box. */
  const groups = $derived.by(() => {
    const list: { key: string; xM: number; heightM: number; label: string; band: number; pathM: number }[] = [];
    rig.outputs.forEach((slot, index) => {
      if (!slot) return;
      const { xM, heightM } = alignment.speakers[index]!;
      const key = `${xM}|${heightM}`;
      const name = names[index] ?? slot.name;
      const existing = list.find((group) => group.key === key);
      if (existing) existing.label += ` + ${name}`;
      else list.push({ key, xM, heightM, label: name, band: slot.band, pathM: pathLengthM({ xM, heightM }, pointM, crowd.earHeightM) });
    });
    return list;
  });

  const xMin = $derived(Math.min(0, crowd.startM, ...groups.map((group) => group.xM)) - 1);
  const xMax = $derived(Math.max(crowdEnd, ...groups.map((group) => group.xM)) + 1);
  const hMax = $derived(Math.max(crowd.earHeightM, ...groups.map((group) => group.heightM)) * 1.15 + 0.3);
  const plotW = $derived(Math.max(120, width - PAD.left - PAD.right));
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (m: number) => PAD.left + ((m - xMin) / (xMax - xMin)) * plotW;
  const y = (h: number) => PAD.top + plotH - (h / hMax) * plotH;
  const labelAtEnd = (m: number) => x(m) > PAD.left + plotW * 0.6;

  /** Neighbouring crowd samples in the same state, drawn as one run. */
  const runs = $derived.by(() => {
    if (!result) return [{ from: crowd.startM, to: crowdEnd, state: null as CouplingState | null }];
    const { samples } = result;
    const half = samples.length > 1 ? (samples[1]!.xM - samples[0]!.xM) / 2 : 0;
    const list: { from: number; to: number; state: CouplingState | null }[] = [];
    for (const sample of samples) {
      const last = list[list.length - 1];
      const to = Math.min(crowdEnd, sample.xM + half);
      if (last && last.state === sample.state) last.to = to;
      else list.push({ from: Math.max(crowd.startM, sample.xM - half), to, state: sample.state });
    }
    return list;
  });

  const distance = (m: number) => `${formatFixed(metresToShown(m, unit), 1)} ${unit}`;
  const crossovers = $derived(rig.crossoversHz.map((hz) => `${formatFixed(hz, 0)} Hz`).join(" and "));
  const percent = $derived(result && result.totalM > 0 ? Math.round((result.coupledM / result.totalM) * 100) : 100);

  function clampPoint(m: number): number {
    const rounded = Number((Math.round(m / POINT_STEP_M) * POINT_STEP_M).toFixed(1));
    return Math.min(crowdEnd, Math.max(crowd.startM, rounded));
  }

  function metresAt(clientX: number): number {
    const rect = svg!.getBoundingClientRect();
    return clampPoint(xMin + ((clientX - rect.left - PAD.left) / plotW) * (xMax - xMin));
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    dragging = true;
    try {
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    } catch {
      // pointer already released (or synthetic): moves over the diagram still drag
    }
    onpoint(metresAt(event.clientX));
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return;
    const next = metresAt(event.clientX);
    if (next !== pointM) onpoint(next);
  }

  function onPointerUp(): void {
    dragging = false;
  }

  function onKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? POINT_STEP_SHIFT_M : POINT_STEP_M;
    let next: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = pointM - step;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = pointM + step;
    else if (event.key === "Home") next = crowd.startM;
    else if (event.key === "End") next = crowdEnd;
    if (next === null) return;
    event.preventDefault();
    onpoint(clampPoint(next));
  }
</script>

<div class="diagram">
  <div class="graph" bind:clientWidth={width}>
    <svg bind:this={svg} {width} height={HEIGHT} role="group" aria-label="Side view of the speakers, the crowd and the alignment point">
      <line class="floor" x1={PAD.left} x2={PAD.left + plotW} y1={y(0)} y2={y(0)} />
      <line class="edge" x1={x(0)} x2={x(0)} y1={PAD.top - 14} y2={y(0)} />
      <text class="caption" x={x(0) + 4} y={PAD.top - 18}>Stage edge</text>
      {#each runs as run (run.from)}
        <rect class="strip {run.state ?? 'neutral'}" x={x(run.from)} y={y(0)} width={Math.max(1, x(run.to) - x(run.from))} height={STRIP_H} />
      {/each}
      <text class="caption" x={x(crowd.startM)} y={y(0) + STRIP_H + 12}>Crowd {distance(crowd.startM)} to {distance(crowdEnd)}</text>
      {#each groups as group (group.key)}
        <line class="path" x1={x(group.xM)} y1={y(group.heightM)} x2={x(pointM)} y2={y(crowd.earHeightM)} style:stroke={bandColour(bands, group.band)} />
      {/each}
      {#each groups as group (group.key)}
        {@const end = labelAtEnd(group.xM)}
        {@const labelX = end ? x(group.xM) - BOX / 2 - 4 : x(group.xM) + BOX / 2 + 4}
        <rect class="speaker" x={x(group.xM) - BOX / 2} y={y(group.heightM) - BOX / 2} width={BOX} height={BOX} rx="2"
              style:--band={bandColour(bands, group.band)} />
        <text class="name" class:end x={labelX} y={y(group.heightM) - 2}>{group.label}</text>
        <text class="figure" class:end x={labelX} y={y(group.heightM) + 10}>
          {distance(group.pathM)}, {formatFixed((group.pathM / speed) * 1000, 1)} ms
        </text>
      {/each}
      <g class="point" role="slider" tabindex="0" aria-label="Alignment point"
         aria-valuemin={crowd.startM} aria-valuemax={crowdEnd} aria-valuenow={pointM}
         aria-valuetext="{distance(pointM)} from the stage edge"
         onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp}
         onkeydown={onKeydown}>
        <rect class="hit" x={x(crowd.startM)} y={PAD.top} width={Math.max(1, x(crowdEnd) - x(crowd.startM))} height={plotH + STRIP_H} />
        <line class="marker" x1={x(pointM)} x2={x(pointM)} y1={y(crowd.earHeightM)} y2={y(0)} />
        <circle class="marker" cx={x(pointM)} cy={y(crowd.earHeightM)} r="6" />
      </g>
    </svg>
  </div>
  <div class="readout">
    {#if result}
      <span>Coupled at {crossovers}: <strong>{distance(result.coupledM)}</strong> of {distance(result.totalM)} ({percent}%)</span>
    {:else}
      <span class="faint">No crossover: only the arrival times matter.</span>
    {/if}
    <span class="faint">Alignment point {distance(pointM)} from the stage edge, {alignment.pointM === null ? (suggested === null ? "the middle of the crowd" : "suggested") : "moved by you"}.</span>
    <button disabled={alignment.pointM === null} onclick={() => onpoint(null)}>{suggested === null ? "Use the middle" : "Use suggested"}</button>
  </div>
  {#if result}
    <ul class="legend">
      {#each STATES as state (state)}<li><span class="swatch {state}"></span>{STATE_NAMES[state]}</li>{/each}
    </ul>
  {/if}
</div>

<style>
  .diagram { display: grid; gap: 6px; margin-bottom: 10px; }
  .graph { position: relative; width: 100%; height: 200px; background: var(--graph-bg); border: 1px solid var(--line); border-radius: var(--radius); }
  svg { position: absolute; inset: 0; display: block; }
  text { font: 10px var(--font-mono); fill: var(--text-dim); }
  .caption { fill: var(--text-faint); }
  .name { font: 600 11px var(--font); fill: var(--text); }
  .end { text-anchor: end; }
  .floor { stroke: var(--graph-zero); }
  .edge { stroke: var(--graph-grid); stroke-dasharray: 4 3; }
  .strip.adds, .swatch.adds { fill: var(--ok); background: var(--ok); }
  .strip.weak, .swatch.weak { fill: var(--warn); background: var(--warn); }
  .strip.cancels, .swatch.cancels { fill: var(--bad); background: var(--bad); }
  .strip.neutral { fill: var(--graph-grid); }
  .path { stroke-width: 1.5; opacity: .7; }
  .speaker { fill: color-mix(in srgb, var(--band) 30%, var(--graph-bg)); stroke: var(--band); }
  .point { outline: none; cursor: ew-resize; }
  .hit { fill: transparent; }
  .marker { stroke: var(--accent); stroke-width: 2; }
  circle.marker { fill: var(--accent); }
  .point:focus-visible circle.marker { stroke: var(--text); }
  .readout { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: 12px; }
  .legend { display: flex; gap: 14px; margin: 0; padding: 0; list-style: none; font-size: 11px; color: var(--text-dim); }
  .legend li { display: flex; align-items: center; gap: 6px; }
  .swatch { width: 12px; height: 6px; border-radius: 1px; }
</style>
```

- [ ] **Step 5: Create `AlignmentSection.svelte`**

Create `web/src/setup/AlignmentSection.svelte`:

```svelte
<script lang="ts">
  // Setup's time alignment: speaker positions and the crowd in a side view (or direct
  // distances), the delays they give, and the by-ear fine tuning.
  import { settings } from "../state/settings.svelte.ts";
  import { channelLabel } from "../state/model.ts";
  import type { Range } from "../state/params.ts";
  import Section from "../ui/Section.svelte";
  import NumberField from "../ui/NumberField.svelte";
  import Toggle from "../ui/Toggle.svelte";
  import Choice from "../ui/Choice.svelte";
  import { formatDb, formatFixed } from "../ui/format.ts";
  import { celsiusToShown, metresToShown, shownToCelsius, shownToMetres } from "../ui/units.ts";
  import type { AlignmentMode } from "./alignment.ts";
  import { setupDraft as draft } from "./draft.svelte.ts";
  import {
    ALIGNMENT_MODES, CROWD_RANGE, DISTANCE_RANGE, EAR_HEIGHT_RANGE, HEIGHT_RANGE, LAYOUTS, POSITION_RANGE, TEMPERATURE_RANGE,
    alignmentDelaysMs, bandCount, rigOf, usedOutputs, type Recipe,
  } from "./recipe.ts";
  import AlignmentDiagram from "./AlignmentDiagram.svelte";

  interface Props {
    recipe: Recipe;
    problemAt: (field: string) => string | undefined;
    /** The whole setup form has no problems. */
    valid: boolean;
  }

  let { recipe, problemAt, valid }: Props = $props();

  const MODE_NAMES: Record<AlignmentMode, string> = { positions: "Positions", direct: "Direct distances" };
  const DISTANCE_STEP = 0.1;
  const TEMPERATURE_STEP = 1;

  const layout = $derived(LAYOUTS[recipe.layout]);
  const used = $derived(usedOutputs(layout));
  const rig = $derived(rigOf(recipe));
  const delays = $derived(alignmentDelaysMs(recipe));
  const positions = $derived(recipe.alignment.mode === "positions");
  const unit = $derived(settings.value.distanceUnit);
  const temperatureUnit = $derived(settings.value.temperatureUnit);

  const clampTo = (value: number, range: Range) => Math.min(range.max, Math.max(range.min, value));
  const shown = (metres: number) => metresToShown(metres, unit);
  const toMetres = (value: number, range: Range) => clampTo(shownToMetres(value, unit), range);
  const formatDistance = (value: number) => formatFixed(value, 2);

  /** A crowd edit keeps a chosen alignment point inside the crowd. */
  function setCrowdEdge(edge: "startM" | "endM", value: number): void {
    draft.edit((r) => {
      r.alignment.crowd[edge] = toMetres(value, CROWD_RANGE);
      const { startM, endM } = r.alignment.crowd;
      if (r.alignment.pointM !== null) r.alignment.pointM = Math.min(Math.max(startM, endM), Math.max(startM, r.alignment.pointM));
    });
  }
</script>

<Section title="Time alignment">
  {#snippet actions()}
    <Toggle pressed={recipe.alignment.enabled} title="Time alignment"
            onchange={(on) => draft.edit((r) => { r.alignment.enabled = on; })}>{recipe.alignment.enabled ? "On" : "Off"}</Toggle>
  {/snippet}
  {#if recipe.alignment.enabled}
    <div class="row">
      <Choice options={ALIGNMENT_MODES} value={recipe.alignment.mode} label={(mode) => MODE_NAMES[mode]} ariaLabel="How the speakers are placed"
              onchange={(mode) => draft.edit((r) => { r.alignment.mode = mode; })} />
    </div>
    {#if positions}
      <p class="dim">Give each speaker's distance from the stage edge and its height, and where the crowd stands. The nearer speakers are delayed so that every sound arrives together at the alignment point.</p>
    {:else}
      <p class="dim">Measure from the listening spot to each speaker. The nearer speakers are delayed so that every sound arrives with the farthest one.</p>
    {/if}
    <div class="fields">
      <NumberField label="Air temperature" value={celsiusToShown(recipe.alignment.tempC, temperatureUnit)}
                   min={celsiusToShown(TEMPERATURE_RANGE.min, temperatureUnit)} max={celsiusToShown(TEMPERATURE_RANGE.max, temperatureUnit)}
                   step={TEMPERATURE_STEP} format={(v) => formatFixed(v, 0)} unit="°{temperatureUnit}" error={problemAt("alignment.tempC")}
                   onchange={(value) => draft.edit((r) => { r.alignment.tempC = clampTo(shownToCelsius(value, temperatureUnit), TEMPERATURE_RANGE); })} />
      {#if positions}
        <NumberField label="Crowd from" value={shown(recipe.alignment.crowd.startM)} min={shown(CROWD_RANGE.min)} max={shown(CROWD_RANGE.max)}
                     step={DISTANCE_STEP} format={formatDistance} {unit} error={problemAt("alignment.crowd.startM")}
                     onchange={(value) => setCrowdEdge("startM", value)} />
        <NumberField label="Crowd to" value={shown(recipe.alignment.crowd.endM)} min={shown(CROWD_RANGE.min)} max={shown(CROWD_RANGE.max)}
                     step={DISTANCE_STEP} format={formatDistance} {unit} error={problemAt("alignment.crowd.endM")}
                     onchange={(value) => setCrowdEdge("endM", value)} />
        <NumberField label="Ear height" value={shown(recipe.alignment.crowd.earHeightM)} min={shown(EAR_HEIGHT_RANGE.min)}
                     max={shown(EAR_HEIGHT_RANGE.max)} step={DISTANCE_STEP} format={formatDistance} {unit}
                     error={problemAt("alignment.crowd.earHeightM")}
                     onchange={(value) => draft.edit((r) => { r.alignment.crowd.earHeightM = toMetres(value, EAR_HEIGHT_RANGE); })} />
      {/if}
    </div>
    {#if positions}
      <AlignmentDiagram {rig} names={layout.outputs.map((output) => output?.name ?? null)} bands={bandCount(layout)} {unit}
                        onpoint={(pointM) => draft.edit((r) => { r.alignment.pointM = pointM; })} />
      {#if problemAt("alignment.pointM")}<p class="error">{problemAt("alignment.pointM")}</p>{/if}
    {/if}
    <table class="table">
      <thead>
        <tr>
          <th>Output</th>
          {#if positions}<th>From stage edge</th><th>Height</th>{:else}<th>Distance</th>{/if}
          <th>Delay</th><th>Fine-tune</th>
        </tr>
      </thead>
      <tbody>
        {#each used as output (output.ch)}
          {@const offset = recipe.alignment.offsetsMs[output.index] ?? 0}
          {@const speaker = recipe.alignment.speakers[output.index]!}
          <tr>
            <td>{output.slot.name} <span class="faint">{channelLabel(output.ch)}</span></td>
            {#if positions}
              <td>
                <NumberField ariaLabel="{output.slot.name} distance from the stage edge" value={shown(speaker.xM)}
                             min={shown(POSITION_RANGE.min)} max={shown(POSITION_RANGE.max)} step={DISTANCE_STEP} format={formatDistance} {unit}
                             error={problemAt(`alignment.speakers.${output.index}.xM`)}
                             onchange={(value) => draft.edit((r) => { r.alignment.speakers[output.index]!.xM = toMetres(value, POSITION_RANGE); })} />
              </td>
              <td>
                <NumberField ariaLabel="{output.slot.name} height" value={shown(speaker.heightM)}
                             min={shown(HEIGHT_RANGE.min)} max={shown(HEIGHT_RANGE.max)} step={DISTANCE_STEP} format={formatDistance} {unit}
                             error={problemAt(`alignment.speakers.${output.index}.heightM`)}
                             onchange={(value) => draft.edit((r) => { r.alignment.speakers[output.index]!.heightM = toMetres(value, HEIGHT_RANGE); })} />
              </td>
            {:else}
              <td>
                <NumberField ariaLabel="Distance to {output.slot.name}" value={shown(recipe.alignment.distancesM[output.index] ?? 0)}
                             min={shown(DISTANCE_RANGE.min)} max={shown(DISTANCE_RANGE.max)} step={DISTANCE_STEP} format={formatDistance} {unit}
                             error={problemAt(`alignment.distancesM.${output.index}`)}
                             onchange={(value) => draft.edit((r) => { r.alignment.distancesM[output.index] = toMetres(value, DISTANCE_RANGE); })} />
              </td>
            {/if}
            <td class="num">{formatFixed(delays[output.index] ?? 0, 2)} ms</td>
            <td class="num">
              {#if offset !== 0}
                {formatDb(offset, 2)} ms
                <button class="ghost" title="Remove the fine-tune offset of {output.slot.name}"
                        onclick={() => draft.edit((r) => { r.alignment.offsetsMs[output.index] = 0; })}>Reset</button>
              {:else}
                <span class="faint">none</span>
              {/if}
              {#if problemAt(`alignment.offsetsMs.${output.index}`)}<span class="error">{problemAt(`alignment.offsetsMs.${output.index}`)}</span>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if problemAt("alignment.delay")}<p class="error">{problemAt("alignment.delay")}</p>{/if}
    <p class="faint">
      Distances cannot include the cabinets' own delay; the by-ear fine tuning corrects it at the alignment point. With an
      audience in front of ground-stacked subs, the subs arrive a little later, so slightly less sub delay is often better.
      A measurement app (REW, Open Sound Meter) is the reliable check.
    </p>
  {:else}
    <p class="dim">Off: the output delays are left as they are.</p>
  {/if}
</Section>

<style>
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 8px; }
  .fields { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px 16px; margin-bottom: 10px; }
  .table { border-collapse: collapse; margin-bottom: 10px; }
  .table th { text-align: left; font-size: 11px; font-weight: 600; color: var(--text-dim); padding: 2px 12px 4px 0; }
  .table td { padding: 3px 12px 3px 0; vertical-align: top; }
  .table td:first-child { padding-top: 8px; white-space: nowrap; }
  .table td.num { padding-top: 8px; white-space: nowrap; }
  p { margin: 0 0 8px; }
  .error { color: var(--bad); }
  td .error { display: block; font-size: 11px; white-space: normal; }
</style>
```

`valid` is passed on to `TuningPanel` in Task 6 (the tsconfig has no `noUnusedLocals`, so the prop being unused until then is not a warning).

- [ ] **Step 6: Use the section in `SetupView.svelte`**

In `web/src/views/SetupView.svelte`:

1. Replace the whole `<Section title="Time alignment"> ... </Section>` block (from `<Section title="Time alignment">` to its closing `</Section>`, before `<Section title="Protection">`) with:

```svelte
    <AlignmentSection {recipe} {problemAt} valid={problems.length === 0} />
```

2. Add the import below `import CrossoverPreview from "../setup/CrossoverPreview.svelte";`:

```ts
  import AlignmentSection from "../setup/AlignmentSection.svelte";
```

3. Delete the `// ---- units ----` block (from `const metric =` to `const delays = $derived(alignmentDelaysMs(recipe));`) and the constants `TEMPERATURE_STEP`, `DISTANCE_STEP`, `FEET_PER_METRE`.

4. From the `../setup/recipe.ts` import remove `DISTANCE_RANGE`, `TEMPERATURE_RANGE`, `alignmentDelaysMs`. From the `../ui/format.ts` import remove `formatFixed`.

- [ ] **Step 7: Run tests, typecheck and build**

Run: `cd web && npm test && npm run typecheck && npm run build`
Expected: all tests PASS; 0 errors, 0 warnings; build succeeds.

- [ ] **Step 8: Quick look in the browser**

Run: `cd web && npm run dev` (in the background), open `http://localhost:5173/?mock#setup`, choose the "2.1 Outdoor" preset, switch Time alignment on.
Expected: "Positions" pressed; the side view shows Top L + Top R at 2 m, Sub at 0.4 m, the crowd strip from 2 to 20 m all green, readout "Coupled at 100 Hz: 18.0 m of 18.0 m (100%)". Set the top height to 6 m: the strip shows amber or red near the stage. Drag the marker: delays in the table change, "moved by you" shows; "Use suggested" puts it back.

- [ ] **Step 9: Commit**

```bash
git add web/src/ui/units.ts web/test/units.test.ts web/src/setup/bandColour.ts web/src/setup/LayoutCard.svelte web/src/setup/AlignmentDiagram.svelte web/src/setup/AlignmentSection.svelte web/src/views/SetupView.svelte
git commit -m "feat(web): time alignment positions and live side-view diagram"
```

---

### Task 6: Guided by-ear tuning

**Files:**
- Create: `web/src/state/storage.ts`
- Modify: `web/src/setup/draft.svelte.ts:14-20`, `web/src/state/settings.svelte.ts:4-10`
- Create: `web/src/setup/tuning.svelte.ts`
- Create: `web/src/setup/TuningPanel.svelte`
- Modify: `web/src/setup/AlignmentSection.svelte`

**Interfaces:**
- Consumes: Task 1 (`device.beginGroup`, `device.endGroup`, `device.applyGroup`), Task 4 (all of `tuning.ts`), Task 3 (`rigOf`, `LAYOUTS`, `Recipe`), Task 2 (`effectivePointM`, `Rig`), `device.testTone(source, freqIndex)`, `ToneSource`, `TONE_FREQS`, `setupDraft.edit`.
- Produces: `browserStorage(): StorageLike | null` (`state/storage.ts`); store `tuning` with `running: RunningTuning | null`, `offsetMs: number`, `interrupted: TuningSnapshot | null`, `start(recipe, step, upper, pairName)`, `setOffset(ms)`, `done()`, `cancel()`, `restoreInterrupted()`, `dismissInterrupted()`; component `TuningPanel` with props `{ recipe: Recipe; valid: boolean }`.

- [ ] **Step 1: Share `browserStorage`**

Create `web/src/state/storage.ts`:

```ts
// The browser's localStorage, or null where there is none or access is denied.
import type { StorageLike } from "./settings.ts";

export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage access denied (privacy settings)
  }
}
```

In `web/src/state/settings.svelte.ts`, delete the local `function browserStorage()`, remove `type StorageLike` from its import, and add `import { browserStorage } from "./storage.ts";`.

In `web/src/setup/draft.svelte.ts`, delete the local `function browserStorage()`, remove the `import type { StorageLike } ...` line, and add `import { browserStorage } from "../state/storage.ts";`.

Run: `cd web && npm test && npm run typecheck`
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 2: Create the session store**

Create `web/src/setup/tuning.svelte.ts`:

```ts
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
```

- [ ] **Step 3: Create the panel**

Create `web/src/setup/TuningPanel.svelte`:

```svelte
<script lang="ts">
  // By-ear fine tuning, step by step: intro (safety, where to stand, which pair), the
  // running session (offset with Earlier / Later), and the notice after an interrupted one.
  import { device } from "../state/device.svelte.ts";
  import { settings } from "../state/settings.svelte.ts";
  import NumberField from "../ui/NumberField.svelte";
  import Choice from "../ui/Choice.svelte";
  import { formatDb, formatFixed } from "../ui/format.ts";
  import { metresToShown } from "../ui/units.ts";
  import { effectivePointM } from "./alignment.ts";
  import { LAYOUTS, rigOf, type Recipe } from "./recipe.ts";
  import { tuning } from "./tuning.svelte.ts";
  import { tuningBlocker, tuningSteps } from "./tuning.ts";

  interface Props {
    recipe: Recipe;
    /** The whole setup form has no problems. */
    valid: boolean;
  }

  let { recipe, valid }: Props = $props();

  const NUDGE_MS = 0.1;
  const NUDGE_SHIFT_MS = 1;

  const layout = $derived(LAYOUTS[recipe.layout]);
  const rig = $derived(rigOf(recipe));
  const steps = $derived(tuningSteps(layout.outputs, recipe.crossoversHz));
  const blocker = $derived(tuning.interrupted
    ? "Restore or dismiss the interrupted session first"
    : tuningBlocker({ connected: device.connected, valid, rig, model: device.edit.model }));
  const unit = $derived(settings.value.distanceUnit);
  const where = $derived(recipe.alignment.mode === "positions"
    ? `Stand at the alignment point, ${formatFixed(metresToShown(effectivePointM(rig), unit), 1)} ${unit} from the stage edge, ears at the ear height.`
    : "Stand at the spot you measured the distances from.");
  const nameOf = (index: number) => layout.outputs[index]?.name ?? `Out ${index + 1}`;

  let open = $state(false);
  let stepIndex = $state(0);
  let chosen = $state<number | null>(null);
  const step = $derived(steps[Math.min(stepIndex, steps.length - 1)]);
  const upper = $derived(step && chosen !== null && step.uppers.includes(chosen) ? chosen : step?.uppers[0]);

  function begin(): void {
    stepIndex = 0;
    chosen = null;
    open = true;
  }

  function start(): void {
    if (!step || upper === undefined) return;
    tuning.start($state.snapshot(recipe) as Recipe, step, upper, `${nameOf(step.lower)} ↔ ${nameOf(upper)}`);
  }

  function done(): void {
    tuning.done();
    if (stepIndex + 1 < steps.length) {
      stepIndex++;
      chosen = null;
    } else {
      open = false;
    }
  }

  function nudge(event: MouseEvent, direction: 1 | -1): void {
    tuning.setOffset(tuning.offsetMs + direction * (event.shiftKey ? NUDGE_SHIFT_MS : NUDGE_MS));
  }
</script>

{#if tuning.interrupted && device.connected && !tuning.running}
  <div class="panel">
    <p>A fine-tuning session was interrupted. Restore the mutes, polarity and delays it changed?</p>
    <div class="row">
      <button class="primary" onclick={() => tuning.restoreInterrupted()}>Restore</button>
      <button onclick={() => tuning.dismissInterrupted()}>Dismiss</button>
    </div>
  </div>
{/if}

{#if tuning.running}
  {@const run = tuning.running}
  <div class="panel">
    <h4>Fine-tune {run.pairName}</h4>
    <p>{nameOf(run.step.lower)} is inverted and a {formatFixed(run.toneHz, 0)} Hz sine is playing. Make the tone as quiet as possible: the quietest point is the aligned one.</p>
    <p class="warning">Only {nameOf(run.step.lower)} and {nameOf(run.upper)} should play. If other speakers play, press Cancel and switch their amplifiers off.</p>
    {#if !device.connected}
      <p class="warning">The device is not connected. Cancel now: the changes are offered for restoring when it is connected again.</p>
    {/if}
    <div class="row">
      <button onclick={(event) => nudge(event, -1)} title="Less delay on {nameOf(run.step.lower)} (Shift: 1 ms)">Earlier</button>
      <NumberField ariaLabel="Fine-tune offset of {nameOf(run.step.lower)}" value={tuning.offsetMs} min={run.limits.min} max={run.limits.max}
                   step={NUDGE_MS} format={(v) => formatDb(v, 2)} unit="ms" width="110px" onchange={(value) => tuning.setOffset(value)} />
      <button onclick={(event) => nudge(event, 1)} title="More delay on {nameOf(run.step.lower)} (Shift: 1 ms)">Later</button>
      <span class="faint">{formatDb(run.limits.min, 1)} to {formatDb(run.limits.max, 1)} ms</span>
    </div>
    <div class="row">
      <button class="primary" onclick={done}>Done</button>
      <button onclick={() => tuning.cancel()}>Cancel</button>
    </div>
  </div>
{:else if open && step && upper !== undefined}
  <div class="panel">
    <h4>Fine-tune by ear</h4>
    <p class="warning">The tone plays at full level. Turn the amplifiers down first.</p>
    <p>{where}</p>
    {#if steps.length > 1}
      <label class="select">
        <span class="label">Pair</span>
        <select value={stepIndex} onchange={(event) => { stepIndex = Number(event.currentTarget.value); chosen = null; }}>
          {#each steps as s, i (i)}
            <option value={i}>{nameOf(s.lower)} with {s.uppers.map(nameOf).join(" or ")}, {formatFixed(s.crossoverHz, 0)} Hz</option>
          {/each}
        </select>
      </label>
    {/if}
    {#if step.uppers.length > 1}
      <div class="row">
        <span class="faint">Against</span>
        <Choice options={step.uppers} value={upper} label={nameOf} ariaLabel="Tune against" onchange={(index) => (chosen = index)} />
      </div>
    {/if}
    <p class="dim">
      {nameOf(step.lower)} gets inverted and a sine near {formatFixed(step.crossoverHz, 0)} Hz plays on {nameOf(step.lower)} and
      {nameOf(upper)} only. Done keeps the result as one undo step; Cancel puts everything back.
    </p>
    <div class="row">
      <button class="primary" disabled={blocker !== null} title={blocker ?? undefined} onclick={start}>Start</button>
      <button onclick={() => (open = false)}>Close</button>
      {#if blocker}<span class="faint">{blocker}</span>{/if}
    </div>
  </div>
{:else if steps.length > 0}
  <div class="row">
    <button disabled={blocker !== null} title={blocker ?? "Find the cabinets' own delay with a sine and a polarity flip"} onclick={begin}>Fine-tune by ear…</button>
    {#if blocker}<span class="faint">{blocker}</span>{/if}
  </div>
{/if}

<style>
  .panel { margin: 0 0 10px; padding: 8px 10px; border-left: 3px solid var(--accent); background: var(--surface-2); }
  h4 { margin: 0 0 6px; font-size: 13px; }
  p { margin: 0 0 8px; }
  .warning { color: var(--warn); }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 8px; }
  .select { display: inline-flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
</style>
```

- [ ] **Step 4: Add the panel to the section**

In `web/src/setup/AlignmentSection.svelte`: add `import TuningPanel from "./TuningPanel.svelte";` after the `AlignmentDiagram` import, then insert above the limits note paragraph (`<p class="faint">Distances cannot include ...`):

```svelte
    <TuningPanel {recipe} {valid} />
```

- [ ] **Step 5: Run tests, typecheck and build**

Run: `cd web && npm test && npm run typecheck && npm run build`
Expected: all PASS; 0 errors, 0 warnings; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/src/state/storage.ts web/src/state/settings.svelte.ts web/src/setup/draft.svelte.ts web/src/setup/tuning.svelte.ts web/src/setup/TuningPanel.svelte web/src/setup/AlignmentSection.svelte
git commit -m "feat(web): guided by-ear fine tuning of the time alignment"
```

---

### Task 7: Manual verification in mock mode

**Files:** none (fix anything found in the file it belongs to, with a test first when it is in a pure module).

- [ ] **Step 1: Start the app**

Run: `cd web && npm run dev` (background). Open `http://localhost:5173/?mock#setup`. Note your current Settings (units, theme) to restore them afterwards.

- [ ] **Step 2: Diagram and positions**

Check, with "2.1 Outdoor" and alignment on:
- Positions mode by default; table columns From stage edge, Height, Delay, Fine-tune.
- Top heights 4 m, ear 1.7 m: the readout's coupled length and the sub delay change; at a crowd of 1 to 40 m with tops at 8 m, the strip shows red near the stage when the point is at the back.
- Drag the marker, then the arrow keys (0.1 m), Shift+arrow (1 m), Home/End. "Use suggested" returns to the suggestion.
- Crowd end below start + 1 m shows the crowd error; moving the crowd keeps a chosen point inside.
- Settings: switch to ft and °F; the fields, diagram captions and readout use them; switching back restores the same metric values.
- Direct distances mode: the old table, no diagram.
- Top/Kick/Sub: the readout lists 90 Hz and 180 Hz. 2.0: "No crossover", "Use the middle".
- Phone width (about 390 px): the diagram fits, labels readable.

- [ ] **Step 3: Version 1 data**

In the browser console, run:

```js
localStorage.setItem("opendsp-4x4.setup-draft", JSON.stringify({ ...JSON.parse(localStorage.getItem("opendsp-4x4.setup-draft")), version: 1, alignment: { enabled: true, tempC: 20, distancesM: [10, 10, 6.57, 0] } }))
```

Reload. Expected: Direct distances mode with 10, 10, 6.57 and a sub delay of about 9.99 ms. Then switch back to Positions.

- [ ] **Step 4: Tuning session**

With "2.1 Outdoor", alignment on, apply the setup. Then:
- "Fine-tune by ear…" is enabled; before applying, it says "Apply the setup first".
- Intro: warning, where to stand, Against Top L / Top R.
- Start: Overview shows Top R muted, Sub inverted; the undo button title says "Fine-tune Sub ↔ Top L"; Ctrl+Z does nothing.
- Later (Shift) and the field (wheel): delays on the Sub output change; a negative offset makes the tops' delay grow instead; the limits are -5 to +5 ms around the start.
- Done: mutes and polarity back, the Fine-tune column shows the offset, one undo step "Fine-tune Sub ↔ Top L"; Ctrl+Z restores the previous delays.
- Cancel in a second session: everything back, no new undo step.
- Start a session, reload the page, reconnect (mock): the "interrupted" notice appears; Restore puts mutes, polarity and delays back as one undo step "Restore after fine-tuning".

- [ ] **Step 5: Restore settings and stop**

Put back the Settings noted in Step 1, stop the dev server.

- [ ] **Step 6: Final checks**

Run: `cd web && npm test && npm run typecheck && npm run build`
Expected: all PASS; 0 errors, 0 warnings; build succeeds. `git status` shows only `docs/FIRMWARE.md` modified (not ours) besides any fixes, which get their own commit with explicit paths.

# Level Control (stages 1-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mouse-wheel level changes on hover (with a page-scroll guard), a custom gain fader on the device's level scale, a mixer-style Overview with master trim, mute all and solo, plus the browser settings store these controls read from.

**Architecture:** All logic lives in pure TypeScript modules with node unit tests (`state/settings.ts`, `ui/wheel.ts`, `ui/faderTaper.ts`, `state/solo.ts`, `state/trim.ts`); Svelte components stay thin and call the `device` store facade, which routes every edit through the existing `Editor` (undo, delivery tracking). Spec: `docs/superpowers/specs/2026-10-14-ui-ux-presets-levels-settings-design.md`, sections 2 and 3.1-3.2. Setup presets (stages 3-4) and the Settings tab (stage 5) get their own plans.

**Tech Stack:** Svelte 5 (runes), TypeScript 5.7, Vite 6, `node --test` with `--experimental-strip-types`.

## Global Constraints

- Work in `web/`. Run tests with `npm test` (all) or `node --experimental-strip-types --test test/<file>.test.ts` (one file); typecheck with `npm run typecheck` (fails on Svelte warnings).
- `.ts` files must be erasable TypeScript only: no parameter properties (`constructor(private x)`), no enums, no namespaces (node strips types, it does not compile them).
- No new dependencies.
- Logic that needs tests goes in `.ts` files; `.svelte.ts` (runes) and `.svelte` files are not loaded by tests.
- Comments only state constraints the code cannot show; match the surrounding style (short header comment per file).
- Settings are stored in `localStorage` key `opendsp-4x4.settings`; settings belong to the browser, not to a device.
- Gain range is -60 to +12 dB (device raw 0..400; 0.5 dB steps below -20 dB, 0.1 dB above).
- Wheel: Shift = x10, Alt = x0.1, Ctrl/Meta wheel is never taken; scroll guard window 400 ms.
- Default gain step per wheel notch / arrow press: 0.5 dB.

---

### Task 1: Settings schema and store, meter peak hold

**Files:**
- Create: `web/src/state/settings.ts`
- Create: `web/src/state/settings.svelte.ts`
- Modify: `web/src/ui/Meter.svelte`
- Test: `web/test/settings.test.ts`

**Interfaces:**
- Produces:
  - `interface Settings { version: 1; names: string[]; colors: string[]; hidden: number[]; gainStepDb: 0.1 | 0.5 | 1 | 3; freqStepDivisions: 30 | 12 | 6 | 3; eqWidth: "q" | "octaves"; eqRangeDb: 12 | 18 | 24; peakHoldMs: 0 | 1200 | 3000; theme: "dark" | "light" | "system"; density: "compact" | "comfortable" | "touch"; textSize: "small" | "normal" | "large"; distanceUnit: "m" | "ft"; temperatureUnit: "C" | "F"; gainCeilingDb: number | null; startView: "last" | "overview" }`
  - `defaultSettings(): Settings`, `parseSettings(raw: unknown): Settings`, `loadSettings(storage: StorageLike | null): Settings`, `saveSettings(storage: StorageLike | null, settings: Settings): boolean`
  - `interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }`
  - constants `SETTINGS_STORAGE_KEY`, `CHANNEL_PALETTE`, `GAIN_STEPS_DB`, `FREQ_STEP_DIVISIONS`, `EQ_RANGES_DB`, `PEAK_HOLDS_MS`, `NAME_MAX_LENGTH`, and the string option lists
  - `settings` store (from `settings.svelte.ts`): `settings.value: Settings` (reactive), `settings.update(patch: Partial<Settings>): void`, `settings.reset(): void`

- [ ] **Step 1: Write the failing test**

Create `web/test/settings.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHANNEL_PALETTE, SETTINGS_STORAGE_KEY, defaultSettings, loadSettings, parseSettings, saveSettings, type StorageLike,
} from "../src/state/settings.ts";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

test("default settings match the spec", () => {
  const settings = defaultSettings();
  assert.equal(settings.version, 1);
  assert.equal(settings.gainStepDb, 0.5);
  assert.equal(settings.freqStepDivisions, 30);
  assert.equal(settings.eqWidth, "q");
  assert.equal(settings.eqRangeDb, 18);
  assert.equal(settings.peakHoldMs, 1200);
  assert.equal(settings.theme, "dark");
  assert.equal(settings.density, "comfortable");
  assert.equal(settings.textSize, "normal");
  assert.equal(settings.distanceUnit, "m");
  assert.equal(settings.temperatureUnit, "C");
  assert.equal(settings.gainCeilingDb, null);
  assert.equal(settings.startView, "last");
  assert.deepEqual(settings.names, ["", "", "", "", "", "", "", ""]);
  assert.deepEqual(settings.colors, CHANNEL_PALETTE.slice(0, 8));
  assert.deepEqual(settings.hidden, []);
});

test("invalid fields fall back to their defaults one by one", () => {
  const settings = parseSettings({
    gainStepDb: 3,
    theme: "purple",
    peakHoldMs: 3000,
    names: ["Top L", 5, "  Sub  ", "a".repeat(40)],
    colors: ["#5ac2b4", "red"],
    hidden: [7, 7, 2, 9, -1, 1.5, "3"],
    gainCeilingDb: 50,
  });
  assert.equal(settings.gainStepDb, 3);
  assert.equal(settings.theme, "dark");
  assert.equal(settings.peakHoldMs, 3000);
  assert.deepEqual(settings.names.slice(0, 5), ["Top L", "", "Sub", "a".repeat(16), ""]);
  assert.equal(settings.colors[0], "#5ac2b4");
  assert.equal(settings.colors[1], CHANNEL_PALETTE[1]);
  assert.deepEqual(settings.hidden, [2, 7]);
  assert.equal(settings.gainCeilingDb, null, "outside the gain range");
});

test("anything that is not a settings object gives the defaults", () => {
  for (const raw of [undefined, null, 42, "x", [1]]) assert.deepEqual(parseSettings(raw), defaultSettings());
});

test("the gain ceiling is kept in 0.1 dB steps", () => {
  assert.equal(parseSettings({ gainCeilingDb: 3.04 }).gainCeilingDb, 3);
  assert.equal(parseSettings({ gainCeilingDb: -6 }).gainCeilingDb, -6);
  assert.equal(parseSettings({ gainCeilingDb: Number.NaN }).gainCeilingDb, null);
});

test("settings survive a save and load, and broken storage never throws", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadSettings(storage), defaultSettings());
  const changed = { ...defaultSettings(), gainStepDb: 1 as const };
  assert.equal(saveSettings(storage, changed), true);
  assert.equal(loadSettings(storage).gainStepDb, 1);

  storage.data.set(SETTINGS_STORAGE_KEY, "{not json");
  assert.deepEqual(loadSettings(storage), defaultSettings());
  assert.deepEqual(loadSettings(null), defaultSettings());
  assert.equal(saveSettings(null, changed), false);

  const broken: StorageLike = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("quota exceeded"); },
  };
  assert.deepEqual(loadSettings(broken), defaultSettings());
  assert.equal(saveSettings(broken, changed), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && node --experimental-strip-types --test test/settings.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/state/settings.ts`.

- [ ] **Step 3: Write the settings module**

Create `web/src/state/settings.ts`:

```ts
// Preferences of this browser (not device state), stored as JSON and validated field
// by field: a corrupt or outdated stored value only loses the fields that are wrong.
import { CHANNEL_COUNT } from "./model.ts";
import { GAIN_RANGE } from "./params.ts";

export const SETTINGS_STORAGE_KEY = "opendsp-4x4.settings";
export const SETTINGS_VERSION = 1;
export const NAME_MAX_LENGTH = 16;

export const GAIN_STEPS_DB = [0.1, 0.5, 1, 3] as const;
/** Frequency steps per octave (30 = the device's own resolution). */
export const FREQ_STEP_DIVISIONS = [30, 12, 6, 3] as const;
export const EQ_RANGES_DB = [12, 18, 24] as const;
export const PEAK_HOLDS_MS = [0, 1200, 3000] as const;
export const EQ_WIDTHS = ["q", "octaves"] as const;
export const THEMES = ["dark", "light", "system"] as const;
export const DENSITIES = ["compact", "comfortable", "touch"] as const;
export const TEXT_SIZES = ["small", "normal", "large"] as const;
export const DISTANCE_UNITS = ["m", "ft"] as const;
export const TEMPERATURE_UNITS = ["C", "F"] as const;
export const START_VIEWS = ["last", "overview"] as const;

/** Channel marker colours: the defaults of In A … Out 4, then four extras. */
export const CHANNEL_PALETTE = [
  "#d97aa6", "#d9925a", "#cfc05a", "#8fc25a", "#5aa7d9", "#7f8ad9", "#a97fd9", "#5ac2b4",
  "#e07a7a", "#c9c9c9", "#7ad9d0", "#b48a5a",
] as const;

export interface Settings {
  version: typeof SETTINGS_VERSION;
  /** Display name per channel address; "" = the device's name. */
  names: string[];
  colors: string[];
  /** Channel addresses left out of the tabs and the Overview. */
  hidden: number[];
  gainStepDb: (typeof GAIN_STEPS_DB)[number];
  freqStepDivisions: (typeof FREQ_STEP_DIVISIONS)[number];
  eqWidth: (typeof EQ_WIDTHS)[number];
  eqRangeDb: (typeof EQ_RANGES_DB)[number];
  peakHoldMs: (typeof PEAK_HOLDS_MS)[number];
  theme: (typeof THEMES)[number];
  density: (typeof DENSITIES)[number];
  textSize: (typeof TEXT_SIZES)[number];
  distanceUnit: (typeof DISTANCE_UNITS)[number];
  temperatureUnit: (typeof TEMPERATURE_UNITS)[number];
  /** Highest output gain the UI may set; null = no limit. */
  gainCeilingDb: number | null;
  startView: (typeof START_VIEWS)[number];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

function perChannel<T>(value: unknown, parse: (entry: unknown, index: number) => T): T[] {
  const list = Array.isArray(value) ? value : [];
  return Array.from({ length: CHANNEL_COUNT }, (_, index) => parse(list[index], index));
}

function parseName(entry: unknown): string {
  return typeof entry === "string" ? entry.trim().slice(0, NAME_MAX_LENGTH) : "";
}

function parseColor(entry: unknown, index: number): string {
  return oneOf<string>(entry, CHANNEL_PALETTE, CHANNEL_PALETTE[index]!);
}

function parseHidden(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const valid = value.filter((ch): ch is number => Number.isInteger(ch) && ch >= 0 && ch < CHANNEL_COUNT);
  return [...new Set(valid)].sort((a, b) => a - b);
}

function parseCeiling(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < GAIN_RANGE.min || value > GAIN_RANGE.max) return null;
  return Math.round(value * 10) / 10;
}

export function parseSettings(raw: unknown): Settings {
  const data = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    version: SETTINGS_VERSION,
    names: perChannel(data.names, parseName),
    colors: perChannel(data.colors, parseColor),
    hidden: parseHidden(data.hidden),
    gainStepDb: oneOf(data.gainStepDb, GAIN_STEPS_DB, 0.5),
    freqStepDivisions: oneOf(data.freqStepDivisions, FREQ_STEP_DIVISIONS, 30),
    eqWidth: oneOf(data.eqWidth, EQ_WIDTHS, "q"),
    eqRangeDb: oneOf(data.eqRangeDb, EQ_RANGES_DB, 18),
    peakHoldMs: oneOf(data.peakHoldMs, PEAK_HOLDS_MS, 1200),
    theme: oneOf(data.theme, THEMES, "dark"),
    density: oneOf(data.density, DENSITIES, "comfortable"),
    textSize: oneOf(data.textSize, TEXT_SIZES, "normal"),
    distanceUnit: oneOf(data.distanceUnit, DISTANCE_UNITS, "m"),
    temperatureUnit: oneOf(data.temperatureUnit, TEMPERATURE_UNITS, "C"),
    gainCeilingDb: parseCeiling(data.gainCeilingDb),
    startView: oneOf(data.startView, START_VIEWS, "last"),
  };
}

export function defaultSettings(): Settings {
  return parseSettings(undefined);
}

/** Never throws: unreadable or corrupt storage gives the defaults. */
export function loadSettings(storage: StorageLike | null): Settings {
  if (!storage) return defaultSettings();
  try {
    const text = storage.getItem(SETTINGS_STORAGE_KEY);
    return parseSettings(text === null ? undefined : JSON.parse(text));
  } catch {
    return defaultSettings();
  }
}

/** False when the settings could not be stored (no storage, quota, privacy mode). */
export function saveSettings(storage: StorageLike | null, settings: Settings): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && node --experimental-strip-types --test test/settings.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the reactive store**

Create `web/src/state/settings.svelte.ts`:

```ts
// Reactive browser settings, saved to localStorage on every change.
import { defaultSettings, loadSettings, parseSettings, saveSettings, type Settings, type StorageLike } from "./settings.ts";

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage access denied (privacy settings)
  }
}

class SettingsStore {
  private readonly storage = browserStorage();
  value = $state<Settings>(loadSettings(this.storage));

  update(patch: Partial<Settings>): void {
    this.value = parseSettings({ ...$state.snapshot(this.value), ...patch });
    saveSettings(this.storage, this.value);
  }

  reset(): void {
    this.value = defaultSettings();
    saveSettings(this.storage, this.value);
  }
}

export const settings = new SettingsStore();
```

- [ ] **Step 6: Read the peak hold from settings in the meter**

In `web/src/ui/Meter.svelte`, replace the script's header comment, imports and peak logic:

```svelte
<script lang="ts">
  // Level meter for a 0..1 reading (linear in dB between the device's floor and full
  // scale), with a peak hold whose duration comes from the settings (0 = no peak).
  import { untrack } from "svelte";
  import { settings } from "../state/settings.svelte.ts";

  interface Props {
    level: number;
    orientation?: "vertical" | "horizontal";
    title?: string;
  }

  let { level, orientation = "vertical", title }: Props = $props();

  const PEAK_FALL_PER_UPDATE = 0.04;

  let peak = $state(0);
  let peakAt = 0;

  const holdMs = $derived(settings.value.peakHoldMs);
  const clamped = $derived(Math.max(0, Math.min(1, level)));
  const percent = $derived(clamped * 100);
  const zone = $derived(clamped > 0.9 ? "hi" : clamped > 0.7 ? "mid" : "lo");

  $effect(() => {
    const current = clamped;
    const now = performance.now();
    const held = untrack(() => peak);
    if (current >= held) {
      peak = current;
      peakAt = now;
    } else if (now - peakAt > untrack(() => holdMs)) {
      peak = Math.max(current, held - PEAK_FALL_PER_UPDATE);
    }
  });
</script>
```

and change the peak condition in the markup from `{#if peak > 0.02}` to:

```svelte
  {#if holdMs > 0 && peak > 0.02}
```

(The `<style>` block and the rest of the markup stay as they are.)

- [ ] **Step 7: Typecheck and run all tests**

Run: `cd web && npm run typecheck && npm test`
Expected: typecheck reports 0 errors and 0 warnings; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add web/src/state/settings.ts web/src/state/settings.svelte.ts web/src/ui/Meter.svelte web/test/settings.test.ts
git commit -m "state: browser settings store (validated per field), meter peak hold from settings"
```

---

### Task 2: Wheel helper, hover wheel on numeric fields and EQ handles

**Files:**
- Create: `web/src/ui/wheel.ts`
- Modify: `web/src/ui/NumberField.svelte` (header comment, wheel handling at lines 99-110)
- Modify: `web/src/channel/EqGraph.svelte` (wheel handling at lines 104-121)
- Test: `web/test/wheel.test.ts`

**Interfaces:**
- Produces:
  - `interface WheelSample { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }` (a `WheelEvent` satisfies it)
  - `wheelPixels(event: WheelSample): number` (positive = wheel up = increase)
  - `wheelMultiplier(event: Pick<WheelSample, "shiftKey" | "altKey">): number`
  - `class ScrollGuard { constructor(now?: () => number, windowMs?: number); noteScroll(): void; get scrolling(): boolean }`
  - `class WheelController { constructor(guard: ScrollGuard, now?: () => number); handle(event: WheelSample): { consume: boolean; steps: number; multiplier: number } }`
  - `interface WheelTarget { accepts?(event: WheelEvent): boolean; step(steps: number, multiplier: number, event: WheelEvent): void }`
  - `attachWheel(element: Element, target: WheelTarget): () => void` (returns the cleanup; use as `$effect(() => attachWheel(el, {...}))`)
  - constants `LINE_PX = 40`, `PAGE_PX = 800`, `NOTCH_PX = 50`, `ACCUMULATOR_RESET_MS = 300`, `SCROLL_GUARD_MS = 400`

- [ ] **Step 1: Write the failing test**

Create `web/test/wheel.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCUMULATOR_RESET_MS, SCROLL_GUARD_MS, ScrollGuard, WheelController, wheelMultiplier, wheelPixels, type WheelSample,
} from "../src/ui/wheel.ts";

const sample = (patch: Partial<WheelSample>): WheelSample => ({
  deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...patch,
});

function setup() {
  let now = 1000;
  const clock = () => now;
  const guard = new ScrollGuard(clock);
  const controller = new WheelController(guard, clock);
  return { guard, controller, advance: (ms: number) => { now += ms; } };
}

test("wheel deltas become upward pixels in every delta mode", () => {
  assert.equal(wheelPixels(sample({ deltaY: -100 })), 100);
  assert.equal(wheelPixels(sample({ deltaY: 3, deltaMode: 1 })), -120);
  assert.equal(wheelPixels(sample({ deltaY: 1, deltaMode: 2 })), -800);
  assert.equal(wheelPixels(sample({ deltaX: 100, shiftKey: true })), -100, "Shift+wheel reported as horizontal");
});

test("Shift is coarse and Alt is fine", () => {
  assert.equal(wheelMultiplier({ shiftKey: true, altKey: false }), 10);
  assert.equal(wheelMultiplier({ shiftKey: false, altKey: true }), 0.1);
  assert.equal(wheelMultiplier({ shiftKey: false, altKey: false }), 1);
});

test("each mouse-wheel notch is one step, whatever its size", () => {
  const { controller, advance } = setup();
  assert.deepEqual(controller.handle(sample({ deltaY: -100 })), { consume: true, steps: 1, multiplier: 1 });
  advance(50);
  assert.equal(controller.handle(sample({ deltaY: -53 })).steps, 1);
  advance(50);
  assert.equal(controller.handle(sample({ deltaY: 3, deltaMode: 1 })).steps, -1);
  advance(50);
  assert.deepEqual(controller.handle(sample({ deltaY: -100, shiftKey: true })), { consume: true, steps: 1, multiplier: 10 });
});

test("small trackpad deltas add up to steps", () => {
  const { controller, advance } = setup();
  const steps: number[] = [];
  for (let i = 0; i < 10; i++) {
    steps.push(controller.handle(sample({ deltaY: -12 })).steps);
    advance(16);
  }
  assert.equal(steps.reduce((sum, s) => sum + s, 0), 2, "120 px is two 50 px steps");
  assert.ok(steps.every((s) => s === 0 || s === 1));
});

test("the trackpad remainder is dropped after a pause or a change of direction", () => {
  const { controller, advance } = setup();
  controller.handle(sample({ deltaY: -40 }));
  advance(ACCUMULATOR_RESET_MS + 1);
  assert.equal(controller.handle(sample({ deltaY: -40 })).steps, 0, "40 + 40 would be a step without the reset");
  advance(10);
  assert.equal(controller.handle(sample({ deltaY: 40 })).steps, 0, "reversing starts from zero");
  advance(10);
  assert.equal(controller.handle(sample({ deltaY: 40 })).steps, -1);
});

test("wheel input is left to the page while the page is scrolling", () => {
  const { guard, controller, advance } = setup();
  guard.noteScroll();
  advance(SCROLL_GUARD_MS - 1);
  assert.deepEqual(controller.handle(sample({ deltaY: -100 })), { consume: false, steps: 0, multiplier: 1 });
  advance(2);
  assert.equal(controller.handle(sample({ deltaY: -100 })).consume, true);
});

test("Ctrl and Meta wheel (browser zoom, pinch) are never taken", () => {
  const { controller } = setup();
  assert.equal(controller.handle(sample({ deltaY: -100, ctrlKey: true })).consume, false);
  assert.equal(controller.handle(sample({ deltaY: -100, metaKey: true })).consume, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && node --experimental-strip-types --test test/wheel.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/ui/wheel.ts`.

- [ ] **Step 3: Write the wheel module**

Create `web/src/ui/wheel.ts`:

```ts
// Mouse-wheel adjustment of the control under the pointer (no focus needed). While
// the page is scrolling, wheel events are left to the page so scrolling past a fader
// does not change it. A mouse notch is one step; small trackpad deltas add up.

export const LINE_PX = 40;
export const PAGE_PX = 800;
/** A pixel delta this large is one mouse-wheel notch; smaller ones (trackpads) accumulate. */
export const NOTCH_PX = 50;
export const ACCUMULATOR_RESET_MS = 300;
export const SCROLL_GUARD_MS = 400;

export interface WheelSample {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export interface WheelDecision {
  /** The event belongs to the control (prevent the page from scrolling). */
  consume: boolean;
  steps: number;
  multiplier: number;
}

type Clock = () => number;
const defaultClock: Clock = () => performance.now();

/** Movement in pixels, positive for wheel up (increase). Shift+wheel may arrive as deltaX. */
export function wheelPixels(event: WheelSample): number {
  const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
  const scale = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? PAGE_PX : 1;
  return -delta * scale;
}

export function wheelMultiplier(event: Pick<WheelSample, "shiftKey" | "altKey">): number {
  if (event.shiftKey) return 10;
  if (event.altKey) return 0.1;
  return 1;
}

export class ScrollGuard {
  private readonly now: Clock;
  private readonly windowMs: number;
  private lastScrollAt = Number.NEGATIVE_INFINITY;

  constructor(now: Clock = defaultClock, windowMs = SCROLL_GUARD_MS) {
    this.now = now;
    this.windowMs = windowMs;
  }

  noteScroll(): void {
    this.lastScrollAt = this.now();
  }

  get scrolling(): boolean {
    return this.now() - this.lastScrollAt < this.windowMs;
  }
}

export class WheelController {
  private readonly guard: ScrollGuard;
  private readonly now: Clock;
  private total = 0;
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(guard: ScrollGuard, now: Clock = defaultClock) {
    this.guard = guard;
    this.now = now;
  }

  handle(event: WheelSample): WheelDecision {
    const multiplier = wheelMultiplier(event);
    if (event.ctrlKey || event.metaKey || this.guard.scrolling) return { consume: false, steps: 0, multiplier };
    const pixels = wheelPixels(event);
    const at = this.now();
    if (at - this.lastAt > ACCUMULATOR_RESET_MS || Math.sign(pixels) !== Math.sign(this.total)) this.total = 0;
    this.lastAt = at;
    if (Math.abs(pixels) >= NOTCH_PX) {
      this.total = 0;
      return { consume: true, steps: Math.sign(pixels), multiplier };
    }
    this.total += pixels;
    const steps = Math.trunc(this.total / NOTCH_PX);
    this.total -= steps * NOTCH_PX;
    return { consume: true, steps, multiplier };
  }
}

export const scrollGuard = new ScrollGuard();
let guardInstalled = false;

function installScrollGuard(): void {
  if (guardInstalled || typeof document === "undefined") return;
  guardInstalled = true;
  // scroll does not bubble: listen in the capture phase to see every scroll container
  document.addEventListener("scroll", () => scrollGuard.noteScroll(), { capture: true, passive: true });
}

export interface WheelTarget {
  /** Whether this event is for the control (default: always). */
  accepts?(event: WheelEvent): boolean;
  step(steps: number, multiplier: number, event: WheelEvent): void;
}

/** Listen for wheel events on `element`; returns the cleanup (fits a Svelte $effect). */
export function attachWheel(element: Element, target: WheelTarget): () => void {
  installScrollGuard();
  const controller = new WheelController(scrollGuard);
  const onWheel = (event: Event): void => {
    const wheel = event as WheelEvent;
    if (target.accepts && !target.accepts(wheel)) return;
    const decision = controller.handle(wheel);
    if (!decision.consume) return;
    wheel.preventDefault();
    if (decision.steps !== 0) target.step(decision.steps, decision.multiplier, wheel);
  };
  element.addEventListener("wheel", onWheel, { passive: false });
  return () => element.removeEventListener("wheel", onWheel);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && node --experimental-strip-types --test test/wheel.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Use the hover wheel in NumberField**

In `web/src/ui/NumberField.svelte`:

Replace the header comment (lines 2-5) with:

```svelte
  // Numeric entry: type a value (Enter commits, Escape reverts), ArrowUp/Down or the
  // wheel (hovering is enough) to step — Shift ×10, Alt ×0.1 — or drag vertically with
  // a mouse. Linear or logarithmic stepping. The value is one-way: changes go out
  // through onchange and come back (normalized) through `value`.
```

Add the import after `import { parseNumber } from "./format.ts";`:

```ts
  import { attachWheel } from "./wheel.ts";
```

Replace the `onWheel` function and its `$effect` (lines 99-110) with:

```ts
  $effect(() => attachWheel(input, {
    accepts: () => !disabled,
    step: (steps, multiplier) => {
      draft = null;
      emit(stepBy(value, steps * multiplier));
      void resync();
    },
  }));
```

- [ ] **Step 6: Use the wheel helper for Q on EQ handles**

In `web/src/channel/EqGraph.svelte`:

Add the import after `import { GAINLESS_PEQ_TYPES } from "../ui/labels.ts";`:

```ts
  import { attachWheel } from "../ui/wheel.ts";
```

Replace the `onWheel` function and its `$effect` (lines 104-121) with:

```ts
  const handleOf = (event: Event) => (event.target as Element).closest<SVGGElement>("[data-band]");

  /** Wheel over a band handle changes that band's Q (elsewhere the page scrolls normally). */
  $effect(() => attachWheel(svg, {
    accepts: (event) => handleOf(event) !== null,
    step: (steps, multiplier, event) => {
      const index = Number(handleOf(event)!.dataset.band);
      const band = eq.bands[index];
      if (!band) return;
      onselect(index);
      const q = bwOctToQ(band.bwOct, band.freqHz);
      const next = Math.max(Q_MIN, Math.min(Q_MAX, q * Math.pow(WHEEL_Q_FACTOR, steps * multiplier)));
      onband(index, { ...band, bwOct: qToBwOct(next, band.freqHz) });
    },
  }));
```

- [ ] **Step 7: Typecheck and run all tests**

Run: `cd web && npm run typecheck && npm test`
Expected: 0 errors, 0 warnings; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add web/src/ui/wheel.ts web/test/wheel.test.ts web/src/ui/NumberField.svelte web/src/channel/EqGraph.svelte
git commit -m "ui: wheel adjusts the control under the pointer, with a page-scroll guard"
```

---

### Task 3: Gain scale, Fader component, channel page fader

**Files:**
- Modify: `web/src/protocol/control.ts:34-39` (split out the continuous curve)
- Create: `web/src/ui/faderTaper.ts`
- Create: `web/src/ui/Fader.svelte`
- Modify: `web/src/ui/NumberField.svelte` (add `stepper` prop)
- Modify: `web/src/channel/ChannelControls.svelte` (replace the native range input)
- Test: `web/test/fader.test.ts`

**Interfaces:**
- Consumes: `attachWheel` (Task 2), `settings.value.gainStepDb` (Task 1).
- Produces:
  - `gainDbToRawContinuous(db: number): number` in `protocol/control.ts`
  - `dbToPosition(db: number): number` (0..1), `positionToDb(position: number): number`, `stepGainDb(db: number, deltaDb: number): number`, `FADER_TICKS_DB` in `ui/faderTaper.ts`
  - `Fader.svelte` props: `value: number; onchange(db: number): void; onend(): void; step: number; label: string; orientation?: "horizontal" | "vertical"; ticks?: boolean; status?: SyncEntry; warn?: boolean`
  - `NumberField.svelte` new optional prop `stepper?: (from: number, delta: number) => number` (replaces `from + delta` for linear fields)

- [ ] **Step 1: Write the failing test**

Create `web/test/fader.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && node --experimental-strip-types --test test/fader.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/ui/faderTaper.ts`.

- [ ] **Step 3: Expose the continuous gain curve**

In `web/src/protocol/control.ts`, replace `gainDbToRaw` (lines 34-39) with:

```ts
/** Unrounded raw level for a dB value (the fader uses it as its travel). */
export function gainDbToRawContinuous(db: number): number {
  return db >= gainRawToDb(GAIN_KNEE_RAW)
    ? GAIN_ZERO_DB + db * GAIN_UNITS_PER_DB
    : (db - GAIN_MIN_DB) * GAIN_LOW_UNITS_PER_DB;
}
export function gainDbToRaw(db: number): number {
  return Math.max(0, Math.min(GAIN_MAX_RAW, Math.round(gainDbToRawContinuous(db))));
}
```

- [ ] **Step 4: Write the taper module**

Create `web/src/ui/faderTaper.ts`:

```ts
// Gain fader geometry: travel follows the device's own level scale (raw 0..400), so
// 0 dB sits at 70 % and the coarse range below -20 dB takes the bottom fifth.
import { GAIN_MAX_RAW, gainDbToRaw, gainDbToRawContinuous, gainRawToDb } from "../protocol/control.ts";

export const FADER_TICKS_DB = [12, 6, 0, -6, -12, -20, -40, -60] as const;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function dbToPosition(db: number): number {
  return clamp01(gainDbToRawContinuous(db) / GAIN_MAX_RAW);
}

export function positionToDb(position: number): number {
  return gainRawToDb(clamp01(position) * GAIN_MAX_RAW);
}

/** Step a gain by deltaDb; a step that would round back to the same device value moves one device step instead. */
export function stepGainDb(db: number, deltaDb: number): number {
  if (deltaDb === 0) return db;
  const fromRaw = gainDbToRaw(db);
  let raw = gainDbToRaw(db + deltaDb);
  if (raw === fromRaw) raw = fromRaw + Math.sign(deltaDb);
  return gainRawToDb(Math.max(0, Math.min(GAIN_MAX_RAW, raw)));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && node --experimental-strip-types --test test/fader.test.ts && npm test`
Expected: PASS, 4 tests in `fader.test.ts`; the full suite still passes (the `gainDbToRaw` split is behaviour-preserving).

- [ ] **Step 6: Add the `stepper` prop to NumberField**

In `web/src/ui/NumberField.svelte`, add to `interface Props` after `log?: boolean;`:

```ts
    /** Linear stepping rule (e.g. gain, whose device resolution changes with the value); default from + delta. */
    stepper?: (from: number, delta: number) => number;
```

Change the props destructuring to include it:

```ts
  let {
    value, onchange, onend, min, max, step, log = false, stepper, format, unit = "", label = "", ariaLabel,
    status, disabled = false, width = "88px",
  }: Props = $props();
```

Replace the `stepBy` line with:

```ts
  const stepBy = (from: number, steps: number) => clamp(
    log ? from * Math.pow(step, steps) : stepper ? stepper(from, steps * step) : from + steps * step,
  );
```

- [ ] **Step 7: Write the Fader component**

Create `web/src/ui/Fader.svelte`:

```svelte
<script lang="ts">
  // Gain fader on the device's own level scale (0 dB at 70 % of travel). Drag the thumb
  // (Alt = fine), click the track to jump there (mouse/pen; touch always drags from the
  // current value), wheel over it, arrows / PageUp / PageDown to step, double-click for
  // 0 dB. One-way like NumberField: changes go out through onchange, come back via value.
  import type { SyncEntry } from "../state/editor.ts";
  import { GAIN_RANGE } from "../state/params.ts";
  import { FADER_TICKS_DB, dbToPosition, positionToDb, stepGainDb } from "./faderTaper.ts";
  import { attachWheel } from "./wheel.ts";
  import { formatDb } from "./format.ts";

  interface Props {
    value: number;
    onchange: (db: number) => void;
    /** Gesture finished (pointer up, double-click): splits undo steps. */
    onend: () => void;
    /** dB per wheel notch or arrow press. */
    step: number;
    /** Accessible name. */
    label: string;
    orientation?: "horizontal" | "vertical";
    /** dB scale beside the track (vertical only). */
    ticks?: boolean;
    status?: SyncEntry;
    /** The value is above a user limit. */
    warn?: boolean;
  }

  let { value, onchange, onend, step, label, orientation = "horizontal", ticks = false, status, warn = false }: Props = $props();

  const PAGE_STEPS = 10;
  const FINE_DRAG = 0.1;
  const THUMB_GRAB_PX = 10;
  const KEY_STEPS: Readonly<Record<string, number>> = {
    ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: PAGE_STEPS, PageDown: -PAGE_STEPS,
  };

  let track: HTMLDivElement;
  let drag: { pointerId: number; startPosition: number; startCoord: number; length: number } | null = null;

  const vertical = $derived(orientation === "vertical");
  const position = $derived(dbToPosition(value));
  const percent = $derived(`${(position * 100).toFixed(2)}%`);
  const title = $derived(
    status?.status === "failed" ? `Not applied on the device: ${status.error ?? "write failed"}`
      : status?.status === "offline" ? "Not sent: device offline" : undefined,
  );

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

  function emit(db: number): void {
    if (Number.isFinite(db) && db !== value) onchange(db);
  }

  /** Pointer coordinate along the travel, growing toward the top (vertical) or the right. */
  function coord(event: PointerEvent): number {
    return vertical ? -event.clientY : event.clientX;
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    track.focus();
    const rect = track.getBoundingClientRect();
    const length = Math.max(1, vertical ? rect.height : rect.width);
    const pointed = clamp01(vertical ? (rect.bottom - event.clientY) / length : (event.clientX - rect.left) / length);
    const grab = event.pointerType === "touch" || Math.abs(pointed - position) * length <= THUMB_GRAB_PX;
    const startPosition = grab ? position : pointed;
    if (!grab) emit(positionToDb(startPosition));
    drag = { pointerId: event.pointerId, startPosition, startCoord: coord(event), length };
    try {
      track.setPointerCapture(event.pointerId);
    } catch {
      // pointer already released (or synthetic): moves over the track still adjust it
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const scale = event.altKey ? FINE_DRAG : 1;
    emit(positionToDb(clamp01(drag.startPosition + ((coord(event) - drag.startCoord) / drag.length) * scale)));
  }

  function onPointerUp(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    onend();
  }

  function onDoubleClick(): void {
    emit(0);
    onend();
  }

  function onKeydown(event: KeyboardEvent): void {
    const steps = KEY_STEPS[event.key];
    if (steps === undefined) return;
    event.preventDefault();
    emit(stepGainDb(value, steps * step));
  }

  $effect(() => attachWheel(track, {
    step: (steps, multiplier) => emit(stepGainDb(value, steps * multiplier * step)),
  }));
</script>

<div class="fader {orientation}" class:warn data-status={status?.status} {title}>
  {#if ticks && vertical}
    <div class="ticks" aria-hidden="true">
      {#each FADER_TICKS_DB as db (db)}
        <span style:bottom="{dbToPosition(db) * 100}%">{db > 0 ? `+${db}` : db}</span>
      {/each}
    </div>
  {/if}
  <div
    bind:this={track}
    class="track"
    role="slider"
    tabindex="0"
    aria-label={label}
    aria-orientation={orientation}
    aria-valuemin={GAIN_RANGE.min}
    aria-valuemax={GAIN_RANGE.max}
    aria-valuenow={value}
    aria-valuetext="{formatDb(value)} dB"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    ondblclick={onDoubleClick}
    onkeydown={onKeydown}
  >
    <div class="rail"></div>
    <div class="fill" style:height={vertical ? percent : null} style:width={vertical ? null : percent}></div>
    <div class="thumb" style:bottom={vertical ? percent : null} style:left={vertical ? null : percent}></div>
  </div>
</div>

<style>
  .fader { display: flex; min-width: 0; }
  .fader.horizontal { width: 100%; height: var(--control-h); }
  .fader.vertical { height: 100%; gap: 2px; }
  .track { position: relative; flex: 1; touch-action: none; cursor: pointer; outline-offset: 2px; }
  .vertical .track { flex: none; width: 22px; }
  .rail, .fill { position: absolute; border-radius: 2px; }
  .rail { background: var(--surface-3); }
  .fill { background: var(--accent-dim); }
  .horizontal .rail { left: 0; right: 0; top: 50%; height: 4px; transform: translateY(-50%); }
  .horizontal .fill { left: 0; top: 50%; height: 4px; transform: translateY(-50%); }
  .vertical .rail { top: 0; bottom: 0; left: 50%; width: 4px; transform: translateX(-50%); }
  .vertical .fill { bottom: 0; left: 50%; width: 4px; transform: translateX(-50%); }
  .thumb { position: absolute; background: var(--surface-3); border: 1px solid var(--text-dim); border-radius: 2px; }
  .horizontal .thumb { top: 50%; width: 12px; height: 20px; transform: translate(-50%, -50%); }
  .vertical .thumb { left: 50%; width: 22px; height: 10px; transform: translate(-50%, 50%); }
  .track:focus-visible .thumb, .track:active .thumb { border-color: var(--accent); }
  .fader[data-status="pending"] .fill { background: var(--accent); }
  .fader[data-status="offline"] .thumb { border-color: var(--warn); }
  .fader[data-status="failed"] .thumb { border-color: var(--bad); }
  .fader.warn .fill { background: var(--warn); }
  .ticks { position: relative; width: 22px; font: 9px var(--font-mono); color: var(--text-faint); }
  .ticks span { position: absolute; right: 0; line-height: 1; transform: translateY(50%); }
</style>
```

- [ ] **Step 8: Use the Fader on channel pages**

Replace `web/src/channel/ChannelControls.svelte` with:

```svelte
<script lang="ts">
  // Gain fader + field, mute, polarity and level meter for one channel.
  import { device } from "../state/device.svelte.ts";
  import { settings } from "../state/settings.svelte.ts";
  import { GAIN_RANGE } from "../state/params.ts";
  import Fader from "../ui/Fader.svelte";
  import NumberField from "../ui/NumberField.svelte";
  import Toggle from "../ui/Toggle.svelte";
  import Meter from "../ui/Meter.svelte";
  import { stepGainDb } from "../ui/faderTaper.ts";
  import { formatDb } from "../ui/format.ts";

  let { ch }: { ch: number } = $props();
  const channel = $derived(device.ch(ch));
  const gainStatus = $derived(device.syncOf({ kind: "gain", ch }));
  const gainStep = $derived(settings.value.gainStepDb);
</script>

<div class="controls">
  <div class="gain">
    <span class="label">Gain</span>
    <div class="fader">
      <Fader value={channel.gainDb} step={gainStep} label="{channel.name} gain" status={gainStatus}
             onchange={(db) => device.setGainDb(ch, db)} onend={() => device.seal()} />
    </div>
    <NumberField value={channel.gainDb} min={GAIN_RANGE.min} max={GAIN_RANGE.max} step={gainStep} stepper={stepGainDb}
                 format={(v) => formatDb(v)} unit="dB" status={gainStatus} ariaLabel="{channel.name} gain value"
                 onchange={(db) => device.setGainDb(ch, db)} onend={() => device.seal()} />
  </div>
  <div class="toggles">
    <Toggle pressed={channel.mute} tone="bad" title="Mute {channel.name}" status={device.syncOf({ kind: "mute", ch })}
            onchange={(on) => device.setMute(ch, on)}>Mute</Toggle>
    <Toggle pressed={channel.polarity} tone="warn" title="Invert polarity of {channel.name}" status={device.syncOf({ kind: "polarity", ch })}
            onchange={(invert) => device.setPolarity(ch, invert)}>Ø</Toggle>
  </div>
  <div class="meter" title="Level">
    <span class="label">Level</span>
    <Meter level={device.meters[ch] ?? 0} orientation="horizontal" />
  </div>
</div>

<style>
  .controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 16px; }
  .gain { display: flex; align-items: center; gap: 8px; flex: 1 1 320px; min-width: 0; }
  .fader { flex: 1; min-width: 80px; }
  .toggles { display: flex; gap: 6px; }
  .meter { display: flex; align-items: center; gap: 8px; flex: 0 1 180px; min-width: 120px; height: var(--control-h); }
</style>
```

- [ ] **Step 9: Typecheck and run all tests**

Run: `cd web && npm run typecheck && npm test`
Expected: 0 errors, 0 warnings; all tests pass.

- [ ] **Step 10: Commit**

```bash
git add web/src/protocol/control.ts web/src/ui/faderTaper.ts web/src/ui/Fader.svelte web/src/ui/NumberField.svelte web/src/channel/ChannelControls.svelte web/test/fader.test.ts
git commit -m "ui: gain fader on the device level scale; gain steps never stick below -20 dB"
```

---

### Task 4: Group actions on outputs (merge key, mute all, solo, trim)

**Files:**
- Modify: `web/src/state/editor.ts:86-97` (`setMany` merge key)
- Create: `web/src/state/solo.ts`
- Create: `web/src/state/trim.ts`
- Modify: `web/src/state/device.svelte.ts` (new state and actions)
- Modify: `web/src/shell/TopBar.svelte` (Mute all button)
- Modify: `web/src/shell/ChannelTabs.svelte` (solo badge)
- Test: `web/test/outputs.test.ts`, `web/test/state.test.ts` (append one editor test)

**Interfaces:**
- Consumes: `Editor.setMany`, `ParamAssignment`, `DeviceModel`, `OUT_BASE`, `OUTPUT_COUNT`, `GAIN_RANGE`.
- Produces:
  - `Editor.setMany(label: string, assignments: ParamAssignment[], options?: { mergeKey?: string }): Promise<boolean>`
  - `type MuteSnapshot = (boolean | null)[]`; `outputMutes(model: DeviceModel): MuteSnapshot`; `muteAllAssignments(): ParamAssignment[]`; `restoreAssignments(snapshot: MuteSnapshot | null): ParamAssignment[]`; `soloAssignments(soloed: ReadonlySet<number>): ParamAssignment[]` in `state/solo.ts`
  - `trimmedGains(base: readonly number[], offsetDb: number, maxDb?: number): { gains: number[]; clamped: boolean }` in `state/trim.ts`
  - `device.soloed: number[]` (reactive), `device.allOutputsMuted: boolean`, `device.trimOutputs(gains: readonly number[]): void`, `device.muteAll(): void`, `device.unmuteAll(): void`, `device.toggleSolo(ch: number): void`

- [ ] **Step 1: Write the failing editor test**

Append to `web/test/state.test.ts` (after the existing editor tests; `editorWithDevice`, `OUT1`, `OUT2` are already defined in that file):

```ts
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
```

- [ ] **Step 2: Write the failing group-action tests**

Create `web/test/outputs.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd web && node --experimental-strip-types --test test/outputs.test.ts test/state.test.ts`
Expected: `outputs.test.ts` FAILS with `ERR_MODULE_NOT_FOUND` for `src/state/solo.ts`; in `state.test.ts` the new test FAILS (second undo leaves Out 1 at -1 instead of 0).

- [ ] **Step 4: Add the merge key to `setMany`**

In `web/src/state/editor.ts`, replace the `setMany` doc comment and signature, and its `record` call:

```ts
  /** Several edits as one undo step (copy EQ, file import, group actions). With a merge key,
   *  consecutive calls with the same key extend that step until seal(). Null values are left untouched. */
  setMany(label: string, assignments: ParamAssignment[], options: { mergeKey?: string } = {}): Promise<boolean> {
    const normalized = assignments
      .filter((assignment) => assignment.value !== null)
      .map(({ ref, value }) => ({ ref, value: normalizeParam(ref, value as ParamValue, this.deps.cal) }));
    const sends: Promise<boolean>[] = [];
    const changes = normalized.flatMap(({ ref, value }) => this.apply(ref, value, sends));
    if (changes.length === 0) return Promise.resolve(true);
    this.history.record(label, changes, options.mergeKey);
    this.touch();
    return allSucceeded(sends);
  }
```

- [ ] **Step 5: Write the solo and trim modules**

Create `web/src/state/solo.ts`:

```ts
// Group mute actions on the four outputs (mute all / unmute all, solo) as parameter
// assignments the editor applies in one undo step.
import { OUT_BASE, OUTPUT_COUNT, type DeviceModel } from "./model.ts";
import type { ParamAssignment } from "./params.ts";

/** Mute state of Out 1..4; null = unknown (the device has no mute readback). */
export type MuteSnapshot = (boolean | null)[];

const OUTPUTS = Array.from({ length: OUTPUT_COUNT }, (_, i) => OUT_BASE + i);
const mute = (ch: number, on: boolean): ParamAssignment => ({ ref: { kind: "mute", ch }, value: on });

export function outputMutes(model: DeviceModel): MuteSnapshot {
  return OUTPUTS.map((ch) => model.channels[ch]!.mute);
}

export function muteAllAssignments(): ParamAssignment[] {
  return OUTPUTS.map((ch) => mute(ch, true));
}

/** Back to a snapshot; unknown entries, or no snapshot at all, become unmuted. */
export function restoreAssignments(snapshot: MuteSnapshot | null): ParamAssignment[] {
  return OUTPUTS.map((ch, i) => mute(ch, snapshot?.[i] ?? false));
}

/** Soloed outputs play; every other output is muted. */
export function soloAssignments(soloed: ReadonlySet<number>): ParamAssignment[] {
  return OUTPUTS.map((ch) => mute(ch, !soloed.has(ch)));
}
```

Create `web/src/state/trim.ts`:

```ts
// Shifting all output gains by one offset while keeping their differences. Each gain
// is clamped to the device range (or a lower ceiling) and the caller learns if any was.
import { GAIN_RANGE } from "./params.ts";

export function trimmedGains(base: readonly number[], offsetDb: number, maxDb: number = GAIN_RANGE.max): { gains: number[]; clamped: boolean } {
  let clamped = false;
  const gains = base.map((db) => {
    const target = db + offsetDb;
    const limited = Math.min(maxDb, Math.max(GAIN_RANGE.min, target));
    if (limited !== target) clamped = true;
    return limited;
  });
  return { gains, clamped };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd web && node --experimental-strip-types --test test/outputs.test.ts test/state.test.ts`
Expected: PASS (4 tests in `outputs.test.ts`; every test in `state.test.ts`, including the new one).

- [ ] **Step 7: Add the group actions to the device store**

In `web/src/state/device.svelte.ts`:

Change the params and model imports to:

```ts
import { paramKey, describeParam, type ParamAssignment, type ParamRef, type ParamValue } from "./params.ts";
import { CHANNEL_COUNT, DEFAULT_BAND_FREQS, OUT_BASE, defaultBand, defaultModel, type Channel, type Compressor, type Gate } from "./model.ts";
import { muteAllAssignments, outputMutes, restoreAssignments, soloAssignments, type MuteSnapshot } from "./solo.ts";
```

Add after `selected = $state(-1); // selected channel index; -1 = nothing open`:

```ts
  /** Soloed outputs (addresses); while non-empty every other output is muted. */
  soloed = $state<number[]>([]);
  private soloSnapshot: MuteSnapshot | null = null;
  private muteAllSnapshot: MuteSnapshot | null = null;
```

In the constructor, change the `ended` callback to:

```ts
      ended: () => {
        this.stopMeters();
        this.clearSolo();
      },
```

Add after the `get unsynced()` getter:

```ts
  get allOutputsMuted(): boolean { return outputMutes(this.edit.model).every((mute) => mute === true); }
```

Replace the `setMute` line with:

```ts
  setMute(ch: number, on: boolean): void {
    this.muteAllSnapshot = null;
    this.change({ kind: "mute", ch }, on);
  }
```

Replace the `undo` and `redo` lines with:

```ts
  undo(): void {
    this.clearSolo();
    void this.editor.undo();
  }
  redo(): void {
    this.clearSolo();
    void this.editor.redo();
  }
```

Add a new section before `// --- presets ---`:

```ts
  // --- output group actions ---

  /** New gains for Out 1..4; calls until seal() form one undo step. */
  trimOutputs(gains: readonly number[]): void {
    const assignments = gains.map((db, i): ParamAssignment => ({ ref: { kind: "gain", ch: OUT_BASE + i }, value: db }));
    this.guard("Trim outputs", () => this.editor.setMany("Trim outputs", assignments, { mergeKey: "trim-outputs" }));
  }

  muteAll(): void {
    const snapshot = this.soloSnapshot ?? outputMutes(this.edit.model);
    this.clearSolo();
    this.muteAllSnapshot = snapshot;
    this.applyGroup("Mute all", muteAllAssignments());
  }

  /** Back to the mute states from before Mute all (all unmuted if they are unknown). */
  unmuteAll(): void {
    this.clearSolo();
    const assignments = restoreAssignments(this.muteAllSnapshot);
    this.muteAllSnapshot = null;
    this.applyGroup("Unmute all", assignments);
  }

  toggleSolo(ch: number): void {
    const next = new Set(this.soloed);
    const adding = !next.has(ch);
    if (adding) next.add(ch);
    else next.delete(ch);
    if (this.soloed.length === 0) this.soloSnapshot = outputMutes(this.edit.model);
    if (next.size === 0) {
      const assignments = restoreAssignments(this.soloSnapshot);
      this.clearSolo();
      this.applyGroup("Solo off", assignments);
      return;
    }
    this.soloed = [...next].sort((a, b) => a - b);
    const name = this.ch(ch).name;
    this.applyGroup(adding ? `Solo ${name}` : `Unsolo ${name}`, soloAssignments(next));
  }

  private clearSolo(): void {
    this.soloed = [];
    this.soloSnapshot = null;
  }

  private applyGroup(label: string, assignments: ParamAssignment[]): void {
    this.guard(label, () => this.editor.setMany(label, assignments));
    this.editor.seal();
  }
```

At the end of `hydrate`, after `this.presetNames = presetNames;`, add:

```ts
    this.clearSolo();
    this.muteAllSnapshot = null;
```

- [ ] **Step 8: Add the Mute all button**

In `web/src/shell/TopBar.svelte`, add a new group right after the Undo/Redo group (`</div>` that closes the group containing the Redo button):

```svelte
  <div class="group">
    <button class:danger={device.allOutputsMuted}
            onclick={() => (device.allOutputsMuted ? device.unmuteAll() : device.muteAll())}
            title={device.allOutputsMuted ? "Unmute the outputs (back to how they were before Mute all)" : "Mute all four outputs"}>
      {device.allOutputsMuted ? "Unmute all" : "Mute all"}
    </button>
  </div>
```

- [ ] **Step 9: Show soloed outputs on their tab**

In `web/src/shell/ChannelTabs.svelte`, inside `<span class="badges">`, add before the mute badge:

```svelte
          {#if device.soloed.includes(view as number)}<span class="badge solo" title="Soloed">S</span>{/if}
```

and add to the `<style>` block after `.badge.mute { ... }`:

```css
  .badge.solo { background: var(--accent-dim); color: var(--text); }
```

- [ ] **Step 10: Typecheck and run all tests**

Run: `cd web && npm run typecheck && npm test`
Expected: 0 errors, 0 warnings; all tests pass.

- [ ] **Step 11: Commit**

```bash
git add web/src/state/editor.ts web/src/state/solo.ts web/src/state/trim.ts web/src/state/device.svelte.ts web/src/shell/TopBar.svelte web/src/shell/ChannelTabs.svelte web/test/outputs.test.ts web/test/state.test.ts
git commit -m "state: mute all, solo and output trim as single undo steps"
```

---

### Task 5: Mixer-style Overview with master trim

**Files:**
- Create: `web/src/channel/MasterTrim.svelte`
- Modify: `web/src/views/Overview.svelte` (strips become mixer strips)

**Interfaces:**
- Consumes: `Fader` (Task 3), `stepGainDb` (Task 3), `attachWheel` (Task 2), `trimmedGains` (Task 4), `device.trimOutputs`, `device.toggleSolo`, `device.soloed` (Task 4), `settings.value.gainStepDb` (Task 1).
- Produces: `MasterTrim.svelte` (no props).

- [ ] **Step 1: Write the master trim strip**

Create `web/src/channel/MasterTrim.svelte`:

```svelte
<script lang="ts">
  // Moves all four output gains together, keeping their differences. A button press,
  // a drag, or a run of wheel steps is one gesture and one undo step.
  import { device } from "../state/device.svelte.ts";
  import { settings } from "../state/settings.svelte.ts";
  import { GAIN_RANGE } from "../state/params.ts";
  import { OUT_BASE, OUTPUT_COUNT } from "../state/model.ts";
  import { trimmedGains } from "../state/trim.ts";
  import { attachWheel } from "../ui/wheel.ts";
  import { formatDb } from "../ui/format.ts";

  const WHEEL_IDLE_MS = 800;
  const DRAG_PIXELS_PER_STEP = 6;
  const BUTTON_STEP_DB = 1;
  const MIN_STEP_DB = 0.1;
  const SPAN_DB = GAIN_RANGE.max - GAIN_RANGE.min;
  const OUTPUTS = Array.from({ length: OUTPUT_COUNT }, (_, i) => OUT_BASE + i);

  /** Output gains when the current gesture started; null between gestures. */
  let base: number[] | null = null;
  let offset = $state(0);
  let clamped = $state(false);
  let area: HTMLDivElement;
  let drag: { pointerId: number; startY: number } | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const step = $derived(Math.max(MIN_STEP_DB, settings.value.gainStepDb));
  const round = (db: number) => Math.round(db * 10) / 10;

  function apply(nextOffset: number): void {
    if (base === null) {
      base = OUTPUTS.map((ch) => device.ch(ch).gainDb);
      clamped = false;
    }
    offset = round(nextOffset);
    const result = trimmedGains(base, offset);
    clamped = clamped || result.clamped;
    device.trimOutputs(result.gains);
  }

  function end(): void {
    clearTimeout(idleTimer);
    base = null;
    offset = 0;
    device.seal();
  }

  function nudge(deltaDb: number): void {
    end();
    apply(deltaDb);
    end();
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    end();
    drag = { pointerId: event.pointerId, startY: event.clientY };
    try {
      area.setPointerCapture(event.pointerId);
    } catch {
      // pointer already released (or synthetic): moves over the area still adjust it
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const next = round(Math.round((drag.startY - event.clientY) / DRAG_PIXELS_PER_STEP) * step);
    if (next !== offset) apply(next);
  }

  function onPointerUp(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    end();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    nudge(event.key === "ArrowUp" ? step : -step);
  }

  $effect(() => attachWheel(area, {
    step: (steps, multiplier) => {
      apply(offset + steps * Math.max(MIN_STEP_DB, multiplier * step));
      clearTimeout(idleTimer);
      idleTimer = setTimeout(end, WHEEL_IDLE_MS);
    },
  }));
</script>

<div class="master">
  <span class="name">Outputs</span>
  <button title="Raise all outputs by {BUTTON_STEP_DB} dB" onclick={() => nudge(BUTTON_STEP_DB)}>+{BUTTON_STEP_DB}</button>
  <div
    bind:this={area}
    class="area"
    role="slider"
    tabindex="0"
    aria-label="Trim all outputs"
    aria-valuemin={-SPAN_DB}
    aria-valuemax={SPAN_DB}
    aria-valuenow={offset}
    aria-valuetext="{formatDb(offset)} dB"
    title="Drag up or down, or use the mouse wheel, to move all outputs together"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onkeydown={onKeydown}
  >
    <span class="num">{formatDb(offset)}</span>
    <span class="unit">dB</span>
  </div>
  <button title="Lower all outputs by {BUTTON_STEP_DB} dB" onclick={() => nudge(-BUTTON_STEP_DB)}>-{BUTTON_STEP_DB}</button>
  <div class="limit">{clamped ? "limit reached" : ""}</div>
</div>

<style>
  .master {
    display: grid; grid-template-rows: auto auto 1fr auto auto; gap: 6px; padding: 6px; min-width: 0; margin-left: 8px;
    background: var(--surface-2); border: 1px solid var(--line); border-top: 3px solid var(--accent); border-radius: var(--radius);
  }
  .name { font-weight: 600; text-align: center; }
  .area {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-height: 60px;
    border: 1px dashed var(--line-strong); border-radius: var(--radius); cursor: ns-resize; touch-action: none;
  }
  .area:focus-visible { border-color: var(--accent); }
  .unit { font-size: 11px; color: var(--text-faint); }
  .limit { min-height: 14px; font-size: 10px; text-align: center; color: var(--warn); }
  @media (max-width: 760px) {
    .master { margin-left: 0; }
  }
</style>
```

- [ ] **Step 2: Turn the Overview strips into mixer strips**

Replace the `<script>` block and the "Channels" section of `web/src/views/Overview.svelte` (the "Routing" section stays as it is), and replace its `<style>` block:

```svelte
<script lang="ts">
  // All eight channels as mixer strips (fader + meter, gain, mute, polarity, solo on
  // outputs), a master trim for the outputs, and the routing matrix.
  import { device } from "../state/device.svelte.ts";
  import { settings } from "../state/settings.svelte.ts";
  import { ui } from "../state/ui.svelte.ts";
  import { GAIN_RANGE } from "../state/params.ts";
  import { CHANNEL_COUNT, OUT_BASE, OUTPUT_COUNT } from "../state/model.ts";
  import Section from "../ui/Section.svelte";
  import NumberField from "../ui/NumberField.svelte";
  import Toggle from "../ui/Toggle.svelte";
  import Meter from "../ui/Meter.svelte";
  import Fader from "../ui/Fader.svelte";
  import MasterTrim from "../channel/MasterTrim.svelte";
  import { stepGainDb } from "../ui/faderTaper.ts";
  import { formatDb } from "../ui/format.ts";
  import { INPUT_LETTERS } from "../ui/labels.ts";

  const channels = Array.from({ length: CHANNEL_COUNT }, (_, i) => i);
  const outputs = Array.from({ length: OUTPUT_COUNT }, (_, i) => OUT_BASE + i);
  const gainStep = $derived(settings.value.gainStepDb);

  function summary(ch: number): string {
    const channel = device.ch(ch);
    if (!channel.isOutput) return channel.gate ? `Gate ${formatDb(channel.gate.thresholdDb, 1)} dB` : "";
    const mask = device.routing[ch - OUT_BASE] ?? 0;
    const sources = INPUT_LETTERS.filter((_, i) => (mask & (1 << i)) !== 0).join("+") || "none";
    return `${sources} · ${(channel.delayMs ?? 0).toFixed(2)} ms`;
  }
</script>

<div class="view">
  <Section title="Channels">
    <div class="strips">
      {#each channels as ch (ch)}
        {@const channel = device.ch(ch)}
        {@const gainStatus = device.syncOf({ kind: "gain", ch })}
        <div class="strip" class:output-start={ch === OUT_BASE} style="--marker: var(--ch-{ch})">
          <button class="name ghost" title="Open {channel.name}" onclick={() => ui.open(ch)}>{channel.name}</button>
          <div class="mix">
            <Fader value={channel.gainDb} orientation="vertical" ticks step={gainStep} label="{channel.name} gain"
                   status={gainStatus} onchange={(db) => device.setGainDb(ch, db)} onend={() => device.seal()} />
            <Meter level={device.meters[ch] ?? 0} />
          </div>
          <NumberField value={channel.gainDb} min={GAIN_RANGE.min} max={GAIN_RANGE.max} step={gainStep} stepper={stepGainDb}
                       format={(v) => formatDb(v)} unit="dB" width="100%" status={gainStatus}
                       ariaLabel="{channel.name} gain value"
                       onchange={(db) => device.setGainDb(ch, db)} onend={() => device.seal()} />
          <div class="toggles">
            <Toggle pressed={channel.mute} tone="bad" title="Mute {channel.name}" status={device.syncOf({ kind: "mute", ch })}
                    onchange={(on) => device.setMute(ch, on)}>M</Toggle>
            <Toggle pressed={channel.polarity} tone="warn" title="Invert polarity of {channel.name}" status={device.syncOf({ kind: "polarity", ch })}
                    onchange={(invert) => device.setPolarity(ch, invert)}>Ø</Toggle>
            {#if channel.isOutput}
              <Toggle pressed={device.soloed.includes(ch)} title="Solo {channel.name} (mutes the other outputs)"
                      onchange={() => device.toggleSolo(ch)}>S</Toggle>
            {/if}
          </div>
          <div class="summary num faint" title={summary(ch)}>{summary(ch)}</div>
        </div>
      {/each}
      <MasterTrim />
    </div>
  </Section>
```

New `<style>` block:

```svelte
<style>
  .view { display: grid; gap: var(--gap); align-content: start; max-width: 1100px; }
  .strips { display: grid; grid-template-columns: repeat(9, minmax(84px, 1fr)); gap: 6px; }
  .strip {
    display: grid; grid-template-rows: auto 220px auto auto auto; gap: 6px; padding: 6px;
    background: var(--surface-2); border: 1px solid var(--line); border-top: 3px solid var(--marker); border-radius: var(--radius);
    min-width: 0;
  }
  .strip.output-start { margin-left: 8px; }
  .name { justify-self: stretch; font-weight: 600; overflow: hidden; text-overflow: ellipsis; padding: 0 2px; }
  .mix { display: flex; justify-content: center; gap: 6px; min-height: 0; }
  .mix :global(.meter) { width: 10px; }
  .toggles { display: flex; gap: 4px; justify-content: center; }
  .toggles :global(button) { flex: 1; min-width: 0; padding: 0; }
  .summary { font-size: 10px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .matrix { border-collapse: collapse; }
  .matrix th, .matrix td { padding: 3px 6px; text-align: center; }
  .matrix thead th { font-size: 11px; font-weight: 600; color: var(--text-dim); }
  .matrix tbody th { text-align: left; }
  @media (max-width: 760px) {
    .strips { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .strip.output-start { margin-left: 0; }
    .strip { grid-template-rows: auto 140px auto auto auto; }
  }
</style>
```

- [ ] **Step 3: Typecheck, test and build**

Run: `cd web && npm run typecheck && npm test && npm run build`
Expected: 0 errors, 0 warnings; all tests pass; Vite build succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/src/channel/MasterTrim.svelte web/src/views/Overview.svelte
git commit -m "ui: mixer-style overview with vertical faders, solo and master output trim"
```

---

### Task 6: Manual verification against the simulated device

**Files:** none (verification only; fix and commit anything that fails, in the task whose code is wrong).

- [ ] **Step 1: Start the dev server**

Run: `cd web && npm run dev`
Expected: Vite prints `Local: http://localhost:5173/`.

- [ ] **Step 2: Check each control at `http://localhost:5173/?mock` after pressing Connect…**

Expected, one line per check:
- Overview: hovering a vertical fader and scrolling one notch changes that channel's gain by 0.5 dB; Shift = 5 dB; Alt = 0.1 dB (never stuck below -20 dB, where it moves in 0.5 dB device steps).
- Scrolling the page (pointer over empty space) so a fader passes under the pointer does not change it; after stopping ~0.5 s, the wheel adjusts the fader.
- Ctrl+wheel over a fader zooms the page and leaves the gain alone.
- Dragging a fader thumb, clicking the track (jumps), double-click (0 dB), arrow keys and PageUp/PageDown all work; a whole drag is one Undo step.
- Hovering a gain number field and scrolling changes it without clicking first; Q, frequency and threshold fields do the same with their own steps.
- On an output page, wheel over an EQ band handle changes its Q; wheel elsewhere on the graph scrolls the page.
- Master strip: +1 / -1 move all four outputs by 1 dB (one Undo step each); dragging and wheel move them together; an output at +12 dB stops and "limit reached" shows.
- Mute all mutes Out 1-4 and becomes Unmute all; Unmute all brings back the earlier states; each is one Undo step.
- S on Out 3 mutes Out 1, 2, 4 and shows an "S" badge on the Out 3 tab; S on Out 3 again restores the earlier mutes ("Solo off" in Undo).
- Narrow the window below 760 px: strips wrap to 4 columns with 140 px faders, the master strip wraps under them.

- [ ] **Step 3: Stop the dev server and confirm a clean tree**

Run: `git status --short`
Expected: no changes from this plan left uncommitted.

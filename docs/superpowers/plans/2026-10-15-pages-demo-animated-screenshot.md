# Pages Demo and Animated Screenshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The GitHub Pages web app opens on a simulated "Demo DSP" whose meters react to edits, a real DSP can still be connected from it, and the README shows an animated WebP recorded from that demo.

**Architecture:** A `DemoDsp` (built on the existing `MockDsp`) tracks gain, mute, routing and test tone, and computes its meters with pure functions in `demoLevels.ts`. The `Connection` gains a demo link factory, a `simulated` flag and `connectDemo()`; a pure `startupPlan()` decides between bridge, device and demo on open. A Playwright-core script records the demo walk-through and ffmpeg encodes it.

**Tech Stack:** Svelte 5 (runes), TypeScript strict, Vite 6, node `--experimental-strip-types --test`, `playwright-core` (system Chrome), ffmpeg `libwebp_anim`.

**Spec:** `docs/superpowers/specs/2026-10-14-pages-demo-animated-screenshot-design.md`

## Global Constraints

- All commands run in `web/` unless a step says otherwise. Tests: `npm test`. Typecheck: `npm run typecheck` (tsc plus svelte-check `--fail-on-warnings`, must end with 0 errors and 0 warnings).
- Node 22 runs `.ts` files with `--experimental-strip-types`: no TypeScript parameter properties, no `enum`, no `namespace`, no `override` keyword.
- Commit with `git add` of explicit paths only. Never stage or commit `docs/FIRMWARE.md` (the user's uncommitted work). Commits are GPG-signed: if signing fails, stop and report; never pass `--no-gpg-sign` or `-c commit.gpgsign=false`.
- Commit messages follow the repository style: `feat(web): …`, `test(web): …`, `docs: …`.
- User-facing copy and comments: plain sentences, no em dashes.
- Banner copy, exactly: "Demo: a simulated DSP. Nothing here reaches real hardware." Without device access it continues: "Connecting a DSP needs Chrome or Edge on a computer, or the Android app."
- The demo never runs in the ESP32 build (`VITE_TARGET=esp`) or in the Android app (native bridge present).
- Product name of the demo device: "Demo DSP".
- Demo floors: inputs -87 dBFS, outputs -75 dBFS. Test tone on every input: -12 dBFS.
- The demo preset is the factory image with Out 3 and Out 4 routed from In A + In B (mask 3).
- Recording: viewport 1280 x 800, device scale factor 1, 12 fps, lossy WebP, looping, output `docs/demo.webp`, target about 3 to 4 MB.
- Before Task 1 (controller): run `npm run build` and note the size of `dist/assets/index-*.js`, for the comparison in Task 8.

---

### Task 1: Demo meter levels (pure)

**Files:**
- Create: `web/src/transport/demoLevels.ts`
- Test: `web/test/demoLevels.test.ts`

**Interfaces:**
- Produces: `INPUT_FLOOR_DB = -87`, `OUTPUT_FLOOR_DB = -75`, `TONE_DB = -12`; `interface DemoMix { gainsDb: number[]; mutes: boolean[]; routing: number[]; toneOn: boolean }` (gains and mutes: 8 entries In A to D then Out 1 to 4; routing: 4 input bitmasks, In A = 1 … In D = 8); `programDb(timeMs: number): [number, number]`; `meterLevels(mix: DemoMix, timeMs: number): number[]` (8 dBFS values).

- [ ] **Step 1: Write the failing tests**

Create `web/test/demoLevels.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { INPUT_FLOOR_DB, OUTPUT_FLOOR_DB, TONE_DB, meterLevels, programDb, type DemoMix } from "../src/transport/demoLevels.ts";

function mix(overrides: Partial<DemoMix> = {}): DemoMix {
  return {
    gainsDb: new Array<number>(8).fill(0),
    mutes: new Array<boolean>(8).fill(false),
    routing: [1, 2, 4, 8],
    toneOn: false,
    ...overrides,
  };
}

test("the program on In A and In B stays between the floor and full scale, and moves", () => {
  let lowest = Infinity;
  let highest = -Infinity;
  let differs = false;
  for (let timeMs = 0; timeMs < 8000; timeMs += 50) {
    const [a, b] = programDb(timeMs);
    lowest = Math.min(lowest, a, b);
    highest = Math.max(highest, a, b);
    if (Math.abs(a - b) > 0.5) differs = true;
  }
  assert.ok(lowest > -40, `lowest ${lowest}`);
  assert.ok(highest < -3, `highest ${highest}`);
  assert.ok(highest - lowest > 10, "it moves like music, not a steady level");
  assert.ok(differs, "left and right are not identical");
});

test("In C and In D sit at the idle floor", () => {
  const levels = meterLevels(mix(), 1234);
  assert.equal(levels[2], INPUT_FLOOR_DB);
  assert.equal(levels[3], INPUT_FLOOR_DB);
});

test("an output routed from one input shows that input plus its gain", () => {
  const levels = meterLevels(mix({ gainsDb: [0, 0, 0, 0, -3, 0, 0, 0] }), 1234);
  assert.ok(Math.abs(levels[4]! - (levels[0]! - 3)) < 1e-9);
  assert.ok(Math.abs(levels[5]! - levels[1]!) < 1e-9);
});

test("the test tone puts every input at -12 dBFS", () => {
  const levels = meterLevels(mix({ toneOn: true }), 1234);
  assert.deepEqual(levels.slice(0, 4), [TONE_DB, TONE_DB, TONE_DB, TONE_DB]);
});

test("two routed inputs add up as power", () => {
  const levels = meterLevels(mix({ toneOn: true, routing: [3, 2, 4, 8] }), 0);
  assert.ok(Math.abs(levels[4]! - (TONE_DB + 10 * Math.log10(2))) < 1e-9);
});

test("input gain comes before the meters and the routing", () => {
  const levels = meterLevels(mix({ toneOn: true, gainsDb: [-6, 0, 0, 0, 3, 0, 0, 0] }), 0);
  assert.equal(levels[0], TONE_DB - 6);
  assert.equal(levels[4], TONE_DB - 6 + 3);
});

test("muting an input or an output drops it to the floor", () => {
  const inputMuted = meterLevels(mix({ toneOn: true, mutes: [true, false, false, false, false, false, false, false] }), 0);
  assert.equal(inputMuted[0], INPUT_FLOOR_DB);
  assert.equal(inputMuted[4], OUTPUT_FLOOR_DB, "Out 1 only takes In A");
  const outputMuted = meterLevels(mix({ toneOn: true, mutes: [false, false, false, false, false, true, false, false] }), 0);
  assert.equal(outputMuted[5], OUTPUT_FLOOR_DB);
  assert.equal(outputMuted[1], TONE_DB, "the input meter is before the output mute");
});

test("an output with no input routed sits at the floor", () => {
  const levels = meterLevels(mix({ toneOn: true, routing: [0, 2, 4, 8] }), 0);
  assert.equal(levels[4], OUTPUT_FLOOR_DB);
});

test("levels never go above full scale", () => {
  const levels = meterLevels(mix({ toneOn: true, routing: [15, 15, 15, 15], gainsDb: new Array<number>(8).fill(12) }), 0);
  assert.ok(levels.every((db) => db <= 0));
  assert.equal(levels[4], 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL in `demoLevels.test.ts` with "Cannot find module … demoLevels.ts".

- [ ] **Step 3: Write the implementation**

Create `web/src/transport/demoLevels.ts`:

```ts
// What the demo DSP's meters show: a music-like program on In A and In B (a kick at
// 124 BPM, slow swells and some random motion, correlated but not identical between the
// two), followed through each channel's gain and mute and through the routing. EQ,
// crossovers, delay, compressor, gate and polarity are not modelled.

/** Idle levels of the hardware meters, in dBFS. */
export const INPUT_FLOOR_DB = -87;
export const OUTPUT_FLOOR_DB = -75;
/** Level of the test tone on every input while it plays. */
export const TONE_DB = -12;

const INPUT_COUNT = 4;
const BEAT_MS = 60_000 / 124;
const SWELL_MS = 16 * BEAT_MS;

/** The state the meters depend on. Gains and mutes: In A to D, then Out 1 to 4. */
export interface DemoMix {
  gainsDb: number[];
  mutes: boolean[];
  /** Input bitmask per output (In A = 1 … In D = 8). */
  routing: number[];
  toneOn: boolean;
}

/** A repeatable pseudo-random value in [0, 1) for an integer step and a seed. */
function hash(step: number, seed: number): number {
  const x = Math.sin(step * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Smooth noise in [-0.5, 0.5] that changes about once per period. */
function wobble(timeMs: number, periodMs: number, seed: number): number {
  const t = timeMs / periodMs;
  const step = Math.floor(t);
  const fraction = t - step;
  const ease = fraction * fraction * (3 - 2 * fraction);
  return hash(step, seed) * (1 - ease) + hash(step + 1, seed) * ease - 0.5;
}

/** In A and In B before their gain, in dBFS. */
export function programDb(timeMs: number): [number, number] {
  const beat = (timeMs % BEAT_MS) / BEAT_MS;
  const kick = Math.exp(-6 * beat);
  const swell = 0.5 - 0.5 * Math.cos((2 * Math.PI * timeMs) / SWELL_MS);
  const common = -30 + 10 * swell + 12 * kick + 4 * wobble(timeMs, 180, 1);
  return [common + 3 * wobble(timeMs, 120, 2), common + 3 * wobble(timeMs, 120, 3)];
}

const toPower = (db: number) => 10 ** (db / 10);
const clamp = (db: number, floor: number) => Math.min(0, Math.max(floor, db));

/** The eight meter levels in dBFS (In A to D, Out 1 to 4) at a moment. */
export function meterLevels(mix: DemoMix, timeMs: number): number[] {
  const [a, b] = programDb(timeMs);
  const sources = mix.toneOn ? Array.from({ length: INPUT_COUNT }, () => TONE_DB) : [a, b, INPUT_FLOOR_DB, INPUT_FLOOR_DB];
  const inputs = sources.map((db, i) => (mix.mutes[i] ? -Infinity : db + (mix.gainsDb[i] ?? 0)));
  const outputs = mix.routing.map((mask, o) => {
    const ch = INPUT_COUNT + o;
    const power = inputs.reduce((sum, db, i) => (mask & (1 << i) ? sum + toPower(db) : sum), 0);
    return mix.mutes[ch] || power === 0 ? -Infinity : 10 * Math.log10(power) + (mix.gainsDb[ch] ?? 0);
  });
  return [...inputs.map((db) => clamp(db, INPUT_FLOOR_DB)), ...outputs.map((db) => clamp(db, OUTPUT_FLOOR_DB))];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all tests PASS, including the 9 new ones.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors, 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add web/src/transport/demoLevels.ts web/test/demoLevels.test.ts
git commit -m "feat(web): meter levels of the demo device"
```

---

### Task 2: The demo device (`DemoDsp`)

**Files:**
- Modify: `web/src/transport/link.ts` (add `simulated`)
- Modify: `web/src/transport/mock.ts` (header comment, `productName` type, `answer` becomes protected, export `MockReply`)
- Create: `web/src/transport/demo.ts`
- Test: `web/test/demo.test.ts`

**Interfaces:**
- Consumes: `DemoMix`, `meterLevels` from Task 1.
- Produces: `HidLink.simulated?: boolean`; `class DemoDsp extends MockDsp` with `productName = "Demo DSP"`, `simulated = true`, `mix: DemoMix`, constructor `(options?: MockDspOptions)` (default latencies: recall 660 ms, store 2200 ms); `demoPresetPages(): Uint8Array[]`; in `mock.ts`: `export interface MockReply { code: number; data: number[] }` and `protected answer(code: number, data: Uint8Array): MockReply | null`.

- [ ] **Step 1: Write the failing tests**

Create `web/test/demo.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DemoDsp, demoPresetPages } from "../src/transport/demo.ts";
import { defaultPresetPages } from "../src/transport/factory-pages.ts";
import { OUTPUT_FLOOR_DB, TONE_DB } from "../src/transport/demoLevels.ts";
import { RequestChannel } from "../src/transport/channel.ts";
import { Dsp } from "../src/dsp.ts";
import { ToneSource } from "../src/protocol/commands.ts";
import { parsePresetImage, reconstructPresetImage } from "../src/protocol/readback.ts";

async function openDemo() {
  const demo = new DemoDsp({ latencyMs: {} });
  await demo.open();
  const channel = new RequestChannel(demo);
  const dsp = new Dsp(channel);
  const close = async () => {
    channel.close();
    await demo.close();
  };
  return { demo, dsp, close };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the demo preset is the factory image with Out 3 and Out 4 fed from In A + In B", () => {
  const demo = reconstructPresetImage(demoPresetPages());
  const factory = reconstructPresetImage(defaultPresetPages());
  assert.deepEqual(parsePresetImage(demo).outputs.map((output) => output.routingMask), [1, 2, 3, 3]);
  const changed = demo.reduce((count, byte, i) => (byte === factory[i] ? count : count + 1), 0);
  assert.equal(changed, 2);
});

test("the demo starts from its preset: 0 dB, unmuted, tone off", () => {
  const demo = new DemoDsp();
  assert.equal(demo.productName, "Demo DSP");
  assert.equal(demo.simulated, true);
  assert.deepEqual(demo.mix, {
    gainsDb: new Array<number>(8).fill(0),
    mutes: new Array<boolean>(8).fill(false),
    routing: [1, 2, 3, 3],
    toneOn: false,
  });
});

test("level, mute, routing and tone writes change the mix", async () => {
  const { demo, dsp, close } = await openDemo();
  await dsp.setLevelDb(4, -6);
  await dsp.mute(1, true);
  await dsp.routing(6, 0b0100);
  await dsp.testTone(ToneSource.PINK);
  assert.equal(demo.mix.gainsDb[4], -6);
  assert.equal(demo.mix.mutes[1], true);
  assert.equal(demo.mix.routing[2], 0b0100);
  assert.equal(demo.mix.toneOn, true);
  await dsp.testTone(ToneSource.OFF);
  assert.equal(demo.mix.toneOn, false);
  await close();
});

test("the meters follow the mix at once", async () => {
  const { demo, dsp, close } = await openDemo();
  await dsp.testTone(ToneSource.PINK);
  assert.equal(demo.levels[0], TONE_DB);
  assert.equal(demo.levels[4], TONE_DB);
  await dsp.mute(4, true);
  assert.equal(demo.levels[4], OUTPUT_FLOOR_DB);
  await close();
});

test("other writes are acked and leave the mix alone", async () => {
  const { demo, dsp, close } = await openDemo();
  const before = structuredClone(demo.mix);
  await dsp.setPolarity(4, true);
  await dsp.delayMs(4, 2);
  assert.deepEqual(demo.mix, before);
  await close();
});

test("a recall puts the preset back", async () => {
  const { demo, dsp, close } = await openDemo();
  await dsp.setLevelDb(5, -10);
  await dsp.mute(6, true);
  await dsp.routing(7, 0);
  await dsp.testTone(ToneSource.WHITE);
  await dsp.recallPreset(3);
  assert.deepEqual(demo.mix, new DemoDsp().mix);
  await close();
});

test("the levels move while the device is open, and stop when it is closed", async () => {
  const { demo, close } = await openDemo();
  const first = demo.levels[0];
  await sleep(350);
  assert.notEqual(demo.levels[0], first);
  await close();
  const closed = demo.levels[0];
  await sleep(250);
  assert.equal(demo.levels[0], closed);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL in `demo.test.ts` with "Cannot find module … demo.ts".

- [ ] **Step 3: Add `simulated` to the link interface**

In `web/src/transport/link.ts`, after `readonly productName: string;` add:

```ts
  /** True for the built-in demo device: nothing reaches real hardware. */
  readonly simulated?: boolean;
```

- [ ] **Step 4: Open `MockDsp` for the subclass**

In `web/src/transport/mock.ts`:

Replace the header line
`// Used by the tests, and by dev builds opened with ?mock (UI work without hardware).`
with
`// Used by the tests, and as the base of the demo device (demo.ts).`

After the `MockDspOptions` interface add:

```ts
export interface MockReply {
  code: number;
  data: number[];
}
```

Replace `readonly productName = "Mock DSP";` with `readonly productName: string = "Mock DSP";`

Replace the signature line
`  private answer(code: number, data: Uint8Array): { code: number; data: number[] } | null {`
with
`  protected answer(code: number, data: Uint8Array): MockReply | null {`

- [ ] **Step 5: Write `DemoDsp`**

Create `web/src/transport/demo.ts`:

```ts
// The demo device: the simulated DSP of mock.ts plus the state its meters depend on
// (gain, mute, routing, test tone), so the levels react to edits like the real unit's.
// Every preset slot holds the demo preset; a recall puts the state back to it.
import { MockDsp, type MockDspOptions, type MockReply } from "./mock.ts";
import { defaultPresetPages } from "./factory-pages.ts";
import { meterLevels, type DemoMix } from "./demoLevels.ts";
import { Command, ToneSource } from "../protocol/commands.ts";
import { gainRawToDb } from "../protocol/control.ts";
import { parsePresetImage, reconstructPresetImage } from "../protocol/readback.ts";

const PAGE_SIZE = 50;
const CHANNEL_COUNT = 8;
const OUT_BASE = 4;
/** Routing bytes of Out 3 and Out 4 in the preset image (output records at 260 and 334, routing at +8). */
const DEMO_ROUTING = [{ offset: 268, mask: 0b0011 }, { offset: 342, mask: 0b0011 }];
const LEVEL_INTERVAL_MS = 100;
const SLOW_COMMAND_LATENCY_MS = { [Command.RECALL_PRESET]: 660, [Command.STORE_PRESET]: 2200 };

/** The factory preset image with Out 3 and Out 4 fed from In A + In B, as nine channel pages. */
export function demoPresetPages(): Uint8Array[] {
  const image = reconstructPresetImage(defaultPresetPages());
  for (const { offset, mask } of DEMO_ROUTING) image[offset] = mask;
  return Array.from({ length: image.length / PAGE_SIZE }, (_, i) => image.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE));
}

function mixFromPages(pages: Uint8Array[]): DemoMix {
  const preset = parsePresetImage(reconstructPresetImage(pages));
  const records = [...preset.inputs, ...preset.outputs];
  return {
    gainsDb: records.map((record) => gainRawToDb(record.gainRaw)),
    mutes: records.map(() => false),
    routing: preset.outputs.map((output) => output.routingMask),
    toneOn: false,
  };
}

export class DemoDsp extends MockDsp {
  readonly productName: string = "Demo DSP";
  readonly simulated = true;
  mix: DemoMix;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: MockDspOptions = {}) {
    super({ latencyMs: options.latencyMs ?? SLOW_COMMAND_LATENCY_MS });
    this.pages = demoPresetPages();
    this.mix = mixFromPages(this.pages);
    this.refreshLevels();
  }

  async open(): Promise<void> {
    await super.open();
    this.timer ??= setInterval(() => this.refreshLevels(), LEVEL_INTERVAL_MS);
  }

  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await super.close();
  }

  protected answer(code: number, data: Uint8Array): MockReply | null {
    this.apply(code, data);
    return super.answer(code, data);
  }

  private apply(code: number, data: Uint8Array): void {
    const chan = data[0] ?? 0;
    switch (code) {
      case Command.LEVEL:
        if (chan < CHANNEL_COUNT) this.mix.gainsDb[chan] = gainRawToDb((data[1] ?? 0) | ((data[2] ?? 0) << 8));
        break;
      case Command.MUTE:
        if (chan < CHANNEL_COUNT) this.mix.mutes[chan] = data[1] !== 0;
        break;
      case Command.ROUTING:
        if (chan >= OUT_BASE && chan < CHANNEL_COUNT) this.mix.routing[chan - OUT_BASE] = data[1] ?? 0;
        break;
      case Command.TEST_TONE:
        this.mix.toneOn = chan !== ToneSource.OFF;
        break;
      case Command.RECALL_PRESET:
        this.mix = mixFromPages(this.pages);
        break;
      default:
        return;
    }
    this.refreshLevels();
  }

  private refreshLevels(): void {
    this.levels = meterLevels(this.mix, Date.now());
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: all tests PASS (the 7 new ones and every existing `MockDsp` test).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors, 0 warnings.

- [ ] **Step 8: Commit**

```bash
git add web/src/transport/link.ts web/src/transport/mock.ts web/src/transport/demo.ts web/test/demo.test.ts
git commit -m "feat(web): demo device whose meters follow gain, mute, routing and test tone"
```

---

### Task 3: The demo in the connection lifecycle

**Files:**
- Modify: `web/src/state/connection.ts` (full replacement below)
- Test: `web/test/connection.test.ts`

**Interfaces:**
- Consumes: `DemoDsp` (Task 2, tests only), `HidLink.simulated`.
- Produces: `ConnectionSnapshot.simulated: boolean`; `new Connection(provider, hooks, demoLink: (() => HidLink) | null = null)`; `connectDemo(): Promise<void>`; `autoConnect(): Promise<boolean>` (false only when no granted device was found); getters `hardwareSupported: boolean` and `demoAvailable: boolean`.

- [ ] **Step 1: Write the failing tests**

In `web/test/connection.test.ts`:

Change the imports at the top to:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Connection, type ConnectionPhase, type ConnectionSnapshot, type SessionHooks, type SyncReason } from "../src/state/connection.ts";
import type { LinkProvider } from "../src/transport/platform.ts";
import type { HidLink } from "../src/transport/link.ts";
import type { Dsp } from "../src/dsp.ts";
import { Command } from "../src/protocol/commands.ts";
import { MockDsp } from "../src/transport/mock.ts";
import { DemoDsp } from "../src/transport/demo.ts";
```

In `class FakeProvider`, add the field `canReachDevices = true;` after `nextExisting`, and replace `supported(): boolean { return true; }` with `supported(): boolean { return this.canReachDevices; }`.

Replace the whole `function setup() { … }` with:

```ts
function setup({ supported = true, demo = true }: { supported?: boolean; demo?: boolean } = {}) {
  const provider = new FakeProvider();
  provider.canReachDevices = supported;
  const recorder = new HookRecorder();
  const hooks: SessionHooks = {
    sync: (dsp, reason) => recorder.sync(dsp, reason),
    started: () => { recorder.started++; },
    ended: () => { recorder.ended++; },
  };
  const demos: DemoDsp[] = [];
  const demoLink = () => {
    const link = new DemoDsp({ latencyMs: {} });
    demos.push(link);
    return link;
  };
  const connection = new Connection(provider, hooks, demo ? demoLink : null);
  const phases: ConnectionPhase[] = [];
  connection.onChange((snapshot) => {
    if (phases[phases.length - 1] !== snapshot.phase) phases.push(snapshot.phase);
  });
  return { provider, recorder, connection, phases, demos };
}
```

After `function waitForPhase(…) { … }` add:

```ts
function waitUntil(connection: Connection, done: (snapshot: ConnectionSnapshot) => boolean, timeoutMs = 3000): Promise<void> {
  if (done(connection.snapshot)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error(`timed out in ${connection.snapshot.phase}`)); }, timeoutMs);
    const stop = connection.onChange((snapshot) => {
      if (!done(snapshot)) return;
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}
```

Append these tests at the end of the file:

```ts
test("connectDemo binds the demo device and reports it as simulated", async () => {
  const { connection, phases, demos } = setup();
  await connection.connectDemo();
  assert.deepEqual(phases, ["connecting", "syncing", "ready"]);
  assert.equal(connection.snapshot.simulated, true);
  assert.equal(connection.snapshot.productName, "Demo DSP");
  assert.equal(demos.length, 1);
  await connection.dispose();
  assert.equal(demos[0]!.isOpen, false);
});

test("during the demo, a cancelled pick keeps it and a picked device replaces it", async () => {
  const { provider, connection, demos } = setup();
  await connection.connectDemo();
  provider.nextPick = null;
  await connection.connect();
  assert.equal(connection.snapshot.phase, "ready");
  assert.equal(connection.snapshot.simulated, true);
  assert.equal(demos[0]!.isOpen, true);

  const real = new MockDsp();
  provider.nextPick = real;
  await connection.connect();
  assert.equal(connection.snapshot.phase, "ready");
  assert.equal(connection.snapshot.simulated, false);
  assert.equal(connection.snapshot.productName, "Mock DSP");
  assert.equal(demos[0]!.isOpen, false);
  assert.equal(real.isOpen, true);
  await connection.dispose();
});

test("a granted device plugged in during the demo replaces it", async () => {
  const { provider, connection, demos } = setup();
  await connection.connectDemo();
  provider.attach(new MockDsp());
  await waitUntil(connection, (snapshot) => snapshot.phase === "ready" && !snapshot.simulated);
  assert.equal(demos[0]!.isOpen, false);
  await connection.dispose();
});

test("a lost device does not fall back to the demo", async () => {
  const { provider, connection, demos } = setup();
  const device = new MockDsp();
  provider.nextExisting = device;
  assert.equal(await connection.autoConnect(), true);
  device.unplug();
  await waitForPhase(connection, "lost");
  assert.equal(connection.snapshot.simulated, false);
  assert.equal(demos.length, 0);
  await connection.dispose();
});

test("autoConnect resolves false when no granted device is plugged in", async () => {
  const { connection } = setup();
  assert.equal(await connection.autoConnect(), false);
  assert.equal(connection.snapshot.phase, "idle");
  await connection.dispose();
});

test("without device access the demo still runs, and ending it goes back to unsupported", async () => {
  const { provider, connection } = setup({ supported: false });
  assert.equal(connection.snapshot.phase, "unsupported");
  assert.equal(connection.hardwareSupported, false);
  assert.equal(await connection.autoConnect(), false);
  provider.nextPick = new MockDsp();
  await connection.connect();
  assert.equal(connection.snapshot.phase, "unsupported", "nothing to pick from");
  await connection.connectDemo();
  assert.equal(connection.snapshot.phase, "ready");
  assert.equal(connection.snapshot.simulated, true);
  await connection.disconnect();
  assert.equal(connection.snapshot.phase, "unsupported");
  assert.equal(connection.snapshot.simulated, false);
  await connection.dispose();
});

test("connectDemo does nothing where the demo is not available", async () => {
  const { connection, phases } = setup({ demo: false });
  assert.equal(connection.demoAvailable, false);
  await connection.connectDemo();
  assert.deepEqual(phases, []);
  assert.equal(connection.snapshot.phase, "idle");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL in `connection.test.ts` with "connection.connectDemo is not a function" (and the `simulated` assertions failing).

- [ ] **Step 3: Replace `web/src/state/connection.ts`**

Write the full file:

```ts
// Connection lifecycle: open a link, identify the device, let the session read
// its state, then run until the device goes away or stops answering.
//
//   idle ──connect──▶ connecting ──▶ syncing ──▶ ready ──resync──▶ syncing ──▶ ready
//                         │             │          │
//                         └── error ────┴──────────┴── unplugged / unresponsive ──▶ lost
//
// "lost" (and "idle", unless the user disconnected on purpose) re-binds
// automatically when a granted device is plugged back in. The demo device goes through
// the same lifecycle, and a picked or plugged-in device replaces it. Where the platform
// cannot reach devices at all, a session ends in "unsupported" instead of "idle" or "lost".
import type { HidLink } from "../transport/link.ts";
import type { LinkProvider } from "../transport/platform.ts";
import { RequestChannel, ProtocolError, emptyStats, type ChannelStats, type Transaction } from "../transport/channel.ts";
import { Dsp, type DeviceInfo } from "../dsp.ts";

export type ConnectionPhase = "unsupported" | "idle" | "connecting" | "syncing" | "ready" | "lost";
export type SyncReason = "connect" | "resync";

export interface ConnectionSnapshot {
  phase: ConnectionPhase;
  error: string;
  productName: string;
  info: DeviceInfo | null;
  stats: ChannelStats;
  /** The bound device is the demo: nothing reaches real hardware. */
  simulated: boolean;
}

export interface SessionHooks {
  /** Read device state into the model (phase is "syncing" while this runs). */
  sync(dsp: Dsp, reason: SyncReason): Promise<void>;
  /** The session is ready for live traffic (start meter polling). */
  started(dsp: Dsp): void;
  /** The session has ended, for any reason. */
  ended(): void;
}

/** Consecutive timed-out transactions after which a ready device counts as lost. */
const MAX_CONSECUTIVE_TIMEOUTS = 4;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class Connection {
  private readonly provider: LinkProvider;
  private readonly hooks: SessionHooks;
  private readonly demoLink: (() => HidLink) | null;
  private readonly listeners = new Set<(snapshot: ConnectionSnapshot) => void>();
  private state: ConnectionSnapshot;
  private generation = 0;
  private link: HidLink | null = null;
  private channel: RequestChannel | null = null;
  private client: Dsp | null = null;
  private sessionCleanup: (() => void)[] = [];
  private stopWatchingAttach: (() => void) | null = null;
  private userDisconnected = false;
  private consecutiveTimeouts = 0;

  constructor(provider: LinkProvider, hooks: SessionHooks, demoLink: (() => HidLink) | null = null) {
    this.provider = provider;
    this.hooks = hooks;
    this.demoLink = demoLink;
    this.state = {
      phase: provider.supported() ? "idle" : "unsupported",
      error: "",
      productName: "",
      info: null,
      stats: emptyStats(),
      simulated: false,
    };
  }

  get snapshot(): ConnectionSnapshot {
    return this.state;
  }

  /** The client for the current session (null when no device is bound). */
  get dsp(): Dsp | null {
    return this.client;
  }

  /** The platform can reach real devices. */
  get hardwareSupported(): boolean {
    return this.provider.supported();
  }

  /** connectDemo() can bind the demo device here. */
  get demoAvailable(): boolean {
    return this.demoLink !== null;
  }

  onChange(listener: (snapshot: ConnectionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Pick/grant a device and bind it. On desktop this must run inside a user gesture.
   * During the demo the picker comes first: a cancelled pick leaves the demo running.
   */
  async connect(): Promise<void> {
    if (!this.provider.supported()) return;
    this.userDisconnected = false;
    this.watchAttach();
    let link: HidLink | null;
    try {
      link = await this.provider.pick();
    } catch (error) {
      this.update({ error: messageOf(error) });
      return;
    }
    if (link) await this.bind(link);
  }

  /**
   * Bind an already-granted device without prompting, and auto-bind future plug-ins.
   * Resolves false only when there is no granted device (an error while looking stays on screen).
   */
  async autoConnect(): Promise<boolean> {
    if (!this.provider.supported()) return false;
    this.watchAttach();
    let link: HidLink | null;
    try {
      link = await this.provider.existing();
    } catch (error) {
      this.update({ error: messageOf(error) });
      return true;
    }
    if (!link) return false;
    await this.bind(link);
    return true;
  }

  /** Bind the demo device; a granted device plugged in later replaces it. */
  async connectDemo(): Promise<void> {
    if (!this.demoLink) return;
    this.userDisconnected = false;
    this.watchAttach();
    await this.bind(this.demoLink());
  }

  async disconnect(): Promise<void> {
    this.userDisconnected = true;
    this.generation++;
    await this.endSession();
    this.update({ phase: this.restingPhase("idle"), error: "", simulated: false });
  }

  /** Re-read the device state (after a preset recall, or on demand). */
  async resync(): Promise<void> {
    const dsp = this.client;
    if (!dsp || this.state.phase !== "ready") return;
    const session = this.generation;
    this.update({ phase: "syncing" });
    try {
      await this.hooks.sync(dsp, "resync");
      if (session === this.generation) this.update({ phase: "ready", error: "" });
    } catch (error) {
      if (session !== this.generation || (error instanceof ProtocolError && error.kind === "closed")) return;
      this.update({ phase: "ready", error: `Resync failed: ${messageOf(error)}` });
    }
  }

  /** Stop watching for plug-ins and end any session. */
  async dispose(): Promise<void> {
    this.stopWatchingAttach?.();
    this.stopWatchingAttach = null;
    this.generation++;
    await this.endSession();
  }

  private watchAttach(): void {
    if (this.stopWatchingAttach) return;
    this.stopWatchingAttach = this.provider.onAttach((link) => {
      const { phase, simulated } = this.state;
      if (this.userDisconnected || !(simulated || phase === "idle" || phase === "lost")) return;
      void this.bind(link);
    });
  }

  private async bind(link: HidLink): Promise<void> {
    const session = ++this.generation;
    await this.endSession();
    this.consecutiveTimeouts = 0;
    this.update({ phase: "connecting", error: "", info: null, stats: emptyStats(), simulated: link.simulated === true });
    try {
      await link.open();
      if (session !== this.generation) {
        await link.close();
        return;
      }
      const channel = new RequestChannel(link);
      const dsp = new Dsp(channel);
      this.link = link;
      this.channel = channel;
      this.client = dsp;
      this.sessionCleanup = [
        link.onDisconnect((reason) => void this.lose(session, reason ?? "Device disconnected")),
        channel.onTransaction((transaction) => this.observe(session, transaction)),
      ];

      const info = await dsp.identify();
      if (session !== this.generation) return;
      this.update({ phase: "syncing", info, productName: link.productName });
      await this.hooks.sync(dsp, "connect");
      await dsp.finalize();
      if (session !== this.generation) return;
      this.update({ phase: "ready" });
      this.hooks.started(dsp);
    } catch (error) {
      if (session !== this.generation) return;
      this.generation++;
      await this.endSession();
      this.update({ phase: this.restingPhase("idle"), error: `Connection failed: ${messageOf(error)}`, simulated: false });
    }
  }

  private async lose(session: number, reason: string): Promise<void> {
    if (session !== this.generation) return;
    this.generation++;
    await this.endSession();
    this.update({ phase: this.restingPhase("lost"), error: reason, simulated: false });
  }

  /** Where a session ends: "unsupported" when the platform cannot reach devices (after the demo). */
  private restingPhase(phase: "idle" | "lost"): ConnectionPhase {
    return this.provider.supported() ? phase : "unsupported";
  }

  private observe(session: number, transaction: Transaction): void {
    if (session !== this.generation || !this.channel) return;
    this.consecutiveTimeouts = transaction.error === "timeout" ? this.consecutiveTimeouts + 1 : 0;
    this.update({ stats: { ...this.channel.stats } });
    if (this.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS && this.state.phase === "ready") {
      void this.lose(session, "Device stopped responding");
    }
  }

  private async endSession(): Promise<void> {
    const link = this.link;
    const hadSession = this.client !== null;
    for (const cleanup of this.sessionCleanup) cleanup();
    this.sessionCleanup = [];
    this.channel?.close("session ended");
    this.link = null;
    this.channel = null;
    this.client = null;
    if (hadSession) this.hooks.ended();
    if (link) await link.close().catch(() => undefined);
  }

  private update(patch: Partial<ConnectionSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all tests PASS (7 new connection tests, all existing ones).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors, 0 warnings. (`device.svelte.ts` still compiles: it ignores the new snapshot field and `autoConnect()`'s result.)

- [ ] **Step 6: Commit**

```bash
git add web/src/state/connection.ts web/test/connection.test.ts
git commit -m "feat(web): the connection can bind the demo device, and a real one replaces it"
```

---

### Task 4: Platform, startup choice and the device store

**Files:**
- Modify: `web/src/transport/platform.ts`
- Create: `web/src/state/startup.ts`
- Test: `web/test/startupPlan.test.ts`
- Modify: `web/src/state/device.svelte.ts`
- Modify: `web/src/main.ts`

**Interfaces:**
- Consumes: `DemoDsp` (Task 2), `Connection` constructor and `connectDemo()` / `autoConnect(): Promise<boolean>` / `hardwareSupported` / `demoAvailable` (Task 3).
- Produces: in `platform.ts`: `demoAvailable(): boolean`, `demoLink(): HidLink`; in `startup.ts`: `type StartupPlan = "bridge" | "device" | "demo" | "device-or-demo"`, `interface StartupContext { bridge: boolean; demoAvailable: boolean; demoRequested: boolean }`, `startupPlan(context): StartupPlan`, `demoRequested(search: string): boolean`; on `DeviceStore`: `simulated` ($state boolean), `get demoAvailable(): boolean`, `get hardwareSupported(): boolean`, `connectDemo(): Promise<void>`, `autoConnect(): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

Create `web/test/startupPlan.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { demoRequested, startupPlan } from "../src/state/startup.ts";

test("the ESP32 build always starts with the bridge", () => {
  assert.equal(startupPlan({ bridge: true, demoAvailable: false, demoRequested: true }), "bridge");
});

test("where the demo is not available (Android app), only a granted device is bound", () => {
  assert.equal(startupPlan({ bridge: false, demoAvailable: false, demoRequested: false }), "device");
  assert.equal(startupPlan({ bridge: false, demoAvailable: false, demoRequested: true }), "device");
});

test("the web build binds a granted device, else starts the demo", () => {
  assert.equal(startupPlan({ bridge: false, demoAvailable: true, demoRequested: false }), "device-or-demo");
});

test("?demo goes straight to the demo", () => {
  assert.equal(startupPlan({ bridge: false, demoAvailable: true, demoRequested: true }), "demo");
});

test("?demo and its alias ?mock ask for the demo", () => {
  assert.equal(demoRequested("?demo"), true);
  assert.equal(demoRequested("?mock"), true);
  assert.equal(demoRequested("?foo=1&demo"), true);
  assert.equal(demoRequested(""), false);
  assert.equal(demoRequested("?demonstration"), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL in `startupPlan.test.ts` with "Cannot find module … startup.ts".

- [ ] **Step 3: Write `startup.ts`**

Create `web/src/state/startup.ts`:

```ts
// What the app does on open. The ESP32 build logs in to the bridge first. Elsewhere a
// granted DSP is bound without prompting; the plain web build falls back to the demo
// when there is none, or goes straight to it with ?demo (alias ?mock).
export type StartupPlan = "bridge" | "device" | "demo" | "device-or-demo";

export interface StartupContext {
  /** The page is served by the ESP32 bridge. */
  bridge: boolean;
  /** The demo device may run here (not on the bridge, not in the Android app). */
  demoAvailable: boolean;
  /** The page address asks for the demo. */
  demoRequested: boolean;
}

export function startupPlan(context: StartupContext): StartupPlan {
  if (context.bridge) return "bridge";
  if (!context.demoAvailable) return "device";
  return context.demoRequested ? "demo" : "device-or-demo";
}

/** True when the query string has ?demo or ?mock. */
export function demoRequested(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("demo") || params.has("mock");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Platform: the demo link replaces the dev mock**

In `web/src/transport/platform.ts`:

Replace the header comment (first two lines) with:

```ts
// Chooses the link implementation for the running platform: the Android shell's
// native USB bridge when present, the ESP32 bridge's WebSocket in that build, otherwise
// desktop WebHID. The demo device is offered beside them in the plain web build.
```

Replace the import `import { MockDsp } from "./mock.ts";` with `import { DemoDsp } from "./demo.ts";` and delete the import `import { Command } from "../protocol/commands.ts";`.

Delete `MOCK_LATENCY_MS`, `MOCK_LEVEL_INTERVAL_MS` and the whole `mockProvider()` function (from `const MOCK_LATENCY_MS` to the closing brace of `mockProvider`).

Replace `platformLinkProvider()` with:

```ts
export function platformLinkProvider(): LinkProvider {
  if (isEspTarget()) return wsProvider;
  return NativeLink.supported() ? nativeProvider : webHidProvider;
}

/** The demo runs in the plain web build only: not on the ESP32 bridge, not in the Android app. */
export function demoAvailable(): boolean {
  return !isEspTarget() && !NativeLink.supported();
}

export function demoLink(): HidLink {
  return new DemoDsp();
}
```

- [ ] **Step 6: Device store**

In `web/src/state/device.svelte.ts`:

Replace `import { platformLinkProvider } from "../transport/platform.ts";` with
`import { demoAvailable, demoLink, platformLinkProvider } from "../transport/platform.ts";`

After `productName = $state("");` add:

```ts
  /** The bound device is the demo. */
  simulated = $state(false);
```

Pass the demo link as the third argument of the `Connection` constructor (the closing `});` after the `ended` hook becomes `}, demoAvailable() ? demoLink : null);`). The call reads:

```ts
    this.connection = new Connection(platformLinkProvider(), {
      sync: (dsp, reason) => this.hydrate(dsp, reason),
      started: (dsp) => this.startMeters(dsp),
      ended: () => {
        this.stopMeters();
        this.clearSolo();
      },
    }, demoAvailable() ? demoLink : null);
```

In the `onChange` listener, after `this.productName = snapshot.productName;` add `this.simulated = snapshot.simulated;`.

After `get supported(): boolean { return this.phase !== "unsupported"; }` add:

```ts
  /** The platform can reach a real DSP (Connect can open the picker). */
  get hardwareSupported(): boolean { return this.connection.hardwareSupported; }
  /** The demo device can run here. */
  get demoAvailable(): boolean { return this.connection.demoAvailable; }
```

Replace `autoConnect(): Promise<void> { return this.connection.autoConnect(); }` with:

```ts
  /** False when no granted device was found. */
  autoConnect(): Promise<boolean> { return this.connection.autoConnect(); }
  connectDemo(): Promise<void> { return this.connection.connectDemo(); }
```

- [ ] **Step 7: Startup in `main.ts`**

Replace `web/src/main.ts` with:

```ts
import { mount } from "svelte";
import App from "./App.svelte";
import { device } from "./state/device.svelte.ts";
import { bridge } from "./esp/bridge.svelte.ts";
import { demoRequested, startupPlan } from "./state/startup.ts";
import "./theme.css";

const app = mount(App, { target: document.getElementById("app")! });
(globalThis as Record<string, unknown>).device = device; // console handle for hardware debugging

// On the ESP32 build the session comes first: the login screen appears when there is none.
// Elsewhere an already-granted device is bound on load (no prompt), and future plug-ins;
// the web build runs the demo when there is no granted device.
async function start(): Promise<void> {
  const plan = startupPlan({ bridge: bridge.active, demoAvailable: device.demoAvailable, demoRequested: demoRequested(location.search) });
  if (plan === "bridge") await bridge.start();
  else if (plan === "demo") await device.connectDemo();
  else if (plan === "device") await device.autoConnect();
  else if (!(await device.autoConnect())) await device.connectDemo();
}

void start();
export default app;
```

- [ ] **Step 8: Run tests, typecheck and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests PASS; 0 errors, 0 warnings; build succeeds.

- [ ] **Step 9: Check the demo starts on its own**

Run in the background: `npx vite --port 5180 --strictPort`
Open `http://localhost:5180/` in a browser without a granted DSP. Expected: the meters on the Overview move, Out 3 and Out 4 included; the status bar reads "Connected". Open `http://localhost:5180/?demo`: the same. Stop the server.

- [ ] **Step 10: Commit**

```bash
git add web/src/transport/platform.ts web/src/state/startup.ts web/test/startupPlan.test.ts web/src/state/device.svelte.ts web/src/main.ts
git commit -m "feat(web): open on the demo when no granted DSP is plugged in (?demo forces it)"
```

---

### Task 5: Fine-tuning on the demo stays in memory

**Files:**
- Modify: `web/src/setup/tuningRunner.ts`
- Modify: `web/src/setup/tuning.svelte.ts`
- Test: `web/test/tuningRunner.test.ts`

**Interfaces:**
- Consumes: `DeviceStore.simulated` (Task 4).
- Produces: `TuningRunner.useSimulated(simulated: boolean): void`.

- [ ] **Step 1: Write the failing tests**

Append to `web/test/tuningRunner.test.ts`:

```ts
test("a session on the demo keeps its snapshot in memory only", async () => {
  const { runner, storage, state, start } = setup();
  runner.useSimulated(true);
  await start();
  assert.ok(state.running);
  assert.equal(storage.items.has(TUNING_SESSION_KEY), false);
  await runner.cancel();
  assert.equal(storage.items.has(TUNING_SESSION_KEY), false);
});

test("while the demo runs, a stored interrupted session is set aside, then offered again", async () => {
  const stored = snapshotOf(defaultModel());
  const { runner, state, storage, start } = setup(stored);
  assert.deepEqual(state.interrupted, stored);
  runner.useSimulated(true);
  assert.equal(state.interrupted, null);
  await start();
  assert.ok(state.running, "the stored session does not block a demo session");
  await runner.cancel();
  runner.useSimulated(false);
  assert.deepEqual(state.interrupted, stored);
  assert.deepEqual(loadTuningSnapshot(storage), stored);
});

test("a demo session cut short by the switch to a real device is not offered on it", async () => {
  const { runner, state, device, start } = setup();
  runner.useSimulated(true);
  await start();
  runner.useSimulated(false);
  assert.equal(state.running, null);
  assert.equal(state.interrupted, null);
  assert.ok(device.calls.includes("end"), "the session's undo group is closed");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL with "runner.useSimulated is not a function".

- [ ] **Step 3: Implement in `tuningRunner.ts`**

Replace the header comment's last two lines
```ts
// A session is one undo step. What it changed stays in storage until the device has
// confirmed it is put back, so it can still be restored after a reload or a lost link.
```
with
```ts
// A session is one undo step. What it changed stays in storage until the device has
// confirmed it is put back, so it can still be restored after a reload or a lost link.
// On the demo device it stays in memory only, and a real device's stored session waits.
```

In `class TuningRunner`, after `private settling = 0;` add:

```ts
  /** The bound device is the demo. */
  private simulated = false;
```

After the constructor add:

```ts
  /**
   * The bound device became the demo, or stopped being it. A session running on the
   * previous device ends as interrupted; a demo session is never offered on a real device,
   * and a real device's interrupted session is set aside (kept in storage) during the demo.
   */
  useSimulated(simulated: boolean): void {
    if (simulated === this.simulated) return;
    this.interrupt();
    this.simulated = simulated;
    this.state.interrupted = simulated ? null : loadTuningSnapshot(this.storage);
  }
```

In `start()`, replace `saveTuningSnapshot(this.storage, snapshot);` with `saveTuningSnapshot(this.store, snapshot);`.

In `dismissInterrupted()`, replace `clearTuningSnapshot(this.storage);` with `clearTuningSnapshot(this.store);`.

Replace the whole `putBack` method with:

```ts
  /**
   * Tone off, then the restore writes. The snapshot is forgotten only once the device
   * confirmed both; otherwise the Restore notice comes back (unless the device was swapped meanwhile).
   */
  private async putBack(snapshot: TuningSnapshot, label: string, assignments: ParamAssignment[]): Promise<void> {
    const store = this.store;
    const simulated = this.simulated;
    this.settling++;
    try {
      // unmuting while the tone still plays would put it on every routed output
      const silenced = await this.device.testTone(ToneSource.OFF);
      if (!silenced) {
        this.endGroup();
        this.device.report(label, "Could not stop the tone; the other outputs stay muted");
        if (simulated === this.simulated) this.state.interrupted = snapshot;
        return;
      }
      const restored = this.device.applyGroup(label, assignments);
      this.endGroup();
      if (await restored) clearTuningSnapshot(store);
      else if (simulated === this.simulated) this.state.interrupted = snapshot;
    } finally {
      this.settling--;
    }
  }

  /** Where the session snapshot is kept: nowhere but memory on the demo. */
  private get store(): StorageLike | null {
    return this.simulated ? null : this.storage;
  }
```

- [ ] **Step 4: Follow the device in `tuning.svelte.ts`**

In `web/src/setup/tuning.svelte.ts`, inside `$effect.root(() => { … })`, after the existing `$effect(() => { … });` add:

```ts
      $effect(() => {
        const simulated = device.simulated;
        untrack(() => this.runner.useSimulated(simulated));
      });
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS (3 new ones and every existing tuning test); 0 errors, 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add web/src/setup/tuningRunner.ts web/src/setup/tuning.svelte.ts web/test/tuningRunner.test.ts
git commit -m "feat(web): fine-tuning on the demo stays in memory and sets a real session aside"
```

---

### Task 6: Demo banner, Connect DSP and Try the demo

**Files:**
- Modify: `web/src/App.svelte`
- Modify: `web/src/shell/TopBar.svelte`
- Modify: `web/src/shell/StatusBar.svelte`

**Interfaces:**
- Consumes: `device.simulated`, `device.hardwareSupported`, `device.demoAvailable`, `device.connectDemo()`, `device.connect()`, `device.productName` (Task 4).

- [ ] **Step 1: Notices in `App.svelte`**

Replace the block from `{#if !device.supported}` to its closing `{/if}` (the connection notices, before the tuning notice) with:

```svelte
  {#if device.simulated}
    <div class="notice demo">
      Demo: a simulated DSP. Nothing here reaches real hardware.
      {#if device.hardwareSupported}
        <button class="primary" disabled={device.phase === "connecting"} onclick={() => device.connect()}>Connect DSP…</button>
      {:else}
        Connecting a DSP needs Chrome or Edge on a computer, or the Android app.
      {/if}
    </div>
  {:else if !device.supported}
    <div class="notice bad">
      {bridge.active ? "This browser has no WebSocket support." : "This browser cannot reach USB devices. Use Chrome or Edge on a desktop computer, or the Android app."}
      {#if device.demoAvailable}<button class="ghost" onclick={() => device.connectDemo()}>Try the demo</button>{/if}
    </div>
  {:else if device.phase === "lost"}
    <div class="notice bad">
      {device.connectionError}.
      {bridge.active ? "Press Connect to take control (only one browser controls the DSP at a time)." : "Plug the DSP back in to reconnect automatically, or press Connect."}
      {#if bridge.active}<button class="ghost" onclick={() => device.connect()}>Take control</button>{/if}
      {#if device.demoAvailable}<button class="ghost" onclick={() => device.connectDemo()}>Try the demo</button>{/if}
    </div>
  {:else if !device.connected && device.phase !== "syncing"}
    <div class="notice">
      Offline: edits change this screen only. Connecting loads the device's current settings.
      {#if device.demoAvailable}<button class="ghost" onclick={() => device.connectDemo()}>Try the demo</button>{/if}
    </div>
  {/if}
```

In the `<style>` block, after `.notice.bad { … }` add:

```css
  .notice.demo { border-left-color: var(--accent); }
```

- [ ] **Step 2: Top bar**

In `web/src/shell/TopBar.svelte`:

Replace the `statusText` line with:

```ts
  const statusText = $derived(
    device.busy ? `${device.busy}…`
      : device.connected ? (device.simulated ? device.productName : "Connected")
      : device.connectionError || PHASE_LABELS[device.phase],
  );
```

Replace the button block inside `<div class="group connection">`:

```svelte
    {#if device.connected || device.phase === "syncing"}
      <button onclick={() => device.disconnect()}>Disconnect</button>
    {:else}
      <button class="primary" disabled={!device.supported || device.phase === "connecting"} onclick={() => device.connect()}>Connect…</button>
    {/if}
```

with:

```svelte
    {#if device.simulated}
      {#if device.hardwareSupported}
        <button class="primary" disabled={device.phase === "connecting"} onclick={() => device.connect()}>Connect DSP…</button>
      {/if}
    {:else if device.connected || device.phase === "syncing"}
      <button onclick={() => device.disconnect()}>Disconnect</button>
    {:else}
      <button class="primary" disabled={!device.supported || device.phase === "connecting"} onclick={() => device.connect()}>Connect…</button>
    {/if}
```

- [ ] **Step 3: Status bar**

In `web/src/shell/StatusBar.svelte`, replace

```svelte
  <span class="item">{PHASE_LABELS[device.phase]}{device.info ? ` · ${device.info.firmware}` : ""}</span>
```

with

```svelte
  <span class="item">{PHASE_LABELS[device.phase]}{device.simulated ? ` · ${device.productName}` : device.info ? ` · ${device.info.firmware}` : ""}</span>
```

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: 0 errors, 0 warnings; build succeeds.

- [ ] **Step 5: Look at it**

Run in the background: `npx vite --port 5180 --strictPort`. Open `http://localhost:5180/`. Expected: the banner "Demo: a simulated DSP. Nothing here reaches real hardware." with a "Connect DSP…" button; the top bar shows "Demo DSP" and "Connect DSP…" (no Disconnect); the status bar reads "Connected · Demo DSP". Mute Out 1 on the Overview: its meter drops to the floor; unmute: it moves again. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add web/src/App.svelte web/src/shell/TopBar.svelte web/src/shell/StatusBar.svelte
git commit -m "feat(web): demo banner, Connect DSP and Try the demo"
```

---

### Task 7: Recording `docs/demo.webp`

**Files:**
- Modify: `web/vite.config.ts` (preview uses the Pages base)
- Modify: `web/package.json`, `web/package-lock.json` (dev dependency and script)
- Create: `web/tools/capture-demo.ts`
- Create: `docs/demo.webp` (the recording)

**Interfaces:**
- Consumes: the demo on `?demo` (Tasks 4 to 6), and these existing UI hooks: tabs `[role="tab"][data-view="…"]` (`overview`, `setup`, `4` = Out 1, `system`, `settings`); Overview mute toggles `button[title^="Mute Out 3"]` (prefix match: right after connecting the mute is unknown and the title reads "Mute Out 3: unknown (the device can't report it). Click to set."); EQ handles `role="button"` named `Band 3`; Setup preset select labelled `Preset` with the option "2.1 Outdoor"; layout cards `button.card` (the 2.2 card has the text "Stereo tops and stereo subs"); the time alignment toggle `button[title="Time alignment"]`; the slider named `Alignment point`; the Settings group named `Theme` with buttons `Light` and `Dark`; the banner text "Demo: a simulated DSP".

- [ ] **Step 1: Preview with the Pages base**

In `web/vite.config.ts`, replace the comment and config with:

```ts
// base: "./" for the Android WebView build (VITE_TARGET=android — assets resolve
// under the WebViewAssetLoader path); "/" for the ESP32-hosted build (VITE_TARGET=esp,
// output in dist-esp, see tools/build-esp.ts); "/opendsp-4x4/" for the GitHub Pages
// project site and `vite preview` of it; "/" for local dev.
const target = process.env.VITE_TARGET;

export default defineConfig(({ command, isPreview }) => ({
  base: target === "android" ? "./" : target === "esp" || (command !== "build" && !isPreview) ? "/" : "/opendsp-4x4/",
  build: target === "esp" ? { outDir: "dist-esp" } : undefined,
  plugins: [svelte()],
}));
```

- [ ] **Step 2: Add `playwright-core` and the script**

Run: `npm install --save-dev --save-exact playwright-core@1.64.1`
Expected: `package.json` lists `"playwright-core": "1.64.1"` in `devDependencies`; no browser is downloaded (playwright-core never downloads one).

In `web/package.json` `scripts`, after `"hw:latency"` add:

```json
    "capture:demo": "node --experimental-strip-types tools/capture-demo.ts"
```

(add the comma after the `hw:latency` line.)

- [ ] **Step 3: Write the capture script**

Create `web/tools/capture-demo.ts`:

```ts
// Records docs/demo.webp, the README's animated screenshot: the Pages build of the app on
// the demo device, walking through six pages with one small edit on each. Needs Chrome or
// Chromium (CHROME_PATH, else google-chrome-stable or chromium on the PATH) and ffmpeg
// with the libwebp_anim encoder.
//
//   npm run capture:demo
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";

const VIEWPORT = { width: 1280, height: 800 };
const FPS = 12;
const WEBP_QUALITY = 70;
const WEB_DIR = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(WEB_DIR, "../docs/demo.webp");
const BASE_PATH = "/opendsp-4x4/";
const STEP_TIMEOUT_MS = 5000;

interface Point { x: number; y: number }
interface Frame { timestamp: number; data: string }

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function commandPath(name: string): string | null {
  const result = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function findChrome(): string {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv) return fromEnv;
  for (const name of ["google-chrome-stable", "chromium"]) {
    const path = commandPath(name);
    if (path) return path;
  }
  throw new Error("Chrome not found: set CHROME_PATH, or install google-chrome-stable or chromium");
}

function checkFfmpeg(): void {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error("ffmpeg not found on the PATH");
  if (!result.stdout.includes("libwebp_anim")) throw new Error("this ffmpeg has no libwebp_anim encoder");
}

function build(): void {
  const result = spawnSync("npm", ["run", "build"], { cwd: WEB_DIR, stdio: "inherit" });
  if (result.status !== 0) throw new Error("npm run build failed");
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function startPreview(port: number): ChildProcess {
  const vite = join(WEB_DIR, "node_modules/.bin/vite");
  return spawn(vite, ["preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: WEB_DIR, stdio: "ignore" });
}

async function waitForServer(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error(`the preview server did not answer at ${url}`);
}

/** Runs in the page: a dot that follows the pointer, so clicks and drags show in the recording. */
function installCursor(): void {
  let x = -100;
  let y = -100;
  let pressed = false;
  const dot = document.createElement("div");
  dot.style.cssText = [
    "position:fixed", "left:0", "top:0", "width:18px", "height:18px", "margin:-9px 0 0 -9px", "border-radius:50%",
    "background:rgba(255,255,255,.85)", "border:2px solid rgba(0,0,0,.6)", "box-shadow:0 0 6px rgba(0,0,0,.5)",
    "pointer-events:none", "z-index:2147483647",
  ].join(";");
  const place = () => { dot.style.transform = `translate(${x}px, ${y}px) scale(${pressed ? 0.7 : 1})`; };
  addEventListener("pointermove", (event) => { x = event.clientX; y = event.clientY; place(); }, true);
  addEventListener("pointerdown", () => { pressed = true; place(); }, true);
  addEventListener("pointerup", () => { pressed = false; place(); }, true);
  addEventListener("DOMContentLoaded", () => { document.body.append(dot); place(); });
}

/** Moves the mouse in visible, eased steps and remembers where it is. */
class Pointer {
  private readonly page: Page;
  private at: Point = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };

  constructor(page: Page) {
    this.page = page;
  }

  async glide(to: Point, durationMs = 450): Promise<void> {
    const from = this.at;
    const steps = Math.max(1, Math.round(durationMs / 16));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t * t * (3 - 2 * t);
      await this.page.mouse.move(from.x + (to.x - from.x) * ease, from.y + (to.y - from.y) * ease);
      await this.page.waitForTimeout(16);
    }
    this.at = to;
  }

  async click(target: Locator): Promise<void> {
    await this.glide(await centreOf(target));
    await this.page.mouse.down();
    await this.page.waitForTimeout(90);
    await this.page.mouse.up();
  }

  async drag(from: Point, to: Point, durationMs: number): Promise<void> {
    await this.glide(from);
    await this.page.mouse.down();
    await this.glide(to, durationMs);
    await this.page.mouse.up();
  }
}

async function centreOf(target: Locator): Promise<Point> {
  await target.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await target.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS });
  const box = await target.boundingBox();
  if (!box) throw new Error("the control has no box on screen");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    throw new Error(`step "${name}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

const tab = (page: Page, view: string) => page.locator(`[role="tab"][data-view="${view}"]`);

async function walkThrough(page: Page): Promise<void> {
  const pointer = new Pointer(page);
  const wait = (ms: number) => page.waitForTimeout(ms);

  await step("Overview: mute and unmute Out 3", async () => {
    await wait(1200);
    const mute = page.locator('button[title^="Mute Out 3"]').first();
    await pointer.click(mute);
    await wait(1100);
    await pointer.click(mute);
    await wait(900);
  });

  await step("Out 1: drag a PEQ handle", async () => {
    await pointer.click(tab(page, "4"));
    await wait(700);
    const handle = page.getByRole("button", { name: "Band 3", exact: true });
    const start = await centreOf(handle);
    await pointer.drag(start, { x: start.x + 110, y: start.y - 45 }, 1300);
    await wait(1200);
  });

  await step("Setup: 2.1 Outdoor, then the 2.2 layout", async () => {
    await pointer.click(tab(page, "setup"));
    await wait(600);
    const preset = page.getByLabel("Preset", { exact: true });
    await pointer.glide(await centreOf(preset));
    await preset.selectOption({ label: "2.1 Outdoor" });
    await wait(1300);
    await pointer.click(page.locator("button.card", { hasText: "Stereo tops and stereo subs" }));
    await wait(1400);
  });

  await step("Time alignment: switch it on and drag the point", async () => {
    const toggle = page.locator('button[title="Time alignment"]');
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await pointer.click(toggle);
    await wait(900);
    const slider = page.getByRole("slider", { name: "Alignment point" });
    await centreOf(slider);
    const box = await slider.boundingBox();
    if (!box) throw new Error("the alignment point has no box on screen");
    const y = box.y + box.height * 0.5;
    await pointer.drag({ x: box.x + box.width * 0.2, y }, { x: box.x + box.width * 0.8, y }, 1800);
    await wait(1300);
  });

  await step("System", async () => {
    await pointer.click(tab(page, "system"));
    await wait(2600);
  });

  await step("Settings: light theme and back", async () => {
    await pointer.click(tab(page, "settings"));
    await wait(700);
    const theme = page.getByRole("group", { name: "Theme" });
    await pointer.click(theme.getByRole("button", { name: "Light", exact: true }));
    await wait(1400);
    await pointer.click(theme.getByRole("button", { name: "Dark", exact: true }));
    await wait(700);
    await pointer.click(tab(page, "overview"));
    await wait(500);
  });
}

async function startRecording(page: Page): Promise<() => Promise<Frame[]>> {
  const cdp = await page.context().newCDPSession(page);
  const frames: Frame[] = [];
  cdp.on("Page.screencastFrame", (event) => {
    frames.push({ timestamp: event.metadata.timestamp ?? Date.now() / 1000, data: event.data });
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId });
  });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 });
  return async () => {
    await cdp.send("Page.stopScreencast");
    return frames;
  };
}

/** The frames at a steady rate: each one is the last screencast frame at or before its time. */
function resample(frames: Frame[], fps: number): Frame[] {
  if (frames.length === 0) throw new Error("the screencast sent no frames");
  const start = frames[0]!.timestamp;
  const end = frames[frames.length - 1]!.timestamp;
  const steady: Frame[] = [];
  let index = 0;
  for (let t = start; t <= end; t += 1 / fps) {
    while (index + 1 < frames.length && frames[index + 1]!.timestamp <= t) index++;
    steady.push(frames[index]!);
  }
  return steady;
}

function encode(frameDir: string): void {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-framerate", String(FPS), "-i", join(frameDir, "frame-%05d.png"),
    "-c:v", "libwebp_anim", "-lossless", "0", "-quality", String(WEBP_QUALITY), "-compression_level", "6", "-loop", "0", OUTPUT,
  ], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("ffmpeg could not encode the WebP");
}

async function main(): Promise<void> {
  const chromePath = findChrome();
  checkFfmpeg();
  build();
  const port = await freePort();
  const server = startPreview(port);
  const frameDir = mkdtempSync(join(tmpdir(), "opendsp-capture-"));
  const browser = await chromium.launch({ executablePath: chromePath });
  try {
    const url = `http://127.0.0.1:${port}${BASE_PATH}?demo`;
    await waitForServer(url);
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    await page.addInitScript(installCursor);
    await page.goto(url);
    await step("open the demo", async () => {
      await page.getByText("Demo: a simulated DSP").waitFor({ timeout: STEP_TIMEOUT_MS });
      await page.locator('button[title^="Mute Out 3"]').first().waitFor({ timeout: STEP_TIMEOUT_MS });
    });
    const stop = await startRecording(page);
    await walkThrough(page);
    const frames = resample(await stop(), FPS);
    frames.forEach((frame, i) => {
      writeFileSync(join(frameDir, `frame-${String(i + 1).padStart(5, "0")}.png`), Buffer.from(frame.data, "base64"));
    });
    encode(frameDir);
    const sizeMb = statSync(OUTPUT).size / 1e6;
    console.log(`${OUTPUT}: ${frames.length} frames, ${(frames.length / FPS).toFixed(1)} s, ${sizeMb.toFixed(2)} MB`);
  } finally {
    await browser.close();
    server.kill();
    rmSync(frameDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors, 0 warnings (the tools directory is included in `tsconfig.json`).

- [ ] **Step 5: Record**

Run: `npm run capture:demo`
Expected: the build output, then one line `…/docs/demo.webp: N frames, about 25 s, X MB`. If a step fails, the message names it: fix the locator in that step against the live page (`npx vite preview` and look), and run again.

- [ ] **Step 6: Check the size and look at it**

If X is above 4 MB, lower `WEBP_QUALITY` by 10 (not below 50) and run Step 5 again; if it is still above 4 MB at 50, report the size instead of going further. Open `docs/demo.webp` in Chrome (`google-chrome-stable docs/demo.webp` or drag it into a tab) and check: it loops; the dot shows each click and drag; all six pages appear in order; the meters move; the dark theme is back at the end.

- [ ] **Step 7: Commit**

```bash
git add web/vite.config.ts web/package.json web/package-lock.json web/tools/capture-demo.ts docs/demo.webp
git commit -m "feat(web): record the README animation from the demo (npm run capture:demo)"
```

---

### Task 8: README, and the checks before pushing

**Files:**
- Modify: `README.md`
- Delete: `docs/screenshot.png`

- [ ] **Step 1: README**

In `README.md`:

Replace line 7
`**[Open the web app](https://askz.github.io/opendsp-4x4/)** · plug the DSP in, click *Connect…*`
with
```markdown
**[Open the web app](https://askz.github.io/opendsp-4x4/)** · plug the DSP in, click *Connect…*.
No DSP plugged in? It opens a demo with a simulated DSP ([try the demo](https://askz.github.io/opendsp-4x4/?demo)).
```

Replace the image line
`![openDSP-4x4: tabbed editor with channel tabs and live meters, an output page with EQ graph, filter table and compressor](docs/screenshot.png)`
with
`![openDSP-4x4 on the demo device: the Overview with live meters, an output's EQ, Setup with a layout and time alignment, System and Settings](docs/demo.webp)`

In "Features", after the "Robust connection" bullet add:

```markdown
- **Demo**: without a DSP the web app runs against a simulated one whose meters follow the
  gain, mute, routing and test tone, so every page can be tried; *Connect DSP…* switches to
  the real device.
```

Replace the dev note
```markdown
- **No hardware?** Open the dev server with `?mock` (e.g. `http://localhost:5173/?mock`) to run
  against a simulated DSP that reproduces the real device's replies and timing.
```
with
```markdown
- **No hardware?** The web app starts the demo on its own when no granted DSP is plugged in;
  `?demo` (e.g. `http://localhost:5173/?demo`) forces it. The simulated DSP reproduces the real
  device's replies and timing.
- **README animation**: `npm run capture:demo` records `docs/demo.webp` from the demo (needs
  Chrome or Chromium and ffmpeg with libwebp).
```

In the Architecture block, replace `HidLink (WebHID / Android bridge / mock) → RequestChannel` with `HidLink (WebHID / Android bridge / ESP32 WebSocket / demo) → RequestChannel`.

- [ ] **Step 2: Remove the old screenshot**

Run (from the repository root): `git rm docs/screenshot.png`

- [ ] **Step 3: Check nothing else points at it**

Run (from the repository root): `rg -n "screenshot.png|\?mock" --glob '!node_modules' --glob '!dist*' --glob '!docs/superpowers/**'`
Expected: no output.

- [ ] **Step 4: Full checks**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests PASS; 0 errors, 0 warnings; build succeeds. Note the size of `dist/assets/index-*.js` and compare with the size noted before Task 1.

Run: `VITE_TARGET=android npm run build && npm run build`
Expected: both succeed (the second restores the Pages build in `dist`).

- [ ] **Step 5: Commit**

```bash
git add README.md docs/screenshot.png
git commit -m "docs: README shows the demo animation and how to try the demo"
```

(`git add` of the deleted path records the deletion; `docs/FIRMWARE.md` stays unstaged.)

- [ ] **Step 6: Manual checks on the preview build (controller)**

Run in the background: `npx vite preview --port 5181 --strictPort`. In one tab at `http://localhost:5181/opendsp-4x4/`:
1. The demo starts on open with its banner; the status bar reads "Connected · Demo DSP".
2. Meters react: mute and unmute an output; lower an input's gain; set an output's routing to none; start a pink test tone in System (every input at the same steady level), then stop it.
3. In Setup, start a fine-tuning on a 2.1 layout and cancel it; DevTools → Application → Local Storage: the tuning session key holds no snapshot.
Stop the server.

Then the no-WebHID case (Firefox is not installed here): run `chromium --user-data-dir="$(mktemp -d)" --disable-blink-features=WebHID http://localhost:5181/opendsp-4x4/` with the preview running again, and check in DevTools that `"hid" in navigator` is `false`. Expected: the demo runs, the banner says connecting a DSP needs Chrome or Edge on a computer, or the Android app, and there is no Connect DSP button. If the flag does not remove `navigator.hid`, report that this case was not checked in a browser (the unit test in Task 3 covers the lifecycle).

- [ ] **Step 7: Hand over**

Report to the user: the commits, the WebP size, the bundle size change, and that pushing `main` publishes Pages together with every unpushed commit (`git rev-list --count origin/main..main`). Ask before pushing. The hardware check is the user's: on the Pages site with the DSP plugged in, Connect DSP opens the picker and the real device replaces the demo; cancelling keeps the demo.

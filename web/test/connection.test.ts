import { test } from "node:test";
import assert from "node:assert/strict";
import { Connection, type ConnectionPhase, type ConnectionSnapshot, type SessionHooks, type SyncReason } from "../src/state/connection.ts";
import type { LinkProvider } from "../src/transport/platform.ts";
import type { HidLink } from "../src/transport/link.ts";
import type { Dsp } from "../src/dsp.ts";
import { Command } from "../src/protocol/commands.ts";
import { MockDsp } from "../src/transport/mock.ts";
import { DemoDsp } from "../src/transport/demo.ts";

class FakeProvider implements LinkProvider {
  nextPick: HidLink | null = null;
  nextExisting: HidLink | null = null;
  canReachDevices = true;
  private readonly attachListeners = new Set<(link: HidLink) => void>();

  supported(): boolean { return this.canReachDevices; }
  async pick(): Promise<HidLink | null> { return this.nextPick; }
  async existing(): Promise<HidLink | null> { return this.nextExisting; }
  onAttach(listener: (link: HidLink) => void): () => void {
    this.attachListeners.add(listener);
    return () => this.attachListeners.delete(listener);
  }
  attach(link: HidLink): void {
    for (const listener of this.attachListeners) listener(link);
  }
}

class HookRecorder {
  syncs: SyncReason[] = [];
  started = 0;
  ended = 0;
  failSync: Error | null = null;

  async sync(dsp: Dsp, reason: SyncReason): Promise<void> {
    this.syncs.push(reason);
    if (this.failSync) throw this.failSync;
    await dsp.presetImage();
  }
}

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

function waitForPhase(connection: Connection, phase: ConnectionPhase, timeoutMs = 3000): Promise<void> {
  if (connection.snapshot.phase === phase) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error(`still ${connection.snapshot.phase}, wanted ${phase}`)); }, timeoutMs);
    const stop = connection.onChange((snapshot) => {
      if (snapshot.phase !== phase) return;
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}

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

test("connect: identify, sync, finalize, then ready", async () => {
  const { provider, recorder, connection, phases } = setup();
  const device = new MockDsp();
  provider.nextPick = device;
  await connection.connect();
  assert.deepEqual(phases, ["connecting", "syncing", "ready"]);
  assert.deepEqual(recorder.syncs, ["connect"]);
  assert.equal(recorder.started, 1);
  assert.equal(connection.snapshot.info?.firmware, "4x4MINIPRO V010 20230106A");
  const codes = device.receivedCodes();
  assert.equal(codes[0], Command.GET_STATUS);
  assert.equal(codes[codes.length - 1], Command.INIT_DONE);
  await connection.dispose();
});

test("unplug → lost; plugging a granted device back in rebinds it", async () => {
  const { provider, recorder, connection } = setup();
  const first = new MockDsp();
  provider.nextExisting = first;
  await connection.autoConnect();
  assert.equal(connection.snapshot.phase, "ready");

  first.unplug();
  await waitForPhase(connection, "lost");
  assert.equal(connection.snapshot.error, "Device disconnected");
  assert.equal(connection.dsp, null);
  assert.equal(recorder.ended, 1);

  provider.attach(new MockDsp());
  await waitForPhase(connection, "ready");
  assert.equal(recorder.started, 2);
  await connection.dispose();
});

test("a ready device that stops answering is declared lost", async () => {
  const { provider, connection } = setup();
  const device = new MockDsp();
  provider.nextPick = device;
  await connection.connect();
  device.unresponsive = true;
  const dsp = connection.dsp!;
  const writes = [4, 5, 6, 7].map((chan) => dsp.mute(chan, false).catch(() => undefined));
  await waitForPhase(connection, "lost");
  await Promise.all(writes);
  assert.equal(connection.snapshot.error, "Device stopped responding");
  await connection.dispose();
});

test("a failing sync ends the session with an error", async () => {
  const { provider, recorder, connection } = setup();
  const device = new MockDsp();
  recorder.failSync = new Error("page 3 is truncated");
  provider.nextPick = device;
  await connection.connect();
  assert.equal(connection.snapshot.phase, "idle");
  assert.equal(connection.snapshot.error, "Connection failed: page 3 is truncated");
  assert.equal(device.isOpen, false);
  assert.equal(recorder.started, 0);
});

test("a link that fails to open leaves the connection idle with the reason", async () => {
  const { provider, connection } = setup();
  const device = new MockDsp();
  device.failOpen = new Error("access denied");
  provider.nextPick = device;
  await connection.connect();
  assert.equal(connection.snapshot.phase, "idle");
  assert.match(connection.snapshot.error, /access denied/);
});

test("after an explicit disconnect, plug-in events are ignored", async () => {
  const { provider, connection } = setup();
  provider.nextPick = new MockDsp();
  await connection.connect();
  await connection.disconnect();
  assert.equal(connection.snapshot.phase, "idle");
  provider.attach(new MockDsp());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(connection.snapshot.phase, "idle");
  await connection.dispose();
});

test("resync re-reads the device and returns to ready", async () => {
  const { provider, recorder, connection, phases } = setup();
  provider.nextPick = new MockDsp();
  await connection.connect();
  await connection.resync();
  assert.deepEqual(recorder.syncs, ["connect", "resync"]);
  assert.deepEqual(phases.slice(-2), ["syncing", "ready"]);
  await connection.dispose();
});

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

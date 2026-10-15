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

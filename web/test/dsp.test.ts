import { test } from "node:test";
import assert from "node:assert/strict";
import { Dsp } from "../src/dsp.ts";
import { RequestChannel } from "../src/transport/channel.ts";
import { Command, ReplyCode, PRESET_SLOT_COUNT } from "../src/protocol/commands.ts";
import { expectedReplyCode, replyTimeoutMs, replyMatcher } from "../src/protocol/exchange.ts";
import { readPresetNameFrame, getLevelsFrame } from "../src/protocol/control.ts";
import { gainRawToDb } from "../src/protocol/control.ts";
import { MockDsp } from "../src/transport/mock.ts";

async function connect(device = new MockDsp()): Promise<{ device: MockDsp; dsp: Dsp }> {
  await device.open();
  return { device, dsp: new Dsp(new RequestChannel(device)) };
}

test("reply rules measured on hardware", () => {
  assert.equal(expectedReplyCode(Command.READ_CHANNEL), Command.REPLY_CHANNEL);
  assert.equal(expectedReplyCode(Command.GET_VERSION), Command.GET_VERSION);
  assert.equal(expectedReplyCode(Command.MUTE), ReplyCode.ACK);
  assert.equal(expectedReplyCode(Command.INIT_DONE), ReplyCode.ACK);
  assert.ok(replyTimeoutMs(Command.STORE_PRESET) > 2200);
  assert.ok(replyTimeoutMs(Command.RECALL_PRESET) > 660);
  const matchSlot3 = replyMatcher(readPresetNameFrame(3));
  assert.equal(matchSlot3({ code: Command.READ_PRESET_NAME, data: Uint8Array.of(3), checksumOk: true }), true);
  assert.equal(matchSlot3({ code: Command.READ_PRESET_NAME, data: Uint8Array.of(4), checksumOk: true }), false);
  assert.equal(replyMatcher(getLevelsFrame())({ code: ReplyCode.ACK, data: new Uint8Array(0), checksumOk: true }), false);
});

test("identify wakes the device, then reads both version strings", async () => {
  const { device, dsp } = await connect();
  const info = await dsp.identify();
  assert.deepEqual(info, { status: 0x1f, version: "4x4MINIPRO V010", firmware: "4x4MINIPRO V010 20230106A" });
  assert.deepEqual(device.receivedCodes(), [Command.GET_STATUS, Command.GET_VERSION, Command.GET_VERSION_FW]);
});

test("presetImage decodes a factory-default unit", async () => {
  const { dsp } = await connect();
  const image = await dsp.presetImage();
  assert.equal(image.presetName, "Default Preset");
  assert.deepEqual(image.inputs.map((input) => input.name), ["InA", "InB", "InC", "InD"]);
  assert.deepEqual(image.outputs.map((output) => output.name), ["Out1", "Out2", "Out3", "Out4"]);
  assert.deepEqual(image.outputs.map((output) => output.routingMask), [0x01, 0x02, 0x04, 0x08]);
  for (const record of [...image.inputs, ...image.outputs]) assert.equal(gainRawToDb(record.gainRaw), 0);
  const out1 = image.outputs[0]!;
  assert.deepEqual(out1.bands.map((band) => band.freqIdx), [31, 71, 118, 161, 200, 240, 270]);
  assert.ok(out1.bands.every((band) => band.gainRaw === 120 && band.qRaw === 25 && band.type === 0));
  assert.equal(out1.lpfRaw, 300);
  assert.equal(out1.comp.thrRaw, 220);
  assert.deepEqual(image.inputs[0]!.gate, { atkRaw: 49, relRaw: 499, holdRaw: 99, thrRaw: 0 });
});

test("presetNames reads every slot; activePreset tracks recall", async () => {
  const { device, dsp } = await connect();
  device.presetNames[5] = "Band night";
  const names = await dsp.presetNames();
  assert.equal(names.length, PRESET_SLOT_COUNT);
  assert.equal(names[5], "Band night");
  await dsp.recallPreset(7);
  assert.equal(await dsp.activePreset(), 7);
});

test("preset slots outside 0..29 are refused before reaching the device", async () => {
  const { device, dsp } = await connect();
  assert.throws(() => dsp.recallPreset(PRESET_SLOT_COUNT), RangeError);
  assert.throws(() => dsp.storePreset(-1), RangeError);
  assert.equal(device.received.length, 0);
});

test("levels decodes the 8 meters from a background poll", async () => {
  const { device, dsp } = await connect();
  device.levels = [-90, -36, 0, -72, -75, -75, -75, 0]; // dBFS
  const levels = await dsp.levels();
  assert.equal(levels?.length, 8);
  assert.equal(levels?.[0], 0);
  assert.ok(Math.abs(levels![1]! - 0.5) < 1e-4);
  assert.ok(Math.abs(levels![2]! - 1) < 1e-4);
  assert.ok(Math.abs(levels![7]! - 1) < 1e-4);
});

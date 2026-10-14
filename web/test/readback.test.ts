import { test } from "node:test";
import assert from "node:assert/strict";
import type { Reply } from "../src/protocol/frame.ts";
import { levelsDbFromReply, levelsFromReply, reconstructPresetImage, parsePresetImage } from "../src/protocol/readback.ts";

const bytes = (hex: string) => Uint8Array.from(hex.split(" ").map((b) => parseInt(b, 16)));

// 0x40 level reply, captured on hardware (4x4MINIPRO V010, programme audio on In A → Out 1).
// Per channel c the firmware packs a 32-bit DSP level word as [bits23..16, bits31..24, bits15..8].
const CAPTURED_LEVELS = bytes("04 00 ec 00 00 04 00 00 03 00 00 04 04 00 2b 00 00 0b 00 00 0b 00 00 0b 00 01 00");

test("GOLDEN: levelsDbFromReply decodes the captured 0x40 reply as dBFS (2^24 = full scale)", () => {
  const db = levelsDbFromReply({ code: 0x40, data: CAPTURED_LEVELS, checksumOk: true })!;
  const expected = [0x0004ec00, 0x00000400, 0x00000300, 0x00000400, 0x00042b00, 0x00000b00, 0x00000b00, 0x00000b00]
    .map((word) => 20 * Math.log10(word / 2 ** 24));
  assert.equal(db.length, 8);
  db.forEach((value, i) => assert.ok(Math.abs(value - expected[i]!) < 1e-9, `channel ${i}: ${value} vs ${expected[i]}`));
  assert.ok(Math.abs(db[0]! - -34.32) < 0.01); // In A, programme audio
  assert.ok(Math.abs(db[5]! - -75.50) < 0.01); // Out 2, idle noise floor
});

test("levelsDbFromReply uses the high byte (bits 31..24) and maps silence to -Infinity", () => {
  const data = new Uint8Array(27);
  data[1] = 0x01; // In A word 0x01000000 = 0 dBFS
  const db = levelsDbFromReply({ code: 0x40, data, checksumOk: true })!;
  assert.equal(db[0], 0);
  assert.equal(db[1], -Infinity);
});

test("levelsFromReply maps -72..0 dBFS onto the 0..1 meter", () => {
  const lv = levelsFromReply({ code: 0x40, data: CAPTURED_LEVELS, checksumOk: true })!;
  assert.equal(lv.length, 8);
  assert.ok(Math.abs(lv[0]! - (72 - 34.3157) / 72) < 1e-3); // In A ≈ 0.52
  assert.equal(lv[1], 0); // idle input below the floor
  assert.equal(lv[5], 0); // idle output (-75.5 dBFS) below the floor
  const full = new Uint8Array(27);
  full[1] = 0x01;
  assert.equal(levelsFromReply({ code: 0x40, data: full, checksumOk: true })![0], 1);
});

test("levelsFromReply rejects non-0x40 / short replies", () => {
  assert.equal(levelsFromReply({ code: 0x13, data: new Uint8Array(27), checksumOk: true }), null);
  assert.equal(levelsFromReply({ code: 0x40, data: new Uint8Array(10), checksumOk: true }), null);
});

// 450-byte preset image: name @+2; input records @16/40/64/88 (gain @+18);
// output records @112/186/260/334 (gain @+66).
test("parsePresetImage extracts preset name, channel names, gains", () => {
  const img = new Uint8Array(450);
  const put = (o: number, s: string) => img.set(new TextEncoder().encode(s), o);
  const u16 = (o: number, v: number) => { img[o] = v & 0xff; img[o + 1] = (v >> 8) & 0xff; };
  put(2, "Default Preset");
  put(16, "InA"); u16(16 + 18, 280);   // ≈ 0 dB on the level-raw scale
  put(112, "Out1"); u16(112 + 66, 400); img[112 + 8] = 0x05; // gain ≈ +12 dB, routing InA+InC
  const pr = parsePresetImage(img);
  assert.equal(pr.presetName, "Default Preset");
  assert.equal(pr.inputs[0]!.name, "InA");
  assert.equal(pr.inputs[0]!.gainRaw, 280);
  assert.equal(pr.outputs[0]!.name, "Out1");
  assert.equal(pr.outputs[0]!.gainRaw, 400);
  assert.equal(pr.outputs[0]!.routingMask, 0x05);
});

test("reconstructPresetImage concatenates nine 50-byte pages", () => {
  const pages = Array.from({ length: 9 }, (_, i) => new Uint8Array(50).fill(i + 1));
  const img = reconstructPresetImage(pages);
  assert.equal(img.length, 450);
  assert.equal(img[0], 1);
  assert.equal(img[50], 2);
  assert.equal(img[449], 9);
});

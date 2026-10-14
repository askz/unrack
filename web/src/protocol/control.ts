// Pure command-frame builders for the confirmed opcodes. These return ready-to-send
// 64-byte request frames; they take no transport, so they're fully unit-testable.
import { buildRequest } from "./frame.ts";
import { Command } from "./commands.ts";

/** Mute/un-mute a channel. chan: see Channel (Output 1 = 0x04). */
export function muteFrame(chan: number, on: boolean): Uint8Array {
  return buildRequest(Command.MUTE, Uint8Array.of(chan & 0xff, on ? 1 : 0));
}

/** Invert/normal polarity on a channel. */
export function polarityFrame(chan: number, invert: boolean): Uint8Array {
  return buildRequest(Command.POLARITY, Uint8Array.of(chan & 0xff, invert ? 1 : 0));
}

/** Set a channel level as the raw device value (0..400). */
export function levelRawFrame(chan: number, raw16: number): Uint8Array {
  const v = Math.max(0, Math.min(400, Math.round(raw16)));
  return buildRequest(Command.LEVEL, Uint8Array.of(chan & 0xff, v & 0xff, (v >> 8) & 0xff));
}

// Gain mapping, two segments (firmware converters sub_6880 inputs / sub_6830 outputs,
// see docs/FIRMWARE.md):
//   raw >= 80: dB = (raw - 280) / 10   (0.1 dB/step; 0 dB = 280 factory default, +12 dB = 400)
//   raw <  80: dB = raw / 2 - 60       (0.5 dB/step; -20 dB at raw 80)
// Raw 0 (-60 dB) is a hard mute on the device.
const GAIN_ZERO_DB = 280;
const GAIN_UNITS_PER_DB = 10;
const GAIN_KNEE_RAW = 80; // -20 dB
const GAIN_LOW_UNITS_PER_DB = 2;
const GAIN_MIN_DB = -60;
export const GAIN_MAX_RAW = 400; // +12 dB

/** Unrounded raw level for a dB value (the fader uses it as its travel). */
export function gainDbToRawContinuous(db: number): number {
  return db >= gainRawToDb(GAIN_KNEE_RAW)
    ? GAIN_ZERO_DB + db * GAIN_UNITS_PER_DB
    : (db - GAIN_MIN_DB) * GAIN_LOW_UNITS_PER_DB;
}
export function gainDbToRaw(db: number): number {
  return Math.max(0, Math.min(GAIN_MAX_RAW, Math.round(gainDbToRawContinuous(db))));
}
export function gainRawToDb(raw: number): number {
  return raw >= GAIN_KNEE_RAW
    ? (raw - GAIN_ZERO_DB) / GAIN_UNITS_PER_DB
    : raw / GAIN_LOW_UNITS_PER_DB + GAIN_MIN_DB;
}

/** Set a channel level in dB. */
export function levelDbFrame(chan: number, db: number): Uint8Array {
  return levelRawFrame(chan, gainDbToRaw(db));
}

export function recallPresetFrame(slot: number): Uint8Array {
  return buildRequest(Command.RECALL_PRESET, Uint8Array.of(slot & 0xff));
}

export function storePresetFrame(slot: number): Uint8Array {
  return buildRequest(Command.STORE_PRESET, Uint8Array.of(slot & 0xff));
}

export function getVersionFrame(): Uint8Array {
  return buildRequest(Command.GET_VERSION);
}

/** Long version query, e.g. "4x4MINIPRO V010 20230106A". */
export function getFirmwareVersionFrame(): Uint8Array {
  return buildRequest(Command.GET_VERSION_FW);
}

/** Active preset slot (0..29), updated by recall and store. */
export function getActivePresetFrame(): Uint8Array {
  return buildRequest(Command.GET_ACTIVE_PRESET);
}

/** Status/wake query — the editor sends this first after connecting (0x13 only replies after it). */
export function getStatusFrame(): Uint8Array {
  return buildRequest(Command.GET_STATUS);
}

/** Poll the 8 in/out audio levels (reply carries the meters). */
export function getLevelsFrame(): Uint8Array {
  return buildRequest(Command.READBACK_LEVELS);
}

/** Read the 30-byte flags/link table (holds live mute state, not in the preset image). */
export function getFlagsBlockFrame(): Uint8Array {
  return buildRequest(Command.GET_FLAGS_BLOCK);
}

/** Read a preset's 14-char name by slot (0..29). */
export function readPresetNameFrame(index: number): Uint8Array {
  return buildRequest(Command.READ_PRESET_NAME, Uint8Array.of(index & 0xff));
}

/** Read a channel's 50-byte state block by index (0..8); reply code is 0x24. */
export function readChannelFrame(index: number): Uint8Array {
  return buildRequest(Command.READ_CHANNEL, Uint8Array.of(index & 0xff));
}

/** Finalize the startup handshake (device acks). */
export function finalizeFrame(): Uint8Array {
  return buildRequest(Command.INIT_DONE);
}

/** Test tone: source (ToneSource) + sine frequency index (into TONE_FREQS). */
export function testToneFrame(source: number, freqIndex = 0): Uint8Array {
  return buildRequest(Command.TEST_TONE, Uint8Array.of(source & 0xff, freqIndex & 0xff));
}

/** Set the 4-character lock password (default "1234"). */
export function setPasswordFrame(pw: string): Uint8Array {
  const bytes = new TextEncoder().encode(pw.slice(0, 4).padEnd(4, "0"));
  return buildRequest(Command.SET_PASSWORD, bytes);
}

/**
 * Set a PEQ band, raw 16-bit params. Layout from capture: [chan, band, f16, q16, g16, 0].
 * The freq/Q/gain encodings are not yet calibrated — see PROTOCOL.md / pending capture.
 */
export function peqBandRawFrame(chan: number, band: number, f16: number, q16: number, g16: number): Uint8Array {
  const le = (v: number) => [v & 0xff, (v >> 8) & 0xff];
  return buildRequest(Command.PEQ_BAND, Uint8Array.of(chan & 0xff, band & 0xff, ...le(f16), ...le(q16), ...le(g16), 0));
}

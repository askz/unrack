// DSP-block command builders + unit conversions, all derived and validated by
// observing the device's USB traffic (one control at a time).
// See ../../../PROTOCOL.md for the field layouts.
import { buildRequest } from "./frame.ts";
import { Command } from "./commands.ts";

const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];

// ---- unit conversions ----

/** Threshold (compressor & gate): raw = (dB + 90) * 2. */
export const thresholdDbToRaw = (db: number) => Math.round((db + 90) * 2);
export const thresholdRawToDb = (raw: number) => raw / 2 - 90;

/** Delay: 48 kHz, stored in samples. Max 32640 samples (680 ms). */
export const msToSamples = (ms: number) => Math.max(0, Math.min(32640, Math.round(ms * 48)));
export const samplesToMs = (s: number) => s / 48;

/** Compressor/gate attack/release/hold: device raw, ms = raw + 1 (firmware-confirmed,
 * converter at 0x2c34; see docs/FIRMWARE.md). */
export const timeMsToRaw = (ms: number) => Math.max(0, Math.round(ms) - 1);
export const timeRawToMs = (raw: number) => raw + 1;

/** PEQ frequency: log index 0..300, 30 steps/octave (0 = 19.7 Hz, 300 = 20.16 kHz) — same
 * scale as the crossover. Capture-verified: editor 40.3 Hz = index 31 = 19.7·2^(31/30). */
export const hzToPeqIndex = (hz: number) =>
  Math.max(0, Math.min(300, Math.round(30 * Math.log2(hz / 19.7))));
export const peqIndexToHz = (i: number) => 19.7 * Math.pow(2, i / 30);

/**
 * PEQ Q: single byte (q8), exponential. The firmware (4x4MINIPRO image, biquad builder at
 * 0x3264) computes 1/Q = 1.0594^(100 - raw) / 128, i.e. Q = 128 / 1.0594^(100 - raw). So
 * raw 16 = Q 1.0, raw 100 = Q 128, and every +12 counts doubles Q. The constant 1.0594 is the
 * firmware's stored value for 2^(1/12). raw is clamped to 0..100 (Q ≈ 0.40..128).
 * Confirmed by the High-Pass golden capture (q8 10 = Q 0.71, i.e. Butterworth). See docs/FIRMWARE.md.
 */
const Q_BASE = 1.0594;
export const qToRaw = (q: number) =>
  Math.max(0, Math.min(100, Math.round(100 - Math.log(128 / q) / Math.log(Q_BASE))));
export const rawToQ = (raw: number) => 128 / Math.pow(Q_BASE, 100 - raw);

// ---- block builders (return 64-byte request frames) ----

/** Compressor (full state). thresholdDb e.g. -10; ratioIndex 0..15 (see Ratio). */
export function compressorFrame(
  chan: number,
  o: { ratioIndex: number; kneeDb: number; attackMs: number; releaseMs: number; thresholdDb: number },
): Uint8Array {
  return buildRequest(Command.COMPRESSOR, Uint8Array.of(
    chan & 0xff, o.ratioIndex & 0xff, o.kneeDb & 0xff,
    ...le16(timeMsToRaw(o.attackMs)), ...le16(timeMsToRaw(o.releaseMs)), ...le16(thresholdDbToRaw(o.thresholdDb)),
  ));
}

/** Gate (full state). */
export function gateFrame(
  chan: number,
  o: { attackMs: number; releaseMs: number; holdMs: number; thresholdDb: number },
): Uint8Array {
  return buildRequest(Command.GATE, Uint8Array.of(
    chan & 0xff,
    ...le16(timeMsToRaw(o.attackMs)), ...le16(timeMsToRaw(o.releaseMs)), ...le16(timeMsToRaw(o.holdMs)),
    ...le16(thresholdDbToRaw(o.thresholdDb)),
  ));
}

/** Crossover. freqRaw is the device's 16-bit freq index (its Hz scale differs from PEQ; raw for now). */
export function crossoverHpfFrame(chan: number, freqRaw: number, slope: number): Uint8Array {
  return buildRequest(Command.CROSSOVER_HPF, Uint8Array.of(chan & 0xff, ...le16(freqRaw), slope & 0xff));
}
export function crossoverLpfFrame(chan: number, freqRaw: number, slope: number): Uint8Array {
  return buildRequest(Command.CROSSOVER_LPF, Uint8Array.of(chan & 0xff, ...le16(freqRaw), slope & 0xff));
}

/** Delay in samples (use msToSamples for ms). */
export function delayFrame(chan: number, samples: number): Uint8Array {
  return buildRequest(Command.DELAY, Uint8Array.of(chan & 0xff, ...le16(samples)));
}
export const delayMsFrame = (chan: number, ms: number) => delayFrame(chan, msToSamples(ms));

/** Routing: which inputs feed an output. inputMask bits: InA=1, InB=2, InC=4, InD=8. */
export function routingFrame(outChan: number, inputMask: number): Uint8Array {
  return buildRequest(Command.ROUTING, Uint8Array.of(outChan & 0xff, inputMask & 0xff));
}

/**
 * PEQ band. Layout (capture-verified): [chan, band, gain16, freq16, q8, type8, bypass8].
 * gainRaw 16-bit (0..240, 0 dB = 120); freq -> 16-bit log index (30/oct, same as crossover);
 * q -> single byte. NB gain comes first (not the RBJ freq/q/gain order) — verified by an
 * editor gain ramp + a fixed-freq (40.3 Hz) capture.
 */
export function peqBandFrame(
  chan: number, band: number,
  o: { freqHz: number; q: number; gainRaw: number; type: number; bypass?: boolean },
): Uint8Array {
  return buildRequest(Command.PEQ_BAND, Uint8Array.of(
    chan & 0xff, band & 0xff,
    ...le16(o.gainRaw), ...le16(hzToPeqIndex(o.freqHz)),
    qToRaw(o.q) & 0xff, o.type & 0xff, o.bypass ? 1 : 0,
  ));
}

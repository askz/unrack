// Builds the model from a decoded preset image. The image has no mute or PEQ-bypass
// state, so those come back unknown (null) unless a previous model still knows
// mute (mute is live state, not part of a preset, so it survives a recall).
import type { Calibration } from "../eq/calibration.ts";
import type { PresetReadback } from "../protocol/readback.ts";
import { gainRawToDb } from "../protocol/control.ts";
import { peqIndexToHz, rawToQ, samplesToMs, thresholdRawToDb, timeRawToMs } from "../protocol/blocks.ts";
import { OUT_BASE, defaultModel, type DeviceModel } from "./model.ts";

export function modelFromReadback(image: PresetReadback, cal: Calibration, previous?: DeviceModel): DeviceModel {
  const model = defaultModel();
  model.presetName = image.presetName;

  image.inputs.forEach((record, i) => {
    const ch = model.channels[i]!;
    if (record.name) ch.name = record.name;
    ch.gainDb = gainRawToDb(record.gainRaw);
    ch.polarity = record.polarity;
    ch.mute = previous?.channels[i]?.mute ?? null;
    ch.gate = {
      attackMs: timeRawToMs(record.gate.atkRaw), releaseMs: timeRawToMs(record.gate.relRaw),
      holdMs: timeRawToMs(record.gate.holdRaw), thresholdDb: thresholdRawToDb(record.gate.thrRaw),
    };
  });

  image.outputs.forEach((record, i) => {
    const index = OUT_BASE + i;
    const ch = model.channels[index]!;
    if (record.name) ch.name = record.name;
    ch.gainDb = gainRawToDb(record.gainRaw);
    ch.polarity = record.polarity;
    ch.mute = previous?.channels[index]?.mute ?? null;
    ch.delayMs = samplesToMs(record.delaySamples);
    model.routing[i] = record.routingMask;
    ch.comp = {
      ratioIndex: record.comp.ratioIndex, kneeDb: record.comp.kneeRaw,
      attackMs: timeRawToMs(record.comp.atkRaw), releaseMs: timeRawToMs(record.comp.relRaw),
      thresholdDb: thresholdRawToDb(record.comp.thrRaw),
    };
    ch.eq = {
      hpf: { freqHz: cal.xoverRawToHz(record.hpfRaw), slope: record.hpfSlope },
      lpf: { freqHz: cal.xoverRawToHz(record.lpfRaw), slope: record.lpfSlope },
      bands: record.bands.map((band) => {
        const freqHz = peqIndexToHz(band.freqIdx);
        return {
          freqHz, type: band.type, bypass: null,
          gainDb: cal.peqGainRawToDb(band.gainRaw, band.type),
          bwOct: cal.qToBwOct(rawToQ(band.qRaw), freqHz),
        };
      }),
    };
  });

  return model;
}

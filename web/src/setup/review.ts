// What a set of assignments would change, before it is applied: a preview model (for
// the response curves) and one readable line per parameter that really changes once
// quantized to the device's resolution, exactly as the editor would store it.
import type { Calibration } from "../eq/calibration.ts";
import { bwOctToQ } from "../eq/biquad.ts";
import type { Crossover, PeqBand } from "../eq/types.ts";
import { channelLabel, clone, sameValue, type Compressor, type DeviceModel, type Gate } from "../state/model.ts";
import {
  describeParam, normalizeParam, readParam, writeParam,
  type ParamAssignment, type ParamKind, type ParamValue,
} from "../state/params.ts";
import { formatDb, formatHz } from "../ui/format.ts";
import { GAINLESS_PEQ_TYPES, INPUT_LETTERS, PEQ_TYPE_LABELS, RATIO_LABELS, SLOPE_LABELS } from "../ui/labels.ts";

/** A copy of the model with every non-null assignment applied (normalized like the editor does). */
export function previewModel(model: DeviceModel, assignments: readonly ParamAssignment[], cal: Calibration): DeviceModel {
  const next = clone(model);
  for (const { ref, value } of assignments) {
    if (value !== null) writeParam(next, ref, normalizeParam(ref, value, cal));
  }
  return next;
}

function routingText(mask: number): string {
  const inputs = INPUT_LETTERS.filter((_, input) => (mask & (1 << input)) !== 0);
  return inputs.length > 0 ? inputs.join("+") : "none";
}

function bandText(band: PeqBand): string {
  const gain = GAINLESS_PEQ_TYPES.has(band.type) ? "" : ` ${formatDb(band.gainDb)} dB`;
  const off = band.bypass === true ? " (off)" : band.bypass === null ? " (on/off unknown)" : "";
  return `${PEQ_TYPE_LABELS[band.type] ?? "?"} ${formatHz(band.freqHz)} Hz${gain} Q ${bwOctToQ(band.bwOct, band.freqHz).toFixed(1)}${off}`;
}

function crossoverText(crossover: Crossover): string {
  if (crossover.slope === 0) return "Off";
  return `${formatHz(crossover.freqHz)} Hz, ${SLOPE_LABELS[crossover.slope] ?? "?"}`;
}

function compressorText(comp: Compressor): string {
  return `${RATIO_LABELS[comp.ratioIndex] ?? "?"} at ${formatDb(comp.thresholdDb)} dB, ${comp.attackMs} / ${comp.releaseMs} ms`;
}

function gateText(gate: Gate): string {
  return `${formatDb(gate.thresholdDb)} dB, ${gate.attackMs} / ${gate.holdMs} / ${gate.releaseMs} ms`;
}

function valueText(kind: ParamKind, value: ParamValue | null): string {
  if (value === null) return "unknown";
  switch (kind) {
    case "gain": return `${formatDb(value as number)} dB`;
    case "mute": return value ? "muted" : "unmuted";
    case "polarity": return value ? "inverted" : "normal";
    case "delay": return `${(value as number).toFixed(2)} ms`;
    case "routing": return routingText(value as number);
    case "peq": return bandText(value as PeqBand);
    case "hpf":
    case "lpf": return crossoverText(value as Crossover);
    case "comp": return compressorText(value as Compressor);
    case "gate": return gateText(value as Gate);
  }
}

/** "Out 3 routing: C → A+B", one per assignment that changes the model. */
export function describeChanges(
  model: DeviceModel,
  assignments: readonly ParamAssignment[],
  cal: Calibration,
  nameOf: (ch: number) => string = (ch) => model.channels[ch]?.name || channelLabel(ch),
): string[] {
  const lines: string[] = [];
  for (const { ref, value } of assignments) {
    if (value === null) continue;
    const after = normalizeParam(ref, value, cal);
    const before = readParam(model, ref);
    if (sameValue(before, after)) continue;
    lines.push(`${describeParam(ref, nameOf)}: ${valueText(ref.kind, before)} → ${valueText(ref.kind, after)}`);
  }
  return lines;
}

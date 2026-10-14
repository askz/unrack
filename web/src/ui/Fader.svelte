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

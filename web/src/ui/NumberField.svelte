<script lang="ts">
  // Numeric entry: type a value (Enter commits, Escape reverts), ArrowUp/Down or the
  // wheel (hovering is enough) to step — Shift ×10, Alt ×0.1 — or drag vertically with
  // a mouse. Linear or logarithmic stepping. The value is one-way: changes go out
  // through onchange and come back (normalized) through `value`.
  import { tick } from "svelte";
  import type { SyncEntry } from "../state/editor.ts";
  import { parseNumber } from "./format.ts";
  import { attachWheel } from "./wheel.ts";

  interface Props {
    value: number;
    onchange: (value: number) => void;
    /** Gesture finished (commit, blur, pointer up): used to split undo steps. */
    onend?: () => void;
    min: number;
    max: number;
    /** Linear step, or the multiplicative ratio per step when log is set. */
    step: number;
    log?: boolean;
    /** Linear stepping rule (e.g. gain, whose device resolution changes with the value); default from + delta. */
    stepper?: (from: number, delta: number) => number;
    format: (value: number) => string;
    unit?: string;
    label?: string;
    /** Accessible name when there is no visible label (e.g. inside a table). */
    ariaLabel?: string;
    status?: SyncEntry;
    disabled?: boolean;
    width?: string;
  }

  let {
    value, onchange, onend, min, max, step, log = false, stepper, format, unit = "", label = "", ariaLabel,
    status, disabled = false, width = "88px",
  }: Props = $props();

  const DRAG_PIXELS_PER_STEP = 4;
  const DRAG_THRESHOLD_PX = 3;

  let input: HTMLInputElement;
  /** Text the user is typing; null when not typing (the field shows the formatted value). */
  let draft = $state<string | null>(null);
  let drag: { startY: number; startValue: number; moved: boolean; pointerId: number } | null = null;

  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const stepBy = (from: number, steps: number) => clamp(
    log ? from * Math.pow(step, steps) : stepper ? stepper(from, steps * step) : from + steps * step,
  );
  const shown = $derived(draft ?? format(value));
  const title = $derived(
    status?.status === "failed" ? `Not applied on the device: ${status.error ?? "write failed"}`
      : status?.status === "offline" ? "Not sent: device offline"
      : status?.status === "pending" ? "Sending…" : undefined,
  );

  function multiplier(event: KeyboardEvent | WheelEvent | PointerEvent): number {
    if (event.shiftKey) return 10;
    if (event.altKey) return 0.1;
    return 1;
  }

  function emit(next: number): void {
    if (Number.isFinite(next) && next !== value) onchange(next);
  }

  /** Re-show the formatted value, even if it equals what was rendered before typing. */
  async function resync(): Promise<void> {
    await tick();
    if (input && draft === null) input.value = format(value);
  }

  function commitDraft(): void {
    if (draft === null) return;
    const parsed = parseNumber(draft);
    draft = null;
    if (parsed !== null) emit(clamp(parsed));
    onend?.();
    void resync();
  }

  function cancelDraft(): void {
    draft = null;
    void resync();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      commitDraft();
      input.select();
    } else if (event.key === "Escape") {
      cancelDraft();
      input.blur();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      const direction = event.key === "ArrowUp" || event.key === "PageUp" ? 1 : -1;
      const size = event.key.startsWith("Page") ? 10 : multiplier(event);
      draft = null;
      emit(stepBy(value, direction * size));
      void resync();
    }
  }

  $effect(() => attachWheel(input, {
    accepts: () => !disabled,
    step: (steps, multiplier) => {
      draft = null;
      emit(stepBy(value, steps * multiplier));
      void resync();
    },
  }));

  function onPointerDown(event: PointerEvent): void {
    if (disabled || event.pointerType === "touch" || document.activeElement === input || event.button !== 0) return;
    event.preventDefault();
    drag = { startY: event.clientY, startValue: value, moved: false, pointerId: event.pointerId };
    try {
      input.setPointerCapture(event.pointerId);
    } catch {
      // pointer already released (or synthetic): moves over the field still adjust it
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dy = drag.startY - event.clientY;
    if (!drag.moved && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    const steps = Math.round(dy / DRAG_PIXELS_PER_STEP) * multiplier(event);
    emit(stepBy(drag.startValue, steps));
  }

  function onPointerUp(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = drag.moved;
    drag = null;
    if (moved) onend?.();
    else {
      input.focus();
      input.select();
    }
  }
</script>

<label class="field" class:disabled style:width={width} {title}
       data-status={status?.status}>
  {#if label}<span class="label">{label}</span>{/if}
  <span class="box">
    <input
      bind:this={input}
      class="num"
      type="text"
      inputmode="decimal"
      autocomplete="off"
      spellcheck="false"
      value={shown}
      {disabled}
      aria-label={ariaLabel ?? (label || undefined)}
      oninput={(event) => { draft = event.currentTarget.value; }}
      onfocus={() => input.select()}
      onblur={commitDraft}
      onkeydown={onKeydown}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
    />
    {#if unit}<span class="unit">{unit}</span>{/if}
  </span>
</label>

<style>
  .field { display: inline-flex; flex-direction: column; gap: 2px; min-width: 0; }
  .box {
    position: relative; display: flex; align-items: center; height: var(--control-h);
    background: var(--surface); border: 1px solid var(--line-strong); border-radius: var(--radius);
    border-left-width: 3px; border-left-color: var(--line-strong);
  }
  .field:focus-within .box { border-color: var(--accent); }
  .field[data-status="pending"] .box { border-left-color: var(--accent); }
  .field[data-status="offline"] .box { border-left-color: var(--warn); }
  .field[data-status="failed"] .box { border-left-color: var(--bad); }
  input {
    flex: 1; min-width: 0; height: 100%; padding: 0 2px 0 4px; border: 0; background: transparent;
    text-align: right; outline: none; cursor: ns-resize;
  }
  input:focus { cursor: text; }
  .unit { padding: 0 5px 0 2px; font-size: 11px; color: var(--text-faint); }
  .disabled { opacity: .5; }
  .disabled input { cursor: default; }
</style>

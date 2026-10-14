<script lang="ts">
  // Moves all four output gains together, keeping their differences. A button press,
  // a drag, or a run of wheel steps is one gesture and one undo step.
  import { device } from "../state/device.svelte.ts";
  import { settings } from "../state/settings.svelte.ts";
  import { GAIN_RANGE } from "../state/params.ts";
  import { OUT_BASE, OUTPUT_COUNT } from "../state/model.ts";
  import { trimmedGains } from "../state/trim.ts";
  import { attachWheel } from "../ui/wheel.ts";
  import { formatDb } from "../ui/format.ts";

  const WHEEL_IDLE_MS = 800;
  const DRAG_PIXELS_PER_STEP = 6;
  const BUTTON_STEP_DB = 1;
  const MIN_STEP_DB = 0.1;
  const SPAN_DB = GAIN_RANGE.max - GAIN_RANGE.min;
  const OUTPUTS = Array.from({ length: OUTPUT_COUNT }, (_, i) => OUT_BASE + i);

  /** Output gains when the current gesture started; null between gestures. */
  let base: number[] | null = null;
  let offset = $state(0);
  let clamped = $state(false);
  let area: HTMLDivElement;
  let drag: { pointerId: number; startY: number } | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const step = $derived(Math.max(MIN_STEP_DB, settings.value.gainStepDb));
  const round = (db: number) => Math.round(db * 10) / 10;

  function apply(nextOffset: number): void {
    if (base === null) {
      base = OUTPUTS.map((ch) => device.ch(ch).gainDb);
      clamped = false;
    }
    offset = round(nextOffset);
    const result = trimmedGains(base, offset);
    clamped = clamped || result.clamped;
    device.trimOutputs(result.gains);
  }

  function end(): void {
    clearTimeout(idleTimer);
    base = null;
    offset = 0;
    device.seal();
  }

  function nudge(deltaDb: number): void {
    end();
    apply(deltaDb);
    end();
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    end();
    drag = { pointerId: event.pointerId, startY: event.clientY };
    try {
      area.setPointerCapture(event.pointerId);
    } catch {
      // pointer already released (or synthetic): moves over the area still adjust it
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const next = round(Math.round((drag.startY - event.clientY) / DRAG_PIXELS_PER_STEP) * step);
    if (next !== offset) apply(next);
  }

  function onPointerUp(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    end();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    nudge(event.key === "ArrowUp" ? step : -step);
  }

  $effect(() => attachWheel(area, {
    step: (steps, multiplier) => {
      apply(offset + steps * Math.max(MIN_STEP_DB, multiplier * step));
      clearTimeout(idleTimer);
      idleTimer = setTimeout(end, WHEEL_IDLE_MS);
    },
  }));
</script>

<div class="master">
  <span class="name">Outputs</span>
  <button title="Raise all outputs by {BUTTON_STEP_DB} dB" onclick={() => nudge(BUTTON_STEP_DB)}>+{BUTTON_STEP_DB}</button>
  <div
    bind:this={area}
    class="area"
    role="slider"
    tabindex="0"
    aria-label="Trim all outputs"
    aria-valuemin={-SPAN_DB}
    aria-valuemax={SPAN_DB}
    aria-valuenow={offset}
    aria-valuetext="{formatDb(offset)} dB"
    title="Drag up or down, or use the mouse wheel, to move all outputs together"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onkeydown={onKeydown}
  >
    <span class="num">{formatDb(offset)}</span>
    <span class="unit">dB</span>
  </div>
  <button title="Lower all outputs by {BUTTON_STEP_DB} dB" onclick={() => nudge(-BUTTON_STEP_DB)}>-{BUTTON_STEP_DB}</button>
  <div class="limit">{clamped ? "limit reached" : ""}</div>
</div>

<style>
  .master {
    display: grid; grid-template-rows: auto auto 1fr auto auto; gap: 6px; padding: 6px; min-width: 0; margin-left: 8px;
    background: var(--surface-2); border: 1px solid var(--line); border-top: 3px solid var(--accent); border-radius: var(--radius);
  }
  .name { font-weight: 600; text-align: center; }
  .area {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-height: 60px;
    border: 1px dashed var(--line-strong); border-radius: var(--radius); cursor: ns-resize; touch-action: none;
  }
  .area:focus-visible { border-color: var(--accent); }
  .unit { font-size: 11px; color: var(--text-faint); }
  .limit { min-height: 14px; font-size: 10px; text-align: center; color: var(--warn); }
  @media (max-width: 760px) {
    .master { margin-left: 0; }
  }
</style>

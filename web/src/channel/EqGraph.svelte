<script lang="ts">
  // Frequency response of one output: summed PEQ + crossovers, the selected band's own
  // curve, draggable band handles (frequency/gain), wheel = Q, double-click = reset,
  // and crossover handles on the frequency axis.
  import { bandResponseDb, logFreqAxis, summedResponseDb } from "../eq/response.ts";
  import { makeScales } from "../eq/scales.ts";
  import { bwOctToQ, qToBwOct } from "../eq/biquad.ts";
  import type { ChannelEq, Crossover, PeqBand } from "../eq/types.ts";
  import { PEQ_GAIN_RANGE } from "../state/params.ts";
  import { GAINLESS_PEQ_TYPES } from "../ui/labels.ts";
  import { attachWheel } from "../ui/wheel.ts";

  interface Props {
    eq: ChannelEq;
    selected: number;
    onselect: (band: number) => void;
    onband: (band: number, value: PeqBand) => void;
    onxover: (kind: "hpf" | "lpf", value: Crossover) => void;
    onreset: (band: number) => void;
    onend: () => void;
  }

  let { eq, selected, onselect, onband, onxover, onreset, onend }: Props = $props();

  const F_MIN = 20;
  const F_MAX = 20000;
  const DB_RANGE = 18;
  const PAD = { left: 30, right: 8, top: 8, bottom: 18 };
  const Q_MIN = 0.1;
  const Q_MAX = 25.5;
  const WHEEL_Q_FACTOR = 1.08;
  const GRID_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const LABEL_FREQS = new Set([20, 100, 1000, 10000, 20000, 50, 200, 500, 2000, 5000]);
  const GRID_DB = [-12, -6, 0, 6, 12];

  let width = $state(800);
  let height = $state(260);
  let svg: SVGSVGElement;
  let drag: { kind: "band" | "hpf" | "lpf"; band: number; pointerId: number } | null = null;

  const plotW = $derived(Math.max(100, width - PAD.left - PAD.right));
  const plotH = $derived(Math.max(60, height - PAD.top - PAD.bottom));
  const scales = $derived(makeScales(plotW, plotH, F_MIN, F_MAX, DB_RANGE));
  const freqs = $derived(logFreqAxis(Math.min(400, Math.round(plotW / 2)), F_MIN, F_MAX));

  const clampDb = (db: number) => Math.max(-DB_RANGE, Math.min(DB_RANGE, db));
  const x = (hz: number) => PAD.left + scales.freqToX(hz);
  const y = (db: number) => PAD.top + scales.dbToY(clampDb(db));

  function path(values: Float64Array): string {
    let d = "";
    for (let i = 0; i < freqs.length; i++) d += `${i ? "L" : "M"}${x(freqs[i]!).toFixed(1)} ${y(values[i]!).toFixed(1)}`;
    return d;
  }

  const summed = $derived(path(summedResponseDb(eq, freqs)));
  const selectedBand = $derived(eq.bands[selected]);
  const selectedFill = $derived.by(() => {
    if (!selectedBand || selectedBand.bypass === true) return "";
    const line = path(bandResponseDb(selectedBand, freqs));
    return `${line}L${x(F_MAX).toFixed(1)} ${y(0).toFixed(1)}L${x(F_MIN).toFixed(1)} ${y(0).toFixed(1)}Z`;
  });

  function pointerValue(event: PointerEvent): { hz: number; db: number } {
    const rect = svg.getBoundingClientRect();
    const px = event.clientX - rect.left - PAD.left;
    const py = event.clientY - rect.top - PAD.top;
    const hz = Math.max(F_MIN, Math.min(F_MAX, scales.xToFreq(Math.max(0, Math.min(plotW, px)))));
    return { hz, db: scales.yToDb(py) };
  }

  function startDrag(event: PointerEvent, kind: "band" | "hpf" | "lpf", band = 0): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (kind === "band") onselect(band);
    drag = { kind, band, pointerId: event.pointerId };
    try {
      svg.setPointerCapture(event.pointerId);
    } catch {
      // pointer already released (or synthetic): the drag still follows moves over the graph
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { hz, db } = pointerValue(event);
    if (drag.kind === "band") {
      const band = eq.bands[drag.band]!;
      const gainDb = GAINLESS_PEQ_TYPES.has(band.type)
        ? band.gainDb
        : Math.max(PEQ_GAIN_RANGE.min, Math.min(PEQ_GAIN_RANGE.max, db));
      onband(drag.band, { ...band, freqHz: hz, gainDb });
    } else {
      onxover(drag.kind, { ...eq[drag.kind], freqHz: hz });
    }
  }

  function endDrag(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    onend();
  }

  const handleOf = (event: Event) => (event.target as Element).closest<SVGGElement>("[data-band]");

  /** Wheel over a band handle changes that band's Q (elsewhere the page scrolls normally). */
  $effect(() => attachWheel(svg, {
    accepts: (event) => handleOf(event) !== null,
    step: (steps, multiplier, event) => {
      const index = Number(handleOf(event)!.dataset.band);
      const band = eq.bands[index];
      if (!band) return;
      onselect(index);
      const q = bwOctToQ(band.bwOct, band.freqHz);
      const next = Math.max(Q_MIN, Math.min(Q_MAX, q * Math.pow(WHEEL_Q_FACTOR, steps * multiplier)));
      onband(index, { ...band, bwOct: qToBwOct(next, band.freqHz) });
    },
  }));

  const crossovers = $derived([
    { kind: "hpf" as const, xo: eq.hpf },
    { kind: "lpf" as const, xo: eq.lpf },
  ]);

  const freqLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : `${hz}`);
</script>

<div class="graph" bind:clientWidth={width} bind:clientHeight={height}>
  <svg
    bind:this={svg}
    width={width}
    height={height}
    role="application"
    aria-label="EQ response. Drag a band handle to change frequency and gain; mouse wheel changes Q."
    onpointermove={onPointerMove}
    onpointerup={endDrag}
    onpointercancel={endDrag}
  >
    <g class="grid">
      {#each GRID_FREQS as hz (hz)}
        <line x1={x(hz)} x2={x(hz)} y1={PAD.top} y2={PAD.top + plotH} />
        {#if LABEL_FREQS.has(hz)}<text class="xlabel" x={x(hz)} y={height - 5}>{freqLabel(hz)}</text>{/if}
      {/each}
      {#each GRID_DB as db (db)}
        <line class:zero={db === 0} x1={PAD.left} x2={PAD.left + plotW} y1={y(db)} y2={y(db)} />
        <text class="ylabel" x={PAD.left - 4} y={y(db) + 3}>{db > 0 ? `+${db}` : db}</text>
      {/each}
    </g>

    {#if eq.hpf.slope !== 0}<line class="xo" x1={x(eq.hpf.freqHz)} x2={x(eq.hpf.freqHz)} y1={PAD.top} y2={PAD.top + plotH} />{/if}
    {#if eq.lpf.slope !== 0}<line class="xo" x1={x(eq.lpf.freqHz)} x2={x(eq.lpf.freqHz)} y1={PAD.top} y2={PAD.top + plotH} />{/if}

    {#if selectedFill}<path class="band-fill" d={selectedFill} />{/if}
    <path class="sum" d={summed} />

    {#each eq.bands as band, index (index)}
      <g
        class="handle"
        class:selected={index === selected}
        class:bypassed={band.bypass === true}
        transform="translate({x(band.freqHz)} {y(GAINLESS_PEQ_TYPES.has(band.type) ? 0 : band.gainDb)})"
        role="button"
        tabindex="-1"
        aria-label="Band {index + 1}"
        data-band={index}
        onpointerdown={(event) => startDrag(event, "band", index)}
        ondblclick={() => onreset(index)}
      >
        <circle r="8" />
        <text y="3.5">{index + 1}</text>
      </g>
    {/each}

    {#each crossovers as { kind, xo } (kind)}
      {#if xo.slope !== 0}
        <g class="xo-handle" transform="translate({x(xo.freqHz)} {PAD.top + plotH})" role="button" tabindex="-1"
           aria-label={kind === "hpf" ? "High-pass frequency" : "Low-pass frequency"}
           onpointerdown={(event) => startDrag(event, kind)}>
          <path d="M-6 0 L6 0 L0 -9 Z" />
        </g>
      {/if}
    {/each}
  </svg>
</div>

<style>
  .graph { position: relative; width: 100%; height: var(--eq-height, 260px); background: var(--graph-bg); border: 1px solid var(--line); border-radius: var(--radius); }
  svg { position: absolute; inset: 0; display: block; user-select: none; touch-action: pan-y; }
  .grid line { stroke: var(--graph-grid); stroke-width: 1; }
  .grid line.zero { stroke: var(--graph-zero); }
  .grid text { fill: var(--text-faint); font: 10px var(--font-mono); }
  .xlabel { text-anchor: middle; }
  .ylabel { text-anchor: end; }
  .xo { stroke: var(--warn); stroke-width: 1; stroke-dasharray: 3 3; opacity: .7; }
  .sum { fill: none; stroke: var(--accent); stroke-width: 2; }
  .band-fill { fill: color-mix(in srgb, var(--accent) 12%, transparent); stroke: color-mix(in srgb, var(--accent) 45%, transparent); stroke-width: 1; }
  .handle { cursor: grab; touch-action: none; }
  .handle circle { fill: var(--surface-3); stroke: var(--text-dim); stroke-width: 1.5; }
  .handle text { fill: var(--text); font: 600 10px var(--font-mono); text-anchor: middle; pointer-events: none; }
  .handle.selected circle { fill: var(--accent-dim); stroke: var(--accent); stroke-width: 2; }
  .handle.bypassed circle { fill: transparent; stroke-dasharray: 2 2; }
  .handle.bypassed text { fill: var(--text-faint); }
  .xo-handle { cursor: ew-resize; touch-action: none; }
  .xo-handle path { fill: var(--warn); }
</style>

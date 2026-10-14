<script lang="ts">
  // Side view of the time alignment: speakers at their height and distance from the stage
  // edge, the crowd on the floor coloured by how well neighbouring bands add up at their
  // crossover, and the alignment point (drag it, or focus it and use the arrow keys).
  import { formatFixed } from "../ui/format.ts";
  import { metresToShown, type DistanceUnit } from "../ui/units.ts";
  import { bandColour } from "./bandColour.ts";
  import {
    coverage, effectivePointM, pathLengthM, speedOfSound, suggestedPointM, type CouplingState, type Rig,
  } from "./alignment.ts";

  interface Props {
    rig: Rig;
    /** Display name per output (Out 1 to Out 4); null = spare. */
    names: readonly (string | null)[];
    bands: number;
    unit: DistanceUnit;
    /** New alignment point (m), or null to follow the suggestion. */
    onpoint: (pointM: number | null) => void;
  }

  let { rig, names, bands, unit, onpoint }: Props = $props();

  const HEIGHT = 200;
  const PAD = { left: 16, right: 16, top: 30, bottom: 30 };
  const STRIP_H = 8;
  const BOX = 14;
  const POINT_STEP_M = 0.1;
  const POINT_STEP_SHIFT_M = 1;
  const STATES: readonly CouplingState[] = ["adds", "weak", "cancels"];
  const STATE_NAMES: Record<CouplingState, string> = { adds: "adds up", weak: "weak", cancels: "cancels" };

  let width = $state(480);
  let svg = $state<SVGSVGElement>();
  let dragging = false;

  const alignment = $derived(rig.alignment);
  const crowd = $derived(alignment.crowd);
  const crowdEnd = $derived(Math.max(crowd.startM, crowd.endM));
  const suggested = $derived(suggestedPointM(rig));
  // effectivePointM would search for the suggestion a second time
  const pointM = $derived(alignment.pointM === null && suggested !== null ? suggested : effectivePointM(rig));
  const result = $derived(coverage(rig, pointM));
  const speed = $derived(speedOfSound(alignment.tempC));

  /** Used outputs at the same position share one box. */
  const groups = $derived.by(() => {
    const list: { key: string; xM: number; heightM: number; label: string; band: number; pathM: number }[] = [];
    rig.outputs.forEach((slot, index) => {
      if (!slot) return;
      const { xM, heightM } = alignment.speakers[index]!;
      const key = `${xM}|${heightM}`;
      const name = names[index] ?? slot.name;
      const existing = list.find((group) => group.key === key);
      if (existing) existing.label += ` + ${name}`;
      else list.push({ key, xM, heightM, label: name, band: slot.band, pathM: pathLengthM({ xM, heightM }, pointM, crowd.earHeightM) });
    });
    return list;
  });

  const xMin = $derived(Math.min(0, crowd.startM, ...groups.map((group) => group.xM)) - 1);
  const xMax = $derived(Math.max(crowdEnd, ...groups.map((group) => group.xM)) + 1);
  const hMax = $derived(Math.max(crowd.earHeightM, ...groups.map((group) => group.heightM)) * 1.15 + 0.3);
  const plotW = $derived(Math.max(120, width - PAD.left - PAD.right));
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (m: number) => PAD.left + ((m - xMin) / (xMax - xMin)) * plotW;
  const y = (h: number) => PAD.top + plotH - (h / hMax) * plotH;
  const labelAtEnd = (m: number) => x(m) > PAD.left + plotW * 0.6;

  /** Neighbouring crowd samples in the same state, drawn as one run. */
  const runs = $derived.by(() => {
    if (!result) return [{ from: crowd.startM, to: crowdEnd, state: null as CouplingState | null }];
    const { samples } = result;
    const half = samples.length > 1 ? (samples[1]!.xM - samples[0]!.xM) / 2 : 0;
    const list: { from: number; to: number; state: CouplingState | null }[] = [];
    for (const sample of samples) {
      const last = list[list.length - 1];
      const to = Math.min(crowdEnd, sample.xM + half);
      if (last && last.state === sample.state) last.to = to;
      else list.push({ from: Math.max(crowd.startM, sample.xM - half), to, state: sample.state });
    }
    return list;
  });

  const distance = (m: number) => `${formatFixed(metresToShown(m, unit), 1)} ${unit}`;
  const crossovers = $derived.by(() => {
    const values = rig.crossoversHz.map((hz) => formatFixed(hz, 0));
    const list = values.length > 1 ? `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}` : (values[0] ?? "");
    return `${list} Hz`;
  });
  const percent = $derived(result && result.totalM > 0 ? Math.round((result.coupledM / result.totalM) * 100) : 100);

  function clampPoint(m: number): number {
    const rounded = Number((Math.round(m / POINT_STEP_M) * POINT_STEP_M).toFixed(1));
    return Math.min(crowdEnd, Math.max(crowd.startM, rounded));
  }

  function metresAt(clientX: number): number {
    const rect = svg!.getBoundingClientRect();
    return clampPoint(xMin + ((clientX - rect.left - PAD.left) / plotW) * (xMax - xMin));
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    dragging = true;
    try {
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    } catch {
      // pointer already released (or synthetic): moves over the diagram still drag
    }
    onpoint(metresAt(event.clientX));
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return;
    const next = metresAt(event.clientX);
    if (next !== pointM) onpoint(next);
  }

  function onPointerUp(): void {
    dragging = false;
  }

  function onKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? POINT_STEP_SHIFT_M : POINT_STEP_M;
    let next: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = pointM - step;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = pointM + step;
    else if (event.key === "Home") next = crowd.startM;
    else if (event.key === "End") next = crowdEnd;
    if (next === null) return;
    event.preventDefault();
    onpoint(clampPoint(next));
  }
</script>

<div class="diagram">
  <div class="graph" bind:clientWidth={width}>
    <svg bind:this={svg} {width} height={HEIGHT} role="group" aria-label="Side view of the speakers, the crowd and the alignment point">
      <line class="floor" x1={PAD.left} x2={PAD.left + plotW} y1={y(0)} y2={y(0)} />
      <line class="edge" x1={x(0)} x2={x(0)} y1={PAD.top - 14} y2={y(0)} />
      <text class="caption" x={x(0) + 4} y={PAD.top - 18}>Stage edge</text>
      {#each runs as run (run.from)}
        <rect class="strip {run.state ?? 'neutral'}" x={x(run.from)} y={y(0)} width={Math.max(1, x(run.to) - x(run.from))} height={STRIP_H} />
      {/each}
      <text class="caption" x={x(crowd.startM)} y={y(0) + STRIP_H + 12}>Crowd {distance(crowd.startM)} to {distance(crowdEnd)}</text>
      {#each groups as group (group.key)}
        <line class="path" x1={x(group.xM)} y1={y(group.heightM)} x2={x(pointM)} y2={y(crowd.earHeightM)} style:stroke={bandColour(bands, group.band)} />
      {/each}
      {#each groups as group (group.key)}
        {@const end = labelAtEnd(group.xM)}
        {@const labelX = end ? x(group.xM) - BOX / 2 - 4 : x(group.xM) + BOX / 2 + 4}
        <rect class="speaker" x={x(group.xM) - BOX / 2} y={y(group.heightM) - BOX / 2} width={BOX} height={BOX} rx="2"
              style:--band={bandColour(bands, group.band)} />
        <text class="name" class:end x={labelX} y={y(group.heightM) - 2}>{group.label}</text>
        <text class="figure" class:end x={labelX} y={y(group.heightM) + 10}>
          {distance(group.pathM)}, {formatFixed((group.pathM / speed) * 1000, 1)} ms
        </text>
      {/each}
      <g class="point" role="slider" tabindex="0" aria-label="Alignment point"
         aria-valuemin={crowd.startM} aria-valuemax={crowdEnd} aria-valuenow={Number(pointM.toFixed(2))}
         aria-valuetext="{distance(pointM)} from the stage edge"
         onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp}
         onkeydown={onKeydown}>
        <rect class="hit" x={x(crowd.startM)} y={PAD.top} width={Math.max(1, x(crowdEnd) - x(crowd.startM))} height={plotH + STRIP_H} />
        <line class="marker" x1={x(pointM)} x2={x(pointM)} y1={y(crowd.earHeightM)} y2={y(0)} />
        <circle class="marker" cx={x(pointM)} cy={y(crowd.earHeightM)} r="6" />
      </g>
    </svg>
  </div>
  <div class="readout">
    {#if result}
      <span>Coupled at {crossovers}: <strong>{distance(result.coupledM)}</strong> of {distance(result.totalM)} ({percent}%)</span>
    {:else}
      <span class="faint">No crossover: only the arrival times matter.</span>
    {/if}
    <span class="faint">Alignment point {distance(pointM)} from the stage edge, {alignment.pointM === null ? (suggested === null ? "the middle of the crowd" : "suggested") : "moved by you"}.</span>
    <button disabled={alignment.pointM === null} onclick={() => onpoint(null)}>{suggested === null ? "Use the middle" : "Use suggested"}</button>
  </div>
  {#if result}
    <ul class="legend">
      {#each STATES as state (state)}<li><span class="swatch {state}"></span>{STATE_NAMES[state]}</li>{/each}
    </ul>
  {/if}
</div>

<style>
  .diagram { display: grid; gap: 6px; margin-bottom: 10px; }
  .graph { position: relative; width: 100%; height: 200px; background: var(--graph-bg); border: 1px solid var(--line); border-radius: var(--radius); }
  svg { position: absolute; inset: 0; display: block; user-select: none; touch-action: pan-y; }
  text { font: 10px var(--font-mono); fill: var(--text-dim); }
  .caption { fill: var(--text-faint); }
  .name { font: 600 11px var(--font); fill: var(--text); }
  .end { text-anchor: end; }
  .floor { stroke: var(--graph-zero); }
  .edge { stroke: var(--graph-grid); stroke-dasharray: 4 3; }
  .strip.adds, .swatch.adds { fill: var(--ok); background: var(--ok); }
  .strip.weak, .swatch.weak { fill: var(--warn); background: var(--warn); }
  .strip.cancels, .swatch.cancels { fill: var(--bad); background: var(--bad); }
  .strip.neutral { fill: var(--graph-grid); }
  .path { stroke-width: 1.5; opacity: .7; }
  .speaker { fill: color-mix(in srgb, var(--band) 30%, var(--graph-bg)); stroke: var(--band); }
  .point { outline: none; cursor: ew-resize; }
  .hit { fill: transparent; }
  .marker { stroke: var(--accent); stroke-width: 2; }
  circle.marker { fill: var(--accent); }
  .point:focus-visible .marker { stroke: var(--text); stroke-width: 3; }
  .readout { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: 12px; }
  .legend { display: flex; gap: 14px; margin: 0; padding: 0; list-style: none; font-size: 11px; color: var(--text-dim); }
  .legend li { display: flex; align-items: center; gap: 6px; }
  .swatch { width: 12px; height: 6px; border-radius: 1px; }
</style>

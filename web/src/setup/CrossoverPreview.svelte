<script lang="ts">
  // The level of each used output after the setup (gain, crossovers and PEQ) on one
  // graph, so band splits and trims can be checked before applying.
  import { logFreqAxis, summedResponseDb } from "../eq/response.ts";
  import type { DeviceModel } from "../state/model.ts";

  interface Props {
    model: DeviceModel;
    outputs: { ch: number; name: string }[];
  }

  let { model, outputs }: Props = $props();

  const F_MIN = 20;
  const F_MAX = 20000;
  const DB_TOP = 12;
  const DB_BOTTOM = -36;
  const HEIGHT = 200;
  const PAD = { left: 30, right: 8, top: 8, bottom: 18 };
  const GRID_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const GRID_DB = [12, 0, -12, -24, -36];

  let width = $state(400);

  const plotW = $derived(Math.max(100, width - PAD.left - PAD.right));
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const freqs = $derived(logFreqAxis(Math.min(300, Math.round(plotW / 2)), F_MIN, F_MAX));

  const x = (hz: number) => PAD.left + (Math.log10(hz / F_MIN) / Math.log10(F_MAX / F_MIN)) * plotW;
  const y = (db: number) => PAD.top + ((DB_TOP - Math.max(DB_BOTTOM, Math.min(DB_TOP, db))) / (DB_TOP - DB_BOTTOM)) * plotH;
  const freqLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : `${hz}`);

  const curves = $derived(outputs.flatMap(({ ch, name }) => {
    const channel = model.channels[ch];
    if (!channel?.eq) return [];
    const response = summedResponseDb(channel.eq, freqs);
    let d = "";
    for (let i = 0; i < freqs.length; i++) {
      d += `${i ? "L" : "M"}${x(freqs[i]!).toFixed(1)} ${y(response[i]! + channel.gainDb).toFixed(1)}`;
    }
    return [{ ch, name, d, muted: channel.mute === true }];
  }));
</script>

<div class="preview">
  <div class="graph" bind:clientWidth={width}>
    <svg width={width} height={HEIGHT} role="img"
         aria-label="Frequency response of each output after the setup: {outputs.map((o) => o.name).join(', ')}">
      <g class="grid">
        {#each GRID_FREQS as hz (hz)}
          <line x1={x(hz)} x2={x(hz)} y1={PAD.top} y2={PAD.top + plotH} />
          <text class="xlabel" x={x(hz)} y={HEIGHT - 5}>{freqLabel(hz)}</text>
        {/each}
        {#each GRID_DB as db (db)}
          <line class:zero={db === 0} x1={PAD.left} x2={PAD.left + plotW} y1={y(db)} y2={y(db)} />
          <text class="ylabel" x={PAD.left - 4} y={y(db) + 3}>{db > 0 ? `+${db}` : db}</text>
        {/each}
      </g>
      {#each curves as curve (curve.ch)}
        <path class="curve" class:muted={curve.muted} d={curve.d} style:stroke="var(--ch-{curve.ch})" />
      {/each}
    </svg>
  </div>
  <ul class="legend">
    {#each curves as curve (curve.ch)}
      <li><span class="swatch" style:background="var(--ch-{curve.ch})"></span>{curve.name}{#if curve.muted}<span class="faint"> (muted)</span>{/if}</li>
    {/each}
  </ul>
</div>

<style>
  .preview { display: grid; gap: 6px; }
  .graph { position: relative; width: 100%; height: 200px; background: var(--graph-bg); border: 1px solid var(--line); border-radius: var(--radius); }
  svg { position: absolute; inset: 0; display: block; }
  .grid line { stroke: var(--graph-grid); stroke-width: 1; }
  .grid line.zero { stroke: var(--graph-zero); }
  .grid text { fill: var(--text-faint); font: 10px var(--font-mono); }
  .xlabel { text-anchor: middle; }
  .ylabel { text-anchor: end; }
  .curve { fill: none; stroke-width: 2; }
  .curve.muted { stroke-dasharray: 4 3; opacity: .6; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 0; list-style: none; font-size: 12px; }
  .legend li { display: flex; align-items: center; gap: 6px; }
  .swatch { width: 12px; height: 3px; border-radius: 1px; }
</style>

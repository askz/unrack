<script lang="ts">
  // One speaker layout as a pickable card: which input feeds which output, the outputs
  // coloured by frequency band (warm = low, cool = high), spare outputs dashed.
  import { bandCount, type Layout, type Side, type SourceId } from "./recipe.ts";

  interface Props {
    layout: Layout;
    source: SourceId;
    selected: boolean;
    onselect: () => void;
  }

  let { layout, source, selected, onselect }: Props = $props();

  const WIDTH = 168;
  const HEIGHT = 92;
  const BOX_H = 16;
  const IN_X = 4;
  const IN_W = 24;
  const OUT_X = 100;
  const OUT_W = 64;
  const INPUT_Y: Record<"A" | "B", number> = { A: 20, B: 56 };
  const outY = (index: number) => 4 + index * 22;

  function bandColour(band: number): string {
    const bands = bandCount(layout);
    if (bands === 1) return "var(--accent)";
    return `var(--band-${Math.round((band * 3) / (bands - 1))})`;
  }

  function feeds(side: Side): ("A" | "B")[] {
    if (source === "mono") return ["A"];
    if (side === "L") return ["A"];
    if (side === "R") return ["B"];
    return ["A", "B"];
  }

  function wire(input: "A" | "B", index: number): string {
    const x1 = IN_X + IN_W;
    const y1 = INPUT_Y[input] + BOX_H / 2;
    const x2 = OUT_X;
    const y2 = outY(index) + BOX_H / 2;
    const mid = (x1 + x2) / 2;
    return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
  }

  const wires = $derived(layout.outputs.flatMap((output, index) => (output
    ? feeds(output.side).map((input) => ({ key: `${input}${index}`, d: wire(input, index), colour: bandColour(output.band) }))
    : [])));
</script>

<button type="button" class="card" class:selected aria-pressed={selected} onclick={onselect}>
  <span class="name">{layout.name}</span>
  <svg viewBox="0 0 {WIDTH} {HEIGHT}" aria-hidden="true">
    {#each wires as { key, d, colour } (key)}<path class="wire" {d} style:stroke={colour} />{/each}
    {#each ["A", "B"] as const as input (input)}
      <g class="input" class:unused={input === "B" && source === "mono"}>
        <rect x={IN_X} y={INPUT_Y[input]} width={IN_W} height={BOX_H} rx="2" />
        <text x={IN_X + IN_W / 2} y={INPUT_Y[input] + 11.5}>{input}</text>
      </g>
    {/each}
    {#each layout.outputs as output, index (index)}
      <g class="output" class:spare={!output} style:--band={output ? bandColour(output.band) : undefined}>
        <rect x={OUT_X} y={outY(index)} width={OUT_W} height={BOX_H} rx="2" />
        <text x={OUT_X + OUT_W / 2} y={outY(index) + 11.5}>{output ? output.name : "Spare"}</text>
      </g>
    {/each}
  </svg>
  <span class="description">{layout.description}</span>
</button>

<style>
  .card {
    display: flex; flex-direction: column; align-items: stretch; gap: 4px; height: auto; padding: 8px;
    text-align: left; white-space: normal; background: var(--surface);
  }
  .card.selected { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: var(--surface-2); }
  .name { font-weight: 600; }
  .description { font-size: 11px; color: var(--text-dim); }
  svg { width: 100%; height: auto; display: block; }
  .wire { fill: none; stroke-width: 1.5; opacity: .8; }
  rect { stroke-width: 1; }
  text { font: 600 9px var(--font); text-anchor: middle; fill: var(--text); }
  .input rect { fill: var(--surface-3); stroke: var(--line-strong); }
  .input.unused { opacity: .35; }
  .output rect { fill: color-mix(in srgb, var(--band) 22%, transparent); stroke: var(--band); }
  .output.spare rect { fill: none; stroke: var(--text-faint); stroke-dasharray: 3 2; }
  .output.spare text { fill: var(--text-faint); font-weight: 400; }
</style>

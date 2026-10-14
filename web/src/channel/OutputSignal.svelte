<script lang="ts">
  // Output source selection (which inputs feed it) and alignment delay.
  import { device } from "../state/device.svelte.ts";
  import { DELAY_RANGE } from "../state/params.ts";
  import { msToSamples } from "../protocol/blocks.ts";
  import { OUT_BASE } from "../state/model.ts";
  import NumberField from "../ui/NumberField.svelte";
  import Toggle from "../ui/Toggle.svelte";
  import { INPUT_LETTERS } from "../ui/labels.ts";

  let { ch }: { ch: number } = $props();

  const SPEED_OF_SOUND_M_PER_S = 343;
  const mask = $derived(device.routing[ch - OUT_BASE] ?? 0);
  const delayMs = $derived(device.ch(ch).delayMs ?? 0);
  const routingStatus = $derived(device.syncOf({ kind: "routing", ch }));
</script>

<div class="signal">
  <div class="group">
    <span class="label">Sources</span>
    <div class="sources">
      {#each INPUT_LETTERS as letter, input (letter)}
        <Toggle pressed={(mask & (1 << input)) !== 0} title="Feed from {device.displayName(input)}" status={routingStatus}
                onchange={() => { device.setRouting(ch, mask ^ (1 << input)); device.seal(); }}>{letter}</Toggle>
      {/each}
    </div>
  </div>
  <div class="group">
    <NumberField label="Delay" value={delayMs} min={DELAY_RANGE.min} max={DELAY_RANGE.max} step={0.1}
                 format={(v) => v.toFixed(2)} unit="ms" status={device.syncOf({ kind: "delay", ch })}
                 onchange={(ms) => device.setDelayMs(ch, ms)} onend={() => device.seal()} width="96px" />
    <span class="readout num faint">
      {msToSamples(delayMs)} smp · {((delayMs / 1000) * SPEED_OF_SOUND_M_PER_S).toFixed(2)} m
    </span>
  </div>
</div>

<style>
  .signal { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: flex-end; }
  .group { display: flex; align-items: flex-end; gap: 8px; }
  .group > .label { align-self: center; }
  .sources { display: flex; gap: 4px; }
  .readout { font-size: 11px; line-height: var(--control-h); }
</style>

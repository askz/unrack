<script lang="ts">
  // Level meter for a 0..1 reading (linear in dB between the device's floor and full
  // scale), with a peak hold whose duration comes from the settings (0 = no peak).
  import { untrack } from "svelte";
  import { settings } from "../state/settings.svelte.ts";

  interface Props {
    level: number;
    orientation?: "vertical" | "horizontal";
    title?: string;
  }

  let { level, orientation = "vertical", title }: Props = $props();

  const PEAK_FALL_PER_UPDATE = 0.04;

  let peak = $state(0);
  let peakAt = 0;

  const holdMs = $derived(settings.value.peakHoldMs);
  const clamped = $derived(Math.max(0, Math.min(1, level)));
  const percent = $derived(clamped * 100);
  const zone = $derived(clamped > 0.9 ? "hi" : clamped > 0.7 ? "mid" : "lo");

  $effect(() => {
    const current = clamped;
    const now = performance.now();
    const held = untrack(() => peak);
    if (current >= held) {
      peak = current;
      peakAt = now;
    } else if (now - peakAt > untrack(() => holdMs)) {
      peak = Math.max(current, held - PEAK_FALL_PER_UPDATE);
    }
  });
</script>

<div class="meter {orientation}" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={clamped} {title}>
  <div class="fill {zone}" style={orientation === "vertical" ? `height:${percent}%` : `width:${percent}%`}></div>
  {#if holdMs > 0 && peak > 0.02}
    <div class="peak" style={orientation === "vertical" ? `bottom:${peak * 100}%` : `left:${peak * 100}%`}></div>
  {/if}
</div>

<style>
  .meter { position: relative; background: var(--meter-bg); border: 1px solid var(--line); overflow: hidden; }
  .vertical { width: 8px; height: 100%; min-height: 24px; }
  .horizontal { height: 6px; width: 100%; }
  .fill { position: absolute; left: 0; bottom: 0; }
  .vertical .fill { right: 0; }
  .horizontal .fill { top: 0; }
  .lo { background: var(--meter-lo); }
  .mid { background: var(--meter-mid); }
  .hi { background: var(--meter-hi); }
  .peak { position: absolute; background: var(--text); }
  .vertical .peak { left: 0; right: 0; height: 1px; }
  .horizontal .peak { top: 0; bottom: 0; width: 1px; }
</style>

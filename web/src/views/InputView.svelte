<script lang="ts">
  import { device } from "../state/device.svelte.ts";
  import Section from "../ui/Section.svelte";
  import ChannelControls from "../channel/ChannelControls.svelte";
  import DynamicsFields from "../channel/DynamicsFields.svelte";

  let { ch }: { ch: number } = $props();
  const routedTo = $derived(
    device.routing.flatMap((mask, out) => ((mask & (1 << ch)) !== 0 ? [device.displayName(4 + out)] : [])),
  );
</script>

<div class="view">
  <Section title="{device.displayName(ch)} · Input">
    <ChannelControls {ch} />
    <p class="routed dim">Feeds: {routedTo.length ? routedTo.join(", ") : "no output"}</p>
  </Section>
  <Section title="Noise gate">
    <DynamicsFields {ch} kind="gate" />
  </Section>
</div>

<style>
  .view { display: grid; gap: var(--gap); align-content: start; max-width: 1100px; }
  .routed { margin: 10px 0 0; font-size: 12px; }
</style>

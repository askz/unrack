<script lang="ts">
  import { device } from "../state/device.svelte.ts";
  import { ui } from "../state/ui.svelte.ts";
  import { OUT_BASE, OUTPUT_COUNT } from "../state/model.ts";
  import Section from "../ui/Section.svelte";
  import ChannelControls from "../channel/ChannelControls.svelte";
  import OutputSignal from "../channel/OutputSignal.svelte";
  import EqGraph from "../channel/EqGraph.svelte";
  import EqTable from "../channel/EqTable.svelte";
  import DynamicsFields from "../channel/DynamicsFields.svelte";

  let { ch }: { ch: number } = $props();

  const channel = $derived(device.ch(ch));
  const others = $derived(Array.from({ length: OUTPUT_COUNT }, (_, i) => OUT_BASE + i).filter((i) => i !== ch));
  const linkedTo = $derived(device.eqLink[ch]);

  function onLinkChange(value: string): void {
    if (value === "") device.unlinkEq(ch);
    else device.linkEq(ch, Number(value));
  }
  function onCopy(select: HTMLSelectElement): void {
    if (select.value !== "") device.copyEqTo(ch, Number(select.value));
    select.value = "";
  }
</script>

<div class="view">
  <Section title="{device.displayName(ch)} · Output">
    <div class="stack">
      <ChannelControls {ch} />
      <OutputSignal {ch} />
    </div>
  </Section>

  <Section title="Equalizer">
    {#snippet actions()}
      <label class="inline">
        <span class="label">Link</span>
        <select value={linkedTo === undefined ? "" : String(linkedTo)} onchange={(event) => onLinkChange(event.currentTarget.value)}
                title="Linked outputs mirror every EQ edit">
          <option value="">Not linked</option>
          {#each others as other (other)}<option value={String(other)}>{device.displayName(other)}</option>{/each}
        </select>
      </label>
      <label class="inline">
        <span class="label">Copy to</span>
        <select value="" onchange={(event) => onCopy(event.currentTarget)} title="Copy this EQ (crossovers and bands) to another output">
          <option value="">Choose…</option>
          {#each others as other (other)}<option value={String(other)}>{device.displayName(other)}</option>{/each}
        </select>
      </label>
    {/snippet}
    <div class="stack">
      {#if channel.eq}
        <EqGraph
          eq={channel.eq}
          selected={ui.bandOf(ch)}
          onselect={(band) => ui.selectBand(ch, band)}
          onband={(band, value) => device.setBand(ch, band, value)}
          onxover={(kind, value) => (kind === "hpf" ? device.setHpf(ch, value) : device.setLpf(ch, value))}
          onreset={(band) => device.resetBand(ch, band)}
          onend={() => device.seal()}
        />
        <EqTable {ch} />
      {/if}
    </div>
  </Section>

  <Section title="Compressor / limiter">
    <DynamicsFields {ch} kind="comp" />
  </Section>
</div>

<style>
  .view { display: grid; gap: var(--gap); align-content: start; max-width: 1100px; }
  .stack { display: grid; gap: 12px; }
  .inline { display: flex; align-items: center; gap: 6px; }
  .inline select { max-width: 130px; }
  .inline .label { white-space: nowrap; }
</style>

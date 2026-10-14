<script lang="ts">
  // The channels as mixer strips (fader + meter, gain, mute, polarity, solo on outputs),
  // a master trim for the outputs, and the routing matrix. Channels hidden in Settings
  // are left out (the matrix keeps every input column so no active route disappears).
  import { device } from "../state/device.svelte.ts";
  import { settings } from "../state/settings.svelte.ts";
  import { ui } from "../state/ui.svelte.ts";
  import { GAIN_RANGE } from "../state/params.ts";
  import { CHANNEL_COUNT, OUT_BASE, OUTPUT_COUNT } from "../state/model.ts";
  import Section from "../ui/Section.svelte";
  import NumberField from "../ui/NumberField.svelte";
  import Toggle from "../ui/Toggle.svelte";
  import Meter from "../ui/Meter.svelte";
  import Fader from "../ui/Fader.svelte";
  import MasterTrim from "../channel/MasterTrim.svelte";
  import { stepGainDb } from "../ui/faderTaper.ts";
  import { formatDb } from "../ui/format.ts";
  import { INPUT_LETTERS } from "../ui/labels.ts";

  const allChannels = Array.from({ length: CHANNEL_COUNT }, (_, i) => i);
  const allOutputs = Array.from({ length: OUTPUT_COUNT }, (_, i) => OUT_BASE + i);
  const channels = $derived(allChannels.filter((ch) => !settings.value.hidden.includes(ch)));
  const outputs = $derived(allOutputs.filter((ch) => !settings.value.hidden.includes(ch)));
  const firstOutput = $derived(outputs[0]);
  const gainStep = $derived(settings.value.gainStepDb);

  function summary(ch: number): string {
    const channel = device.ch(ch);
    if (!channel.isOutput) return channel.gate ? `Gate ${formatDb(channel.gate.thresholdDb, 1)} dB` : "";
    const mask = device.routing[ch - OUT_BASE] ?? 0;
    const sources = INPUT_LETTERS.filter((_, i) => (mask & (1 << i)) !== 0).join("+") || "none";
    return `${sources} · ${(channel.delayMs ?? 0).toFixed(2)} ms`;
  }
</script>

<div class="view">
  <Section title="Channels">
    <div class="strips" style:--strip-count={channels.length + 1}>
      {#each channels as ch (ch)}
        {@const channel = device.ch(ch)}
        {@const name = device.displayName(ch)}
        {@const gainStatus = device.syncOf({ kind: "gain", ch })}
        {@const warn = device.aboveCeiling(ch)}
        <div class="strip" class:output-start={ch === firstOutput && channels[0] !== ch} style="--marker: var(--ch-{ch})">
          <button class="name ghost" title="Open {name}" onclick={() => ui.open(ch)}>{name}</button>
          <div class="mix">
            <Fader value={channel.gainDb} orientation="vertical" ticks step={gainStep} label="{name} gain"
                   status={gainStatus} {warn} onchange={(db) => device.setGainDb(ch, db)} onend={() => device.seal()} />
            <Meter level={device.meters[ch] ?? 0} />
          </div>
          <NumberField value={channel.gainDb} min={GAIN_RANGE.min} max={GAIN_RANGE.max} step={gainStep} stepper={stepGainDb}
                       format={(v) => formatDb(v)} unit="dB" width="100%" status={gainStatus} {warn}
                       ariaLabel="{name} gain value"
                       onchange={(db) => device.setGainDb(ch, db)} onend={() => device.seal()} />
          <div class="toggles">
            <Toggle pressed={channel.mute} tone="bad" title="Mute {name}" status={device.syncOf({ kind: "mute", ch })}
                    onchange={(on) => device.setMute(ch, on)}>M</Toggle>
            <Toggle pressed={channel.polarity} tone="warn" title="Invert polarity of {name}" status={device.syncOf({ kind: "polarity", ch })}
                    onchange={(invert) => device.setPolarity(ch, invert)}>Ø</Toggle>
            {#if channel.isOutput}
              <Toggle pressed={device.soloed.includes(ch)} title="Solo {name} (mutes the other outputs)"
                      onchange={() => device.toggleSolo(ch)}>S</Toggle>
            {/if}
          </div>
          <div class="summary num faint" title={summary(ch)}>{summary(ch)}</div>
        </div>
      {/each}
      <MasterTrim />
    </div>
  </Section>

  <Section title="Routing">
    <table class="matrix">
      <thead>
        <tr>
          <th></th>
          {#each INPUT_LETTERS as letter, input (letter)}<th scope="col" title={device.displayName(input)}>In {letter}</th>{/each}
        </tr>
      </thead>
      <tbody>
        {#each outputs as out (out)}
          {@const mask = device.routing[out - OUT_BASE] ?? 0}
          {@const status = device.syncOf({ kind: "routing", ch: out })}
          <tr>
            <th scope="row"><button class="ghost" onclick={() => ui.open(out)}>{device.displayName(out)}</button></th>
            {#each INPUT_LETTERS as letter, input (letter)}
              <td>
                <Toggle pressed={(mask & (1 << input)) !== 0} {status}
                        title="{device.displayName(input)} → {device.displayName(out)}"
                        onchange={() => { device.setRouting(out, mask ^ (1 << input)); device.seal(); }}>{letter}</Toggle>
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </Section>
</div>

<style>
  .view { display: grid; gap: var(--gap); align-content: start; max-width: 1100px; }
  .strips { display: grid; grid-template-columns: repeat(var(--strip-count), minmax(84px, 1fr)); gap: 6px; }
  .strip {
    display: grid; grid-template-rows: auto 220px auto auto auto; gap: 6px; padding: 6px;
    background: var(--surface-2); border: 1px solid var(--line); border-top: 3px solid var(--marker); border-radius: var(--radius);
    min-width: 0;
  }
  .strip.output-start { margin-left: 8px; }
  .name { justify-self: stretch; font-weight: 600; overflow: hidden; text-overflow: ellipsis; padding: 0 2px; }
  .mix { display: flex; justify-content: center; gap: 6px; min-height: 0; }
  .mix :global(.meter) { width: 10px; }
  .toggles { display: flex; gap: 4px; justify-content: center; }
  .toggles :global(button) { flex: 1; min-width: 0; padding: 0; }
  .summary { font-size: 10px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .matrix { border-collapse: collapse; }
  .matrix th, .matrix td { padding: 3px 6px; text-align: center; }
  .matrix thead th { font-size: 11px; font-weight: 600; color: var(--text-dim); }
  .matrix tbody th { text-align: left; }
  @media (max-width: 760px) {
    .strips { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .strip.output-start { margin-left: 0; }
    .strip { grid-template-rows: auto 140px auto auto auto; }
  }
</style>

<script lang="ts">
  // Gain fader + field, mute, polarity and level meter for one channel.
  import { device } from "../state/device.svelte.ts";
  import { settings } from "../state/settings.svelte.ts";
  import { GAIN_RANGE } from "../state/params.ts";
  import Fader from "../ui/Fader.svelte";
  import NumberField from "../ui/NumberField.svelte";
  import Toggle from "../ui/Toggle.svelte";
  import Meter from "../ui/Meter.svelte";
  import { stepGainDb } from "../ui/faderTaper.ts";
  import { formatDb } from "../ui/format.ts";

  let { ch }: { ch: number } = $props();
  const channel = $derived(device.ch(ch));
  const gainStatus = $derived(device.syncOf({ kind: "gain", ch }));
  const gainStep = $derived(settings.value.gainStepDb);
</script>

<div class="controls">
  <div class="gain">
    <span class="label">Gain</span>
    <div class="fader">
      <Fader value={channel.gainDb} step={gainStep} label="{channel.name} gain" status={gainStatus}
             onchange={(db) => device.setGainDb(ch, db)} onend={() => device.seal()} />
    </div>
    <NumberField value={channel.gainDb} min={GAIN_RANGE.min} max={GAIN_RANGE.max} step={gainStep} stepper={stepGainDb}
                 format={(v) => formatDb(v)} unit="dB" status={gainStatus} ariaLabel="{channel.name} gain value"
                 onchange={(db) => device.setGainDb(ch, db)} onend={() => device.seal()} />
  </div>
  <div class="toggles">
    <Toggle pressed={channel.mute} tone="bad" title="Mute {channel.name}" status={device.syncOf({ kind: "mute", ch })}
            onchange={(on) => device.setMute(ch, on)}>Mute</Toggle>
    <Toggle pressed={channel.polarity} tone="warn" title="Invert polarity of {channel.name}" status={device.syncOf({ kind: "polarity", ch })}
            onchange={(invert) => device.setPolarity(ch, invert)}>Ø</Toggle>
  </div>
  <div class="meter" title="Level">
    <span class="label">Level</span>
    <Meter level={device.meters[ch] ?? 0} orientation="horizontal" />
  </div>
</div>

<style>
  .controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 16px; }
  .gain { display: flex; align-items: center; gap: 8px; flex: 1 1 320px; min-width: 0; }
  .fader { flex: 1; min-width: 80px; }
  .toggles { display: flex; gap: 6px; }
  .meter { display: flex; align-items: center; gap: 8px; flex: 0 1 180px; min-width: 120px; height: var(--control-h); }
</style>

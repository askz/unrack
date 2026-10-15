<script lang="ts">
  // Preferences of this browser: channel names, colours and visibility, control steps,
  // meters, appearance, units, the output gain limit and the startup view. Every
  // control applies immediately and is saved in this browser only.
  import { device } from "../state/device.svelte.ts";
  import { settings } from "../state/settings.svelte.ts";
  import {
    CHANNEL_PALETTE, DENSITIES, DISTANCE_UNITS, EQ_RANGES_DB, EQ_WIDTHS, FREQ_STEP_DIVISIONS, GAIN_STEPS_DB,
    NAME_MAX_LENGTH, PEAK_HOLDS_MS, START_VIEWS, TEMPERATURE_UNITS, TEXT_SIZES, THEMES, type Settings,
  } from "../state/settings.ts";
  import { CHANNEL_COUNT, channelLabel } from "../state/model.ts";
  import { GAIN_RANGE } from "../state/params.ts";
  import Section from "../ui/Section.svelte";
  import EspSettings from "../esp/EspSettings.svelte";
  import { bridge } from "../esp/bridge.svelte.ts";
  import Choice from "../ui/Choice.svelte";
  import NumberField from "../ui/NumberField.svelte";
  import Toggle from "../ui/Toggle.svelte";
  import { formatDb } from "../ui/format.ts";

  const DEFAULT_CEILING_DB = 0;
  const CEILING_STEP_DB = 0.5;

  const EQ_WIDTH_NAMES: Record<Settings["eqWidth"], string> = { q: "Q", octaves: "Bandwidth (octaves)" };
  const THEME_NAMES: Record<Settings["theme"], string> = { dark: "Dark", light: "Light", system: "Like the system" };
  const DENSITY_NAMES: Record<Settings["density"], string> = { compact: "Compact", comfortable: "Comfortable", touch: "Touch" };
  const TEXT_SIZE_NAMES: Record<Settings["textSize"], string> = { small: "Small", normal: "Normal", large: "Large" };
  const DISTANCE_NAMES: Record<Settings["distanceUnit"], string> = { m: "Metres", ft: "Feet" };
  const TEMPERATURE_NAMES: Record<Settings["temperatureUnit"], string> = { C: "°C", F: "°F" };
  const START_NAMES: Record<Settings["startView"], string> = { last: "The last view", overview: "The Overview" };

  const channels = Array.from({ length: CHANNEL_COUNT }, (_, i) => i);
  const value = $derived(settings.value);
  const hasNames = $derived(value.names.some((name) => name !== ""));
  let confirmReset = $state(false);

  const deviceName = (ch: number) => device.ch(ch).name || channelLabel(ch);

  function setName(ch: number, name: string): void {
    const names = [...value.names];
    names[ch] = name;
    settings.update({ names });
  }

  function setColour(ch: number, colour: string): void {
    const colors = [...value.colors];
    colors[ch] = colour;
    settings.update({ colors });
  }

  function setShown(ch: number, shown: boolean): void {
    settings.update({ hidden: shown ? value.hidden.filter((x) => x !== ch) : [...value.hidden, ch] });
  }

  function resetAll(): void {
    settings.reset();
    confirmReset = false;
  }
</script>

<div class="view">
  <Section title="Channels" class="wide">
    {#snippet actions()}
      <button disabled={!hasNames} onclick={() => settings.update({ names: channels.map(() => "") })}>Reset to device names</button>
    {/snippet}
    <div class="scroll">
      <table>
        <thead><tr><th>Channel</th><th>Name</th><th>Colour</th><th>Shown</th></tr></thead>
        <tbody>
          {#each channels as ch (ch)}
            <tr>
              <td class="channel" style:--marker="var(--ch-{ch})">{channelLabel(ch)}</td>
              <td>
                <input type="text" value={value.names[ch]} maxlength={NAME_MAX_LENGTH} placeholder={deviceName(ch)}
                       aria-label="Name of {channelLabel(ch)}" onchange={(event) => setName(ch, event.currentTarget.value)} />
              </td>
              <td>
                <div class="swatches" role="group" aria-label="Colour of {channelLabel(ch)}">
                  {#each CHANNEL_PALETTE as colour, index (colour)}
                    <button type="button" class="swatch" class:selected={value.colors[ch] === colour} style:--swatch={colour}
                            aria-pressed={value.colors[ch] === colour} aria-label="Colour {index + 1}"
                            onclick={() => setColour(ch, colour)}></button>
                  {/each}
                </div>
              </td>
              <td>
                <input type="checkbox" checked={!value.hidden.includes(ch)} aria-label="Show {channelLabel(ch)} in the tabs and the Overview"
                       onchange={(event) => setShown(ch, event.currentTarget.checked)} />
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="faint">A name replaces the device's name on this screen only (empty = the device's name). Hidden channels stay reachable by their number key or link, and keep working.</p>
  </Section>

  {#if bridge.active}<EspSettings />{/if}

  <Section title="Controls">
    <div class="rows">
      <span>Gain step</span>
      <Choice ariaLabel="Gain step" options={GAIN_STEPS_DB} value={value.gainStepDb} label={(db) => `${db} dB`}
              onchange={(gainStepDb) => settings.update({ gainStepDb })} />
      <span>Frequency step</span>
      <Choice ariaLabel="Frequency step" options={FREQ_STEP_DIVISIONS} value={value.freqStepDivisions} label={(n) => `1/${n} oct`}
              onchange={(freqStepDivisions) => settings.update({ freqStepDivisions })} />
      <span>EQ width shown as</span>
      <Choice ariaLabel="EQ width shown as" options={EQ_WIDTHS} value={value.eqWidth} label={(w) => EQ_WIDTH_NAMES[w]}
              onchange={(eqWidth) => settings.update({ eqWidth })} />
      <span>EQ graph range</span>
      <Choice ariaLabel="EQ graph range" options={EQ_RANGES_DB} value={value.eqRangeDb} label={(db) => `±${db} dB`}
              onchange={(eqRangeDb) => settings.update({ eqRangeDb })} />
    </div>
    <p class="faint">Steps apply to the arrow keys, the mouse wheel and dragging. Shift steps ×10, Alt ×0.1.</p>
  </Section>

  <Section title="Meters">
    <div class="rows">
      <span>Peak hold</span>
      <Choice ariaLabel="Peak hold" options={PEAK_HOLDS_MS} value={value.peakHoldMs}
              label={(ms) => (ms === 0 ? "Off" : `${ms / 1000} s`)} onchange={(peakHoldMs) => settings.update({ peakHoldMs })} />
    </div>
  </Section>

  <Section title="Appearance">
    <div class="rows">
      <span>Theme</span>
      <Choice ariaLabel="Theme" options={THEMES} value={value.theme} label={(t) => THEME_NAMES[t]}
              onchange={(theme) => settings.update({ theme })} />
      <span>Density</span>
      <Choice ariaLabel="Density" options={DENSITIES} value={value.density} label={(d) => DENSITY_NAMES[d]}
              onchange={(density) => settings.update({ density })} />
      <span>Text size</span>
      <Choice ariaLabel="Text size" options={TEXT_SIZES} value={value.textSize} label={(s) => TEXT_SIZE_NAMES[s]}
              onchange={(textSize) => settings.update({ textSize })} />
    </div>
  </Section>

  <Section title="Units">
    <div class="rows">
      <span>Distance</span>
      <Choice ariaLabel="Distance unit" options={DISTANCE_UNITS} value={value.distanceUnit} label={(u) => DISTANCE_NAMES[u]}
              onchange={(distanceUnit) => settings.update({ distanceUnit })} />
      <span>Temperature</span>
      <Choice ariaLabel="Temperature unit" options={TEMPERATURE_UNITS} value={value.temperatureUnit} label={(u) => TEMPERATURE_NAMES[u]}
              onchange={(temperatureUnit) => settings.update({ temperatureUnit })} />
    </div>
    <p class="faint">Used by the time alignment in Setup.</p>
  </Section>

  <Section title="Safety">
    <div class="rows">
      <span>Output gain limit</span>
      <div class="inline">
        <Toggle pressed={value.gainCeilingDb !== null} title="Limit the output gains"
                onchange={(on) => settings.update({ gainCeilingDb: on ? DEFAULT_CEILING_DB : null })}>{value.gainCeilingDb !== null ? "On" : "Off"}</Toggle>
        {#if value.gainCeilingDb !== null}
          <NumberField ariaLabel="Output gain limit" value={value.gainCeilingDb} min={GAIN_RANGE.min} max={GAIN_RANGE.max}
                       step={CEILING_STEP_DB} format={(v) => formatDb(v)} unit="dB"
                       onchange={(gainCeilingDb) => settings.update({ gainCeilingDb })} />
        {/if}
      </div>
    </div>
    <p class="faint">Faders, fields, the wheel, the master trim and Setup cannot raise an output above the limit. Gains already above it (from a recalled preset or a file) stay as they are and show in the warning colour.</p>
  </Section>

  <Section title="Startup">
    <div class="rows">
      <span>Open on</span>
      <Choice ariaLabel="Open on" options={START_VIEWS} value={value.startView} label={(v) => START_NAMES[v]}
              onchange={(startView) => settings.update({ startView })} />
    </div>
    <p class="faint">A link to a view (such as …#out-1) always opens that view.</p>
  </Section>

  <Section title="Reset">
    {#if confirmReset}
      <div class="inline">
        <span>Reset every setting on this page to its default?</span>
        <button class="danger" onclick={resetAll}>Reset all settings</button>
        <button onclick={() => (confirmReset = false)}>Cancel</button>
      </div>
    {:else}
      <div class="inline">
        <button onclick={() => (confirmReset = true)}>Reset all settings…</button>
        <span class="faint">Setup presets and the device are not affected.</span>
      </div>
    {/if}
  </Section>
</div>

<style>
  .view { display: grid; gap: var(--gap); align-content: start; max-width: 1100px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); }
  .view :global(.wide) { grid-column: 1 / -1; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; }
  th { text-align: left; font-size: 11px; font-weight: 600; color: var(--text-dim); padding: 2px 12px 4px 0; }
  td { padding: 3px 12px 3px 0; }
  .channel { font-weight: 600; white-space: nowrap; box-shadow: inset 3px 0 0 var(--marker); padding-left: 8px; }
  td input[type="text"] { width: 160px; }
  .swatches { display: flex; gap: 3px; }
  .swatch {
    width: 18px; height: 18px; min-width: 0; padding: 0; border-radius: 50%;
    background: var(--swatch); border: 2px solid transparent;
  }
  .swatch:hover:not(:disabled) { background: var(--swatch); border-color: var(--text-faint); }
  .swatch.selected { border-color: var(--text); box-shadow: 0 0 0 1px var(--bg) inset; }
  .rows { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; align-items: center; }
  .rows > span { color: var(--text-dim); }
  .inline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  p { margin: 10px 0 0; }
</style>

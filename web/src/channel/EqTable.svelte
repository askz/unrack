<script lang="ts">
  // All filters of one output as an editable table: high-pass, 7 PEQ bands, low-pass.
  // Q is shown (the device stores Q in 0.1 steps); the model keeps bandwidth in octaves.
  import { device } from "../state/device.svelte.ts";
  import { ui } from "../state/ui.svelte.ts";
  import { FREQ_RANGE, PEQ_GAIN_RANGE } from "../state/params.ts";
  import { bwOctToQ, qToBwOct } from "../eq/biquad.ts";
  import type { Crossover, PeqBand } from "../eq/types.ts";
  import NumberField from "../ui/NumberField.svelte";
  import Toggle from "../ui/Toggle.svelte";
  import { formatDb, formatHz } from "../ui/format.ts";
  import { GAINLESS_PEQ_TYPES, PEQ_TYPE_CODES, PEQ_TYPE_LABELS, SLOPE_CODES, SLOPE_LABELS } from "../ui/labels.ts";

  let { ch }: { ch: number } = $props();

  const FREQ_STEP = Math.pow(2, 1 / 30); // one device frequency step (1/30 octave)
  const Q_RANGE = { min: 0.1, max: 25.5, step: 0.1 };
  const eq = $derived(device.ch(ch).eq!);
  const selected = $derived(ui.bandOf(ch));
  const seal = () => device.seal();

  function setBand(index: number, patch: Partial<PeqBand>): void {
    ui.selectBand(ch, index);
    device.setBand(ch, index, { ...eq.bands[index]!, ...patch });
  }
  function setCrossover(kind: "hpf" | "lpf", patch: Partial<Crossover>): void {
    const next = { ...eq[kind], ...patch };
    if (kind === "hpf") device.setHpf(ch, next);
    else device.setLpf(ch, next);
  }
  const qOf = (band: PeqBand) => bwOctToQ(band.bwOct, band.freqHz);
</script>

<div class="scroll">
  <table>
    <thead>
      <tr>
        <th class="c-id">Filter</th>
        <th class="c-on">On</th>
        <th class="c-type">Type</th>
        <th>Freq</th>
        <th>Gain</th>
        <th>Q</th>
        <th class="c-act"></th>
      </tr>
    </thead>
    <tbody>
      {@render crossoverRow("hpf", "HPF")}
      {#each eq.bands as band, index (index)}
        {@const status = device.syncOf({ kind: "peq", ch, band: index })}
        <tr class:selected={index === selected} onfocusin={() => ui.selectBand(ch, index)} onpointerdown={() => ui.selectBand(ch, index)}>
          <td class="c-id num">{index + 1}</td>
          <td class="c-on">
            <Toggle pressed={band.bypass === null ? null : !band.bypass} title="Band {index + 1} active" {status}
                    onchange={(on) => setBand(index, { bypass: !on })}>On</Toggle>
          </td>
          <td class="c-type">
            <select value={band.type} aria-label="Band {index + 1} type"
                    onchange={(event) => { setBand(index, { type: Number(event.currentTarget.value) }); seal(); }}>
              {#each PEQ_TYPE_CODES as code (code)}<option value={code}>{PEQ_TYPE_LABELS[code]}</option>{/each}
            </select>
          </td>
          <td>
            <NumberField value={band.freqHz} min={FREQ_RANGE.min} max={FREQ_RANGE.max} step={FREQ_STEP} log
                         format={formatHz} unit="Hz" {status} onend={seal} ariaLabel="Band {index + 1} frequency"
                         onchange={(freqHz) => setBand(index, { freqHz, bwOct: qToBwOct(qOf(band), freqHz) })} />
          </td>
          <td>
            <NumberField value={band.gainDb} min={PEQ_GAIN_RANGE.min} max={PEQ_GAIN_RANGE.max} step={0.1}
                         format={(v) => formatDb(v)} unit="dB" {status} onend={seal} ariaLabel="Band {index + 1} gain"
                         disabled={GAINLESS_PEQ_TYPES.has(band.type)}
                         onchange={(gainDb) => setBand(index, { gainDb })} />
          </td>
          <td>
            <NumberField value={qOf(band)} min={Q_RANGE.min} max={Q_RANGE.max} step={Q_RANGE.step}
                         format={(v) => v.toFixed(1)} {status} onend={seal} width="64px" ariaLabel="Band {index + 1} Q"
                         onchange={(q) => setBand(index, { bwOct: qToBwOct(q, band.freqHz) })} />
          </td>
          <td class="c-act">
            <button class="ghost" title="Reset band {index + 1}" aria-label="Reset band {index + 1}"
                    onclick={() => device.resetBand(ch, index)}>Reset</button>
          </td>
        </tr>
      {/each}
      {@render crossoverRow("lpf", "LPF")}
    </tbody>
  </table>
</div>

{#snippet crossoverRow(kind: "hpf" | "lpf", name: string)}
  {@const xo = eq[kind]}
  {@const status = device.syncOf({ kind, ch })}
  <tr class="xo" class:off={xo.slope === 0}>
    <td class="c-id">{name}</td>
    <td class="c-on"></td>
    <td class="c-type">
      <select value={xo.slope} aria-label="{name} slope"
              onchange={(event) => { setCrossover(kind, { slope: Number(event.currentTarget.value) }); seal(); }}>
        {#each SLOPE_CODES as code (code)}<option value={code}>{SLOPE_LABELS[code]}</option>{/each}
      </select>
    </td>
    <td>
      <NumberField value={xo.freqHz} min={FREQ_RANGE.min} max={FREQ_RANGE.max} step={FREQ_STEP} log
                   format={formatHz} unit="Hz" {status} onend={seal} ariaLabel="{name} frequency"
                   onchange={(freqHz) => setCrossover(kind, { freqHz })} />
    </td>
    <td class="faint">—</td>
    <td class="faint">—</td>
    <td class="c-act"></td>
  </tr>
{/snippet}

<style>
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 560px; }
  th { text-align: left; font-size: 11px; font-weight: 600; color: var(--text-dim); padding: 4px 6px; border-bottom: 1px solid var(--line); }
  td { padding: 3px 6px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  tr.selected td { background: var(--surface-2); }
  tr.selected .c-id { box-shadow: inset 3px 0 0 var(--accent); }
  tr.xo td { background: var(--surface-sunken); }
  tr.xo.off td:not(.c-type) { opacity: .6; }
  .c-id { width: 48px; font-weight: 600; }
  .c-on { width: 52px; }
  .c-type select { width: 150px; }
  .c-act { width: 60px; text-align: right; }
</style>

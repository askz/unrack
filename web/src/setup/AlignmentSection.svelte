<script lang="ts">
  // Setup's time alignment: speaker positions and the crowd in a side view (or direct
  // distances), the delays they give, and the by-ear fine tuning.
  import { settings } from "../state/settings.svelte.ts";
  import { channelLabel } from "../state/model.ts";
  import type { Range } from "../state/params.ts";
  import Section from "../ui/Section.svelte";
  import NumberField from "../ui/NumberField.svelte";
  import Toggle from "../ui/Toggle.svelte";
  import Choice from "../ui/Choice.svelte";
  import { formatDb, formatFixed } from "../ui/format.ts";
  import { celsiusToShown, metresToShown, shownToCelsius, shownToMetres } from "../ui/units.ts";
  import type { AlignmentMode } from "./alignment.ts";
  import { setupDraft as draft } from "./draft.svelte.ts";
  import {
    ALIGNMENT_MODES, CROWD_RANGE, DISTANCE_RANGE, EAR_HEIGHT_RANGE, HEIGHT_RANGE, LAYOUTS, POSITION_RANGE, TEMPERATURE_RANGE,
    alignmentDelaysMs, bandCount, rigOf, usedOutputs, type Recipe,
  } from "./recipe.ts";
  import AlignmentDiagram from "./AlignmentDiagram.svelte";
  import TuningPanel from "./TuningPanel.svelte";
  import { tuning, TUNING_LOCKED } from "./tuning.svelte.ts";

  interface Props {
    recipe: Recipe;
    problemAt: (field: string) => string | undefined;
    /** The whole setup form has no problems. */
    valid: boolean;
  }

  let { recipe, problemAt, valid }: Props = $props();

  const MODE_NAMES: Record<AlignmentMode, string> = { positions: "Positions", direct: "Direct distances" };
  const DISTANCE_STEP = 0.1;
  const TEMPERATURE_STEP = 1;

  const layout = $derived(LAYOUTS[recipe.layout]);
  const used = $derived(usedOutputs(layout));
  const rig = $derived(rigOf(recipe));
  const delays = $derived(alignmentDelaysMs(recipe));
  const positions = $derived(recipe.alignment.mode === "positions");
  const unit = $derived(settings.value.distanceUnit);
  const temperatureUnit = $derived(settings.value.temperatureUnit);
  /** The session's delays come from these values: they stay as they are until it ends. */
  const locked = $derived(tuning.running !== null);
  const lockTitle = $derived(locked ? TUNING_LOCKED : undefined);

  const clampTo = (value: number, range: Range) => Math.min(range.max, Math.max(range.min, value));
  const shown = (metres: number) => metresToShown(metres, unit);
  const toMetres = (value: number, range: Range) => clampTo(shownToMetres(value, unit), range);
  const formatDistance = (value: number) => formatFixed(value, 2);

  /** A crowd edit keeps a chosen alignment point inside the crowd. */
  function setCrowdEdge(edge: "startM" | "endM", value: number): void {
    draft.edit((r) => {
      r.alignment.crowd[edge] = toMetres(value, CROWD_RANGE);
      const { startM, endM } = r.alignment.crowd;
      if (r.alignment.pointM !== null) r.alignment.pointM = Math.min(Math.max(startM, endM), Math.max(startM, r.alignment.pointM));
    });
  }
</script>

<Section title="Time alignment">
  {#snippet actions()}
    <Toggle pressed={recipe.alignment.enabled} title={lockTitle ?? "Time alignment"} disabled={locked}
            onchange={(on) => draft.edit((r) => { r.alignment.enabled = on; })}>{recipe.alignment.enabled ? "On" : "Off"}</Toggle>
  {/snippet}
  {#if recipe.alignment.enabled}
    <div class="row">
      <Choice options={ALIGNMENT_MODES} value={recipe.alignment.mode} label={(mode) => MODE_NAMES[mode]} ariaLabel="How the speakers are placed"
              disabled={locked} title={lockTitle}
              onchange={(mode) => draft.edit((r) => { r.alignment.mode = mode; })} />
    </div>
    {#if positions}
      <p class="dim">Give each speaker's distance from the stage edge and its height, and where the crowd stands. The nearer speakers are delayed so that every sound arrives together at the alignment point.</p>
    {:else}
      <p class="dim">Measure from the listening spot to each speaker. The nearer speakers are delayed so that every sound arrives with the farthest one.</p>
    {/if}
    <div class="fields">
      <NumberField label="Air temperature" value={celsiusToShown(recipe.alignment.tempC, temperatureUnit)}
                   min={celsiusToShown(TEMPERATURE_RANGE.min, temperatureUnit)} max={celsiusToShown(TEMPERATURE_RANGE.max, temperatureUnit)}
                   step={TEMPERATURE_STEP} format={(v) => formatFixed(v, 0)} unit="°{temperatureUnit}" error={problemAt("alignment.tempC")}
                   disabled={locked}
                   onchange={(value) => draft.edit((r) => { r.alignment.tempC = clampTo(shownToCelsius(value, temperatureUnit), TEMPERATURE_RANGE); })} />
      {#if positions}
        <NumberField label="Crowd from" value={shown(recipe.alignment.crowd.startM)} min={shown(CROWD_RANGE.min)} max={shown(CROWD_RANGE.max)}
                     step={DISTANCE_STEP} format={formatDistance} {unit} error={problemAt("alignment.crowd.startM")}
                     disabled={locked} onchange={(value) => setCrowdEdge("startM", value)} />
        <NumberField label="Crowd to" value={shown(recipe.alignment.crowd.endM)} min={shown(CROWD_RANGE.min)} max={shown(CROWD_RANGE.max)}
                     step={DISTANCE_STEP} format={formatDistance} {unit} error={problemAt("alignment.crowd.endM")}
                     disabled={locked} onchange={(value) => setCrowdEdge("endM", value)} />
        <NumberField label="Ear height" value={shown(recipe.alignment.crowd.earHeightM)} min={shown(EAR_HEIGHT_RANGE.min)}
                     max={shown(EAR_HEIGHT_RANGE.max)} step={DISTANCE_STEP} format={formatDistance} {unit}
                     error={problemAt("alignment.crowd.earHeightM")} disabled={locked}
                     onchange={(value) => draft.edit((r) => { r.alignment.crowd.earHeightM = toMetres(value, EAR_HEIGHT_RANGE); })} />
      {/if}
    </div>
    {#if positions}
      <AlignmentDiagram {rig} names={layout.outputs.map((output) => output?.name ?? null)} bands={bandCount(layout)} {unit}
                        disabled={locked} title={lockTitle}
                        onpoint={(pointM) => draft.edit((r) => { r.alignment.pointM = pointM; })} />
      {#if problemAt("alignment.pointM")}<p class="error">{problemAt("alignment.pointM")}</p>{/if}
    {/if}
    <table class="table">
      <thead>
        <tr>
          <th>Output</th>
          {#if positions}<th>From stage edge</th><th>Height</th>{:else}<th>Distance</th>{/if}
          <th>Delay</th><th>Fine-tune</th>
        </tr>
      </thead>
      <tbody>
        {#each used as output (output.ch)}
          {@const offset = recipe.alignment.offsetsMs[output.index] ?? 0}
          {@const speaker = recipe.alignment.speakers[output.index]!}
          <tr>
            <td>{output.slot.name} <span class="faint">{channelLabel(output.ch)}</span></td>
            {#if positions}
              <td>
                <NumberField ariaLabel="{output.slot.name} distance from the stage edge" value={shown(speaker.xM)}
                             min={shown(POSITION_RANGE.min)} max={shown(POSITION_RANGE.max)} step={DISTANCE_STEP} format={formatDistance} {unit}
                             error={problemAt(`alignment.speakers.${output.index}.xM`)} disabled={locked}
                             onchange={(value) => draft.edit((r) => { r.alignment.speakers[output.index]!.xM = toMetres(value, POSITION_RANGE); })} />
              </td>
              <td>
                <NumberField ariaLabel="{output.slot.name} height" value={shown(speaker.heightM)}
                             min={shown(HEIGHT_RANGE.min)} max={shown(HEIGHT_RANGE.max)} step={DISTANCE_STEP} format={formatDistance} {unit}
                             error={problemAt(`alignment.speakers.${output.index}.heightM`)} disabled={locked}
                             onchange={(value) => draft.edit((r) => { r.alignment.speakers[output.index]!.heightM = toMetres(value, HEIGHT_RANGE); })} />
              </td>
            {:else}
              <td>
                <NumberField ariaLabel="Distance to {output.slot.name}" value={shown(recipe.alignment.distancesM[output.index] ?? 0)}
                             min={shown(DISTANCE_RANGE.min)} max={shown(DISTANCE_RANGE.max)} step={DISTANCE_STEP} format={formatDistance} {unit}
                             error={problemAt(`alignment.distancesM.${output.index}`)} disabled={locked}
                             onchange={(value) => draft.edit((r) => { r.alignment.distancesM[output.index] = toMetres(value, DISTANCE_RANGE); })} />
              </td>
            {/if}
            <td class="num">{formatFixed(delays[output.index] ?? 0, 2)} ms</td>
            <td class="num">
              {#if offset !== 0}
                {formatDb(offset, 2)} ms
                <button class="ghost" title={lockTitle ?? `Remove the fine-tune offset of ${output.slot.name}`} disabled={locked}
                        onclick={() => draft.edit((r) => { r.alignment.offsetsMs[output.index] = 0; })}>Reset</button>
              {:else}
                <span class="faint">none</span>
              {/if}
              {#if problemAt(`alignment.offsetsMs.${output.index}`)}<span class="error">{problemAt(`alignment.offsetsMs.${output.index}`)}</span>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if problemAt("alignment.delay")}<p class="error">{problemAt("alignment.delay")}</p>{/if}
    <TuningPanel {recipe} {valid} />
    <p class="faint">
      Distances cannot include the cabinets' own delay; the by-ear fine tuning corrects it at the alignment point. With an
      audience in front of ground-stacked subs, the subs arrive a little later, so slightly less sub delay is often better.
      A measurement app (REW, Open Sound Meter) is the reliable check.
    </p>
  {:else}
    <p class="dim">Off: the output delays are left as they are.</p>
    {#if tuning.running || tuning.interrupted}<TuningPanel {recipe} {valid} />{/if}
  {/if}
</Section>

<style>
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 8px; }
  .fields { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px 16px; margin-bottom: 10px; }
  .table { border-collapse: collapse; margin-bottom: 10px; }
  .table th { text-align: left; font-size: 11px; font-weight: 600; color: var(--text-dim); padding: 2px 12px 4px 0; }
  .table td { padding: 3px 12px 3px 0; vertical-align: top; }
  .table td:first-child { padding-top: 8px; white-space: nowrap; }
  .table td.num { padding-top: 8px; white-space: nowrap; }
  p { margin: 0 0 8px; }
  .error { color: var(--bad); }
  td .error { display: block; font-size: 11px; white-space: normal; }
</style>

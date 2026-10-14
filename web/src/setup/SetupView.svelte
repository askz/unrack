<script lang="ts">
  // Setup: pick a speaker layout and an environment, adjust a few system values, review
  // the exact changes, then apply them as one undo step. Only the parameters a setup
  // owns are written (outputs only; mutes and inputs are left alone).
  import { device } from "../state/device.svelte.ts";
  import { settings } from "../state/settings.svelte.ts";
  import { defaultCalibration } from "../eq/calibration.ts";
  import { OUT_BASE, OUTPUT_COUNT, channelLabel } from "../state/model.ts";
  import Section from "../ui/Section.svelte";
  import NumberField from "../ui/NumberField.svelte";
  import Toggle from "../ui/Toggle.svelte";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import { stepGainDb } from "../ui/faderTaper.ts";
  import { formatDb, formatFixed, formatHz } from "../ui/format.ts";
  import { openTextFile, saveTextFile } from "../ui/files.ts";
  import { buildSetup } from "./build.ts";
  import { describeChanges, previewModel } from "./review.ts";
  import { setupDraft as draft } from "./draft.svelte.ts";
  import { BUILTIN_PRESETS, PRESET_NAME_MAX_LENGTH, SetupFileError } from "./library.ts";
  import {
    CROSSOVER_RANGE, DISTANCE_RANGE, ENVIRONMENTS, ENVIRONMENT_IDS, LAYOUTS, LAYOUT_IDS, ROLE_NAMES, SHELF_RANGE,
    SLOPES, SOURCES, SUBSONIC_RANGE, TEMPERATURE_RANGE, THRESHOLD_RANGE, TRIM_RANGE, alignmentDelaysMs, checkRecipe,
    layoutRoles, usedOutputs, withEnvironment, withLayout, type Recipe, type Role, type SlopeId, type SourceId,
  } from "./recipe.ts";
  import LayoutCard from "./LayoutCard.svelte";
  import CrossoverPreview from "./CrossoverPreview.svelte";

  const SOURCE_NAMES: Record<SourceId, string> = { stereo: "Stereo A / B", mono: "Mono A" };
  const SLOPE_NAMES: Record<SlopeId, string> = { LR24: "Linkwitz-Riley 24 dB/oct", LR12: "Linkwitz-Riley 12 dB/oct" };
  const SHELF_STEP_DB = 0.5;
  const TEMPERATURE_STEP = 1;
  const DISTANCE_STEP = 0.1;
  const FEET_PER_METRE = 1 / 0.3048;
  const OUTPUTS = Array.from({ length: OUTPUT_COUNT }, (_, i) => OUT_BASE + i);
  /** Matches the two-column rule in the styles below. */
  const WIDE_LAYOUT_QUERY = "(min-width: 1000px)";

  const recipe = $derived(draft.recipe);
  const layout = $derived(LAYOUTS[recipe.layout]);
  const used = $derived(usedOutputs(layout));
  const roles = $derived(layoutRoles(layout));
  const problems = $derived(checkRecipe(recipe));
  const problemAt = (field: string) => problems.find((problem) => problem.field === field)?.message;

  const gainStep = $derived(settings.value.gainStepDb);
  const freqStep = $derived(Math.pow(2, 1 / settings.value.freqStepDivisions));
  const ceiling = $derived(device.gainCeiling);

  const recipeKey = $derived(JSON.stringify(recipe));
  const build = $derived(problems.length === 0 ? buildSetup($state.snapshot(recipe) as Recipe, { gainCeilingDb: ceiling }) : null);
  const current = $derived(device.edit.model);
  const preview = $derived(build ? previewModel(current, build.assignments, defaultCalibration) : current);
  const previewOutputs = $derived(build
    ? used.map((output) => ({ ch: output.ch, name: output.slot.name }))
    : OUTPUTS.map((ch) => ({ ch, name: device.displayName(ch) })));
  const changes = $derived.by(() => {
    if (!build) return [];
    const names = Object.entries(build.names).flatMap(([key, name]) => {
      const ch = Number(key);
      const now = device.displayName(ch);
      return now === name ? [] : [`${channelLabel(ch)} name: ${now} → ${name}`];
    });
    return [...names, ...describeChanges(current, build.assignments, defaultCalibration, (ch) => device.displayName(ch))];
  });
  const clampedTrims = $derived(ceiling === null ? [] : roles.filter((role) => (recipe.trimsDb[role] ?? 0) > ceiling));

  /** The change list starts open where the review has a column of its own. */
  let changesOpen = $state(typeof matchMedia === "undefined" || matchMedia(WIDE_LAYOUT_QUERY).matches);
  let applied = $state<{ key: string; spare: number[] } | null>(null);
  const justApplied = $derived(applied !== null && applied.key === recipeKey && changes.length === 0);
  const visibleSpare = $derived(applied ? applied.spare.filter((ch) => !settings.value.hidden.includes(ch)) : []);

  let saving = $state(false);
  let saveName = $state("");
  let confirmDelete = $state(false);
  let fileIssues = $state<string[]>([]);
  const replacing = $derived(draft.customs.find((preset) => preset.name.toLowerCase() === saveName.trim().toLowerCase()));

  // ---- units ----
  const metric = $derived(settings.value.distanceUnit === "m");
  const celsius = $derived(settings.value.temperatureUnit === "C");
  const toDistance = (metres: number) => (metric ? metres : metres * FEET_PER_METRE);
  const fromDistance = (shown: number) => clampTo(metric ? shown : shown / FEET_PER_METRE, DISTANCE_RANGE.min, DISTANCE_RANGE.max);
  const toTemperature = (c: number) => (celsius ? c : (c * 9) / 5 + 32);
  const fromTemperature = (shown: number) => clampTo(celsius ? shown : ((shown - 32) * 5) / 9, TEMPERATURE_RANGE.min, TEMPERATURE_RANGE.max);
  const clampTo = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const delays = $derived(alignmentDelaysMs(recipe));

  // ---- labels ----
  function bandName(band: number): string {
    const names = new Set(used.filter((output) => output.slot.band === band).map((output) => ROLE_NAMES[output.slot.role]));
    return [...names].join(" / ");
  }
  const outputsOf = (role: Role) => used.filter((output) => output.slot.role === role).map((output) => channelLabel(output.ch)).join(", ");

  // ---- actions ----
  function setInverted(role: Role, inverted: boolean): void {
    draft.edit((r) => { r.invert = inverted ? [...r.invert.filter((x) => x !== role), role] : r.invert.filter((x) => x !== role); });
  }

  function apply(): void {
    if (!build) return;
    const result = device.applySetup($state.snapshot(recipe) as Recipe);
    applied = { key: recipeKey, spare: result.spare };
  }

  function hideSpare(): void {
    settings.update({ hidden: [...settings.value.hidden, ...visibleSpare].sort((a, b) => a - b) });
  }

  function startSave(): void {
    saveName = draft.selected && !draft.selected.builtin ? draft.selected.name : "";
    saving = true;
  }

  function save(event: SubmitEvent): void {
    event.preventDefault();
    if (draft.saveAs(saveName)) saving = false;
  }

  function exportFile(): void {
    const file = draft.exportFile();
    saveTextFile(file.name, file.text);
  }

  async function importFile(): Promise<void> {
    const text = await openTextFile(".json,application/json");
    if (text === null) return;
    try {
      draft.importFile(text);
      fileIssues = [];
    } catch (error) {
      fileIssues = error instanceof SetupFileError ? error.issues : [error instanceof Error ? error.message : String(error)];
    }
  }

  function deletePreset(): void {
    if (draft.selected && !draft.selected.builtin) draft.remove(draft.selected.id);
    confirmDelete = false;
  }

  const focus = (element: HTMLElement) => { element.focus(); };
</script>

<div class="setup">
  <div class="form">
    <Section title="Preset">
      {#snippet actions()}
        {#if draft.modified}<span class="tag">modified</span>{/if}
      {/snippet}
      <div class="row">
        <select class="preset" value={draft.presetId} aria-label="Preset" onchange={(event) => draft.choose(event.currentTarget.value)}>
          <optgroup label="Built-in">
            {#each BUILTIN_PRESETS as preset (preset.id)}<option value={preset.id}>{preset.name}</option>{/each}
          </optgroup>
          {#if draft.customs.length > 0}
            <optgroup label="Saved in this browser">
              {#each draft.customs as preset (preset.id)}<option value={preset.id}>{preset.name}</option>{/each}
            </optgroup>
          {/if}
        </select>
        <button disabled={!draft.modified || !draft.selected} onclick={() => draft.revert()}>Revert</button>
        <button disabled={problems.length > 0} onclick={startSave}>Save as…</button>
        <button onclick={exportFile}>Export…</button>
        <button onclick={importFile}>Import…</button>
        {#if draft.selected && !draft.selected.builtin}<button class="danger" onclick={() => (confirmDelete = true)}>Delete</button>{/if}
      </div>
      {#if saving}
        <form class="row save" onsubmit={save}>
          <input type="text" bind:value={saveName} maxlength={PRESET_NAME_MAX_LENGTH} placeholder="Preset name" aria-label="Preset name" {@attach focus} />
          <button class="primary" type="submit" disabled={!saveName.trim() || problems.length > 0}>{replacing ? "Replace" : "Save"}</button>
          <button type="button" onclick={() => (saving = false)}>Cancel</button>
          {#if replacing}<span class="dim">Replaces the saved preset “{replacing.name}”</span>{/if}
        </form>
      {/if}
      {#if fileIssues.length > 0}
        <div class="problems">
          <p>This file could not be imported:</p>
          <ul>{#each fileIssues as issue, i (i)}<li>{issue}</li>{/each}</ul>
          <button class="ghost" onclick={() => (fileIssues = [])}>Dismiss</button>
        </div>
      {/if}
    </Section>

    <Section title="Layout">
      {#snippet actions()}
        <span class="faint">Input</span>
        <div class="segmented" role="group" aria-label="Input">
          {#each SOURCES as source (source)}
            <button class:primary={recipe.source === source} aria-pressed={recipe.source === source}
                    onclick={() => draft.edit((r) => { r.source = source; })}>{SOURCE_NAMES[source]}</button>
          {/each}
        </div>
      {/snippet}
      <div class="cards">
        {#each LAYOUT_IDS as id (id)}
          <LayoutCard layout={LAYOUTS[id]} source={recipe.source} selected={recipe.layout === id}
                      onselect={() => draft.update(withLayout(recipe, id))} />
        {/each}
      </div>
    </Section>

    <Section title="System">
      <div class="fields">
        {#each recipe.crossoversHz as hz, i (i)}
          <NumberField label="Crossover {bandName(i)} / {bandName(i + 1)}" value={hz} min={CROSSOVER_RANGE.min} max={CROSSOVER_RANGE.max}
                       step={freqStep} log format={formatHz} unit="Hz" width="150px" error={problemAt(`crossoversHz.${i}`)}
                       onchange={(value) => draft.edit((r) => { r.crossoversHz[i] = value; })} />
        {/each}
        {#if recipe.crossoversHz.length > 0}
          <label class="select">
            <span class="label">Slope</span>
            <select value={recipe.slope} onchange={(event) => { const slope = event.currentTarget.value as SlopeId; draft.edit((r) => { r.slope = slope; }); }}>
              {#each SLOPES as slope (slope)}<option value={slope}>{SLOPE_NAMES[slope]}</option>{/each}
            </select>
          </label>
        {/if}
        <div class="subsonic">
          <span class="label">Subsonic filter</span>
          <div class="row">
            <Toggle pressed={recipe.subsonic.enabled}
                    title="High-pass on the lowest band (Butterworth 24 dB/oct): keeps the cones from moving below what the speakers can play"
                    onchange={(on) => draft.edit((r) => { r.subsonic.enabled = on; })}>{recipe.subsonic.enabled ? "On" : "Off"}</Toggle>
            <NumberField ariaLabel="Subsonic frequency" value={recipe.subsonic.freqHz} min={SUBSONIC_RANGE.min} max={SUBSONIC_RANGE.max}
                         step={freqStep} log format={formatHz} unit="Hz" disabled={!recipe.subsonic.enabled}
                         error={problemAt("subsonic.freqHz")}
                         onchange={(value) => draft.edit((r) => { r.subsonic.freqHz = value; })} />
          </div>
        </div>
      </div>
      {#if problemAt("crossoversHz")}<p class="error">{problemAt("crossoversHz")}</p>{/if}

      <table class="table">
        <thead><tr><th>Speakers</th><th>Trim</th><th>Polarity</th></tr></thead>
        <tbody>
          {#each roles as role (role)}
            {@const trim = recipe.trimsDb[role] ?? 0}
            <tr>
              <td>{ROLE_NAMES[role]} <span class="faint">{outputsOf(role)}</span></td>
              <td>
                <NumberField ariaLabel="{ROLE_NAMES[role]} trim" value={trim} min={TRIM_RANGE.min} max={TRIM_RANGE.max} step={gainStep}
                             stepper={stepGainDb} format={(v) => formatDb(v)} unit="dB" warn={ceiling !== null && trim > ceiling}
                             error={problemAt(`trimsDb.${role}`)} onchange={(value) => draft.edit((r) => { r.trimsDb[role] = value; })} />
              </td>
              <td>
                <Toggle pressed={recipe.invert.includes(role)} tone="warn" title="Invert polarity of {ROLE_NAMES[role]}"
                        onchange={(on) => setInverted(role, on)}>Ø</Toggle>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if clampedTrims.length > 0}
        <p class="warning">
          {clampedTrims.map((role) => ROLE_NAMES[role]).join(", ")}: above the output gain limit ({formatDb(ceiling ?? 0)} dB) set in Settings; the limit is applied instead.
        </p>
      {/if}
    </Section>

    <Section title="Environment">
      <div class="chips" role="group" aria-label="Environment">
        {#each ENVIRONMENT_IDS as id (id)}
          <button class:primary={recipe.environment.id === id} aria-pressed={recipe.environment.id === id} title={ENVIRONMENTS[id].hint}
                  onclick={() => draft.update(withEnvironment(recipe, id))}>{ENVIRONMENTS[id].name}</button>
        {/each}
      </div>
      <p class="dim">{ENVIRONMENTS[recipe.environment.id].hint}.</p>
      <div class="fields">
        <NumberField label="Low shelf {formatHz(ENVIRONMENTS[recipe.environment.id].lowHz)} Hz" value={recipe.environment.lowDb}
                     min={SHELF_RANGE.min} max={SHELF_RANGE.max} step={SHELF_STEP_DB} format={(v) => formatDb(v)} unit="dB" width="130px"
                     error={problemAt("environment.lowDb")} onchange={(value) => draft.edit((r) => { r.environment.lowDb = value; })} />
        <NumberField label="High shelf {formatHz(ENVIRONMENTS[recipe.environment.id].highHz)} Hz" value={recipe.environment.highDb}
                     min={SHELF_RANGE.min} max={SHELF_RANGE.max} step={SHELF_STEP_DB} format={(v) => formatDb(v)} unit="dB" width="130px"
                     error={problemAt("environment.highDb")} onchange={(value) => draft.edit((r) => { r.environment.highDb = value; })} />
      </div>
      <p class="faint">The low shelf goes on the lowest band and the high shelf on the highest, in PEQ bands 1 and 7.</p>
    </Section>

    <Section title="Time alignment">
      {#snippet actions()}
        <Toggle pressed={recipe.alignment.enabled} title="Time alignment"
                onchange={(on) => draft.edit((r) => { r.alignment.enabled = on; })}>{recipe.alignment.enabled ? "On" : "Off"}</Toggle>
      {/snippet}
      {#if recipe.alignment.enabled}
        <p class="dim">Measure from the listening spot to each speaker. The nearer speakers are delayed so that every sound arrives with the farthest one.</p>
        <div class="fields">
          <NumberField label="Air temperature" value={toTemperature(recipe.alignment.tempC)} min={toTemperature(TEMPERATURE_RANGE.min)}
                       max={toTemperature(TEMPERATURE_RANGE.max)} step={TEMPERATURE_STEP} format={(v) => formatFixed(v, 0)}
                       unit="°{settings.value.temperatureUnit}" error={problemAt("alignment.tempC")}
                       onchange={(value) => draft.edit((r) => { r.alignment.tempC = fromTemperature(value); })} />
        </div>
        <table class="table">
          <thead><tr><th>Output</th><th>Distance</th><th>Delay</th></tr></thead>
          <tbody>
            {#each used as output (output.ch)}
              <tr>
                <td>{output.slot.name} <span class="faint">{channelLabel(output.ch)}</span></td>
                <td>
                  <NumberField ariaLabel="Distance to {output.slot.name}" value={toDistance(recipe.alignment.distancesM[output.index] ?? 0)}
                               min={toDistance(DISTANCE_RANGE.min)} max={toDistance(DISTANCE_RANGE.max)} step={DISTANCE_STEP}
                               format={(v) => formatFixed(v, 2)} unit={settings.value.distanceUnit}
                               error={problemAt(`alignment.distancesM.${output.index}`)}
                               onchange={(value) => draft.edit((r) => { r.alignment.distancesM[output.index] = fromDistance(value); })} />
                </td>
                <td class="num">{formatFixed(delays[output.index] ?? 0, 2)} ms</td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if problemAt("alignment.delay")}<p class="error">{problemAt("alignment.delay")}</p>{/if}
      {:else}
        <p class="dim">Off: the output delays are left as they are.</p>
      {/if}
    </Section>

    <Section title="Protection">
      {#snippet actions()}
        <Toggle pressed={recipe.protection.enabled} title="Protection limiters"
                onchange={(on) => draft.edit((r) => { r.protection.enabled = on; })}>{recipe.protection.enabled ? "On" : "Off"}</Toggle>
      {/snippet}
      {#if recipe.protection.enabled}
        <p class="dim">A limiter on each used output, with attack and release times chosen per speaker type. Set each threshold for your amplifier and speakers.</p>
        <table class="table">
          <thead><tr><th>Speakers</th><th>Threshold</th></tr></thead>
          <tbody>
            {#each roles as role (role)}
              <tr>
                <td>{ROLE_NAMES[role]} <span class="faint">{outputsOf(role)}</span></td>
                <td>
                  <NumberField ariaLabel="{ROLE_NAMES[role]} limiter threshold" value={recipe.protection.thresholdDb[role] ?? 0}
                               min={THRESHOLD_RANGE.min} max={THRESHOLD_RANGE.max} step={gainStep} format={(v) => formatDb(v)} unit="dB"
                               error={problemAt(`protection.thresholdDb.${role}`)}
                               onchange={(value) => draft.edit((r) => { r.protection.thresholdDb[role] = value; })} />
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="dim">Off: the output compressors are left as they are.</p>
      {/if}
    </Section>
  </div>

  <div class="side">
    <Section title="Preview">
      <CrossoverPreview model={preview} outputs={previewOutputs} />
      {#if !build}<p class="faint">Showing the outputs as they are now: fix the problems below to see the setup.</p>{/if}
    </Section>

    <Section title="Review and apply" class="review">
      <p class="warning">A starting point, not a tuning for your speakers. Turn the amplifiers down before applying.</p>
      {#if problems.length > 0}
        <div class="problems">
          <p>Fix these first:</p>
          <ul>{#each problems as problem, i (i)}<li>{problem.message}</li>{/each}</ul>
        </div>
      {:else if justApplied}
        <p class="ok">Applied as one undo step: Ctrl+Z restores the previous values (the output names stay).</p>
        {#if visibleSpare.length > 0}
          <div class="row">
            <span>{visibleSpare.map((ch) => channelLabel(ch)).join(", ")} {visibleSpare.length === 1 ? "is" : "are"} not used.</span>
            <button onclick={hideSpare}>Hide {visibleSpare.length === 1 ? "it" : "them"}</button>
          </div>
        {/if}
      {:else if changes.length === 0}
        <p class="dim">The outputs already match this setup.</p>
      {:else}
        <details class="changes" bind:open={changesOpen}>
          <summary>{changes.length} change{changes.length === 1 ? "" : "s"}</summary>
          <ul>{#each changes as line, i (i)}<li>{line}</li>{/each}</ul>
        </details>
      {/if}
      <div class="row">
        <button class="primary" disabled={!build || changes.length === 0} onclick={apply}>
          Apply{changes.length > 0 ? ` ${changes.length} change${changes.length === 1 ? "" : "s"}` : ""}
        </button>
        {#if !device.connected}<span class="faint">Offline: this changes the screen only.</span>{/if}
      </div>
    </Section>
  </div>
</div>

<ConfirmDialog
  open={confirmDelete}
  title="Delete preset?"
  message="“{draft.selected?.name ?? ''}” will be removed from this browser. The form keeps its values."
  confirmLabel="Delete"
  danger
  onconfirm={deletePreset}
  oncancel={() => (confirmDelete = false)}
/>

<style>
  .setup { display: grid; gap: var(--gap); align-items: start; max-width: 1400px; grid-template-columns: minmax(0, 1fr); }
  .form, .side { display: grid; gap: var(--gap); min-width: 0; align-content: start; }
  @media (min-width: 1000px) {
    .setup { grid-template-columns: minmax(0, 3fr) minmax(360px, 2fr); }
    /* 130px: top bar, tabs, status bar and the main padding */
    .side { position: sticky; top: 0; max-height: calc(100dvh - 130px); overflow-y: auto; }
  }
  @media (max-width: 999px) {
    .side { display: contents; }
    .setup :global(.review) { position: sticky; bottom: 0; z-index: 1; box-shadow: 0 -6px 16px rgb(0 0 0 / .35); }
  }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .save { margin-top: 8px; }
  .save input { flex: 1 1 200px; max-width: 320px; }
  .preset { min-width: 200px; }
  .tag { font-size: 11px; color: var(--warn); }
  .segmented { display: flex; gap: 2px; }
  .segmented button { height: 24px; padding: 0 8px; }
  .cards { display: grid; gap: var(--gap); grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); }
  .fields { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px 16px; margin-bottom: 10px; }
  .select, .subsonic { display: inline-flex; flex-direction: column; gap: 2px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
  .table { border-collapse: collapse; }
  .table th { text-align: left; font-size: 11px; font-weight: 600; color: var(--text-dim); padding: 2px 12px 4px 0; }
  .table td { padding: 3px 12px 3px 0; vertical-align: top; }
  .table td:first-child { padding-top: 8px; white-space: nowrap; }
  .table td.num { padding-top: 8px; }
  p { margin: 0 0 8px; }
  .warning { color: var(--warn); }
  .ok { color: var(--ok); }
  .error { color: var(--bad); }
  .problems { margin-bottom: 8px; padding: 6px 10px; border-left: 3px solid var(--bad); background: var(--surface-2); }
  .problems p { margin: 0 0 4px; }
  .problems ul, .changes ul { margin: 0; padding-left: 18px; }
  .changes { margin-bottom: 8px; }
  .changes summary { cursor: pointer; color: var(--text-dim); margin-bottom: 4px; }
  .changes ul { max-height: min(260px, 28vh); overflow-y: auto; font-size: 12px; }
  .changes li, .problems li { margin: 1px 0; }
</style>

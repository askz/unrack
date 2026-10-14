<script lang="ts">
  // By-ear fine tuning, step by step: intro (safety, where to stand, which pair), the
  // running session (offset with Earlier / Later), and the notice after an interrupted one.
  import { device } from "../state/device.svelte.ts";
  import { settings } from "../state/settings.svelte.ts";
  import NumberField from "../ui/NumberField.svelte";
  import Choice from "../ui/Choice.svelte";
  import { formatDb, formatFixed } from "../ui/format.ts";
  import { metresToShown } from "../ui/units.ts";
  import { effectivePointM } from "./alignment.ts";
  import { LAYOUTS, rigOf, type Recipe } from "./recipe.ts";
  import { tuning } from "./tuning.svelte.ts";
  import { tuningBlocker, tuningSteps } from "./tuning.ts";

  interface Props {
    recipe: Recipe;
    /** The whole setup form has no problems. */
    valid: boolean;
  }

  let { recipe, valid }: Props = $props();

  const NUDGE_MS = 0.1;
  const NUDGE_SHIFT_MS = 1;

  const layout = $derived(LAYOUTS[recipe.layout]);
  const rig = $derived(rigOf(recipe));
  const steps = $derived(tuningSteps(layout.outputs, recipe.crossoversHz));
  const blocker = $derived(tuning.interrupted
    ? "Restore or dismiss the interrupted session first"
    : tuningBlocker({ connected: device.connected, busy: !!device.busy, valid, rig, model: device.edit.model }));
  const unit = $derived(settings.value.distanceUnit);
  const where = $derived(recipe.alignment.mode === "positions"
    ? `Stand at the alignment point, ${formatFixed(metresToShown(effectivePointM(rig), unit), 1)} ${unit} from the stage edge, ears at the ear height.`
    : "Stand at the spot you measured the distances from.");
  const nameOf = (index: number) => layout.outputs[index]?.name ?? `Out ${index + 1}`;

  let open = $state(false);
  let stepIndex = $state(0);
  let chosen = $state<number | null>(null);
  const step = $derived(steps[Math.min(stepIndex, steps.length - 1)]);
  const upper = $derived(step && chosen !== null && step.uppers.includes(chosen) ? chosen : step?.uppers[0]);

  function begin(): void {
    stepIndex = 0;
    chosen = null;
    open = true;
  }

  function start(): void {
    if (!step || upper === undefined) return;
    tuning.start($state.snapshot(recipe) as Recipe, step, upper, `${nameOf(step.lower)} ↔ ${nameOf(upper)}`);
  }

  function done(): void {
    tuning.done();
    if (stepIndex + 1 < steps.length) {
      stepIndex++;
      chosen = null;
    } else {
      open = false;
    }
  }

  function nudge(event: MouseEvent, direction: 1 | -1): void {
    tuning.setOffset(tuning.offsetMs + direction * (event.shiftKey ? NUDGE_SHIFT_MS : NUDGE_MS));
  }
</script>

{#if tuning.interrupted && device.connected && !tuning.running}
  <div class="panel">
    <p>
      A fine-tuning session was interrupted. Restore the mutes, polarity and delays it changed? Dismiss turns the tone off
      and leaves the mutes, polarity and delays as they are now.
    </p>
    <div class="row">
      <button class="primary" onclick={() => tuning.restoreInterrupted()}>Restore</button>
      <button onclick={() => tuning.dismissInterrupted()}>Dismiss</button>
    </div>
  </div>
{/if}

{#if tuning.running}
  {@const run = tuning.running}
  {@const adjustable = device.connected && !tuning.starting}
  <div class="panel">
    <h4>Fine-tune {run.pairName}</h4>
    {#if tuning.starting}
      <p>Muting the other outputs and inverting {nameOf(run.step.lower)}. The tone starts once the device has confirmed it.</p>
    {:else}
      <p>{nameOf(run.step.lower)} is inverted and a {formatFixed(run.toneHz, 0)} Hz sine is playing. Make the tone as quiet as possible: the quietest point is the aligned one.</p>
    {/if}
    <p class="warning">Only {nameOf(run.step.lower)} and {nameOf(run.upper)} should play. If other speakers play, press Cancel and switch their amplifiers off.</p>
    {#if !device.connected}
      <p class="warning">The device is not connected. Cancel now: the changes are offered for restoring when it is connected again.</p>
    {/if}
    <div class="row">
      <button disabled={!adjustable} onclick={(event) => nudge(event, -1)} title="Less delay on {nameOf(run.step.lower)} (Shift: 1 ms)">Earlier</button>
      <NumberField ariaLabel="Fine-tune offset of {nameOf(run.step.lower)}" value={tuning.offsetMs} min={run.limits.min} max={run.limits.max}
                   step={NUDGE_MS} format={(v) => formatDb(v, 2)} unit="ms" width="110px" disabled={!adjustable}
                   onchange={(value) => tuning.setOffset(value)} />
      <button disabled={!adjustable} onclick={(event) => nudge(event, 1)} title="More delay on {nameOf(run.step.lower)} (Shift: 1 ms)">Later</button>
      <span class="faint">{formatDb(run.limits.min, 1)} to {formatDb(run.limits.max, 1)} ms</span>
    </div>
    <div class="row">
      <button class="primary" disabled={!adjustable} onclick={done}>Done</button>
      <button onclick={() => tuning.cancel()}>Cancel</button>
    </div>
  </div>
{:else if open && step && upper !== undefined}
  <div class="panel">
    <h4>Fine-tune by ear</h4>
    <p class="warning">The tone plays at full level. Turn the amplifiers down first.</p>
    <p>{where}</p>
    {#if steps.length > 1}
      <label class="select">
        <span class="label">Pair</span>
        <select value={stepIndex} onchange={(event) => { stepIndex = Number(event.currentTarget.value); chosen = null; }}>
          {#each steps as s, i (i)}
            <option value={i}>{nameOf(s.lower)} with {s.uppers.map(nameOf).join(" or ")}, {formatFixed(s.crossoverHz, 0)} Hz</option>
          {/each}
        </select>
      </label>
    {/if}
    {#if step.uppers.length > 1}
      <div class="row">
        <span class="faint">Against</span>
        <Choice options={step.uppers} value={upper} label={nameOf} ariaLabel="Tune against" onchange={(index) => (chosen = index)} />
      </div>
    {/if}
    <p class="dim">
      {nameOf(step.lower)} gets inverted and a sine near {formatFixed(step.crossoverHz, 0)} Hz plays on {nameOf(step.lower)} and
      {nameOf(upper)} only. Done keeps the result as one undo step; Cancel puts everything back.
      Outputs whose mute is unknown are unmuted at the end, so set their mutes first if that matters.
      Undo puts the device delays back, but the offset stays in the setup until you reset it in the Fine-tune column.
    </p>
    <div class="row">
      <button class="primary" disabled={blocker !== null} title={blocker ?? undefined} onclick={start}>Start</button>
      <button onclick={() => (open = false)}>Close</button>
      {#if blocker}<span class="faint">{blocker}</span>{/if}
    </div>
  </div>
{:else if steps.length > 0}
  <div class="row">
    <button disabled={blocker !== null} title={blocker ?? "Find the cabinets' own delay with a sine and a polarity flip"} onclick={begin}>Fine-tune by ear…</button>
    {#if blocker}<span class="faint">{blocker}</span>{/if}
  </div>
{/if}

<style>
  .panel { margin: 0 0 10px; padding: 8px 10px; border-left: 3px solid var(--accent); background: var(--surface-2); }
  h4 { margin: 0 0 6px; font-size: 13px; }
  p { margin: 0 0 8px; }
  .warning { color: var(--warn); }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 8px; }
  .select { display: inline-flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
</style>

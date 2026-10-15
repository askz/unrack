<script lang="ts">
  import { device } from "../state/device.svelte.ts";
  import { PRESET_SLOT_COUNT, TONE_FREQS } from "../protocol/commands.ts";
  import Section from "../ui/Section.svelte";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import { TONE_SOURCE_LABELS } from "../ui/labels.ts";
  import { exportPresetFile, importPresetFile } from "../ui/presetFiles.ts";
  import { tuning, TUNING_LOCKED } from "../setup/tuning.svelte.ts";

  const SINE = 3;
  const DEFAULT_TONE_FREQ_INDEX = 17; // 1 kHz

  let storeSlot = $state<number | null>(null);
  let toneArmed = $state(false);
  let toneSource = $state(0);
  let toneFreq = $state(DEFAULT_TONE_FREQ_INDEX);
  let password = $state("");
  let passwordSent = $state(false);

  const slots = Array.from({ length: PRESET_SLOT_COUNT }, (_, i) => i);
  const busy = $derived(!!device.busy);
  const slotLabel = (slot: number) => String(slot + 1).padStart(2, "0");
  const time = (at: number) => new Date(at).toLocaleTimeString();

  function setTone(source: number): void {
    toneSource = source;
    device.testTone(source, toneFreq);
  }
  function setToneFreq(index: number): void {
    toneFreq = index;
    if (toneSource === SINE) device.testTone(SINE, index);
  }
  function sendPassword(): void {
    device.setPassword(password);
    passwordSent = true;
    setTimeout(() => { passwordSent = false; }, 2000);
  }
  function confirmStore(): void {
    if (storeSlot !== null) void device.storePreset(storeSlot);
    storeSlot = null;
  }
</script>

<div class="view">
  <Section title="Device">
    <dl class="facts">
      <dt>Status</dt><dd>{device.connected ? "Connected" : device.connectionError || device.phase}</dd>
      <dt>Product</dt><dd>{device.productName || "—"}</dd>
      <dt>Firmware</dt><dd class="num">{device.info?.firmware || "—"}</dd>
      <dt>Transactions</dt><dd class="num">{device.stats.transactions}</dd>
      <dt>Retries / failures</dt><dd class="num">{device.stats.retries} / {device.stats.failures}</dd>
      <dt>Merged writes</dt><dd class="num">{device.stats.coalesced}</dd>
      <dt>Stray / corrupt replies</dt><dd class="num">{device.stats.strayReports} / {device.stats.badReports}</dd>
      <dt>Last round trip</dt><dd class="num">{device.stats.lastDurationMs.toFixed(1)} ms</dd>
    </dl>
  </Section>

  <Section title="Preset slots">
    {#snippet actions()}
      <span class="faint">Stored on the device · recall replaces the live settings</span>
    {/snippet}
    <div class="slots">
      <table>
        <thead><tr><th>Slot</th><th>Name</th><th></th></tr></thead>
        <tbody>
          {#each slots as slot (slot)}
            <tr class:active={device.activePreset === slot}>
              <td class="num">{slotLabel(slot)}</td>
              <td>{device.presetNames[slot] ?? "—"}{#if device.activePreset === slot}<span class="tag">active{device.modified ? ", edited" : ""}</span>{/if}</td>
              <td class="buttons">
                <button disabled={!device.connected || busy || tuning.lock !== null} title={tuning.lock ?? undefined}
                        onclick={() => device.recallPreset(slot)}>Recall</button>
                <button disabled={!device.connected || busy || tuning.lock !== null} title={tuning.lock ?? undefined}
                        onclick={() => (storeSlot = slot)}>Store</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Section>

  <Section title="Preset files">
    <p class="dim">A file holds every parameter of the live state. Importing applies it as one undoable change and sends only the values that differ.</p>
    <div class="row">
      <button onclick={exportPresetFile}>Export to file…</button>
      <button disabled={busy || tuning.lock !== null} title={tuning.lock ?? undefined} onclick={importPresetFile}>Import from file…</button>
    </div>
  </Section>

  <Section title="Test tone">
    <p class="warning">Test tones play at full level on every routed output. Turn amplifiers down first.</p>
    <label class="row"><input type="checkbox" bind:checked={toneArmed} /> Enable test tones</label>
    <div class="row">
      {#each TONE_SOURCE_LABELS as label, source (label)}
        <button class:primary={toneSource === source} disabled={!device.connected || (source !== 0 && !toneArmed) || tuning.running !== null}
                title={tuning.running ? TUNING_LOCKED : undefined} onclick={() => setTone(source)}>{label}</button>
      {/each}
      <select value={toneFreq} disabled={toneSource !== SINE || tuning.running !== null} aria-label="Sine frequency"
              title={tuning.running ? TUNING_LOCKED : undefined}
              onchange={(event) => setToneFreq(Number(event.currentTarget.value))}>
        {#each TONE_FREQS as hz, index (index)}<option value={index}>{hz >= 1000 ? `${hz / 1000}k` : hz} Hz</option>{/each}
      </select>
    </div>
  </Section>

  <Section title="Front-panel lock password">
    <div class="row">
      <input type="password" inputmode="numeric" maxlength="4" pattern="[0-9]*" placeholder="4 digits" bind:value={password} aria-label="Lock password" />
      <button disabled={!device.connected || !/^\d{4}$/.test(password)} onclick={sendPassword}>Set password</button>
      {#if passwordSent}<span class="dim">Sent</span>{/if}
    </div>
  </Section>

  <Section title="Issue log">
    {#snippet actions()}
      <button class="ghost" disabled={device.issues.length === 0} onclick={() => device.clearIssues()}>Clear</button>
    {/snippet}
    {#if device.issues.length === 0}
      <p class="dim">No issues.</p>
    {:else}
      <ol class="issues">
        {#each [...device.issues].reverse() as issue (issue.at + issue.message)}
          <li><span class="num faint">{time(issue.at)}</span> {issue.message}</li>
        {/each}
      </ol>
    {/if}
  </Section>

  <Section title="About">
    <p class="dim">
      Unrack: open-source control software for rack DSPs (today the t.racks DSP 4x4 Mini Pro), built from observed USB traffic.
      Licensed under the <a href="https://www.gnu.org/licenses/agpl-3.0.html">GNU AGPL-3.0</a>;
      <a href="https://github.com/askz/opendsp-4x4">source code</a>.
      Not affiliated with or endorsed by Thomann.
    </p>
  </Section>
</div>

<ConfirmDialog
  open={storeSlot !== null}
  title="Store preset {storeSlot === null ? '' : slotLabel(storeSlot)}?"
  message="The live settings will overwrite slot {storeSlot === null ? '' : slotLabel(storeSlot)} ({storeSlot === null ? '' : device.presetNames[storeSlot] ?? 'unnamed'}). This cannot be undone."
  confirmLabel="Store"
  danger
  onconfirm={confirmStore}
  oncancel={() => (storeSlot = null)}
/>

<style>
  .view { display: grid; gap: var(--gap); align-content: start; max-width: 1100px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); }
  .facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
  dt { color: var(--text-dim); }
  dd { margin: 0; }
  .slots { max-height: 340px; overflow-y: auto; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; color: var(--text-dim); padding: 4px 6px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--surface); }
  td { padding: 3px 6px; border-bottom: 1px solid var(--line); }
  tr.active td { background: var(--surface-2); }
  tr.active td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
  .tag { margin-left: 8px; font-size: 11px; color: var(--accent); }
  .buttons { text-align: right; white-space: nowrap; }
  .buttons button { height: 24px; padding: 0 8px; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  p { margin: 0 0 10px; }
  .warning { color: var(--warn); }
  .issues { margin: 0; padding: 0; list-style: none; max-height: 240px; overflow-y: auto; display: grid; gap: 4px; }
  a { color: var(--accent); }
</style>

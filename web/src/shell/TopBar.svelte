<script lang="ts">
  import { device } from "../state/device.svelte.ts";
  import { PRESET_SLOT_COUNT } from "../protocol/commands.ts";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import { exportPresetFile, importPresetFile } from "../ui/presetFiles.ts";
  import { PHASE_LABELS } from "./phase.ts";
  import { tuning } from "../setup/tuning.svelte.ts";

  const slots = Array.from({ length: PRESET_SLOT_COUNT }, (_, i) => i);
  let slot = $state(0);
  let confirmStore = $state(false);

  $effect(() => {
    if (device.activePreset >= 0) slot = device.activePreset;
  });

  const busy = $derived(!!device.busy);
  const working = $derived(device.phase === "connecting" || device.phase === "syncing" || busy);
  const slotLabel = (index: number) => `${String(index + 1).padStart(2, "0")} ${device.presetNames[index] ?? ""}`.trim();
  const statusText = $derived(
    device.busy ? `${device.busy}…`
      : device.connected ? (device.simulated ? device.productName : "Connected")
      : device.connectionError || PHASE_LABELS[device.phase],
  );
  const shortcut = typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform) ? "⌘" : "Ctrl+";
</script>

<header class="topbar">
  <div class="brand">Unrack</div>

  <div class="group presets">
    <select bind:value={slot} disabled={!device.connected} aria-label="Preset slot">
      {#each slots as index (index)}<option value={index}>{slotLabel(index)}</option>{/each}
    </select>
    <button class="primary" disabled={!device.connected || busy || tuning.lock !== null} onclick={() => device.recallPreset(slot)}
            title={tuning.lock ?? `Load slot ${slot + 1} (replaces the live settings)`}>Recall</button>
    <button disabled={!device.connected || busy || tuning.lock !== null} onclick={() => (confirmStore = true)}
            title={tuning.lock ?? `Save the live settings into slot ${slot + 1}`}>Store…</button>
    {#if device.modified}<span class="edited" title="The live settings differ from the last recalled or stored preset">edited</span>{/if}
  </div>

  <div class="group">
    <button disabled={!device.undoLabel} onclick={() => device.undo()} title={device.undoLabel ? `Undo ${device.undoLabel} (${shortcut}Z)` : "Nothing to undo"}>Undo</button>
    <button disabled={!device.redoLabel} onclick={() => device.redo()} title={device.redoLabel ? `Redo ${device.redoLabel} (${shortcut}Shift+Z)` : "Nothing to redo"}>Redo</button>
  </div>

  <div class="group">
    <button class:danger={device.allOutputsMuted}
            onclick={() => (device.allOutputsMuted ? device.unmuteAll() : device.muteAll())}
            title={device.allOutputsMuted ? "Unmute the outputs (back to how they were before Mute all)" : "Mute all four outputs"}>
      {device.allOutputsMuted ? "Unmute all" : "Mute all"}
    </button>
  </div>

  <div class="group">
    <button disabled={busy || tuning.lock !== null} onclick={importPresetFile}
            title={tuning.lock ?? "Apply a preset file to the live settings"}>Import…</button>
    <button onclick={exportPresetFile} title="Save the live settings to a file">Export…</button>
  </div>

  <div class="group connection">
    <span class="dot" data-phase={device.phase} class:working></span>
    <span class="status" title={device.info?.firmware ?? statusText}>{statusText}</span>
    {#if device.simulated}
      {#if device.hardwareSupported}
        <button class="primary" disabled={device.phase === "connecting"} onclick={() => device.connect()}>Connect DSP…</button>
      {/if}
    {:else if device.connected || device.phase === "syncing"}
      <button onclick={() => device.disconnect()}>Disconnect</button>
    {:else}
      <button class="primary" disabled={!device.supported || device.phase === "connecting"} onclick={() => device.connect()}>Connect…</button>
    {/if}
  </div>
</header>

<ConfirmDialog
  open={confirmStore}
  title="Store preset {slot + 1}?"
  message="The live settings will overwrite slot {slot + 1} ({device.presetNames[slot] ?? 'unnamed'}). This cannot be undone."
  confirmLabel="Store"
  danger
  onconfirm={() => { confirmStore = false; void device.storePreset(slot); }}
  oncancel={() => (confirmStore = false)}
/>

<style>
  .topbar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px;
    padding: calc(6px + var(--safe-top)) 10px 6px; background: var(--surface); border-bottom: 1px solid var(--line);
  }
  .brand { font-weight: 700; letter-spacing: .02em; margin-right: 4px; }
  .group { display: flex; align-items: center; gap: 4px; }
  .presets select { width: 210px; }
  .edited { font-size: 11px; color: var(--warn); }
  .connection { margin-left: auto; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); flex: none; }
  .dot[data-phase="ready"] { background: var(--ok); }
  .dot[data-phase="lost"] { background: var(--bad); }
  .dot.working { background: var(--warn); }
  .status { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); }
  @media (max-width: 760px) {
    .presets { flex: 1 1 100%; }
    .presets select { flex: 1; width: auto; min-width: 0; }
    .connection { margin-left: 0; flex: 1 1 100%; }
    .status { flex: 1; max-width: none; }
  }
</style>

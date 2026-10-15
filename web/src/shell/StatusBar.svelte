<script lang="ts">
  import { device } from "../state/device.svelte.ts";
  import { ui } from "../state/ui.svelte.ts";
  import { PHASE_LABELS } from "./phase.ts";

  const unsynced = $derived(device.unsynced);
  const undelivered = $derived(unsynced.failed + unsynced.offline);
</script>

<footer class="statusbar">
  <span class="item">{PHASE_LABELS[device.phase]}{device.simulated ? ` · ${device.productName}` : device.info ? ` · ${device.info.firmware}` : ""}</span>
  {#if device.connected}
    <span class="item num" title="Round trip of the last request">{device.stats.lastDurationMs.toFixed(0)} ms</span>
    <span class="item num" title="Requests / retries / failures">{device.stats.transactions} req · {device.stats.retries} retry · {device.stats.failures} fail</span>
  {/if}
  {#if unsynced.pending > 0}<span class="item num">{unsynced.pending} sending</span>{/if}
  {#if undelivered > 0}
    <span class="item warn num">
      {undelivered} not on device
      <button class="ghost small" disabled={!device.connected} onclick={() => device.resendUnsynced()}>Resend</button>
    </span>
  {/if}
  <span class="spacer"></span>
  {#if device.lastIssue}
    <button class="ghost small issue" title={device.lastIssue.message} onclick={() => ui.open("system")}>
      {device.issues.length} issue{device.issues.length === 1 ? "" : "s"}: {device.lastIssue.message}
    </button>
  {/if}
</footer>

<style>
  .statusbar {
    display: flex; align-items: center; gap: 14px; min-height: 24px; padding: 2px 10px calc(2px + var(--safe-bottom));
    background: var(--surface); border-top: 1px solid var(--line); font-size: 11px; color: var(--text-dim);
    overflow: hidden; white-space: nowrap;
  }
  .item { display: inline-flex; align-items: center; gap: 6px; }
  .warn { color: var(--warn); }
  .spacer { flex: 1; }
  .small { height: 20px; padding: 0 6px; font-size: 11px; }
  .issue { color: var(--warn); max-width: 50vw; overflow: hidden; text-overflow: ellipsis; }
</style>

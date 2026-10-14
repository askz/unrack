<script lang="ts">
  // Tab strip: Overview, Setup, the 8 channels (with live level and state badges), System.
  import { device } from "../state/device.svelte.ts";
  import { ui, type View } from "../state/ui.svelte.ts";
  import { CHANNEL_COUNT } from "../state/model.ts";
  import Meter from "../ui/Meter.svelte";

  const views: View[] = ["overview", "setup", ...Array.from({ length: CHANNEL_COUNT }, (_, i) => i), "system"];
  const NAMED_TITLES: Record<Exclude<View, number>, string> = { overview: "Overview", setup: "Setup", system: "System", settings: "Settings" };

  function title(view: View): string {
    return typeof view === "number" ? device.displayName(view) : NAMED_TITLES[view];
  }

  /** Channels with parameters the device did not accept (failed) or never received (offline). */
  const unsyncedChannels = $derived.by(() => {
    const channels = new Set<number>();
    for (const [key, entry] of Object.entries(device.edit.sync)) {
      if (entry.status !== "pending") channels.add(Number(key.split(":")[1]));
    }
    return channels;
  });

  let strip: HTMLDivElement;

  $effect(() => {
    const selected = strip.querySelector<HTMLElement>(`[data-view="${ui.view}"]`);
    selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = views.indexOf(ui.view);
    const next = views[(index + (event.key === "ArrowRight" ? 1 : -1) + views.length) % views.length]!;
    ui.open(next);
    (event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();
  }
</script>

<div class="tabs" role="tablist" aria-label="Views" tabindex="-1" onkeydown={onKeydown} bind:this={strip}>
  {#each views as view (view)}
    {@const channel = typeof view === "number" ? device.ch(view) : null}
    <button
      role="tab"
      class="tab"
      class:channel={channel !== null}
      class:gap={view === 4 || view === "system"}
      aria-selected={ui.view === view}
      tabindex={ui.view === view ? 0 : -1}
      data-view={view}
      style={typeof view === "number" ? `--marker: var(--ch-${view})` : ""}
      onclick={() => ui.open(view)}
    >
      <span class="title">{title(view)}</span>
      {#if channel}
        <span class="badges">
          {#if device.soloed.includes(view as number)}<span class="badge solo" title="Soloed">S</span>{/if}
          {#if channel.mute === true}<span class="badge mute">M</span>{/if}
          {#if channel.polarity}<span class="badge">Ø</span>{/if}
          {#if typeof view === "number" && unsyncedChannels.has(view)}<span class="badge bad" title="Some settings are not on the device">!</span>{/if}
        </span>
        <span class="level"><Meter level={device.meters[view as number] ?? 0} orientation="horizontal" /></span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .tabs {
    display: flex; align-items: stretch; gap: 2px; padding: 0 6px; overflow-x: auto;
    background: var(--surface); border-bottom: 1px solid var(--line); scrollbar-width: thin;
  }
  .tab {
    position: relative; display: grid; grid-template-columns: auto auto; grid-template-rows: 1fr auto; align-items: center;
    column-gap: 6px; height: 40px; padding: 4px 12px 5px; border: 0; border-radius: 0; background: transparent;
    color: var(--text-dim); min-width: 72px;
  }
  .tab.gap { margin-left: 8px; }
  .tab.channel { border-top: 2px solid var(--marker); }
  .tab:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
  .tab[aria-selected="true"] { background: var(--bg); color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
  .title { font-weight: 600; white-space: nowrap; grid-row: 1 / span 2; }
  .tab.channel .title { grid-row: 1; }
  .badges { display: flex; gap: 2px; justify-self: end; }
  .badge { font-size: 10px; font-weight: 700; padding: 0 3px; border-radius: 2px; background: var(--surface-3); color: var(--text-dim); }
  .badge.mute { background: #5e2320; color: #ffd3d0; }
  .badge.solo { background: var(--accent-dim); color: var(--text); }
  .badge.bad { background: var(--bad); color: #fff; }
  .level { grid-column: 1 / span 2; grid-row: 2; }
</style>

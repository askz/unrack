<script lang="ts">
  import { device } from "./state/device.svelte.ts";
  import { ui } from "./state/ui.svelte.ts";
  import TopBar from "./shell/TopBar.svelte";
  import ChannelTabs from "./shell/ChannelTabs.svelte";
  import StatusBar from "./shell/StatusBar.svelte";
  import Overview from "./views/Overview.svelte";
  import InputView from "./views/InputView.svelte";
  import OutputView from "./views/OutputView.svelte";
  import SystemView from "./views/SystemView.svelte";
  import SetupView from "./views/SetupView.svelte";
  import SettingsView from "./views/SettingsView.svelte";
  import Gate from "./esp/Gate.svelte";
  import { bridge } from "./esp/bridge.svelte.ts";
  import { tuning } from "./setup/tuning.svelte.ts";
  import { OUT_BASE } from "./state/model.ts";
  import { settings } from "./state/settings.svelte.ts";
  import { appearanceVars } from "./ui/appearance.ts";

  const SYSTEM_KEY = "9";
  const SETUP_KEY = "s";
  const LIGHT_QUERY = "(prefers-color-scheme: light)";

  let prefersLight = $state(matchMedia(LIGHT_QUERY).matches);

  $effect(() => {
    const query = matchMedia(LIGHT_QUERY);
    const onChange = () => { prefersLight = query.matches; };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  });

  $effect(() => {
    const { theme, vars } = appearanceVars(settings.value, prefersLight);
    const root = document.documentElement;
    root.dataset.theme = theme;
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  });

  function isEditable(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));
  }

  /** Ctrl/⌘+Z undo, Ctrl/⌘+Shift+Z or Ctrl+Y redo, 0 overview, 1–8 channels, 9 system, S setup. */
  function onKeydown(event: KeyboardEvent): void {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey && event.key.toLowerCase() === "z") {
      if (isEditable(event.target) && (event.target as HTMLElement).tagName !== "SELECT") return; // native text undo
      event.preventDefault();
      if (event.shiftKey) device.redo();
      else device.undo();
      return;
    }
    if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      device.redo();
      return;
    }
    if (mod || event.altKey || isEditable(event.target) || document.querySelector("dialog[open]")) return;
    if (event.key === "0") ui.open("overview");
    else if (event.key === SYSTEM_KEY) ui.open("system");
    else if (event.key.toLowerCase() === SETUP_KEY) ui.open("setup");
    else if (/^[1-8]$/.test(event.key)) ui.open(Number(event.key) - 1);
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if bridge.active}<Gate />{/if}
<TopBar />
<ChannelTabs />

<main>
  {#if !device.supported}
    <div class="notice bad">{bridge.active ? "This browser has no WebSocket support." : "This browser cannot reach USB devices. Use Chrome or Edge on a desktop computer, or the Android app."}</div>
  {:else if device.phase === "lost"}
    <div class="notice bad">
      {device.connectionError}.
      {bridge.active ? "Press Connect to take control (only one browser controls the DSP at a time)." : "Plug the DSP back in to reconnect automatically, or press Connect."}
      {#if bridge.active}<button class="ghost" onclick={() => device.connect()}>Take control</button>{/if}
    </div>
  {:else if !device.connected && device.phase !== "syncing"}
    <div class="notice">Offline: edits change this screen only. Connecting loads the device's current settings.</div>
  {/if}

  {#if ui.view !== "setup" && (tuning.running || (tuning.interrupted && device.connected))}
    <div class="notice">
      {tuning.running ? "Fine-tuning is running. Finish or cancel it in Setup." : "A fine-tuning session was interrupted. Restore the outputs in Setup."}
      <button class="ghost" onclick={() => ui.open("setup")}>Open Setup</button>
    </div>
  {/if}

  {#if typeof ui.view === "number" && settings.value.hidden.includes(ui.view)}
    {@const shown = ui.view}
    <div class="notice">
      Hidden: {device.displayName(shown)} is left out of the tabs and the Overview.
      <button class="ghost" onclick={() => settings.update({ hidden: settings.value.hidden.filter((ch) => ch !== shown) })}>Show</button>
    </div>
  {/if}

  {#if ui.view === "setup"}
    <SetupView />
  {:else if ui.view === "system"}
    <SystemView />
  {:else if ui.view === "settings"}
    <SettingsView />
  {:else if typeof ui.view === "number"}
    {#if ui.view < OUT_BASE}
      {#key ui.view}<InputView ch={ui.view} />{/key}
    {:else}
      {#key ui.view}<OutputView ch={ui.view} />{/key}
    {/if}
  {:else}
    <Overview />
  {/if}
</main>

<StatusBar />

<style>
  main { flex: 1; min-height: 0; overflow: auto; padding: var(--gap); display: grid; gap: var(--gap); align-content: start; }
  .notice { max-width: 1100px; padding: 6px 10px; border: 1px solid var(--line-strong); border-left: 3px solid var(--warn); border-radius: var(--radius); background: var(--surface); color: var(--text-dim); }
  .notice.bad { border-left-color: var(--bad); }
</style>

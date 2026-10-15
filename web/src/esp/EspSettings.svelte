<script lang="ts">
  // Settings of the ESP32 bridge itself (only in the ESP32 build): Wi-Fi, the access point,
  // the login password, the API token, firmware and web UI updates.
  import { onMount } from "svelte";
  import Section from "../ui/Section.svelte";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import { bridge } from "./bridge.svelte.ts";
  import {
    AP_PASSWORD_LIMITS, LOGIN_PASSWORD_LIMITS, describeError, passwordProblem, uploadImage, waitForBridge,
    type BridgeHealth, type ScannedNetwork, type WifiStatus,
  } from "./api.ts";

  const POLL_MS = 2000;
  const REBOOT_WAIT_MS = 60000;
  const UI_UPLOAD_WAIT_MS = 5000;

  // ---------------------------------------------------------------- status
  let wifi = $state<WifiStatus | null>(null);
  let health = $state<BridgeHealth | null>(null);

  async function poll(): Promise<void> {
    try {
      [wifi, health] = await Promise.all([bridge.call<WifiStatus>("/api/wifi"), bridge.call<BridgeHealth>("/api/health")]);
    } catch { /* the login screen or the next poll handles it */ }
  }

  onMount(() => {
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  });

  /** Run a settings action and show its outcome next to the control that started it. */
  async function attempt(slot: { busy: boolean; message: string; failed: boolean }, action: () => Promise<string>): Promise<void> {
    slot.busy = true;
    slot.message = "";
    slot.failed = false;
    try {
      slot.message = await action();
    } catch (error) {
      slot.message = describeError(error);
      slot.failed = true;
    } finally {
      slot.busy = false;
    }
  }

  // ----------------------------------------------------------------- Wi-Fi
  const join = $state({ busy: false, message: "", failed: false });
  const scan = $state({ busy: false, message: "", failed: false });
  let networks = $state<ScannedNetwork[]>([]);
  let ssid = $state("");
  let networkPassword = $state("");
  let confirmForget = $state(false);

  const stationText = $derived.by(() => {
    const station = wifi?.station;
    if (!station) return "Loading…";
    switch (station.state) {
      case "connected": return `Connected to ${station.ssid}, ${station.ip}${station.rssi !== undefined ? ` (${station.rssi} dBm)` : ""}`;
      case "connecting": return `Connecting to ${station.ssid}…`;
      case "failed": return `Could not join ${station.ssid}${station.error ? `: ${station.error}` : ""}`;
      default: return "No home network registered";
    }
  });

  const scanNetworks = () => attempt(scan, async () => {
    networks = (await bridge.call<{ networks: ScannedNetwork[] }>("/api/wifi/scan")).networks;
    return networks.length === 0 ? "No networks found." : "";
  });

  const joinNetwork = () => attempt(join, async () => {
    wifi = await bridge.call<WifiStatus>("/api/wifi", "POST", { ssid, password: networkPassword });
    networkPassword = "";
    return "Joining. When it works, the ESP32's own network switches off after a few seconds: continue at the address shown above or at http://opendsp.local on that network.";
  });

  const forgetNetwork = () => attempt(join, async () => {
    confirmForget = false;
    wifi = await bridge.call<WifiStatus>("/api/wifi", "DELETE");
    return "Home network forgotten. The ESP32's own network stays on.";
  });

  // ------------------------------------------------------- access point
  const ap = $state({ busy: false, message: "", failed: false });
  let apPassword = $state("");
  let apConfirm = $state("");
  const apProblem = $derived(apPassword === "" ? "" : passwordProblem(apPassword, apConfirm, AP_PASSWORD_LIMITS));

  const saveAp = () => attempt(ap, async () => {
    await bridge.call("/api/wifi/ap", "POST", { password: apPassword });
    apPassword = apConfirm = "";
    return "Saved. Devices connected to the ESP32's network must rejoin with the new password.";
  });

  // ------------------------------------------------------------- login
  const login = $state({ busy: false, message: "", failed: false });
  let currentPassword = $state("");
  let newPassword = $state("");
  let newConfirm = $state("");
  const loginProblem = $derived(newPassword === "" ? "" : passwordProblem(newPassword, newConfirm, LOGIN_PASSWORD_LIMITS));

  const savePassword = () => attempt(login, async () => {
    await bridge.changePassword(currentPassword, newPassword);
    currentPassword = newPassword = newConfirm = "";
    return "Password changed. Other browsers were logged out.";
  });

  // ------------------------------------------------------------- token
  const token = $state({ busy: false, message: "", failed: false });
  let newToken = $state("");

  const makeToken = () => attempt(token, async () => {
    newToken = (await bridge.call<{ token: string }>("/api/auth/token", "POST", {})).token;
    await bridge.refresh();
    return "Copy it now: it is not shown again. Any older token stopped working.";
  });

  // ----------------------------------------------------------- updates
  const update = $state({ busy: false, message: "", failed: false });
  let progress = $state(0);
  let confirmReboot = $state(false);

  async function pickFile(kind: "firmware" | "ui", event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    await attempt(update, async () => {
      progress = 0;
      await uploadImage(`/api/update/${kind}`, file, (fraction) => { progress = fraction; });
      if (kind === "ui") {
        await new Promise((resolve) => setTimeout(resolve, UI_UPLOAD_WAIT_MS));
        location.reload();
        return "Web UI updated. Reloading…";
      }
      update.message = "Firmware installed. The ESP32 is restarting…";
      await waitForBridge(REBOOT_WAIT_MS);
      location.reload();
      return "Restarted. Reloading…";
    });
    progress = 0;
  }

  const reboot = () => attempt(update, async () => {
    confirmReboot = false;
    await bridge.call("/api/reboot", "POST", {});
    update.message = "Restarting…";
    await waitForBridge(REBOOT_WAIT_MS);
    location.reload();
    return "Restarted. Reloading…";
  });

  const logout = () => attempt(login, async () => {
    await bridge.logout();
    return "";
  });

  const uptime = (seconds: number) => {
    const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
    return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
  };
</script>

<Section title="Wi-Fi" class="wide">
  <div class="rows">
    <span>Home network</span>
    <span>{stationText}</span>
    <span>Own network</span>
    <span>
      {#if wifi}
        {wifi.ap.on ? `${wifi.ap.ssid}, ${wifi.ap.clients} connected` : "Off (a home network is joined)"}
      {:else}Loading…{/if}
    </span>
    <span>Address</span>
    <span class="num">http://{wifi?.hostname ?? "opendsp.local"}{wifi?.station.ip ? ` or http://${wifi.station.ip}` : " or http://192.168.4.1"}</span>
  </div>

  <form class="stack" onsubmit={(event) => { event.preventDefault(); void joinNetwork(); }}>
    <div class="inline">
      <button type="button" disabled={scan.busy} onclick={scanNetworks}>{scan.busy ? "Scanning…" : "Scan"}</button>
      <input type="text" list="espNetworks" placeholder="Network name" maxlength="32" bind:value={ssid} aria-label="Network name" autocomplete="off" />
      <datalist id="espNetworks">
        {#each networks as network (network.ssid)}<option value={network.ssid}>{network.ssid}{network.open ? " (open)" : ""} {network.rssi} dBm</option>{/each}
      </datalist>
      <input type="password" placeholder="Password (empty for an open network)" maxlength="63" bind:value={networkPassword}
             aria-label="Network password" autocomplete="off" />
      <button class="primary" disabled={join.busy || ssid === ""}>{join.busy ? "Saving…" : "Join"}</button>
      {#if wifi?.station.configured}
        <button type="button" class="danger" disabled={join.busy} onclick={() => (confirmForget = true)}>Forget…</button>
      {/if}
    </div>
    {#if scan.message}<p class:bad={scan.failed} class="note">{scan.message}</p>{/if}
    {#if join.message}<p class:bad={join.failed} class="note">{join.message}</p>{/if}
  </form>
  <p class="faint">Joining a network switches the ESP32's own network off after a few seconds. If the home network is lost for 30 seconds it comes back, so the ESP32 stays reachable.</p>
</Section>

<Section title="Own network (access point)">
  <form class="stack" onsubmit={(event) => { event.preventDefault(); void saveAp(); }}>
    <div class="rows">
      <span>New password</span>
      <input type="password" bind:value={apPassword} autocomplete="new-password" maxlength="63" aria-label="New access point password" />
      <span>Repeat it</span>
      <input type="password" bind:value={apConfirm} autocomplete="new-password" maxlength="63" aria-label="Repeat the access point password" />
    </div>
    {#if apProblem}<p class="note warn">{apProblem}</p>{/if}
    <div class="inline">
      <button class="primary" disabled={ap.busy || apPassword === "" || apProblem !== ""}>Change password</button>
    </div>
    {#if ap.message}<p class:bad={ap.failed} class="note">{ap.message}</p>{/if}
  </form>
  <p class="faint">The password of the {wifi?.ap.ssid ?? "openDSP-XXXX"} network (WPA2, 8 to 63 characters).</p>
</Section>

<Section title="Login">
  <form class="stack" onsubmit={(event) => { event.preventDefault(); void savePassword(); }}>
    <div class="rows">
      <span>Current password</span>
      <input type="password" bind:value={currentPassword} autocomplete="current-password" aria-label="Current password" />
      <span>New password</span>
      <input type="password" bind:value={newPassword} autocomplete="new-password" aria-label="New password" />
      <span>Repeat it</span>
      <input type="password" bind:value={newConfirm} autocomplete="new-password" aria-label="Repeat the new password" />
    </div>
    {#if loginProblem}<p class="note warn">{loginProblem}</p>{/if}
    <div class="inline">
      <button class="primary" disabled={login.busy || currentPassword === "" || newPassword === "" || loginProblem !== ""}>Change password</button>
      <button type="button" disabled={login.busy} onclick={logout}>Log out</button>
    </div>
    {#if login.message}<p class:bad={login.failed} class="note">{login.message}</p>{/if}
  </form>

  <div class="stack">
    <div class="inline">
      <button disabled={token.busy} onclick={makeToken}>{bridge.session?.tokenSet ? "Replace API token" : "Create API token"}</button>
      <span class="faint">{bridge.session?.tokenSet ? "A token is set." : "No token yet."} For scripts: <span class="num">Authorization: Bearer …</span></span>
    </div>
    {#if newToken}<p class="note"><input class="token num" readonly value={newToken} aria-label="New API token" onfocus={(event) => event.currentTarget.select()} /></p>{/if}
    {#if token.message}<p class:bad={token.failed} class="note">{token.message}</p>{/if}
  </div>
</Section>

<Section title="Device and updates">
  <div class="rows">
    <span>Firmware</span><span class="num">{health?.firmware ?? "…"}{health ? ` (slot ${health.otaSlot})` : ""}</span>
    <span>Web UI</span><span class="num">{health ? (health.uiInstalled ? health.ui : "not installed") : "…"}</span>
    <span>Uptime</span><span>{health ? `${uptime(health.uptimeSeconds)}, last reset: ${health.resetReason}` : "…"}</span>
    <span>Free memory</span><span class="num">{health ? `${Math.round(health.heap.free / 1024)} KiB` : "…"}</span>
  </div>

  <div class="stack">
    <div class="inline">
      <label class="file">
        <span class="button">Upload firmware…</span>
        <input type="file" accept=".bin" disabled={update.busy} onchange={(event) => pickFile("firmware", event)} />
      </label>
      <label class="file">
        <span class="button">Upload web UI…</span>
        <input type="file" accept=".bin" disabled={update.busy} onchange={(event) => pickFile("ui", event)} />
      </label>
      <button class="danger" disabled={update.busy} onclick={() => (confirmReboot = true)}>Restart…</button>
    </div>
    {#if update.busy && progress > 0 && progress < 1}<progress value={progress} max="1"></progress>{/if}
    {#if update.message}<p class:bad={update.failed} class="note">{update.message}</p>{/if}
  </div>
  <p class="faint">Firmware is <span class="num">opendsp-bridge.bin</span>, the web UI is <span class="num">www.bin</span> (both from the firmware build). A new firmware starts on the next boot and rolls back by itself if it does not come up healthy. Do not unplug the ESP32 during an upload.</p>
</Section>

<ConfirmDialog
  open={confirmForget}
  title="Forget the home network?"
  message="The ESP32 will only be reachable through its own network until you register one again."
  confirmLabel="Forget"
  danger
  onconfirm={forgetNetwork}
  oncancel={() => (confirmForget = false)}
/>

<ConfirmDialog
  open={confirmReboot}
  title="Restart the ESP32?"
  message="Control is interrupted for about 15 seconds. The DSP keeps its settings."
  confirmLabel="Restart"
  danger
  onconfirm={reboot}
  oncancel={() => (confirmReboot = false)}
/>

<style>
  .rows { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; align-items: center; }
  .rows > span:nth-child(odd) { color: var(--text-dim); }
  .rows input { max-width: 260px; }
  .inline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .stack { display: grid; gap: 8px; margin-top: 10px; }
  .note { margin: 0; color: var(--text-dim); }
  .note.bad, .bad { color: var(--bad-text); }
  .note.warn { color: var(--warn); }
  p.faint { margin: 10px 0 0; }
  .token { width: 100%; max-width: 380px; }
  progress { width: 100%; max-width: 380px; }
  .file { position: relative; display: inline-block; }
  .file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; }
  .file input:disabled { cursor: default; }
  .button {
    display: inline-flex; align-items: center; height: var(--control-h); padding: 0 9px;
    background: var(--surface-2); border: 1px solid var(--line-strong); border-radius: var(--radius);
  }
  .file:hover .button { background: var(--surface-3); }
</style>

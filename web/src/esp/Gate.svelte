<script lang="ts">
  // Full-screen login for the ESP32 build. Shown while there is no session, and again
  // while the default password still has to be replaced (the firmware refuses
  // everything else until then).
  import { bridge } from "./bridge.svelte.ts";
  import { LOGIN_PASSWORD_LIMITS, describeError, passwordProblem } from "./api.ts";

  let password = $state("");
  let current = $state(bridge.rememberedPassword);
  let replacement = $state("");
  let confirm = $state("");
  let error = $state("");
  let busy = $state(false);

  const mustChange = $derived(bridge.mustChangePassword);
  const problem = $derived(mustChange && replacement !== "" ? passwordProblem(replacement, confirm, LOGIN_PASSWORD_LIMITS) : "");

  $effect(() => {
    if (mustChange && current === "") current = bridge.rememberedPassword;
  });

  async function run(action: () => Promise<void>): Promise<void> {
    busy = true;
    error = "";
    try {
      await action();
      password = replacement = confirm = "";
    } catch (failure) {
      error = describeError(failure);
    } finally {
      busy = false;
    }
  }

  const login = (event: SubmitEvent) => { event.preventDefault(); void run(() => bridge.login(password)); };
  const change = (event: SubmitEvent) => {
    event.preventDefault();
    const issue = passwordProblem(replacement, confirm, LOGIN_PASSWORD_LIMITS);
    if (issue) { error = issue; return; }
    void run(() => bridge.changePassword(current, replacement));
  };
</script>

{#if bridge.needsLogin}
  <div class="gate" role="dialog" aria-modal="true" aria-label={mustChange ? "Set a password" : "Log in"}>
    {#if mustChange}
      <form onsubmit={change}>
        <h1>Set your own password</h1>
        <p class="dim">The ESP32 still uses its default password. Choose a new one to continue; you will be logged in again.</p>
        <label>Current password<input type="password" bind:value={current} autocomplete="current-password" required /></label>
        <label>New password<input type="password" bind:value={replacement} autocomplete="new-password" required /></label>
        <label>Repeat it<input type="password" bind:value={confirm} autocomplete="new-password" required /></label>
        {#if problem}<p class="warn">{problem}</p>{/if}
        {#if error}<p class="bad">{error}</p>{/if}
        <button class="primary" disabled={busy || problem !== ""}>Set password</button>
      </form>
    {:else}
      <form onsubmit={login}>
        <h1>openDSP bridge</h1>
        {#if bridge.unreachable}<p class="bad">{bridge.unreachable}</p>{/if}
        <label>Password<input type="password" bind:value={password} autocomplete="current-password" required /></label>
        {#if error}<p class="bad">{error}</p>{/if}
        <button class="primary" disabled={busy || password === ""}>Log in</button>
        <p class="faint">First start: the password is <span class="num">opendsp-setup</span>.</p>
      </form>
    {/if}
  </div>
{/if}

<style>
  .gate { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; background: var(--bg); padding: var(--gap); }
  form { display: grid; gap: 10px; width: min(100%, 360px); padding: 18px; background: var(--surface); border: 1px solid var(--line-strong); border-radius: var(--radius); }
  h1 { margin: 0; font-size: 15px; }
  p { margin: 0; }
  label { display: grid; gap: 3px; color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  input { text-transform: none; letter-spacing: normal; font-size: 13px; }
  .bad { color: var(--bad-text); }
  .warn { color: var(--warn); }
</style>

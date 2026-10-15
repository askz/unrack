// Session state of the ESP32 bridge for the UI: whether we are logged in, whether the
// default password still has to be replaced, and the calls that need the session.
import { device } from "../state/device.svelte.ts";
import { EspApiError, espRequest, fetchSession, isEspTarget, type EspSession } from "./api.ts";

export class BridgeStore {
  /** True when this page is served by the ESP32 (VITE_TARGET=esp). */
  readonly active = isEspTarget();
  loaded = $state(false);
  session = $state<EspSession | null>(null);
  /** Why the last session check failed (the ESP32 is unreachable). */
  unreachable = $state("");
  private loginPassword = "";

  get needsLogin(): boolean {
    return this.active && this.loaded && (!this.session?.authenticated || this.session.passwordChangeRequired);
  }

  get mustChangePassword(): boolean {
    return !!this.session?.authenticated && this.session.passwordChangeRequired;
  }

  /** Load the session, then bind the DSP when we are fully logged in. */
  async start(): Promise<void> {
    await this.refresh();
    if (!this.needsLogin) void device.autoConnect();
  }

  async refresh(): Promise<void> {
    try {
      this.session = await fetchSession();
      this.unreachable = "";
    } catch (error) {
      this.unreachable = error instanceof Error ? error.message : String(error);
    }
    this.loaded = true;
  }

  async login(password: string): Promise<void> {
    await espRequest("/api/login", "POST", { password });
    this.loginPassword = password;
    await this.refresh();
    if (!this.needsLogin) void device.autoConnect();
  }

  /** The password typed at login, kept until it has been replaced (prefills the forced change). */
  get rememberedPassword(): string {
    return this.loginPassword;
  }

  async changePassword(current: string, replacement: string): Promise<void> {
    await espRequest("/api/auth/password", "POST", { old: current, new: replacement });
    this.loginPassword = "";
    await this.login(replacement); // the firmware ends every session on a password change
  }

  async logout(): Promise<void> {
    await espRequest("/api/logout", "POST", {});
    await device.disconnect();
    await this.refresh();
  }

  /** A call that needs the session: an expired session sends the user back to the login screen. */
  async call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    try {
      return await espRequest<T>(path, method, body);
    } catch (error) {
      if (error instanceof EspApiError && error.status === 401) await this.refresh();
      throw error;
    }
  }
}

export const bridge = new BridgeStore();

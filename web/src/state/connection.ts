// Connection lifecycle: open a link, identify the device, let the session read
// its state, then run until the device goes away or stops answering.
//
//   idle ──connect──▶ connecting ──▶ syncing ──▶ ready ──resync──▶ syncing ──▶ ready
//                         │             │          │
//                         └── error ────┴──────────┴── unplugged / unresponsive ──▶ lost
//
// "lost" (and "idle", unless the user disconnected on purpose) re-binds
// automatically when a granted device is plugged back in.
import type { HidLink } from "../transport/link.ts";
import type { LinkProvider } from "../transport/platform.ts";
import { RequestChannel, ProtocolError, emptyStats, type ChannelStats, type Transaction } from "../transport/channel.ts";
import { Dsp, type DeviceInfo } from "../dsp.ts";

export type ConnectionPhase = "unsupported" | "idle" | "connecting" | "syncing" | "ready" | "lost";
export type SyncReason = "connect" | "resync";

export interface ConnectionSnapshot {
  phase: ConnectionPhase;
  error: string;
  productName: string;
  info: DeviceInfo | null;
  stats: ChannelStats;
}

export interface SessionHooks {
  /** Read device state into the model (phase is "syncing" while this runs). */
  sync(dsp: Dsp, reason: SyncReason): Promise<void>;
  /** The session is ready for live traffic (start meter polling). */
  started(dsp: Dsp): void;
  /** The session has ended, for any reason. */
  ended(): void;
}

/** Consecutive timed-out transactions after which a ready device counts as lost. */
const MAX_CONSECUTIVE_TIMEOUTS = 4;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class Connection {
  private readonly provider: LinkProvider;
  private readonly hooks: SessionHooks;
  private readonly listeners = new Set<(snapshot: ConnectionSnapshot) => void>();
  private state: ConnectionSnapshot;
  private generation = 0;
  private link: HidLink | null = null;
  private channel: RequestChannel | null = null;
  private client: Dsp | null = null;
  private sessionCleanup: (() => void)[] = [];
  private stopWatchingAttach: (() => void) | null = null;
  private userDisconnected = false;
  private consecutiveTimeouts = 0;

  constructor(provider: LinkProvider, hooks: SessionHooks) {
    this.provider = provider;
    this.hooks = hooks;
    this.state = {
      phase: provider.supported() ? "idle" : "unsupported",
      error: "",
      productName: "",
      info: null,
      stats: emptyStats(),
    };
  }

  get snapshot(): ConnectionSnapshot {
    return this.state;
  }

  /** The client for the current session (null when no device is bound). */
  get dsp(): Dsp | null {
    return this.client;
  }

  onChange(listener: (snapshot: ConnectionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Pick/grant a device and bind it. On desktop this must run inside a user gesture. */
  async connect(): Promise<void> {
    if (this.state.phase === "unsupported") return;
    this.userDisconnected = false;
    this.watchAttach();
    let link: HidLink | null;
    try {
      link = await this.provider.pick();
    } catch (error) {
      this.update({ error: messageOf(error) });
      return;
    }
    if (link) await this.bind(link);
  }

  /** Bind an already-granted device without prompting, and auto-bind future plug-ins. */
  async autoConnect(): Promise<void> {
    if (this.state.phase === "unsupported") return;
    this.watchAttach();
    try {
      const link = await this.provider.existing();
      if (link) await this.bind(link);
    } catch (error) {
      this.update({ error: messageOf(error) });
    }
  }

  async disconnect(): Promise<void> {
    this.userDisconnected = true;
    this.generation++;
    await this.endSession();
    this.update({ phase: "idle", error: "" });
  }

  /** Re-read the device state (after a preset recall, or on demand). */
  async resync(): Promise<void> {
    const dsp = this.client;
    if (!dsp || this.state.phase !== "ready") return;
    const session = this.generation;
    this.update({ phase: "syncing" });
    try {
      await this.hooks.sync(dsp, "resync");
      if (session === this.generation) this.update({ phase: "ready", error: "" });
    } catch (error) {
      if (session !== this.generation || (error instanceof ProtocolError && error.kind === "closed")) return;
      this.update({ phase: "ready", error: `Resync failed: ${messageOf(error)}` });
    }
  }

  /** Stop watching for plug-ins and end any session. */
  async dispose(): Promise<void> {
    this.stopWatchingAttach?.();
    this.stopWatchingAttach = null;
    this.generation++;
    await this.endSession();
  }

  private watchAttach(): void {
    if (this.stopWatchingAttach) return;
    this.stopWatchingAttach = this.provider.onAttach((link) => {
      const { phase } = this.state;
      if (this.userDisconnected || (phase !== "idle" && phase !== "lost")) return;
      void this.bind(link);
    });
  }

  private async bind(link: HidLink): Promise<void> {
    const session = ++this.generation;
    await this.endSession();
    this.consecutiveTimeouts = 0;
    this.update({ phase: "connecting", error: "", info: null, stats: emptyStats() });
    try {
      await link.open();
      if (session !== this.generation) {
        await link.close();
        return;
      }
      const channel = new RequestChannel(link);
      const dsp = new Dsp(channel);
      this.link = link;
      this.channel = channel;
      this.client = dsp;
      this.sessionCleanup = [
        link.onDisconnect((reason) => void this.lose(session, reason ?? "Device disconnected")),
        channel.onTransaction((transaction) => this.observe(session, transaction)),
      ];

      const info = await dsp.identify();
      if (session !== this.generation) return;
      this.update({ phase: "syncing", info, productName: link.productName });
      await this.hooks.sync(dsp, "connect");
      await dsp.finalize();
      if (session !== this.generation) return;
      this.update({ phase: "ready" });
      this.hooks.started(dsp);
    } catch (error) {
      if (session !== this.generation) return;
      this.generation++;
      await this.endSession();
      this.update({ phase: "idle", error: `Connection failed: ${messageOf(error)}` });
    }
  }

  private async lose(session: number, reason: string): Promise<void> {
    if (session !== this.generation) return;
    this.generation++;
    await this.endSession();
    this.update({ phase: "lost", error: reason });
  }

  private observe(session: number, transaction: Transaction): void {
    if (session !== this.generation || !this.channel) return;
    this.consecutiveTimeouts = transaction.error === "timeout" ? this.consecutiveTimeouts + 1 : 0;
    this.update({ stats: { ...this.channel.stats } });
    if (this.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS && this.state.phase === "ready") {
      void this.lose(session, "Device stopped responding");
    }
  }

  private async endSession(): Promise<void> {
    const link = this.link;
    const hadSession = this.client !== null;
    for (const cleanup of this.sessionCleanup) cleanup();
    this.sessionCleanup = [];
    this.channel?.close("session ended");
    this.link = null;
    this.channel = null;
    this.client = null;
    if (hadSession) this.hooks.ended();
    if (link) await link.close().catch(() => undefined);
  }

  private update(patch: Partial<ConnectionSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}

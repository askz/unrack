// One-transaction-at-a-time request engine over a HidLink.
//
// The device silently drops a frame sent while it is still busy, and a reply can
// arrive after its attempt timed out, so each request waits for the reply that
// matches it (reply code, plus the echoed index for indexed queries); any other
// report is counted as a stray and ignored. User actions (control lane) always go
// before meter polls (background lane), and queued requests sharing a coalesce key
// collapse into the latest frame, so a fader drag never builds a backlog.
import type { HidLink } from "./link.ts";
import { requestCode, tryParseReply, type Reply } from "../protocol/frame.ts";
import { ReplyCode, commandName } from "../protocol/commands.ts";
import { replyMatcher, replyTimeoutMs } from "../protocol/exchange.ts";

export type Lane = "control" | "background";
export type ProtocolErrorKind = "timeout" | "rejected" | "closed" | "io";

export class ProtocolError extends Error {
  readonly kind: ProtocolErrorKind;

  constructor(kind: ProtocolErrorKind, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.kind = kind;
  }
}

export interface RequestOptions {
  lane?: Lane;
  /** Queued requests with the same key collapse: only the latest frame is sent, every caller gets its reply. */
  coalesceKey?: string;
  timeoutMs?: number;
  attempts?: number;
}

export interface Transaction {
  code: number;
  attempts: number;
  durationMs: number;
  error?: ProtocolErrorKind;
}

export interface ChannelStats {
  transactions: number;
  failures: number;
  retries: number;
  coalesced: number;
  strayReports: number;
  badReports: number;
  lastDurationMs: number;
}

export function emptyStats(): ChannelStats {
  return { transactions: 0, failures: 0, retries: 0, coalesced: 0, strayReports: 0, badReports: 0, lastDurationMs: 0 };
}

interface Waiter {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
}

interface PendingRequest {
  frame: Uint8Array;
  code: number;
  coalesceKey?: string;
  timeoutMs: number;
  attempts: number;
  waiters: Waiter[];
}

interface Attempt {
  name: string;
  matches: (reply: Reply) => boolean;
  finish: (outcome: Reply | ProtocolError) => void;
}

const DEFAULT_ATTEMPTS = 3;
const LANES: readonly Lane[] = ["control", "background"];

export class RequestChannel {
  readonly stats: ChannelStats = emptyStats();
  private readonly link: HidLink;
  private readonly queues: Record<Lane, PendingRequest[]> = { control: [], background: [] };
  private readonly transactionListeners = new Set<(transaction: Transaction) => void>();
  private readonly unsubscribeReports: () => void;
  private current: Attempt | null = null;
  private pumping = false;
  private closedError: ProtocolError | null = null;

  constructor(link: HidLink) {
    this.link = link;
    this.unsubscribeReports = link.onReport((report) => this.handleReport(report));
  }

  get closed(): boolean {
    return this.closedError !== null;
  }

  request(frame: Uint8Array, options: RequestOptions = {}): Promise<Reply> {
    if (this.closedError) return Promise.reject(this.closedError);
    const queue = this.queues[options.lane ?? "control"];
    return new Promise<Reply>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      const queued = options.coalesceKey === undefined
        ? undefined
        : queue.find((pending) => pending.coalesceKey === options.coalesceKey);
      if (queued) {
        queued.frame = frame;
        queued.waiters.push(waiter);
        this.stats.coalesced++;
        return;
      }
      const code = requestCode(frame);
      queue.push({
        frame,
        code,
        coalesceKey: options.coalesceKey,
        timeoutMs: (options.timeoutMs ?? replyTimeoutMs(code)) + (this.link.timeoutSlackMs ?? 0),
        attempts: options.attempts ?? DEFAULT_ATTEMPTS,
        waiters: [waiter],
      });
      void this.pump();
    });
  }

  onTransaction(listener: (transaction: Transaction) => void): () => void {
    this.transactionListeners.add(listener);
    return () => this.transactionListeners.delete(listener);
  }

  /** Reject everything queued or in flight and stop listening to the link. Idempotent. */
  close(reason = "connection closed"): void {
    if (this.closedError) return;
    const error = new ProtocolError("closed", reason);
    this.closedError = error;
    this.unsubscribeReports();
    this.current?.finish(error);
    for (const lane of LANES) {
      for (const pending of this.queues[lane].splice(0)) {
        for (const waiter of pending.waiters) waiter.reject(error);
      }
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let next = this.dequeue(); next; next = this.dequeue()) await this.execute(next);
    } finally {
      this.pumping = false;
    }
  }

  private dequeue(): PendingRequest | undefined {
    if (this.closedError) return undefined;
    return this.queues.control.shift() ?? this.queues.background.shift();
  }

  private async execute(pending: PendingRequest): Promise<void> {
    const started = performance.now();
    let attempts = 0;
    let outcome: Reply | ProtocolError;
    do {
      attempts++;
      outcome = await this.attempt(pending);
    } while (
      outcome instanceof ProtocolError && outcome.kind === "timeout"
      && attempts < pending.attempts && !this.closedError
    );
    const durationMs = performance.now() - started;
    const failed = outcome instanceof ProtocolError;

    this.stats.transactions++;
    this.stats.retries += attempts - 1;
    this.stats.lastDurationMs = durationMs;
    if (failed) this.stats.failures++;

    for (const waiter of pending.waiters) {
      if (outcome instanceof ProtocolError) waiter.reject(outcome);
      else waiter.resolve(outcome);
    }
    const transaction: Transaction = {
      code: pending.code,
      attempts,
      durationMs,
      error: outcome instanceof ProtocolError ? outcome.kind : undefined,
    };
    for (const listener of this.transactionListeners) listener(transaction);
  }

  private attempt(pending: PendingRequest): Promise<Reply | ProtocolError> {
    const name = commandName(pending.code);
    return new Promise((settle) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: Reply | ProtocolError): void => {
        if (this.current !== attempt) return;
        this.current = null;
        clearTimeout(timer);
        settle(outcome);
      };
      const attempt: Attempt = { name, matches: replyMatcher(pending.frame), finish };
      this.current = attempt;
      timer = setTimeout(
        () => finish(new ProtocolError("timeout", `${name}: no reply within ${pending.timeoutMs} ms`)),
        pending.timeoutMs,
      );
      this.link.write(pending.frame).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        finish(new ProtocolError("io", `${name}: write failed (${detail})`));
      });
    });
  }

  private handleReport(report: Uint8Array): void {
    const reply = tryParseReply(report);
    if (!reply) {
      this.stats.badReports++;
      return;
    }
    const attempt = this.current;
    if (attempt?.matches(reply)) attempt.finish(reply);
    else if (attempt && reply.code === ReplyCode.NAK) attempt.finish(new ProtocolError("rejected", `${attempt.name}: rejected by the device`));
    else this.stats.strayReports++;
  }
}

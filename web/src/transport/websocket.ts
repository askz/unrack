// WebSocket link to the ESP32 bridge. Binary messages are the raw 64-byte HID
// reports, byte for byte what WebHID would carry. Text messages are JSON control
// events from the bridge:
//   {"type":"hello","usb":bool,"version":"…","fw":"…"}  first message after connect
//   {"type":"usb","connected":bool}                      DSP attached/detached on the ESP
//   {"type":"evicted"}                                   another browser took control
import type { HidLink } from "./link.ts";
import { REPORT_SIZE } from "./link.ts";

/** The subset of the WebSocket API used here (the browser and Node 22 both provide it). */
export interface WsSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

export type WsFactory = (url: string) => WsSocket;

const OPEN_TIMEOUT_MS = 8000;
/** Reply time added for the network hop and the bridge's own queue. */
const NETWORK_SLACK_MS = 250;
const READY_STATE_OPEN = 1;

const MESSAGES = {
  noDsp: "The DSP is not connected to the ESP32 (check the USB cable)",
  unplugged: "The DSP was unplugged from the ESP32",
  evicted: "Another browser took control of the DSP",
  closed: "Connection to the ESP32 closed",
} as const;

interface MessageLike { data: unknown }

export class WsLink implements HidLink {
  readonly productName = "DSP 4x4 Mini Pro (Wi-Fi)";
  readonly timeoutSlackMs = NETWORK_SLACK_MS;
  /** Firmware version reported by the bridge, once open. */
  bridgeFirmware = "";

  private readonly url: string;
  private readonly createSocket: WsFactory;
  private socket: WsSocket | null = null;
  private ended = false;
  private readonly reportListeners = new Set<(report: Uint8Array) => void>();
  private readonly disconnectListeners = new Set<(reason?: string) => void>();

  constructor(url: string, createSocket: WsFactory = (target) => new WebSocket(target) as unknown as WsSocket) {
    this.url = url;
    this.createSocket = createSocket;
  }

  open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket?.close();
        this.socket = null;
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error("Timed out connecting to the ESP32")), OPEN_TIMEOUT_MS);

      const socket = this.createSocket(this.url);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      this.ended = false;

      socket.addEventListener("error", () => fail(new Error("Could not reach the ESP32 (are you logged in?)")));
      socket.addEventListener("close", () => {
        if (!settled) fail(new Error("The ESP32 refused the connection (log in first)"));
        else this.end(MESSAGES.closed);
      });
      socket.addEventListener("message", ((event: MessageLike) => {
        const handled = this.handleMessage(event.data, settled ? undefined : { resolve, fail });
        if (handled === "open") {
          settled = true;
          clearTimeout(timer);
        }
      }) as (event: never) => void);
    });
  }

  async close(): Promise<void> {
    this.ended = true;
    this.socket?.close();
    this.socket = null;
  }

  async write(report: Uint8Array): Promise<void> {
    if (!this.socket || this.socket.readyState !== READY_STATE_OPEN) throw new Error("not connected to the ESP32");
    this.socket.send(report);
  }

  onReport(listener: (report: Uint8Array) => void): () => void {
    this.reportListeners.add(listener);
    return () => this.reportListeners.delete(listener);
  }

  onDisconnect(listener: (reason?: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private handleMessage(
    data: unknown,
    opening?: { resolve: () => void; fail: (error: Error) => void },
  ): "open" | undefined {
    if (typeof data === "string") return this.handleControl(data, opening);
    if (data instanceof ArrayBuffer && data.byteLength === REPORT_SIZE) {
      const report = new Uint8Array(data);
      for (const listener of this.reportListeners) listener(report);
    }
    return undefined;
  }

  private handleControl(
    text: string,
    opening?: { resolve: () => void; fail: (error: Error) => void },
  ): "open" | undefined {
    let message: { type?: string; usb?: boolean; connected?: boolean; fw?: string };
    try {
      message = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (message.type === "hello" && opening) {
      this.bridgeFirmware = message.fw ?? "";
      if (!message.usb) {
        opening.fail(new Error(MESSAGES.noDsp));
        return undefined;
      }
      opening.resolve();
      return "open";
    }
    if (message.type === "usb" && message.connected === false) this.end(MESSAGES.unplugged);
    else if (message.type === "evicted") this.end(MESSAGES.evicted);
    return undefined;
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.socket?.close();
    for (const listener of this.disconnectListeners) listener(reason);
  }
}

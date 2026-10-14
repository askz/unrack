// A simulated DSP 4x4 Mini Pro behind the HidLink interface, reproducing the
// behaviour measured on hardware: queries echo their code (0x27 → 0x24), writes
// are acked with 0x01, unknown opcodes get 0x02, bad checksums get no reply, and a
// frame that arrives while the device is still processing the previous one is dropped.
// Used by the tests, and by dev builds opened with ?mock (UI work without hardware).
import type { HidLink } from "./link.ts";
import { frameWrap, parseFrame } from "../protocol/frame.ts";
import { Command, ReplyCode, PRESET_SLOT_COUNT } from "../protocol/commands.ts";
import { defaultPresetPages } from "./factory-pages.ts";

const WRITE_CODES: ReadonlySet<number> = new Set([
  Command.INIT_DONE, Command.RECALL_PRESET, Command.STORE_PRESET, Command.SET_NAME, Command.SET_PASSWORD,
  Command.TEST_TONE, Command.COMPRESSOR, Command.CROSSOVER_LPF, Command.CROSSOVER_HPF, Command.PEQ_BAND,
  Command.LEVEL, Command.MUTE, Command.POLARITY, Command.DELAY, Command.GATE, Command.ROUTING,
]);

export interface MockDspOptions {
  /** Processing time per request code, in ms (default 1). */
  latencyMs?: Partial<Record<number, number>>;
}

export class MockDsp implements HidLink {
  readonly productName = "Mock DSP";
  readonly received: Uint8Array[] = [];
  pages: Uint8Array[] = defaultPresetPages();
  presetNames: string[] = Array.from({ length: PRESET_SLOT_COUNT }, () => "Default Preset");
  activePreset = 0;
  /** Meter levels in dBFS, In A–D then Out 1–4 (hardware idle floor: ~-87 in, ~-75 out). */
  levels: number[] = [-87, -87, -87, -87, -75, -75, -75, -75];
  /** Silently drop this many upcoming frames (lost transactions). */
  dropNext = 0;
  /** Stop answering entirely. */
  unresponsive = false;
  /** Frames dropped because they arrived while the device was busy. */
  droppedWhileBusy = 0;
  isOpen = false;
  failOpen: Error | null = null;

  private readonly latencyMs: Partial<Record<number, number>>;
  private readonly reportListeners = new Set<(report: Uint8Array) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private busy = false;

  constructor(options: MockDspOptions = {}) {
    this.latencyMs = options.latencyMs ?? {};
  }

  async open(): Promise<void> {
    if (this.failOpen) throw this.failOpen;
    this.isOpen = true;
  }

  async close(): Promise<void> {
    this.isOpen = false;
  }

  async write(report: Uint8Array): Promise<void> {
    if (!this.isOpen) throw new Error("device not open");
    this.received.push(report.slice());
    if (this.busy) {
      this.droppedWhileBusy++;
      return;
    }
    if (this.unresponsive) return;
    if (this.dropNext > 0) {
      this.dropNext--;
      return;
    }
    const { payload, checksumOk } = parseFrame(report);
    if (!checksumOk) return;
    const code = payload[3] ?? 0;
    const data = payload.slice(4);
    this.busy = true;
    setTimeout(() => {
      this.busy = false;
      const reply = this.answer(code, data);
      if (reply) this.emit(reply.code, reply.data);
    }, this.latencyMs[code] ?? 1);
  }

  onReport(listener: (report: Uint8Array) => void): () => void {
    this.reportListeners.add(listener);
    return () => this.reportListeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  /** Send a report the host did not ask for (e.g. a late or foreign reply). */
  emit(code: number, data: ArrayLike<number> = []): void {
    const bytes = Array.from(data);
    const report = new Uint8Array(64);
    report.set(frameWrap([0x01, 0x00, 1 + bytes.length, code, ...bytes]));
    for (const listener of this.reportListeners) listener(report);
  }

  /** Deliver raw bytes as an inbound report. */
  emitRaw(report: Uint8Array): void {
    for (const listener of this.reportListeners) listener(report);
  }

  unplug(): void {
    this.isOpen = false;
    for (const listener of this.disconnectListeners) listener();
  }

  /** Request codes received so far, in order. */
  receivedCodes(): number[] {
    return this.received.map((frame) => frame[5] ?? 0);
  }

  private answer(code: number, data: Uint8Array): { code: number; data: number[] } | null {
    const ascii = (text: string) => Array.from(new TextEncoder().encode(text));
    switch (code) {
      case Command.GET_STATUS: return { code, data: [0x1f] };
      case Command.GET_VERSION: return { code, data: ascii("4x4MINIPRO V010") };
      case Command.GET_VERSION_FW: return { code, data: ascii("4x4MINIPRO V010 20230106A") };
      case Command.GET_ACTIVE_PRESET: return { code, data: [this.activePreset] };
      case Command.GET_CONFIG: return { code, data: [0x00, 0x27, 0x0f, 0, 0, 0, 0] };
      case Command.GET_FLAGS_BLOCK: return { code, data: new Array(30).fill(0) };
      case Command.READ_PRESET_NAME: {
        const slot = data[0] ?? 0;
        return { code, data: [slot, ...ascii((this.presetNames[slot] ?? "").padEnd(14, " ").slice(0, 14))] };
      }
      case Command.READ_CHANNEL: {
        const index = data[0] ?? 0;
        return { code: Command.REPLY_CHANNEL, data: [index, ...(this.pages[index] ?? new Uint8Array(50))] };
      }
      case Command.READBACK_LEVELS: {
        const levelData = new Array(27).fill(0);
        this.levels.forEach((db, i) => {
          const word = Math.min(0xffffffff, Math.round(2 ** 24 * Math.pow(10, db / 20)));
          levelData[3 * i] = (word >>> 16) & 0xff;
          levelData[3 * i + 1] = (word >>> 24) & 0xff;
          levelData[3 * i + 2] = (word >>> 8) & 0xff;
        });
        return { code, data: levelData };
      }
      case Command.RECALL_PRESET:
      case Command.STORE_PRESET:
        this.activePreset = data[0] ?? 0;
        return { code: ReplyCode.ACK, data: [] };
      default:
        return WRITE_CODES.has(code) ? { code: ReplyCode.ACK, data: [] } : { code: ReplyCode.NAK, data: [] };
    }
  }
}

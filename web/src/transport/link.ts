// The platform seam: a raw HID byte pipe. WebHID (desktop) and the Android USB
// bridge implement it; all request/reply semantics live above it in RequestChannel.

export const REPORT_SIZE = 64;

export interface HidLink {
  readonly productName: string;
  /** True for the built-in demo device: nothing reaches real hardware. */
  readonly simulated?: boolean;
  /** Extra reply time the transport itself can add (a network hop); default 0. */
  readonly timeoutSlackMs?: number;
  open(): Promise<void>;
  close(): Promise<void>;
  /** Send one 64-byte output report. Rejects if the OS-level write fails. */
  write(report: Uint8Array): Promise<void>;
  /** Subscribe to every inbound report. Returns an unsubscribe function. */
  onReport(listener: (report: Uint8Array) => void): () => void;
  /** Subscribe to the device going away (unplugged, permission revoked, taken over). The reason is shown to the user. */
  onDisconnect(listener: (reason?: string) => void): () => void;
}

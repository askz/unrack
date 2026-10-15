// Client for the ESP32 bridge's JSON API (same origin, session cookie).
export interface EspSession {
  authenticated: boolean;
  passwordChangeRequired: boolean;
  firmware: string;
  ui: string;
  tokenSet?: boolean;
}

export class EspApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "EspApiError";
    this.status = status;
    this.code = code;
  }
}

/** True in the build served from the ESP32 (VITE_TARGET=esp). */
export const isEspTarget = (): boolean => import.meta.env?.VITE_TARGET === "esp";

/** The WebSocket address of the bridge, derived from the page address. */
export function bridgeUrl(location: Pick<Location, "protocol" | "host">): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
}

export async function espRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new EspApiError(response.status, parsed.error ?? `http_${response.status}`);
  return parsed as T;
}

export const fetchSession = () => espRequest<EspSession>("/api/session");

// ------------------------------------------------------------------- types

export interface WifiStatus {
  ap: { on: boolean; ssid: string; clients: number };
  station: { configured: boolean; ssid: string; state: "not_configured" | "connecting" | "connected" | "failed"; ip: string; rssi?: number; error: string };
  hostname: string;
}

export interface ScannedNetwork {
  ssid: string;
  rssi: number;
  open: boolean;
}

export interface BridgeHealth {
  uptimeSeconds: number;
  resetReason: string;
  firmware: string;
  ui: string;
  uiInstalled: boolean;
  otaSlot: string;
  heap: { free: number; minimumFree: number };
}

// -------------------------------------------------------------- validation

export const LOGIN_PASSWORD_LIMITS = { min: 8, max: 64 } as const;
export const AP_PASSWORD_LIMITS = { min: 8, max: 63 } as const;

/** Why a new password cannot be used, or "" when it is fine. */
export function passwordProblem(password: string, confirm: string, limits: { min: number; max: number }): string {
  if (password.length < limits.min) return `Use at least ${limits.min} characters.`;
  if (password.length > limits.max) return `Use at most ${limits.max} characters.`;
  if (password !== confirm) return "The two passwords differ.";
  return "";
}

const ERROR_TEXT: Record<string, string> = {
  bad_password: "Wrong password.",
  bad_new_password: "The new password is not acceptable (8 to 64 characters).",
  unauthorized: "Your session ended. Log in again.",
  password_change_required: "Change the default password first.",
  bad_network: "That network name or password is not acceptable.",
  scan_busy: "The Wi-Fi scan is busy. Try again in a moment.",
  save_failed: "The ESP32 could not save the change.",
  image_too_large: "That file is too large for its partition.",
  invalid_image: "The file is not a valid image for this device.",
  not_a_littlefs_image: "That is not a web UI image (www.bin).",
  no_memory: "The ESP32 is out of memory. Try again.",
};

export function describeError(error: unknown): string {
  if (error instanceof EspApiError) return ERROR_TEXT[error.code] ?? `The ESP32 refused the request (${error.code}).`;
  return error instanceof Error ? error.message : String(error);
}

// ----------------------------------------------------------------- uploads

/** POST a file as the raw request body (what the firmware's update endpoints expect), reporting progress 0..1. */
export function uploadImage(path: string, file: Blob, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", path);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onerror = () => reject(new Error("The upload was interrupted."));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      let code = `http_${request.status}`;
      try {
        code = (JSON.parse(request.responseText) as { error?: string }).error ?? code;
      } catch { /* not JSON: keep the status code */ }
      reject(new EspApiError(request.status, code));
    };
    request.send(file);
  });
}

/** Resolve once the ESP32 answers again after a reboot (or reject after the timeout). */
export async function waitForBridge(timeoutMs: number, intervalMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await new Promise((resolve) => setTimeout(resolve, intervalMs)); // let it go down first
  while (Date.now() < deadline) {
    try {
      await fetchSession();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error("The ESP32 did not come back. Reload the page in a moment.");
}

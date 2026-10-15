// What the app does on open. The ESP32 build logs in to the bridge first. Elsewhere a
// granted DSP is bound without prompting; the plain web build falls back to the demo
// when there is none, or goes straight to it with ?demo (alias ?mock).
export type StartupPlan = "bridge" | "device" | "demo" | "device-or-demo";

export interface StartupContext {
  /** The page is served by the ESP32 bridge. */
  bridge: boolean;
  /** The demo device may run here (not on the bridge, not in the Android app). */
  demoAvailable: boolean;
  /** The page address asks for the demo. */
  demoRequested: boolean;
}

export function startupPlan(context: StartupContext): StartupPlan {
  if (context.bridge) return "bridge";
  if (!context.demoAvailable) return "device";
  return context.demoRequested ? "demo" : "device-or-demo";
}

/** True when the query string has ?demo or ?mock. */
export function demoRequested(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("demo") || params.has("mock");
}

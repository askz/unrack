// Chooses the link implementation for the running platform: the Android shell's
// native USB bridge when present, otherwise desktop WebHID.
import type { HidLink } from "./link.ts";
import { NativeLink } from "./native.ts";
import { WebHidLink } from "./webhid.ts";
import { MockDsp } from "./mock.ts";
import { Command } from "../protocol/commands.ts";

export interface LinkProvider {
  supported(): boolean;
  /** Let the user choose/grant the device (desktop: needs a user gesture). */
  pick(): Promise<HidLink | null>;
  /** An already-granted, attached device, without prompting. */
  existing(): Promise<HidLink | null>;
  /** Notify when a granted device appears. Returns an unsubscribe function. */
  onAttach(listener: (link: HidLink) => void): () => void;
}

const nativeProvider: LinkProvider = {
  supported: () => true,
  pick: async () => new NativeLink(),
  existing: async () => (NativeLink.connected() ? new NativeLink() : null),
  onAttach: (listener) => NativeLink.onAttach(listener),
};

const webHidProvider: LinkProvider = {
  supported: () => WebHidLink.supported(),
  pick: () => WebHidLink.request(),
  existing: () => WebHidLink.existing(),
  onAttach: (listener) => WebHidLink.onAttach(listener),
};

const MOCK_LATENCY_MS = { [Command.RECALL_PRESET]: 660, [Command.STORE_PRESET]: 2200 };
const MOCK_LEVEL_INTERVAL_MS = 100;

/** Dev-only simulated device (open the dev server with ?mock). */
function mockProvider(): LinkProvider {
  const device = new MockDsp({ latencyMs: MOCK_LATENCY_MS });
  setInterval(() => {
    device.levels = device.levels.map((_, i) => -60 + 54 * Math.abs(Math.sin(Date.now() / (700 + 90 * i))));
  }, MOCK_LEVEL_INTERVAL_MS);
  return {
    supported: () => true,
    pick: async () => device,
    existing: async () => device,
    onAttach: () => () => {},
  };
}

export function platformLinkProvider(): LinkProvider {
  if (import.meta.env?.DEV && new URLSearchParams(globalThis.location?.search).has("mock")) return mockProvider();
  return NativeLink.supported() ? nativeProvider : webHidProvider;
}

// Chooses the link implementation for the running platform: the Android shell's
// native USB bridge when present, the ESP32 bridge's WebSocket in that build, otherwise
// desktop WebHID. The demo device is offered beside them in the plain web build.
import type { HidLink } from "./link.ts";
import { NativeLink } from "./native.ts";
import { WebHidLink } from "./webhid.ts";
import { WsLink } from "./websocket.ts";
import { bridgeUrl, fetchSession, isEspTarget } from "../esp/api.ts";
import { DemoDsp } from "./demo.ts";

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

/** The ESP32 bridge: the page itself is served by it, so the link is always "granted". */
async function espLink(): Promise<HidLink> {
  const session = await fetchSession();
  if (!session.authenticated || session.passwordChangeRequired) throw new Error("Log in to the ESP32 first");
  return new WsLink(bridgeUrl(globalThis.location));
}

const wsProvider: LinkProvider = {
  supported: () => typeof WebSocket !== "undefined",
  pick: espLink,
  existing: espLink,
  onAttach: () => () => {},
};

export function platformLinkProvider(): LinkProvider {
  if (isEspTarget()) return wsProvider;
  return NativeLink.supported() ? nativeProvider : webHidProvider;
}

/** The demo runs in the plain web build only: not on the ESP32 bridge, not in the Android app. */
export function demoAvailable(): boolean {
  return !isEspTarget() && !NativeLink.supported();
}

export function demoLink(): HidLink {
  return new DemoDsp();
}

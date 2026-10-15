// Link for the hardware tools: a Linux hidraw node (/dev/hidrawN), or the ESP32
// bridge (ws://host/ws, authenticated with the API token in $OPENDSP_TOKEN).
import type { HidLink } from "../src/transport/link.ts";
import { WsLink, type WsSocket } from "../src/transport/websocket.ts";
import { HidrawLink } from "./hidraw-link.ts";

type NodeWebSocket = new (url: string, init: { headers: Record<string, string> }) => WsSocket;

export function linkFor(target: string): HidLink {
  if (!/^wss?:\/\//.test(target)) return new HidrawLink(target);
  const token = process.env.OPENDSP_TOKEN?.trim();
  if (!token) throw new Error("set OPENDSP_TOKEN to an API token of the bridge (Settings > Login)");
  // Node's WebSocket (undici) accepts extra handshake headers, which browsers do not.
  const Socket = WebSocket as unknown as NodeWebSocket;
  return new WsLink(target, (url) => new Socket(url, { headers: { Authorization: `Bearer ${token}` } }));
}

export const TARGET_USAGE = "<hidraw device path | ws://host/ws (with OPENDSP_TOKEN set)>";

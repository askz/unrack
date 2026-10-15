# ESP32-S3 Wi-Fi bridge for the DSP

Date: 2026-10-15. Status: approved design.

An ESP32-S3-DevKitC-1 acts as USB host for the DSP (`0168:0821`, DSP on the "USB" OTG port)
and exposes it over Wi-Fi. It also hosts the web UI, so the whole system needs no USB
connection to a computer. Firmware lives in `firmware/` (native ESP-IDF 6.0.2).

## Decisions

- **Bridge**: a WebSocket carries the same raw 64-byte HID reports as WebHID. The web app only
  gains one `HidLink` implementation; `RequestChannel` and everything above it are unchanged.
- **Transaction gate**: the DSP handles one transaction at a time and drops frames sent while
  busy. The ESP lets one request reach the DSP at a time, from the browser or from its own
  polling, and routes each reply to whoever asked.
- **Endpoints**: JSON (`/api/status`, `/api/levels`, `/api/health`) and Prometheus `/metrics`.
- **Clients**: one controller at a time. A new tab takes over; the old one receives
  `{"type":"evicted"}` and shows "controlled elsewhere" with a "Take control" button.
- **Updates**: OTA firmware (two slots, rollback) plus a separate LittleFS `www` partition
  that can be replaced on its own.
- **Wi-Fi**: the AP `openDSP-XXXX` is on by default. After a home network is registered and
  joined the AP turns off, and returns if the network is lost for 30 s.
- **Security**: WPA2 AP, session cookie for the UI and WebSocket, `Authorization: Bearer`
  token for scripts and Prometheus. Default AP and UI password `opendsp-setup`, the UI forces a
  change at first login.

## ESP-IDF 6 constraints

- USB Host is a managed component (`espressif/usb`). `espressif/usb_host_hid` can only write
  with `SET_REPORT` on the control endpoint, so the firmware uses raw interrupt IN/OUT
  transfers through `usb_host_transfer_submit()`.
- `json` and `mdns` are managed components (`espressif/cjson`, `espressif/mdns`).
- WebSocket handlers are not called on the handshake (6.0.1+): connect logic uses
  `ws_post_handshake_cb` (`CONFIG_HTTPD_WS_POST_HANDSHAKE_CB_SUPPORT`).
- Interrupt-OUT scheduling issue (esp-idf#14412): workaround is `USB_TRANSFER_FLAG_ZERO_PACK`.

## Firmware modules

| Module | Role |
|--------|------|
| `dsp_usb` | USB host daemon/client tasks, endpoint discovery, `dsp_usb_write`, report callback, attach/detach callbacks |
| `dsp_gate` | single-flight request queue, reply matching (rules of `exchange.ts`), meter and device-info caches, stats |
| `ws_bridge` | `/ws` endpoint, takeover, text control messages |
| `api` | JSON endpoints, `/metrics`, static files from LittleFS |
| `wifi_mgr` | AP/STA state machine, scan, NVS credentials, mDNS, power save off |
| `auth` | password hash, sessions, API token, factory reset |
| `ota` | firmware and UI uploads |

The gate's matching logic is pure C (`dsp_proto.{c,h}`) so it can be unit tested on the host
(`firmware/test/`).

## WebSocket protocol (`/ws`)

- Binary frames are exactly 64 bytes: browser to ESP is a request, ESP to browser is the
  matching reply. A request that times out gets no reply; the browser's own retry applies.
- Text frames: `hello` on connect, `usb` on attach/detach, `evicted` before a takeover close.
- The handshake needs a valid session cookie or Bearer token.

## HTTP API

Everything needs a session cookie or Bearer token except static files, `POST /api/login` and
`GET /api/session`.

- `GET /api/status`, `GET /api/levels`, `GET /api/health`, `GET /metrics`
- `GET /api/wifi`, `GET /api/wifi/scan`, `POST /api/wifi`, `DELETE /api/wifi`, `POST /api/wifi/ap`
- `POST /api/login`, `POST /api/logout`, `POST /api/auth/password`, `POST /api/auth/token`
- `POST /api/update/firmware`, `POST /api/update/ui`, `POST /api/reboot`

`/api/levels` serves the cached meter reply when it is under 250 ms old (a browser polling at
10 Hz keeps it fresh); otherwise the gate performs one internal `0x40` poll. No traffic is sent
while nobody asks.

## Web app

- `WsLink` (`transport/websocket.ts`) implements `HidLink`; `timeoutSlackMs` extends reply
  timeouts for Wi-Fi latency.
- `VITE_TARGET=esp` build: base `/`, output `dist-esp`, gzipped into `firmware/www/`.
- `web/src/esp/`: API client, login overlay, controlled-elsewhere banner, Network settings.
- `hw-smoke` accepts `ws://host/ws`.

## Verification

1. USB-only firmware reads `GET_VERSION` from the real DSP.
2. `npm run hw:smoke -- ws://192.168.4.1/ws` passes through the bridge.
3. Endpoints checked with `curl`; `/metrics` format-checked.
4. Wi-Fi join/fallback, auth, OTA and rollback exercised on the board.
5. `npm test`, `npm run typecheck`, `idf.py build`.

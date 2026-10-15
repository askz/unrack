# How the Android app works — a WebView + USB-bridge walkthrough

Unrack runs on Android (app ID `io.github.askz.unrack`) by **wrapping the
existing web app in a thin WebView** and handing
it a small native USB pipe. This page explains why, and walks through the pieces. It doubles as
a reusable recipe for getting any WebHID/WebUSB app onto a phone when the browser can't reach
the hardware.

## Why a native shell at all?

The web app talks to the DSP with **WebHID**, which only exists in desktop Chrome/Edge. On
Android there is *no* browser path to this device:

- **WebHID** isn't implemented in any Android browser.
- **WebUSB** is implemented, but it **blocks the HID interface class** for security.

So the USB I/O has to be native. Everything else — the UI, the protocol codec, the EQ maths —
is reused unchanged. The whole Android-specific surface is four small Kotlin files plus a
140-line TypeScript link.

## The one seam that makes this cheap

The codebase keeps a single boundary between the platform-agnostic protocol and the actual I/O,
in [`web/src/transport/link.ts`](web/src/transport/link.ts): a raw HID byte pipe.

```ts
interface HidLink {
  readonly productName: string;
  readonly simulated?: boolean;                        // the built-in demo device
  readonly timeoutSlackMs?: number;                    // extra reply time of a network hop
  open(): Promise<void>;
  close(): Promise<void>;
  write(report: Uint8Array): Promise<void>;            // one 64-byte output report
  onReport(listener: (report: Uint8Array) => void): () => void;
  onDisconnect(listener: (reason?: string) => void): () => void;  // unplugged / revoked / taken over
}
```

`webhid.ts` implements it for the desktop. For Android there is **one more implementation** that
moves the same bytes through a bridge. Everything above the seam (request/reply matching,
retries, queueing, the connection lifecycle) is shared and unit-tested.

```
     Svelte UI ─ device store ─ Connection ─ Dsp client ─ RequestChannel ─ HidLink
                                                                              │
                         ┌────────────────────────────────────────────────────┴──────┐
                  WebHidLink (desktop)                                   NativeLink (Android)
                  device.sendReport / inputreport              window.AndroidUsb  ⇄  Kotlin USB
```

## Step 1 — `NativeLink` (TypeScript)

[`web/src/transport/native.ts`](web/src/transport/native.ts) is the WebHID link with the I/O swapped:

- **write:** `device.sendReport(0, frame)` → `window.AndroidUsb.write(base64)` (returns `false` if the transfer failed)
- **read:** the `inputreport` event → a global callback `window.__dsp_onReport(base64)`
- **disconnect / attach:** `window.__dsp_onState(false / true)`

The tricky bits (one transaction in flight, reply matching, per-command timeouts, retries) live
in [`channel.ts`](web/src/transport/channel.ts), shared by both platforms.
[`web/test/native.test.ts`](web/test/native.test.ts) drives the link against a fake bridge.

Two more small edits wire it up:

- [`platform.ts`](web/src/transport/platform.ts) picks the link: the ESP32 build → the
  WebSocket link, native bridge present → `NativeLink`, else `WebHidLink`. The demo device is
  never offered in the Android app.
- [`vite.config.ts`](web/vite.config.ts) — `VITE_TARGET=android` sets `base: "./"` so the
  bundle's asset paths resolve under the WebView's asset-loader host.

## Step 2 — the bridge contract

Raw bytes only, carried as base64 strings.

**JS → native** (`@JavascriptInterface`, synchronous):
`AndroidUsb.open()`, `AndroidUsb.write(b64)`, `AndroidUsb.close()`, `AndroidUsb.isConnected()`.

**native → JS** (`evaluateJavascript` on the UI thread):
`window.__dsp_onReport(b64)` per inbound report; `window.__dsp_onState(connected)` when the
device opens, fails to open, or is detached (`ACTION_USB_DEVICE_DETACHED`).

That's the whole interface. The Kotlin side is a *dumb byte pipe* — it knows nothing about the
protocol.

**Preset files** need two more small pieces, because a WebView neither downloads blobs nor opens
a file picker by itself ([`FileBridge.kt`](android/app/src/main/java/io/github/askz/unrack/FileBridge.kt)):
`window.AndroidFiles.save(name, mimeType, text)` opens the system "save as" dialog (Storage
Access Framework) and writes the document, and a `WebChromeClient.onShowFileChooser` makes
`<input type="file">` work for import. [`files.ts`](web/src/ui/files.ts) picks the bridge when
it is present.

## Step 3 — the Kotlin shell (`android/`)

Four small files (the fourth, `FileBridge.kt`, is the preset-file bridge above):

- **[`MainActivity.kt`](android/app/src/main/java/io/github/askz/unrack/MainActivity.kt)** — a
  full-screen WebView that serves the bundled UI from
  `https://appassets.androidplatform.net/assets/www/` via `WebViewAssetLoader` (offline, and
  avoids `file://` quirks). Wires the bridge in with `addJavascriptInterface(bridge, "AndroidUsb")`.
- **[`UsbHid.kt`](android/app/src/main/java/io/github/askz/unrack/UsbHid.kt)** — the USB host:
  enumerate by VID/PID (`0x0168` / `0x0821`) → runtime permission → `openDevice` →
  `claimInterface(force = true)` (this detaches the kernel HID driver) → interrupt endpoints
  OUT `0x02` / IN `0x81`. A daemon read thread loops on `bulkTransfer` (Android services
  interrupt endpoints through it too) and forwards each report.
- **[`Bridge.kt`](android/app/src/main/java/io/github/askz/unrack/Bridge.kt)** — the
  `@JavascriptInterface` methods, base64 ⇄ bytes, and `evaluateJavascript` to push reports/state
  back to the page.

The [manifest](android/app/src/main/AndroidManifest.xml) declares the `usb.host` feature and a
`USB_DEVICE_ATTACHED` intent-filter pointing at
[`device_filter.xml`](android/app/src/main/res/xml/device_filter.xml) (`vendor-id="360"
product-id="2081"` — the same IDs in decimal). Plugging the DSP in then offers to launch the app
*and pre-grants USB permission*.

## Step 4 — the edge-to-edge gotcha

Targeting Android 15 (SDK 35) forces **edge-to-edge**: the WebView draws under the status and
nav bars, so the page's top row lands beneath the clock. Padding the WebView *view* doesn't help
— Chromium ignores view padding for its content viewport (its `innerHeight` stays the full
screen height). The fix is to read the system-bar insets and feed them to CSS:

```kotlin
ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
    val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
    // px → CSS px (÷ density), then push into the page on the UI thread:
    safeTopPx = bars.top / density; safeBottomPx = bars.bottom / density
    applyInsets() // evaluateJavascript: documentElement.style.setProperty('--safe-top', …)
    WindowInsetsCompat.CONSUMED
}
```

The header reserves `var(--safe-top)` and the bottom bar reserves `var(--safe-bottom)`.

## Step 5 — build & release

One script, [`android/build-apk.sh`](android/build-apk.sh), runs the whole chain: build the web
bundle in Android mode → copy `web/dist/*` into `app/src/main/assets/www/` →
`./gradlew assembleDebug`.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) builds a debug APK for every push
to `main` and every pull request. Releases are automated. Tag `vX.Y.Z` and
[`.github/workflows/android-release.yml`](.github/workflows/android-release.yml) verifies the web
bundle (typecheck + tests), assembles a **signed** APK (keystore from repo secrets, with a
debug-key fallback so it still builds without them), and publishes a GitHub Release whose notes
are the tag's section of [`CHANGELOG.md`](CHANGELOG.md). Bump `versionCode` / `versionName` in
`android/app/build.gradle.kts` and add the changelog section in the commit you tag. The signing
secret names are in the workflow header.

## Gotchas worth knowing

- **Use a data-capable OTG cable/adapter.** A charge-only one makes Android report the Type-C
  compliance warning `missing data lines` and *nothing enumerates* — no device in the list, no
  permission dialog. (Isolate it by trying a known-good USB stick on the same adapter.)
- **`claimInterface(force = true)` is required** — without `force` the kernel HID driver keeps the
  interface and the claim fails.
- **Changing the signing key needs an uninstall** — Android refuses to update a package when the
  APK signature changes (e.g. a debug build → a release build).
- **Keep timing/retry in TypeScript.** The Kotlin side stays a byte pipe, so the calibrated
  protocol has one source of truth and the fiddly parts stay unit-testable.

## Status

Upstream's openDSP-4x4 `v0.2.2` was verified end-to-end on a Pixel 8 Pro over USB-OTG: attach →
permission → version handshake (`4x4MINIPRO V010`) → full state readback/hydrate → preset
recall, routing and live meters. Unrack `v1.0.0` keeps the same Kotlin bridge but has not been
tested on a phone yet. Hot-unplug is reported through `__dsp_onState(false)` (detach receiver)
and moves the connection to "lost"; replugging re-binds via the attach intent.

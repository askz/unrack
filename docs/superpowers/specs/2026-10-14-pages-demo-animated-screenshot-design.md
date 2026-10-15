# Demo on GitHub Pages and animated screenshot

Date: 2026-10-14
Status: approved design

## Goal

1. The GitHub Pages site (`https://askz.github.io/opendsp-4x4/`) opens a demo with a simulated
   DSP whose meters move like a live show, while a real DSP can still be connected from the same
   page.
2. The README shows an animated screenshot (`docs/demo.webp`) walking through six pages with one
   small edit on each, recorded from the demo by a reproducible script.

Order: the demo first, then the recording (the recording is made from the demo).

## Decisions

| Topic | Choice |
|---|---|
| Demo start | Automatic on open when no granted DSP is plugged in |
| Meters | React to gain, mute, routing and test tone |
| Recording | `playwright-core` (system Chrome) and ffmpeg, a manual script |
| Pages in the animation | Overview, an output page, Setup, time alignment, System, Settings |
| Edits shown | One per page |
| Format and size | Animated WebP, desktop 1280 x 800 |
| Settings shared with the real device | Yes (output names, colours, theme, units, Setup draft) |

## 1. The demo device (transport, plain TypeScript)

### `web/src/transport/demo.ts`: `DemoDsp`

- Built on the existing `MockDsp` (same replies, timing and factory preset image).
- `productName` is "Demo DSP"; `simulated` is `true` (see section 2).
- Decodes four writes and keeps their state per channel (8 channels: In A to D, Out 1 to 4):
  - `LEVEL` (0x34) `[chan, val16]`: gain, converted with `gainRawToDb` from `protocol/control.ts`.
  - `MUTE` (0x35) `[chan, on]`.
  - `ROUTING` (0x3a) `[out_chan, input_bitmask]` (In A = 1, In B = 2, In C = 4, In D = 8).
  - `TEST_TONE` (0x39) `[source, freqIndex]`; source 0 = off.
- Its preset image (every slot in the simulation) is the factory image with Out 3 and Out 4
  routed from In A + In B, so all four outputs carry signal from the start.
- Initial state, and the state after `RECALL_PRESET`: gains and routing from that image, all
  channels unmuted, tone off.
- While open, the levels are recomputed every 100 ms from `demoLevels.ts`; the timer stops on
  close.
- Uses the same recall and store latencies as the dev mock today.

### `web/src/transport/demoLevels.ts` (pure)

- `programDb(timeMs)`: the input signal for In A and In B in dBFS. A kick pulse at about
  124 BPM, a slower swell over several bars, and some random motion from a small seeded
  generator. In A and In B are correlated but not identical (stereo). In C and In D stay at the
  hardware idle floor, -87 dBFS.
- While a test tone is on (source not 0), every input is a steady -12 dBFS instead (on the
  device the tone also replaces the input signal).
- Input meters: the input signal plus the input's gain; muted gives the input floor (-87).
  Assumption, not measured: the hardware input meter is after the input gain.
- Output meters: the power sum of the routed inputs (after their gain and mute) plus the
  output's gain; muted or no input routed gives the output floor (-75).
- Every level is clamped between its floor and 0 dBFS.
- Not modelled: EQ, crossovers, delay, compressor, gate, polarity. This is a limit of the demo.

### Tests

- Each of the four writes is decoded into the state; other writes are still acked and change
  nothing.
- Routing power sum (one input, two inputs, none), gain, mute to the floor, the test tone, the
  reset on recall.
- The program signal stays between the floor and 0 dBFS, and moves (not constant) over a few
  seconds.

## 2. Choosing between the demo and a real DSP

### Transport

- `HidLink` gains an optional `readonly simulated?: boolean`; only `DemoDsp` sets it.
- `platform.ts` gains `demoLink(): HidLink`, a new `DemoDsp`. The real provider is unchanged
  (WebHID on desktop, the native bridge in the Android app). The dev-only `mockProvider` is
  removed; `?mock` becomes an alias of `?demo`.

### `Connection`

- The snapshot gains `simulated: boolean` (true while the bound link is simulated).
- New `connectDemo()`: binds `demoLink()` through the usual lifecycle (connecting, syncing,
  ready). Allowed when WebHID is missing; when that session ends, the phase returns to
  "unsupported".
- `connect()` during a demo session: the provider's picker runs first (it needs the click's user
  gesture). A chosen device ends the demo session and binds; a cancelled pick (null) or an error
  leaves the demo session running untouched.
- A granted DSP attached during a demo session binds (the attach watcher also accepts a
  simulated session, not only "idle" and "lost").
- No automatic demo after a real device is lost or disconnected.

### Startup

A pure function decides what happens on open, from: the ESP32 build, the Android app, and
whether `?demo` (or `?mock`) is in the URL.

- ESP32 build: the bridge login and auto-connect as today, never the demo.
- Android app: auto-connect only, never the demo.
- `?demo` in the URL: the demo, without auto-connecting.
- Otherwise: the existing auto-connect; if it found no granted device, the demo. A granted
  device that fails to open keeps its error on screen (no demo over it).

### UI

- Banner (App.svelte, like the offline notice) while the session is simulated:
  - With WebHID: "Demo: a simulated DSP. Nothing here reaches real hardware." and a
    "Connect DSP…" button.
  - Without WebHID: "Demo: a simulated DSP. Nothing here reaches real hardware. Connecting a
    DSP needs Chrome or Edge on a computer, or the Android app."
- While simulated, this banner replaces the offline and "cannot reach USB devices" notices.
- Top bar: "Connect DSP…" instead of "Disconnect" while simulated (absent without WebHID).
- Status bar: the product name "Demo DSP".
- The "lost" notice, the offline notice and the "cannot reach USB devices" notice get a
  "Try the demo" button.

### Fine-tuning in the demo

- A session started on a simulated device keeps its snapshot in memory only (no
  `localStorage`), so a later real DSP is never offered a Restore with demo values.
- A stored interrupted session (from a real DSP) is neither shown nor restorable, and does not
  lock anything, while the session is simulated.

### Tests

- `Connection`: `connectDemo()` binds and reports `simulated`; during a demo, a picked device
  replaces it, a cancelled pick keeps it, an attach replaces it; no demo after a loss; the phase
  returns to "unsupported" after a demo without WebHID.
- The startup function: each case above.
- Tuning: a session on a simulated device writes nothing to storage, and a stored interrupted
  session is ignored while simulated.

## 3. The recording

- `npm run capture:demo` runs `web/tools/capture-demo.ts`.
- `playwright-core` as a pinned dev dependency, no browser download. Chrome from `CHROME_PATH`,
  else `google-chrome-stable` or `chromium` on the PATH. ffmpeg with `libwebp_anim` is required.
  The script checks both first and names what is missing.
- It runs `npm run build`, serves `dist` with `vite preview` on a free port (the Vite config
  gives preview the same `/opendsp-4x4/` base as the Pages build) and opens
  `/opendsp-4x4/?demo` in a fresh profile (default settings: dark theme, metres, empty draft),
  viewport 1280 x 800, device scale factor 1.
- A cursor dot is drawn by the script into the page so clicks and drags are visible; the app is
  not changed for the recording.
- Steps (about 25 s):
  1. Overview, about 4 s: meters running; mute an output, its meter drops, unmute.
  2. An output page, about 4 s: drag one PEQ handle on the EQ graph.
  3. Setup, about 4 s: choose "2.1 Outdoor", click a layout card, the crossover preview changes.
  4. Time alignment, about 5 s: switch it on, drag the alignment point across the crowd.
  5. System, about 3 s: preset slots and device facts.
  6. Settings, about 4 s: switch to the light theme, then back to dark, so the loop restarts on
     the dark Overview.
- Controls are found by role and label. A step that cannot find its control stops the script
  with the step's name.
- Frames come from Chrome's screencast with their timestamps; ffmpeg encodes them to
  `docs/demo.webp` (lossy, 12 fps, looping). Quality and fps are constants at the top of the
  script. The script prints the size; the target is about 3 to 4 MB, to be confirmed by
  measuring.
- Not run in CI.

## 4. Deploy, docs and checks

- Deploy: the existing `.github/workflows/pages.yml` builds `web/` on every push to `main`
  (Pages is set to deploy from GitHub Actions). No workflow change. The site updates only once
  `main` is pushed; local `main` is 36 commits ahead of `origin/main` today, so that push also
  publishes the level control, Setup and time alignment work. Pushing needs the user's go-ahead.
- README:
  - Hero image `docs/demo.webp`; `docs/screenshot.png` removed (only the README uses it).
  - Under "Open the web app": "No DSP plugged in? It opens a demo with a simulated DSP", and a
    "Try the demo" link to `?demo`.
  - A feature line for the demo; the `?mock` dev note becomes `?demo` (works in every web build).
- Checks:
  - Unit tests for sections 1 and 2; typecheck with 0 warnings; build, with the bundle size
    before and after.
  - Manual, on the preview build: the demo starts on open with its banner; meters react to mute,
    gain, routing and the test tone; a fine-tuning session in the demo writes nothing to
    `localStorage`; with WebHID absent the demo still runs; the Android build target
    (`VITE_TARGET=android`) still builds.
  - Hardware, by the user: on the Pages site with the DSP plugged in, Connect DSP opens the
    picker and the real device replaces the demo; cancelling keeps the demo.

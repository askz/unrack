# Changelog

All notable changes to Unrack. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-15

First release of **Unrack**, a hard fork of [openDSP-4x4](https://github.com/GlassOnTin/opendsp-4x4)
by Ian Williams ([@GlassOnTin](https://github.com/GlassOnTin)). The protocol research is his; the
transport, state layer and UI have been rebuilt since `v0.2.2`. Supported device: the t.racks DSP
4x4 Mini Pro.

**[Open the web app](https://askz.github.io/unrack/)** (desktop Chrome or Edge), or
[try the demo](https://askz.github.io/unrack/?demo) without a DSP.

### Added

- **Demo**: with no DSP plugged in, the web app runs against a simulated one whose meters follow
  the gain, mute, routing and test tone, so every page can be tried. *Connect DSP…* switches to
  the real device. `?demo` forces it.
- **Setup**: pick a speaker layout (2.0 stereo, 2.1, 2.2, Top / Kick / Sub in stereo or mono,
  bi-amp stereo, 4-way mono) and an environment (neutral, indoor, outdoor, club, speech,
  background). Setup derives the crossovers (Linkwitz-Riley 12 or 24 dB/oct), a subsonic
  filter, trims, polarity, shelves, output names and optional protection limiters, shows a
  crossover preview and the exact list of changes, and applies them as one undo step. Built-in
  presets, your own presets and setup files.
- **Time alignment** (in Setup): delays from the speakers' positions and the crowd area in a
  side view, or from measured distances, corrected for air temperature. The view shows where
  in the crowd the bands add up or cancel at the crossover.
- **Fine-tune by ear**: a guided session that finds the cabinets' own delay with a sine and a
  polarity flip on one pair of outputs, as one undo group.
- **Settings** (saved in the browser): channel names, colours and visibility, step sizes, EQ
  width as Q or octaves, EQ graph range, meter peak hold, theme (dark, light or system),
  density, text size, metric or imperial units, an output gain limit, startup view.
- **Mixer-style overview**: vertical faders on the device's level scale, solo on outputs,
  *Mute all* (and back), and a master trim that moves the four output gains together.
- **Undo / redo** for every parameter (Ctrl/⌘+Z, Ctrl/⌘+Shift+Z or Ctrl+Y); a fader or
  EQ-handle drag is one step.
- **Delivery tracking**: each parameter shows whether it is sending, rejected or not sent
  (offline), with a *Resend* action.
- **Preset files**: export the full live state as JSON and import it back as one undoable
  change, with strict validation. Also on Android, through a file bridge.
- **Wi-Fi bridge (ESP32-S3)**: firmware (ESP-IDF 6) that plugs into the DSP's USB port and
  serves the web app over Wi-Fi to any browser, phone or tablet. Access point on first start,
  then your home network; password login and API tokens; one controller at a time with
  take-over; `/api/status`, `/api/levels`, `/api/health` and Prometheus `/metrics`; firmware
  and web UI updates over the air with automatic rollback. A round trip to the DSP takes about
  11 ms on a home network. Build and flash it from source (see the README).
- **Tools**: `npm run hw:smoke` (hardware smoke test over hidraw or the bridge) and
  `npm run hw:latency` (round-trip benchmark).
- Mouse wheel adjusts the control under the pointer, with a guard against page scrolling.
- Keyboard: `S` opens Setup.

### Changed

- **Renamed to Unrack.** The web app now lives at <https://askz.github.io/unrack/>.
- **Transport and connection rebuilt** on hardware-measured protocol rules: one transaction in
  flight, reply matching, retries, priority lanes and coalescing; automatic reconnect when a
  granted device is plugged back in; detection of unplugged or unresponsive devices; meters
  never delay an edit.
- **Exact values**: every edit is quantized to the device's own resolution (0.1 dB gain,
  1/30-octave frequency, Q in 0.1 steps, 1/48 ms delay), verified by reading the device back.
- After a preset recall the app re-reads the device, so the screen matches what is loaded.
- Gain steps no longer stick below -20 dB.
- **Android app**: now named Unrack with app ID `io.github.askz.unrack`, so it installs next to
  openDSP-4x4 from F-Droid instead of conflicting with it. The 30 preset slots live on the DSP,
  so they are unaffected; nothing saved inside the old app carries over.
- CI checks the web app and builds a debug APK on every push to `main` and every pull request.

### Removed

- The F-Droid and fastlane metadata from upstream. Unrack is not on F-Droid.

### Known issues

- Mute and PEQ-band bypass have no readback on this device: after connecting they show as
  unknown (`?`) until you set them.
- Setup's protection limiters use the compressor's *Limit* ratio, which has not been verified
  on hardware yet.
- The Android APK is signed with a debug key and has not been tested on a phone since the
  rebuild, including the preset file bridge. A later release signed with a release key will
  need an uninstall first.

## Earlier versions

`0.2.2` and earlier are releases of openDSP-4x4; see its
[releases](https://github.com/GlassOnTin/opendsp-4x4/releases).

[1.0.0]: https://github.com/askz/unrack/compare/v0.2.2...v1.0.0

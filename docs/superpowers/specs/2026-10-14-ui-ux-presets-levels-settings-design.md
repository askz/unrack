# UI/UX round 1: setup presets, level control, personalization

Date: 2026-10-14. Status: approved design, ready for an implementation plan.

Three features for the web app (`web/`), designed together and built in order:

1. **Setup presets**: a Setup tab that turns a small "recipe" (speaker layout + environment +
   a few parameters) into device parameters, applied as one undoable edit.
2. **Level control**: mouse-wheel adjustment on hover with a scroll guard, a custom fader,
   a mixer-style Overview with master trim, mute all and solo.
3. **Personalization**: a Settings tab persisted in the browser (names, colours, hiding,
   step sizes, theme, density, units, gain ceiling).

## Device constraints the design respects

- 4 inputs (A to D, addresses 0x00 to 0x03), 4 outputs (Out 1 to 4, 0x04 to 0x07).
- Routing is an on/off input bitmask per output (A=1, B=2, C=4, D=8); no per-crosspoint level.
- Per output: gain (-60 to +12 dB; 0.5 dB steps below -20 dB, 0.1 dB above), mute (no
  readback), polarity, delay (0 to 680 ms), one high-pass and one low-pass crossover
  (Butterworth / Bessel / Linkwitz-Riley up to 24 dB/oct, or off), 7 PEQ bands (+-12 dB),
  compressor/limiter. Per input: gain, mute, polarity, noise gate.
- Channel names are read from the device but cannot be written yet. Display names are
  therefore stored in the browser.
- Unknown: whether summing A+B into one output is attenuated. See "Hardware check".

All edits go through the existing `Editor` (normalization, undo, delivery tracking). Nothing
in this design adds a new device command.

---

## 1. Setup presets

### 1.1 Recipe

A recipe is plain JSON-safe data. Built-in presets and custom presets are both recipes.

```ts
type LayoutId = "2.0" | "2.1" | "2.2" | "top-kick-sub" | "top-kick-sub-mono" | "biamp" | "4way";
type Role = "main" | "fill" | "top" | "kick" | "sub" | "low" | "mid" | "high";
type EnvironmentId = "neutral" | "indoor" | "outdoor" | "club" | "speech" | "background";

interface Recipe {
  version: 1;
  layout: LayoutId;
  source: "stereo" | "mono";              // stereo: A = left, B = right; mono: A only
  crossoversHz: number[];                 // ascending, length = layout split count
  slope: "LR24" | "LR12";
  subsonic: { enabled: boolean; freqHz: number };
  trimsDb: Partial<Record<Role, number>>; // missing role = 0 dB
  invert: Role[];
  alignment: { enabled: boolean; tempC: number; distancesM: [number, number, number, number] };
  protection: { enabled: boolean; thresholdDb: Partial<Record<Role, number>> }; // missing = 0 dB
  environment: { id: EnvironmentId; lowDb: number; highDb: number };
}
```

`distancesM` is indexed by output (Out 1 to Out 4); entries for spare outputs are ignored.

### 1.2 Layouts

Each layout assigns every output a role, a side (`L`, `R` or `mono`) and a frequency band
index (0 = lowest band). Spare outputs have no role.

| Layout | Out 1 | Out 2 | Out 3 | Out 4 | Default crossovers |
|---|---|---|---|---|---|
| `2.0` | Main L (main, L, 0) | Main R (main, R, 0) | Fill L (fill, L, 0) | Fill R (fill, R, 0) | none |
| `2.1` | Top L (top, L, 1) | Top R (top, R, 1) | Sub (sub, mono, 0) | Spare | 100 Hz |
| `2.2` | Top L (top, L, 1) | Top R (top, R, 1) | Sub L (sub, L, 0) | Sub R (sub, R, 0) | 100 Hz |
| `top-kick-sub` | Top L (top, L, 2) | Top R (top, R, 2) | Kick (kick, mono, 1) | Sub (sub, mono, 0) | 90, 180 Hz |
| `top-kick-sub-mono` | Top (top, mono, 2) | Kick (kick, mono, 1) | Sub (sub, mono, 0) | Spare | 90, 180 Hz |
| `biamp` | Low L (low, L, 0) | High L (high, L, 1) | Low R (low, R, 0) | High R (high, R, 1) | 1600 Hz |
| `4way` | Sub (sub, mono, 0) | Low (low, mono, 1) | Mid (mid, mono, 2) | High (high, mono, 3) | 90, 250, 1600 Hz |

The layout's band count is `crossoversHz.length + 1`. "Lowest-band outputs" have band 0;
"top-band outputs" have the highest band index. In `2.0` every output is both.

Choosing a different layout in the form resets `crossoversHz` to the new layout's defaults
and keeps every other recipe field.

### 1.3 What `buildSetup` produces

`buildSetup(recipe) -> { assignments: ParamAssignment[]; names: Record<number, string>; spare: number[] }`

Ownership rule: a recipe only writes the parameters listed here. Input channels, mute,
PEQ bands 2 to 6, and anything listed as conditional while its switch is off are never
written.

For every **used** (non-spare) output:

- **Routing**: side `L` = A (1), side `R` = B (2), `mono` = A+B (3). With `source: "mono"`
  every used output is A (1).
- **High-pass**: band 0 gets the subsonic filter when `subsonic.enabled`
  (Butterworth 24 at `subsonic.freqHz`), otherwise off. Band `b > 0` gets
  `crossoversHz[b - 1]` with the recipe slope (`LR24` = Linkwitz-Riley 24,
  `LR12` = Linkwitz-Riley 12).
- **Low-pass**: band `b` below the top band gets `crossoversHz[b]` with the recipe slope;
  the top band gets off. When a crossover is off its frequency is set to the factory end of
  the scale (high-pass: lowest, low-pass: highest), matching `defaultEq()`.
- **Gain**: `trimsDb[role] ?? 0`, clamped to the gain ceiling (section 3.6).
- **Polarity**: inverted when `role` is in `invert`.
- **PEQ band 1** (index 0): on lowest-band outputs, a low shelf at the environment's low
  frequency with gain `environment.lowDb`; on other outputs, `defaultBand` at the factory
  band 1 frequency (flat).
- **PEQ band 7** (index 6): on top-band outputs, a high shelf at the environment's high
  frequency with gain `environment.highDb`; on other outputs, `defaultBand` at the factory
  band 7 frequency (flat).
  Shelves use Q 0.7 and `bypass: false`.
- **Delay** (only when `alignment.enabled`): speed of sound
  `c = 331.3 + 0.606 * tempC` m/s; `d_max` = largest distance among used outputs;
  `delayMs = (d_max - d_i) / c * 1000`.
- **Compressor** (only when `protection.enabled`): ratio `Limit`, knee 0 dB, threshold
  `thresholdDb[role] ?? 0`, attack/release by role:
  sub, low: 20 / 400 ms; kick, mid: 10 / 200 ms; main, fill: 5 / 200 ms; top, high: 2 / 100 ms.

For every **spare** output: routing 0 (silent). Nothing else.

`names` maps each output address to its display name from the layout table ("Top L",
"Spare", ...). `spare` lists spare output addresses (used to offer hiding them).

### 1.4 Environments

| Id | Low shelf (band 1) | High shelf (band 7) |
|---|---|---|
| `neutral` | 0 dB at 60 Hz | 0 dB at 10 kHz |
| `indoor` | -3 dB at 60 Hz | -1 dB at 10 kHz |
| `outdoor` | +3 dB at 60 Hz | +2 dB at 8 kHz |
| `club` | +4 dB at 60 Hz | +1.5 dB at 10 kHz |
| `speech` | -6 dB at 150 Hz | +2 dB at 4 kHz |
| `background` | +3 dB at 100 Hz | +2 dB at 8 kHz |

Picking an environment chip fills `lowDb` / `highDb` with its defaults; the user can then
edit them. The shelf frequencies come from the environment id and are not edited in the
form.

### 1.5 Validation (`checkRecipe`)

Returns a list of readable problems (empty = valid). Apply is disabled while non-empty.

- `version` is 1; `layout`, `source`, `slope`, `environment.id` are known values.
- `crossoversHz.length` equals the layout's split count; each is within 20 Hz to 20 kHz;
  each is at least 1/3 octave above the previous one.
- `subsonic.freqHz` within 20 to 80 Hz.
- Trims within the gain range; protection thresholds within the compressor threshold range;
  `lowDb` / `highDb` within +-12 dB.
- `alignment.tempC` within -20 to 45 C; distances within 0 to 250 m; every resulting delay
  at most 680 ms.
- `invert` only contains roles of the chosen layout (others are ignored with no error).

### 1.6 Review and apply

- `describeChanges(model, assignments, cal) -> string[]`: normalizes each assignment the same
  way the editor does and keeps only those that differ from the model. One line per changed
  parameter, using the display name, e.g.
  `Out 3 high-pass: Off -> 90 Hz, Linkwitz-Riley 24`,
  `Out 1 PEQ band 1: Peak 40 Hz 0.0 dB -> Low shelf 60 Hz +3.0 dB`,
  `Out 3 routing: A -> A+B`, `Out 3 gain: 0.0 dB -> -6.0 dB`,
  `Out 2 delay: 0.00 ms -> 2.35 ms`, `Out 1 limiter: 1:1.0 at 20 dB -> Limit at 0 dB`,
  `Out 4 polarity: normal -> inverted`.
- `device.applySetup(recipe)`: runs `buildSetup`, calls `editor.setMany("Setup: <layout name>",
  assignments)`, then writes `names` into the display-name settings. The user is offered
  (inline, not a dialog) to hide the spare outputs. Works offline (edits are tracked as not
  sent, like any edit). It does not store to a device slot.

### 1.7 Library and files (`setup/library.ts`)

- Built-in presets: one per layout with `neutral` environment and default parameters, plus
  named combinations: "2.1 Outdoor", "2.1 Indoor", "Top/Kick/Sub Outdoor",
  "Top/Kick/Sub Club", "2.0 Speech". Built-ins are read-only.
- Custom presets: `{ id, name, recipe }[]` in `localStorage` key
  `opendsp-4x4.setup-presets`. Save as (name prompt inline), Delete (with confirm).
- The form draft is stored in `opendsp-4x4.setup-draft` so a reload keeps it. A stored draft
  that is not valid JSON, has `version` other than 1, or has an unknown `layout` is replaced
  by the default recipe. Any other draft is loaded as is, with its `checkRecipe` problems
  shown on the fields.
- File format: `{ "format": "opendsp-4x4/setup", "version": 1, "name": string, "recipe": Recipe }`,
  extension `.setup.json`. Import is strict: wrong format/version or a failing `checkRecipe`
  rejects the file with the list of problems. Export and import reuse `ui/files.ts`
  (works on desktop and through the Android file bridge).

### 1.8 Setup tab UI (`views/SetupView.svelte`)

Tab between Overview and In A, hash `#setup`, key `s`. Two columns at >= 900 px (form left,
preview and review right), one column below.

1. Preset bar: preset select (built-ins, then custom), Save as..., Export, Import, Delete.
2. Layout cards (`setup/LayoutCard.svelte`): name and a small SVG of inputs A/B feeding four
   output boxes labelled by role and coloured by band; spare outputs greyed.
3. System: source (stereo A/B or mono A), one log-stepped frequency field per crossover,
   slope select, subsonic switch + frequency, one row per role with trim (dB) and an invert
   toggle.
4. Environment: six chips, Low and High fields.
5. Time alignment (collapsed, switch): temperature, distance per used output, resulting delay
   shown next to each.
6. Protection (collapsed, switch): threshold per role, with a note: set it just below the
   level where the amplifier or speaker distorts.
7. Preview (`setup/CrossoverPreview.svelte`): each used output's magnitude response, computed
   from the current model with the recipe's assignments applied (so bands 2 to 6 show), in
   the output's colour. Reuses `eq/response.ts`.
8. Review and apply (sticky at the bottom of the tab): "N changes" expandable into the
   `describeChanges` lines, Apply (primary, disabled when invalid or 0 changes), Revert form
   (back to the selected preset). Warning line: "A starting point, not tuned for your
   speakers. Turn amps down before applying."

Field errors from `checkRecipe` are shown next to the field they concern.

---

## 2. Level control

### 2.1 Wheel helper (`ui/wheel.ts`)

Pure logic plus a small `attachWheel(element, onSteps)` DOM wrapper.

- **Hover adjusts**: a wheel event over a registered control changes it without focus.
- **Scroll guard**: the main scroll container (`<main>`) reports scroll events; a wheel event
  over a control is ignored (not prevented, so the page keeps scrolling) when the container
  scrolled within the last 400 ms. Once the user stops on a control, the next wheel event
  adjusts it.
- **Normalization**: `deltaMode` line/page are converted to pixels (line = 40 px, page = 800 px);
  pixel deltas accumulate per element and emit one step per 100 px, so a mouse notch is one
  step and trackpads add up smoothly. When `deltaY` is 0 and `deltaX` is not (Shift+wheel on
  some systems), `deltaX` is used. The accumulator resets after 300 ms of no wheel input.
- **Modifiers**: Shift = x10, Alt = x0.1 (callers clamp to the device resolution). Events with
  Ctrl or Meta are ignored, so browser zoom keeps working.
- `preventDefault` is called only when a step is handled.
- The clock and the "last container scroll" time are injectable for tests.

Used by `NumberField` (replaces its focus-only wheel), `Fader`, the EQ graph band handles
(Q), and the master trim.

### 2.2 Fader (`ui/Fader.svelte`, `ui/faderTaper.ts`)

- Horizontal (channel pages, replaces the native range in `ChannelControls`) and vertical
  (Overview strips).
- Taper: position = continuous raw gain / 400, using the device's two-segment gain curve
  (`faderTaper.ts`: `dbToPosition`, `positionToDb`, continuous, inverse of each other).
  0 dB sits at 70% of travel, -20 dB at 20%.
- Input: pointer drag (pointer capture; Alt = fine), wheel via `attachWheel` with the gain
  step from settings, ArrowUp/Right and ArrowDown/Left = one step, PageUp/PageDown = x10,
  double-click = 0 dB. Every gesture ends with `device.seal()`.
- Ticks at +12, +6, 0, -6, -12, -20, -40, -60 dB. Delivery status shown as the coloured
  edge already used by `NumberField`. `role="slider"` with `aria-valuetext` like "-3.5 dB".
- Shows a warning colour when the value is above the gain ceiling (section 3.6).

### 2.3 Mixer-style Overview

- Each strip: name, vertical `Fader` with the `Meter` beside it, value field, Mute, polarity,
  and for outputs a Solo (S) toggle, then the existing summary line. Strip height about
  220 px on desktop, about 140 px below 760 px width.
- Master strip after the outputs: -1 / +1 dB buttons, wheel and vertical drag area.
  `device.trimOutputs(deltaDb)` shifts all four output gains by the delta, each clamped to
  the gain range and ceiling. One gesture = one undo step "Trim outputs" (see 2.5). If any
  output was clamped, the strip shows "limit reached" until the next gesture.
- Hidden channels (section 3) are left out.

### 2.4 Mute all and solo (`state/solo.ts`)

- Top bar button "Mute all" toggles to "Unmute all".
  - `muteAll()`: snapshots the four output mute states, sets all four to muted, one undo
    step "Mute all".
  - `unmuteAll()`: restores the snapshot, treating unknown (null) as unmuted; without a
    snapshot (after a reload) unmutes all four. One undo step "Unmute all".
- Solo (outputs only), state in the store, not persisted:
  - On the first solo, snapshot the four output mute states.
  - While the solo set is non-empty: soloed outputs unmuted, the others muted.
  - When the last solo is turned off: restore the snapshot (null = unmuted).
  - Each solo change is one undo step ("Solo Out 3", "Solo off").
  - Solo state is cleared (without restoring) on preset recall, resync, connect, disconnect,
    and on undo/redo.
  - Soloed outputs show an "S" badge on their tab.
- `solo.ts` is pure: given the solo set, the snapshot and the outputs, it returns the
  mute assignments.

### 2.5 Editor change

`Editor.setMany(label, assignments, options?: { mergeKey?: string })`: when a merge key is
given, it is passed to `History.record`, so consecutive calls with the same key within the
merge window and before `seal()` form one undo step. Without it, behaviour is unchanged.

### 2.6 Not in this round

L/R gain linking (the master trim covers the main need) and a clip indicator (it is not
known whether a full-scale meter reading means digital clipping).

---

## 3. Personalization (Settings tab)

### 3.1 Storage

- `state/settings.ts` (pure): `Settings` type, `DEFAULT_SETTINGS`, and
  `parseSettings(unknown): Settings`, which validates field by field and replaces any
  missing, mistyped or out-of-range field with its default (never throws).
- `state/settings.svelte.ts`: reactive wrapper; loads from `localStorage` key
  `opendsp-4x4.settings` (with `version: 1`), saves on every change. Settings belong to the
  browser, not to a device. Android's WebView has DOM storage enabled.

### 3.2 Settings and defaults

| Group | Setting | Values (default in bold) |
|---|---|---|
| Channels | Display name per channel | text up to 16 chars; **empty** = device name |
| Channels | Colour per channel | 12-colour palette; **current `--ch-N` colours** |
| Channels | Hidden channels | set of addresses; **none** |
| Controls | Gain step per notch / arrow | 0.1, **0.5**, 1, 3 dB |
| Controls | Frequency step | **1/30**, 1/12, 1/6, 1/3 octave |
| Controls | EQ width shown as | **Q**, bandwidth (octaves) |
| Controls | EQ graph range | +-12, **+-18**, +-24 dB |
| Meters | Peak hold | off, **1.2 s**, 3 s |
| Appearance | Theme | **dark**, light, system |
| Appearance | Density | compact (24 px), **comfortable (28 px)**, touch (40 px) |
| Appearance | Text size | small (12 px), **normal (13 px)**, large (15 px) |
| Units | Distance | **m**, ft |
| Units | Temperature | **C**, F |
| Safety | Output gain ceiling | **off**, or a value in the gain range |
| Startup | Open on | **last view**, Overview |

Plus "Reset to device names" (clears display names) and "Reset all settings".

### 3.3 Display names, colours, hiding

- A single helper `displayName(ch)` returns the display name or the device name. It is used
  everywhere channel names are shown, including undo labels and review lines.
- Colours are applied by setting the `--ch-N` CSS variables from settings.
- Hidden channels are removed from the tab strip and the Overview. A hidden channel's page is
  still reachable by URL hash or number key, with a "Hidden. Show" notice.

### 3.4 Theme and density

- `theme.css` gets a light palette under `[data-theme="light"]`; "system" follows
  `prefers-color-scheme`. Hard-coded colours in `EqGraph.svelte`, `Meter.svelte` and
  `EqTable.svelte` move to theme variables.
- Density sets `--control-h` (24 / 28 / 40 px) and matching gaps; text size sets the root
  font size.

### 3.5 Units

Distance and temperature settings only affect how Setup's time-alignment fields are shown
and entered; recipes always store metres and degrees Celsius.

### 3.6 Output gain ceiling

When set, every UI path that sets an output gain (fader, field, wheel, master trim, Setup
trims) clamps to it, in `DeviceStore`. Values already above it (from a recall or file import)
are not changed; their fader and field show the warning colour.

### 3.7 Settings tab UI (`views/SettingsView.svelte`)

Tab after System, hash `#settings`. Sections in the order of the table above, using the
existing `Section` component; every control applies immediately.

---

## 4. Code layout

New pure modules (unit-tested):

- `web/src/setup/recipe.ts`: types, layout and environment tables, defaults, `checkRecipe`.
- `web/src/setup/build.ts`: `buildSetup`.
- `web/src/setup/review.ts`: `describeChanges`.
- `web/src/setup/library.ts`: built-ins, custom preset storage, file parse/serialize.
- `web/src/state/settings.ts`: settings schema, defaults, `parseSettings`.
- `web/src/state/solo.ts`: mute-all and solo assignment logic.
- `web/src/ui/wheel.ts`: wheel normalization, accumulation, guard.
- `web/src/ui/faderTaper.ts`: dB and fader position conversion.

New UI files:

- `web/src/views/SetupView.svelte`, `web/src/views/SettingsView.svelte`
- `web/src/setup/LayoutCard.svelte`, `web/src/setup/CrossoverPreview.svelte`
- `web/src/ui/Fader.svelte`
- `web/src/state/settings.svelte.ts`

Changed:

- `state/editor.ts`: `setMany` merge key.
- `state/device.svelte.ts`: `applySetup`, `trimOutputs`, `muteAll` / `unmuteAll`, solo,
  `displayName`, gain ceiling; clear solo on recall/resync/connect/disconnect/undo/redo.
- `state/viewHash.ts`, `state/ui.svelte.ts`, `App.svelte`: `setup` and `settings` views,
  `s` key, startup view setting.
- `views/Overview.svelte`: mixer strips, master strip.
- `channel/ChannelControls.svelte`: `Fader`.
- `ui/NumberField.svelte`: hover wheel via `attachWheel`.
- `channel/EqGraph.svelte`: wheel guard, graph range setting, theme variables.
- `channel/EqTable.svelte`: frequency step and Q/bandwidth settings.
- `ui/Meter.svelte`: peak hold from settings.
- `shell/TopBar.svelte`: Mute all.
- `shell/ChannelTabs.svelte`: Setup and Settings tabs, hidden channels, display names, solo
  badge.
- `theme.css`: light theme, density and text-size variables.

## 5. Testing

`npm test` (node `--test`, pure `.ts` only) gains:

- Recipes: for every layout, the expected routing masks, high/low-pass slots and slopes,
  gains and polarity; bands 2 to 6 and input channels never appear; delay only with
  alignment on; compressor only with protection on; spare outputs only get routing 0;
  `source: "mono"` routes A only.
- Alignment maths (speed of sound, farthest-speaker reference) and the 680 ms limit.
- Environment shelves on the right outputs, flat bands elsewhere.
- `checkRecipe` for each rule in 1.5.
- `describeChanges` text and "no change" filtering after normalization.
- Library: custom preset file round trip; wrong format, wrong version and invalid recipe are
  rejected with problems listed.
- `parseSettings`: corrupt JSON, wrong types and out-of-range values fall back per field.
- Wheel: pixel/line/page normalization, accumulation to steps, reset timeout, guard window,
  modifiers, Ctrl/Meta ignored.
- Fader taper: `positionToDb(dbToPosition(x))` returns `x` across the range; 0 dB at 0.7.
- Editor: `setMany` with a merge key merges into one undo step and splits after `seal()`.
- Solo and mute all: snapshot, solo set changes, restore with null treated as unmuted.

Also: `npm run typecheck` passes, and a manual pass against the simulated device (`?mock`)
covering each new control.

## 6. Hardware check

Before fixing the default trim for summed (mono from stereo) outputs: with a signal on A and
B, compare an output's meter reading with routing A alone and A+B. If A+B reads about 6 dB
hotter, the 2.1 / 2.2-mono / Top-Kick-Sub defaults set `trimsDb.sub` (and `kick`) to -6 dB;
otherwise 0 dB.

## 7. Build order

Each step is usable on its own and committed separately.

1. Settings store (`settings.ts`, `settings.svelte.ts`) and `wheel.ts`; hover wheel in
   `NumberField` and the EQ graph handles.
2. `faderTaper.ts`, `Fader`, editor merge key, mixer Overview, master trim, mute all, solo.
3. Pure Setup modules (`recipe`, `build`, `review`, `library`) with tests.
4. Setup tab UI, custom presets and files.
5. Settings tab, theme, density, text size, display names, colours, hiding, gain ceiling,
   units, startup view.

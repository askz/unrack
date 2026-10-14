# Setup presets and Settings tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build stages 3 to 5 of `docs/superpowers/specs/2026-10-14-ui-ux-presets-levels-settings-design.md`: pure Setup modules, the Setup tab, and the Settings tab with everything it controls.

**Architecture:** A recipe (plain data) goes through pure modules (`setup/recipe.ts`, `setup/build.ts`, `setup/review.ts`, `setup/library.ts`) that produce `ParamAssignment[]`, review lines and file text; the UI only wires them to `device` (one `setMany` undo step) and to the settings store. Settings already exist (`state/settings.ts`); stage 5 makes every setting take effect and adds the tab.

**Tech Stack:** Svelte 5 runes, TypeScript 5.7 (erasable syntax only in `.ts` tested by node), Vite 6, `node --experimental-strip-types --test`.

## Global Constraints

- Tests load only plain `.ts` (no `.svelte`, no `.svelte.ts`): all logic lives in pure modules.
- No enums, namespaces or parameter properties in `.ts` files.
- Every device edit goes through `Editor` (`set` / `setMany`); nothing adds a device command.
- `npm run typecheck` must pass with 0 errors and 0 warnings (`--fail-on-warnings`).
- Storage keys: `opendsp-4x4.settings` (exists), `opendsp-4x4.setup-presets`, `opendsp-4x4.setup-draft`, `opendsp-4x4.last-view`.
- Setup file: `{ "format": "opendsp-4x4/setup", "version": 1, "name": string, "recipe": Recipe }`, extension `.setup.json`.
- No em dashes in new UI copy.

## Decisions taken while planning (spec gaps)

- `checkRecipe` always checks types, but checks the ranges of subsonic, alignment and protection only while their switch is on, so a collapsed, switched-off section never blocks Apply.
- `checkRecipe` returns `{ field, message }[]` so the form can show each problem next to its field. Field keys: `layout`, `source`, `slope`, `crossoversHz.<i>`, `subsonic.freqHz`, `trimsDb.<role>`, `invert`, `alignment.tempC`, `alignment.distancesM.<out index>`, `alignment.delay`, `protection.thresholdDb.<role>`, `environment.id`, `environment.lowDb`, `environment.highDb`, `version`, `recipe`.
- A stored draft with a valid version and layout but wrong-typed fields gets those fields from the default recipe (`coerceRecipe`), so the form never renders a missing object; out-of-range values are kept and shown as problems.
- Custom presets that no longer pass `checkRecipe` are dropped when loading; Save as is disabled while the draft has problems.
- Review lines include Q for PEQ bands, so a Q-only change is visible.
- Startup view: a URL hash always wins (reload keeps the view). Without a hash, "last view" opens the view stored in `opendsp-4x4.last-view`, "Overview" opens the Overview.
- Hidden channels leave the tab strip, the Overview strips and the routing rows; the routing matrix keeps all four input columns so no active route disappears.
- Hardware check (spec section 6) has not been done: summed outputs keep a 0 dB default trim.

## File map

Create:
- `web/src/setup/recipe.ts`: types, `LAYOUTS`, `ENVIRONMENTS`, `ROLE_NAMES`, `defaultRecipe`, `withLayout`, `withEnvironment`, `usedOutputs`, `layoutRoles`, `alignmentDelaysMs`, `speedOfSound`, `checkRecipe`, `coerceRecipe`.
- `web/src/setup/build.ts`: `buildSetup`.
- `web/src/setup/review.ts`: `previewModel`, `describeChanges`.
- `web/src/setup/library.ts`: `BUILTIN_PRESETS`, custom preset and draft storage, setup file parse/serialize.
- `web/src/setup/draft.svelte.ts`: reactive form state (draft, selected preset, custom list).
- `web/src/setup/LayoutCard.svelte`, `web/src/setup/CrossoverPreview.svelte`, `web/src/views/SetupView.svelte`.
- `web/src/ui/appearance.ts`: pure `appearanceVars(settings)` (CSS variables and theme attribute).
- `web/src/views/SettingsView.svelte`.
- Tests: `web/test/recipe.test.ts`, `web/test/build.test.ts`, `web/test/review.test.ts`, `web/test/library.test.ts`, `web/test/appearance.test.ts`.

Modify:
- `state/params.ts`: `describeParam(ref, nameOf?)`.
- `state/editor.ts`: `EditorDeps.channelName?`, used by every label.
- `state/device.svelte.ts`: `displayName`, gain ceiling clamp, `applySetup`.
- `state/viewHash.ts`, `state/ui.svelte.ts`, `App.svelte`, `shell/ChannelTabs.svelte`: `setup` and `settings` views, `s` key, hidden channels, startup view.
- `views/Overview.svelte`, `views/OutputView.svelte`, `views/InputView.svelte`, `channel/ChannelControls.svelte`, `channel/OutputSignal.svelte`, `channel/MasterTrim.svelte`: display names, hidden channels, ceiling warning.
- `ui/NumberField.svelte`: `warn` prop.
- `channel/EqGraph.svelte`, `channel/EqTable.svelte`, `ui/Meter.svelte`, `ui/Toggle.svelte`, `theme.css`: theme variables, light theme, density, EQ settings.

---

### Task 1: Recipe model and validation (`setup/recipe.ts`)

**Interfaces (produces):**
- `type LayoutId`, `type Role`, `type EnvironmentId`, `interface Recipe` exactly as spec 1.1.
- `interface OutputSlot { role: Role; side: "L" | "R" | "mono"; band: number; name: string }`
- `interface Layout { id: LayoutId; name: string; outputs: readonly (OutputSlot | null)[]; crossoversHz: readonly number[] }` (4 outputs, `null` = spare)
- `LAYOUTS: Readonly<Record<LayoutId, Layout>>`, `LAYOUT_IDS: readonly LayoutId[]`
- `interface Environment { id; name; lowHz; highHz; lowDb; highDb }`, `ENVIRONMENTS`, `ENVIRONMENT_IDS`
- `ROLE_NAMES: Readonly<Record<Role, string>>`
- `defaultRecipe(layout: LayoutId = "2.1"): Recipe`
- `withLayout(recipe, layout): Recipe` (resets crossovers only), `withEnvironment(recipe, id): Recipe` (fills low/high dB)
- `usedOutputs(layout): { ch: number; slot: OutputSlot }[]`, `spareOutputs(layout): number[]` (addresses)
- `layoutRoles(layout): Role[]` (distinct, in output order)
- `speedOfSound(tempC): number`, `alignmentDelaysMs(recipe): (number | null)[]` (per output, null = spare)
- `interface RecipeProblem { field: string; message: string }`, `checkRecipe(raw: unknown): RecipeProblem[]`
- `coerceRecipe(raw: unknown): Recipe | null` (null = invalid JSON shape, wrong version or unknown layout)

- [ ] Step 1: write `test/recipe.test.ts`: every layout has 4 outputs and `crossoversHz.length + 1` bands covering 0..n; `withLayout` resets crossovers and keeps trims; `withEnvironment("outdoor")` gives +3 / +2; speed of sound 343.42 m/s at 20 C; delays: farthest speaker 0 ms, a speaker 3.43 m closer about 10 ms, spare null; `checkRecipe(defaultRecipe(id))` empty for every layout; one failing test per rule of spec 1.5 (bad version, unknown layout, wrong crossover count, crossover out of range, crossovers closer than 1/3 octave, subsonic out of range only when enabled, trim out of range, threshold out of range only when enabled, shelf over 12 dB, temperature, distance, delay over 680 ms, a role not in the layout in `invert` is not an error); `coerceRecipe` returns null for wrong version or layout and repairs a wrong-typed `alignment`.
- [ ] Step 2: run `node --experimental-strip-types --test test/recipe.test.ts`, expect failure (module missing).
- [ ] Step 3: implement `setup/recipe.ts`.
- [ ] Step 4: run the test, expect pass.
- [ ] Step 5: commit `setup: recipe model, layouts, environments and validation`.

### Task 2: Building assignments (`setup/build.ts`)

**Interfaces:**
- Consumes Task 1.
- Produces `buildSetup(recipe: Recipe, options?: { gainCeilingDb?: number | null }): { assignments: ParamAssignment[]; names: Record<number, string>; spare: number[] }`.

- [ ] Step 1: write `test/build.test.ts`: for every layout, the routing masks, hpf/lpf slopes and frequencies per band; `source: "mono"` routes A only; spare outputs get only routing 0; no input channel, mute or PEQ band 2-6 ref appears; band 1 low shelf only on lowest-band outputs, band 7 high shelf only on top-band outputs, flat defaults elsewhere; trims and polarity by role; ceiling clamps trims; delay refs only with alignment on; comp refs only with protection on, with ratio Limit and the role's times; subsonic sets Butterworth 24 on band-0 outputs.
- [ ] Step 2: run, expect failure.
- [ ] Step 3: implement.
- [ ] Step 4: run, expect pass.
- [ ] Step 5: commit `setup: build device assignments from a recipe`.

### Task 3: Review lines and preview (`setup/review.ts`)

**Interfaces:**
- `previewModel(model: DeviceModel, assignments: ParamAssignment[], cal: Calibration): DeviceModel` (clone, normalize each value like the editor, write).
- `describeChanges(model, assignments, cal, nameOf?: (ch: number) => string): string[]`, one line per parameter whose normalized value differs.

- [ ] Step 1: write `test/review.test.ts`: routing `A → A+B`, gain `0.0 dB → -6.0 dB`, high-pass `Off → 90 Hz, Linkwitz-Riley 24` (frequency after device quantization), PEQ band text, delay `0.00 ms → 2.35 ms`, polarity, comp; an assignment equal to the model after normalization gives no line; `nameOf` changes the channel name; `previewModel` leaves the input model untouched.
- [ ] Step 2 to 4: fail, implement, pass.
- [ ] Step 5: commit `setup: review lines and preview model`.

### Task 4: Library, storage and files (`setup/library.ts`)

**Interfaces:**
- `interface SetupPreset { id: string; name: string; recipe: Recipe; builtin: boolean }`
- `BUILTIN_PRESETS: readonly SetupPreset[]` (one per layout plus the five named ones)
- `loadCustomPresets(storage: StorageLike | null): SetupPreset[]`, `saveCustomPresets(storage, presets): boolean`
- `loadDraft(storage): Recipe | null`, `saveDraft(storage, recipe): boolean`
- `serializeSetupFile(name, recipe): string`, `setupFileName(name): string`, `parseSetupFile(text): { name: string; recipe: Recipe }` throwing `SetupFileError` with `issues: string[]`
- `newPresetId(existing: readonly SetupPreset[]): string`

- [ ] Step 1: write `test/library.test.ts`: every built-in passes `checkRecipe` and ids are unique; custom round trip through a fake storage; corrupt storage gives `[]`; an invalid stored preset is dropped; draft round trip and corrupt draft gives null; file round trip; wrong format, wrong version, invalid JSON and a failing recipe are rejected with issues.
- [ ] Step 2 to 4: fail, implement, pass.
- [ ] Step 5: commit `setup: built-in and custom presets, draft storage and setup files`.

### Task 5: Display names, gain ceiling and `applySetup` in the store

**Interfaces:**
- `describeParam(ref: ParamRef, nameOf: (ch: number) => string = channelLabel)`.
- `EditorDeps.channelName?(ch: number): string`; the editor uses it for every label (set, copy, link, errors).
- `device.displayName(ch): string` = settings name or device name.
- `device.gainCeiling: number | null`; `setGainDb` and `trimOutputs` clamp output gains to it; `aboveCeiling(ch): boolean`.
- `device.applySetup(recipe: Recipe, layoutName: string): { spare: number[] }`.

- [ ] Step 1: add a state test: an editor with `channelName` labels its undo step with that name.
- [ ] Step 2: implement params/editor change, run all tests.
- [ ] Step 3: implement the store changes, replace every `channel.name` / `device.ch(x).name` in views with `device.displayName(x)`, pass the ceiling to `MasterTrim` and add `warn` to `NumberField`.
- [ ] Step 4: typecheck and tests.
- [ ] Step 5: commit `state: display names in labels, output gain ceiling, applySetup`.

### Task 6: Setup tab

- [ ] Step 1: `viewHash` gets `setup` and `settings` (test in `misc.test.ts` style: round trip of both hashes); `App.svelte` key `s` opens Setup; tab strip shows Setup after Overview and Settings after System.
- [ ] Step 2: `setup/draft.svelte.ts`, `LayoutCard.svelte`, `CrossoverPreview.svelte`, `SetupView.svelte` per spec 1.8.
- [ ] Step 3: typecheck, tests, build.
- [ ] Step 4: commit `ui: Setup tab with layouts, environments, alignment, protection, preview and review`.

### Task 7: Appearance (theme, density, text size, colours)

**Interfaces:** `appearanceVars(s: Settings, prefersLight: boolean): { theme: "dark" | "light"; vars: Record<string, string> }`.

- [ ] Step 1: write `test/appearance.test.ts`: density maps to `--control-h` 24/28/40, text size to `font-size` 12/13/15, colours to `--ch-N`, "system" follows the flag.
- [ ] Step 2 to 4: fail, implement, pass; `App.svelte` applies the result to `document.documentElement` in an `$effect`.
- [ ] Step 5: light palette in `theme.css`; hard-coded colours in `EqGraph`, `Meter`, `EqTable`, `Toggle`, `ChannelTabs`, `SystemView` move to variables.
- [ ] Step 6: commit `ui: themes, density, text size and channel colours from settings`.

### Task 8: Remaining settings take effect, Settings tab

- [ ] Step 1: EQ settings: `EqTable` frequency step from `freqStepDivisions`, Q or bandwidth column from `eqWidth`; `EqGraph` range from `eqRangeDb`.
- [ ] Step 2: hidden channels in tabs, Overview strips and routing rows; "Hidden. Show" notice on a hidden channel's page.
- [ ] Step 3: startup view (`ui.svelte.ts` stores the last view; first view resolved from hash, setting and stored value). Pure resolver `initialView(hash, startView, stored)` in `viewHash.ts` with a test.
- [ ] Step 4: `SettingsView.svelte` with every setting of spec 3.2, "Reset to device names", "Reset all settings" (inline confirm).
- [ ] Step 5: typecheck, tests, build; commit `ui: Settings tab; EQ, hiding and startup settings take effect`.

### Task 9: Manual verification (`?mock`)

- [ ] Setup: each layout card fills the form; environment chips fill the shelves; a bad crossover shows its error and disables Apply; Apply is one undo step and renames outputs; spare hide offer works; Save as, Delete, Export, Import (good file, bad file) work; reload keeps the draft.
- [ ] Settings: each control changes the UI immediately and survives a reload; light theme readable on every view; ceiling clamps fader, field, wheel, master trim and Setup trims, and shows the warning colour on values above it.
- [ ] `git status --short` shows only the user's own files.

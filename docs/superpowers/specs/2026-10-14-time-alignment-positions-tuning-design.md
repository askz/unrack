# Time alignment round 2: positions, live diagram, by-ear tuning

Date: 2026-10-14. Status: approved design, ready for an implementation plan.

Builds on the Setup tab's time alignment (spec `2026-10-14-ui-ux-presets-levels-settings-design.md`,
section 1). Three additions, mainly for outdoor systems and clubs:

1. **Positions**: speakers and the crowd are described in a side view (distance from the stage
   edge, height), so a sub on the floor and flown or stand-mounted tops are computed correctly.
2. **Live diagram**: an SVG side view with the alignment point, the sound paths and a strip
   showing where in the crowd sub and tops add up or cancel at the crossover.
3. **By-ear fine tuning**: a guided polarity-null session with the device's sine generator that
   stores a per-output offset on top of the geometry.

No new device command. All device edits go through the existing `Editor`.

## Background (research summary)

- Geometric alignment delays the nearer source by the path difference divided by the speed of
  sound, measured from the alignment point to each acoustic centre. With heights, the path is
  the hypotenuse of the horizontal distance and the height difference.
- Alignment is exact at one point only. Around it, sources stay coupled while their phase offset
  at the crossover is under 120 degrees, and within 3 dB of full summation under 90 degrees
  (at 100 Hz: about +-1.3 ms, +-40 cm). The point should be chosen to keep the most audience
  coupled (Merlijn van Veen, "Sub Align", "Displacement is Key").
- Matching Linkwitz-Riley low-pass and high-pass filters are in phase with each other, so the
  crossover itself needs no compensation. The enclosure and driver delay is unknown and can be
  several ms; distances cannot capture it. A polarity-null test with a sine at the crossover,
  or a dual-channel measurement (REW, Smaart, Open Sound Meter), finds it.
- An audience in front of ground-stacked subs slows their arrival (L-Acoustics, 2024).

Path difference sub (floor, 0.4 m) vs top, horizontal distances equal, 343 m/s, positive = sub
arrives first:

| Listener distance | Top on stand 2.0 m, seated ears 1.2 m | Top flown 4 m, standing ears 1.7 m |
|---|---|---|
| 2 m | 0.00 ms | +1.93 ms |
| 5 m | 0.00 ms | +0.98 ms |
| 10 m | 0.00 ms | +0.52 ms |
| 20 m | 0.00 ms | +0.26 ms |

On a stand the ears sit midway between sub and top, so the heights cancel out. Flown, the
difference changes with listener distance by more than the 100 Hz tolerance. So the height
matters when tops are high, and the choice of alignment point matters as much as the numbers.

---

## 1. Data model: recipe version 2

```ts
type AlignmentMode = "positions" | "direct";

interface SpeakerPosition {
  xM: number;      // distance from the stage edge toward the crowd; negative = behind the edge
  heightM: number; // height of the acoustic centre above the floor
}

interface Alignment {
  enabled: boolean;
  tempC: number;
  mode: AlignmentMode;
  distancesM: [number, number, number, number];   // direct mode, as in version 1
  speakers: [SpeakerPosition, SpeakerPosition, SpeakerPosition, SpeakerPosition];
  crowd: { startM: number; endM: number; earHeightM: number };
  pointM: number | null;                           // alignment point; null = follow the suggestion
  offsetsMs: [number, number, number, number];     // by-ear fine-tune offsets
}
```

All per-output arrays are indexed by output (Out 1 to Out 4); entries of spare outputs are
ignored. `Recipe.version` becomes 2 and `Recipe.alignment` becomes `Alignment`.

Defaults (`defaultRecipe`, and for fields a version 1 recipe lacks):

- `mode: "positions"` for new recipes.
- `speakers`: `xM = 0`; `heightM` by role of the output: sub 0.4, kick 0.6, top 2.0, main 2.0,
  fill 1.5, low/mid/high 1.5. Spare outputs: 0, 1.5.
- `crowd`: start 2 m, end 20 m, ear height 1.7 m.
- `pointM: null`, `offsetsMs: [0, 0, 0, 0]`.

Ranges (new `Range` constants in `recipe.ts`):

| Field | Range |
|---|---|
| `speakers[].xM` | -50 to 250 m |
| `speakers[].heightM` | 0 to 30 m |
| `crowd.startM`, `crowd.endM` | 0 to 250 m, end at least 1 m after start |
| `crowd.earHeightM` | 0.5 to 2.5 m |
| `pointM` | inside the crowd area |
| `offsetsMs[]` | -20 to +20 ms |

Validation (`checkAlignment`) reports each field under its path, e.g.
`alignment.speakers.2.heightM`, `alignment.crowd.endM`, `alignment.pointM`,
`alignment.offsetsMs.2`. Positions fields are only range-checked in positions mode, distances
only in direct mode (as today, only when alignment is enabled). The existing
`alignment.delay` problem (longest delay over 680 ms) covers both modes and includes offsets.

Migration: `upgradeRecipe(raw: unknown): unknown` turns a version 1 object into version 2 by
adding `mode: "direct"` (its distances are kept, so applying it gives the same delays) and the
defaults above; anything else is returned unchanged. `library.ts` calls it before
`checkRecipe` / `coerceRecipe` for stored customs, the stored draft and imported files, so old
presets and files keep working. Exported files are version 2.

## 2. Calculation (`web/src/setup/alignment.ts`, pure, unit tested)

```ts
/** Straight path from a speaker to a listener at distance pointM with ears at earHeightM. */
function pathLengthM(speaker: SpeakerPosition, pointM: number, earHeightM: number): number;
// sqrt((pointM - xM)^2 + (heightM - earHeightM)^2)

/** Geometric delay per output (ms) aligning every used output at pointM; null for spares. */
function geometricDelaysMs(recipe: Recipe, pointM: number): (number | null)[];

/** Final delay per output: geometric (or direct-mode) delay + offset, shifted so the smallest is 0. */
function alignmentDelaysMs(recipe: Recipe): (number | null)[];

interface CoverageSample { xM: number; worstPhaseDeg: number; state: "adds" | "weak" | "cancels" }
interface Coverage { samples: CoverageSample[]; coupledM: number; totalM: number }

function coverage(recipe: Recipe, pointM: number): Coverage | null; // null: no crossover
function suggestedPointM(recipe: Recipe): number | null;            // null: no crossover
function effectivePointM(recipe: Recipe): number;                   // pointM ?? suggested ?? crowd middle
```

Rules:

1. **Delays.** Each used output gets `(longest path - its path) / c * 1000` ms, with
   `c = speedOfSound(tempC)` and the paths taken to `effectivePointM` (positions mode) or the
   direct distances (direct mode). Then its offset is added, and all used outputs are shifted
   by the same amount so the smallest delay is 0. A negative sub offset therefore becomes
   extra delay on the tops. `alignmentDelaysMs` keeps its name and callers (`build.ts`,
   `SetupView`, `checkAlignment`).
2. **Pairs.** For each crossover `k`, the pairs are every used output of band `k` with every
   used output of band `k + 1` (2.1: Sub with Top L and Sub with Top R).
3. **Phase.** At a crowd position `x`, for a pair (a, b) with geometric delays only:
   `dt = (path_a(x) / c + delay_a) - (path_b(x) / c + delay_b)` and
   `phase = 360 * fc_k * dt` degrees, not wrapped. Offsets are left out: they are meant to
   cancel the cabinets' own delay, which the geometry does not know.
4. **Coverage.** The crowd area is sampled every 0.1 m from `startM` to `endM` (at most 501
   samples; a deeper crowd gets an even, slightly larger step). Each sample
   takes the worst `|phase|` over all pairs: up to 90 = "adds", over 90 up to 120 = "weak",
   over 120 = "cancels". `coupledM` = sampled length at 120 or below.
5. **Suggestion.** Every sample position is tried as the alignment point; the one with the
   largest `coupledM` wins, ties going to the position nearest the middle of the crowd.
6. **No crossover** (2.0): `coverage` and `suggestedPointM` return null; the point defaults to
   the middle of the crowd.

## 3. Live diagram (`web/src/setup/AlignmentDiagram.svelte`)

Shown in positions mode, inside the Time alignment section, above the inputs.

- SVG side view: horizontal axis = distance from the stage edge, vertical = height. The scale
  fits all used speakers and the crowd area with a margin; a dashed vertical line marks the
  stage edge.
- Each used output is a small box at (`xM`, `heightM`) in its band colour (`--band-N`).
  Outputs at the same position share one box with a combined label ("Top L + R").
- The crowd area is a strip on the floor coloured per coverage sample: "adds" green
  (`--ok`), "weak" amber (`--warn`), "cancels" red (`--bad`). Without a crossover the strip
  is neutral.
- The alignment point is a marker at ear height on a vertical line. Lines run from each speaker
  box to the marker, labelled with path length and arrival time ("6.12 m, 17.8 ms").
- Interaction: drag the marker along the crowd area (pointer events, clamped to the area,
  snapped to 0.1 m), or focus it and use Left/Right (0.1 m, Shift 1 m). Moving it sets
  `pointM` through `draft.edit`. A "Use suggested" button sets `pointM` back to null; it is
  disabled while the point follows the suggestion.
- Readout under the diagram: "Coupled at 100 Hz: 17.4 of 18.0 m (97%)" (for two crossovers,
  both frequencies are listed) and "Suggested point" or "Moved by you".
- Distances follow the m/ft setting; values are converted at the edges, as in today's table.
- The marker has `role="slider"`, `aria-valuemin/max/now` and `aria-valuetext` with the unit.

Inputs under the diagram:

- Mode choice: "Positions" / "Direct distances". Direct mode shows today's distance table and
  hides the diagram and the crowd fields.
- Speaker table (positions mode): output name, distance from stage edge, height, computed
  delay, offset (read-only with a "Reset" link when not 0).
- Crowd fields: start, end, ear height. Temperature as today.

## 4. Guided by-ear fine tuning

Logic in `web/src/setup/tuning.ts` (pure, unit tested); UI as a panel in the Time alignment
section (`web/src/setup/TuningPanel.svelte`); device calls through `device.svelte.ts`.

### 4.1 Availability

The "Fine-tune by ear" button is enabled when: connected; alignment enabled; the layout has a
crossover; the draft is valid; and the device's output delays equal `alignmentDelaysMs` of the
draft (within one sample), i.e. the setup has been applied. Otherwise its title says which
condition is missing.

### 4.2 Pairs

One pair per crossover: the lower-band output and one upper-band output.

- 2.1: Sub with Top L, or Sub with Top R (user's choice).
- 2.2: Sub L with Top L, then Sub R with Top R.
- Top/Kick/Sub: Kick with Top first, then Sub with Kick.
- Bi-amp: Low L with High L, then Low R with High R.
- 4-way: High with Mid, Mid with Low, Low with Sub.

The adjusted output is the lower-band one; its offset is changed.

### 4.3 Session steps

1. **Intro**: warning "The tone plays at full level. Turn the amplifiers down first." and
   "Stand at the alignment point, 8.4 m from the stage edge." Pair choice. Start button.
2. **Start**: the app saves the current mute, polarity and delay of all four outputs to
   localStorage (`opendsp-4x4.tuning-session`), then in one editor group: mutes every output
   except the pair and inverts the lower output's polarity relative to its current state.
   Then it starts the sine at the `TONE_FREQS` entry nearest to the crossover (log distance).
   It asks: "Only the two speakers of the pair should play. If others play, stop and check."
3. **Adjust**: an offset field (NumberField, wheel enabled) with Earlier / Later buttons,
   0.1 ms per step, 1 ms with Shift. The range is the stored offset +- half a period at the
   tone frequency (+-5 ms at 100 Hz), also clamped to the offset range. Each change sends the
   new delays of all used outputs (rule 1 of section 2) through the same editor group. Text:
   "Make the tone as quiet as possible. The quietest point is the aligned one."
4. **Done**: tone off; mutes and polarities restored to the saved values; delays kept; the
   offset written to the draft (`draft.edit`); the editor group closed as one undo step
   labelled "Fine-tune Sub ↔ Top L"; localStorage entry removed. With more pairs, the panel
   offers the next pair.
5. **Cancel**: tone off; mutes, polarities and delays restored; group closed (net no change);
   offset unchanged; localStorage entry removed.

### 4.4 Interruption

If the page reloads or the device disconnects during a session, the saved entry stays. On the
next connection, a notice in the Setup tab says "A fine-tuning session was interrupted. Restore
the mutes, polarity and delays it changed?" with Restore (applies the saved values as one undo
step "Restore after fine-tuning", tone off) and Dismiss (removes the entry).

### 4.5 Undo grouping

`History` gains `beginGroup(label)` / `endGroup()`: between them, every `record` call merges
into one entry regardless of merge keys and the time window. `Editor` exposes the same pair;
`device` wraps them. Undo of the session entry reverts the delays (mutes and polarity are back
to their original values anyway, so their changes cancel out).

## 5. Limits note (UI text)

One short paragraph in the Time alignment section:

"Distances cannot include the cabinets' own delay; the by-ear fine tuning corrects it at the
alignment point. With an audience in front of ground-stacked subs, the subs arrive a little
later, so slightly less sub delay is often better. A measurement app (REW, Open Sound Meter)
is the reliable check."

## Testing

- `test/alignment.test.ts`: path length; geometric delays (floor sub at 0.4 m vs flown top,
  the table above); offsets with the shift to zero (negative sub offset delays the
  tops); direct mode unchanged from version 1; coverage states at 90/120 degrees; suggestion
  maximizes coupled length and breaks ties toward the middle; no-crossover layout returns null.
- `test/recipe.test.ts`: version 1 upgrade (direct mode, same delays); new field validation
  and paths; delay limit including offsets.
- `test/tuning.test.ts`: pairs per layout; nearest tone index; start assignments (mutes,
  relative polarity); offset range; restore assignments.
- `test/state.test.ts` (history and editor section): a group merges records across time and
  keys into one entry, drops changes that came back, and a cancelled group leaves no entry.
- Manual check in `?mock`: diagram drag and keyboard, suggestion, unit switch, a full tuning
  session (Done and Cancel), reload during a session and restore.

## Hardware checks

- Whether the test tone passes through the output mutes (the session relies on it). If it does
  not, the session must tell the user to switch the other amplifiers off instead.
- That the polarity-null by ear works with the sine level and frequencies of the device.

# Weekly-Only Trend Chart Design

## Context

Codex may return only the seven-day weekly quota without a five-hour window (see `2026-07-12-codex-weekly-only-window-design.md`). In that state QuotaBar does not build a `windowBudget` object, and every part of the window-budget UI — including the weekly trend chart and the forecast — is hidden, because all of it is gated on the presence of a non-learning `windowBudget`.

The weekly trend chart and the forecast are computed purely from weekly data. Only three things genuinely require five-hour data: the "X of Y windows" tile, the converted `currentUsage`, and the five-hour reset markers on the chart. The chart and forecast can therefore be shown for weekly-only snapshots without inventing any five-hour data.

OpenAI may re-introduce the five-hour window at any time, temporarily, permanently, or per account. The design must make five-hour presence purely additive so that repeated toggling never makes the chart appear and disappear.

## Decision

Introduce a second, weaker rendering state alongside the existing full window-budget state. Both states are keyed on data presence, not on provider name, so the behavior is provider-agnostic (in practice only Codex enters the weaker state, because Claude always returns both windows).

- **trend-eligible**: the snapshot has a `weekly` window with a numeric `usedPercent`.
- **full budget** (unchanged): `snap.windowBudget` exists and `snap.windowBudget.learning === false`.

`full budget` always implies `trend-eligible`, because a window budget requires weekly data.

The weekly trend chart and forecast render whenever a snapshot is **trend-eligible**. Full budget already renders them; the new behavior extends rendering to the two non-full trend-eligible states:

1. the five-hour window is absent (`windowBudget === undefined`), and
2. the five-hour window is present but the ratio is still learning (`windowBudget.learning === true`).

Because the chart also renders in both non-full states, five-hour presence only ever *adds* enrichments (the tile, the converted usage, the reset markers, the label upgrade) and never removes the chart. When OpenAI re-introduces the five-hour window, the chart stays in place and upgrades in situ; when the window disappears again, only the enrichments are removed. The persisted five-hour/weekly ratio is never cleared, so a returning five-hour window often satisfies the learning threshold immediately and upgrades straight from `Weekly trend` to `Window budget` without a visible learning phase.

## User Interface

The collapsible section that today shows the window-budget chart renders for every trend-eligible snapshot. Its button label is dynamic:

- **full budget** → `Window budget` (current two-window presentation, unchanged).
- **trend-eligible but not full budget** → `Weekly trend`.

The section body is unchanged: the weekly trend chart plus the forecast row. All UI strings remain English.

The "X of Y windows" tile in the card body is unchanged. It renders only when `snap.windowBudget` exists: the full bar when the ratio is learned, and the existing `still learning…` message during the learning phase. It does not render when the five-hour window is absent. This produces a deliberate, informative asymmetry:

- five-hour absent → `Weekly trend` chart, no tile.
- five-hour present, learning → `still learning…` tile *and* `Weekly trend` chart.
- five-hour present, learned → `Window budget` chart, full tile.

The collapse open/closed preference (`windowBudgetOpen` in `localStorage`) is shared across the label change, so the user's expand/collapse choice survives a five-hour transition.

## Five-Hour Reset Markers

Five-hour reset markers appear only in the full-budget state. They are suppressed whenever the converted budget is unavailable — that is, whenever `windowsPerWeek` is not a number, which is true for both non-full states (five-hour absent and learning).

Suppression happens in the worker: after building the series, if the provider's `windowsPerWeek` is not a number, the worker sets `series.fiveHourResets = []` before returning. The renderer stays unaware of the mode. A window that straddles a five-hour transition and contains real historical markers therefore shows no markers until the full-budget state is reached; the markers reappear together with the tile and the label upgrade. This keeps the `Weekly trend` state free of any five-hour-derived overlay.

## Data Flow

The IPC handler and the analytics worker must pass weekly-only and learning providers through to the series builder.

- **`detailsWindow.ts` `windowBudget:get` filter**: drop the `if (!budget || budget.learning) return []` gate. Keep only the requirement that a `weekly` window with a numeric `usedPercent` exists. Set `windowsPerWeek: full-budget ? budget.windowsPerWeek : null`, so learning and five-hour-absent providers both pass `null`.
- **`analyticsWorker.ts` `WindowBudgetTaskInput.providers[].windowsPerWeek`**: widen from `number` to `number | null`. `WeeklySeriesRequest.windowsPerWeek` is already `number | null` and needs no change.
- **Derived, no new code**: `currentUsage` is built only when `windowsPerWeek` is a number, so a `null` value yields `currentUsage: null` and the tile stays data-less. The forecast is computed purely from weekly inputs and is unaffected.

## Renderer

- **Collapse block** (`windowBudgetCollapseHtml`): render when the snapshot is trend-eligible instead of requiring a non-learning `windowBudget`. Choose the button label from full-budget vs not. Chart and forecast element IDs are unchanged.
- **Hydration** (`hydrateWindowBudgets`): widen the `wanted` filter from `windowBudget && !learning` to trend-eligible. The existing `if (row && d.currentUsage)` guard keeps the tile untouched for non-full snapshots, and the missing `wb-row` element is a safe no-op.
- **Tile** (`windowBudgetRowHtml`): no change. It already returns empty markup without a `windowBudget`.
- **Shared predicate**: add a `hasWeeklyTrend(snap)` helper (weekly window with numeric `usedPercent`) and reuse it in both the collapse gate and the hydration filter.

## Error Handling

The Codex endpoint remains unofficial and defensive. No five-hour data is fabricated for weekly-only snapshots. When the five-hour window returns, duration-based classification restores the learned ratio and full presentation automatically. Payload-shape logging remains metadata-only and must not expose tokens, authorization headers, cookies, JWTs, account identifiers, or raw payload contents.

## Tests

Add regression coverage for:

1. A weekly-only provider request (`windowsPerWeek: null`) yields a series with weekly `points`, `currentUsage: null`, and empty `fiveHourResets`.
2. A learning provider (`windowsPerWeek: null`, five-hour data present in logs) also yields empty `fiveHourResets` and `currentUsage: null`.
3. A two-window provider request is unchanged: `currentUsage` present and `fiveHourResets` preserved.
4. The `windowBudget:get` input construction includes a weekly-present provider without a non-learning budget, mapping it to `windowsPerWeek: null`, while a genuinely absent weekly window is still excluded.

After implementation, run `npm test` and `npm run build`. Because the renderer changes, verify in a real Electron window per `TESTING.md`: a weekly-only Codex fixture (shows `Weekly trend` chart, no tile, no markers) and a normal two-window card (unchanged `Window budget` chart with tile and markers).

## Scope

This change does not add the "X of Y windows" tile to weekly-only snapshots, does not reconstruct a converted budget from a stale ratio, does not delete historical data, does not alter Claude quota semantics, and does not change subscription pricing or cost calculations. It does introduce one intentional behavior change beyond weekly-only Codex: the weekly trend chart now also renders during the initial ratio-learning phase for any provider, where previously only the `still learning…` tile appeared.

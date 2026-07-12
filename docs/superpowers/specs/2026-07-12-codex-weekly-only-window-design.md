# Codex Weekly-Only Window Design

## Context

OpenAI currently exposes the unchanged seven-day Codex quota without a five-hour quota for affected accounts. The unofficial usage payload may place that seven-day window in `rate_limit.primary_window`. QuotaBar currently assumes that `primary_window` always means five hours, which causes a seven-day countdown to be labeled as `5-Hour`.

The change may be temporary, permanent, or rolled out per account. QuotaBar must therefore support both the established two-window payload and a weekly-only payload without a rollout-specific feature flag.

## Decision

Codex quota windows are classified by `limit_window_seconds`, not by their `primary_window` or `secondary_window` position:

- `18_000` seconds maps to `fiveHour`.
- `604_800` seconds maps to `weekly`.
- A window without a recognized duration is not assigned a known quota-window name.

Both API slots are processed independently. Normalized windows retain a stable semantic order: `fiveHour` before `weekly` when both exist.

If two source windows classify as the same type, QuotaBar keeps the more complete candidate. Completeness is determined by the presence of usage percentage, reset time, and duration, in that order. This prevents duplicate UI rows while preserving the most useful data.

The legacy top-level `used_percent`/`usage_percent` fallback must not manufacture a five-hour window without a matching known duration. Incorrectly labeling data is worse than omitting an unclassified quota window.

## User Interface

The Live card renders each known window only when it exists:

- Weekly-only Codex data shows a single `Weekly` bar and its seven-day countdown.
- The card headline uses the most constrained available window, so weekly-only data displays `Wk N%`.
- No empty `5-Hour` row, marker, insight, or countdown is rendered when the five-hour window is absent.
- When both windows return, the current two-row presentation remains unchanged.

The tray indicator prefers the five-hour window when present and falls back to the weekly window. This keeps Codex visible during the weekly-only rollout while preserving existing behavior for two-window accounts.

## Derived Features

Five-hour-derived features continue to require actual five-hour data:

- Window-ratio learning and the converted five-hour window budget remain inactive for weekly-only snapshots.
- Bonus-window calculations that depend on the learned ratio remain inactive.
- Five-hour pressure and window-history calculations receive no fabricated observations.
- Existing historical observations remain untouched and may still appear in historical views.
- Weekly pace, burn rate, reset countdowns, notifications, and forecasts continue to operate from the weekly window.

If the five-hour limit returns, duration-based classification restores the existing learning and display behavior automatically.

## Error Handling

The provider endpoint remains unofficial and is treated defensively. Unrecognized durations are excluded from known quota-window presentation rather than guessed from slot position. Existing payload-shape logging remains metadata-only and must not expose tokens, authorization headers, cookies, JWTs, account identifiers, or raw payload contents.

## Tests

Add regression coverage for:

1. A `primary_window` with `604_800` seconds normalizes to one `weekly` window.
2. A `primary_window` with `18_000` seconds and a `secondary_window` with `604_800` seconds normalize to both known windows.
3. Swapped API slots still produce the same semantic result and order.
4. Duplicate classified windows select the more complete candidate.
5. An unknown or missing duration is not mislabeled as five-hour.
6. A weekly-only Live card contains the Weekly row and no 5-Hour row.
7. A weekly-only snapshot produces a weekly-backed Codex tray indicator.
8. Existing two-window rendering and window-ratio behavior remain unchanged.

After implementation, run `npm test` and `npm run build`. Because the renderer changes, verify both a weekly-only Codex fixture and a normal two-window provider card in a real Electron window according to `TESTING.md`.

## Scope

This change does not assert that OpenAI permanently removed the five-hour limit. It does not delete historical data, alter Claude behavior, invent a new window type, or change subscription pricing and cost calculations.

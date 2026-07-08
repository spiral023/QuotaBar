# Session Time Trend Design

## Goal

Add an Analytics chart that shows how average session time develops over time, separated by provider and controlled by the existing global provider toggle.

## User Value

The current Analytics view shows only one average session value for the selected period. A time series makes long-term behavior visible: whether sessions are getting shorter, longer, or diverging between Claude and Codex.

## Data Model

The worker will add `sessionDurationBuckets` to `AnalyticsData`.

Each bucket contains:

- `date`: bucket key used by the chart.
- `days`: number of local calendar days represented by the bucket.
- `claudeMinutes`: average measurable Claude session duration in minutes.
- `codexMinutes`: average measurable Codex session duration in minutes.
- `allMinutes`: average measurable duration across both providers.

Buckets are derived from the existing provider-neutral `ActivityEntry` arrays that already power session stats. A measurable session is identified by `(project, session)` within one provider. For the combined view, projects remain provider-prefixed so sessions from different providers cannot collide.

## Calculation

For each bucket, group activity entries by session key and calculate each measurable session as:

`last recorded activity timestamp - first recorded activity timestamp`

Sessions with only one activity entry are excluded from the average because their duration cannot be measured. If a bucket has no measurable sessions, its value is `0`.

Daily buckets group by local day. Weekly buckets group by ISO week start. Monthly buckets group by calendar month start. The hourly Analytics resolution does not apply to this chart; when the global resolution is `Hr`, this chart displays daily buckets and titles itself as daily.

## UI

Add a new Analytics section after `ACTIVITY STATS`:

Title: `AVG SESSION TIME`

The section contains:

- A short explanatory sentence:
  `Average session time is the average duration of measurable sessions in each bucket. A session duration is last recorded activity minus first recorded activity; sessions with only one activity entry are excluded because their length cannot be measured.`
- A Chart.js line chart using existing Claude and Codex colors.
- The global provider toggle controls which datasets are visible.
- The chart follows `Day`, `Wk`, and `Mo`. It ignores `Hr` by falling back to `Day`.

## Error Handling

Invalid timestamps are ignored. Empty periods render an empty zero-valued chart rather than throwing.

## Testing

Add unit tests for:

- Daily bucket averages.
- Weekly and monthly grouping.
- Provider separation.
- Combined `allMinutes` across providers.
- Excluding single-entry sessions.
- Ignoring invalid timestamps.

Run `npm test` and `npm run build` after implementation.

Renderer changes must be manually verified in the Electron window according to `TESTING.md`.

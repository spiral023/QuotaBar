# Changelog

## 2.2.1 - 2026-09-06

### Fixed

- The usage chart is back for Codex accounts on the larger plans. Those plans no longer
  report a 5-hour window, and the whole chart pipeline was gated on that window being
  present, so the card lost its history entirely. The weekly (7-day) trend, the forecast
  and the unscheduled-reset badge are now built from the weekly window alone; only the
  conversion into 5-hour windows and its reset markers are omitted, and the panel is
  titled "Weekly trend" instead of "Window budget". Resets — both the ones OpenAI issues
  and a banked reset you redeem yourself — break the line rather than drawing a drop.

## 2.2.0 - 2026-09-06

### Changed

- Background ingestion now pauses between passes instead of running continuously. Each
  pass is followed by a cooldown as long as the pass itself, capped at 60 seconds, so the
  app no longer keeps a CPU core busy the whole time it is open. Newly recorded usage can
  appear up to one cycle later than before; manual refresh is unaffected.
- Reading the stored history is about 45% faster, which speeds up every dashboard view.
  Sorting re-parsed both timestamps on every comparison and rebuilt a date object per
  event just to derive its month; both are now derived directly from the stored value.

## 2.1.2 - 2026-09-05

### Changed

- Background ingestion is about 40% faster on installations with many session files.
  Validating a source record re-checked every stored event ID, and that check ran inside
  loops over all known sources, so the work grew with the square of the history. A full
  ingest pass over 3,389 sources dropped from 17.7 s to 10.3 s.

## 2.1.1 - 2026-09-05

### Fixed

- QuotaBar could stop refreshing shortly after launch: the tray menu was not rebuilt and
  no new quota data arrived, leaving the refresh indicator stuck. Startup waited for the
  background ingest to finish, but that wait also covered every follow-up cycle the timer
  had queued in the meantime. Once a cycle took longer than the polling interval - which
  happens on large histories - the wait never ended and startup never completed.

## 2.1.0 - 2026-09-05

### Changed

- QuotaBar is substantially faster on large histories. Opening the dashboard, switching
  tabs and the background refresh no longer re-read and re-hash the whole event store on
  every request. On a 184k-event store the readiness check dropped from 2.2 s to 11 ms,
  the store revision check from 1.25 s to 9 ms, all-time reports from 3.6 s to 1.1 s and
  the 365-day analytics view from 7.1 s to 5.4 s.
- Ingesting new usage writes far less to disk. A single new event previously rewrote the
  entire monthly partition; new events are now appended, reducing a typical ingest cycle
  from 28.7 MB to 14.1 MB written and from 28.8 MB to 14.1 MB read.
- The idle background loop no longer scans the agent source directories on every tick. It
  now reacts to file-system changes, with periodic scans retained as a fallback.

### Fixed

- Analytics and model statistics are no longer discarded and recomputed on every quota
  poll, which made tab switches slow for no reason: a poll only brings new quota
  percentages and cannot change the token history.

## 2.0.0 — 2026-07-14

### Added

- A portable, append-only usage store that incrementally ingests Claude and Codex data. Usage, quotas, reports, model costs, and analytics now remain available after providers remove their source logs.
- Secure portable data export and restore in **System → QuotaBar**. Exports contain portable statistics and settings, verify every archive entry, and exclude credentials, provider logs, application logs, caches, backups, and source-machine paths.
- Support for Codex accounts that expose only a weekly quota window, including live quota cards, tray fallbacks, and weekly trend charts.

### Changed

- Existing historical data is migrated safely to the portable store on first launch. QuotaBar preserves recovery state and shows the preparing state while migration is in progress.
- Portable imports are replacement operations: QuotaBar creates and verifies a timestamped local backup before applying an import, then restarts to finish it.

### Fixed

- Strengthened data-ingestion, migration, and archive recovery so interrupted work, duplicate provider events, invalid archive contents, and incomplete cost enrichment do not corrupt saved statistics.

## 1.5.0 — 2026-07-12

### Added

- Historical API pricing for Codex and Claude reports, backfills, subscription factors, and cost calculations. Historical usage now keeps the price that applied at the time of use.
- Drag-and-drop ordering for provider cards in the Live view, with the selected order also reflected in tray surfaces.
- A coding-agent benchmark index in the Models view.

### Fixed

- Codex authentication now selects a valid, unexpired token across configured Codex home directories.
- Claude source-cost components are attributed correctly when applying historical pricing.

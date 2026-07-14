# Changelog

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

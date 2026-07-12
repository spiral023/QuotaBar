# Changelog

## 1.5.0 — 2026-07-12

### Added

- Historical API pricing for Codex and Claude reports, backfills, subscription factors, and cost calculations. Historical usage now keeps the price that applied at the time of use.
- Drag-and-drop ordering for provider cards in the Live view, with the selected order also reflected in tray surfaces.
- A coding-agent benchmark index in the Models view.

### Fixed

- Codex authentication now selects a valid, unexpired token across configured Codex home directories.
- Claude source-cost components are attributed correctly when applying historical pricing.

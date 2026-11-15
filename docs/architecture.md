# QuotaBar architecture

QuotaBar is an Electron tray application. The main process owns provider access,
credentials, filesystem writes, windows and notifications. Renderer windows
display data through the sandboxed preload bridge. They cannot access Node or
contact provider endpoints directly.

## Process and module ownership

| Area | Owns |
| --- | --- |
| `main/main.ts` | Startup, tray, refresh lifecycle and shutdown drain |
| `main/detailsWindow.ts` | Dashboard window, view lifecycle and analytics caches |
| `main/reportsIpc.ts`, `main/systemIpc.ts` | Report queries and system/archive actions |
| `main/rendererSecurity.ts`, `shared/ipcContract.ts` | Sender, frame, channel and argument validation |
| `shared/rendererIpc.ts` | Typed bridge requests and responses; runtime validation remains authoritative |
| `main/analyticsWorker.ts`, `main/analyticsActivity.ts` | Background analytics orchestration and shared activity aggregation |
| `renderer/tabs/analytics-data.js` | Bounded request deduplication, invalidation and timezone-aware cache keys |
| `renderer/tabs/analytics.js` | Selected range, latest-request rendering and analytics UI |
| `renderer/tabs/analytics-window-history.js` | Window-history loading, charts and its independent generation |
| `renderer/tabs/system*.js` | System orchestration, common views, root views and escaped update text |
| `portable/usageStore.ts` | Canonical usage operations and writer locking |
| `portable/usageStoreFormat.ts`, `portable/usageStoreMaintenance.ts` | Store formats, revisions, metadata reads and temporary-file cleanup |
| `portable/migration.ts`, `portable/legacyReconciliation.ts` | Migration ownership/state transitions and legacy reconciliation calculations |
| `portable/archiveService.ts`, `portable/archiveBackup.ts` | Import/export lifecycle and rollback; archive writing and backup verification |
| `portable/dailyRollups.ts` | Disposable daily aggregates, partition reuse and canonical fallback |
| `shared/zonedDate.ts` | Shared timezone conversion with offset caching and exact fallback |
| `main/logging.ts`, `main/asyncLogWriter.ts` | Secret redaction, bounded asynchronous writes, rotation and flush |

## Canonical and derived data

Monthly usage JSONL files are canonical. Daily rollups are derived and excluded
from portable exports. Their checksummed snapshots include timezone, format,
source identities and durable per-partition generations. Writers invalidate
affected generations before mutating source files, including transaction recovery.
Tracked changes rebuild only affected months when their cached contributions
are independent of global ID deduplication. Ambiguous snapshots rebuild globally
after mutations; managed writers invalidate their global generation when duplicate
IDs are present. Untracked external changes rebuild
from a globally deduplicated canonical read. Corrupt or unavailable cache storage
falls back to canonical data.

UTC partitions can contribute to the same local day. Their provider/model rows
are merged after per-event cost reconciliation. Exact partial ranges still read
canonical boundary events. Imported offset timestamps retain individual rows.

Renderer invalidation clears pending generations as well as cached values.
Only the latest selected-range request may update the visible analytics UI.
Old successes, errors and prefetch results cannot repopulate an invalidated cache.

## Lock order and shutdown

Archive operations acquire locks in this order: application → migration →
ingestion → usage store → quota store. Extraction into modules does not change
that order. Keep coordination in the owning lifecycle module, and keep pure
formatting/reconciliation modules free of locks.

Normal shutdown stops ingestion, flushes notification persistence, flushes the
debug recorder and finally drains application logging. The logger redacts
before enqueueing, bounds queued bytes, shares the archive application lock for filesystem writes,
and reports dropped messages under
overload. Import restart also drains logging before exiting.

## Verification

Run `npm run verify`, `npm run test:coverage`, `npm run test:electron` and
`npm run package` with the declared Node/npm versions. The Electron smoke uses
synthetic data and real IPC in a disposable home; it includes reverse-order
analytics responses, in-flight invalidation, literal update text and small cost
axes. See [TESTING.md](../TESTING.md) for installed update acceptance and
[PERFORMANCE.md](../PERFORMANCE.md) for benchmark scope and measurements.

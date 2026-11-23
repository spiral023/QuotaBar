# Changelog

## 2.4.3 - 2026-11-23

### Fixes

- Codex usage no longer counts a model call twice when Codex repeats its token count without new usage, for example after a context compaction. This affected about 0.6 % of Codex tokens. Usage already stored is not corrected.
- Offline prices now cover every current Claude model. Opus 4.7 and 4.8 were priced at three times their real rate when LiteLLM was unreachable, Opus 5/5.5, Sonnet 4.6/5 and Fable had no price at all, and Haiku 4.5 was priced too low.
- An offline price lookup no longer falls back to an older model version with a different price (for example Opus 4.8 to Opus 4).

### Tests

- Tests no longer read or write the real `~/.quotabar-win` folder. Before, running the suite could add test prices to the local price history, so later usage could be priced at an old offline rate.

### Validation

- Lint, 1,650 tests (1,643 run, seven child-fixture placeholders skipped) and production build passed. Online price lookups were checked against the current LiteLLM file for every locally stored model name and are unchanged.


## 2.4.2 - 2026-11-23

### Fixes

- Settings are no longer reset to defaults when `settings.json` is briefly locked or invalid. Changes are saved atomically under a lock, and an invalid file is kept as `settings.corrupt-<time>.json` at startup instead of being overwritten.
- A Claude token refresh no longer rewrites an unreadable `.credentials.json` with only the OAuth entry. It writes back to the file the token came from (custom and WSL roots previously went to the default path), runs only one refresh at a time, and reuses a newer token already stored by Claude Code.
- Usage ingestion no longer stays blocked until restart after the analytics worker was stopped while holding a store lock.
- Portable data preparation retries with backoff after a startup failure instead of staying off for the session.
- Network and DNS outages are recognised again, and an error response is no longer logged as "network recovered".
- File replacements retry longer when Windows briefly locks a file (antivirus, indexer). Error logs now include the error code, still without paths.
- Tooltips near the right window edge keep their margin instead of touching the edge.

### Improvements

- Tooltips in History, Analytics and Alerts use one shared implementation and also open on keyboard focus.
- History, Analytics and Models share one range filter bar.
- Portable archives use only the streaming ZIP reader/writer; `adm-zip` is no longer shipped.

### Validation

- Strict typechecking, lint, 1,638 tests (1,631 run, seven child-fixture placeholders skipped) and production build passed. Setup, portable and ZIP packages built. Tooltips and filter bars were verified in a real Electron window at 900×660 and 750×520.


## 2.4.1 - 2026-11-23

### Security

- Accept only known notification rule IDs from `quotabar://mute` links, so a crafted link can no longer modify shared object prototypes in the main process.

### Fixes

- Editing a subscription plan no longer shifts its start and end time by the UTC offset on every save.
- Date range presets in History, Analytics and Models now end on the local day and no longer drift across daylight saving changes.
- The Window budget section on the Live tab expands and collapses again; its inline handler was blocked by the content security policy.
- Explanatory tooltips on the Live tab (window budget, bonus week, cost window) now appear, rendered as portal tooltips.
- The cost factor no longer disappears for very large log histories (all-time window) because of a call stack overflow; calculation failures are now logged.
- Replace remaining German UI text with English, including the tray tooltip after resume, plan end markers, empty states and weekday labels.

### Validation

- Strict typechecking, lint, 1,580 tests (1,573 run, seven child-fixture placeholders skipped) and production build passed. Live tab toggle, tooltips and the plan editor were verified in a real Electron window.


## 2.4.0 - 2026-11-14

### Security

- Upgrade Electron to 45 and refresh runtime/build dependencies.
- Restrict renderer IPC to known channels, validated arguments, trusted windows and the main frame.
- Bundle the sandboxed preload, apply local content security policies and ship fonts locally.

### Improvements

- Persist additive daily usage totals for daily, weekly and monthly reports and Models, with timezone-aware boundaries, source-write invalidation and safe recovery from stale or corrupt caches.
- Reduce cached daily report generation from 1,032 ms to 74 ms in the documented 100,000-event synthetic benchmark. The first cache build still reads the full history.
- Split large renderer styles/scripts and portable archive/store helpers into focused modules.
- Bound analytics result caches and worker queues; recover workers that exceed their deadline.
- Upgrade build/typechecking to native TypeScript 7 and tests to Vitest 5, retaining the supported TypeScript 6 API for ESLint.

### Fixes

- Recognize NSIS installations in custom directories so they can auto-update.
- Preserve the first packaged command-line argument, including `--open-window`.
- Update the System panel as downloads progress and expose Install update immediately while preserving edited settings.
- Handle unknown provider response schemas defensively and preserve Codex identity on errors.

### Validation

- Strict typechecking, lint, 1,519 tests, production build, dependency audits and live Electron checks passed during maintenance validation.
- A real installed NSIS update passed in Windows Sandbox, including checksum rejection, download retry, automatic relaunch and retained settings/usage.
- Installer, portable executable and ZIP are provided. Installed builds use the built-in updater; portable/ZIP builds require a manual download.


## 2.3.1 - 2026-10-27

### Security

- Refresh locked dependencies, including Electron and affected archive, process and build tooling. Full and production npm audits reported no known vulnerabilities at release validation.

### Changed

- Correct outdated backfill status wording and remove unused legacy provider code.
- Limit packaged logos to the files used by the app.
- Add Windows tests, installer checks and dependency audits for future maintenance updates.

## 2.3.0 - 2026-10-17

### Changed

- Live quota values now arrive about 2 seconds after launch instead of about 22. Polling,
  notifications, the tray menu and the update check used to wait until the stored usage
  history had been prepared; that preparation now runs in the background. Quitting while
  it is still running waits for it to finish, so no write is cut short.
- Background ingestion while idle costs a fraction of what it did. A single passive pass
  dropped from 5.5-8.5 s to 1.5-2.4 s on a large history, and passes with new usage finish
  their follow-up steps in about 3 s instead of 5-6 s. Three causes:
  - Session files containing a zero-token placeholder entry from Claude Code (API errors,
    "No response requested.") were treated as not fully priced, so they were re-read on
    every pass - 133 files here - together with the entire stored history.
  - A single folder that cannot be watched for changes, such as a Codex home inside WSL,
    disabled change detection for all folders, so every 15-second tick scanned the full
    history. Such folders are now covered by a scan at most once a minute; new usage there
    can take up to a minute to appear.
  - The store fingerprint, which serializes and hashes every event, was computed three
    times per pass, once without being used.
- Each ingest pass now appends the few changed entries to a small journal instead of
  rewriting the complete ingest state (about 20 MB here) every time.
- Startup no longer re-reads every legacy debug log to migrate quota snapshots; only new or
  grown logs are read, which cuts that step from 3-5 s to about 0.5 s.

### Fixed

- Usage of gpt-5-codex-mini is now priced, at the gpt-5.1-codex-mini rates. Codex
  auto-review and Antigravity proxy models, which have no published price, are booked at
  zero. Previously these events had no cost at all and kept a background cost repair
  running on every pass.
- Improved the contrast of dimmed text to meet WCAG AA: the version number in the header,
  disabled notification rules and the Codex "Active" badge.

## 2.2.3 - 2026-09-17

### Fixed

- Release packaging only - the app itself is identical to 2.2.2. That release never
  shipped a usable installer: the pipeline hung while uploading the setup executable, in
  three consecutive attempts, so the release ended up without its installer and without
  the latest.yml that describes the update. Every update check ran into a 404 with
  "Cannot find latest.yml in the latest release artifacts". Artifacts are now uploaded
  through the GitHub CLI with retries, and a release only becomes visible once its
  update metadata is in place.

## 2.2.2 - 2026-09-17

### Changed

- Model benchmark scores now follow the Artificial Analysis Intelligence Index v4.3,
  which incorporates ten evaluations and rescales the index against v4.1. Every score is
  lower than before, so the numbers are only meaningful relative to each other within
  this release - do not compare them to the ones QuotaBar showed previously. Claude
  Fable 5.1, Claude Opus 5, GPT-6 Astra, GPT-5.4 mini, GLM-5.3 and Qwen3.8 27B joined the
  table. The Coding Agent index is unchanged.

### Security

- Updated dependencies to clear all 15 advisories reported by npm audit, one of them
  rated critical (node-tar) and eleven high. The notable one for the running app is
  Electron 42.3.3 -> 42.11.4, which carries the accumulated Chromium security fixes; the
  rest are build and test tooling. No dependency ranges changed, so the update is a
  lockfile refresh only.

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

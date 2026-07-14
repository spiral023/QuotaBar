# Portable QuotaBar Statistics Store and ZIP Transfer

## Goal

QuotaBar shall retain every data point required to reproduce the current Models, Analytics, History, and Reports views inside `%USERPROFILE%\.quotabar-win`. Claude and Codex data remain ingestion sources, but the application must not depend on their original session files after ingestion.

The System tab shall provide a ZIP export and import workflow that transfers this portable data to another Windows PC, including a PC whose signed-in user has a different username or home directory.

## Privacy boundary

The portable store may contain recognizable project names because they are required for the intended statistics. It must not contain:

- prompts, responses, or source-file contents;
- OAuth tokens, JWTs, authorization headers, cookies, or credentials;
- complete Claude or Codex session files;
- complete absolute project paths;
- QuotaBar diagnostic logs.

Session identifiers are pseudonymized before persistence. Project names remain recognizable, while their absolute source paths are not persisted as active paths.

## Architecture

QuotaBar gains a durable, versioned statistics store below its existing application-data directory:

```text
%USERPROFILE%\.quotabar-win\
├── usage\
│   ├── events\
│   │   ├── 2026-07.jsonl
│   │   └── 2026-08.jsonl
│   ├── ingest-state.json
│   └── store-metadata.json
├── quota\
│   └── snapshots\
├── settings.json
├── window-history.json
├── window-ratio.json
├── bonus-state.json
└── notification-state.json
```

Monthly JSONL files are the canonical normalized event store. They match the current file-oriented architecture, remain inspectable, are straightforward to test and archive, and avoid a database runtime dependency. A rebuildable metadata index prevents ordinary queries from repeatedly parsing the complete history.

Claude and Codex readers become ingestion adapters. Models, Analytics, History, and Reports read only from the portable store after migration. Live quota observations are persisted under `.quotabar-win` as a separate snapshot stream and feed the quota-related Analytics views.

## Normalized usage event

Every normalized usage event contains only statistics-relevant fields:

- schema version;
- stable event ID;
- provider;
- occurrence timestamp;
- normalized model name;
- recognizable project name, when available;
- pseudonymized session ID;
- input, output, cache-creation, cache-read, and reasoning-token counts where supported;
- API-equivalent costs and pricing-version metadata;
- non-sensitive source type metadata.

Stable IDs make ingestion idempotent. The ID is derived from normalized, non-secret event identity fields and a private format namespace, not from raw prompt or response content.

## Ingestion and durability

The ingestion service scans only the known provider paths already supported by QuotaBar. For every new or changed source file it:

1. parses statistical events using the existing provider readers;
2. normalizes the events;
3. removes duplicates by stable event ID;
4. appends or atomically rewrites the affected monthly partition;
5. updates the rebuildable metadata index and ingestion state.

`ingest-state.json` records the known source path, size, modification time, and processing state. It must not record file contents or credentials. A deleted or temporarily unavailable provider source never deletes an already imported QuotaBar event.

Writes use a temporary file followed by an atomic rename. A malformed provider file is isolated and reported without blocking other files. Errors may include a known path and technical cause, but never token values, credentials, prompts, or responses.

## Migration from the current format

The first compatible application start performs an idempotent migration:

1. Existing `debug\*.backfill.jsonl` records are converted into normalized store events.
2. Existing Claude and Codex session logs are ingested when available to enrich time, session, and project information.
3. Stable IDs and migration provenance prevent double counting between backfill and provider-derived data.
4. Existing live debug observations are migrated into the quota snapshot store.
5. Existing backfill files remain untouched as a safety copy during the initial release.

Data absent from both old Backfill records and currently retained provider logs cannot be reconstructed. After the new store is active, all newly observed statistics are portable without the original provider logs.

The migration is versioned and resumable. An interruption leaves the old data intact and allows the next start to continue safely.

## Statistics consumers

After migration:

- Models reads model/token/cost distributions from normalized usage events.
- History and Reports aggregate normalized events by the requested period.
- Analytics derives activity, sessions, project statistics, costs, cache efficiency, and model usage from normalized events.
- Quota-window analytics reads the portable quota snapshot stream and persistent window state.

No statistics view may silently fall back to reading provider logs directly. Provider readers are limited to ingestion so that a copied `.quotabar-win` directory is sufficient to render the imported historical views.

## Cross-user and cross-PC portability

Archive contents use paths relative to the archive root. The archive must never use the source computer's `%USERPROFILE%` as an extraction destination.

On import, QuotaBar resolves its application-data directory and all default provider roots from the target process and target user's home directory. Source-machine absolute paths in `settings.json`, `ingest-state.json`, or legacy metadata are not activated on the target.

Portable settings are divided conceptually into:

- machine-independent preferences, plans, notification rules, and display settings, which are restored;
- machine-dependent Claude/Codex roots, which are remapped to target defaults or cleared unless they can be expressed as a recognized portable default.

Old source paths may be retained only as inert provenance metadata when necessary for deduplication. They must not be opened, scanned, or displayed as active target paths. This guarantees that an export made by `C:\Users\Alice` can be imported by `C:\Users\Bob` without manual JSON editing.

## ZIP export

The QuotaBar panel in the System tab gains an `Export data` action. The export opens a save dialog and writes a ZIP containing:

- the portable usage event store and its metadata;
- portable quota snapshots and window history;
- settings, plans, and notification configuration;
- notification history and required persistent state;
- an archive manifest.

The manifest contains the archive-format version, QuotaBar version, creation time, relative file list, byte sizes, and checksums.

The export excludes:

- credentials and provider authentication files;
- original provider session logs;
- QuotaBar diagnostic logs;
- rebuildable caches;
- existing backups;
- temporary files and installer markers.

Export reads from an internally consistent snapshot. A failed or cancelled export leaves no apparently valid partial archive at the selected destination.

## ZIP import

The System tab gains an `Import data` action. Import is a complete restoration of a portable QuotaBar archive, not a merge between two independently active histories.

The workflow is:

1. Select a ZIP archive.
2. Validate the manifest, archive format, checksums, entry count, individual sizes, and total expanded size.
3. Reject absolute paths, drive-qualified paths, traversal components, links, unexpected entries, duplicate normalized paths, and files outside the allowlist.
4. Create and verify a timestamped backup of the current `.quotabar-win` data outside that directory.
5. Extract into a temporary sibling directory.
6. Validate all required store files and schemas.
7. Remap or clear machine-dependent paths for the target user.
8. Atomically replace the portable data set while preserving recovery data until success is confirmed.
9. Restart QuotaBar so no stale in-memory state survives.

If any step fails, the existing installation remains usable or is restored from the automatic backup. The UI reports a concise English error without archive contents or sensitive values.

## System-tab experience

The existing QuotaBar data panel receives compact `Export data` and `Import data` buttons consistent with current System-tab actions.

Export communicates progress, cancellation, success, and the selected destination. Import explains that current portable data and settings will be replaced, requires confirmation, reports validation progress, and restarts only after a successful replacement.

The actions remain disabled while another data-management operation is running. Renderer code receives only structured status/results through narrow IPC handlers; filesystem and archive operations remain in the main process.

## Backup checkpoint before productive testing

Before the first test against the user's current production data:

1. fully exit QuotaBar;
2. create a timestamped ZIP of the complete current `%USERPROFILE%\.quotabar-win` directory outside that directory;
3. open and enumerate the ZIP to verify that it is readable and that its entry count is plausible;
4. retain the backup unchanged while migration, export, and import tests run;
5. only then start the build that performs the real migration.

This manual checkpoint is required even though import also creates an automatic pre-import backup.

## Validation and tests

Automated coverage includes:

- normalized event creation and privacy-field exclusion;
- deterministic IDs and duplicate suppression;
- migration from existing Backfill and live debug records;
- interrupted and resumed migration;
- preservation when provider files disappear;
- parity tests comparing legacy and portable-store Models, Analytics, History, and Reports results;
- cross-user path remapping from a source home to a different target home;
- ZIP manifest and checksum validation;
- rejection of traversal, absolute paths, links, duplicate paths, oversized archives, corrupted archives, and unsupported versions;
- cancellation and interrupted export/import;
- restoration after a failed import;
- System-tab renderer behavior and busy/error states.

Before completion, run `npm test` and `npm run build`. Verify the complete workflow in the real Electron window according to `TESTING.md`, including export, destructive-import confirmation, restart, restored views, and different target-home fixtures.

## Rollout

The rollout keeps legacy Backfill data during the first store version and gates consumer cutover on successful migration. If migration has not completed, the app reports that portable history is being prepared rather than presenting silently incomplete results.

The first release does not implement merging two independent QuotaBar archives. Import replaces the portable data set after creating a recoverable backup. Archive merging can be designed later using the stable event IDs if needed.

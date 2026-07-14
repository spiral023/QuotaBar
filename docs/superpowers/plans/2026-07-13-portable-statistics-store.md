# Portable Statistics Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `%USERPROFILE%\.quotabar-win` the complete source for every historical QuotaBar view and add safe ZIP export/import across PCs and Windows usernames.

**Architecture:** Normalize provider usage into versioned monthly JSONL partitions under `.quotabar-win\usage`, persist quota observations separately, and make Reports, History, Models, and Analytics consume only those stores. Export an allowlisted archive with checksums; validate imports into staging, create a full backup, and apply the staged replacement during restart so Windows never replaces live files.

**Tech Stack:** Electron 42, TypeScript 5.8, Node.js filesystem/crypto, `adm-zip`, vanilla renderer JavaScript/CSS, Vitest, Playwright Electron.

---

## File map

New focused modules:

- `src/portable/types.ts` — versioned portable event, metadata, migration, and archive contracts.
- `src/portable/eventIdentity.ts` — deterministic event IDs and session pseudonyms.
- `src/portable/usageStore.ts` — partition selection, validated JSONL reads, atomic upserts, and rebuildable metadata.
- `src/portable/eventAdapters.ts` — lossless conversions between provider-reader events, portable events, and report inputs.
- `src/portable/ingestion.ts` — known-path provider ingestion and source fingerprint state.
- `src/portable/migration.ts` — legacy Backfill reconciliation and resumable migration state.
- `src/portable/quotaStore.ts` — durable normalized quota observations.
- `src/portable/archiveManifest.ts` — allowlist, checksums, archive limits, and cross-user settings sanitization.
- `src/portable/archiveService.ts` — export, validation/staging, full backup, pending import, and rollback.

Existing consumers and integration points:

- `src/config/paths.ts` — paths for portable stores, staging, and pending import.
- `src/reports/reportService.ts` — portable events become the sole default report source.
- `src/main/modelsData.ts` and `src/main/analyticsWorker.ts` — remove direct Backfill/provider-history dependencies.
- `src/main/main.ts` — apply pending imports before settings load; run migration/ingestion; record quota snapshots.
- `src/main/detailsWindow.ts` — narrow archive IPC handlers and portable-store worker inputs.
- `src/main/systemData.ts` — show portable usage/quota paths and migration state.
- `src/renderer/tabs/system.js` and `src/renderer/styles.css` — export/import controls, confirmation, busy, and result states.
- `README.md`, `docs/how-quotabar-calculates.md`, and `TESTING.md` — portable lifecycle and manual verification.

## Task 1: Add archive dependency and portable paths/contracts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/config/paths.ts`
- Create: `src/portable/types.ts`
- Test: `tests/portablePaths.test.ts`

- [ ] **Step 1: Install the ZIP dependency**

Run:

```powershell
npm install adm-zip
npm install --save-dev @types/adm-zip
```

Expected: `package.json` contains `adm-zip` in `dependencies`, its types in `devDependencies`, and the lockfile changes without unrelated upgrades.

- [ ] **Step 2: Write the failing path/contract test**

```ts
import { describe, expect, it } from "vitest";
import {
  getPortableUsageDir, getPortableEventsDir, getPortableQuotaDir,
  getPortableMigrationPath, getPendingImportPath,
} from "../src/config/paths";

describe("portable data paths", () => {
  it("keeps every canonical path below .quotabar-win", () => {
    for (const value of [
      getPortableUsageDir(), getPortableEventsDir(), getPortableQuotaDir(),
      getPortableMigrationPath(), getPendingImportPath(),
    ]) expect(value).toContain(".quotabar-win");
  });
});
```

- [ ] **Step 3: Run the test and confirm the missing exports**

Run: `npx vitest run tests/portablePaths.test.ts`

Expected: FAIL because the portable path functions do not exist.

- [ ] **Step 4: Add paths and exact versioned contracts**

Add path functions using `getAppConfigDir()` and define these core contracts:

```ts
export const PORTABLE_STORE_VERSION = 1 as const;

export type PortableProvider = "claude" | "codex";
export type PortableEventSource = "claude-log" | "codex-log" | "legacy-reconciliation";

export interface PortableUsageEvent {
  schemaVersion: 1;
  id: string;
  provider: PortableProvider;
  occurredAt: string;
  model: string;
  projectName?: string;
  sessionKey: string;
  source: PortableEventSource;
  synthetic: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningOutputTokens: number;
  costUSD?: number;
  inputCostUSD?: number;
  outputCostUSD?: number;
  cacheCreationCostUSD?: number;
  cacheReadCostUSD?: number;
  pricingVersion?: string;
}

export interface PortableStoreMetadata {
  schemaVersion: 1;
  partitions: Record<string, { eventCount: number; firstAt: string; lastAt: string }>;
  updatedAt: string;
}

export interface PortableIngestState {
  schemaVersion: 1;
  sources: Record<string, { size: number; mtimeMs: number; processedAt: string }>;
}

export interface PortableMigrationState {
  schemaVersion: 1;
  status: "pending" | "running" | "complete" | "failed";
  legacyVersion: number;
  lastError?: string;
  updatedAt: string;
}
```

Implement `getPortableUsageDir()`, `getPortableEventsDir()`, `getPortableQuotaDir()`, `getPortableMetadataPath()`, `getPortableIngestStatePath()`, `getPortableMigrationPath()`, `getImportStagingDir()`, and `getPendingImportPath()`.

- [ ] **Step 5: Run the test and build**

Run: `npx vitest run tests/portablePaths.test.ts && npm run build`

Expected: PASS and TypeScript build success.

- [ ] **Step 6: Commit**

```powershell
git add package.json package-lock.json src/config/paths.ts src/portable/types.ts tests/portablePaths.test.ts
git commit -m "feat: define portable statistics contracts"
```

## Task 2: Implement deterministic identities without sensitive content

**Files:**
- Create: `src/portable/eventIdentity.ts`
- Test: `tests/portableEventIdentity.test.ts`

- [ ] **Step 1: Write failing deterministic/privacy tests**

```ts
import { describe, expect, it } from "vitest";
import { eventId, sessionKey } from "../src/portable/eventIdentity";

describe("portable event identity", () => {
  it("is deterministic and changes with statistical identity", () => {
    const base = { provider: "claude" as const, occurredAt: "2026-07-13T10:00:00.000Z", model: "m", session: "secret-session", ordinal: 2 };
    expect(eventId(base)).toBe(eventId(base));
    expect(eventId({ ...base, ordinal: 3 })).not.toBe(eventId(base));
  });

  it("does not expose the raw session", () => {
    expect(sessionKey("claude", "secret-session")).not.toContain("secret-session");
  });
});
```

- [ ] **Step 2: Run the test to verify failure**

Run: `npx vitest run tests/portableEventIdentity.test.ts`

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement namespaced SHA-256 identities**

```ts
import { createHash } from "node:crypto";

const NS = "quotabar-portable-v1";
const hash = (parts: readonly (string | number)[]) =>
  createHash("sha256").update([NS, ...parts].join("\u001f"), "utf8").digest("hex");

export function sessionKey(provider: "claude" | "codex", raw: string): string {
  return hash(["session", provider, raw]);
}

export function eventId(input: {
  provider: "claude" | "codex"; occurredAt: string; model: string; session: string; ordinal: number;
}): string {
  return hash(["event", input.provider, input.occurredAt, input.model, input.session, input.ordinal]);
}
```

Do not add prompt text, response text, file contents, credentials, or full paths to either hash input.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run tests/portableEventIdentity.test.ts`

Expected: PASS.

```powershell
git add src/portable/eventIdentity.ts tests/portableEventIdentity.test.ts
git commit -m "feat: add private portable event identities"
```

## Task 3: Build the atomic monthly usage store

**Files:**
- Create: `src/portable/usageStore.ts`
- Test: `tests/portableUsageStore.test.ts`

- [ ] **Step 1: Write failing partition, dedupe, range, and recovery tests**

Use a temporary root and assert that two July events land in `events/2026-07.jsonl`, duplicate IDs remain single, an August-only query does not return July, malformed lines are skipped, and deleting `store-metadata.json` followed by `rebuildMetadata()` reconstructs counts.

```ts
const event = (id: string, occurredAt: string): PortableUsageEvent => ({
  schemaVersion: 1, id, provider: "claude", occurredAt, model: "claude-x",
  sessionKey: "session", source: "claude-log", synthetic: false,
  inputTokens: 1, outputTokens: 2, cacheCreationTokens: 0,
  cacheReadTokens: 0, reasoningOutputTokens: 0,
});
const store = new PortableUsageStore(root);
await store.upsert([event("a", "2026-07-01T00:00:00.000Z"), event("a", "2026-07-01T00:00:00.000Z"), event("b", "2026-08-01T00:00:00.000Z")]);
expect((await store.read({ since: "2026-07-01", until: "2026-07-31" })).map(e => e.id)).toEqual(["a"]);
expect((await store.read({ since: "2026-08-01", until: "2026-08-31" })).map(e => e.id)).toEqual(["b"]);
```

- [ ] **Step 2: Run the focused test**

Run: `npx vitest run tests/portableUsageStore.test.ts`

Expected: FAIL because `PortableUsageStore` is missing.

- [ ] **Step 3: Implement validated parsing and atomic upsert**

Expose this API:

```ts
export class PortableUsageStore {
  constructor(private readonly rootDir = getPortableUsageDir()) {}
  read(range: { since?: string; until?: string } = {}): Promise<PortableUsageEvent[]>;
  upsert(events: readonly PortableUsageEvent[]): Promise<{ inserted: number; existing: number }>;
  rebuildMetadata(): Promise<PortableStoreMetadata>;
}
```

For each affected `YYYY-MM`, read valid v1 events into `Map<string, PortableUsageEvent>`, add only unknown IDs, sort by `occurredAt` then `id`, write `${file}.${process.pid}.tmp`, and rename. Validate provider, ISO timestamp, finite non-negative token fields, and non-empty ID/model/sessionKey. Select partitions from the requested month range so bounded reads never scan unrelated months.

- [ ] **Step 4: Run focused and existing file-reader tests**

Run: `npx vitest run tests/portableUsageStore.test.ts tests/backfill-reader.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/portable/usageStore.ts tests/portableUsageStore.test.ts
git commit -m "feat: add atomic portable usage store"
```

## Task 4: Normalize Claude and Codex events

**Files:**
- Create: `src/portable/eventAdapters.ts`
- Modify: `src/pricing/jsonl-reader.ts`
- Modify: `src/pricing/codex-log-reader.ts`
- Test: `tests/portableEventAdapters.test.ts`
- Modify: `tests/jsonl-reader.test.ts`
- Modify: `tests/codex-log-reader.test.ts`

- [ ] **Step 1: Write failing adapter and privacy tests**

Test Claude and Codex conversion, recognizable project names, pseudonymized sessions, token mapping, and serialized-field allowlisting:

```ts
const [event] = fromClaudeEntries([{ provider: "claude", timestamp: "2026-07-13T10:00:00.000Z", model: "claude-x", project: "QuotaBar", session: "raw-id", inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 }]);
expect(event.projectName).toBe("QuotaBar");
expect(JSON.stringify(event)).not.toContain("raw-id");
expect(Object.keys(event).sort()).toEqual(PORTABLE_USAGE_EVENT_KEYS);
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/portableEventAdapters.test.ts`

Expected: FAIL because adapters are missing.

- [ ] **Step 3: Implement bidirectional adapters**

Export:

```ts
export function fromClaudeEntries(entries: readonly ClaudeUsageEntry[]): PortableUsageEvent[];
export function fromCodexEvents(events: readonly CodexTokenEvent[]): PortableUsageEvent[];
export function toClaudeEntries(events: readonly PortableUsageEvent[]): ClaudeUsageEntry[];
export function toCodexEvents(events: readonly PortableUsageEvent[]): CodexTokenEvent[];
```

Use input order as the per-session/timestamp/model ordinal passed to `eventId`. Extend both provider readers to retain a `projectName` derived only from the basename of the provider event's `cwd`/working-directory metadata; never expose the full working directory. Fall back to the existing Claude project label or `Unknown project` when no working-directory metadata exists. For Codex, map cached input to `cacheReadTokens` and preserve reasoning output. Reverse adapters use `sessionKey` and `projectName`; they never recreate an absolute path.

- [ ] **Step 4: Run adapter and provider-reader tests**

Run: `npx vitest run tests/portableEventAdapters.test.ts tests/jsonl-reader.test.ts tests/codex-log-reader.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/portable/eventAdapters.ts src/pricing/jsonl-reader.ts src/pricing/codex-log-reader.ts tests/portableEventAdapters.test.ts tests/jsonl-reader.test.ts tests/codex-log-reader.test.ts
git commit -m "feat: normalize provider usage events"
```

## Task 5: Add incremental known-path ingestion

**Files:**
- Create: `src/portable/ingestion.ts`
- Test: `tests/portableIngestion.test.ts`

- [ ] **Step 1: Write failing idempotence and deletion tests**

Create fixture provider readers as injected dependencies. First ingest inserts events, second unchanged ingest inserts zero, changing one fingerprint reprocesses it without duplicating stable IDs, and deleting a source leaves stored events untouched.

```ts
const result1 = await ingestPortableUsage({ store, statePath, claudeRefs: [ref], codexRefs: [], readClaude, readCodex });
const result2 = await ingestPortableUsage({ store, statePath, claudeRefs: [ref], codexRefs: [], readClaude, readCodex });
expect(result1.inserted).toBe(1);
expect(result2.inserted).toBe(0);
expect((await store.read()).length).toBe(1);
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/portableIngestion.test.ts`

Expected: FAIL because ingestion is missing.

- [ ] **Step 3: Implement the ingestion boundary**

Expose `ingestPortableUsage(options)` with injected refs/readers for tests and defaults using `listClaudeSourceFiles`, `readClaudeUsageEntriesFromFiles`, `listCodexSourceFiles`, and `readCodexTokensFromFiles`. Fingerprint with `size` and rounded `mtimeMs`; parse only changed files; call adapter then store upsert; atomically save state only after the store succeeds. Treat absent previous sources as inactive metadata, not deletion requests.

Errors returned to callers use `{ provider, path, message }` and must never include a parsed line or event body.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run tests/portableIngestion.test.ts tests/portableUsageStore.test.ts`

Expected: PASS.

```powershell
git add src/portable/ingestion.ts tests/portableIngestion.test.ts
git commit -m "feat: ingest provider statistics incrementally"
```

## Task 6: Migrate and reconcile legacy Backfill data

**Files:**
- Create: `src/portable/migration.ts`
- Modify: `src/reports/backfill-reader.ts`
- Test: `tests/portableMigration.test.ts`

- [ ] **Step 1: Expose legacy reads and write failing reconciliation tests**

Keep `readBackfillDayRecords()` and add tests for:

- a Backfill-only model/day becoming one synthetic event;
- provider events equal to Backfill totals creating no synthetic event;
- partial provider totals creating only a non-negative delta event;
- rerunning migration creating no duplicates;
- an interrupted `running` state resuming to `complete`.

```ts
await migrateLegacyData({ store, records: [legacyDay], providerEvents: [partial], statePath });
const events = await store.read();
const totalTokens = events.reduce((sum, event) => sum
  + event.inputTokens + event.outputTokens + event.cacheCreationTokens
  + event.cacheReadTokens + event.reasoningOutputTokens, 0);
expect(totalTokens).toEqual(legacyDay.totalTokens);
expect(events.filter(e => e.source === "legacy-reconciliation")).toHaveLength(1);
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/portableMigration.test.ts`

Expected: FAIL because migration is missing.

- [ ] **Step 3: Implement day/provider/model reconciliation**

Run provider ingestion first. Aggregate its portable events by UTC day/provider/model. For each legacy `perModel` entry, calculate `max(legacy - ingested, 0)` independently for each token and cost component. Write a synthetic event only when at least one delta is positive, at `${date}T12:00:00.000Z`, with project `Imported legacy data`, a deterministic reconciliation ID, and `synthetic: true`.

Read legacy `snapshot` events from `debug/YYYY-MM-DD.jsonl`, sanitize them with the quota-store validator, and upsert them into the quota partitions. Write migration state `running` before changes and `complete` only after event and quota migration succeed. Preserve legacy files.

- [ ] **Step 4: Run migration tests**

Run: `npx vitest run tests/portableMigration.test.ts tests/backfill-reader.test.ts`

Expected: PASS with exact totals and idempotent rerun.

- [ ] **Step 5: Commit**

```powershell
git add src/portable/migration.ts src/reports/backfill-reader.ts tests/portableMigration.test.ts
git commit -m "feat: migrate legacy history into portable store"
```

## Task 7: Persist live quota observations independently of debug logging

**Files:**
- Create: `src/portable/quotaStore.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/analyticsWorker.ts`
- Test: `tests/portableQuotaStore.test.ts`

- [ ] **Step 1: Write failing quota-store tests**

Test monthly partitioning, dedupe by provider/fetchedAt, window preservation, range reads, and operation while debug logging is disabled.

```ts
await appendQuotaSnapshots(root, snapshots);
await appendQuotaSnapshots(root, snapshots);
expect(await readQuotaSnapshots(root, { since: "2026-07-01" })).toHaveLength(snapshots.length);
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/portableQuotaStore.test.ts`

Expected: FAIL because quota store functions are missing.

- [ ] **Step 3: Implement atomic quota partitions and integrate refresh**

Store sanitized `SnapshotEvent` records in `quota/snapshots/YYYY-MM.jsonl`, excluding `errorMessage` when it may include provider response details. In `refreshLoop.onRefresh`, call `appendQuotaSnapshots(getPortableQuotaDir(), snapshots)` independently of `DebugRecorder`.

Change window-budget/history readers in `analyticsWorker.ts` to accept portable quota observations. Retain legacy debug reads only inside migration code.

- [ ] **Step 4: Run quota/window tests**

Run: `npx vitest run tests/portableQuotaStore.test.ts tests/windowBudgetSeries.test.ts tests/windowRatioSeeder.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/portable/quotaStore.ts src/main/main.ts src/main/analyticsWorker.ts tests/portableQuotaStore.test.ts
git commit -m "feat: persist portable quota observations"
```

## Task 8: Make reports and History consume the portable store

**Files:**
- Modify: `src/reports/types.ts`
- Modify: `src/reports/reportService.ts`
- Modify: `src/main/detailsWindow.ts`
- Test: `tests/portableReports.test.ts`
- Modify: `tests/reports.test.ts`

- [ ] **Step 1: Write failing report parity and no-provider-read tests**

Build equivalent Claude/Codex fixtures as legacy entries and portable events. Assert daily, weekly, monthly, hourly, session, project, breakdown, date range, and provider totals match. Inject provider readers that throw and assert default reports still succeed from portable events.

```ts
const portable = await generateUsageReport(request, { usageEvents });
expect(portable.rows).toEqual(legacy.rows);
expect(portable.totals).toEqual(legacy.totals);
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/portableReports.test.ts`

Expected: FAIL because reports do not accept/use portable events.

- [ ] **Step 3: Cut report defaults over**

Replace `source?: "live" | "backfill"` with `source?: "portable" | "legacy"`, default to `portable`, and add `usageEvents?: PortableUsageEvent[]` plus `usageStore?: PortableUsageStore` to `ReportDeps`. Read the bounded date range from the store and use the reverse adapters for existing grouping/cost code. Keep `legacy` only for migration parity tests, not renderer IPC.

Update `reports:get`, Analytics summary report calls, and History requests to use the portable default without provider directory arguments.

- [ ] **Step 4: Run all report/history tests**

Run: `npx vitest run tests/portableReports.test.ts tests/reports.test.ts tests/windowHistory.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/reports/types.ts src/reports/reportService.ts src/main/detailsWindow.ts tests/portableReports.test.ts tests/reports.test.ts
git commit -m "refactor: serve reports from portable usage store"
```

## Task 9: Cut Models and Analytics over and enforce provider-reader isolation

**Files:**
- Modify: `src/main/modelsData.ts`
- Modify: `src/main/analyticsWorker.ts`
- Modify: `src/main/detailsWindow.ts`
- Test: `tests/portableAnalyticsParity.test.ts`
- Modify: `tests/modelsData.test.ts`
- Modify: `tests/analyticsDeepDive.test.ts`

- [ ] **Step 1: Write failing consumer parity tests**

For a fixture containing two providers, models, projects, sessions, cache tokens, and quota observations, compare the old calculation inputs with portable results for Models days, API costs, active days, session durations, heatmap, cache efficiency, top models, project statistics, and window history.

Also statically assert that `modelsData.ts` and the non-migration paths in `analyticsWorker.ts` do not import `jsonl-reader`, `codex-log-reader`, or `backfill-reader`.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/portableAnalyticsParity.test.ts`

Expected: FAIL while the consumers still read legacy/provider data.

- [ ] **Step 3: Replace consumer inputs**

Change worker inputs from `claudeProjectsDirs`, `codexSessionsDirs`, and `logDir` to serializable `usageRange` and `quotaRange`, or load `PortableUsageStore`/quota partitions inside the worker. Build Models days from portable events grouped by UTC day/provider/model. Build Analytics session metrics from `sessionKey` and timestamps, project metrics from `projectName`, and quota metrics from portable quota observations.

Make `DetailsWindowController.prewarmAnalytics()` prewarm portable partitions. A migration state other than `complete` returns a structured `portableDataPreparing: true` status rather than incomplete statistics.

- [ ] **Step 4: Run Models/Analytics suites**

Run: `npx vitest run tests/portableAnalyticsParity.test.ts tests/modelsData.test.ts tests/analyticsDeepDive.test.ts tests/windowBudgetSeries.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/modelsData.ts src/main/analyticsWorker.ts src/main/detailsWindow.ts tests/portableAnalyticsParity.test.ts tests/modelsData.test.ts tests/analyticsDeepDive.test.ts
git commit -m "refactor: serve analytics from portable stores"
```

## Task 10: Orchestrate startup migration and ongoing ingestion

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/main/debugBackfill.ts`
- Test: `tests/portableStartup.test.ts`

- [ ] **Step 1: Write failing startup-order tests**

Extract an injectable `preparePortableData()` orchestration function and assert order: provider ingestion, legacy reconciliation, quota migration, migration complete, then consumer prewarm. Assert a failed stage leaves state `failed`, preserves Backfill, and skips consumer cutover.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/portableStartup.test.ts`

Expected: FAIL because orchestration is missing.

- [ ] **Step 3: Integrate migration and periodic ingestion**

In `main.ts`, await `preparePortableData()` after runtime root discovery and before `prewarmAnalytics()`. Replace the 15-second Backfill timer with an ingestion timer that runs immediately after migration and after known source changes/manual recompute. Keep `runBackfill` only as a legacy migration input during the compatibility release; it must no longer feed views.

Log counts and durations only. Never log event bodies, tokens, or credentials.

- [ ] **Step 4: Run startup/backfill tests**

Run: `npx vitest run tests/portableStartup.test.ts tests/backfillManifest.test.ts tests/backfill-reader.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/main.ts src/main/debugBackfill.ts tests/portableStartup.test.ts
git commit -m "feat: activate portable data migration"
```

## Task 11: Define archive allowlist, checksums, limits, and cross-user settings

**Files:**
- Create: `src/portable/archiveManifest.ts`
- Test: `tests/portableArchiveManifest.test.ts`

- [ ] **Step 1: Write failing archive-policy tests**

Cover allowed relative paths, excluded auth/log/cache/backups, SHA-256 verification, maximum 25,000 entries, maximum 64 MiB per file, maximum 1 GiB expanded total, and path rejection for `../x`, `/x`, `C:\x`, UNC paths, empty segments, and case-insensitive duplicates.

Test cross-user sanitization:

```ts
const result = sanitizeImportedSettings({ ...defaultSettings, claudeRoots: ["C:\\Users\\Alice\\.claude"], codexHomes: ["C:\\Users\\Alice\\.codex"] }, "C:\\Users\\Bob");
expect(result.claudeRoots).toEqual([]);
expect(result.codexHomes).toEqual([]);
expect(result.plans).toEqual(defaultSettings.plans);
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/portableArchiveManifest.test.ts`

Expected: FAIL because archive policy is missing.

- [ ] **Step 3: Implement the policy**

Allow exactly `usage/events/**`, `usage/store-metadata.json`, `usage/migration-state.json`, `quota/**`, `settings.json`, `window-history.json`, `window-ratio.json`, `bonus-state.json`, `notification-state.json`, and `notifications.log`, plus root `manifest.json`. Explicitly exclude `usage/ingest-state.json` because it contains source-machine paths. Normalize ZIP separators to `/`, reject paths before any `getData()` call, calculate SHA-256 over bytes, and validate all manifest entries exactly once.

On import set `claudeRoots` and `codexHomes` to empty arrays unless a future explicit portable marker exists. Preserve machine-independent settings. Create a fresh empty `usage/ingest-state.json` on the target so it discovers only its own known paths.

- [ ] **Step 4: Run policy tests and commit**

Run: `npx vitest run tests/portableArchiveManifest.test.ts tests/settingsLoad.test.ts`

Expected: PASS.

```powershell
git add src/portable/archiveManifest.ts tests/portableArchiveManifest.test.ts
git commit -m "feat: secure portable archive policy"
```

## Task 12: Implement export, validated staging, full backup, and pending import

**Files:**
- Create: `src/portable/archiveService.ts`
- Test: `tests/portableArchiveService.test.ts`

- [ ] **Step 1: Write failing end-to-end service tests**

Use temporary source/target homes to cover:

- export contains only allowlisted entries and valid checksums;
- a `C:\Users\Alice` export stages for `C:\Users\Bob` with cleared roots;
- corrupt checksum, unsupported version, traversal, duplicate path, oversize header, and unexpected entry are rejected before writes;
- staging creates a verified full backup outside app data;
- `applyPendingImport()` replaces only portable paths and preserves `quotabar.log`, caches, and backup;
- injected rename failure rolls back current data;
- success removes pending/staging and retains the backup.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/portableArchiveService.test.ts`

Expected: FAIL because the service is missing.

- [ ] **Step 3: Implement export and validation without blind extraction**

Expose:

```ts
export async function exportPortableData(appDir: string, destinationZip: string): Promise<ExportResult>;
export async function stagePortableImport(zipPath: string, appDir: string, targetHome: string): Promise<StageImportResult>;
export async function createFullBackup(appDir: string, backupZip: string): Promise<BackupResult>;
export async function applyPendingImport(appDir: string): Promise<ApplyImportResult>;
```

Use `AdmZip` to enumerate entries, validate names/headers/manifest first, then read bytes and verify checksums. Write each validated entry yourself under the staging root; never call bulk extraction. Export to `destinationZip + ".partial"`, validate the finished archive, then rename.

Create full backups in a sibling `QuotaBar Backups` directory with timestamped names. Verify the backup by reopening it, enumerating entries, and reading every entry CRC before writing pending-import metadata.

For apply, rename current portable paths to a rollback directory, rename staged paths into place, and restore rollback paths if any operation fails. Do not replace the entire live app directory.

- [ ] **Step 4: Run archive tests**

Run: `npx vitest run tests/portableArchiveService.test.ts tests/portableArchiveManifest.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/portable/archiveService.ts tests/portableArchiveService.test.ts
git commit -m "feat: export and restore portable archives"
```

## Task 13: Apply pending imports before settings and expose IPC

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/main/detailsWindow.ts`
- Modify: `tests/detailsWindow.test.ts`
- Test: `tests/pendingImportStartup.test.ts`

- [ ] **Step 1: Write failing startup and IPC tests**

Mock Electron `dialog.showSaveDialog`, `dialog.showOpenDialog`, `app.relaunch`, and `app.exit`. Assert handlers `system:export-portable-data` and `system:import-portable-data` register; cancellation returns `{ ok: false, cancelled: true }`; successful import stages, calls relaunch, then exits; only one archive operation runs at once.

Assert `applyPendingImport()` runs inside `whenReady()` before `isFirstRun()` and `loadSettings()`.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/detailsWindow.test.ts tests/pendingImportStartup.test.ts`

Expected: FAIL because handlers/startup integration are missing.

- [ ] **Step 3: Add narrow main-process integration**

Add `dialog` to Electron imports. Export uses a `.zip` save dialog and calls `exportPortableData`. Import uses a single-file `.zip` open dialog, calls `stagePortableImport`, returns the verified backup path, then schedules `app.relaunch(); app.exit(0)` after the IPC response flushes.

Use a module-level `archiveOperation: "export" | "import" | null` guarded by `try/finally`. Return stable English error codes/messages and log only action, destination path, counts, and sanitized error text.

In startup, call `await applyPendingImport(getAppConfigDir())` before reading settings. A failed apply logs the rollback result and aborts normal startup instead of loading a mixed data set.

- [ ] **Step 4: Run integration tests and build**

Run: `npx vitest run tests/detailsWindow.test.ts tests/pendingImportStartup.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/main.ts src/main/detailsWindow.ts tests/detailsWindow.test.ts tests/pendingImportStartup.test.ts
git commit -m "feat: add portable archive IPC workflow"
```

## Task 14: Add System-tab export/import experience

**Files:**
- Modify: `src/renderer/tabs/system.js`
- Modify: `src/renderer/styles.css`
- Create: `tests/systemPortableTransferRenderer.test.ts`

- [ ] **Step 1: Write failing renderer-structure tests**

Follow existing renderer source tests. Assert English labels, button IDs, import warning, IPC channels, busy disabling, success/error result region, and no inline credential/auth wording in exported content.

```ts
expect(script).toContain("system:export-portable-data");
expect(script).toContain("system:import-portable-data");
expect(script).toContain("Import replaces portable statistics and settings");
expect(styles).toContain(".sys-transfer-result");
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/systemPortableTransferRenderer.test.ts`

Expected: FAIL because controls are absent.

- [ ] **Step 3: Add controls and state handling**

Place `Export data` and `Import data` beside `Delete` in the QuotaBar panel. Add an inline confirmation panel for import stating that current portable statistics/settings will be replaced, a backup is created automatically, and the app restarts on success.

Use one `_transferBusy` flag. Disable Export, Import, Delete, and repeated confirmation while busy. Display `Preparing archive…`, `Validating and backing up…`, success destination/backup, cancellation, or concise errors. Escape every main-process string with `QB.esc` before HTML insertion; use `textContent` for results.

- [ ] **Step 4: Run renderer tests**

Run: `npx vitest run tests/systemPortableTransferRenderer.test.ts tests/systemData.test.ts tests/appChrome.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/renderer/tabs/system.js src/renderer/styles.css tests/systemPortableTransferRenderer.test.ts
git commit -m "feat: add System data transfer controls"
```

## Task 15: Surface portable readiness and update documentation

**Files:**
- Modify: `src/main/systemData.ts`
- Modify: `src/renderer/tabs/system.js`
- Modify: `README.md`
- Modify: `docs/how-quotabar-calculates.md`
- Modify: `TESTING.md`
- Modify: `tests/systemData.test.ts`

- [ ] **Step 1: Write failing System-data tests**

Assert `collectSystemData()` lists Usage Store, Quota Snapshots, Migration State, and Pending Import under the QuotaBar app without scanning elsewhere. Assert migration status is returned as `pending`, `running`, `complete`, or `failed` without file contents.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/systemData.test.ts`

Expected: FAIL because portable paths are not listed.

- [ ] **Step 3: Add readiness display and English documentation**

Extend `buildAppSpecs()` with portable paths. Show `Portable data: Ready`, `Preparing`, or `Needs attention` in the QuotaBar panel. Document that provider logs are ingestion-only, the archive privacy boundary, different-username behavior, replacement semantics, automatic backup location, and restore steps.

Add a `TESTING.md` section describing fixture-home export from Alice and import into Bob, including assertions that no `C:\Users\Alice` active root remains.

- [ ] **Step 4: Run tests and prose checks**

Run:

```powershell
npx vitest run tests/systemData.test.ts tests/systemPortableTransferRenderer.test.ts
rg -n "auth\.json|\.credentials\.json|C:\\Users\\Alice" README.md docs/how-quotabar-calculates.md TESTING.md
```

Expected: tests PASS; documentation mentions auth only to state exclusion and Alice only in the cross-user test example.

- [ ] **Step 5: Commit**

```powershell
git add src/main/systemData.ts src/renderer/tabs/system.js README.md docs/how-quotabar-calculates.md TESTING.md tests/systemData.test.ts
git commit -m "docs: explain portable QuotaBar data"
```

## Task 16: Create and verify the mandatory production-data backup

**Files:**
- No repository files changed
- Backup output: outside `%USERPROFILE%\.quotabar-win`

- [ ] **Step 1: Stop QuotaBar and verify no process holds production data**

Run:

```powershell
Get-Process QuotaBar,electron -ErrorAction SilentlyContinue
```

Expected: no QuotaBar production process. Do not kill unrelated Electron applications; close QuotaBar through its tray menu.

- [ ] **Step 2: Create a timestamped full ZIP using the tested backup service**

Run the built backup entry point or a temporary read-only harness calling `createFullBackup`, targeting:

```text
%USERPROFILE%\QuotaBar Backups\quotabar-before-portable-migration-YYYYMMDD-HHmmss.zip
```

Do not place the ZIP below `.quotabar-win`.

- [ ] **Step 3: Verify archive readability and entry counts**

Run a temporary harness that opens the ZIP through `AdmZip`, calls `getData()` for every non-directory entry, and prints only entry count, total bytes, and relative names. It must not print file contents.

Expected: every entry reads successfully; the archive includes `settings.json`, `debug/*.backfill.jsonl`, `window-history.json`, and existing state files where present.

- [ ] **Step 4: Record the verified backup path in the working notes, not source control**

Do not proceed to productive migration unless the ZIP exists, is outside `.quotabar-win`, and the verification succeeded.

## Task 17: Full verification and real Electron transfer test

**Files:**
- Temporary only: `verify-main.cjs`, `verify-drive.cjs`, screenshots, fixture homes

- [ ] **Step 1: Run the full automated gates**

Run:

```powershell
npm test
npm run build
npm run lint
```

Expected: all tests PASS, build succeeds, lint reports no errors.

- [ ] **Step 2: Run a synthetic cross-user end-to-end test first**

Create temporary `Alice\.quotabar-win` and `Bob\.quotabar-win` fixtures. Populate Alice through the portable store APIs, export, stage/import for Bob, apply pending import, and assert all view IPC results match while Bob settings contain no Alice roots.

Expected: Models, Analytics, History, and Reports match fixture expectations; active paths resolve below Bob.

- [ ] **Step 3: Verify UI in real Electron at required sizes**

Follow `TESTING.md` using the real `DetailsWindowController`. At 900×660 and 750×520, open System and verify:

- Export and Import remain visible without overlap.
- Import confirmation is readable and keyboard reachable.
- Busy state prevents repeated actions.
- Cancel returns safely.
- Export success reports the chosen ZIP.
- A synthetic import stages and restarts successfully.

Capture screenshots and measure button/panel bounds. Inspect screenshots with the image viewer. Remove temporary harnesses and images afterward.

- [ ] **Step 4: Test production migration only after Task 16 backup**

Start the new build against the real data. Wait for portable status `Ready`; compare totals and representative ranges in Models, Analytics, History, and Reports with pre-migration screenshots/values. Export a portable ZIP, validate it, and import it into an isolated different-home fixture before attempting any other real-PC transfer.

Expected: no historical totals shrink, project names remain recognizable, no source username becomes an active path, and no credentials/provider logs appear in the portable ZIP.

- [ ] **Step 5: Inspect repository cleanliness**

Run:

```powershell
git status --short
git diff --check
```

Expected: only intended source/test/doc changes; no `dist`, `release`, `package-output`, backup ZIP, fixture data, screenshots, or temporary verify scripts.

- [ ] **Step 6: Request code review, address findings, and commit final fixes**

Use `superpowers:requesting-code-review`, re-run `npm test` and `npm run build` after fixes, then commit only reviewed source changes.

# Portable Refresh Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the portable migration revision and legacy-derived usage current after ongoing ingestion without allowing stale refresh or prewarm failures to overwrite newer work.

**Architecture:** Add optimistic migration-state ownership transitions using the existing complete revision and running `updatedAt` fingerprint. Drive every ongoing trigger through a changed-only ingestion/reconciliation/completion pipeline, preserving the migration-lock-to-store-lock order and refreshing consumers only after a changed commit.

**Tech Stack:** TypeScript, Node.js filesystem locks, Vitest, Electron main process

---

### Task 1: Bind failure transitions to their owner

**Files:**
- Modify: `src/portable/migration.ts`
- Modify: `src/main/debugBackfill.ts`
- Test: `tests/portableStartup.test.ts`
- Test: `tests/detailsWindow.test.ts`

- [ ] **Step 1: Write failing ownership tests**

Add tests that complete revision `R`, move the state to a newer `running` state behind a barrier, reject A's prewarm, and assert A receives a superseded result while B remains running and can complete. Add the control test in which state remains `complete/R` and A writes `consumer_prewarm_failed`. Preserve future-state and already-failed assertions.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/portableStartup.test.ts tests/detailsWindow.test.ts`

Expected: the newer running state is overwritten by A's unowned prewarm failure.

- [ ] **Step 3: Implement expected-state failure comparison**

Introduce the exact expectation type and optional argument:

```ts
export type MigrationStateExpectation =
  | { status: "complete"; storeRevision: string }
  | { status: "running"; updatedAt: string };

export async function markMigrationFailed(
  statePath: string,
  lastError: PortableMigrationFailureCode,
  expectation?: MigrationStateExpectation,
  now: () => Date = () => new Date(),
): Promise<MigrationStateTransitionResult>;
```

Compare the expectation under `.portable-migration.lock` before writing. In `preparePortableData`, retain the completed revision and pass `{ status: "complete", storeRevision }` only for `consumer_prewarm_failed`.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- tests/portableStartup.test.ts tests/detailsWindow.test.ts`

Expected: all selected tests pass.

### Task 2: Add refresh ownership and exact completion

**Files:**
- Modify: `src/portable/migration.ts`
- Test: `tests/portableStartup.test.ts`
- Test: `tests/fixtures/portableFinalizeChild.test.ts`

- [ ] **Step 1: Write failing transition and process tests**

Test an atomic `complete/R -> running(owner)` transition, owner-checked completion, owner-checked failure, stale store revision rejection, and a child-process barrier in which an older owner cannot complete after a newer process takes the state.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/portableStartup.test.ts`

Expected: refresh transition APIs are missing or stale ownership overwrites current state.

- [ ] **Step 3: Implement refresh transition APIs**

Add:

```ts
export type MigrationRefreshOwner = { status: "running"; updatedAt: string };

export async function beginMigrationRefresh(
  statePath: string,
  expectedCompleteRevision: string,
  now?: () => Date,
): Promise<MigrationStateTransitionResult | { status: "applied"; owner: MigrationRefreshOwner }>;
```

Allow deferred legacy reconciliation to accept the owner, verify it under the already-held migration lock, and avoid rewriting `running`. Extend completion to accept the owner and require an exact state match before acquiring the store writer lock. Keep migration lock outermost.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- tests/portableStartup.test.ts`

Expected: all selected tests pass, including the real child-process barrier.

### Task 3: Replace ongoing bare ingestion with changed-only refresh

**Files:**
- Modify: `src/main/debugBackfill.ts`
- Modify: `src/main/main.ts`
- Modify: `src/portable/migration.ts`
- Test: `tests/portableStartup.test.ts`
- Test: `tests/portableMigration.test.ts`

- [ ] **Step 1: Write failing refresh behavior tests**

Cover complete `R`, one new provider event, legacy reconciliation shrinking the synthetic delta, exact final revision, readiness without restart, shared manual/source triggers, zero-change stable state/no prewarm, and source deletion preserving stored provider events.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/portableStartup.test.ts tests/portableMigration.test.ts tests/detailsWindow.test.ts`

Expected: ongoing lifecycle leaves complete state at the old revision and readiness becomes false.

- [ ] **Step 3: Implement `refreshPortableData` and wire main**

The orchestrator performs:

```ts
const before = await dependencies.readCompleteRevision();
const ingestion = await dependencies.ingestProviderEvents();
if (ingestion.inserted + ingestion.updated === 0) return { status: "unchanged" };
const begun = await dependencies.beginRefresh(before);
if (transitionWasSuperseded(begun)) return { status: "superseded" };
const legacy = await dependencies.reconcileLegacy(await dependencies.readLegacyRecords(), begun.owner);
const completed = await dependencies.completeRefresh(legacy.storeRevision, begun.owner);
if (transitionWasSuperseded(completed)) return { status: "superseded" };
await dependencies.refreshConsumers();
return { status: "complete" };
```

On owned failures, write only fixed supported categories using the running or completed expectation. Wire the existing coalescing lifecycle so startup, source-change, and manual recompute all call this pipeline. Do not reread quota during refresh.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- tests/portableStartup.test.ts tests/portableMigration.test.ts tests/detailsWindow.test.ts`

Expected: all selected tests pass.

### Task 4: Verify and commit

**Files:**
- Modify only files required by Tasks 1-3.

- [ ] **Step 1: Run focused tests**

Run: `npm test -- tests/portableStartup.test.ts tests/portableMigration.test.ts tests/portableUsageStore.test.ts tests/detailsWindow.test.ts`

Expected: all selected tests pass.

- [ ] **Step 2: Run full gates**

Run: `npm test`

Run: `npm run build`

Run: `npm run lint`

Run: `git diff --check`

Expected: every command exits zero with no failures.

- [ ] **Step 3: Commit the race fixes**

```bash
git add src/main/debugBackfill.ts src/main/main.ts src/portable/migration.ts tests/portableStartup.test.ts tests/portableMigration.test.ts tests/detailsWindow.test.ts tests/fixtures/portableFinalizeChild.test.ts docs/superpowers/plans/2026-07-13-portable-refresh-ownership.md
git commit -m "fix: keep portable refresh revision current"
```

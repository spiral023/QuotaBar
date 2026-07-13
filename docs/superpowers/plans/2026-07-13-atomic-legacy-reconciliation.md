# Atomic Legacy Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep portable legacy-derived events exactly reconciled after later provider ingestion without races, stale deltas, or unsafe state skips.

**Architecture:** Add a store-owned derived reconciliation operation that builds and applies legacy-only upserts/removals from one locked snapshot and returns a content revision. Run migration under an outer cross-process migration lock, bind complete state to the returned store revision, normalize model identities, and carry Codex reasoning through Backfill parsing.

**Tech Stack:** TypeScript, Node.js filesystem primitives, Vitest, Electron portable JSONL store.

---

### Task 1: Atomic derived store operation

**Files:**
- Modify: `src/portable/usageStore.ts`
- Modify: `tests/portableUsageStore.test.ts`

- [ ] Add a failing test for `reconcileLegacyDerived(builder)` proving the builder sees one snapshot and can update/remove only `legacy-reconciliation` events.
- [ ] Run `npm test -- tests/portableUsageStore.test.ts` and verify the missing API fails.
- [ ] Implement the operation inside `exclusive()`: scan once, clone events for the builder, validate legacy-only incoming/removal IDs, update partitions and metadata in one `commitTransaction`, and return `{ inserted, updated, removed, existing, revision }`.
- [ ] Derive `revision` from canonical serialized metadata plus partition contents so unchanged content has the same revision and provider ingestion changes it.
- [ ] Run the store tests and verify they pass.

### Task 2: Late-ingestion reconciliation and revision-bound state

**Files:**
- Modify: `src/portable/migration.ts`
- Modify: `src/portable/types.ts`
- Modify: `tests/portableMigration.test.ts`

- [ ] Add the failing regression: legacy 10/provider 4 creates 6; provider reaches 6 updates synthetic to 4; provider reaches 10 removes synthetic.
- [ ] Run `npm test -- tests/portableMigration.test.ts` and verify the stale maximum policy fails.
- [ ] Move baseline/delta construction into `reconcileLegacyDerived`; persist exact historical targets on stable legacy-only markers, emit exact desired deltas, and retain zero-valued markers after providers cover the target.
- [ ] Add `storeRevision` to strict migration state parsing/writing; skip only when current revision equals the complete state's revision.
- [ ] Run migration/store tests and verify exact total remains 10.

### Task 3: Cross-process migration lock and forward safety

**Files:**
- Modify: `src/portable/rootLock.ts`
- Modify: `src/portable/migration.ts`
- Modify: `tests/rootLock.test.ts`
- Modify: `tests/portableMigration.test.ts`

- [ ] Add failing tests for the `.portable-migration.lock` name, concurrent migrations, and future state versions remaining byte-identical.
- [ ] Generalize named locks to accept the migration lock and document order: migration/ingestion lock first, store lock second; store code never acquires a named outer lock.
- [ ] Wrap recovery, state decision, derived reconciliation, and final state write in the migration lock.
- [ ] Reject future schema or usage migration versions with `Portable migration state is newer than this QuotaBar version` before writing state or store data.
- [ ] Run root-lock and migration tests.

### Task 4: Reasoning and normalized identities

**Files:**
- Modify: `src/reports/types.ts`
- Modify: `src/reports/backfill-reader.ts`
- Modify: `src/portable/migration.ts`
- Modify: `src/portable/eventIdentity.ts`
- Modify: `tests/backfill-reader.test.ts`
- Modify: `tests/portableMigration.test.ts`
- Modify: `tests/portableEventIdentity.test.ts`

- [ ] Add failing Backfill tests for explicit Codex reasoning, derived older reasoning, and negative inconsistent remainder rejection.
- [ ] Add failing migration tests proving dated/canonical aliases aggregate under `normalizeModelName` and reasoning deltas reconcile.
- [ ] Add failing identity test proving optional `domain` preserves provider hashes when omitted and separates legacy IDs when supplied.
- [ ] Extend Backfill model entries with `reasoningOutputTokens`; parse explicit reasoning or derive `totalTokens - normalized components`, rejecting negative results.
- [ ] Normalize both provider and legacy model keys before aggregation; aggregate legacy aliases rather than overwrite them.
- [ ] Pass `domain: "legacy-reconciliation-v1"` for synthetic event IDs.
- [ ] Run Backfill, migration, identity, and adapter tests.

### Task 5: Verification and commit

**Files:**
- Review all modified files above.

- [ ] Run `npm test -- tests/portableMigration.test.ts tests/backfill-reader.test.ts tests/portableUsageStore.test.ts tests/portableEventIdentity.test.ts tests/portableEventAdapters.test.ts`.
- [ ] Run `npm run build`, `npm test`, `npm run lint`, and `git diff --check`.
- [ ] Confirm no build artifacts or unrelated files are staged.
- [ ] Commit with `git commit -m "fix: reconcile legacy deltas atomically"`.

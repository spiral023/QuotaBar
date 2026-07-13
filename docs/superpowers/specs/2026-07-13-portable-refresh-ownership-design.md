# Portable Refresh Ownership Design

## Goal

Keep portable analytics ready after ongoing provider ingestion by reconciling legacy-derived events and publishing the exact current store revision, while preventing stale refresh or prewarm failures from overwriting newer migration work.

## Refresh pipeline

The ongoing lifecycle uses a dedicated refresh orchestrator instead of calling provider ingestion alone. It reads the currently complete migration state, ingests provider events, and exits without changing migration state or prewarming consumers when ingestion reports no inserted or updated events.

When ingestion changes the store, the orchestrator atomically changes the previously observed `complete` state to `running` only when its status and `storeRevision` still match. The transition returns the exact persisted running-state fingerprint, using the existing `updatedAt` field rather than adding a schema operation token. Legacy day records are then reread and reconciled against all current provider and legacy-derived events. This updates the stable synthetic identities so their positive deltas shrink as provider coverage grows. Provider events remain append-only; a deleted source file does not remove previously ingested events.

Completion requires both the exact running-state fingerprint and the reconciled UsageStore revision. The migration lock is acquired before the UsageStore writer lock. The completion callback writes `complete` only while the store revision is still current. A newer state owner or store mutation returns a superseded result and cannot be overwritten.

Quota snapshots are not reread during ongoing refreshes. After a changed refresh completes, consumers are refreshed once through the existing bounded analytics prewarm. A zero-change refresh performs neither migration-state writes nor consumer prewarm.

Manual recompute, source-change polling, and startup lifecycle triggers all enter the same serialized/coalescing refresh runner.

## Failure ownership

A refresh failure writes a supported sanitized failure code only if the current migration state still exactly matches the running-state fingerprint created by that refresh. If another process has replaced the state, the failed transition is superseded.

Startup consumer prewarm occurs after completion. If it fails, its failure transition compares the current state atomically with `complete` plus the exact revision just completed by that startup. It may write `consumer_prewarm_failed` only on that match. If another process has moved the state to `running`, completed another revision, written a supported failure, or installed a future state, the older prewarm failure is superseded and leaves the newer state unchanged.

## Locking

All compound migration-state checks and writes use the migration lock. Operations that also verify the UsageStore use the fixed global order:

1. Migration lock.
2. UsageStore writer/root lock.

UsageStore operations never acquire the migration lock, so no inverse edge is introduced. Provider ingestion finishes before refresh ownership is acquired; if ownership is lost, the winning refresh sees and reconciles the already committed provider events.

## Tests

Tests first establish the current failures, then cover:

- a complete revision followed by provider ingestion, legacy-delta adjustment, exact completion, and readiness without restart;
- identical behavior for manual and source-change triggers;
- zero-change stability with no state rewrite or prewarm;
- a deterministic stale completion barrier, including a separate process;
- an older prewarm failure racing a newer running owner, with the newer owner preserved and able to complete;
- a genuine prewarm failure while the matching complete revision remains current;
- preservation of future-state and already-failed semantics;
- append-only behavior when a source disappears.

No renderer behavior changes, so Electron window verification is outside this change.

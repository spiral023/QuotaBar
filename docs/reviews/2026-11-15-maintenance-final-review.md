# Final maintenance review — 2026-11-15

Reviewed all tracked changes and new modules against baseline
`4b7a6e40524af09f8c9b0fceadfd1bed57f13e0e`. Requirements came from the agreed
maintenance work: renderer correctness, module separation, typed IPC, bounded
caches, incremental daily metrics, asynchronous logging, dependency/CI hygiene
and real Electron verification. Standards came from `AGENTS.md`, `TESTING.md`,
`PERFORMANCE.md` and `docs/dependency-maintenance.md`.

## Standards

**P2 — Preserve canonical global deduplication across incremental rebuilds.**
After a cross-month duplicate is excluded by a global rebuild, a later managed
write could rebuild its month independently and reintroduce it. Reports and
Models then counted four events instead of the canonical three. This violated
the documented canonical-data/cache contract. The independent standards review
found no other concrete documented-standard violation.

## Spec

**P1 — Incremental daily metrics must preserve global ID deduplication.**
The independent requirements review reproduced the same duplicate regression.
Counterexamples also covered an external edit immediately followed by a managed
write, and external removal of the winning duplicate followed by a write. The
latter lost a previously excluded event: two events instead of three.

**P2 — Exact partial ranges must preserve imported offset timestamps.**
Offset events have individual aggregate rows. A partially included UTC row
reread every event for the same provider/model, counting an overlapping offset
event again. A two-event interval incorrectly returned three events.

## Additional implementation review

**P2 — Application logging must respect the archive application lock.**
The asynchronous logger could append or rotate while an archive snapshot held
the application lock. A focused test confirmed that logger flush completed
inside the protected snapshot. It now acquires the same application lock around
stat, rotation and append. Its lock order has no reverse dependency on usage,
quota or migration locks; restart/shutdown flushes occur outside archive locks.

## Corrections and regression coverage

- Snapshot format 3 records whether monthly contributions are independent of
  global deduplication. Ambiguous snapshots reuse unchanged data, but any source
  or generation change requires a full canonical rebuild. Older snapshots are
  rebuilt because their provenance is unknown.
- Managed writes detect existing cross-month duplicates before mutation and
  invalidate the global epoch. This also catches external edits masked by the
  following managed write's partition generation.
- Exact-range fallback selects only the original aggregate row's identity, so
  independent offset rows cannot be included twice.
- Duplicate tests cover ordinary upsert, ingestion reconciliation and legacy
  reconciliation, with and without an intervening read. Inverse tests empty or
  remove the winning partition. A migration test checks old-cache rebuilding.
- The offset fixture now retains its original offset explicitly; its adapter
  previously normalized it before the test exercised the store.
- Logger lock tests prove that queued writes wait until the snapshot releases
  its lock. Redaction remains before enqueueing.

Every confirmed issue was reproduced by a failing isolated synthetic regression
before its correction. Focused follow-up reviews found no remaining issue in
these fixes. No provider credentials or production statistics were used.

Standards: one confirmed finding. Spec: two confirmed findings, including the
duplicate finding shared with Standards. Implementation review: one additional
finding. All three distinct problems are corrected.

## Final verification

- Node 22.23.4/npm 11.21.2: `npm run verify` passed typechecks, lint, 1,556 tests
  and build. Seven child-fixture placeholders are intentionally skipped.
- `npm run test:coverage` passed: 92.37% lines and 83.57% branches in the
  documented selected scope. Full and production-only npm audits found zero
  known vulnerabilities.
- All three performance tools passed with unchanged result hashes. Updated-month
  daily reads still use one JSONL read; unchanged warm reads require zero.
  Timings and limitations are recorded in `PERFORMANCE.md`.
- `npm run test:electron` passed the real isolated Electron window, both sizes,
  seven tabs, compact/onboarding views and renderer correctness regressions.
- `npm run package` built NSIS, portable EXE and ZIP without publishing.
- `npm run test:update` passed the real installed update inside Windows Sandbox:
  checksum rejection, valid retry/download, install, automatic relaunch and
  retained settings/canonical usage. Both fixture installers matched 183 runtime
  files. Evidence: `package-output/update-smoke/results-1794703161632/` (ignored).
- No runtime source module exceeds 1,000 lines; the largest has 988 lines.

No confirmed blocking review finding remains. Public GitHub/CDN update delivery,
signing and SmartScreen reputation are outside the guest-local acceptance test.

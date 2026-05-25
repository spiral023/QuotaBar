# Debug Log: Structured Local Activity Stream

**Date:** 2026-05-26
**Status:** Draft (pending user review)

## Background

QuotaBar currently writes a human-readable text log at `~/.quotabar-win/quotabar.log` covering app status and errors. The actual usage values (5-hour %, weekly %, token totals, costs) live only in the in-memory `UsageStore` and never reach disk. This makes debugging and post-hoc analysis difficult: when a user wonders "what was my Claude weekly % yesterday at 14:00?", there is no record to consult.

## Goals

- Persist every refresh result and every relevant app activity to a local file in a structured format that is both **live-tailable** and **analysis-friendly**.
- Support **historical backfill** of token-level data for past days from the existing Claude/Codex JSONL session files.
- Keep the implementation small, explicit, and isolated from the live data path.

## Non-Goals

- Reconstructing historical live snapshot values (5h %, weekly %, reset times, pace) — these only exist at fetch-time and are unrecoverable.
- A remote sink or cloud upload. Everything stays local.
- A query UI inside the app. Users tail/`jq` the files themselves.

## Decisions (already settled with user)

| Decision | Value |
|---|---|
| Format | JSONL (one JSON object per line) |
| File layout | One file per UTC day, all event kinds mixed |
| Directory | `~/.quotabar-win/debug/` |
| Filename (live) | `YYYY-MM-DD.jsonl` |
| Filename (backfill) | `YYYY-MM-DD.backfill.jsonl` |
| Redaction | `email` and `account_id`/`accountId` fields → `"<redacted>"`. Access/refresh tokens are never present in the structures we log. |
| Activation | `settings.json` field `debugLog.enabled`, default `true` |
| Retention | None — files are kept forever; user cleans up manually |
| Architecture | Approach A: explicit `DebugRecorder` module, called from integration points |

## Architecture

A new `DebugRecorder` module owns file I/O. Other modules (`main`, `refreshLoop`, `detailsWindow`, providers) call `recorder.write(event)` at well-defined points. The recorder applies redaction, serializes to JSON, and appends the line to today's UTC-dated file. When `debugLog.enabled` is `false`, every `write` call is a cheap no-op.

```
                   ┌──────────────┐
   main.ts ────────▶              │
   refreshLoop ────▶ DebugRecorder│ ─── appendFile ───▶ debug/YYYY-MM-DD.jsonl
   detailsWindow ──▶              │
   backfillJob ────▶              │ ─── appendFile ───▶ debug/YYYY-MM-DD.backfill.jsonl
                   └──────────────┘
                          │
                          ▼
                   redactPII(event)
```

### Module breakdown

| File | Role |
|---|---|
| `src/main/debugRecorder.ts` (new) | The appender. Holds the enabled flag, computes today's filename, redacts, writes JSONL. |
| `src/main/debugEvents.ts` (new) | TypeScript discriminated union of all event kinds + factory helpers. |
| `src/main/debugBackfill.ts` (new) | One-shot historical reconstruction from Claude/Codex JSONL session files. |
| `src/shared/redaction.ts` (modify) | Add `redactPII(obj)` for structured PII redaction (email, account_id). |
| `src/config/settings.ts` (modify) | Add `debugLog: { enabled: boolean }` field with `enabled: true` default. |
| `src/config/paths.ts` (modify) | Add `getDebugLogDir()`, `getDebugLogPath(date)`, `getDebugBackfillPath(date)`. |
| `src/main/main.ts` (modify) | Instantiate recorder, emit `app.start` / `app.exit`, kick off backfill. |
| `src/usage/refreshLoop.ts` (modify) | Emit `refresh.start`, `snapshot` (one per provider per refresh), `refresh.skipped`. |
| `src/main/detailsWindow.ts` (modify) | Emit `dashboard.open` / `dashboard.close` / `dashboard.refreshRequested`. |
| `src/main/menu.ts` (modify) | Add "Backfill regenerieren" tray menu item (force re-backfill). |

## Event Schema

Every event has the same envelope and a `kind` discriminator:

```json
{ "ts": "2026-05-26T14:23:01.842Z", "kind": "<event-kind>", "...event-specific fields": "..." }
```

`ts` is always ISO 8601 UTC with milliseconds. The recorder sets it automatically — callers do not supply it.

### Event kinds

#### `app.start`
```json
{"ts":"...","kind":"app.start","version":"0.5.2","pollIntervalSeconds":60,"noWindow":false,"platform":"win32"}
```

#### `app.exit`
Best-effort on `before-quit`. Not guaranteed (process crash, kill).
```json
{"ts":"...","kind":"app.exit","reason":"user-quit"}
```

#### `refresh.start`
```json
{"ts":"...","kind":"refresh.start","providers":["claude","codex"],"trigger":"interval"}
```
`trigger` ∈ `"interval" | "manual" | "dashboard"`.

#### `refresh.skipped`
Emitted when a provider is in backoff.
```json
{"ts":"...","kind":"refresh.skipped","provider":"claude","reason":"rate-limited","remainingSeconds":287}
```

#### `snapshot`
One per provider per refresh, including failed ones. Mirrors `UsageSnapshot` 1:1 with two adjustments: PII redacted, and `costFactor` is serialized under the cleaner field name `cost` for readability when grepping the log. `ts` is the recorder write time; `fetchedAt` is the snapshot's `updatedAt` (when the provider returned data) — keeping both lets us distinguish recorder lag from API freshness.
```json
{
  "ts":"...","kind":"snapshot","provider":"claude","status":"ok",
  "planType":"max_5x",
  "windows":[
    {"name":"fiveHour","usedPercent":3.14,"resetsAt":"2026-05-26T17:00:00Z","windowSeconds":18000},
    {"name":"weekly","usedPercent":18.42,"resetsAt":"2026-05-28T12:00:00Z","windowSeconds":604800,
     "pace":{"stage":"onTrack","expectedPercent":17.9,"deltaPercent":0.5}}
  ],
  "cost":{
    "apiCostUSD":0.42,"subscriptionCostUSD":1.33,"factor":0.31,"isEstimate":false,
    "tokens":{"input":1240,"output":890,"cacheCreation":0,"cacheRead":15800,"total":17930,
              "models":["claude-sonnet-4-6"]}
  },
  "fetchedAt":"..."
}
```

For `status: "error"` / `"not_authenticated"`, `windows` is `[]` and an `errorMessage` field is present.

#### `refresh.error`
Distinct from a per-snapshot error — fires when the whole refresh loop catches something unexpected.
```json
{"ts":"...","kind":"refresh.error","message":"..."}
```

#### `auth.refresh`
```json
{"ts":"...","kind":"auth.refresh","provider":"claude","success":true,"durationMs":412}
```

#### `dashboard.open` / `dashboard.close` / `dashboard.refreshRequested`
```json
{"ts":"...","kind":"dashboard.open"}
{"ts":"...","kind":"dashboard.refreshRequested"}
{"ts":"...","kind":"dashboard.close"}
```

#### `tokens.usage` (backfill only)
One per Claude `ClaudeUsageEntry` / Codex `CodexTokenEvent`.
```json
{
  "ts":"2026-05-20T14:23:01Z","kind":"tokens.usage","provider":"claude",
  "model":"claude-sonnet-4-6","session":"abc...","project":"QuotaBar",
  "input":1240,"output":890,"cacheCreation":0,"cacheRead":15800,"costUSD":0.042
}
```
Codex variant uses `cachedInput` and `reasoningOutput` instead of `cacheCreation` / `cacheRead`.

#### `tokens.daySummary` (backfill only)
One per provider per day with aggregated totals.
```json
{
  "ts":"2026-05-20T23:59:59.999Z","kind":"tokens.daySummary","provider":"claude","date":"2026-05-20",
  "input":48200,"output":12400,"cacheCreation":1200,"cacheRead":284000,"totalTokens":345800,
  "totalCostUSD":1.23,"sessionCount":7,
  "models":["claude-sonnet-4-6","claude-opus-4-7"],
  "perModel":{
    "claude-sonnet-4-6":{"input":40000,"output":10000,"cacheRead":250000,"costUSD":0.95},
    "claude-opus-4-7":{"input":8200,"output":2400,"cacheRead":34000,"costUSD":0.28}
  }
}
```

#### `backfill.start` / `backfill.done`
Written to the live file (not backfill file) so the user can see backfill ran.
```json
{"ts":"...","kind":"backfill.start","days":["2026-05-20","2026-05-21","2026-05-22"]}
{"ts":"...","kind":"backfill.done","daysWritten":3,"daysSkipped":12,"durationMs":1842}
```

## DebugRecorder API

```typescript
class DebugRecorder {
  constructor(private opts: { enabled: boolean; logDir: string });
  setEnabled(enabled: boolean): void;
  write(event: DebugEvent): void;             // fire-and-forget, no await needed
  writeBackfill(date: string, event: DebugEvent): void; // routes to YYYY-MM-DD.backfill.jsonl
  flush(): Promise<void>;                     // awaits pending writes (for tests / shutdown)
}
```

- Disabled → `write` is `return;` immediately, no allocation, no file work.
- Writes are queued internally and drained with `appendFile` in arrival order. The recorder keeps one open append promise per file; the next write chains to it. This avoids interleaved/torn lines without manual locking.
- I/O errors are caught and logged to `console.error` once per file per minute (avoid log spam if disk is full).

## Redaction

Add `redactPII(value)` to `src/shared/redaction.ts`. It deep-clones the object and replaces values at the following keys with the string `"<redacted>"`:

- `email`
- `account_id`
- `accountId`
- `user_id`
- `userId`

The existing `redactSecrets` regex pass for tokens stays as a defense-in-depth pass on the serialized JSON.

## Backfill

Triggered once at app start when `debugLog.enabled` is `true`. Logic:

```
1. For each day D from the earliest session-file mtime up to yesterday (UTC):
2.   If debug/<D>.backfill.jsonl already exists → skip
3.   Read all Claude entries + all Codex events whose timestamp falls in [D 00:00 UTC, D+1 00:00 UTC)
4.   For each entry → write tokens.usage event
5.   Compute per-provider daily aggregates → write two tokens.daySummary events (claude + codex, if data exists)
6.   fsync, move on to next day
```

Today's date is also backfilled (events up to "now"), so on every app start you get a fresh `today.backfill.jsonl`. To re-run a force backfill for all days, the user clicks the tray entry "Backfill regenerieren" which deletes existing `.backfill.jsonl` files and re-runs step 1.

Running cost: the readers already scan every JSONL on every refresh for cost calculation, so this adds at most one pass per day on app start.

## Settings Schema Change

```typescript
// settings.ts
export interface DebugLogSettings {
  enabled: boolean;
}

export interface Settings {
  // ...existing...
  debugLog: DebugLogSettings;
}

export const defaultSettings: Settings = {
  // ...existing...
  debugLog: { enabled: true },
};
```

`normalizeSettings` adds `debugLog: { enabled: Boolean(settings.debugLog?.enabled ?? true) }`.

## Testing

Unit tests in the existing test harness (mirror nearby tests):

- **`debugRecorder.test.ts`**: disabled = no file created; enabled = file at correct path with one JSONL line per `write`; multi-line content is valid JSONL (each line parses); writes during the same UTC day go to the same file; rolling at midnight UTC opens the new file.
- **`debugBackfill.test.ts`**: fixture with Claude + Codex JSONL → expected daily aggregates emitted; idempotent (second run skips existing files); force-regenerate path deletes & re-runs.
- **`redactPII.test.ts`**: each PII key replaced; non-PII keys preserved; nested objects/arrays handled.
- **Integration smoke**: `refreshLoop.refreshNow()` with recorder wired up → events for `refresh.start` + per-provider `snapshot` land in the file.

## Out of scope (explicit)

- Live-toggle of `debugLog.enabled` without app restart. (If the user edits settings, the change is picked up on next restart. Not worth the complexity now.)
- Compression / archival. Files are small text; users can `zstd` them if they care.
- Schema versioning. The `kind` field is the schema; if it changes we ship a new `kind` value.

## Open implementation questions

None as of this draft. Move to plan-writing.

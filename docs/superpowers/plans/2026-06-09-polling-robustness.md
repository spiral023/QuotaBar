# Polling-Robustheit & Nachvollziehbarkeit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backfill nur noch geänderte Quelldateien parsen, Rate-Limit-Retries entschärfen, Polling-Lücken (Schlaf/Netzwerk) als Events erklärbar machen und das Kostenfenster im Dashboard sichtbar machen.

**Architecture:** Vier Teile teilen sich die Event-Infrastruktur in `debugEvents.ts`/`DebugRecorder`. Reine Helfer (`computeBackoffMs`, `classifyFetchError`, `backfillManifest`) sind seiteneffektfrei und per Vitest getestet; `RefreshLoop` und `main.ts` verdrahten sie. Der Renderer (Vanilla-JS) bekommt ein Kostenfenster-Badge.

**Tech Stack:** TypeScript, Electron (`powerMonitor`), Vitest, Vanilla-JS + Inline-CSS.

**Spec:** `docs/superpowers/specs/2026-06-09-polling-robustness-design.md`

---

## File Structure

| Action | Path | Responsibility |
|---|---|---|
| Modify | `src/main/debugEvents.ts` | Alle neuen Event-Interfaces + Union-Einträge |
| **Create** | `src/usage/backoff.ts` | Reiner `computeBackoffMs`-Helfer |
| **Create** | `tests/backoff.test.ts` | Unit-Tests für `computeBackoffMs` |
| **Create** | `src/usage/fetchErrorClassifier.ts` | `classifyFetchError` (dns/network/other) |
| **Create** | `tests/fetchErrorClassifier.test.ts` | Unit-Tests für die Klassifizierung |
| Modify | `src/usage/refreshLoop.ts` | Backoff, Netzwerk-Events, cost.window.changed |
| Modify | `tests/refreshLoop.test.ts` | Tests für Backoff-Reset & Netzwerk-Events |
| **Create** | `src/main/lifecycleEvents.ts` | powerMonitor-Verdrahtung (suspend/resume/lock) |
| Modify | `src/main/main.ts` | `lifecycleEvents` registrieren |
| Modify | `src/pricing/jsonl-reader.ts` | `listClaudeSourceFiles` + `readClaudeUsageEntriesFromFiles` |
| Modify | `src/pricing/codex-log-reader.ts` | `listCodexSourceFiles` + `readCodexTokensFromFiles` |
| **Create** | `src/main/backfillManifest.ts` | Persistentes Quelldatei-Signatur-Manifest |
| **Create** | `tests/backfillManifest.test.ts` | Unit-Tests für Manifest-Logik |
| Modify | `src/main/debugBackfill.ts` | Backfill nutzt Manifest + FromFiles-Reader |
| Modify | `tests/debugBackfill.test.ts` | Tests für Skip-Verhalten (falls vorhanden, sonst neu) |
| Modify | `src/pricing/subscription-factor.ts` | `calculationMode` setzen |
| Modify | `src/providers/types.ts` | `calculationMode` in `CostFactorResult` |
| Modify | `src/renderer/tabs/live.js` | Kostenfenster-Badge + Tooltip |
| Modify | `src/renderer/index.html` | CSS für Window-Badge |

---

## Task 1: Neue Event-Typen definieren

**Files:**
- Modify: `src/main/debugEvents.ts`

- [ ] **Step 1: Union-Typ erweitern**

In `src/main/debugEvents.ts` die `DebugEvent`-Union ergänzen — füge die neuen Member am Ende der Union ein (vor dem abschließenden `;`):

```typescript
export type DebugEvent =
  | AppStartEvent
  | AppExitEvent
  | RefreshStartEvent
  | RefreshSkippedEvent
  | RefreshErrorEvent
  | SnapshotEvent
  | AuthRefreshEvent
  | DashboardOpenEvent
  | DashboardCloseEvent
  | DashboardRefreshRequestedEvent
  | TokensUsageEvent
  | TokensDaySummaryEvent
  | BackfillStartEvent
  | BackfillSkippedEvent
  | BackfillDoneEvent
  | SystemSuspendEvent
  | SystemResumeEvent
  | SystemLockEvent
  | SystemUnlockEvent
  | NetworkCheckFailedEvent
  | DnsLookupFailedEvent
  | NetworkRecoveredEvent
  | CostWindowChangedEvent;
```

- [ ] **Step 2: `BackfillDoneEvent` erweitern und neue Interfaces hinzufügen**

Ersetze die bestehende `BackfillDoneEvent`-Zeile:

```typescript
export interface BackfillDoneEvent { kind: "backfill.done"; daysWritten: number; daysSkipped: number; durationMs: number; }
```

durch:

```typescript
export interface BackfillDoneEvent {
  kind: "backfill.done";
  daysWritten: number;
  daysSkipped: number;
  durationMs: number;
  sourcesScanned?: number;
  sourcesChanged?: number;
}
export interface BackfillSkippedEvent { kind: "backfill.skipped"; unchangedSources: number; }
export interface SystemSuspendEvent { kind: "system.suspend"; }
export interface SystemResumeEvent { kind: "system.resume"; sleepSeconds: number; }
export interface SystemLockEvent { kind: "system.lock"; }
export interface SystemUnlockEvent { kind: "system.unlock"; }
export interface NetworkCheckFailedEvent { kind: "network.check.failed"; provider: string; code: string; }
export interface DnsLookupFailedEvent { kind: "dns.lookup.failed"; provider: string; code: string; }
export interface NetworkRecoveredEvent { kind: "network.recovered"; }
export interface CostWindowChangedEvent { kind: "cost.window.changed"; from: string; to: string; reason: string; }
```

- [ ] **Step 3: TypeScript prüfen**

Run: `npx tsc --noEmit`
Expected: keine Fehler.

- [ ] **Step 4: Commit**

```bash
git add src/main/debugEvents.ts
git commit -m "feat(events): add backfill/system/network/cost-window debug events"
```

---

## Task 2: Rate-Limit-Backoff-Helfer

**Files:**
- Create: `src/usage/backoff.ts`
- Test: `tests/backoff.test.ts`

- [ ] **Step 1: Failing test schreiben**

Erstelle `tests/backoff.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { computeBackoffMs, MIN_RETRY_MS, MAX_RETRY_MS } from "../src/usage/backoff";

describe("computeBackoffMs", () => {
  const noJitter = () => 0;

  it("server retry-after of 0 is raised to MIN_RETRY_MS", () => {
    expect(computeBackoffMs(0, 1, noJitter)).toBe(MIN_RETRY_MS);
  });

  it("uses the larger of server value and MIN_RETRY_MS", () => {
    expect(computeBackoffMs(8_000, 1, noJitter)).toBe(8_000);
    expect(computeBackoffMs(2_000, 1, noJitter)).toBe(MIN_RETRY_MS);
  });

  it("doubles per consecutive rate limit", () => {
    expect(computeBackoffMs(5_000, 1, noJitter)).toBe(5_000);
    expect(computeBackoffMs(5_000, 2, noJitter)).toBe(10_000);
    expect(computeBackoffMs(5_000, 3, noJitter)).toBe(20_000);
  });

  it("is capped at MAX_RETRY_MS", () => {
    expect(computeBackoffMs(5_000, 20, noJitter)).toBe(MAX_RETRY_MS);
  });

  it("adds jitter from the injected random source", () => {
    // random()=0.5 → +1500ms jitter (0.5 * 3000)
    expect(computeBackoffMs(5_000, 1, () => 0.5)).toBe(6_500);
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss scheitern**

Run: `npx vitest run tests/backoff.test.ts`
Expected: FAIL — Modul `../src/usage/backoff` nicht gefunden.

- [ ] **Step 3: Implementieren**

Erstelle `src/usage/backoff.ts`:

```typescript
export const MIN_RETRY_MS = 5_000;
export const MAX_RETRY_MS = 30 * 60_000;
export const JITTER_MAX_MS = 3_000;

/**
 * Computes an effective rate-limit backoff: never below MIN_RETRY_MS, doubled
 * per consecutive 429, capped at MAX_RETRY_MS, plus 0–JITTER_MAX_MS jitter.
 * @param serverRetryAfterMs - Retry-After from the server (may be 0 or bogus).
 * @param consecutive - 1 for the first 429 in a row, 2 for the second, etc.
 * @param random - Injectable RNG for deterministic tests; defaults to Math.random.
 */
export function computeBackoffMs(
  serverRetryAfterMs: number,
  consecutive: number,
  random: () => number = Math.random,
): number {
  const base = Math.max(serverRetryAfterMs, MIN_RETRY_MS);
  const exponent = Math.max(0, consecutive - 1);
  const scaled = Math.min(MAX_RETRY_MS, base * 2 ** exponent);
  return scaled + Math.floor(random() * JITTER_MAX_MS);
}
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `npx vitest run tests/backoff.test.ts`
Expected: PASS (5 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/usage/backoff.ts tests/backoff.test.ts
git commit -m "feat(backoff): add computeBackoffMs with min/jitter/exponential cap"
```

---

## Task 3: Fetch-Fehler-Klassifizierung

**Files:**
- Create: `src/usage/fetchErrorClassifier.ts`
- Test: `tests/fetchErrorClassifier.test.ts`

- [ ] **Step 1: Failing test schreiben**

Erstelle `tests/fetchErrorClassifier.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { classifyFetchError } from "../src/usage/fetchErrorClassifier";

function withCause(code: string): Error {
  const err = new Error("fetch failed");
  (err as Error & { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return err;
}

describe("classifyFetchError", () => {
  it("classifies DNS failures", () => {
    expect(classifyFetchError(withCause("ENOTFOUND"))).toEqual({ kind: "dns", code: "ENOTFOUND" });
    expect(classifyFetchError(withCause("EAI_AGAIN"))).toEqual({ kind: "dns", code: "EAI_AGAIN" });
  });

  it("classifies network failures", () => {
    expect(classifyFetchError(withCause("ECONNREFUSED"))).toEqual({ kind: "network", code: "ECONNREFUSED" });
    expect(classifyFetchError(withCause("ENETUNREACH"))).toEqual({ kind: "network", code: "ENETUNREACH" });
    expect(classifyFetchError(withCause("ECONNRESET"))).toEqual({ kind: "network", code: "ECONNRESET" });
    expect(classifyFetchError(withCause("ETIMEDOUT"))).toEqual({ kind: "network", code: "ETIMEDOUT" });
  });

  it("treats a timeout message as network", () => {
    expect(classifyFetchError(new Error("Claude timed out"))).toEqual({ kind: "network", code: "TIMEOUT" });
  });

  it("returns other for unrelated errors", () => {
    expect(classifyFetchError(new Error("HTTP 500"))).toEqual({ kind: "other", code: "" });
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss scheitern**

Run: `npx vitest run tests/fetchErrorClassifier.test.ts`
Expected: FAIL — Modul nicht gefunden.

- [ ] **Step 3: Implementieren**

Erstelle `src/usage/fetchErrorClassifier.ts`:

```typescript
export type FetchErrorKind = "dns" | "network" | "other";

export interface FetchErrorClass {
  kind: FetchErrorKind;
  code: string;
}

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const NETWORK_CODES = new Set(["ECONNREFUSED", "ENETUNREACH", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH"]);

/**
 * Classifies a fetch failure by its underlying cause code so polling gaps can be
 * attributed to DNS, general network problems, or something else.
 */
export function classifyFetchError(error: unknown): FetchErrorClass {
  const code = causeCode(error);
  if (code && DNS_CODES.has(code)) return { kind: "dns", code };
  if (code && NETWORK_CODES.has(code)) return { kind: "network", code };
  if (error instanceof Error && /timed out|timeout/i.test(error.message)) {
    return { kind: "network", code: "TIMEOUT" };
  }
  return { kind: "other", code: "" };
}

function causeCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  const ownCode = (error as Error & { code?: unknown }).code;
  return typeof ownCode === "string" ? ownCode : null;
}
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `npx vitest run tests/fetchErrorClassifier.test.ts`
Expected: PASS (4 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/usage/fetchErrorClassifier.ts tests/fetchErrorClassifier.test.ts
git commit -m "feat(network): add classifyFetchError for gap attribution"
```

---

## Task 4: RefreshLoop — Backoff, Netzwerk-Events, cost.window.changed

**Files:**
- Modify: `src/usage/refreshLoop.ts`
- Modify: `tests/refreshLoop.test.ts`

- [ ] **Step 1: Failing tests schreiben**

Hänge am Ende von `tests/refreshLoop.test.ts` einen neuen `describe`-Block an. Verwende die im File bereits vorhandenen Helfer `makeProvider`/`UsageStore` (am Dateianfang importiert). Falls `RateLimitError` noch nicht importiert ist, ist er es bereits laut Bestand (Zeile 5).

```typescript
describe("RefreshLoop robustness", () => {
  it("escalates backoff on consecutive rate limits and resets after success", async () => {
    vi.useFakeTimers();
    const store = new UsageStore();
    let call = 0;
    const provider = makeProvider("claude", async () => {
      call++;
      if (call <= 2) throw new RateLimitError(0); // server says 0 → must be raised
      return { provider: "claude", status: "ok" as const, windows: [], updatedAt: new Date().toISOString() };
    });
    const events: any[] = [];
    const recorder = { write: (e: any) => events.push(e) } as any;
    const loop = new RefreshLoop([provider], store, 60, 10_000, undefined, recorder);

    await loop.refreshNow(); // call 1 → 429, backoff ≥ 5s (server said 0)
    // immediate retry must be skipped (still within the raised backoff window)
    await loop.refreshNow();
    expect(events.some(e => e.kind === "refresh.skipped" && e.provider === "claude")).toBe(true);

    vi.useRealTimers();
  });

  it("emits dns.lookup.failed and network.recovered around a DNS outage", async () => {
    const store = new UsageStore();
    let call = 0;
    const provider = makeProvider("claude", async () => {
      call++;
      if (call === 1) {
        const err = new Error("fetch failed");
        (err as any).cause = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
        throw err;
      }
      return { provider: "claude", status: "ok" as const, windows: [], updatedAt: new Date().toISOString() };
    });
    const events: any[] = [];
    const recorder = { write: (e: any) => events.push(e) } as any;
    const loop = new RefreshLoop([provider], store, 60, 10_000, undefined, recorder);

    await loop.refreshNow();
    expect(events.some(e => e.kind === "dns.lookup.failed" && e.provider === "claude")).toBe(true);

    await loop.refreshNow();
    expect(events.some(e => e.kind === "network.recovered")).toBe(true);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen scheitern**

Run: `npx vitest run tests/refreshLoop.test.ts`
Expected: FAIL — `dns.lookup.failed`/`network.recovered` werden noch nicht emittiert.

- [ ] **Step 3: Imports und Felder ergänzen**

In `src/usage/refreshLoop.ts` nach den bestehenden Imports einfügen:

```typescript
import { computeBackoffMs } from "./backoff";
import { classifyFetchError } from "./fetchErrorClassifier";
```

In der `RefreshLoop`-Klasse nach `private readonly burnRateTracker = new BurnRateTracker();` ergänzen:

```typescript
private readonly consecutiveRateLimits = new Map<string, number>();
private offline = false;
private lastCostWindow: string | undefined;
```

- [ ] **Step 4: `fetchWithTimeout` umbauen**

Ersetze die komplette `fetchWithTimeout`-Methode (aktuell Zeilen 89–101) durch:

```typescript
  private async fetchWithTimeout(provider: UsageProvider): Promise<UsageSnapshot> {
    try {
      const snapshot = await withTimeout(provider.fetchUsage(), this.timeoutMs, `${provider.displayName} timed out`);
      this.consecutiveRateLimits.delete(provider.id);
      if (this.offline) {
        this.offline = false;
        this.recorder?.write({ kind: "network.recovered" });
        log.info("network recovered");
      }
      return snapshot;
    } catch (error) {
      if (error instanceof RateLimitError) {
        const consecutive = (this.consecutiveRateLimits.get(provider.id) ?? 0) + 1;
        this.consecutiveRateLimits.set(provider.id, consecutive);
        const backoffMs = computeBackoffMs(error.retryAfterMs, consecutive);
        this.backoff.set(provider.id, Date.now() + backoffMs);
        log.warn(`${provider.id} rate-limited (#${consecutive}), backing off for ${Math.round(backoffMs / 1000)}s`);
        return errorSnapshot(provider.id, toErrorMessage(error), "error");
      }
      const cls = classifyFetchError(error);
      if (cls.kind === "dns") {
        this.offline = true;
        this.recorder?.write({ kind: "dns.lookup.failed", provider: provider.id, code: cls.code });
      } else if (cls.kind === "network") {
        this.offline = true;
        this.recorder?.write({ kind: "network.check.failed", provider: provider.id, code: cls.code });
      }
      log.warn(`${provider.id} refresh failed: ${toErrorMessage(error)}`);
      return errorSnapshot(provider.id, toErrorMessage(error), "error");
    }
  }
```

Hinweis: `fetchUsage()` der echten Provider fängt Nicht-RateLimit-Fehler bereits intern ab und gibt einen `errorSnapshot` zurück (siehe `claude.ts`); die Netzwerk-Klassifizierung greift daher bei `fetchUsage`-Implementierungen, die werfen (z. B. Timeout über `withTimeout`, oder Provider, die durchwerfen). Das ist beabsichtigt — der Timeout-Pfad ist die häufigste werfende Quelle.

- [ ] **Step 5: cost.window.changed im Snapshot-Loop ergänzen**

In `refreshNow`, innerhalb der `for (const snapshot of snapshots)`-Schleife, direkt nach dem Block, der `snapshot.costFactor` setzt (nach `snapshot.costFactor = await this.pricingEngine.calculateFactor(snapshot);` und vor `this.recorder?.write(snapshotEvent(snapshot));`), einfügen:

```typescript
        const win = snapshot.costFactor?.windowLabel;
        if (win) {
          if (this.lastCostWindow !== undefined && this.lastCostWindow !== win) {
            this.recorder?.write({ kind: "cost.window.changed", from: this.lastCostWindow, to: win, reason: "settings" });
            log.info(`cost window changed from ${this.lastCostWindow} to ${win}`);
          }
          this.lastCostWindow = win;
        }
```

- [ ] **Step 6: Alle Tests laufen lassen**

Run: `npx vitest run tests/refreshLoop.test.ts`
Expected: PASS — auch die bestehenden Rate-Limit-Tests bleiben grün (Backoff ist nun ≥ 5s statt exakt retryAfterMs; bestehende Tests nutzen retryAfterMs ≥ 60s, daher unverändert).

- [ ] **Step 7: Gesamtsuite + tsc**

Run: `npx vitest run && npx tsc --noEmit`
Expected: alles grün.

- [ ] **Step 8: Commit**

```bash
git add src/usage/refreshLoop.ts tests/refreshLoop.test.ts
git commit -m "feat(refreshLoop): hardened rate-limit backoff, network events, cost-window change tracking"
```

---

## Task 5: Lifecycle-Events (powerMonitor)

**Files:**
- Create: `src/main/lifecycleEvents.ts`
- Modify: `src/main/main.ts`

Kein Unit-Test (Electron-`powerMonitor` ist nicht headless mockbar); Verifikation per `tsc` + manueller Test.

- [ ] **Step 1: `lifecycleEvents.ts` erstellen**

Erstelle `src/main/lifecycleEvents.ts`:

```typescript
import { powerMonitor } from "electron";
import type { DebugRecorder } from "./debugRecorder";
import { log } from "./logging";

export interface LifecycleDeps {
  recorder: DebugRecorder;
  onResume: () => void; // z. B. sofortiger Refresh nach dem Aufwachen
}

/**
 * Registers powerMonitor listeners so that sleep/wake and lock/unlock gaps in
 * polling become explainable in the debug log. On resume it also triggers an
 * immediate refresh via the injected callback.
 */
export function registerLifecycleEvents(deps: LifecycleDeps): void {
  let suspendedAt: number | null = null;

  powerMonitor.on("suspend", () => {
    suspendedAt = Date.now();
    deps.recorder.write({ kind: "system.suspend" });
    log.info("system suspend");
  });

  powerMonitor.on("resume", () => {
    const sleepSeconds = suspendedAt !== null ? Math.round((Date.now() - suspendedAt) / 1000) : 0;
    suspendedAt = null;
    deps.recorder.write({ kind: "system.resume", sleepSeconds });
    log.info(`system resume after ${sleepSeconds}s`);
    deps.onResume();
  });

  powerMonitor.on("lock-screen", () => {
    deps.recorder.write({ kind: "system.lock" });
  });

  powerMonitor.on("unlock-screen", () => {
    deps.recorder.write({ kind: "system.unlock" });
  });
}
```

- [ ] **Step 2: In `main.ts` registrieren**

In `src/main/main.ts` den Import nach den bestehenden `./`-Imports ergänzen:

```typescript
import { registerLifecycleEvents } from "./lifecycleEvents";
```

Direkt nach `refreshLoop.start();` (aktuell Zeile 91) einfügen:

```typescript
      registerLifecycleEvents({
        recorder,
        onResume: () => {
          void refreshLoop.refreshNow("interval").catch((err: unknown) => {
            log.warn(`Resume refresh failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        },
      });
```

- [ ] **Step 3: TypeScript prüfen**

Run: `npx tsc --noEmit`
Expected: keine Fehler.

- [ ] **Step 4: Commit**

```bash
git add src/main/lifecycleEvents.ts src/main/main.ts
git commit -m "feat(lifecycle): log suspend/resume/lock and refresh on resume"
```

---

## Task 6: Reader — FromFiles-Varianten (Claude)

**Files:**
- Modify: `src/pricing/jsonl-reader.ts`

- [ ] **Step 1: `listClaudeSourceFiles` + `readClaudeUsageEntriesFromFiles` hinzufügen**

In `src/pricing/jsonl-reader.ts` nach `readClaudeUsageEntriesForPeriod` (nach Zeile 68) einfügen:

```typescript
export interface SourceFileRef {
  file: string;     // absoluter Pfad zur .jsonl-Datei
  baseDir: string;  // projectsDir, aus dem die Datei stammt (für Projekt-Ableitung)
}

/** Lists every Claude usage .jsonl source file across the given project dirs. */
export async function listClaudeSourceFiles(projectsDir: string | string[]): Promise<SourceFileRef[]> {
  const dirs = Array.isArray(projectsDir) ? projectsDir : [projectsDir];
  const refs: SourceFileRef[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = (await fs.readdir(dir, { recursive: true })) as string[];
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.endsWith(".jsonl")) refs.push({ file: path.join(dir, e), baseDir: dir });
    }
  }
  return refs;
}

/**
 * Parses the given source files with messageId de-duplication. If billingStart is
 * passed, entries older than it are filtered out BEFORE de-dup — identical order to
 * the previous readClaudeEntriesFromDir, so behaviour is preserved.
 */
export async function readClaudeUsageEntriesFromFiles(refs: SourceFileRef[], billingStart?: Date): Promise<ClaudeUsageEntry[]> {
  const result: ClaudeUsageEntry[] = [];
  const seenMessageIds = new Set<string>();
  for (const ref of refs) {
    const parsed = await claudeFileCache.get(ref.file, () => processJsonlFile(ref.file, ref.baseDir));
    for (const entry of parsed) {
      if (billingStart && new Date(entry.timestamp) < billingStart) continue;
      if (entry.messageId) {
        if (seenMessageIds.has(entry.messageId)) continue;
        seenMessageIds.add(entry.messageId);
      }
      const { messageId: _messageId, ...publicEntry } = entry;
      result.push(publicEntry);
    }
  }
  return result;
}
```

- [ ] **Step 2: `readClaudeUsageEntriesForPeriod` auf die Bausteine refaktorieren**

Ersetze die bestehende `readClaudeUsageEntriesForPeriod` (Zeilen 57–68) und entferne die nun ungenutzte `readClaudeEntriesFromDir` (Zeilen 99–128) — beide werden durch Folgendes ersetzt:

```typescript
export async function readClaudeUsageEntriesForPeriod(
  projectsDir: string | string[],
  billingStart: Date,
): Promise<ClaudeUsageEntry[]> {
  const refs = await listClaudeSourceFiles(projectsDir);
  return readClaudeUsageEntriesFromFiles(refs, billingStart);
}
```

Hinweis: `billingStart` wird an `readClaudeUsageEntriesFromFiles` durchgereicht, das den Datumsfilter **vor** der messageId-Dedup anwendet — exakt die Reihenfolge des alten `readClaudeEntriesFromDir`. Verhalten unverändert.

- [ ] **Step 3: Bestehende Reader-Tests laufen lassen**

Run: `npx vitest run tests/jsonl-reader.test.ts`
Expected: PASS — Verhalten der `*ForPeriod`-Funktion unverändert.

- [ ] **Step 4: tsc**

Run: `npx tsc --noEmit`
Expected: keine Fehler (kein verwaister Code).

- [ ] **Step 5: Commit**

```bash
git add src/pricing/jsonl-reader.ts
git commit -m "refactor(jsonl-reader): extract listClaudeSourceFiles + readClaudeUsageEntriesFromFiles"
```

---

## Task 7: Reader — FromFiles-Varianten (Codex)

**Files:**
- Modify: `src/pricing/codex-log-reader.ts`

- [ ] **Step 1: `listCodexSourceFiles` + `readCodexTokensFromFiles` hinzufügen**

In `src/pricing/codex-log-reader.ts` nach `readCodexTokensForPeriod` (nach Zeile 40) einfügen:

```typescript
export interface CodexSourceFileRef {
  file: string;     // absoluter Pfad zur .jsonl-Datei
  baseDir: string;  // sessionsDir, aus dem die Datei stammt (für directory-Ableitung)
}

/** Lists every Codex session .jsonl source file across the given session dirs. */
export async function listCodexSourceFiles(sessionsDir: string | string[]): Promise<CodexSourceFileRef[]> {
  const dirs = Array.isArray(sessionsDir) ? sessionsDir : [sessionsDir];
  const refs: CodexSourceFileRef[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = (await fs.readdir(dir, { recursive: true })) as string[];
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.endsWith(".jsonl")) refs.push({ file: path.join(dir, e), baseDir: dir });
    }
  }
  return refs;
}

/** Parses the given Codex source files. If billingStart is passed, older events are filtered out (same as before). */
export async function readCodexTokensFromFiles(refs: CodexSourceFileRef[], billingStart?: Date): Promise<CodexTokenEvent[]> {
  const events: CodexTokenEvent[] = [];
  for (const ref of refs) {
    const parsed = await codexFileCache.get(ref.file, () => parseCodexJsonlFile(ref.file, ref.baseDir));
    events.push(...(billingStart ? parsed.filter((event) => new Date(event.timestamp) >= billingStart) : parsed));
  }
  return events;
}
```

- [ ] **Step 2: `readCodexTokensForPeriod` auf die Bausteine refaktorieren**

Ersetze die bestehende `readCodexTokensForPeriod` (Zeilen 30–40) und entferne die nun ungenutzte `readCodexTokensFromDir` (Zeilen 42–63) — beide werden durch Folgendes ersetzt:

```typescript
export async function readCodexTokensForPeriod(
  sessionsDir: string | string[],
  billingStart: Date,
): Promise<CodexTokenEvent[]> {
  const refs = await listCodexSourceFiles(sessionsDir);
  return readCodexTokensFromFiles(refs, billingStart);
}
```

- [ ] **Step 3: Bestehende Reader-Tests laufen lassen**

Run: `npx vitest run tests/codex-log-reader.test.ts`
Expected: PASS — Verhalten unverändert.

- [ ] **Step 4: tsc**

Run: `npx tsc --noEmit`
Expected: keine Fehler.

- [ ] **Step 5: Commit**

```bash
git add src/pricing/codex-log-reader.ts
git commit -m "refactor(codex-log-reader): extract listCodexSourceFiles + readCodexTokensFromFiles"
```

---

## Task 8: Backfill-Manifest

**Files:**
- Create: `src/main/backfillManifest.ts`
- Test: `tests/backfillManifest.test.ts`

- [ ] **Step 1: Failing tests schreiben**

Erstelle `tests/backfillManifest.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadManifest, saveManifest, fileSignature, diffSources } from "../src/main/backfillManifest";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qb-manifest-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("backfillManifest", () => {
  it("returns an empty manifest when none exists", async () => {
    const m = await loadManifest(tmp);
    expect(m.version).toBe(1);
    expect(m.sources).toEqual({});
  });

  it("returns an empty manifest when the file is corrupt", async () => {
    await fs.writeFile(path.join(tmp, "backfill-manifest.json"), "{ not json", "utf8");
    const m = await loadManifest(tmp);
    expect(m.sources).toEqual({});
  });

  it("round-trips a saved manifest", async () => {
    await saveManifest(tmp, { version: 1, sources: { "/a.jsonl": "10:123" }, lastRunAt: "2026-06-09T00:00:00.000Z" });
    const m = await loadManifest(tmp);
    expect(m.sources["/a.jsonl"]).toBe("10:123");
  });

  it("computes a size:mtime signature for an existing file", async () => {
    const f = path.join(tmp, "x.jsonl");
    await fs.writeFile(f, "hello", "utf8");
    const sig = await fileSignature(f);
    expect(sig).toMatch(/^\d+:\d+$/);
  });

  it("returns null signature for a missing file", async () => {
    expect(await fileSignature(path.join(tmp, "nope.jsonl"))).toBeNull();
  });

  it("diffSources reports changed and unchanged files", async () => {
    const prev = { "/a.jsonl": "1:100", "/b.jsonl": "2:200" };
    const current = { "/a.jsonl": "1:100", "/b.jsonl": "9:999", "/c.jsonl": "3:300" };
    const { changed, unchanged } = diffSources(prev, current);
    expect(changed.sort()).toEqual(["/b.jsonl", "/c.jsonl"]);
    expect(unchanged).toEqual(["/a.jsonl"]);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen scheitern**

Run: `npx vitest run tests/backfillManifest.test.ts`
Expected: FAIL — Modul nicht gefunden.

- [ ] **Step 3: Implementieren**

Erstelle `src/main/backfillManifest.ts`:

```typescript
import fs from "node:fs/promises";
import path from "node:path";

export interface BackfillManifest {
  version: 1;
  sources: Record<string, string>; // absoluter Pfad → "size:mtimeMs"
  lastRunAt: string;
}

const MANIFEST_FILE = "backfill-manifest.json";

export function emptyManifest(): BackfillManifest {
  return { version: 1, sources: {}, lastRunAt: new Date(0).toISOString() };
}

export async function loadManifest(logDir: string): Promise<BackfillManifest> {
  try {
    const raw = await fs.readFile(path.join(logDir, MANIFEST_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<BackfillManifest>;
    if (parsed && parsed.version === 1 && parsed.sources && typeof parsed.sources === "object") {
      return { version: 1, sources: parsed.sources as Record<string, string>, lastRunAt: parsed.lastRunAt ?? new Date(0).toISOString() };
    }
  } catch {
    // missing or corrupt → empty
  }
  return emptyManifest();
}

export async function saveManifest(logDir: string, manifest: BackfillManifest): Promise<void> {
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(path.join(logDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** "size:mtimeMs" for an existing file, or null if it cannot be stat'd. */
export async function fileSignature(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** Partitions current source signatures into changed/new vs. unchanged vs. previous. */
export function diffSources(
  previous: Record<string, string>,
  current: Record<string, string>,
): { changed: string[]; unchanged: string[] } {
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const [file, sig] of Object.entries(current)) {
    if (previous[file] === sig) unchanged.push(file);
    else changed.push(file);
  }
  return { changed, unchanged };
}
```

- [ ] **Step 4: Tests laufen lassen — müssen bestehen**

Run: `npx vitest run tests/backfillManifest.test.ts`
Expected: PASS (6 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/backfillManifest.ts tests/backfillManifest.test.ts
git commit -m "feat(backfill): persistent source-file signature manifest"
```

---

## Task 9: Backfill nutzt Manifest + FromFiles-Reader

**Files:**
- Modify: `src/main/debugBackfill.ts`

- [ ] **Step 1: Imports anpassen**

In `src/main/debugBackfill.ts` die Reader-Imports ersetzen. Aktuell:

```typescript
import { readClaudeUsageEntriesForPeriod, type ClaudeUsageEntry } from "../pricing/jsonl-reader";
import { readCodexTokensForPeriod, type CodexTokenEvent } from "../pricing/codex-log-reader";
```

ersetzen durch:

```typescript
import { listClaudeSourceFiles, readClaudeUsageEntriesFromFiles, type ClaudeUsageEntry, type SourceFileRef } from "../pricing/jsonl-reader";
import { listCodexSourceFiles, readCodexTokensFromFiles, type CodexTokenEvent, type CodexSourceFileRef } from "../pricing/codex-log-reader";
import { loadManifest, saveManifest, fileSignature, diffSources, type BackfillManifest } from "./backfillManifest";
```

- [ ] **Step 2: `runBackfill` umbauen**

Ersetze in `runBackfill` den Block von `const epoch = new Date(0);` bis einschließlich der beiden `.catch(...)`-Reader-Aufrufe (aktuell Zeilen 31–46) durch:

```typescript
  const errors: string[] = [];

  const claudeRefs = await listClaudeSourceFiles(opts.claudeProjectsDirs).catch(() => [] as SourceFileRef[]);
  const codexRefs = await listCodexSourceFiles(opts.codexSessionsDirs).catch(() => [] as CodexSourceFileRef[]);

  // Aktuelle Signaturen aller Quelldateien berechnen.
  const currentSources: Record<string, string> = {};
  for (const ref of [...claudeRefs, ...codexRefs]) {
    const sig = await fileSignature(ref.file);
    if (sig !== null) currentSources[ref.file] = sig;
  }

  const manifest: BackfillManifest = opts.force ? { version: 1, sources: {}, lastRunAt: new Date(0).toISOString() } : await loadManifest(opts.logDir);
  const { changed, unchanged } = diffSources(manifest.sources, currentSources);

  if (!opts.force && changed.length === 0) {
    opts.recorder.write({ kind: "backfill.skipped", unchangedSources: unchanged.length });
    await saveManifest(opts.logDir, { version: 1, sources: currentSources, lastRunAt: new Date().toISOString() });
    const durationMs = Date.now() - startedAt;
    opts.recorder.write({ kind: "backfill.done", daysWritten: 0, daysSkipped: 0, durationMs, sourcesScanned: Object.keys(currentSources).length, sourcesChanged: 0 });
    return { daysWritten: 0, daysSkipped: 0, durationMs, errors };
  }

  // Nur geänderte/neue Dateien parsen (bzw. bei force: alle).
  const changedSet = new Set(opts.force ? Object.keys(currentSources) : changed);
  const claudeToRead = claudeRefs.filter((r) => changedSet.has(r.file));
  const codexToRead = codexRefs.filter((r) => changedSet.has(r.file));

  const claudeEntries = await readClaudeUsageEntriesFromFiles(claudeToRead).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Backfill: Claude reader failed: ${msg}`);
    errors.push(`claude: ${msg}`);
    return [] as ClaudeUsageEntry[];
  });
  const codexEvents = await readCodexTokensFromFiles(codexToRead).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Backfill: Codex reader failed: ${msg}`);
    errors.push(`codex: ${msg}`);
    return [] as CodexTokenEvent[];
  });
```

Hinweis: Die Variable `epoch` entfällt; falls sie sonst nirgends verwendet wird, ist die obige Ersetzung vollständig. Der nachfolgende Bestandscode (`byDay`-Aggregation, `sortedDays`, Schreib-Schleife) bleibt unverändert — `sortedDays` enthält jetzt nur noch die von geänderten Dateien betroffenen Tage.

- [ ] **Step 3: Schreib-Schleife: Skip-Logik an Manifest-Modus anpassen**

In der `for (const day of sortedDays)`-Schleife wird aktuell bei `!opts.force && exists(filePath)` übersprungen. Da wir nun nur betroffene Tage in `sortedDays` haben und diese bewusst neu schreiben wollen, ersetze den Schleifenkopf-Block:

```typescript
  for (const day of sortedDays) {
    const filePath = path.join(opts.logDir, `${day}.backfill.jsonl`);
    if (!opts.force && (await exists(filePath))) {
      skipped++;
      continue;
    }
    if (opts.force) {
      await fs.rm(filePath, { force: true });
    }
```

durch:

```typescript
  for (const day of sortedDays) {
    const filePath = path.join(opts.logDir, `${day}.backfill.jsonl`);
    // Betroffener Tag wird immer neu geschrieben (Quelldatei hat sich geändert).
    await fs.rm(filePath, { force: true });
```

- [ ] **Step 4: Manifest am Ende speichern + erweitertes done-Event**

Ersetze den Abschlussblock (aktuell):

```typescript
  const durationMs = Date.now() - startedAt;
  opts.recorder.write({ kind: "backfill.done", daysWritten: written, daysSkipped: skipped, durationMs });
  return { daysWritten: written, daysSkipped: skipped, durationMs, errors };
```

durch:

```typescript
  await saveManifest(opts.logDir, { version: 1, sources: currentSources, lastRunAt: new Date().toISOString() });
  const durationMs = Date.now() - startedAt;
  opts.recorder.write({
    kind: "backfill.done",
    daysWritten: written,
    daysSkipped: skipped,
    durationMs,
    sourcesScanned: Object.keys(currentSources).length,
    sourcesChanged: changedSet.size,
  });
  return { daysWritten: written, daysSkipped: skipped, durationMs, errors };
```

- [ ] **Step 5: tsc + Gesamtsuite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: keine Fehler. Falls `tests/debugBackfill.test.ts` existiert und auf das alte „skip if file exists"-Verhalten testet, in Step 6 anpassen.

- [ ] **Step 6: Den `is idempotent`-Test anpassen**

Run: `npx vitest run tests/debugBackfill.test.ts`
Erwartet: Der Test `"is idempotent — skips days whose .backfill.jsonl already exists"` (Zeilen 68–86) scheitert, weil es keine Per-Tag-Skips mehr gibt (`second.daysSkipped` ist nun 0 statt > 0). Die übrigen Tests bleiben grün (frische tmpDirs → kein Manifest → voller Lauf; `force=true` ignoriert das Manifest).

Ersetze diesen einen Test durch die Manifest-Semantik:

```typescript
  it("skips the whole run when no source file changed since last run", async () => {
    await writeClaudeJsonl(path.join(claudeDir, "proj", "session.jsonl"), [
      { type: "assistant", timestamp: "2026-05-20T14:00:00Z",
        message: { id: "m1", model: "claude-sonnet-4-6",
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ]);
    const logDir = path.join(tmpDir, "debug");
    const recorder = new DebugRecorder({ enabled: true, logDir });
    const opts = { recorder, logDir, claudeProjectsDirs: [claudeDir], codexSessionsDirs: [codexDir] };

    const first = await runBackfill(opts);
    await recorder.flush();
    const second = await runBackfill(opts);
    await recorder.flush();

    expect(first.daysWritten).toBeGreaterThan(0);
    // Zweiter Lauf: Quelldatei unverändert → kompletter Skip via Manifest.
    expect(second.daysWritten).toBe(0);
    // Manifest wurde geschrieben.
    const files = await fs.readdir(logDir);
    expect(files).toContain("backfill-manifest.json");
  });
```

Run erneut: `npx vitest run tests/debugBackfill.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/debugBackfill.ts tests/debugBackfill.test.ts
git commit -m "feat(backfill): only reparse changed source files via manifest"
```

---

## Task 10: Kostenfenster — calculationMode im Backend

**Files:**
- Modify: `src/providers/types.ts`
- Modify: `src/pricing/subscription-factor.ts`

- [ ] **Step 1: `calculationMode` zum Typ hinzufügen**

In `src/providers/types.ts` die `CostFactorResult`-Schnittstelle erweitern (nach `windowDays?: number;`):

```typescript
export interface CostFactorResult {
  apiCostUSD: number;
  subscriptionCostUSD: number;
  factor: number | null;
  isEstimate: boolean;
  label: string;
  windowLabel?: string;
  windowDays?: number;
  calculationMode?: "fixed" | "actual-span";
  tokenUsage?: TokenUsageDetail;
}
```

- [ ] **Step 2: `calculationMode` in `resolveBillingStart` ableiten**

In `src/pricing/subscription-factor.ts` die `resolveBillingStart`-Funktion so ändern, dass sie den Modus mitliefert. Ersetze die Funktion (Zeilen 152–165) durch:

```typescript
function resolveBillingStart(
  costWindow: CostWindow,
  _snapshot: UsageSnapshot,
  _provider: "claude" | "codex",
): { billingStart: Date; windowLabel: string; windowDays: number; calculationMode: "fixed" | "actual-span" } {
  if (costWindow === "7d") {
    return { billingStart: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), windowLabel: "7d", windowDays: 7, calculationMode: "fixed" };
  }
  if (costWindow === "30d") {
    return { billingStart: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), windowLabel: "30d", windowDays: 30, calculationMode: "fixed" };
  }
  // "all" — epoch start; windowDays will be computed after data is fetched
  return { billingStart: new Date(0), windowLabel: "all", windowDays: 0, calculationMode: "actual-span" };
}
```

- [ ] **Step 3: `calculationMode` in beide Factor-Ergebnisse aufnehmen**

In `calculateClaudeFactor`: `resolveBillingStart`-Destrukturierung erweitern und das Ergebnis ergänzen. Ändere Zeile 36:

```typescript
    const { billingStart, windowLabel, windowDays } = resolveBillingStart(this.settings.costWindow, snapshot, "claude");
```

zu:

```typescript
    const { billingStart, windowLabel, windowDays, calculationMode } = resolveBillingStart(this.settings.costWindow, snapshot, "claude");
```

und im `return`-Objekt (nach `windowDays: effectiveDays,`) ergänzen:

```typescript
      calculationMode,
```

In `calculateCodexFactor` analog: Ändere Zeile 99 entsprechend (`windowDays, calculationMode`) und ergänze in **beiden** `return`-Objekten (dem „Keine Logs"-Fall und dem Hauptfall) jeweils `calculationMode,`. Beim „Keine Logs"-Fall steht es nach `windowDays,`; im Hauptfall nach `windowDays: effectiveDays,`.

- [ ] **Step 4: tsc + bestehende Pricing-Tests**

Run: `npx tsc --noEmit && npx vitest run tests/cost-calculator.test.ts`
Expected: keine Fehler.

- [ ] **Step 5: Commit**

```bash
git add src/providers/types.ts src/pricing/subscription-factor.ts
git commit -m "feat(pricing): expose cost-window calculationMode"
```

---

## Task 11: Kostenfenster-Badge im Dashboard

**Files:**
- Modify: `src/renderer/tabs/live.js`
- Modify: `src/renderer/index.html`

Kein Unit-Test (DOM-/Vanilla-JS); manuelle Verifikation am Ende.

- [ ] **Step 1: `costBadgeHtml` um ein dediziertes Window-Badge erweitern**

In `src/renderer/tabs/live.js` die Funktion `costBadgeHtml` (Zeilen 158–174) ersetzen durch:

```javascript
function windowBadgeHtml(cf) {
  if (!cf || !cf.windowLabel) return '';
  const days = cf.windowDays ?? '?';
  const mode = cf.calculationMode === 'actual-span' ? 'tatsächlicher Zeitraum' : 'festes Fenster';
  const text = cf.calculationMode === 'actual-span' ? `${days}d (all)` : cf.windowLabel;
  const tip = `Kostenfenster: ${cf.windowLabel}\nTage: ${days}\nModus: ${mode}`;
  return `<span class="badge b-window" data-tip="${QB.esc(tip)}">${QB.esc(text)}</span>`;
}

function costBadgeHtml(cf) {
  if (!cf) return '';
  const roiTip = cf.factor !== null
    ? `API-Kosten ÷ anteiliger Abo-Preis\nfür ${cf.windowLabel || 'dieses Fenster'} (${cf.windowDays ?? '?'}d).\n1× = Abo-äquivalent.`
    : '';
  const infoIcon = roiTip
    ? `<i class="info-icon" data-tip="${roiTip}" style="display:inline-flex;margin-left:3px">i</i>`
    : '';
  if (cf.factor === null) return `<span class="badge b-cost">${QB.esc(cf.label || 'Keine Logs')}</span>`;
  const pre = cf.isEstimate ? '~' : '';
  const factorPart = `${pre}${cf.factor.toFixed(2)}× sub`;
  if (cf.apiCostUSD >= 0.005) {
    return `<span class="badge b-cost" style="display:inline-flex;align-items:center">$${cf.apiCostUSD.toFixed(2)} (${factorPart})${infoIcon}</span>`;
  }
  return `<span class="badge b-cost" style="display:inline-flex;align-items:center">${factorPart}${infoIcon}</span>`;
}
```

(Das Fenster wandert aus dem `· winSuffix`-Anhängsel in ein eigenes, immer sichtbares Badge.)

- [ ] **Step 2: Window-Badge in beide Karten einreihen**

In `renderStandard`: nach `if (costHtml) bdgs.push(costHtml);` (Zeile 292) ergänzen:

```javascript
  const winHtml = windowBadgeHtml(snap.costFactor);
  if (winHtml) bdgs.push(winHtml);
```

In `renderGemini`: nach `if (costHtml) bdgs.push(costHtml);` (Zeile 321) dieselben zwei Zeilen ergänzen.

- [ ] **Step 3: CSS für `b-window` hinzufügen**

In `src/renderer/index.html` die Regel direkt nach der bestehenden `.b-cost`-Regel einfügen. Suche nach `.b-cost` im `<style>`-Block und ergänze danach:

```css
    .b-window {
      background: rgba(120,140,170,0.10);
      color: var(--t300);
      border: 1px solid rgba(120,140,170,0.22);
      font-variant-numeric: tabular-nums;
    }
```

(Falls `--t300` nicht existiert, nutze `--t400` analog zu `.burn-rate`.)

- [ ] **Step 4: tsc (Renderer wird nicht typgeprüft, aber Build prüfen)**

Run: `npm run build`
Expected: Build erfolgreich.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/tabs/live.js src/renderer/index.html
git commit -m "feat(live): show cost-window as a dedicated badge with tooltip"
```

---

## Task 12: Manuelle Verifikation & Abschluss

- [ ] **Step 1: Gesamtsuite + tsc**

Run: `npx vitest run && npx tsc --noEmit`
Expected: alle Tests grün, keine Typfehler.

- [ ] **Step 2: App starten**

Run: `npm run dev`
Tray-Icon öffnen.

- [ ] **Step 3: Kostenfenster-Badge prüfen**

Jede Provider-Karte zeigt ein Fenster-Badge (`30d` bzw. `Nd (all)`). Hover → Tooltip mit Fenster/Tage/Modus.

- [ ] **Step 4: Backfill-Manifest prüfen**

Im Debug-Log-Verzeichnis liegt nach dem ersten Lauf `backfill-manifest.json`. Bei App-Neustart ohne neue Sessions erscheint `backfill.skipped` im Tageslog; nach neuer Session-Aktivität erscheint `backfill.done` mit `sourcesChanged > 0`.

- [ ] **Step 5: Lifecycle-Events prüfen (optional, falls möglich)**

Rechner kurz in den Standby versetzen und aufwecken → `system.suspend` + `system.resume` mit `sleepSeconds` im Log; direkt danach ein Refresh.

- [ ] **Step 6: Branch abschließen**

Verwende `superpowers:finishing-a-development-branch`, um Merge/PR-Optionen zu wählen.

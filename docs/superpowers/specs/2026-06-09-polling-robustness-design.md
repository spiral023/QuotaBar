# Polling-Robustheit & Nachvollziehbarkeit — Design

**Datum:** 2026-06-09
**Status:** Approved (design)

## Ziel

Vier weitgehend unabhängige Verbesserungen am Hintergrund-Polling, die sich
Logging-/Event-Infrastruktur teilen:

1. **Backfill-Manifest** — vermeidet vollständiges Re-Parsing aller Quelldateien bei jedem Lauf.
2. **Rate-Limit-Backoff** — kein sofortiger Retry bei `Retry-After: 0`; Mindestwartezeit, Jitter, exponentieller Backoff.
3. **Gap-Erkennung** — System-Schlaf/Wake (Electron `powerMonitor`) und Netzwerk-/DNS-Fehler werden als Events geloggt, damit Polling-Lücken erklärbar werden.
4. **Kostenfenster sichtbar machen** — `windowLabel`/`windowDays`/`calculationMode` als Badge + Tooltip im Dashboard, plus `cost.window.changed`-Event.

Alle vier Teile werden in einem Spec und einem Implementierungsplan abgehandelt, sequentiell umgesetzt.

## Tech-Stack

TypeScript (Backend/Electron-Main), Vitest für Unit-Tests, Vanilla-JS + Inline-CSS im Renderer
([live.js](../../../src/renderer/tabs/live.js), [index.html](../../../src/renderer/index.html)).

---

## Teil 1 — Backfill-Manifest (Performance)

### Problem

[`runBackfill`](../../../src/main/debugBackfill.ts) ruft
`readClaudeUsageEntriesForPeriod(dirs, epoch)` und `readCodexTokensForPeriod(dirs, epoch)` auf —
liest und **parst alle Quelldateien seit Anbeginn bei jedem Lauf**. Das Überspringen passiert erst
danach auf Tagesdatei-Ebene (`if (!force && exists(filePath)) skip`). Die teure Arbeit (vollständiges
Lesen + JSON-Parsing aller Session-JSONLs) fällt also jedes Mal an, auch wenn sich nichts geändert hat.

Es gibt bereits einen in-memory [`FileParseCache`](../../../src/pricing/file-parse-cache.ts) mit
Signatur `size:mtimeMs:ctimeMs`, aber er ist nicht persistent über Neustarts und greift beim ersten
Backfill nach App-Start nicht.

### Architektur

Neues Modul `src/main/backfillManifest.ts`:

```ts
interface BackfillManifest {
  version: 1;
  sources: Record<string, string>; // absoluter Pfad → "size:mtimeMs"
  lastRunAt: string;               // ISO
}

export async function loadManifest(logDir: string): Promise<BackfillManifest>;
export async function saveManifest(logDir: string, manifest: BackfillManifest): Promise<void>;
export async function fileSignature(filePath: string): Promise<string | null>; // "size:mtimeMs" oder null
```

- Manifest-Datei: `<logDir>/backfill-manifest.json`.
- Signatur identisch zu `FileParseCache` minus `ctimeMs` (size + mtimeMs reichen für Quelldateien;
  ctime ist auf manchen Dateisystemen unzuverlässig). Bewusst eigenständig gehalten, damit das
  persistente Backfill-Manifest und der in-memory Parse-Cache unabhängig bleiben.

### Datenfluss in `runBackfill`

1. Enumeriere alle Quelldateien (Claude-Projekt-JSONLs, Codex-Session-JSONLs) über die `*Dirs`.
2. Berechne pro Datei die aktuelle Signatur und vergleiche mit `manifest.sources`.
3. **Geänderte/neue Dateien** werden geparst; daraus werden die betroffenen UTC-Tage (`utcDayKey`)
   ermittelt. Nur diese Tagesdateien werden neu geschrieben (bestehende erst gelöscht, dann neu).
4. Sind keine Dateien geändert → kompletter Skip (`backfill.skipped`).
5. Manifest wird mit den aktuellen Signaturen + `lastRunAt` überschrieben.
6. `force: true` (manuelles „Regenerieren") ignoriert das Manifest komplett, schreibt alle Tage neu
   und aktualisiert anschließend das Manifest.

### Reader-Anpassung

Damit der Backfill die Datei→Tag-Zuordnung steuern kann, bekommen die Reader eine Variante, die eine
**explizite Dateiliste** annimmt, statt intern alle Dateien zu enumerieren:

- `readClaudeUsageEntriesFromFiles(files: string[]): Promise<ClaudeUsageEntry[]>`
- `readCodexTokensFromFiles(files: string[]): Promise<CodexTokenEvent[]>`

Die bestehenden `*ForPeriod`-Funktionen werden auf diese Bausteine refaktoriert (enumerate → filter
by period → read from files), sodass kein Verhalten an anderen Aufrufstellen (PricingEngine,
reportService) sich ändert. Eine Helfer-Funktion `listSourceFiles(dirs)` liefert die Dateiliste, die
sowohl `*ForPeriod` als auch der Backfill nutzen.

### Events

- `backfill.skipped` — `{ kind, unchangedSources: number }` (alle Quellen unverändert).
- `backfill.done` erweitert um `sourcesScanned`, `sourcesChanged`.

### Edge Cases

- **Heutiger, noch wachsender Tag:** Die zugehörige Session-Datei ändert sich (size/mtime), wird also
  automatisch als „geändert" erkannt und der Tag neu geschrieben. Kein Sonderfall nötig.
- **Gelöschte Quelldatei:** Verschwindet aus der Enumeration; ihr Manifest-Eintrag wird beim
  Überschreiben entfernt. Bereits geschriebene Tagesdateien bleiben (kein Rückbau alter Summen — das
  entspricht dem bisherigen append-only-Verhalten).
- **Manifest fehlt/korrupt:** `loadManifest` liefert ein leeres Manifest → alle Dateien gelten als neu
  → voller Backfill (wie bisher). Niemals Crash.

---

## Teil 2 — Rate-Limit-Backoff

### Problem

[`refreshLoop.ts`](../../../src/usage/refreshLoop.ts) setzt den Backoff exakt auf `retryAfterMs`.
Der Wert stammt aus dem `Retry-After`-Header ([claude.ts](../../../src/providers/claude.ts)); bei
`Retry-After: 0` oder fehlerhaftem Header → `retryAfterMs = 0` → sofortiger Retry beim nächsten Tick.

### Architektur

Reiner Helper (testbar, ohne Seiteneffekte), z. B. in `src/usage/backoff.ts`:

```ts
const MIN_RETRY_MS = 5_000;
const JITTER_MAX_MS = 3_000;
const MAX_RETRY_MS = 30 * 60_000; // Cap

export function computeBackoffMs(
  serverRetryAfterMs: number,
  consecutive: number,         // 1 = erster 429 in Folge
  random: () => number = Math.random,
): number;
// = min(MAX_RETRY_MS, max(serverRetryAfterMs, MIN_RETRY_MS) * 2^(consecutive-1)) + random()*JITTER_MAX_MS
```

In `RefreshLoop`:
- Neue Map `consecutiveRateLimits: Map<providerId, number>`.
- Bei `RateLimitError`: `consecutive++`, Backoff über `computeBackoffMs` berechnen, in `backoff` setzen.
- Bei erfolgreichem Fetch (kein Error): `consecutiveRateLimits.delete(providerId)`.
- Log + `RefreshSkippedEvent` zeigen die effektiv berechneten Sekunden.

### Tests

- `computeBackoffMs`: server=0 → ≥ 5s; exponentiell bei `consecutive` 1/2/3; Cap greift; Jitter über
  injizierten `random` deterministisch.
- RefreshLoop: aufeinanderfolgende 429er erhöhen den Backoff; erfolgreicher Fetch setzt zurück
  (mit `vi.useFakeTimers`, analog zu bestehenden Tests in `tests/refreshLoop.test.ts`).

---

## Teil 3 — Gap-Erkennung (powerMonitor + Netzwerk)

### System-Schlaf/Wake

Neues Modul `src/main/lifecycleEvents.ts`, registriert in [main.ts](../../../src/main/main.ts) nach
`app.whenReady`. Nutzt Electrons `powerMonitor`:

- `suspend` → merkt sich Zeitstempel, Event `system.suspend`.
- `resume` → berechnet `sleepSeconds` (seit letztem `suspend`), Event `system.resume` mit
  `sleepSeconds`, und löst einmalig `refreshLoop.refreshNow("interval")` aus, damit Daten nach dem
  Aufwachen frisch sind.
- `lock-screen` / `unlock-screen` → Events `system.lock` / `system.unlock` (rein informativ).

Das Modul bekommt `recorder` und einen Refresh-Callback injiziert (keine direkte Abhängigkeit auf
`RefreshLoop`), bleibt damit testbar/isoliert.

### Netzwerk/DNS

In `fetchWithTimeout` (RefreshLoop) wird bei Nicht-`RateLimitError`-Fehlern die Ursache klassifiziert
über `error.cause.code`:

- `ENOTFOUND`, `EAI_AGAIN` → `dns.lookup.failed`
- `ECONNREFUSED`, `ENETUNREACH`, `ECONNRESET`, `ETIMEDOUT`, Timeout-Message → `network.check.failed`

Ein providerübergreifendes Offline-Flag im RefreshLoop merkt sich, ob zuletzt ein Netzwerk-/DNS-Fehler
auftrat. Sobald **irgendein** Fetch wieder gelingt und das Flag gesetzt war → einmalig
`network.recovered`, Flag zurücksetzen.

Klassifizierung als reiner Helper `classifyFetchError(error): "dns" | "network" | "other"` (testbar).

### Events

`system.suspend`, `system.resume` (`sleepSeconds`), `system.lock`, `system.unlock`,
`network.check.failed` (`provider`, `code`), `dns.lookup.failed` (`provider`, `code`),
`network.recovered`.

### Kein separater Heartbeat

Bewusste Entscheidung: Die Ursachen-Events (suspend/resume + Netzwerk) erklären die Gaps direkt. Ein
zusätzlicher periodischer Heartbeat-Gap-Detektor wird nicht implementiert.

---

## Teil 4 — Kostenfenster sichtbar machen

### Backend

`CostFactorResult` liefert bereits `windowLabel` + `windowDays`. Neu:

- `calculationMode: "fixed" | "actual-span"` in `CostFactorResult` und im
  `resolveBillingStart`-Pfad von [subscription-factor.ts](../../../src/pricing/subscription-factor.ts)
  gesetzt: `fixed` bei `7d`/`30d`, `actual-span` bei `all` (wo `windowDays` aus dem Datenzeitraum
  berechnet wird, z. B. 257d).

### Event `cost.window.changed`

- Geloggt, wenn sich `settings.costWindow` ändert. Erkennung: RefreshLoop merkt sich den zuletzt
  beobachteten `costWindow`; weicht der aktuelle ab → `cost.window.changed` mit `from`, `to`,
  `reason: "settings"`. (Die App lädt Settings beim Start; spätere Änderungen kommen über das
  Settings-Menü.)

### Dashboard

In [live.js](../../../src/renderer/tabs/live.js) bekommt die Kostenanzeige ein **Badge** mit dem
Fenster-Label (`30d`, `7d`, oder `257d (all)` bei `actual-span`). Tooltip zeigt `windowLabel`,
`windowDays` und `calculationMode` in Klartext. CSS analog zu bestehenden Badges in
[index.html](../../../src/renderer/index.html).

---

## Querschnitt: Event-Typen

Alle neuen Events kommen als typisierte Interfaces in die `DebugEvent`-Union in
[debugEvents.ts](../../../src/main/debugEvents.ts):

`BackfillSkippedEvent`, (erweitert) `BackfillDoneEvent`, `SystemSuspendEvent`, `SystemResumeEvent`,
`SystemLockEvent`, `SystemUnlockEvent`, `NetworkCheckFailedEvent`, `DnsLookupFailedEvent`,
`NetworkRecoveredEvent`, `CostWindowChangedEvent`.

## Testing

| Bereich | Test |
|---|---|
| Backfill-Manifest | `backfillManifest.test.ts`: Signatur-Vergleich, leeres/korruptes Manifest, geänderte vs. unveränderte Dateien, force-Pfad |
| Reader-Refactor | Bestehende Reader-Tests müssen grün bleiben (Verhalten der `*ForPeriod`-Funktionen unverändert); neuer Test für `*FromFiles` |
| Rate-Limit | `backoff.test.ts`: min/jitter/exponentiell/Cap; RefreshLoop-Tests für consecutive-Reset |
| Netzwerk | `classifyFetchError`-Unit-Test |
| powerMonitor / UI-Badge | Manuelle Verifikation (Electron-abhängig, kein DOM-/IPC-Test) |

## Out of Scope

- Kein Heartbeat-Gap-Detektor (siehe Teil 3).
- Kein Rückbau bereits geschriebener Backfill-Summen bei gelöschten Quelldateien.
- Keine Migration bestehender Backfill-Dateien — das Manifest wird beim ersten Lauf neu aufgebaut.

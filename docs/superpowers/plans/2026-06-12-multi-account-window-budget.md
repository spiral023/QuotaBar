# Multi-Konto-Fenster-Budget — Implementation Plan (Addendum)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Fenster-Budget-Lerner funktioniert korrekt bei mehreren Claude-Konten (Lernen pro Tier statt Reset), der Graph zeigt nur das aktive Konto, und die Claude-Karte zeigt an, welches Konto gerade verwendet wird.

**Architecture:** State-Map-Key wird `provider:planType` (Tier = Limit-Eigenschaft). Neues Feld `lastTs` + 10-min-Max-Alter ersetzt den groben Reset als Lücken-Schutz. Dateiversion 2 erzwingt automatischen Re-Seed. `readWeeklySeries` filtert optional nach `planType`. Ein gecachter Profil-Abruf (`/api/oauth/profile`) befüllt `identity.email` für die Anzeige.

**Tech Stack:** wie Basis-Plan (`2026-06-11-window-budget.md`). Spec: `docs/superpowers/specs/2026-06-12-multi-account-window-budget-design.md`.

**Basis:** Branch `feat/window-budget`, alle 10 Tasks des Basis-Plans sind umgesetzt. Implementierer lesen die bestehenden Module als Referenz.

---

### Task A1: windowRatio v2 — Tier-Key + Max-Alter

**Files:**
- Modify: `src/usage/windowRatio.ts`
- Modify: `tests/windowRatio.test.ts`

**Änderungen am Modul:**

1. Neue Konstante + Helper:
```ts
/** Paare über größere Lücken (Konto-Wechsel, App-Pausen, Log-Lücken) sind wertlos. */
export const MAX_PAIR_AGE_MS = 10 * 60 * 1000;

/** State-Map-Key: das Fenster-Verhältnis ist eine Eigenschaft des Tiers (planType). */
export function ratioKey(provider: string, planType: string | null | undefined): string {
  return `${provider}:${planType ?? "default"}`;
}
```
2. `WindowRatioFile.version` wird `2` (Typ-Literal und `emptyRatioFile()`).
3. `ProviderRatioState` erhält `lastTs: string | null` (in `emptyProviderState()` mit `null`).
4. `RatioObservation` erhält Pflichtfeld `ts: string`.
5. In `recordObservation`: Paar zusätzlich verwerfen, wenn `lastTs` fehlt/unparsebar oder `ts − lastTs > MAX_PAIR_AGE_MS` (oder negativ). Am Ende immer `next.lastTs = obs.ts`. Der bestehende planType-Reset-Zweig bleibt unverändert (Defense-in-Depth, Kommentar ergänzen).
6. `clearTransients` löscht zusätzlich `lastTs`.
7. `WindowRatioTracker.record(provider, obs)` nutzt `ratioKey(provider, obs.planType)` als Map-Key. `getBudget` bekommt neue Signatur `getBudget(provider: string, planType: string | null | undefined, weeklyUsedPercent: number)` und schlägt unter demselben Key nach. `mergeSeed` bleibt unverändert (Keys sind bereits kompatibel, da der Seeder dieselben Keys erzeugt — Task A2).

**Tests (bestehende anpassen + neue):** Alle bestehenden `recordObservation`-Tests bekommen `ts`-Werte im 60-s-Abstand (Helper `feed` erweitern). Neue Fälle:
- Paar mit Lücke > 10 min wird verworfen (Summen unverändert, `last*` aktualisiert)
- Paar mit Lücke ≤ 10 min wird akzeptiert
- `ratioKey("claude", "default_raven")` → `"claude:default_raven"`; `ratioKey("claude", null)` → `"claude:default"`
- Tracker: `record` mit zwei verschiedenen planTypes erzeugt zwei getrennte States; Wechsel zwischen ihnen löscht nichts; `getBudget("claude", "tierA", …)` liest nur tierA
- `clearTransients` nullt `lastTs`
- `emptyRatioFile().version === 2`

- [ ] Tests anpassen/schreiben → rot → implementieren → grün (`npx vitest run tests/windowRatio.test.ts`) → `npx tsc -p tsconfig.json --noEmit` clean
- [ ] Commit: `feat: learn window ratio per plan tier with max pair age`

---

### Task A2: Store-Guard v2 + Seeder-Keying

**Files:**
- Modify: `src/usage/windowRatioStore.ts`
- Modify: `src/main/windowRatioSeeder.ts`
- Modify: `tests/windowRatioStore.test.ts`, `tests/windowRatioSeeder.test.ts`

**Store:** Guard akzeptiert nur noch `version === 2`; `isProviderState` validiert zusätzlich `lastTs` (null|string). Test: v1-Datei (version: 1) wird verworfen → `emptyRatioFile()` (das erzwingt den Re-Seed); Roundtrip-Test mit `lastTs` ergänzen.

**Seeder:** `seedFromDebugLogs` keyed per `ratioKey(provider, planType)` (planType aus dem Snapshot-Event, fehlend → "default") und übergibt `ts: event.ts` an `recordObservation`. Tests anpassen: bestehende Fixtures bekommen dichte Zeitstempel (≤ 10 min Abstand innerhalb gewollter Paare); neuer Test: zwei interleavte planTypes im selben Log akkumulieren in getrennte Keys und verschmutzen einander nicht; Test: Events > 10 min auseinander bilden kein Paar (z. B. die bestehende Datei-Grenze 09→10 Juni: Zeitstempel so wählen, dass der gewollte Effekt getestet wird — Paar über Dateigrenze MIT ≤10-min-Abstand wird weiterhin akzeptiert).

- [ ] Tests rot → implementieren → grün (`npx vitest run tests/windowRatioStore.test.ts tests/windowRatioSeeder.test.ts`) → tsc clean
- [ ] Commit: `feat: seed and persist tier-keyed window ratio state (v2)`

---

### Task A3: Wiring — RefreshLoop übergibt ts + planType

**Files:**
- Modify: `src/usage/refreshLoop.ts`
- Modify: `tests/refreshLoop.test.ts`

Im windowRatioTracker-Block in `refreshNow`: `ts: now.toISOString()` in die Observation aufnehmen (die `now`-Variable existiert dort bereits) und `getBudget(snapshot.provider, snapshot.planType ?? null, weekly.usedPercent)` mit neuer Signatur aufrufen. Bestehende windowBudget-Tests anpassen (pre-seeded State muss jetzt unter `claude:default`-Key liegen, da die Test-Snapshots keinen planType setzen — `file.providers["claude:default"] = …`). Neuer Test: Snapshot mit `planType: "tierA"` liest den State unter `claude:tierA`.

`src/main/main.ts` braucht KEINE Änderung (Tracker-Konstruktion und Saves sind key-agnostisch).

- [ ] Tests rot → implementieren → grün (`npx vitest run tests/refreshLoop.test.ts`) → `npm run build` clean
- [ ] Commit: `feat: pass observation time and plan tier through refresh loop`

---

### Task A4: Graph-Serie nach planType filtern

**Files:**
- Modify: `src/main/windowBudgetSeries.ts`
- Modify: `src/main/analyticsWorker.ts`
- Modify: `src/main/detailsWindow.ts`
- Modify: `tests/windowBudgetSeries.test.ts`

**Series:** Signatur `readWeeklySeries(logDir, provider, windowStartMs, nowMs, bucketMinutes = 30, planType?: string | null)`. Ist `planType` ein String, werden nur Events mit `event.planType === planType` verarbeitet (Events ohne planType ausgeschlossen); bei `null`/`undefined` Verhalten wie bisher. Der Filter greift VOR der Bucket- und Reset-Verarbeitung (auch `prevFivePct`/`prevFiveResetsAt` sehen nur gefilterte Events).

**Worker:** `WindowBudgetTaskInput.providers[]` erhält `planType: string | null`; `buildWindowBudgetData` reicht ihn an `readWeeklySeries` durch (Positionsparameter: `readWeeklySeries(input.logDir, p.provider, windowStartMs, input.nowMs, 30, p.planType)`).

**IPC-Handler:** im providers-Mapping `planType: s.planType ?? null` ergänzen.

**Tests:** `snapLine`-Helper um optionalen planType erweitern. Neue Fälle: (a) Filter gesetzt → nur passende Events gebucketet, Events ohne planType ausgeschlossen; (b) Reset-Erkennung ignoriert Events fremder planTypes (kein falscher Reset durch Konto-Wechsel-Einbruch); (c) kein Filter → Verhalten wie bisher (bestehende Tests bleiben grün).

- [ ] Tests rot → implementieren → grün (`npx vitest run tests/windowBudgetSeries.test.ts`) → `npm run build` clean
- [ ] Commit: `feat: filter weekly series by active plan tier`

---

### Task A5: Konto-Anzeige — Profil-Abruf + Identity + UI

**Files:**
- Create: `src/auth/claudeProfile.ts`
- Modify: `src/providers/claude.ts`
- Modify: `src/renderer/tabs/live.js`, `src/renderer/index.html` (CSS)
- Test: `tests/claudeProfile.test.ts`
- Verify: `tests/redaction.test.ts` / `src/shared/redaction.ts` (nur lesen)

**Profil-Modul** (`src/auth/claudeProfile.ts`):
```ts
export interface ClaudeProfile {
  email?: string;
  accountUuid?: string;
  displayName?: string;
  organizationName?: string;
}
export async function fetchClaudeProfile(accessToken: string, timeoutMs: number): Promise<ClaudeProfile | null>
```
- GET `https://api.anthropic.com/api/oauth/profile`, Header wie in `requestClaudeUsage` (Bearer, `anthropic-beta: oauth-2025-04-20`, User-Agent). Nicht-OK/Fehler/Timeout → `null` (nie werfen).
- Modul-interner Cache: `Map<accessToken, ClaudeProfile | null>` mit nur dem letzten Eintrag (bei neuem Token Map leeren). Export `clearClaudeProfileCache()` für Tests.
- Test mit gemocktem `fetch` (vi.stubGlobal): Erfolg mappt Felder; HTTP 500 → null; zweiter Aufruf mit gleichem Token trifft den Cache (fetch nur 1×); neues Token → neuer Fetch.

**Provider:** In `ClaudeProvider.fetchUsage` nach erfolgreichem Usage-Abruf: `const profile = await fetchClaudeProfile(credentials.accessToken, this.timeoutMs);` und ans normalisierte Snapshot anhängen: `identity: profile?.email || profile?.accountUuid ? { email: profile.email, accountId: profile.accountUuid } : undefined`. Fehler dürfen den Usage-Pfad nicht brechen (Profil null → kein identity).

**PII-Check:** `src/shared/redaction.ts` lesen und verifizieren, dass E-Mails in Snapshot-Events redigiert werden (Snapshot-Events laufen durch `redactPII`). Falls die bestehende Redaction E-Mail-Felder NICHT abdeckt, im Report melden (DONE_WITH_CONCERNS) — nicht eigenmächtig die Redaction umbauen.

**UI:** In `renderStandard` (live.js) unter dem Provider-Namen, nur wenn `snap.identity?.email`:
`<span class="prov-account" title="Aktives Konto">${QB.esc(snap.identity.email)}</span>`
CSS in index.html (bei den `.prov-*`-Regeln): `.prov-account { font-size: 9px; color: var(--t400); display: block; margin-top: 1px; }` — exakte Einbettung an die bestehende `card-head`-Struktur anpassen (erst lesen; die Zeile darf das Layout der Kopfzeile nicht umbrechen — ggf. unterhalb der `.card-head` platzieren).

- [ ] Tests rot → implementieren → grün (`npx vitest run tests/claudeProfile.test.ts`) → `npm run build` clean
- [ ] Commit: `feat: show active Claude account on provider card`

---

### Task A6: Doku + Aufräumen

**Files:**
- Modify: `docs/how-quotabar-calculates.md` (Fenster-Budget-Sektion: Tier-Keying, Max-Alter, v2-Re-Seed, Konto-Anzeige in 2–3 Sätzen ergänzen)
- Delete: `tmp-identity-probe.mjs` (untracked Probe-Skript)
- Final: Feature-Suite grün (`npx vitest run tests/windowRatio.test.ts tests/windowRatioStore.test.ts tests/windowRatioSeeder.test.ts tests/weeklyForecast.test.ts tests/windowBudgetSeries.test.ts tests/refreshLoop.test.ts tests/claudeProfile.test.ts`), `npm run build` clean, `git status` sauber bis auf `M IDEAS.md` (nicht anfassen!)

- [ ] Commit: `docs: document tier-keyed learning and account display`

---

## Hinweise für alle Tasks

- Bekannte, NICHT zu fixende Altlasten: failing `tests/*.test.js` (stale Artefakte), 5 datums-sensitive Failures in subscription-factor/notifications, `M IDEAS.md`.
- Verifikation pro Task: betroffene `.ts`-Suiten + `npm run build`.
- Commit-Trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

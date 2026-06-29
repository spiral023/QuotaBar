# Design-Addendum: Fenster-Budget bei mehreren Claude-Konten

**Datum:** 2026-06-12
**Status:** Genehmigt
**Ergänzt:** `2026-06-11-window-budget-design.md`

## Problem

Der `WindowRatioTracker` setzt den gelernten State bei jedem `planType`-Wechsel zurück (Drift-Schutz). Nutzer mit mehreren Claude-Konten (Wechsel via `claude /login` überschreibt `~/.claude/.credentials.json`) erzeugen ständig wechselnde `planType`-Werte — der Lerner verliert sein Wissen bei jedem Wechsel und erreicht die 200 %-Schwelle nie („lernt noch…" dauerhaft).

Befund beim Erstnutzer: `default_raven` (3407 Snapshots) und `default_claude_ai` (1152 Snapshots) im Wechsel; Claude-State stand bei Σ Δ5h = 17 %.

## Erkenntnisse

1. Der Endpoint `GET https://api.anthropic.com/api/oauth/profile` (gleiche OAuth-Auth wie `/usage`, Header `anthropic-beta: oauth-2025-04-20`) liefert die Konto-Identität: `account.uuid`, `account.email`, `account.display_name`, `organization.name`, `organization.rate_limit_tier`.
2. `rate_limit_tier` ist eine Eigenschaft der **Organisation/des Abos** — gleicher Tier bedeutet gleiche Limits und damit gleiches Fenster-Verhältnis. Die korrekte Lern-Granularität ist daher **pro Tier (`planType`)**, nicht pro Konto und nicht global.

## Entscheidungen

### 1. Lerner-Key = `provider:planType`

- State-Map-Key: `` `${provider}:${planType ?? "default"}` `` (Helper `ratioKey(provider, planType)`).
- Jeder Tier lernt unabhängig; ein Konto-/Tier-Wechsel löscht nichts mehr.
- Der bisherige planType-Reset in `recordObservation` bleibt als Defense-in-Depth bestehen (innerhalb eines Keys ist `planType` per Konstruktion stabil; der Zweig greift praktisch nie).
- **Dateiversion → 2.** Der Loader verwirft v1-Dateien (liefert leeren State, `seededThrough: null`) → der Seeder läuft beim nächsten Start automatisch neu und baut alle Tier-Keys aus den Logs auf (historische Snapshot-Events enthalten `planType`).

### 2. Max-Alter für Beobachtungs-Paare

- `ProviderRatioState` erhält `lastTs: string | null` (ISO-Zeitstempel der letzten Beobachtung).
- `RatioObservation` erhält `ts: string` (Pflicht; RefreshLoop übergibt die Refresh-Zeit, der Seeder den Event-Zeitstempel).
- Paare werden nur akzeptiert, wenn `ts − lastTs ≤ 10 min` (`MAX_PAIR_AGE_MS`). Fehlt `lastTs` oder ist es nicht parsebar → Paar verwerfen, nur `last*` aktualisieren.
- Deckt ab: Konto-Wechsel-Lücken, App-Pausen/Neustarts, Log-Lücken beim Seeding. `clearTransients` löscht `lastTs` mit.

### 3. Graph-Serie nach `planType` filtern

- `readWeeklySeries(...)` erhält einen optionalen Parameter `planType?: string | null`.
- Ist er gesetzt, zählen nur Snapshot-Events mit exakt diesem `event.planType` (Events ohne `planType` werden ausgeschlossen). Ist er `null`/nicht gesetzt, Verhalten wie bisher.
- Worker-Input (`WindowBudgetTaskInput.providers[]`) und IPC-Handler reichen `planType: snapshot.planType ?? null` durch.
- Wirkung: Der Weekly-Graph zeigt nur die Historie des aktiven Kontos/Tiers; bei Ein-Konto-Nutzern ändert sich nichts (ein Tier = alle Events).

### 4. Konto-Anzeige (aktives Claude-Konto)

- Neues Modul `src/auth/claudeProfile.ts`: `fetchClaudeProfile(accessToken, timeoutMs)` → `{ email, accountUuid, displayName, organizationName } | null`. Fehler sind nicht-fatal (null).
- Cache pro `accessToken` (Modul-Map, letzter Eintrag genügt): Profil wird nur neu geholt, wenn sich das Token ändert (= Konto-Wechsel oder Refresh).
- `ClaudeProvider.fetchUsage` befüllt `snapshot.identity = { email, accountId: accountUuid }` (bestehendes Feld in `UsageSnapshot`).
- UI (Live-Tab, Provider-Karte): kleine, gedämpfte Zeile mit der E-Mail unter dem Provider-Namen, nur wenn `identity.email` vorhanden (Codex liefert nur eine UUID — wird nicht angezeigt).
- **PII:** Snapshot-Events laufen durch `redactPII` ins Debug-Log — verifizieren, dass die E-Mail dort redigiert wird (bestehende Redaction-Mechanik).

## Szenarien-Matrix

| Szenario | Verhalten |
|---|---|
| 1 Konto | Ein Key, identisch zu vorher minus Fehl-Resets; Max-Age wirkt wie bisheriger Neustart-Schutz |
| N Konten, verschiedene Tiers | Ein Key pro Tier, unabhängiges Lernen, Kennzahlen immer fürs aktive Konto |
| N Konten, gleicher Tier | Geteilter Key — fachlich korrekt (gleiche Limits). Wechsel-Paare werden durch resetsAt-Differenz bzw. Max-Age verworfen |
| Graph bei N Konten | Nur Events des aktiven planType — keine Sprünge zwischen Konten |

## Nicht im Scope

- Codex-Multi-Konto (kein bekannter Bedarf; Architektur deckt es über denselben Key-Mechanismus automatisch ab).
- Historische Trennung des Wochenprofils nach Konto (Backfill-Tagessummen sind kontoübergreifend; als zeitliche Form weiterhin ausreichend, im Ursprungs-Spec dokumentierte Näherung).

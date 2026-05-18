# Notification Improvements Plan

**Datum:** 2026-05-19  
**Status:** Draft  
**Scope:** Bessere QuotaBar-Benachrichtigungen, konfigurierbar in einem neuen Dashboard-Tab

## Ziel

QuotaBar soll nicht nur melden, dass ein Limit bereits zurueckgesetzt wurde, sondern den Nutzer intelligent dabei unterstuetzen, vorhandene Limits gut zu nutzen und riskante Nutzung frueh zu erkennen. Benachrichtigungen muessen sparsam, konfigurierbar und erklaerbar sein. Jede Meldung soll entweder eine konkrete Entscheidung verbessern oder eine relevante Zustandsaenderung sichtbar machen.

## Leitprinzipien

- **Nur Zustandswechsel melden:** Eine Regel feuert nicht bei jedem Poll, sondern wenn ein Zustand neu eintritt, z.B. `ahead -> farAhead` oder `70% -> 90%`.
- **Konfigurierbare Schwellen:** Prozentwerte, Token-Proxies, Cooldowns und Provider-Scope sind pro Regel anpassbar.
- **Gute Defaults:** Riskante Limit- und Forecast-Meldungen sind standardmaessig aktiv. Informative Nutzungs- und ROI-Meldungen sind gedrosselt oder aus.
- **Keine sensiblen Inhalte:** Keine Prompts, Dateipfade, Tokens, Cookies, Authorization Header, JWTs oder Roh-Session-Inhalte in Notification-Texten.
- **Eine Meldung muss Handlung nahelegen:** Jede Notification beantwortet implizit: "Warum sehe ich das jetzt?"
- **Cooldown vor Vollstaendigkeit:** Lieber eine relevante Meldung verpassen als den Nutzer mit Wiederholungen stoeren.
- **Dashboard-first:** Alle Regeln sind sichtbar, abschaltbar und begruendet. Es gibt keine versteckten Alerts.

## Produktentscheidung

Empfohlener Ansatz: **regelbasierter Notification-Engine-Kern mit Dashboard-Konfiguration**.

Alternativen:

| Ansatz | Vorteil | Nachteil | Entscheidung |
|---|---|---|---|
| Harte feste Alerts | Schnell, wenig UI | Nicht an Nutzungsstil anpassbar | Nicht ausreichend |
| Komplett frei konfigurierbare Regeln | Maximale Flexibilitaet | Zu komplex fuer Tray-App | Zu schwergewichtig |
| Vordefinierte intelligente Regeln mit einstellbaren Schwellen | Gute UX, testbar, nicht zu komplex | Mehr Initialaufwand | **Empfohlen** |

## Zielbild im Dashboard

Ein neuer Tab **Notifications** wird neben Live/Reports angezeigt.

### Aufbau

1. **Global**
   - Master-Schalter: Desktop notifications on/off
   - Quiet hours: Start/Ende, z.B. 22:30-08:00
   - Minimum gap between notifications: z.B. 15 Minuten
   - Test notification Button

2. **Rule Groups**
   - Quota windows
   - Pace & runway
   - Historical usage
   - Economics
   - Data quality

3. **Rule Row**
   - Enable/disable Toggle
   - Name und Kurzbeschreibung
   - Provider: All / Claude / Codex
   - Window: 5h / weekly / credits / all
   - Threshold-Feld, falls relevant
   - Cooldown, z.B. 30m, 2h, 1d
   - Severity: info / watch / warning / critical

4. **Recent Notifications**
   - Letzte 20 ausgelöste Meldungen
   - Zeit, Regel, Provider, Window
   - Grund: z.B. `usedPercent crossed 90%`
   - Keine sensiblen Rohdaten

## Datenbasis

### Heute vorhanden

- Live-Snapshots pro Provider
- Windows: `fiveHour`, `weekly`, `credits`, `session`
- `usedPercent`, `resetsAt`, `windowSeconds`
- Weekly pace mit `stage`, `deltaPercent`, `etaSeconds`, `willLastToReset`
- Reset-Erkennung bei `>=99.5% -> <=1%`

### Spaeter zusaetzlich nutzbar

Aus den geplanten Nutzungsdaten:

- 30d aktive Tage und aktive Stunden
- Rolling 5h Output-Token und Gesamt-Token
- Tages-/Wochenverbrauch
- Modell-Mix
- Cache-Hit-Rate
- API-Aequivalentkosten und ROI
- Session-Dauer und Arbeitszeitmuster
- typische Aktivitaetsfenster, z.B. 18:00-21:00 CEST

## Notification-Katalog

Die Liste enthaelt 18 Regeln. Das ist bewusst oberhalb der Minimalmenge, aber noch klein genug fuer eine uebersichtliche Konfiguration.

| Nr. | Regel | Default | Daten | Konfigurierbar | Zweck |
|---:|---|---|---|---|---|
| 1 | Confirmed limit reset | On | Live | Window, cooldown | Meldet, dass 5h/weekly wieder verfuegbar ist |
| 2 | Unexpected limit reset | On | Live | Drop-Schwelle, min previous usage | Erkennt ausserplanmaessige Resets auch unter 99.5% |
| 3 | Reset soon | Off | Live | Minuten vor Reset | Erinnerung kurz vor neuem 5h/weekly Fenster |
| 4 | High usage crossed | On | Live | Prozent, z.B. 80% | Fruehe Warnung vor knappem Limit |
| 5 | Critical usage crossed | On | Live | Prozent, z.B. 95% | Letzte Warnung vor Limit-Ende |
| 6 | Projected depletion before reset | On | Pace | Minutenpuffer, Provider | Meldet, wenn die aktuelle Rate vor Reset auf 100% fuehrt |
| 7 | Far ahead pace transition | On | Pace | Delta, cooldown | Nutzung laeuft deutlich schneller als erwarteter Wochenpfad |
| 8 | Far behind pace transition | Off | Pace | Delta, Tageszeit | Nutzung liegt deutlich unter erwarteter Wochenrate, also viel Reserve |
| 9 | Fresh quota available in usual work window | On | Live + history | Mindestreserve, Aktivitaetsfenster | Intelligente Erinnerung: jetzt ist gute Nutzungszeit und Limit ist offen |
| 10 | Quota idle after reset | Off | Live + history | Minuten seit Reset, Mindestreserve | Meldet, wenn ein frisches Fenster ungenutzt bleibt |
| 11 | Weekly reserve opportunity | Off | Weekly + history | Restquote, Tage bis Reset | Erinnerung, dass noch viel Wochenkontingent offen ist |
| 12 | Rolling 5h output spike | On | History | Output-token Schwelle oder p90 | Erkennt intensive Multi-Subagent-Runs |
| 13 | Rolling 5h proxy near custom limit | On | History | Token-Proxy-Limit | Nutzt Output-Token als Proxy fuer echte 5h-Grenzen |
| 14 | Burn rate unusually high | On | History | Faktor gegen Median/p90 | Meldet ungewoehnlich schnelle Nutzung im Vergleich zu eigener Historie |
| 15 | Cache hit rate dropped | Off | History | Prozent, Provider | Warnt, wenn Cache-Effizienz stark sinkt |
| 16 | Expensive model share spike | Off | History | Modell, Anteil | Meldet, wenn teure Modelle ploetzlich dominieren |
| 17 | ROI milestone | Off | History + pricing | Faktor, z.B. 2x/5x/10x | Positive, seltene Wirtschaftlichkeitsmeldung |
| 18 | Provider data stale or recovered | On | Live/status | Minuten stale, recovered on/off | Operative Meldung, wenn Daten unzuverlaessig oder wieder aktuell sind |

## Regel-Details

### 1. Confirmed Limit Reset

**Trigger:** Vorherige Nutzung war sehr hoch, neue Nutzung ist nahe 0%.  
**Default:** Aktiv fuer 5h und weekly.  
**Text:** `Claude 5h limit reset. Usage is back at 0%.`  
**Verbesserung gegenueber heute:** Bleibt erhalten, aber mit Rule-State, Cooldown und Dashboard-Schalter.

### 2. Unexpected Limit Reset

**Trigger:** Nutzung faellt stark, z.B. von mindestens 25% auf maximal 5%, obwohl der alte Code kein klassisches `99.5 -> 1` Reset erkennt.  
**Default:** Aktiv.  
**Text:** `Codex 5h usage dropped from 42% to 0%. This looks like an early reset.`  
**Warum interessant:** Der Nutzer hat explizit berichtet, dass Limits manchmal aussernatuerlich zurueckgesetzt werden.

### 3. Reset Soon

**Trigger:** `resetsAt` liegt innerhalb eines konfigurierten Fensters, z.B. 10 Minuten.  
**Default:** Aus, weil es fuer manche stoerend ist.  
**Text:** `Claude weekly resets in 10 minutes.`  
**Guardrail:** Nur einmal pro Window-Zyklus.

### 4. High Usage Crossed

**Trigger:** `usedPercent` ueberschreitet 80%, vorher darunter.  
**Default:** Aktiv.  
**Text:** `Codex 5h usage crossed 80%.`  
**Konfiguration:** Schwelle pro Window, z.B. 70/80/90%.

### 5. Critical Usage Crossed

**Trigger:** `usedPercent` ueberschreitet 95%, vorher darunter.  
**Default:** Aktiv.  
**Text:** `Claude 5h usage is at 96%.`  
**Guardrail:** Critical ersetzt High, wenn beide im gleichen Poll feuern.

### 6. Projected Depletion Before Reset

**Trigger:** Pace-Forecast ergibt, dass 100% vor `resetsAt` erreicht werden.  
**Default:** Aktiv.  
**Text:** `At this pace, Claude weekly may run out before reset.`  
**Konfiguration:** Mindestvorlauf, z.B. nur melden, wenn voraussichtliches Limit-Ende mindestens 30 Minuten vor Reset liegt.

### 7. Far Ahead Pace Transition

**Trigger:** Weekly-Pace springt neu auf `farAhead`.  
**Default:** Aktiv.  
**Wichtige Kopie-Korrektur:** In der aktuellen Logik bedeutet `farAhead`: reale Nutzung liegt deutlich ueber erwarteter Nutzung. Der Text muss das klar sagen.  
**Text:** `Claude weekly usage is far ahead of pace (+18%). Slow down if you need quota later.`

### 8. Far Behind Pace Transition

**Trigger:** Weekly-Pace springt neu auf `farBehind`.  
**Default:** Aus.  
**Text:** `Claude weekly usage is far behind pace. You have more weekly quota available than usual.`  
**Warum optional:** Das ist keine Gefahr, sondern eine Nutzungschance. Sinnvoll fuer Nutzer, die aktiv an offene Kontingente erinnert werden wollen.

### 9. Fresh Quota Available In Usual Work Window

**Trigger:** 5h-Window ist niedrig genutzt, z.B. unter 20%, und aktuelle Zeit faellt in ein historisch aktives Fenster.  
**Default:** Aktiv mit langem Cooldown, z.B. 1x pro Tag.  
**Text:** `Your usual coding window is starting and Claude 5h quota is mostly open.`  
**Datenbezug:** Beispielanalyse zeigt Peak 18:00-21:00 CEST.

### 10. Quota Idle After Reset

**Trigger:** Reset erkannt, danach bleibt Nutzung fuer z.B. 60 Minuten unter 10%, waehrend Nutzer normalerweise in dieser Zeit aktiv ist.  
**Default:** Aus.  
**Text:** `Claude reset an hour ago and the 5h window is still mostly unused.`  
**Guardrail:** Nicht waehrend Quiet Hours.

### 11. Weekly Reserve Opportunity

**Trigger:** Weekly-Nutzung ist niedrig im Verhaeltnis zum verbleibenden Zeitraum, z.B. `farBehind`, weniger als 40% genutzt, weniger als 48h bis Reset.  
**Default:** Aus.  
**Text:** `You still have substantial Claude weekly quota before reset.`  
**Nutzen:** Erinnert daran, offene Wochenlimits sinnvoll auszunutzen.

### 12. Rolling 5h Output Spike

**Trigger:** Output-Token im rollenden 5h-Fenster ueberschreiten eigenes p90/p95 oder festen Wert.  
**Default:** Aktiv, sobald historische Daten verfuegbar sind.  
**Text:** `This 5h window is above your usual output-token peak.`  
**Datenbezug:** Beispiel-Peak: 313.400 Output-Token in 5h.

### 13. Rolling 5h Proxy Near Custom Limit

**Trigger:** Output-Token im 5h-Fenster erreichen z.B. 70/90/100% eines nutzerdefinierten Proxy-Limits.  
**Default:** Aktiv mit Standardschwelle 80%.  
**Text:** `Claude 5h output proxy reached 80% of your custom limit.`  
**Warum:** Claude-Limits sind nicht rein token-basiert, aber Output-Token korrelieren mit Nutzungsgewicht.

### 14. Burn Rate Unusually High

**Trigger:** Verbrauch pro Stunde liegt deutlich ueber historischem Median, z.B. Faktor 2.0.  
**Default:** Aktiv.  
**Text:** `Codex burn rate is 2.3x above your 30-day baseline.`  
**Nutzen:** Erkennt ungewoehnliche Runs frueher als reine Prozentlimits.

### 15. Cache Hit Rate Dropped

**Trigger:** Cache-Hit-Rate faellt unter Schwelle, z.B. Claude unter 98% oder Codex unter 90%.  
**Default:** Aus.  
**Text:** `Claude cache hit rate dropped below 98% today.`  
**Datenbezug:** Beispielwerte: Claude 99,97%, Codex 94,8%.

### 16. Expensive Model Share Spike

**Trigger:** Ein teures Modell erreicht einen hohen Anteil an Kosten oder Tokens, z.B. Opus ueber 10% Tageskosten.  
**Default:** Aus.  
**Text:** `Opus usage is unusually high today.`  
**Guardrail:** Nur mit Kosten-/Modellaggregaten, keine Prompt-Inhalte.

### 17. ROI Milestone

**Trigger:** API-Aequivalentwert ueberschreitet Vielfaches des Abopreises, z.B. 2x, 5x, 10x.  
**Default:** Aus oder als Weekly Digest.  
**Text:** `Claude reached 10x subscription value this month.`  
**Datenbezug:** Beispiel: USD 211,54 bei USD 20 Abo entspricht 10,6x ROI.

### 18. Provider Data Stale Or Recovered

**Trigger:** Provider bleibt laenger als z.B. 10 Minuten stale/error oder wechselt von stale/error zu ok.  
**Default:** Aktiv.  
**Text:** `Codex usage data is stale.` / `Codex usage data is current again.`  
**Nutzen:** Verhindert falsches Vertrauen in alte Quota-Daten.

## Default-Konfiguration

```json
{
  "notifications": {
    "enabled": true,
    "quietHours": { "enabled": false, "start": "22:30", "end": "08:00" },
    "minimumGapMinutes": 15,
    "rules": {
      "confirmedReset": { "enabled": true, "cooldownMinutes": 30 },
      "unexpectedReset": { "enabled": true, "minPreviousPercent": 25, "maxNextPercent": 5, "cooldownMinutes": 30 },
      "resetSoon": { "enabled": false, "minutesBeforeReset": 10, "cooldownMinutes": 120 },
      "highUsage": { "enabled": true, "thresholdPercent": 80, "cooldownMinutes": 60 },
      "criticalUsage": { "enabled": true, "thresholdPercent": 95, "cooldownMinutes": 60 },
      "projectedDepletion": { "enabled": true, "minEarlyMinutes": 30, "cooldownMinutes": 120 },
      "farAhead": { "enabled": true, "minDeltaPercent": 12, "cooldownMinutes": 240 },
      "farBehind": { "enabled": false, "minDeltaPercent": 12, "cooldownMinutes": 720 },
      "freshQuotaWorkWindow": { "enabled": true, "maxUsedPercent": 20, "cooldownMinutes": 1440 },
      "quotaIdleAfterReset": { "enabled": false, "minutesAfterReset": 60, "maxUsedPercent": 10, "cooldownMinutes": 1440 },
      "weeklyReserveOpportunity": { "enabled": false, "maxUsedPercent": 40, "hoursBeforeReset": 48, "cooldownMinutes": 1440 },
      "rolling5hOutputSpike": { "enabled": true, "baseline": "p95", "cooldownMinutes": 180 },
      "rolling5hProxyLimit": { "enabled": true, "thresholdPercent": 80, "customOutputTokenLimit": 500000, "cooldownMinutes": 180 },
      "burnRateSpike": { "enabled": true, "factor": 2.0, "cooldownMinutes": 180 },
      "cacheHitDrop": { "enabled": false, "claudeThresholdPercent": 98, "codexThresholdPercent": 90, "cooldownMinutes": 1440 },
      "expensiveModelShare": { "enabled": false, "thresholdPercent": 10, "cooldownMinutes": 1440 },
      "roiMilestone": { "enabled": false, "milestones": [2, 5, 10], "cooldownMinutes": 10080 },
      "providerDataHealth": { "enabled": true, "staleMinutes": 10, "notifyRecovered": true, "cooldownMinutes": 60 }
    }
  }
}
```

## Architekturplan

### Neue konzeptionelle Bausteine

| Baustein | Verantwortung |
|---|---|
| `NotificationRule` | Persistierte Konfiguration einer Regel |
| `NotificationEvent` | Ergebnis einer Regelpruefung, noch nicht angezeigt |
| `NotificationStateStore` | Letzte Regelzustaende, letzte Ausloesung, Cooldowns |
| `NotificationEngine` | Fuehrt Regeln gegen Live- und History-Kontext aus |
| `NotificationHistory` | Letzte ausgelöste Events fuer Dashboard-Tab |
| `NotificationSettingsView` | Dashboard-Tab fuer Schalter, Schwellen und Verlauf |

### Datenfluss

1. `RefreshLoop` liefert neue Snapshots.
2. Main-Prozess baut `NotificationContext` aus:
   - aktuelle Snapshots
   - vorherige Snapshots
   - optional historische 5h-/30d-Aggregate
   - aktuelle Settings
   - Notification-State
3. `NotificationEngine` erzeugt `NotificationEvent[]`.
4. Dedupe, Cooldown, Quiet Hours und Severity-Prioritaet filtern Events.
5. `NotificationService` zeigt die uebrig gebliebenen Events.
6. Events werden in `NotificationHistory` fuer den Dashboard-Tab gespeichert.

### Priorisierung bei mehreren Events

Wenn in einem Poll mehrere Events entstehen:

1. Critical gewinnt vor warning, warning vor watch, watch vor info.
2. Pro Provider und Window maximal eine Notification.
3. `criticalUsage` ersetzt `highUsage`.
4. `unexpectedReset` ersetzt `confirmedReset`.
5. `projectedDepletion` ersetzt `farAhead`, wenn beide gleichzeitig feuern.

## Dashboard-UX

### Rule Card

Jede Regel bekommt eine kompakte Karte:

```text
[toggle] Critical usage crossed                         warning
        Warn when a 5h or weekly window crosses 95%.
        Provider [All v]   Window [All v]   Threshold [95 %]
        Cooldown [1h v]
```

### Presets

Optionaler Preset-Switch oben im Tab:

| Preset | Verhalten |
|---|---|
| Quiet | Nur critical, unexpected reset, data health |
| Balanced | Empfohlene Defaults |
| Verbose | Auch Reserve-, ROI- und Cache-Hinweise |

Balanced ist Default.

### Copy-Regeln

- Titel kurz: `Claude weekly is at 95%`
- Body erklaert Grund und naechste Handlung: `At this pace it may run out before reset.`
- Prozentwerte runden auf ganze Zahlen.
- Tokenwerte kompakt: `313k output tokens`, `49.6M total tokens`.
- Zeiten lokal anzeigen, nicht UTC, ausser im Reports-Export.

## Implementierungsphasen

### Phase 1: Notification-Konfiguration und bestehende Reset-Alerts steuerbar machen

- Settings um `notifications` erweitern.
- Existing reset detection in die neue Rule-Struktur einhaengen.
- Master-Schalter, Rule-Toggles und Test-Notification im Dashboard-Tab.
- Tests fuer Defaults, Normalisierung und Reset-Regeln.

### Phase 2: Live-Regeln ohne Historie

- High/Critical usage.
- Reset soon.
- Projected depletion.
- Far ahead / far behind transitions.
- Provider stale/recovered.
- State Store fuer Transitionserkennung und Cooldowns.

### Phase 3: Historische Regeln

- Rolling 5h Output-Token.
- Proxy-Limit.
- Burn-rate spike.
- Fresh quota in usual work window.
- Weekly reserve opportunity.
- Cache-hit drop.
- Expensive model share.
- ROI milestone.

### Phase 4: Dashboard-Polish und Audit

- Recent Notifications.
- Presets.
- Copy-Review fuer Pace-Semantik.
- Manuelle Windows-Notification-Pruefung.
- `npm test` und `npm run build`.

## Teststrategie

### Unit-Tests

- Rule-Trigger mit synthetischen Snapshots.
- Schwellenuebergaenge, z.B. `79 -> 80`, `94 -> 95`.
- Kein Event ohne Zustandswechsel.
- Cooldown verhindert Wiederholung.
- Quiet Hours unterdruecken nicht-kritische Events.
- Priority ersetzt niedrigere Events.
- Settings-Normalisierung validiert Schwellen und Defaults.

### Integrationstests

- `NotificationService.onRefresh()` verarbeitet mehrere Provider.
- History-Events landen im Dashboard-Modell.
- Stale/recovered entsteht bei Statuswechseln.
- Historische Aggregates fehlen: History-Regeln bleiben still, Live-Regeln funktionieren weiter.

### Manuelle Pruefung

- Test notification im Dashboard.
- Windows Focus Assist / Benachrichtigungseinstellungen beachten.
- Keine sensitiven Inhalte in Notification-Body oder Logs.
- Kein Notification-Spam bei kurzem Poll-Interval.

## Offene Produktentscheidungen

Diese Punkte sollten vor der Implementierung entschieden werden:

1. Soll `farAhead` im UI umbenannt werden, damit klar ist, ob es "Nutzung voraus" oder "Quota reicht weit" bedeutet?
2. Soll der Notifications-Tab bereits im Compact-Modus erreichbar sein oder nur im breiten Dashboard?
3. Soll der Nutzer eigene Proxy-Limits pro Provider speichern koennen, z.B. Claude 5h Output-Token 500k?
4. Soll es einen Daily Digest statt einzelner ROI-/Reserve-Meldungen geben?
5. Sollen Critical Alerts Quiet Hours ignorieren duerfen?

## Nicht im Scope

- Mobile Push oder externe Webhooks.
- E-Mail, Slack, Teams oder Systemkalender.
- Automatische Modellwahl oder Verbrauchsdrosselung.
- Anzeige von Prompt-/Dateiinhalten.
- Breite Suche nach Auth-Dateien oder neuen Tokenquellen.

## Self-Review

- Die geplanten Benachrichtigungen liegen bei 18 Regeln und damit im gewuenschten Bereich von ca. 10-20.
- Jede Regel hat Zweck, Datenbasis, Default und Konfigurierbarkeit.
- Der Plan enthaelt einen eigenen Dashboard-Tab fuer Ein-/Ausschalten und Schwellwerte.
- Historische Nutzungsdaten aus dem Beispiel werden beruecksichtigt, bleiben aber optional fuer Phase 3.
- Es wurden keine Code-Dateien geaendert.

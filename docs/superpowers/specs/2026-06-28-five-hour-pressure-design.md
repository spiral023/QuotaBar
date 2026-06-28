# 5H Window Pressure — Analytics-Kachel (Design)

**Datum:** 2026-06-28
**Status:** freigegeben (Brainstorming abgeschlossen)

## Ziel

Die bestehende Analytics-Kachel **5H Window Peak** komplett ersetzen. Heute zählt sie
Output-Tokens des intensivsten 5h-Fensters und vergleicht sie gegen willkürliche
Marken (200k/500k/800k), die nichts mit dem echten Account-Limit zu tun haben. Das ist
für den Nutzer wenig aussagekräftig.

Die neue Kachel **5H Window Pressure** zeigt stattdessen die **Quota-Nähe / das
Throttling-Risiko** auf Basis der **echten, vom API gemeldeten Fenster-Auslastung**
(`fivePct`, 0–100 %) — und zwar **gleichwertig für Claude und Codex, nebeneinander**.

Kernaussage: *„Wie viele meiner aktiven 5h-Fenster liefen nah am Limit (≥ 90 %)?"*

## Nicht im Scope (YAGNI)

- Trend über Zeit / Sparkline (war Alternativ-Ansatz, bewusst ausgelassen).
- Drill-down / Klick auf Balken.
- Risiko-Ampel als Einzelkennzahl (Alternativ-Ansatz).

## Datenquelle & Kennzahl

Quelle sind die Live-Debug-Logs (Snapshot-Events), gelesen über
`readWindowHistoryObservations(logDir)` → `HistoryObservation[]` mit Feldern
`provider`, `ts`, `fivePct`, `fiveResetsAt`, `weeklyPct`, `weeklyResetsAt`.

Neue, IO-freie Aggregationsfunktion in [src/usage/windowHistory.ts](../../../src/usage/windowHistory.ts):

```ts
export interface PressureDist {
  buckets: { crit: number; high: number; mid: number; low: number; min: number };
  total: number;                 // Anzahl aktiver Fenster (Peak > 5 %)
  hotCount: number;              // Fenster mit Peak >= 90 %  (= buckets.crit)
  worst: { pct: number; windowStart: string } | null;
}

export function buildFiveHourPressure(
  observations: HistoryObservation[],
  sinceMs: number,
  untilMs: number,
  provider: string,
): PressureDist
```

Algorithmus:

1. Beobachtungen auf `provider` filtern.
2. Nach `fiveResetsAt` in 5h-Fenster segmentieren — gleiche Logik wie `buildEntry`
   in `windowHistory.ts` (`resetsAtChanged` als Fenstergrenze; `fiveResetsAt === null`
   wird dem laufenden Fenster zugeschlagen, kein Split).
3. Pro Fenster den **Spitzen-`fivePct`** ermitteln (Peak-Füllgrad).
4. Fenster nur zählen, wenn **aktiv**: Peak > `USED_WINDOW_MIN_PCT` (= 5 %).
   Idle-Polling-Fenster fluten sonst den untersten Bucket.
5. Fenster nach **Startzeitpunkt** (ts der ersten Beobachtung im Fenster) auf
   `[sinceMs, untilMs]` filtern.
6. Peaks in 5 Buckets einsortieren, `worst` = Fenster mit höchstem Peak.

Bei Codex ist `fivePct` das `primary_window` (Dauer in `windowSeconds`, real meist ~5h).
Die Segmentier-/Bucket-Logik ist providerneutral; die Funktion wird einmal pro Provider
aufgerufen.

## Buckets

Spitzen-`fivePct` pro aktivem Fenster, `>=`-Semantik (Grenzwert landet im oberen Bucket):

| Bucket | Bereich   | Bedeutung       | Farbe              |
|--------|-----------|-----------------|--------------------|
| crit   | ≥ 90 %    | Throttling-nah  | rot `#e55`         |
| high   | 75–90 %   | Warnung         | orange `#f59830`   |
| mid    | 50–75 %   | moderat         | gelb-grün          |
| low    | 25–50 %   | locker          | grün `#52d017`     |
| min    | 5–25 %    | minimal         | grün, gedämpft     |

## Architektur / Datenfluss

Gewählter Weg (Renderer bleibt simpel — ein Daten-Objekt wie heute):

1. `AnalyticsTaskInput` in [src/main/analyticsWorker.ts](../../../src/main/analyticsWorker.ts)
   um `logDir: string` + `nowMs: number` erweitern (im Main-Prozess bereits verfügbar,
   wird an `windowHistory`/`windowBudget`-Tasks schon übergeben).
2. Im `analytics:get`-Pfad zusätzlich `readWindowHistoryObservations(logDir)` aufrufen
   und `buildFiveHourPressure(...)` **zweimal** rechnen (Claude + Codex), begrenzt auf
   `since`/`until` der Auswahl.
3. `AnalyticsData.fiveHourPeak` **ersatzlos ersetzen** durch:
   ```ts
   fiveHourPressure: { claude: PressureDist; codex: PressureDist };
   ```
4. Renderer [src/renderer/tabs/analytics.js](../../../src/renderer/tabs/analytics.js):
   `_buildFiveHourPeak(data)` → `_buildFiveHourPressure(data)`, liest
   `data.fiveHourPressure`. Gleicher Render-Pfad wie heute, nur andere Quelle.

**Kosten:** `analytics:get` liest künftig auch die Snapshot-Logs (kleine Zusatz-IO).
Akzeptabel — Logs sind klein, der Worker ist langlebig und cached.

## Darstellung (Renderer)

Eine `.an-section`, Titel `5H WINDOW PRESSURE (${winLabel})` (ohne `(CLAUDE)`).
Darunter **zwei Spalten nebeneinander** (CSS-Grid/Flex, je ~50 %), links Claude,
rechts Codex:

```
5H WINDOW PRESSURE (30 DAYS)

 CLAUDE   3/47 hot (>=90%)      CODEX   1/22 hot (>=90%)
 >=90 ###            3          >=90 #               1
 75-90 #####         5          75-90 ##              2
 50-75 #########     9          50-75 ####            5
 25-50 ############  14         25-50 ######          8
  5-25 ############# 16          5-25 #####            6
 worst 97% - Jun 24            worst 82% - Jun 26
```

- **Headline pro Spalte:** `hotCount`/`total` aktiver Fenster ≥ 90 %.
- Balkenbreite **relativ zum eigenen Max-Bucket** je Spalte (getrennte Skalen —
  Provider sind unterschiedlich aktiv; gemeinsame Skala wäre irreführend).
- **Worst-Window** mit **lokaler Zeit** (behebt die verwirrende UTC-Anzeige von heute).
- **Leer-/Learning-Zustand pro Spalte unabhängig:** `total === 0` oder keine
  Beobachtungen → „Not enough window data yet" (analog Window-History-Kachel).
- Alle UI-Strings bleiben **englisch** (App-Konvention).

## Aufräumen

- `buildFiveHourPeak` + Konstante `FIVE_HOURS_MS` (sofern nur dort genutzt) in
  `analyticsSummary.ts` entfernen.
- `_FIVE_HOUR_THRESHOLDS` + `_buildFiveHourPeak` im Renderer entfernen.
- Altes Feld `fiveHourPeak` aus `AnalyticsData` entfernen (kein Parallel-Betrieb).
- Zugehörige CSS-Klassen (`an-peak-hero`, `an-peak-sub`, `an-threshold*`) prüfen und
  durch neue Pressure-Klassen ersetzen.

## Tests

Unit-Tests für `buildFiveHourPressure` (synthetische `HistoryObservation[]`, kein IO):

- Segmentierung nach `fiveResetsAt` → korrekte Fenster-Anzahl + Peak je Fenster.
- Aktiv-Filter: Fenster mit Peak ≤ 5 % zählen nicht.
- Bucket-Grenzen: Werte exakt auf 90/75/50/25 landen im **oberen** Bucket.
- Zeitraum-Filter `since`/`until` schneidet Fenster außerhalb korrekt ab.
- `worst` = Fenster mit höchstem Peak + Startzeit; `null` bei 0 Fenstern.
- `hotCount`/`total` korrekt.
- **Provider-Trennung:** gemischte Claude-+Codex-Serie → je Provider nur eigene Fenster.
- `fiveResetsAt === null` → kein Fenster-Split.

Bestehende `buildFiveHourPeak`-Tests in
[tests/analyticsDeepDive.test.ts](../../../tests/analyticsDeepDive.test.ts) entfernen/ersetzen.

## Edge Cases

- **Keine/nur Idle-Fenster** → `total: 0`, Leer-Zustand pro Spalte.
- **`fiveResetsAt` null** (Claude lässt es bei 0 % manchmal weg) → laufendem Fenster
  zuschlagen, kein Split (konsistent mit `resetsAtChanged`).
- **Multi-Account** (2 Claude-Abos): `fivePct` spiegelt das beim Snapshot aktive Konto;
  die Verteilung zeigt die real erlebte Quota-Last kontenübergreifend. Kein Sonder-Handling.

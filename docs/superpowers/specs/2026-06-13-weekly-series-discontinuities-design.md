# Weekly-Budget-Serie: Diskontinuitäten ehrlich darstellen

**Datum:** 2026-06-13
**Status:** Entwurf genehmigt

## Problem

Wenn QuotaBar über einen Zeitraum nicht läuft (App-Pause) oder Claude den
Weekly-Zähler server-seitig zurücksetzt, stellt der FENSTER-BUDGET-Graph dies
falsch dar.

Konkret beobachtet (12./13.06.2026):

- Letzter Snapshot **12.06. 09:46 UTC**: weekly = 67 %, `resetsAt` 16.06. 11:00.
- ~22 h Datenlücke (App aus; bei Wiederanlauf `ENOTFOUND` + OAuth-Refresh).
- Ab **13.06. 08:34 UTC**: weekly = 0→2 %, `resetsAt` **unverändert** 16.06. 11:00.
- Live-Claude bestätigt: weekly 1 %. Der Sturz 67 %→1 % ist also real und
  server-seitig — ein Reset, der `resetsAt` nicht weiterbewegt hat.

Zwei Darstellungsfehler:

1. **Phantom-Interpolationslinie**: Chart.js verbindet auf der linearen
   Zeitachse den letzten Vor-Lücke-Punkt (67 %) direkt mit dem ersten
   Nach-Lücke-Punkt (~0 %) — eine gerade Abwärtslinie quer über das 22h-Loch,
   die wie ein realer Verbrauchsrückgang aussieht.
2. **Kein Weekly-Reset-Bewusstsein**: Die Serie markiert nur 5h-Resets
   (`fiveHourResets`). Ein Weekly-Reset ohne `resetsAt`-Wechsel ist unsichtbar.

**Nicht betroffen** (in der Analyse verifiziert, kein Handlungsbedarf):

- Der Lernzustand `window-ratio.json` ist sauber. Gap-Guard
  (`MAX_PAIR_AGE_MS`) + `clearTransients` verhindern Paare über die Lücke; der
  transiente `weekly=100`-Spike (13.06. 09:02/09:04) wird durch die Invariante
  `dWeekly ≤ dFive` korrekt verworfen. `lastWeekly:100` ist kosmetisch und
  selbstheilend.
- Kostenberechnung ($/Faktor) ist token-basiert (JSONL) und vom %-Reset
  unabhängig.

## Ziel

Diskontinuitäten in der Weekly-Zeitreihe **ehrlich** darstellen: die Linie an
Lücken und an server-seitigen Resets **unterbrechen**, statt zu interpolieren.
Vor-Reset-Daten (der Anstieg auf 67 %) bleiben links sichtbar.

Bewusst **nicht** im Scope (YAGNI): zusätzliche Reset-/Gap-Marker, schattierte
Lückenzonen, Rebasing auf ein Post-Reset-Sub-Fenster, Änderungen an Forecast/
Pace/Lernlogik.

## Ansatz

Erkennung lebt im **Serien-Builder** ([src/main/windowBudgetSeries.ts](../../../src/main/windowBudgetSeries.ts)),
wo die rohen Timestamps und die Reset-Logik (`resetsAtChanged`,
`RESET_DROP_PCT`) bereits sitzen und node-testbar sind. Der Renderer bleibt
dumm und nutzt nur Chart.js' `spanGaps: false`.

### Erkennungsregeln

Angewandt auf je zwei aufeinanderfolgende Punkte der **fertig bereinigten**
Serie (nach `removeSpikes`). Brich die Linie, wenn:

- **(a) Zeitlücke**: `Δt > GAP_THRESHOLD_MS` (App war aus).
- **(b) Weekly-Sturz**: `weeklyPct` fällt um `> WEEKLY_RESET_DROP_PCT`
  (server-seitiger Reset).

Begründung für (b) ohne `resetsAt`-Prüfung: Der Chart zeigt per
`windowStartMs`-Filter nur das aktuelle Weekly-Fenster. Darin ist `weeklyPct`
monoton steigend — ein echter Sturz kann nur der Anomalie-Reset sein.

**Reihenfolge kritisch:** Erkennung läuft **nach** `removeSpikes`, sonst
triggert der transiente `weekly=100→1`-Spike einen Falsch-Reset.

### Konstanten

- `GAP_THRESHOLD_MS = 60 * 60_000` (60 min ≙ 2 Buckets; robust gegen einen
  einzelnen verpassten Poll, fängt aber jede echte App-Pause).
- `WEEKLY_RESET_DROP_PCT = 15` (analog zum bestehenden `RESET_DROP_PCT`).

## Komponenten

### Datenstruktur

`WeeklySeriesPoint.weeklyPct` wird `number | null`. `null` = Bruch-Sentinel.

```ts
export interface WeeklySeriesPoint {
  t: string;
  weeklyPct: number | null; // null = Diskontinuität (Lücke oder Reset)
}
```

### Builder

Neue reine, exportierte Funktion:

```ts
export function insertBreaks(points: WeeklySeriesPoint[]): WeeklySeriesPoint[]
```

- Aufgerufen in `readWeeklySeries` direkt **nach** `removeSpikes`.
- Geht die sortierten Punkte paarweise durch; bei Bruchbedingung (a) oder (b)
  wird zwischen die beiden Punkte ein `{ t, weeklyPct: null }`-Sentinel
  eingefügt (`t` = Zeitpunkt zwischen den beiden, z. B. arithmetisches Mittel).
- Operiert nur auf Punkten mit nicht-`null` `weeklyPct` (eingefügte Sentinels
  werden nicht erneut verglichen).
- `fiveHourResets` bleibt unverändert.

### Renderer

[src/renderer/shared/charts.js](../../../src/renderer/shared/charts.js),
`QB.weeklyBudgetChart`:

- Mapping bleibt `y: p.weeklyPct` (jetzt evtl. `null`).
- `spanGaps: false` explizit im Weekly-Dataset setzen → Chart.js bricht Linie
  und Flächenfüllung an `null`-Punkten.
- Die Prognose-Linie hängt am `last`-Punkt der History; sicherstellen, dass
  `last` ein Punkt mit nicht-`null` `weeklyPct` ist (letzten realen Punkt
  wählen, nicht ein Sentinel).

## Datenfluss

`readWeeklySeries` → Buckets → `removeSpikes` → **`insertBreaks`** → `points`
(mit `null`-Sentinels) → IPC → `QB.weeklyBudgetChart` → Chart.js mit
`spanGaps: false`.

## Tests

[tests/windowBudgetSeries.test.ts](../../../tests/windowBudgetSeries.test.ts) —
`insertBreaks` als reine Funktion per TDD:

- (a) Zeitlücke > 60 min → Sentinel eingefügt.
- (b) Weekly-Sturz > 15 % → Sentinel eingefügt.
- (c) monotone, dichte Daten → kein Bruch.
- (d) isolierter Spike → kein Falsch-Bruch (verifiziert Reihenfolge nach
  `removeSpikes`).
- (e) einzelner verpasster Poll (Δt < 60 min) → kein Bruch.
- (f) leere / einelementige Serie → unverändert.

## Risiken

- Schwellen sind heuristisch. 60 min / 15 % sind als Konstanten leicht
  anpassbar, falls sich in der Praxis Falsch-Brüche zeigen.
- Chart.js `spanGaps`-Default ist bereits `false`; explizites Setzen schützt
  gegen künftige Konfig-Drift.

# Design: Bonus-Reset-Erkennung & 5h-Fenster-Historie

Datum: 2026-06-14
Status: Entwurf zur Freigabe

## Kontext & Problem

Claude (und Codex) haben zwei gekoppelte Quota-Fenster: ein rollendes 5h-Fenster
(`fiveHour`) und ein 7d-Fenster (`weekly`). QuotaBar lernt aus aufeinanderfolgenden
Snapshots das Verhältnis `windowsPerWeek = Σ Δ5h% / Σ Δweekly%` und zeigt daraus
abgeleitet „5h-Fenster: X verbraucht / Y übrig" ([windowRatio.ts:159-165](../../../src/usage/windowRatio.ts#L159)).
Die verbrauchten Fenster werden also **aus dem Weekly-Prozentsatz abgeleitet**, nicht
aus tatsächlich durchlaufenen 5h-Fenstern.

**Beobachteter Vorfall:** Ein außerplanmäßiger Reset hat 5h% **und** Weekly% auf ~0
gesetzt, während der 7d-`resetsAt`-Zeitpunkt **unverändert** blieb. Effekt: Das
Weekly-Budget wurde faktisch erneuert (ein zusätzlicher voller Zyklus bis zum
regulären Reset) — diese Woche stehen „Bonus"-5h-Fenster zur Verfügung. Das aktuelle
Modell verwirft solche Mess-Paare (Rollover-Erkennung, [windowRatio.ts:105](../../../src/usage/windowRatio.ts#L105))
und stellt den Bonus nirgends dar.

## Ziele

1. **Live-Tab:** Außerplanmäßige Resets automatisch erkennen und als Badge sichtbar
   machen (inkl. grober Schätzung der Bonus-Fenster). Die bestehende
   verbraucht/übrig-Berechnung bleibt unangetastet (risikoarm).
2. **Analytics-Tab:** Langfristige Historie „genutzte vs. maximale 5h-Fenster pro
   7d-Fenster" als Auslastungs-Chart, für beide Anbieter.

Nicht-Ziele: Umbau der gelernten `windowsPerWeek`-Logik; serverseitige/echte
Quota-Abfrage zusätzlicher Felder.

## Getroffene Entscheidungen (aus Brainstorming)

| Thema | Entscheidung |
|-------|-------------|
| Vorfall-Mechanik | 5h **und** Weekly fielen, 7d-Reset-Zeitpunkt blieb → Budget effektiv erneuert |
| Live-Darstellung | Bonus sichtbar machen (Badge), Zahlen-Logik nicht umbauen |
| Reset-Erkennung | Automatisch |
| Badge-Detail | Qualitativ + grobe Schätzung „≈ +X 5h-Fenster" |
| Chart-Max-Definition | Budgetbasiert (`windowsPerWeek`) = „prognostiziert mögliche Fenster" |
| Chart-Layout | Pro Anbieter ein Block: genutzte Fenster (Balken) + mögliche Fenster (Linie) auf Fenster-Achse, Auslastung % als Label/Tooltip |
| „Genutzt"-Definition | Nennenswerte Aktivität: 5h-Fenster mit >5 % des 5h-Limits |
| Daten-Historie | Hybrid: einmaliger Seed aus Live-Logs + Forward-Persistenz |
| Anbieter | Claude **und** Codex (beide haben primary/secondary-Fenster) |
| Planwechsel | als vertikale Marker im Chart, gleiche Mechanik wie History/Analytics |
| Leitfrage | „Wird der aktuelle Plan gut genutzt?" → Auslastung sichtbar machen |

## Teil A — Bonus-Reset-Erkennung & Live-Badge

### A1. Erkennung (`src/usage/bonusResetDetection.ts`, neu)

Reine Funktion, vergleicht zwei aufeinanderfolgende Weekly-Fenster-Beobachtungen:

```
isBonusReset(prev, next):
  weeklyDropped   = prev.usedPercent > BONUS_PREV_MIN (20) && next.usedPercent < BONUS_NEXT_MAX (5)
  resetNotAdvanced = |next.resetsAt - prev.resetsAt| < BONUS_RESET_ADVANCE_MIN (~6 Tage)
  return weeklyDropped && resetNotAdvanced
```

Begründung: Ein **normaler** Weekly-Reset senkt `usedPercent` UND schiebt `resetsAt`
um ~7 d nach vorn. Bleibt `resetsAt` (annähernd) stehen, während der Prozentsatz
fällt, war es ein außerplanmäßiger Reset.

### A2. Zustand & Durchreichen

- Im `RefreshLoop` wird `isBonusReset` bei jedem Refresh auf das vorige/aktuelle
  Weekly-Fenster angewandt.
- Erkennung markiert die **laufende 7d-Periode** (Schlüssel = aktueller
  Weekly-`resetsAt`) als Bonus. Persistiert transient in `windowRatio.json` pro
  Provider: `bonusForResetsAt: string | null`. Sobald `resetsAt` regulär
  weiterspringt, wird der Marker verworfen.
- `windowBudget` (Teil des `UsageSnapshot`) erhält ein optionales Feld:
  `bonus?: { active: boolean; estimatedExtraWindows: number }`.

### A3. Grobe Bonus-Schätzung

```
remainingHours      = (weeklyResetsAt - now) / 3600
extraByTime         = remainingHours / 5         # so viele 5h-Fenster passen noch rein
estimatedExtra      = min(windowsPerWeek, extraByTime)   # gedeckelt aufs Budget
```

Interpretation: „Bis zum regulären Reset stehen dir noch ≈ N zusätzliche
5h-Fenster zur Verfügung." Bewusst grob; im Tooltip als Schätzung gekennzeichnet.

### A4. Darstellung ([live.js](../../../src/renderer/tabs/live.js))

Badge nahe der „5h-Fenster"-Zeile (`windowBudgetRowHtml`):

> ⚡ **Bonus-Woche** · ≈ +N 5h-Fenster — außerplanmäßiger Reset, Budget bis zum
> regulären 7d-Reset effektiv erneuert.

Nur sichtbar, wenn `windowBudget.bonus?.active`. Tooltip erklärt Schätzcharakter.

## Teil B — Analytics-Chart „5h-Fenster pro Woche"

### B1. Datenmodell (`windowHistory.json`, neu; `src/usage/windowHistoryStore.ts`)

```ts
interface WindowHistoryEntry {
  provider: string;       // "claude" | "codex"
  weekStart: string;      // ISO; Beginn der 7d-Periode (= vorheriger Reset)
  weekEnd: string;        // ISO; Ende (= resetsAt der Periode)
  usedWindows: number;    // Anzahl 5h-Fenster mit >5 % Aktivität
  maxWindows: number;     // windowsPerWeek zum Zeitpunkt der Periode (budgetbasiert)
  bonus: boolean;         // außerplanmäßiger Reset in dieser Periode erkannt
}
interface WindowHistoryFile { version: 1; entries: WindowHistoryEntry[]; }
```

### B2. Befüllung (Hybrid)

- **Seed** (`src/main/windowHistorySeeder.ts`, analog [windowRatioSeeder.ts](../../../src/main/windowRatioSeeder.ts)):
  Live-Logs chronologisch lesen, in 7d-Perioden (per Weekly-`resetsAt`) segmentieren;
  je Periode die distinkten 5h-Fenster (per 5h-`resetsAt`) mit Spitzen-`usedPercent`
  > 5 % zählen → `usedWindows`. `maxWindows` aus dem zu dem Zeitpunkt gelernten
  Ratio. Einmalig beim ersten Start (Flag wie `seededThrough`).
- **Forward:** Beim erkannten regulären 7d-Reset (im `RefreshLoop`) die soeben
  abgeschlossene Periode als `WindowHistoryEntry` anhängen.

### B3. IPC & Chart

- Neuer IPC-Kanal `windowHistory:get` → liefert `{ entries: WindowHistoryEntry[];
  planChanges: PlanChangePoint[] }` (beide Anbieter). `planChanges` wie in
  `reports:get`/`analytics:get` aus den Plan-Perioden abgeleitet.
- Neue Sektion im Analytics-Tab „5H-FENSTER PRO WOCHE", **ein Block je Anbieter**
  (Claude oben, Codex darunter), damit Balken + Linie lesbar bleiben:
  - **Kombi-Chart** (Bar + Line, eine y-Achse = Anzahl 5h-Fenster), x = abgeschlossene
    7d-Fenster (Wochen):
    - **Balken** = genutzte Fenster (`usedWindows`, ≥5 %-Aktivität), Anbieterfarbe.
    - **Linie** = prognostiziert mögliche Fenster (`maxWindows` = gelerntes
      `windowsPerWeek` der Periode). Zeitvariabel (Linie, nicht konstante Referenz),
      weil sich das Budget z. B. bei Planwechsel ändert.
  - **Auslastung** (`usedWindows / maxWindows × 100`) pro Woche:
    - als Wert im **Tooltip** („genutzt X von ≈ Y · Z % Auslastung"),
    - und als **Balkenfarbe/-deckkraft** kodiert (niedrig = Plan unterausgelastet,
      hoch/▶100 % = voll genutzt bzw. Bonus-Woche).
  - **Planwechsel-Marker:** vertikale Linien an den betroffenen Wochen, gleiche
    Mechanik wie in den übrigen Charts (`QB.charts.mapChangesToIndex` +
    `planChangePlugin`).
  - **Bonus-Wochen:** am Balken markiert (⚡-Marker / abweichende Deckkraft); können
    Auslastung > 100 % erzeugen — y-Achse nicht hart auf `maxWindows` deckeln.
  - Leitfrage „Plan gut genutzt?": niedrige Balken weit unter der Linie über mehrere
    Wochen = Plan überdimensioniert; Balken nahe/über der Linie = gut ausgereizt.

### B4. Wiederverwendung

- `QB.charts.planChangePlugin` und `QB.charts.mapChangesToIndex`
  ([charts.js](../../../src/renderer/shared/charts.js)) werden für die
  Planwechsel-Marker wiederverwendet.
- Für das Bar+Line-Kombi-Chart entweder `createStackedBar` erweitern oder ein
  schlankes Mixed-Chart (Chart.js `type: 'bar'` mit einem Linien-Dataset) ergänzen.
- Aggregation/Rendering rein im Renderer aus den gelieferten Entries; ein Block je
  Anbieter, leere Datenlage je Anbieter sauber abfangen (Hinweis statt leerem Chart).

## Komponenten-Übersicht

| Unit | Zweck | Abhängigkeiten |
|------|-------|----------------|
| `bonusResetDetection.ts` | reine Erkennung außerplanmäßiger Resets | UsageWindow |
| `windowRatio.ts` (Erw.) | transienter Bonus-Marker pro Periode | bonusResetDetection |
| `windowHistoryStore.ts` | Laden/Speichern `windowHistory.json` | fs, paths |
| `windowHistorySeeder.ts` | Seed aus Live-Logs | backfill-/log-reader |
| `RefreshLoop` (Erw.) | Bonus-Marker setzen, Forward-Persistenz | obige |
| `live.js` (Erw.) | Bonus-Badge | windowBudget.bonus |
| `analytics.js` (Erw.) | Bar+Line-Chart je Anbieter, Auslastung + Planwechsel-Marker | windowHistory:get, charts.js |

## Tests

- `bonusResetDetection`: normaler Reset (kein Bonus), außerplanmäßiger Reset (Bonus),
  reiner Verbrauchsanstieg (kein Reset), Grenzwerte der Schwellen.
- Bonus-Schätzung: Deckelung auf `windowsPerWeek`, Zeitberechnung.
- `windowHistorySeeder`: Segmentierung in 7d-Perioden, 5h-Fenster-Zählung mit
  >5 %-Schwelle, Bonus-Markierung, Mehr-Anbieter.
- `windowHistoryStore`: Round-Trip, Versionierung, korrupte Datei → leer.

## Offene Risiken

- **Log-Abdeckung:** Seed kann nur so weit zurück wie die Live-Logs reichen; frühe
  Wochen ggf. unvollständig. Im Chart als solche kenntlich (Hinweis bei dünner Datenlage).
- **5h-Fenster-Zählung:** beruht auf `resetsAt`-Wechseln in den Logs; bei
  Log-Lücken (App aus) können einzelne 5h-Fenster fehlen → `usedWindows` ist
  konservativ (eher Unterschätzung).
- **Codex-Fenster:** primary/secondary müssen nicht exakt 5h/7d sein; das Modell
  behandelt sie generisch als „kurzes/langes Fenster".

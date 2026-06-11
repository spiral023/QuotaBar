# Design: 5h-Fenster-Budget & Weekly-Prognose

**Datum:** 2026-06-11
**Status:** Genehmigt

## Ziel

QuotaBar zeigt pro Provider (Claude, Codex), wie viele volle 5h-Fenster bei 100 % Auslastung in ein Weekly-Fenster passen — und daraus abgeleitet: wie viele 5h-Fenster im aktuellen Weekly-Fenster bereits verbraucht sind, wie viele übrig bleiben, ein Verlaufsgraph der kumulierten Weekly-Auslastung und eine Prognose, wann das Weekly-Limit erreicht wird.

**Beispiel:** „1,9 von 3,1 Fenstern verbraucht · 1,2 übrig · Limit erreicht ~Fr 14:00“

## Empirische Grundlage

Die Live-Debug-Logs (`~/.quotabar-win/debug/YYYY-MM-DD.jsonl`, Snapshot-Events bei jedem Poll-Zyklus) enthalten `usedPercent` für `fiveHour` und `weekly` pro Provider. Eine Probeauswertung über ~2,5 Wochen ergab:

| Provider | Σ Δ5h % | Σ ΔWeekly % | Volle 5h-Fenster pro Weekly |
|---|---|---|---|
| Codex | 1123 | 174 | ≈ 6,5–7 |
| Claude | 2760 | 892 | ≈ 3,1 |

Der Codex-Wert deckt sich mit Community-Erfahrungswerten (~7). Die Berechnung ist damit validiert.

## Architektur

### 1. Kernberechnung — `WindowRatioTracker` (Hybrid-Ansatz)

Pro Provider akkumuliert ein Lerner bei jedem erfolgreichen Poll-Zyklus die ko-okkurrierenden Prozent-Deltas beider Fenster:

```
r = Σ ΔWeekly% / Σ Δ5h%
fensterProWoche = 1 / r
```

**Paar-Filter** (Paar = zwei aufeinanderfolgende Snapshots desselben Providers):

- `Δ5h ≤ 0` → verwerfen (5h-Reset oder idle)
- `ΔWeekly < 0` → verwerfen (Weekly-Reset)
- `resetsAt` des 5h-Fensters hat sich geändert → verwerfen (Rollover zwischen zwei Polls)
- Weekly ≥ 99,5 % beim ersten Snapshot des Paares → verwerfen (gesättigt, Weekly kann nicht wachsen)

**Belastbarkeit:** Das Verhältnis gilt erst ab `Σ Δ5h ≥ 200 %` (entspricht zwei vollen 5h-Fenstern an Beobachtung) als belastbar. Vorher zeigt die UI „lernt noch… (X % gesammelt)“.

**Seeding (einmalig):** Fehlt der persistierte State, liest ein Seeder die vorhandenen Live-Debug-Logs (Snapshot-Events) und füttert denselben Akkumulator. Seeder und Live-Lerner teilen sich die pure Akkumulator-Funktion.

**Drift-Schutz:**

- `planType`-Wechsel eines Providers → State dieses Providers zurücksetzen (neue Limits = neues Verhältnis)
- Exponentielles Vergessen: überschreitet `Σ Δ5h` den Deckel 3000 %, werden beide Summen halbiert — das Verhältnis passt sich an, falls der Anbieter Limits ändert

**Persistenz:** `~/.quotabar-win/window-ratio.json`, geschrieben nach jedem Refresh. Struktur pro Provider: `{ sumFivePct, sumWeeklyPct, pairCount, lastFive, lastWeekly, lastFiveResetsAt, lastPlanType, seededThrough }`.

### 2. Kennzahlen (rein abgeleitet)

- verbraucht = `weekly% / 100 × fensterProWoche`
- übrig = `(100 − weekly%) / 100 × fensterProWoche`

### 3. Prognose — drei Komponenten

| Komponente | Quelle | Rolle |
|---|---|---|
| Wochenprofil | Backfill-Tagessummen (`tokens.daySummary`) der letzten 4 Wochen → durchschnittliche Token pro Wochentag | **Primär**, sobald ≥ 2 Wochen Historie vorhanden |
| Linear | vorhandene `computeLinearPace` auf dem Weekly-Fenster | Fallback bei zu wenig Historie |
| Aktuelle Burn-Rate | vorhandenes `burnRatePctPerHour` (BurnRateTracker) | Sekundär: „bei aktuellem Tempo: ~Do 22:00“ |

**Wochenprofil-Rechnung:** Durchschnittliche Token pro Wochentag aus den letzten 4 Wochen. Skalierung auf Prozent über den aktuellen Wochenverbrauch (`percentProToken = weekly% / TokenImAktuellenFenster`), dann kumulative Fortschreibung ab jetzt bis zum 100 %-Schnittpunkt. Damit fließen Nutzungsmuster (z. B. keine Wochenend-Nutzung) korrekt ein. Die Token-Gewichtung ist eine Näherung (Limits sind modellgewichtet), als zeitliche Form aber ausreichend.

Erreicht keine Projektion 100 % vor dem Weekly-Reset → Anzeige „reicht bis zum Reset“.

### 4. UI (Live-Tab, pro Provider-Karte)

**Immer sichtbar — Budget-Leiste:** Unter dem Weekly-Balken eine segmentierte Leiste: das Weekly-Budget eingeteilt in 5h-Fenster-Äquivalente (gefüllt = verbraucht, hell = laufendes Fenster, gestrichelt = frei). Darunter die Zeile „1,9 verbraucht · 1,2 übrig“.

**Aufklappbar — „Fenster-Budget“** (analog zu „Token Details“): Chart.js-Liniengraph (vendored `chart.min.js`):

- X-Achse: aktuelles Weekly-Fenster (Start = `resetsAt − 7 d` bis `resetsAt`)
- Linie: kumulierte Weekly-% über die Zeit
- Vertikale Marker: 5h-Fenster-Resets
- Gestrichelte Projektion: Primär-Prognose bis zum 100 %-Schnittpunkt
- Darunter beide Prognose-Termine als Text (primär + Burn-Rate-basiert)

**Graph-Datenquelle:** Snapshot-Events der Live-Logs der letzten 7 Tage, gelesen im bestehenden `analyticsWorker` (nicht im Main-Prozess), downsampled auf ~30-Minuten-Punkte.

### 5. Fehlerfälle

| Fall | Verhalten |
|---|---|
| Verhältnis noch nicht belastbar | „lernt noch… (X % gesammelt)“ statt Zahlen |
| Debug-Logging deaktiviert | Kennzahlen + Leiste funktionieren weiter (Live-Lerner); nur der Graph zeigt einen Hinweis |
| Provider ohne Weekly-Fenster oder Status ≠ ok | Sektion ausgeblendet |
| Ganzzahl-Prozente der APIs | unkritisch durch Summen-Aggregation |
| Weekly bei 100 % gesättigt | Paare werden verworfen, Kennzahlen zeigen 0 übrig |
| `resetsAt` fehlt im Snapshot (z. B. Claude bei 0 % Nutzung) | Rollover-Filter greift nur, wenn beide Werte vorhanden sind (Δ-Filter wirken weiter); Graph-X-Achse fällt auf „letzte 7 Tage“ zurück |

### 6. Module

| Datei | Zweck |
|---|---|
| `src/usage/windowRatio.ts` | Purer Akkumulator + Kapazitätsrechnung |
| `src/usage/windowRatioStore.ts` | Laden/Speichern `window-ratio.json` |
| `src/main/windowRatioSeeder.ts` | Einmal-Seed aus Debug-Logs |
| `src/main/weeklyForecast.ts` | Prognose-Kombination Profil/Linear/Burn-Rate |
| `src/config/paths.ts` | + `getWindowRatioPath()` |
| `src/main/main.ts` / Refresh-Pfad | Tracker-Anbindung pro Refresh |
| IPC `windowBudget:get` | Kennzahlen, Prognose, Graph-Serie ans Dashboard |
| `src/renderer/index.html` | Budget-Leiste + Aufklapp-Graph in der Provider-Karte |

### 7. Tests (TDD, unter `tests/`)

- `windowRatio`: Delta-Akkumulation, Reset-Filter (5h/Weekly/resetsAt-Wechsel), Sättigungs-Filter, Vergessen-Deckel, planType-Reset, Belastbarkeits-Schwelle
- `windowRatioSeeder`: Parsing von JSONL-Fixtures, Mehrtages-Seed, defekte Zeilen
- `weeklyForecast`: 100 %-Schnittpunkt (Profil + linear), Fallback-Kaskade, „reicht bis Reset“, Burn-Rate-Sekundärprognose
- `windowRatioStore`: Roundtrip, defekte Datei → leerer State

## Entscheidungs-Log

- **Platzierung:** Live-Tab pro Provider-Karte (Option A) — vom User gewählt
- **Graph:** Kumulative Linie mit Prognose (aufklappbar) + Budget-Leiste (immer sichtbar) — Kombination A+C
- **Prognose:** Beide Termine anzeigen, Wochenprofil aus mehrwöchiger Historie als Primärquelle — User-Wunsch
- **Berechnungs-Backend:** Hybrid (persistierter Live-Lerner, einmalig aus Debug-Logs geseedet) — Option 3

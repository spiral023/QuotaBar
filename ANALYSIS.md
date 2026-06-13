# QuotaBar Analysebericht

Erstanalyse: 2026-06-13  
Letzte Aktualisierung: 2026-06-13 (nach erstem Fix-Durchlauf)

## Änderungen seit Erstanalyse

Am 2026-06-13 wurden die dringendsten Befunde direkt behoben (10 Commits auf `main`):

| Commit | Befund | Status |
| --- | --- | --- |
| `0004f6f` | PricingEngine lud Settings von Disk statt injizierte zu nutzen (Settings-Drift) | ✅ behoben |
| `f12eb26` | analyticsWorker übergab rohes `windowDays`-Sentinel an `buildDailyBuckets` | ✅ behoben |
| `3bdf261` | 43 kompilierte `.test.js`-Duplikate, Vitest lud beides | ✅ entfernt + Guard |
| `8a6b92d` | 3 veraltete `.ts`-Test-Erwartungen (Benchmarks, Notification-Defaults) | ✅ angeglichen |
| `754ed59` | XSS im Models-Tab (Modellnamen/Fehler unescaped in `innerHTML`) | ✅ via `QB.esc` |
| `c63975b` | README-Badge nannte Electron 30 statt 42 | ✅ korrigiert |
| `4ba4384` | Doppelter `describe("source: backfill")`-Block in reports.test.ts | ✅ entfernt |
| `2423481` | Unbekannte Modelle still mit $0 verschluckt (Kosten zu niedrig) | ✅ `missingPricingModels` + UI-Hinweis |
| `c22ad7e` | Forecast ohne Vertrauensgrad (Profil vs. dünn linear nicht unterscheidbar) | ✅ `confidence`/`reason` + UI |
| `e0f20ba` | Analytics-Zeitsemantik UTC vs. lokal gemischt (falscher Tag/Stunde) | ✅ auf Lokalzeit vereinheitlicht |

Verifikation nach Fixes: **`npm test` grün (466 Tests, 54 Dateien)**, `npm run build` grün; Analytics-Zeit-Tests in mehreren Zeitzonen deterministisch.

Damit sind die beiden Berechnungsfehler, der Testpipeline-Blocker, das Models-Tab-XSS sowie drei praxisnahe Transparenz-/Korrektheits-Verbesserungen (nicht eingepreiste Modelle, Forecast-Confidence, Zeitsemantik) erledigt. Die Bewertungen unten sind entsprechend angehoben; verbleibende Punkte sind klar als offen markiert.

## Kurzfazit

QuotaBar ist technisch und fachlich deutlich weiter als ein typisches MVP: Die App hat getrennte Module für Provider, Auth, Pricing, Reports, Analytics, Window-Ratio-Lernen, Forecasts und Debug-Backfill. Besonders positiv ist, dass viele komplizierte Berechnungen nicht nur implementiert, sondern mit Tests gegen bekannte Randfälle abgesichert sind.

Der zuvor größte Qualitätsbruch — rote Testpipeline plus Settings-Drift in der `PricingEngine` — ist behoben: `npm test` ist grün, die Engine ist eine reine Funktion ihrer injizierten Settings (Produktion injiziert weiterhin Live-Settings über einen Provider), und die `.test.js`-Altlast ist entfernt. Auch das Models-Tab-XSS ist geschlossen.

Der jetzt dominierende offene Punkt ist die **Renderer-Härtung**: `nodeIntegration: true` und `contextIsolation: false` gelten weiterhin für Details- und Onboarding-Fenster. Solange das so ist, bleibt jeder verbleibende unescaped-Pfad potenziell RCE-relevant. Daneben fehlen weiterhin CI und Lint, und einige Analyse-Ergebnisse tragen noch keine Quellen-/Confidence-Metadaten.

Gesamtbewertung: **2.7 - befriedigend** (vorher 3.2)  
Bewertung Business-Logik und Berechnungen: **2.4 - gut bis befriedigend** (vorher 2.8)

## Gesamt-Scorecard

| Kategorie | Note | Δ | Kernaussage |
| --- | ---: | :---: | --- |
| Architektur und Modulgrenzen | 2.5 | – | Gute fachliche Schichten, aber `DetailsWindowController` ist zu breit. |
| Codequalität und Wartbarkeit | 3.0 | – | Solider TypeScript-Core, Renderer/HTML wächst stark und ist nicht typechecked. |
| Testqualität und Verifikation | 2.0 | ▲ 4.5 | `npm test` jetzt grün; Duplikate weg. Es fehlen weiterhin CI und Lint. |
| Sicherheit und Robustheit | 3.5 | ▲ 4.0 | Models-Tab-XSS geschlossen; `nodeIntegration: true` bleibt der dominante Hebel. |
| Performance und Effizienz | 2.5 | – | Gute Worker-/Cache-Ansätze, kleinere Skalierungsrisiken bei großen Logs. |
| DX, Tooling und Delivery | 3.3 | ▲ 4.0 | Grüne Testpipeline; weiterhin kein Lint, keine CI, README-Versions­lücke. |
| Dokumentation und Operabilität | 2.0 | – | README und TESTING sind stark, kleine Versions- und Automationslücken. |

## Business-Logik-Scorecard

| Bereich | Note | Δ | Kernaussage |
| --- | ---: | :---: | --- |
| Live-Fenster und Provider-Normalisierung | 2.5 | – | Defensiv normalisiert, aber abhängig von inoffiziellen Provider-Endpunkten. |
| Pace, Burn-Rate und Safety-Gap | 2.5 | – | Verständliche lineare Modelle, gute Grenzen; fachlich einfache Annahmen. |
| Window-Budget-Lernen 5h vs. Weekly | 2.0 | – | Sehr gute Filter gegen Jitter, Resets, Gaps, Planwechsel und Spikes. |
| Weekly Forecast | 3.0 | – | Nützliches Hybridmodell, aber Profilbasis ist grob und stark datenabhängig. |
| Token- und Kostenberechnung | 2.5 | ▲ 3.5 | Settings-Drift behoben, Pricing-Tests grün. Preisquellen-Metadaten fehlen noch. |
| Reports und Backfill | 2.5 | – | Saubere Aggregationen und Backfill-Pfad, aber doppelte Live/Backfill-Semantik bleibt riskant. |
| Analytics und KPI-Logik | 2.7 | ▲ 3.0 | `windowDays`-Bug behoben; UTC/Local-Mix und Proxy-Metriken bleiben. |
| Datenqualität und Fehlersemantik | 3.0 | – | Viele Schutzmechanismen, aber fehlende Confidence-/Freshness-Signale in manchen Analysen. |

## Detailbewertung Business-Logik

### Live-Fenster und Provider-Normalisierung - Note 2.5

Evidenz:

- Codex normalisiert `primary_window`, `secondary_window`, Prozentwerte, Reset-Zeitpunkte und Credits defensiv in `src/providers/codex.ts`.
- Claude normalisiert `fiveHour`, `sevenDay`, `extraUsage` und behandelt 401/403/429 inklusive RateLimit in `src/providers/claude.ts`.
- Beide Live-Provider nutzen Timeouts über `AbortSignal.timeout`.
- Die Live-Fenster hängen bewusst an inoffiziellen Endpunkten (`chatgpt.com/backend-api/wham/usage`, `api.anthropic.com/api/oauth/usage`), was fachlich nicht vollständig kontrollierbar ist.

Bewertung:

Die Normalisierung ist zweckmäßig und defensiv. Für eine Tray-App, die fremde Quota-Fenster beobachtet, ist das gut. Der nicht vollständig beherrschbare Teil ist die Quellsemantik: Wenn Provider das Schema, die Rundung oder die Bedeutung der Fenster ändern, kann QuotaBar nur heuristisch reagieren.

Empfehlungen:

- **Risk-Reducer, M, hoher Impact:** Pro Provider eine kleine Schema-/Semantik-Version in Debug-Snapshots speichern, z. B. welche Felder vorhanden waren und ob `used_percent` oder `utilization` genutzt wurde.
- **M, mittlerer Impact:** Live-Fenster mit Confidence-Level versehen: `exact`, `inferred`, `partial`, `stale`.
- **S, mittlerer Impact:** Bei Schema-Änderungen sichtbarer warnen, nicht nur intern als Error/Stale behandeln.

### Pace, Burn-Rate und Safety-Gap - Note 2.5

Evidenz:

- `computeLinearPace` berechnet erwarteten Verbrauch linear aus Fensterdauer und Reset-Zeit in `src/usage/usagePace.ts`.
- Stage-Grenzen sind klar und stabil: `onTrack` bis 2 Prozentpunkte, danach `slightlyAhead`, `ahead`, `farAhead`.
- `computeSafetyGap` gibt die verbleibende Zeit bis Reset oder bis zur Erschöpfung zurück.
- `BurnRateTracker` nutzt maximal 8 Punkte, rechnet auf Prozentpunkte pro Stunde hoch und resetet bei deutlichem Verbrauchseinbruch.

Bewertung:

Die Logik ist einfach, transparent und für Live-Feedback gut geeignet. Sie ist aber kein echtes Vorhersagemodell: Sie nimmt linearen Verbrauch an, obwohl Entwicklernutzung oft blockweise passiert. Für Warnungen ist das ausreichend, für präzise Prognosen nur begrenzt.

Empfehlungen:

- **S, mittlerer Impact:** UI/Report sprachlich klarer zwischen "lineare Hochrechnung" und "Prognose aus Nutzungsprofil" unterscheiden.
- **M, hoher Impact:** Pace-Stages mit Confidence aus Datenmenge und Zeitspanne kombinieren.
- **S, mittlerer Impact:** Tests für Grenzwerte rund um Stage-Schwellen und Reset-Zeitpunkte ergänzen.

### Window-Budget-Lernen 5h vs. Weekly - Note 2.0

Evidenz:

- `recordObservation` akzeptiert nur positive, ko-okkurrierende Deltas, verwirft Weekly-Resets, 5h-Rollover, gesättigte Weekly-Werte, große Zeitlücken und physikalisch unmögliche `deltaWeekly > deltaFive`.
- Reset-Jitter wird mit `RESETS_AT_TOLERANCE_MS = 60_000` abgefangen.
- Lernphase verlangt mindestens `MIN_SAMPLE_FIVE_PCT = 200` und `MIN_SAMPLE_WEEKLY_PCT = 5`.
- Plan-Typen werden über `ratioKey(provider, planType)` getrennt.
- Tests decken Jitter, Resets, Planwechsel, Gaps, Spikes, Decay und Lernschwellen ab.

Bewertung:

Das ist einer der stärksten fachlichen Teile der App. Die Logik zeigt, dass reale API-Artefakte verstanden wurden: Microsecond-Jitter, rollierende Reset-Zeiten, Account-/Planwechsel, Weekly-Spikes und App-Pausen werden explizit behandelt. Die Note ist nicht 1, weil es weiterhin eine gelernte Heuristik ohne externe Ground Truth ist.

Empfehlungen:

- **S, hoher Impact:** Im UI die Lernbasis anzeigen: Sample-Summe, Pair-Count, PlanType und letztes Update.
- **M, mittlerer Impact:** Outlier-/Confidence-Metrik speichern, z. B. verworfene Paare nach Grund.
- **M, mittlerer Impact:** Verhältnis nicht nur als Punktwert, sondern mit Bandbreite anzeigen, sobald genug Daten vorhanden sind.

### Weekly Forecast - Note 3.0

Evidenz:

- `buildWeeklyProfile` nutzt 28 Tage und mittelt pro Wochentag über 4 Vorkommen.
- `computeWeeklyForecast` wählt primär Profilprognose, wenn mindestens 2 Wochen Daten vorhanden sind; sonst fällt es auf lineare Pace zurück.
- Burn-Rate wird zusätzlich als sekundäre Prognose berechnet.
- `analyticsWorker` kombiniert Backfill-Tage, Live-Weekly-Reset und Debug-Serien zur Window-Budget-Datenbasis.

Bewertung:

Der Forecast ist nützlich, aber eher ein plausibler Indikator als eine belastbare Vorhersage. Die Annahme "Wochentagsdurchschnitt / 24 Stunden" glättet echte Arbeitsblöcke stark. Positiv ist der Fallback auf lineare Pace und die klare Mindestdatenregel.

Empfehlungen:

- **M, hoher Impact:** Profil nicht nur pro Wochentag, sondern optional pro Wochentag+Stunde lernen.
- ✅ Forecast-Result um `confidence` (high/medium/none) und `reason` (`profile`/`linear`/`insufficient-data`) erweitert und im Live-Tab angezeigt (`c22ad7e`).
- **M, mittlerer Impact:** Backfill-Tagesdaten im aktuellen Weekly-Fenster nicht als einzige Tokenbasis nutzen, wenn aktuelle Live-Logs seit Tagesbeginn noch nicht backfilled sind.

### Token- und Kostenberechnung - Note 2.5 (vorher 3.5)

Evidenz:

- `calculateCostFromTokens` trennt Input, Output, Cache-Creation, Cache-Read und unterstützt Tierpreise über 200k Tokens.
- Codex-Kosten trennen uncached input und cached input, inklusive Fast-Multiplier.
- Claude-Kosten werden pro Modell berechnet, offizielle `costUSD`-Werte können im Auto-Modus übernommen werden.
- `LiteLLMFetcher` cached Preise und fällt auf Fallback-Preise zurück.
- ✅ **Behoben (`0004f6f`):** `PricingEngine.calculateClaudeFactor`/`calculateCodexFactor` luden zuvor `loadSettings()` von Disk und ignorierten die injizierten Settings. Jetzt über `resolveSettings()` aufgelöst: Ohne Provider (Tests) reine `this.settings`; Produktion injiziert in `main.ts` einen `() => loadSettings()`-Provider, sodass Laufzeit-`costWindow`-Wechsel weiterhin greifen. Die Inkonsistenz im Codex-"keine Logs"-Zweig (zuvor `this.settings`, sonst `currentSettings`) ist mitbereinigt.
- ✅ Die zuvor roten Pricing-Tests (7d/30d-Fenster, Codex-Subscription-Kosten, Claude-Multimodel = 0) sind grün.

Bewertung:

Das Kostenmodell ist fachlich gut angelegt; der kritische Konsistenzfehler ist beseitigt und durch Tests abgesichert. Offen bleibt die Transparenz der Preisherkunft.

Empfehlungen (offen):

- **M, mittlerer Impact:** Preisquellen im Result markieren: `official-cost`, `litellm`, `fallback`, `missing-pricing`. (= Roadmap #4)
- ✅ Unbekannte Modelle werden nicht mehr still mit $0 verschluckt: `missingPricingModels` im `CostFactorResult` + „⚠ nicht eingepreist"-Hinweis im Live-Tab.

### Reports und Backfill - Note 2.5

Evidenz:

- `generateUsageReport` unterstützt Daily, Weekly, Monthly, Session, Providerfilter, Projektfilter, Instanzen, Kostenmodi und Backfill-Quelle.
- Backfill schreibt Tageszusammenfassungen mit per-model Kosten in `debugBackfill`.
- `readBackfillDayRecords` normalisiert Codex cached input so, dass Input als uncached dargestellt wird.
- Tests decken Daily/Weekly/Session, Backfill-Fallback, Model-Breakdowns, Cost Modes und Filter ab.
- Das Testfile `reports.test.ts` enthält weiterhin zwei `describe("source: backfill")`-Blöcke mit sehr ähnlichem Inhalt (Pflegeaufwand).

Bewertung:

Reports sind fachlich solide und durch Tests gut gestützt. Das Design mit Backfill-Zusammenfassungen ist sinnvoll, weil große JSONL-Historien nicht immer live neu aggregiert werden müssen. Risiko bleibt, dass Live-Pfad und Backfill-Pfad semantisch auseinanderlaufen.

Empfehlungen:

- **M, hoher Impact:** Gemeinsame Normalisierungsfunktionen für Live- und Backfill-Tokensemantik extrahieren.
- ✅ Doppelte Report-Tests konsolidiert (`4ba4384`).
- **M, mittlerer Impact:** Backfill-Records um Schema-Version und Preisquelle erweitern.

### Analytics und KPI-Logik - Note 2.7 (vorher 3.0)

Evidenz:

- `analyticsWorker` führt Reportgenerierung, JSONL-Lesen und KPI-Aufbau in einem Worker aus.
- ROI wird auf das Fenster normalisiert: `monthlySubCost * windowDays / 30`.
- `buildFiveHourPeak` nutzt Sliding Window über 5 Stunden.
- `computeActiveHours` zählt Aktivitätsblöcke mit 30-Minuten-Gap und vermeidet Doppelzählung paralleler Sessions.
- `buildDailyBuckets` nutzt lokale Kalendertage, während mehrere Deep-Dive-Metriken UTC verwenden (`buildHourHeatmap`, `buildWeekdayDistribution`, `buildTopActiveDays`).
- ✅ **Behoben (`f12eb26`):** `buildDailyBuckets` erhielt im "all"-Modus das rohe `input.windowDays === 0`, wodurch `getLastNDays(0)` ein leeres Array lieferte und der Tageschart leer blieb. Jetzt wird der abgeleitete `windowDays` übergeben — konsistent mit `result.windowDays`.

Bewertung:

Die Analytics sind umfangreich und praktisch. Einige KPIs sind aber Proxy-Metriken: aktive Stunden aus Log-Timestamps, 5h-Peak aus Claude-JSONL statt Provider-Quota, Cache-Hit aus letztem Live-CostFactor. Das ist okay, sollte aber als Proxy sichtbar sein. Die Mischung aus UTC und lokaler Zeit kann Nutzer in Tages-/Wochentagsansichten verwirren.

Empfehlungen (offen):

- ✅ Zeitbasis vereinheitlicht: Hour-Heatmap, Weekday-Distribution und Top-Active-Days nutzen jetzt Lokalzeit wie die Tages-Buckets (TZ-deterministisch getestet).
- **M, hoher Impact:** KPI-Metadaten hinzufügen: Quelle, Fenster, Preisquelle, Confidence.

### Datenqualität und Fehlersemantik - Note 3.0

Evidenz:

- JSONL-Parser überspringen ungültige Zeilen defensiv.
- Codex cached tokens werden auf Input geklemmt, um fehlerhafte Logdaten abzufangen.
- Debug-/Backfill-Logs enthalten zusammengefasste Tagesdaten, aber nicht durchgehend Confidence oder Fehlergründe.
- `calculateFactor` fängt alle Fehler und gibt `undefined` zurück. Das verhindert Crashes, kann aber fachliche Fehler unsichtbar machen.

Bewertung:

Die App ist robust gegen kaputte Dateien und Providerfehler, aber fachlich fehlt an einigen Stellen Transparenz. "Keine Daten", "nicht eingepreist", "Fehler", "Stale", "Fallback" und "nicht authentifiziert" sollten konsequenter getrennt werden, weil sie für Business-Entscheidungen unterschiedliche Bedeutung haben.

Empfehlungen:

- **S, hoher Impact:** Fehlergründe in Pricing/Analytics strukturiert zurückgeben statt intern zu schlucken.
- **M, mittlerer Impact:** Analyseergebnisse mit Datenqualitätsfeldern ergänzen: `sourceFreshness`, `missingPricingModels`, `ignoredEntries`, `parseErrors`.
- **M, mittlerer Impact:** Backfill-Manifest um Zähler für übersprungene/ungültige Zeilen erweitern.

## Wichtigste konkrete Befunde

1. ✅ **`PricingEngine`-Settings-Drift behoben.**  
   Berechnung nutzt jetzt konsistent injizierte Settings (Tests) bzw. einen Live-Settings-Provider (Produktion). Pricing-Tests grün.

2. **Window-Ratio-Lernen ist fachlich stark.**  
   Die Logik für 5h-vs-Weekly-Verhältnis behandelt reale Provider-Artefakte gut: Jitter, rollierende Reset-Zeiten, Spikes, Planwechsel und Gaps.

3. **Forecasts sind nützlich, aber nicht präzise genug für harte Entscheidungen.**  
   Der Profilforecast basiert auf 28-Tage-Wochentagsmitteln und verteilt Tagesnutzung gleichmäßig auf 24 Stunden. Das ist gut für Trends, aber nicht für exakte Depletion-Zeitpunkte.

4. **Analytics enthalten mehrere Proxy-Metriken.**  
   5h-Peaks, aktive Stunden, Cache-Hit und ROI sind brauchbar, sollten aber mit Quelle und Confidence beschriftet werden.

5. ✅ **Testpipeline ist grün.**  
   `.test.js`-Duplikate entfernt, Vitest auf `tests/**/*.test.ts` beschränkt, gitignore-Guard ergänzt; 3 veraltete `.ts`-Erwartungen angeglichen. Die sehr gute Testbasis wirkt jetzt wieder als Sicherheitsnetz.

6. ⚠️ **Renderer ist weiterhin nicht gehärtet (neuer Top-Befund).**  
   `nodeIntegration: true` / `contextIsolation: false` in `src/main/detailsWindow.ts` und `src/main/onboardingWindow.ts`. Das XSS im Models-Tab ist geschlossen, aber ohne Renderer-Härtung bleibt jeder künftige unescaped-Pfad RCE-relevant.

## Priorisierte Roadmap

### 30 Tage

1. ✅ **Testpipeline grün machen** — erledigt (`3bdf261`, `8a6b92d`).
2. ✅ **`PricingEngine` Settings-Drift beheben** — erledigt (`0004f6f`).
3. ✅ **Renderer-XSS im Models-Tab schließen** — erledigt (`754ed59`).
4. **Business-Result-Metadaten ergänzen - Quick Win (offen)**  
   Preisquelle, Missing-Pricing-Modelle und Datenfenster im `CostFactorResult`/Analytics-Result ausweisen.

### 60 Tage

1. **Renderer-Härtung umsetzen - Risk-Reducer (jetzt Top-Priorität)**  
   Preload-Script, `contextBridge`, `nodeIntegration: false`, `contextIsolation: true` — für Details- und Onboarding-Fenster.

2. ✅ **Zeitsemantik vereinheitlicht** — Analytics-Ansichten auf Lokalzeit standardisiert (Heatmap/Weekday/Top-Days).

3. ✅ **Forecast-Confidence eingeführt** — `confidence`/`reason` im Result, im Live-Tab sichtbar.

4. **Live-/Backfill-Normalisierung konsolidieren**  
   Gemeinsame Token- und Kosten-Normalisierung für Reports, Analytics und Backfill.

### 90 Tage

1. **CI und GUI-Smoke-Test etablieren**  
   `npm ci`, `npm run build`, `npm test`, plus automatisierter Electron-Smoke-Test aus `TESTING.md`. (Aktuell kein `.github/workflows`.)

2. **Lint-Setup ergänzen**  
   ESLint o. Ä. als `npm run lint`; aktuell existiert kein Lint-Script.

3. **Hourly/Session-basiertes Weekly-Profil verbessern**  
   Forecast nicht nur nach Wochentag, sondern nach Wochentag und Tageszeit modellieren.

4. **Datenqualitäts-Dashboard ergänzen**  
   Parsefehler, ausgelassene Dateien, stale Provider, fehlende Preise und Backfill-Frische sichtbar machen.

5. **Renderer schrittweise typisieren**  
   Kritische Renderer-Module nach TypeScript oder `// @ts-check` migrieren.

## Verifikation

Stand 2026-06-13 nach Fixes:

- `npm test` — **erfolgreich (469 Tests, 54 Dateien)**.
  - `.test.js`-Duplikate entfernt; Vitest lädt nur noch `tests/**/*.test.ts`.
  - Zuvor rote `.ts`-Tests (Pricing, Benchmark, Notification) sind grün.
- `npm run build` — erfolgreich.
- `npm audit` / `npm audit --omit=dev` — bei Erstanalyse 0 bekannte Vulnerabilities (nicht erneut geprüft).

Noch nicht automatisiert: kein CI, kein Lint, kein GUI-Smoke-Test.

## Offene Kleinbefunde

- ✅ README-Badge auf Electron 42 korrigiert (`c63975b`).
- ✅ Doppelter `describe("source: backfill")`-Block in `tests/reports.test.ts` entfernt (`4ba4384`).
- `nodeIntegration: true` / `contextIsolation: false` in Details- und Onboarding-Fenster (offen).
- Mehrere Analyse-/Pricing-Ergebnisse ohne Quellen-/Confidence-Metadaten (offen).

## Endnote

QuotaBar hat eine gute fachliche Grundlage. Besonders die Window-Ratio- und Debug-/Backfill-Logik zeigt ein gutes Verständnis realer Provider-Artefakte. Nach dem ersten Fix-Durchlauf sind die kritischen Berechnungsfehler beseitigt, die Testpipeline ist grün und das Models-Tab-XSS geschlossen. Der nächste strukturelle Hebel ist die **Renderer-Härtung** (contextIsolation/Preload), gefolgt von sichtbaren Datenqualitäts- und Preisquellen-Metadaten. Neue Analysefeatures sollten erst danach folgen.

# Markdown-Nutzungsreport im System-Tab

## Ziel

Im System-Tab soll eine Funktion entstehen, die eine lokale Markdown-Datei mit einem vollständigen oder auf die letzten X Tage begrenzten Nutzungsreport erzeugt. Der Report soll nicht nur Tabellen exportieren, sondern echte Erkenntnisse formulieren: Wie intensiv wurde Quota genutzt, welche Modelle treiben Kosten und Nutzen, wie gut werden 5h-/7d-Fenster ausgeschöpft, wie hoch ist das API-Äquivalent gegenüber Abokosten und welche Muster zeigen sich nach Tageszeit, Wochentag, Sessions und Token-Typen.

Der Report ist auf Deutsch, nutzt korrekte Umlaute und wird dynamisch aus Kennzahlen plus Textbausteinen generiert. Er soll für zwei Zwecke lesbar sein:

- Persönliche Nutzungsanalyse: Wann, womit und wie produktiv wurde gearbeitet?
- Wirtschaftliche Beurteilung: Rechnet sich das Abo gegenüber API-Äquivalenten, welche Modelle sind teuer, welche liefern gutes Preis-Leistungs-Verhältnis?

## Lokale Datenlage im aktuellen Code

### Bereits nutzbare Aggregatoren

- `src/reports/reportService.ts`
  - erzeugt Tages-, Wochen-, Monats-, Stunden- und Session-Reports
  - unterstützt Provider `all`, `claude`, `codex`
  - unterstützt `since`, `until`, `breakdown`, `source: "live" | "backfill"`
  - liefert Token-Summen, Kosten, Modelle und `modelBreakdowns`

- `src/main/analyticsWorker.ts` und `src/main/analyticsSummary.ts`
  - liefern API-Kosten, Abokosten, ROI-Faktor
  - aktive Tage, durchschnittliche Sessiondauer, Sessionanzahl, Gesamtstunden
  - Cache-Hit-Raten
  - Top-Modelle nach Kosten
  - Tages-Buckets mit Kosten und Abokosten
  - Stundenaktivität, Wochentagsverteilung, Top-Aktivtage
  - 5h-Spitzenfenster auf Basis von Claude-Entries
  - wöchentliche Zusammenfassung
  - Kosten pro 1k Output-Tokens und Kosten pro aktiver Stunde
  - Planwechsel im gewählten Zeitraum

- `src/main/modelsData.ts`
  - erzeugt Modell-Tagesdaten aus Backfill plus Live-Tail
  - enthält Kosten je Modell, Token-Typen, Provider und Datum
  - lädt Benchmark-Scores aus `src/config/model-benchmarks.json`
  - sammelt aktuelle Preisraten aus LiteLLM bzw. Fallback

- `src/renderer/tabs/models-calc.js`
  - enthält bereits wertvolle reine Berechnungslogik, die konzeptionell auf Main-Seite gespiegelt oder extrahiert werden könnte:
    - aktive Modelle und Delta
    - Top-Modell nach Kosten
    - Top-Modell nach Output
    - effektive Kosten pro Mio. Token
    - Preis-Leistung über Benchmark-Score pro effektivem $/MTok
    - Top-3-Kostenkonzentration
    - Preis-vs.-Intelligenz-Scatter-Daten
    - Modell-Adoption über Monate
    - Cache-Effizienz und geschätzte Einsparungen durch Cache Reads
    - Provider-/Token-Typ-Kostenaufschlüsselung

- `src/main/windowBudgetSeries.ts`, `src/main/windowHistoryReader.ts`, `src/usage/windowHistory.ts`
  - rekonstruieren 5h- und 7d-Fenster aus Debug-Snapshot-Logs
  - liefern aktuelle Weekly-Zeitreihe, erkannte 5h-Resets und aktuelle Fenster-Nutzung
  - liefern historische abgeschlossene 7d-Perioden mit:
    - genutzten 5h-Fenstern
    - maximal möglichen/gelernten Fenstern
    - Bonus-Reset-Markierung

- `src/main/systemData.ts`
  - scannt bekannte lokale Pfade ohne breite Festplatten-Suche
  - liest keine Credential-Inhalte
  - passt als Einstiegspunkt für einen System-Tab-Export

### Lokale Rohdaten und Speicherorte

- Claude-Projekte: bekannte `projects`-Ordner aus `CLAUDE_CONFIG_DIR`, `~/.config/claude`, `~/.claude`
- Codex-Sessions: bekannte `sessions`-Ordner aus `CODEX_HOME` bzw. `~/.codex`
- Backfill: `%USERPROFILE%\.quotabar-win\debug\*.backfill.jsonl`
- Live-Debug-Snapshots: `%USERPROFILE%\.quotabar-win\debug\*.jsonl`
- Settings und Pläne: `%USERPROFILE%\.quotabar-win\settings.json`
- Window-Ratio: `%USERPROFILE%\.quotabar-win\window-ratio.json`
- Window-History: `%USERPROFILE%\.quotabar-win\window-history.json`
- Usage-Snapshot-Cache: `%USERPROFILE%\.quotabar-win\cache\usage-snapshots.json`
- Modell-Benchmarks: `src/config/model-benchmarks.json`
- Preisdaten: LiteLLM online oder Fallback in `src/pricing/litellm-fetcher.ts`

### Wichtige Grenzen

- Claude-Session- und Stundenmuster sind aktuell detaillierter als Codex, weil einige Analytics-Funktionen direkt auf `ClaudeUsageEntry[]` arbeiten.
- Backfill kennt Tages-/Modellwerte dauerhaft, aber keine vollständigen Sessiondetails.
- Live-Logs und Provider-Logs können Lücken haben; der Report sollte Datenqualität sichtbar machen.
- Preisdaten können fehlen oder aus Fallback/Offline-Modus stammen; wirtschaftliche Aussagen sollten diese Unsicherheit kennzeichnen.
- Credentials, Tokens, Authorization Header und JWTs dürfen nie gelesen, geloggt oder exportiert werden.

## Report-Umfang

Der Export sollte mindestens drei Zeiträume unterstützen:

- Vollständig: alle lokal verfügbaren historischen Daten
- Letzte X Tage: freie numerische Eingabe, z. B. 7, 30, 90, 365
- Optional später: benutzerdefinierter Datumsbereich

Empfohlene V1:

- System-Tab-Button: `Report erstellen`
- daneben kompakter Zeitraum-Selector: `Alle`, `Letzte 7 Tage`, `Letzte 30 Tage`, `Letzte 90 Tage`, `Eigene Tage`
- Export über nativen Save-Dialog als `.md`
- Dateiname: `quotabar-report-YYYY-MM-DD-all.md` oder `quotabar-report-YYYY-MM-DD-30d.md`

## Empfohlene Report-Struktur

### 1. Titel und Kontext

Inhalt:

- Report-Titel
- Zeitraum
- Generierungszeitpunkt
- Provider mit Daten
- Datenquellenstatus: Backfill, Live-Tail, Window-History, Pricing

Beispiel:

```md
# QuotaBar Nutzungsreport

Zeitraum: 2026-05-20 bis 2026-06-19
Erstellt: 2026-06-19 22:55
Datenbasis: Claude, Codex, Backfill, Live-Snapshots, LiteLLM-Preise
```

### 2. Executive Summary

Kurze, dynamische Zusammenfassung mit 4 bis 7 Sätzen:

- Gesamtkosten API-Äquivalent
- Abokosten im Zeitraum
- ROI/Faktor
- aktive Tage und aktive Stunden
- stärkster Kostentreiber
- auffälligster Nutzungsrhythmus
- wichtigste Handlungsempfehlung

Beispiel-Logik:

- Wenn ROI >= 5: Abo wurde wirtschaftlich sehr stark ausgenutzt.
- Wenn ROI zwischen 1 und 5: Abo rechnet sich gegenüber API-Nutzung.
- Wenn ROI < 1: API-Äquivalent liegt unter Aboaufwand; Nutzen eher über Komfort/Verfügbarkeit begründen.
- Wenn Top-3-Modelle > 80 % Kostenanteil: Nutzung ist stark konzentriert.
- Wenn Cache-Hit > 90 %: hohe Wiederverwendung senkt effektive Kosten.

### 3. Kennzahlen auf einen Blick

Markdown-Tabelle:

| Kennzahl | Wert | Einordnung |
| --- | ---: | --- |
| API-Äquivalent | `$...` | rechnerischer API-Wert |
| Abokosten | `$...` | anteilig im Zeitraum |
| ROI-Faktor | `...×` | API-Wert / Abo |
| Aktive Tage | `.../...` | Nutzungsdichte |
| Aktive Stunden | `... h` | geschätzte Arbeitszeit |
| Kosten pro aktiver Stunde | `$...` | API und optional Abo |
| Kosten pro 1k Output | `$...` | Effizienz der Ergebnisproduktion |
| Cache-Hit | `... %` | Wiederverwendung von Kontext |
| Modelle aktiv | `...` | Diversität der Modellnutzung |

### 4. Wirtschaftliche Bewertung

Ziel: nicht nur Kosten anzeigen, sondern interpretieren.

Mögliche Inhalte:

- API-Äquivalent vs. Abo pro Provider und kombiniert
- ROI je Provider
- ROI je hinterlegtem Plan bzw. Planwechsel
- Abo-Kosten pro aktivem Tag und pro aktiver Stunde
- API-Kosten pro aktivem Tag und pro aktiver Stunde
- Break-even-Betrachtung: Wie viel API-Äquivalent pro Monat wäre nötig, damit das Abo rechnerisch aufgeht?
- Hinweis auf Zeiträume ohne hinterlegte Pläne

Tabelle:

| Provider | API-Äquivalent | Abo anteilig | Faktor | Bewertung |
| --- | ---: | ---: | ---: | --- |
| Claude | `$...` | `$...` | `...×` | ... |
| Codex | `$...` | `$...` | `...×` | ... |
| Gesamt | `$...` | `$...` | `...×` | ... |

Textbausteine:

- Hoher Faktor: "Die Nutzung liegt deutlich über dem rechnerischen Abo-Gegenwert."
- Niedriger Faktor: "Rein nach API-Äquivalent wurde das Abo in diesem Zeitraum nicht ausgeschöpft."
- Kein Plan: "Für diesen Provider ist kein Abo-Plan hinterlegt; ROI kann nicht belastbar berechnet werden."

### 5. Nutzung der 5h- und 7d-Fenster

Ziel: sichtbar machen, ob Quota-Fenster sinnvoll genutzt oder verschenkt werden.

Daten:

- aktuelle `windowBudget:get`-Daten, soweit letzte Snapshots vorhanden sind
- historische `windowHistory:get`-Daten aus abgeschlossenen 7d-Perioden
- erkannte 5h-Resets aus `WindowBudgetSeries`
- `usedWindows`, `maxWindows`, `bonus`
- aktuelle Weekly-Auslastung und Forecast

Mögliche Kennzahlen:

- genutzte 5h-Fenster pro abgeschlossener Woche
- geschätzte mögliche Fenster pro Woche
- Auslastung `usedWindows / maxWindows`
- Wochen mit Bonus-Reset
- Anteil ungenutzter Fenster
- stärkste Woche und schwächste Woche
- Trend: mehr oder weniger Fenster genutzt als vorherige Periode

Tabelle:

| Woche bis | Provider | Genutzte 5h-Fenster | Max. Fenster | Auslastung | Bonus |
| --- | --- | ---: | ---: | ---: | --- |

Insight-Ideen:

- "Du nutzt viele 5h-Fenster nur leicht an" bei hoher Reset-Anzahl und niedrigen Peaks.
- "Die Weekly-Quota ist der begrenzende Faktor" bei hoher Weekly-Auslastung und vielen genutzten 5h-Fenstern.
- "Es bleiben rechnerisch Fenster übrig" bei niedriger Auslastung.
- "Bonus-Resets erhöhen den effektiven Wochenrahmen" bei `bonus=true`.

### 6. Aktivitätsmuster

Daten:

- `hourHeatmap`
- `weekdayDistribution`
- `topActiveDays`
- `activeDays`
- `sessionStats`

Inhalte:

- aktivste Stunde
- aktivster Wochentag
- Konzentration auf wenige Tage vs. gleichmäßige Nutzung
- Top-5-Aktivtage mit Calls und Output-Tokens
- durchschnittliche Sessiondauer
- Sessions pro aktivem Tag
- Gesamtstunden

Tabelle:

| Muster | Wert | Insight |
| --- | ---: | --- |
| Aktivste Stunde | `... Uhr` | ... |
| Aktivster Wochentag | `...` | ... |
| Sessions pro aktivem Tag | `...` | ... |
| Ø Sessiondauer | `... min` | ... |

Textbausteine:

- Gebündelte Nutzung: viele Calls an wenigen Tagen.
- Gleichmäßige Nutzung: viele aktive Tage mit moderater Sessionzahl.
- Lange Sessions: Hinweis auf Deep-Work-Phasen.
- Kurze Sessions: Hinweis auf punktuelle Assistenz.

### 7. Modellnutzung und Modellmix

Daten:

- `models:get`
- `modelBreakdowns` aus `reports:get`
- Berechnungen analog `models-calc.js`

Inhalte:

- aktive Modelle
- Top-Modell nach Kosten
- Top-Modell nach Output
- Kostenanteil Top 3
- Modellwechsel/Adoption über Zeit
- Modelle mit steigender oder sinkender Nutzung
- Provider-Mix Claude vs. Codex

Tabellen:

| Modell | Provider | Kosten | Kostenanteil | Tokens | Output | Effektiv $/MTok |
| --- | --- | ---: | ---: | ---: | ---: | ---: |

| Modell | Erste Nutzung | Letzte Nutzung | Trend | Kommentar |
| --- | --- | --- | ---: | --- |

Insight-Ideen:

- Hohe Konzentration kann gut sein, wenn das Top-Modell auch bestes Preis-Leistungs-Verhältnis hat.
- Hohe Kosten bei niedrigem Output können auf teure Reasoning-/Output-Phasen hinweisen.
- Neue Modelle können als "Adoption" markiert werden, wenn sie im Zeitraum erstmals auftauchen.

### 8. Preis, Intelligenz und Wert

Daten:

- Benchmark-Scores aus `model-benchmarks.json`
- effektive `costUSD / totalTokens * 1e6`
- Preisraten aus LiteLLM/Fallback
- Score pro effektivem $/MTok

Inhalte:

- bestes Preis-Leistungs-Modell
- teuerstes Modell pro Mio. Token
- günstigstes relevantes Modell
- Modelle im "guter Wert"-Quadranten: hoher Score, niedriger Preis
- Modelle im "teuer für ihren Score"-Bereich
- Hinweis, wenn Benchmark-Scores fehlen

Tabelle:

| Modell | Score | Effektiv $/MTok | Score/$ | Kostenanteil | Einordnung |
| --- | ---: | ---: | ---: | ---: | --- |

Textbausteine:

- "Das beste gemessene Preis-Leistungs-Verhältnis liefert ..."
- "Dieses Modell ist teuer, dominiert aber auch die Nutzung; prüfen, ob günstigere Modelle für Routineaufgaben reichen."
- "Für einige Modelle fehlen Benchmarkdaten; die Preis-vs.-Intelligenz-Bewertung ist daher unvollständig."

### 9. Token-Anteile und Cache-Effizienz

Daten:

- inputTokens
- outputTokens
- cacheCreationTokens
- cacheReadTokens
- Kostenkomponenten je Token-Typ
- Cache-Effizienz aus `models-calc.js`

Inhalte:

- Token-Mix gesamt und je Provider
- Kostenanteil je Token-Typ
- Cache-Hit-Raten je Provider und Modell
- geschätzte Einsparungen durch Cache Reads
- Warnung bei niedriger Cache-Hit-Rate

Tabellen:

| Provider | Input | Output | Cache Read | Cache Create | Gesamt |
| --- | ---: | ---: | ---: | ---: | ---: |

| Token-Typ | Anteil Tokens | Kosten | Effektiv $/MTok | Kommentar |
| --- | ---: | ---: | ---: | --- |

Insight-Ideen:

- Hoher Cache-Read-Anteil ist wirtschaftlich positiv.
- Hoher Output-Anteil erklärt steigende Kosten.
- Hoher Cache-Creation-Anteil kann auf große neue Kontextaufbauten hinweisen.

### 10. Preisentwicklung und Trends

"Preisentwicklung" kann in V1 zwei Bedeutungen haben:

1. Entwicklung der eigenen effektiven Kosten im Zeitverlauf
2. Entwicklung der externen Modellpreise

Der Code speichert aktuell keine historischen LiteLLM-Preisstände. Daher ist für V1 belastbar:

- tägliche/wöchentliche API-Kosten
- effektiver $/MTok je Zeitraum
- Kosten je Output-Token über Zeit
- Modellmix-bedingte Preisverschiebung
- Planwechsel und Abokostenentwicklung

Nicht belastbar ohne neue Speicherung:

- echte historische Preisänderungen von LiteLLM/OpenAI/Anthropic

Empfehlung:

- V1 nennt diesen Abschnitt "Kostenentwicklung" statt "Preisentwicklung".
- Optional später: täglicher Pricing-Snapshot pro Modell speichern, um echte Preisänderungen berichten zu können.

Mögliche Tabelle:

| Zeitraum | Kosten | Tokens | $/MTok | Veränderung | Haupttreiber |
| --- | ---: | ---: | ---: | ---: | --- |

Insight-Ideen:

- "Die effektiven Kosten pro Mio. Token sind gestiegen, obwohl die Tokenmenge ähnlich blieb; Ursache ist vermutlich ein teurerer Modellmix."
- "Kostenanstieg folgt primär der höheren Nutzung, nicht höheren Stückkosten."

### 11. Sessions und Arbeitsrhythmus

Daten:

- `sessionStats`
- Session-Reports aus `reports:get` mit `type: "session"` für Live-Daten
- Claude-Entries für detailliertere Sessionzeiten

Inhalte:

- Anzahl Sessions
- Ø Sessiondauer
- längste Sessions
- Kosten und Output pro Session
- Kosten pro aktiver Stunde
- aktive Stunden nach Provider, soweit ableitbar

Tabelle:

| Session/Projekt | Provider | Letzte Aktivität | Dauer | Kosten | Output | Modelle |
| --- | --- | --- | ---: | ---: | ---: | --- |

Datenschutz:

- Projekt-/Directory-Namen sollten optional anonymisiert werden, wenn `settings.anonymizeAccounts` oder eine neue Report-Option aktiv ist.
- Keine Rohprompts, keine Antworten, keine Pfadinhalte, keine Credentials.

### 12. Empfehlungen

Der Report sollte am Ende konkrete, aber vorsichtig formulierte Empfehlungen ausgeben.

Kategorien:

- Wirtschaft
  - Abo behalten/prüfen/Plan anpassen
  - Provider mit niedrigem ROI hinterfragen
- Modellmix
  - teure Modelle für High-Value-Aufgaben reservieren
  - günstige Modelle für Routineaufgaben stärker nutzen
- Cache
  - niedrige Cache-Hit-Rate untersuchen
  - lange Kontext-Neuaufbauten vermeiden
- Quota-Fenster
  - 5h-Fenster gezielter bündeln
  - Weekly-Reserve vor Reset nutzen
- Arbeitsrhythmus
  - Deep-Work-Zeiten sichtbar machen
  - stark fragmentierte Nutzung erkennen

Beispiel:

```md
## Empfehlungen

- Dein Abo rechnet sich im betrachteten Zeitraum klar gegenüber API-Nutzung.
- Die Kosten konzentrieren sich stark auf ein Modell. Prüfe, ob Routineaufgaben auf günstigere Modelle verlagert werden können.
- Die Cache-Nutzung ist hoch und wirtschaftlich positiv; große Kontext-Workflows scheinen gut wiederverwendet zu werden.
- Deine Nutzung bündelt sich auf wenige aktive Stunden. Wenn du Weekly-Quota regelmäßig übrig hast, wären zusätzliche Arbeitsblöcke kurz vor dem Reset wirtschaftlich sinnvoll.
```

## Dynamische Textgenerierung

Die Report-Generierung sollte nicht als LLM-Aufruf umgesetzt werden, sondern deterministisch über Kennzahlen, Schwellenwerte und Textbausteine. Vorteile:

- keine Datenweitergabe
- reproduzierbar
- testbar
- offlinefähig
- keine zusätzlichen Kosten

### Konzept

1. Kennzahlen berechnen
2. Kennzahlen normalisieren und klassifizieren
3. Insights als Objekte erzeugen
4. Top-Insights priorisieren
5. Markdown aus Sektionen, Tabellen und Textbausteinen rendern

Beispiel-Datenstruktur:

```ts
interface Insight {
  id: string;
  severity: "positive" | "neutral" | "warning";
  topic: "roi" | "models" | "cache" | "windows" | "sessions" | "rhythm";
  score: number;
  markdown: string;
}
```

### Schwellenwerte als Startpunkt

- ROI
  - `< 1`: wirtschaftlich nicht ausgeschöpft
  - `1-3`: rechnet sich
  - `3-10`: stark
  - `> 10`: außergewöhnlich stark

- Cache-Hit
  - `< 50 %`: niedrig
  - `50-85 %`: solide
  - `> 85 %`: stark

- Top-3-Kostenanteil
  - `< 50 %`: breiter Modellmix
  - `50-80 %`: fokussierter Modellmix
  - `> 80 %`: starke Konzentration

- Aktive Tage
  - `< 25 % des Zeitraums`: punktuelle Nutzung
  - `25-70 %`: regelmäßige Nutzung
  - `> 70 %`: sehr kontinuierliche Nutzung

- 5h-Fenster-Auslastung
  - `< 40 %`: viele ungenutzte Fenster
  - `40-80 %`: moderate Auslastung
  - `> 80 %`: intensive Auslastung

- Kosten pro aktiver Stunde
  - mit API-Kosten und Abo-Kosten vergleichen
  - bei hohem API-Wert pro Stunde als produktiver Hebel formulieren, nicht pauschal als "teuer"

## Technischer Umsetzungsvorschlag für später

Keine Codeänderung in diesem Schritt. Für eine spätere Implementierung wäre diese Struktur sinnvoll:

### Neue Main-Module

- `src/reports/markdownReport.ts`
  - Orchestrierung
  - nimmt Zeitraum und Optionen entgegen
  - ruft bestehende Aggregatoren auf
  - gibt Markdown-String plus Metadaten zurück

- `src/reports/reportInsights.ts`
  - berechnet Insight-Objekte aus aggregierten Daten
  - enthält Schwellenwerte und Ranking

- `src/reports/markdownRenderer.ts`
  - rendert Markdown-Tabellen, Zahlenformate und Sektionen
  - keine Datenlogik

- optional `src/reports/modelAnalytics.ts`
  - extrahiert serverseitige Pendants zu `models-calc.js`, damit die Reportlogik nicht Browser-Code importiert

### Neue IPCs

- `reports:markdown-preview`
  - optional, wenn später eine Vorschau im UI gewünscht ist

- `reports:save-markdown`
  - öffnet Save-Dialog im Main-Prozess
  - schreibt Datei lokal
  - gibt `{ ok, path }` zurück

### System-Tab UI

Der System-Tab bleibt ein lokales Daten-/Exportzentrum. Ergänzung als eigene Panel-Zeile:

- Titel: `Nutzungsreport`
- Kurztext: `Erstellt eine lokale Markdown-Datei aus aggregierten QuotaBar-Daten.`
- Zeitraum-Auswahl
- Button: `Markdown erstellen`
- sekundäre Statuszeile: `Keine Credentials oder Rohinhalte werden exportiert.`

Der Export gehört in den Main-Prozess, weil dort Dateisystemzugriff, Save-Dialog und existierende Aggregatoren verfügbar sind.

### Tests

Sinnvolle Tests bei Implementierung:

- Markdown enthält alle erwarteten Hauptsektionen.
- Zeitraumfilter `all` und `last X days` begrenzt Daten korrekt.
- Keine Secrets/Authorization/JWT-artigen Felder werden aufgenommen.
- Umlaute bleiben korrekt.
- Tabellen werden mit leeren Daten robust gerendert.
- ROI-Textbausteine wechseln bei Schwellenwerten korrekt.
- Fehlende Pricing- oder Benchmarkdaten erzeugen Hinweise statt Fehler.
- Window-History ohne Daten erzeugt saubere "nicht verfügbar"-Sektion.

## Datenschutz und Sicherheit

Der Report darf nur aggregierte Daten enthalten:

- Kosten
- Tokens
- Zeiten
- Modelle
- Provider
- optional anonymisierte Projekte/Sessions

Der Report darf nicht enthalten:

- Tokens, Cookies, Authorization Header, JWTs
- Credential-Inhalte
- Rohprompts
- Modellantworten
- komplette lokale Pfadlisten, außer der Nutzer entscheidet sich später explizit für einen Diagnoseanhang

Pfad- und Projektinformationen:

- Standard: keine vollständigen Pfade im Report
- Session-/Projekt-Namen nur gekürzt oder anonymisiert, wenn sie aus Codex-Directories stammen
- Für wirtschaftliche Reports reichen aggregierte Session-IDs/Projektlabels

## V1-Mindestumfang

Eine gute erste Version sollte enthalten:

- Zeitraum: alle Daten oder letzte X Tage
- Markdown-Datei via Save-Dialog
- Executive Summary
- KPI-Tabelle
- Wirtschaftliche Bewertung mit API-Äquivalent, Abokosten und ROI
- Aktivitätsmuster mit Stunden, Wochentagen, aktiven Tagen und Sessions
- Modellnutzung mit Top-Modellen, Kostenanteilen und effektivem $/MTok
- Preis-vs.-Intelligenz-Auswertung, wenn Benchmarkdaten vorhanden sind
- Token-Typen und Cache-Effizienz
- 5h-/7d-Fenster-Sektion, wenn Window-History vorhanden ist
- Empfehlungen
- Datenqualitäts-/Unsicherheits-Hinweise

## Spätere Erweiterungen

- Markdown-Vorschau im System-Tab
- Export zusätzlich als HTML oder PDF
- Vergleich zweier Zeiträume
- echte historische Preisentwicklung durch gespeicherte Preis-Snapshots
- anonymisierter Diagnoseanhang
- "Management Summary" und "Technischer Anhang" als auswählbare Report-Tiefen
- automatische Monatsreports
- Report-Vorlagen für persönliche Nutzung, Steuer/Accounting und Team-Kostenreview

## Offene Entscheidungen

- Soll `letzte X Tage` als freie Zahl im System-Tab reichen oder zusätzlich ein kompletter Datumsbereich angeboten werden?
- Sollen Projekt-/Session-Namen standardmäßig anonymisiert werden?
- Soll der Report direkt gespeichert werden oder zuerst eine Vorschau erhalten?
- Soll die V1 echte Session-Toplisten enthalten, obwohl Backfill keine vollständigen Sessiondetails kennt, oder soll Sessiontiefe nur bei Live-Daten verfügbar sein?
- Soll "Preisentwicklung" in V1 bewusst als "Kostenentwicklung" formuliert werden, bis historische Preissnapshots existieren?


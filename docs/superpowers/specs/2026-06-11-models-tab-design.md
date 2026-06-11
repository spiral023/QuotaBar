# Models-Tab — Design

**Datum:** 2026-06-11
**Status:** Freigegeben (Brainstorming abgeschlossen)

## Ziel

Ein neuer Dashboard-Tab „Models", der die Modell-Nutzung über beide Provider (Claude
und Codex) hinweg sichtbar macht: Verteilung über die Zeit, Kosten, Effizienz und
Preis-Leistungs-Vergleich. Jedes Feature funktioniert für beide Provider — Features,
die nur ein Provider liefern kann (Reasoning-Tokens, Fallback-Quote), sind bewusst
ausgeschlossen.

## Datenlage (geprüft am 2026-06-11)

- **Backfill-Records** (`~/.quotabar-win/debug/*.backfill.jsonl`): tagesgenaue
  per-Modell-Daten von 2025-09-24 bis heute, beide Provider, mit
  input/output/cacheCreation/cacheRead-Tokens und costUSD pro Modell.
  17 verschiedene Modelle vorhanden.
- **Live-JSONL**: Claude ~1 Monat Retention, Codex ~9 Monate. Für Langzeit-Charts
  ist die Backfill-Quelle maßgeblich; Live-Daten dienen als tagesaktueller Tail.
- **Pricing**: LiteLLM-Preise pro Modell verfügbar (`LiteLLMFetcher`).
- **Benchmark-Scores**: nicht lokal vorhanden → statisches JSON im Repo (Entscheidung).

## Entscheidungen (geklärt mit User)

| Frage | Entscheidung |
|---|---|
| Benchmark-Quelle | Statisches JSON im Repo (`src/config/model-benchmarks.json`), manuell gepflegt |
| Chart-Default | Gesamter Verlauf, wöchentliche Buckets; Pills 30D/90D (täglich) / Alles (wöchentlich) |
| Scope | Voller Tab in einem Wurf (KPIs, Stacked-Chart, Scatter, Tabelle, Insights) |
| Metriken | Output (Default) / Input / Cache Read / Cache Creation / Total / Kosten ($) |
| Architektur | Neuer IPC-Endpunkt `models:get` mit eigenem Worker-Task |

## Layout (von oben nach unten)

```
┌─ KPI-KACHELN (6) ──────────────────────────────────────────────┐
│ Aktive     Top-Modell   Top-Modell   Ø $/MTok    Bestes   Top-3│
│ Modelle    (Kosten)     (Tokens)     effektiv    P/L      Konz.│
└────────────────────────────────────────────────────────────────┘
┌─ MODELL-VERTEILUNG (100% gestapelt) ───────────────────────────┐
│ [Output|Input|Cache Read|Cache Creation|Total|Kosten]  ← Metrik│
│ [Alle|Claude|Codex]                    [30D|90D|Alles] ← Filter│
└────────────────────────────────────────────────────────────────┘
┌─ PREIS vs. INTELLIGENZ (Scatter) ──────────────────────────────┐
┌─ MODELL-TABELLE (sortierbar, mit Summenzeile) ─────────────────┐
┌─ INSIGHTS: Modell-Adoption (Timeline) │ Cache-Effizienz ───────┐
```

## Features im Detail

### KPI-Kacheln

Das Zeitfenster der Kacheln folgt der Fenster-Auswahl des Verteilungs-Charts
(Default: „Alles"). „Vorperiode" = gleich langes Fenster unmittelbar davor;
bei „Alles" gibt es keine Vorperiode → Trend-Indikatoren werden ausgeblendet.

1. **Aktive Modelle** — Anzahl Modelle mit Nutzung im Fenster, Δ zur Vorperiode.
2. **Top-Modell nach Kosten** — Name + $ + Anteil in %.
3. **Top-Modell nach Output-Tokens** — das „Arbeitspferd".
4. **Ø $/MTok effektiv** — Gesamtkosten ÷ Gesamttokens × 1M, Trend ▼/▲ vs.
   Vorperiode. Der „Blended Price" des gesamten Modell-Mixes inkl. Cache-Effekt.
5. **Bestes Preis/Leistungs-Modell** — max(Score ÷ effektiver $/MTok) unter
   genutzten Modellen mit bekanntem Score.
6. **Modell-Konzentration** — Kostenanteil der Top-3-Modelle.

### Chart 1: Modellverteilung (100% gestapelt)

- Default: volle Backfill-Historie, wöchentliche Buckets (~38 Balken).
- Pills: 30D (täglich) / 90D (täglich) / Alles (wöchentlich).
- Metrik-Umschalter: Output (Default) / Input (uncached) / Cache Read /
  Cache Creation / Total / Kosten ($).
- Provider-Filter: Alle / Claude / Codex.
- Modelle mit <1 % Anteil im sichtbaren Fenster → Sammelkategorie „Andere" (grau).
- Tooltip: Modell, absoluter Wert, Prozentanteil.
- Chart.js `createStackedBar`-Variante mit y-Achse 0–100 %.

### Chart 2: Preis vs. Intelligenz (Scatter)

- x: **effektiver $/MTok aus echter Nutzung** (costUSD ÷ totalTokens × 1M des
  Modells im Fenster) — nicht Listenpreis; Cache-Ersparnis verschiebt nach links.
- y: AA-Intelligence-Score aus dem Benchmark-JSON.
- Bubble-Größe: Kostenanteil im Fenster. Farbe: Provider.
- Modelle ohne Score erscheinen nicht im Chart.
- Fußnote: „Quelle: Artificial Analysis Intelligence Index, Stand <asOf>".

### Modell-Tabelle

Eine Zeile pro normalisiertem Modell. Spalten: Provider-Dot, Modell, Input,
Output, Cache Read, Cache Creation, Total, Kosten, effektiver $/MTok, AA-Score,
Score pro $ (Value-Ranking), Kostenanteil %, Cache-Hit-Rate
(cacheRead ÷ (input + cacheRead)), erste Nutzung, letzte Nutzung.
Sortierbar per Spaltenklick, Default: Kosten absteigend. Summenzeile unten
(Muster aus History-Tab). Fehlende Werte als „—".

### Insights

- **Modell-Adoption** (Technologiemanager): horizontale Timeline, ein Balken pro
  Modell von erster bis letzter Nutzung; Balken-Deckkraft pro Monat anteilig am
  Output-Token-Volumen des Modells. Zeigt Generationswechsel und „Zombie-Modelle".
- **Cache-Effizienz pro Modell** (Entwickler): Balken mit Cache-Hit-Rate pro
  Modell + errechnete Ersparnis in $ (cacheRead-Tokens × (Input-Preis −
  Cache-Read-Preis) aus LiteLLM-Pricing).

### Bewusst ausgeschlossen

- Reasoning-Token-Anteil (nur Codex), Fallback-Quote (nur Codex).
- „Was-wäre-wenn alles auf Modell X"-Simulation (Token-Mengen nicht
  modellneutral vergleichbar).

### Notiz für späteren Scope (anderer Tab)

- Live-Tab: „Aktuelles Modell"-Badge pro Provider (letztes genutztes Modell aus
  jüngsten Events). Nicht Teil dieses Designs.

## Architektur & Datenfluss

```
Renderer (models.js)                    Main-Prozess
┌──────────────────┐  models:get   ┌─────────────────────────────┐
│ Tab "Models"     │ ────────────► │ detailsWindow.ts            │
│ Fenster/Metrik-  │               │  modelsDataCache (TTL wie   │
│ Wechsel = lokales│               │  analyticsDataCache)        │
│ Recompute, kein  │ ◄──────────── │   └► analyticsWorker        │
│ neuer IPC-Call   │  ModelsData   │       task: "models"        │
└──────────────────┘               └─────────────────────────────┘
```

- Neuer Worker-Task `"models"` in `src/main/analyticsWorker.ts`; Logik in neuem
  Modul `src/main/modelsData.ts` (analog `analyticsSummary.ts`).
- **Live-Tail-Merge:** Worker bestimmt pro Provider das letzte Backfill-Datum und
  liest nur Tage danach aus den Live-JSONLs (via `generateUsageReport` mit
  `breakdown: true` + `since`). Kein Doppelzählen am Schnitt-Tag: Live-Daten
  ersetzen nie Backfill-Tage, sie ergänzen nur strikt spätere Daten.
- Cache-Invalidierung über bestehendes `clearAnalyticsCaches()`.

### Payload

```ts
interface ModelDay {
  date: string;               // YYYY-MM-DD
  provider: "claude" | "codex";
  model: string;              // normalisiert
  inputTokens: number;        // uncached
  outputTokens: number;
  cacheCreationTokens: number; // Codex: immer 0
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
}

interface ModelsData {
  days: ModelDay[];
  benchmarks: Record<string, number>; // normalisierter Name → Score
  benchmarksAsOf: string;             // z.B. "2026-06"
  generatedAt: string;
}
```

Der Renderer berechnet aus `days` lokal: Fensterfilter, Wochen-Bucketing
(ISO-Wochen, konsistent mit `isoWeekBucket` in reportService), 100%-Normalisierung,
„Andere"-Gruppierung, KPIs inkl. Vorperioden-Deltas, Scatter-Werte, Tabelle,
Adoption-Timeline, Cache-Effizienz. Diese puren Funktionen liegen in
`src/renderer/tabs/models-calc.js` (DOM-frei, direkt vitest-testbar).

## Benchmark-JSON

`src/config/model-benchmarks.json`:

```json
{
  "source": "Artificial Analysis Intelligence Index",
  "asOf": "2026-06",
  "scores": {
    "claude-opus-4-8": 61,
    "claude-opus-4-7": 57,
    "claude-sonnet-4-6": 52,
    "claude-haiku-4-5": 48,
    "gpt-5.5": 60,
    "gpt-5.4": 58,
    "gpt-5.3-codex": 57
  }
}
```

- Matching nur über exakten normalisierten Namen (kein Fuzzy-Matching — falsche
  Zuordnung wäre schlimmer als keine). Unbekannt → kein Scatter-Punkt, „—" in
  Tabelle.
- Die Scores oben sind Beispiele; bei Implementierung werden alle 17 lokal
  vorkommenden Modelle erfasst, soweit AA-Scores existieren.

## Modell-Normalisierung

Neues, von Worker genutztes Modul:

- Datums-Suffix strippen: `/-20\d{6}$/` → `claude-haiku-4-5-20251001` ⇒
  `claude-haiku-4-5`.
- `<synthetic>` und `unknown` werden vollständig gefiltert (0-Kosten-Artefakte).
- Codex-Namen bleiben unverändert.

## Farben

- Zwei Paletten: Claude = 6 Warmtöne ab `#DA785B`, Codex = 6 Kalttöne ab
  `#4B55C8` (konsistent mit `QB.providerColor`).
- Zuweisung nach erstmaligem Auftreten in der Historie (älteste zuerst) →
  stabil über Fenster-/Metrikwechsel. Palette wiederholt sich bei >6 Modellen.
- „Andere" = Grau.

## Fehlerfälle

| Fall | Verhalten |
|---|---|
| Kein Backfill-Verzeichnis | Live-only (~1 Monat), Hinweisbanner „Historie ab <Datum>" |
| Benchmark-JSON fehlt/defekt | Scatter ausgeblendet mit Kurznotiz, Score-Spalte „—" |
| Modell ohne Pricing | costUSD 0 → $/MTok „—" (kein Div/0) |
| Keine Daten | bestehendes Empty-State-Muster |
| Cache Creation + Provider-Filter Codex | Leerhinweis statt leerem Chart |

## UI-Integration

- Neuer Tab-Button „Models" in `src/renderer/index.html` (nach „Analytics"),
  `switchTab`-Erweiterung, `QB.renderModels()` in neuem
  `src/renderer/tabs/models.js`, Berechnungen in `models-calc.js`.
- Lade-/Cache-Muster identisch zu `analytics.js` (`_currentData`, `_dataPromise`,
  Prefetch, `clearModelsCache`).
- Styles folgen den bestehenden `an-*`-Mustern in index.html.

## Tests (vitest)

- `tests/modelsData.test.ts`: Backfill+Live-Tail-Merge (kein Doppelzählen),
  Normalisierung, Benchmark-Merge, Synthetic-Filter, fehlendes Backfill-Dir.
- `tests/modelsCalc.test.ts`: Wochen-Bucketing, 100%-Normalisierung,
  „Andere"-Gruppierung (<1 %), KPI-Deltas, Cache-Hit-Rate, Score/$.
- `tests/modelBenchmarks.test.ts`: JSON valide, alle Scores numerisch, alle
  Schlüssel in normalisierter Form (kein Datums-Suffix).

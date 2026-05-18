# QuotaBar Dashboard Redesign — Design Spec

**Datum:** 2026-05-19
**Status:** Approved
**Scope:** 3-Phasen-Redesign von Compact-Popup zu breitem Dashboard mit Analytics, Reports und mehreren Ansichtsmodi

---

## Ziel

Das bestehende 340×560 px Tray-Popup wird zu einem vollwertigen Dashboard erweitert (900×660 px, 2-spaltig, Tab-Navigation). Eine neue Insights-Leiste im Compact-Modus zeigt die wichtigsten Analytics-Kennzahlen auch ohne das große Fenster. Alle Daten stützen sich ausschließlich auf Claude- und Codex-JSONL-Logs — keine externen APIs.

---

## Architekturentscheidung: Ansatz B — JS-Module pro Tab

`index.html` wird zur reinen Shell. Jeder Tab bekommt eine eigene JS-Datei. Keine Build-Tools, kein Bundler — Electron lädt die Dateien direkt über `nodeIntegration: true`.

---

## Dateistruktur (Zielzustand nach Phase 3)

```
src/renderer/
  index.html                ← Shell: CSS-Variablen, Tab-Chrome, Window-Chrome, <script>-Tags
  tabs/
    live.js                 ← Live-Tab: Provider-Karten, Bars, Badges (aus index.html extrahiert)
    analytics.js            ← Analytics-Tab: Charts, Breakdown, Top Models (Phase 2)
    reports.js              ← Reports-Tab: Liste, Filter, Export (Phase 3)
  shared/
    ipc.js                  ← Dünner Wrapper um ipcRenderer.invoke / ipcRenderer.on
    format.js               ← esc(), fmtTokens(), formatCountdown(), fmtDate()
    colors.js               ← usageColor(), accentVar(), providerColor()
    charts.js               ← Chart.js-Init + wiederverwendbare Chart-Komponenten (Phase 2)

assets/vendor/
  chart.min.js              ← Chart.js lokal eingebunden (kein CDN, kein Netzwerk nötig)
```

**Migrationsstrategie:** Phase 1 extrahiert `live.js` + alle `shared/`-Dateien aus dem bestehenden `index.html`. Phase 2 fügt `analytics.js` hinzu. Phase 3 fügt `reports.js` hinzu. Bestehende Funktionalität bleibt zu jedem Zeitpunkt intakt.

---

## Settings-Erweiterungen

```typescript
// src/config/settings.ts — neue Felder
viewMode: "dashboard" | "compact"   // default: "dashboard"
analyticsWindow: 7 | 30             // default: 30 (Tage für Analytics-Tab)
insightsPanelOpen: boolean          // default: false (Compact-Modus Insights eingeklappt)
```

`normalizeSettings` validiert `viewMode` (Fallback: `"dashboard"`) und `analyticsWindow` (nur 7 oder 30, Fallback: 30).

---

## Phase 1: Dashboard-Shell + Live-Tab + Compact-Insights

### 1.1 Window & View System

| Modus | Größe | Verhalten |
|---|---|---|
| **Dashboard** (default) | 900 × 660 px | `resizable: true`, Mindestgröße 750 × 520, zentriert auf Hauptbildschirm |
| **Compact** | 340 × 560 px | `resizable: false`, positioniert nahe Tray-Icon (bestehende Logik) |

**View-Switcher:** Neuer Button `⊞` in der Titelleiste (rechts neben dem Einstellungs-Zahnrad). Klick → schreibt `viewMode` in Settings via `settings:save` → schließt Fenster → öffnet es neu mit den neuen Dimensionen. `detailsWindow.ts` liest `viewMode` aus Settings beim Öffnen und setzt Width/Height/resizable entsprechend.

**CSS-Strategie:** `<body>` bekommt die Klasse `view-dashboard` oder `view-compact`. Alle Layout-Unterschiede werden über diese Klassen gesteuert — kein JS-basiertes Show/Hide von Elementen.

### 1.2 Dashboard-Layout (Live-Tab, 2-Spalten)

```
┌─────────────────────────────────────────────────────────────────────┐
│  ◆ QUOTABAR   [Live] [Analytics] [Reports]        ⊞  ⚙  ×         │  44px
├─────────────────────────────────────────────┬───────────────────────┤
│  LINKE SPALTE (~520px)                      │  RECHTE SPALTE (~360px)│
│                                             │                        │
│  ┌─ Overview (Mini-Bars) ────────────────┐  │  ┌─ Quick Stats ─────┐ │
│  │  Claude ████████░░ 65%               │  │  │  API-Äq. (30d)    │ │
│  │  Codex  ███████░░░ 61%               │  │  │  $298             │ │
│  └───────────────────────────────────────┘  │  ├───────────────────┤ │
│                                             │  │  Abo ROI          │ │
│  ┌─ Claude-Card ─────────────────────────┐  │  │  9.9×             │ │
│  │  [Logo] CLAUDE              65% >    │  │  ├───────────────────┤ │
│  │  5-Hour ████████░  03:22:26          │  │  │  Aktive Tage      │ │
│  │  Weekly ████░░░░░  13:02:26          │  │  │  20 / 30          │ │
│  │  [Far Behind] [$207 · 30d (10×sub)] │  │  ├───────────────────┤ │
│  │  Input 105K · Output 3.7M · Cache 16M│  │  │  Ø Session        │ │
│  └───────────────────────────────────────┘  │  │  54 min           │ │
│                                             │  └───────────────────┘ │
│  ┌─ Codex-Card ──────────────────────────┐  │                        │
│  │  [Logo] CODEX               61% >    │  │  ┌─ Top Models ──────┐ │
│  │  ...                                 │  │  │  sonnet-4-6  $144 │ │
│  └───────────────────────────────────────┘  │  │  haiku-4-5    $8  │ │
│                                             │  │  opus-4-7     $5  │ │
│                                             │  │  gpt-5.5    $212  │ │
│                                             │  └───────────────────┘ │
│                                             │                        │
│                                             │  ┌─ Cost Window ─────┐ │
│                                             │  │  [7d] [30d] [Abr] │ │
│                                             │  └───────────────────┘ │
└─────────────────────────────────────────────┴───────────────────────┤
│  ● Updated 2m ago                                              ⚙    │  35px
└─────────────────────────────────────────────────────────────────────┘
```

**Rechtes Panel — Quick Stats (4 Kacheln):**
- API-Äquivalent 30d (kombiniert Claude + Codex): `$298`
- Abo ROI (kombiniert): `9.9×`, Farbe grün ≥ 2×, gelb 1–2×, grau < 1×
- Aktive Tage: `20 / 30`
- Ø Session-Dauer: `54 min`

**Rechtes Panel — Top Models:** Tabelle mit Modell, 30d-Kosten, %-Anteil. Maximal 5 Einträge. Daten aus `analytics:summary`.

**Rechtes Panel — Cost Window:** Die bestehenden 3 Pills (`7d / 30d / Abrechn.`) — von Settings-Panel hierher verschoben (im Settings-Panel entfernt).

### 1.3 Compact-Modus — Insights-Leiste

```
┌─────────────────────────────────────────┐
│  [Claude-Card wie heute]                │
│  [Codex-Card wie heute]                 │
│                                         │
│  ┌─ INSIGHTS (30d) ──────────── ∨ ──┐  │  ← einklappbar
│  │  $298 API-Äq.  vs $30 Abo  9.9×  │  │
│  │  20/30 Tage aktiv · Ø 54 min/Ses │  │
│  │  ▁▂▄▃▅▆▇▅  7-Tage Trend   ↗$42  │  │
│  └───────────────────────────────────┘  │
│                                         │
│  ● Updated 2m ago                  ⚙   │
└─────────────────────────────────────────┘
```

**UX-Details:**
- Standardmäßig eingeklappt beim ersten Start (`insightsPanelOpen: false`)
- `∨` / `∧` Toggle merkt Zustand in Settings
- **Sparkline:** Reines SVG, 7 Balken (kein Chart.js), Claude orange + Codex grün, gemeinsam dargestellt
- **ROI-Farbe:** grün ≥ 2×, gelb 1–2×, grau < 1×
- Daten aus `analytics:summary` (gleicher IPC-Call wie Dashboard, gecacht bis nächster Refresh)

### 1.4 Neuer IPC-Channel: `analytics:summary`

**Main-Prozess** (`detailsWindow.ts`):

```typescript
interface AnalyticsSummary {
  apiCostUSD: { claude: number; codex: number; total: number };
  subscriptionCostUSD: { claude: number; codex: number; total: number };
  roiFactor: { claude: number; codex: number; combined: number };
  activeDays: number;                      // aus 30
  avgSessionMinutes: number;
  cacheHitRate: { claude: number; codex: number }; // 0.0–1.0
  sparkline7d: { date: string; claudeUSD: number; codexUSD: number }[]; // 7 Einträge
  topModels: { model: string; provider: "claude" | "codex"; costUSD: number; pctOfTotal: number }[];
  windowDays: number;                      // 7 | 30
}
```

Berechnung im Main-Prozess:
1. `reportService.generateUsageReport({ type: "daily", since: "-30d", provider: "claude" })` → tägliche Buckets
2. `reportService.generateUsageReport({ type: "daily", since: "-30d", provider: "codex" })` → tägliche Buckets
3. `reportService.generateUsageReport({ type: "session", since: "-30d" })` → Session-Daten für `activeDays` + `avgSessionMinutes`
4. Cache-Hit-Rate direkt aus Token-Aggregation berechnen

Cache: Ergebnis wird in `DetailsWindowController` gecacht und bei jedem `refreshLoop.onRefresh` invalidiert.

### 1.5 Neue Modell-Preise in `litellm-fetcher.ts`

Fallback-Preise für Codex-Modelle (pro Million Tokens):

| Modell (Prefix-Match) | Input | Output | Cache Read |
|---|---|---|---|
| `gpt-5.5` | $5.00 | $30.00 | $0.50 |
| `gpt-5.4-mini` | $0.75 | $4.50 | $0.075 |
| `gpt-5.4` | $2.50 | $15.00 | $0.25 |
| `gpt-5.2` | $1.75 | $14.00 | $0.175 |
| `gpt-5.1` | $1.25 | $10.00 | $0.125 |
| `gpt-5` | $1.25 | $10.00 | $0.125 |
| `gpt-4o` | $2.50 | $10.00 | $1.25 |

---

## Phase 2: Analytics-Tab

### 2.1 Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  ◆ QUOTABAR   [Live] [Analytics] [Reports]        ⊞  ⚙  ×         │
├─────────────────────────────────────────────────────────────────────┤
│  USAGE OVER TIME                              [5H] [24H] [7D] [30D] │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  100% ┤                                                      │   │
│  │   75% ┤    ╭──╮        ╭─╮     — claude (orange)            │   │
│  │   50% ┤───╯  ╰──╮  ╭──╯ ╰─── — codex  (grün)               │   │
│  │   25% ┤         ╰──╯                                        │   │
│  │    0% └──────────────────────────────────────────────────── │   │
│  └──────────────────────────────────────────────────────────────┘   │
├──────────────────────────────┬──────────────────────────────────────┤
│  USAGE BREAKDOWN (30D)       │  TOP MODELS BY COST (30D)            │
│    ╭──────╮  Claude  68%     │  MODELL            KOSTEN   % TOTAL  │
│   ╱  9.9×  ╲ Codex   25%    │  claude-sonnet-4-6  $144     48%     │
│  │   ROI    │ Gemini   7%    │  gpt-5.5           $212     —%*     │
│   ╲        ╱                │  claude-haiku-4-5    $8       3%     │
│    ╰──────╯                  │  claude-opus-4-7     $5       2%     │
├──────────────────────────────┴──────────────────────────────────────┤
│  AKTIVITÄTSSTATS (30D)                                              │
│  Aktive Tage  Cache-Hit  Ø Session  API-Kosten  ROI  Ges. Tokens   │
│    20/30       99.9%      54 min    $298.00    9.9×   376M+550M    │
└─────────────────────────────────────────────────────────────────────┘
```

*Codex-Kosten werden mit den neuen Fallback-Preisen aus Phase 1 berechnet.

### 2.2 Charts

**Usage Over Time (Liniendiagramm):** Chart.js `line`, zwei Datasets (Claude orange `#f59830`, Codex grün `#52d017`). Y-Achse: entweder `%` (5H-Window-Auslastung) oder `USD` (Kosten), via Toggle. X-Achse: Datum/Stunde je nach gewähltem Zeitfenster.

**Usage Breakdown (Donut):** Chart.js `doughnut`, drei Segmente (Claude / Codex / Gemini), Mittelbeschriftung zeigt ROI-Faktor.

**Aktivitätsstats-Zeile:** Keine Chart.js — einfache Kacheln analog zu Quick Stats in Phase 1.

### 2.3 Neuer IPC-Channel: `analytics:get`

```typescript
interface AnalyticsData extends AnalyticsSummary {
  dailyBuckets: {
    date: string;
    claudeUSD: number;
    codexUSD: number;
    claudeQuotaPct: number | null;   // 5h-Fenster-Auslastung wenn verfügbar
    codexQuotaPct: number | null;
  }[];
  sessionStats: {
    count: number;
    avgMinutes: number;
    totalHours: number;
    sessionsPerActiveDay: number;
  };
  totalTokens: {
    claude: { input: number; output: number; cacheRead: number; cacheCreate: number };
    codex:  { input: number; output: number; cached: number };
  };
}
```

---

## Phase 3: Reports-Tab

### 3.1 Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  ◆ QUOTABAR   [Live] [Analytics] [Reports]        ⊞  ⚙  ×         │
├─────────────────────────────────────────────┬───────────────────────┤
│  BERICHTE                                   │  EXPORT               │
│                                             │                        │
│  Provider: [Alle ▾]  Typ: [Täglich ▾]      │  Von: [2026-05-01]    │
│                                             │  Bis: [2026-05-19]    │
│  BERICHT         ZEITRAUM    STATUS         │  Format: [CSV] [JSON] │
│  Daily Report    19. Mai     Ready          │                        │
│  Weekly Summary  6–12. Mai   Ready          │  [Bericht generieren] │
│  Monthly         Apr–Mai     Ready          │                        │
│  Cost Export     12. Mai     Ready          │                        │
└─────────────────────────────────────────────┴───────────────────────┘
```

### 3.2 IPC-Channels

- `reports:generate` — ruft `reportService.generateUsageReport(request)` auf, gibt `ReportResult` zurück
- `reports:list` — gibt die letzten 10 generierten Reports aus dem In-Memory-Cache zurück
- `reports:export` — öffnet `dialog.showSaveDialog`, schreibt CSV oder JSON via `fs.writeFile` im Main-Prozess

**Export-Formate:**
- **CSV:** Eine Zeile pro `ReportRow`, Spalten: date, provider, model, inputTokens, outputTokens, cacheReadTokens, costUSD
- **JSON:** Vollständiges `ReportResult`-Objekt

---

## Phasenplan

| Phase | Inhalt | Neue Dateien | Geänderte Dateien |
|---|---|---|---|
| **1** | Window-System, Dashboard-Shell, Live-Tab, Compact-Insights, neue Modell-Preise | `tabs/live.js`, `shared/ipc.js`, `shared/format.js`, `shared/colors.js` | `index.html`, `detailsWindow.ts`, `settings.ts`, `litellm-fetcher.ts` |
| **2** | Analytics-Tab, Charts, `analytics:get` | `tabs/analytics.js`, `shared/charts.js`, `assets/vendor/chart.min.js` | `detailsWindow.ts`, `index.html` |
| **3** | Reports-Tab, Export | `tabs/reports.js` | `detailsWindow.ts`, `index.html` |

---

## Nicht im Scope

- Gemini-Kosten (keine JSONL-Logs, keine verlässlichen Preise)
- Alerts-Tab (Phase 3+ Folgearbeit)
- Sidebar-Modus / Top-Bar-Modus (Folge-Spec nach Phase 3)
- TypeScript im Renderer (kein Bundler, bleibt vanilla JS)
- Internationalisierung

---

## Offene Fragen (vor Implementierungsstart klären)

- Soll das Cost-Window-Pill-Grid aus dem Settings-Panel entfernt werden (nach Verschiebung ins rechte Live-Tab-Panel)?
- Soll `analyticsWindow` (7/30) separat vom `costWindow`-Setting sein, oder dasselbe Setting für beides?

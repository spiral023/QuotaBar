# Models-Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Neuer Dashboard-Tab „Models" mit 100%-Stacked-Modellverteilung, Preis-vs.-Intelligenz-Scatter, KPI-Kacheln, sortierbarer Tabelle und Insights — für Claude und Codex.

**Architecture:** Neuer Worker-Task `"models"` aggregiert Backfill-Records + Live-Tail im Main-Prozess zu einem tagesgenauen `ModelsData`-Payload (ein IPC-Call `models:get`, gecacht). Der Renderer rechnet Fenster/Metriken/Buckets lokal in puren Funktionen (`models-calc.js`, UMD, vitest-testbar) und rendert mit Chart.js.

**Tech Stack:** TypeScript (Main), Vanilla JS + Chart.js (Renderer), vitest.

**Spec:** `docs/superpowers/specs/2026-06-11-models-tab-design.md`

---

## Datei-Übersicht

| Datei | Aktion | Verantwortung |
|---|---|---|
| `src/shared/modelNames.ts` | Neu | Modellnamen-Normalisierung + Synthetic-Filter |
| `src/config/model-benchmarks.json` | Neu | Statische AA-Intelligence-Scores |
| `src/main/modelsData.ts` | Neu | `buildModelsData`: Backfill + Live-Tail + Benchmarks + Pricing |
| `src/main/analyticsWorker.ts` | Ändern | Worker-Task `"models"` |
| `src/main/detailsWindow.ts` | Ändern | `models:get`-Handler + Cache |
| `src/renderer/tabs/models-calc.js` | Neu | Pure Berechnungen (UMD, testbar) |
| `src/renderer/tabs/models.js` | Neu | Tab-Rendering, Charts, Interaktion |
| `src/renderer/shared/charts.js` | Ändern | `createStacked100`-Helper |
| `src/renderer/index.html` | Ändern | Tab-Button, View, Styles, Script-Includes |
| `tests/modelNames.test.ts` | Neu | Normalisierung |
| `tests/modelBenchmarks.test.ts` | Neu | JSON-Validierung |
| `tests/modelsData.test.ts` | Neu | Aggregation + Merge |
| `tests/modelsCalc.test.ts` | Neu | Renderer-Berechnungen |

---

### Task 1: Modellnamen-Normalisierung (`src/shared/modelNames.ts`)

**Files:**
- Create: `src/shared/modelNames.ts`
- Test: `tests/modelNames.test.ts`

- [ ] **Step 1: Failing Test schreiben**

```ts
// tests/modelNames.test.ts
import { describe, it, expect } from "vitest";
import { normalizeModelName, isIgnoredModel } from "../src/shared/modelNames";

describe("normalizeModelName", () => {
  it("strips date suffix from Claude model names", () => {
    expect(normalizeModelName("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizeModelName("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
  });

  it("leaves names without date suffix unchanged", () => {
    expect(normalizeModelName("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeModelName("gpt-5.3-codex")).toBe("gpt-5.3-codex");
    expect(normalizeModelName("gpt-5-codex-mini")).toBe("gpt-5-codex-mini");
  });

  it("does not strip version-like fragments that are not dates", () => {
    expect(normalizeModelName("gpt-5.4-mini")).toBe("gpt-5.4-mini");
  });
});

describe("isIgnoredModel", () => {
  it("ignores synthetic, unknown and empty", () => {
    expect(isIgnoredModel("<synthetic>")).toBe(true);
    expect(isIgnoredModel("unknown")).toBe(true);
    expect(isIgnoredModel("")).toBe(true);
  });

  it("keeps real model names", () => {
    expect(isIgnoredModel("claude-opus-4-8")).toBe(false);
    expect(isIgnoredModel("gpt-5.5")).toBe(false);
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run tests/modelNames.test.ts`
Expected: FAIL — `Cannot find module '../src/shared/modelNames'`

- [ ] **Step 3: Implementierung**

```ts
// src/shared/modelNames.ts

/** Strips Claude-style date suffixes: claude-haiku-4-5-20251001 → claude-haiku-4-5 */
const DATE_SUFFIX = /-20\d{6}$/;

export function normalizeModelName(model: string): string {
  return model.replace(DATE_SUFFIX, "");
}

/** Zero-cost artifacts that must not appear in charts or tables. */
export function isIgnoredModel(model: string): boolean {
  return model === "<synthetic>" || model === "unknown" || model === "";
}
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `npx vitest run tests/modelNames.test.ts`
Expected: PASS (5 Tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/modelNames.ts tests/modelNames.test.ts
git commit -m "feat(models): add model name normalization helpers"
```

---

### Task 2: Benchmark-JSON (`src/config/model-benchmarks.json`)

**Files:**
- Create: `src/config/model-benchmarks.json`
- Test: `tests/modelBenchmarks.test.ts`

Nur belegte Scores aufnehmen (Quelle: Artificial Analysis Intelligence Index, Screenshots vom 2026-06-11). Keine Scores erfinden — Modelle ohne Score erscheinen nicht im Scatter (Spec-Verhalten).

- [ ] **Step 1: Failing Test schreiben**

```ts
// tests/modelBenchmarks.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const FILE = path.join(__dirname, "..", "src", "config", "model-benchmarks.json");

describe("model-benchmarks.json", () => {
  const raw = () => JSON.parse(fs.readFileSync(FILE, "utf8")) as {
    source: string; asOf: string; scores: Record<string, unknown>;
  };

  it("exists and parses", () => {
    expect(() => raw()).not.toThrow();
  });

  it("has source and asOf in YYYY-MM form", () => {
    const json = raw();
    expect(json.source.length).toBeGreaterThan(0);
    expect(json.asOf).toMatch(/^\d{4}-\d{2}$/);
  });

  it("all scores are finite numbers in plausible range", () => {
    for (const [model, score] of Object.entries(raw().scores)) {
      expect(typeof score, model).toBe("number");
      expect(score as number, model).toBeGreaterThan(0);
      expect(score as number, model).toBeLessThan(100);
    }
  });

  it("all keys are normalized (no date suffix)", () => {
    for (const model of Object.keys(raw().scores)) {
      expect(model).not.toMatch(/-20\d{6}$/);
    }
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run tests/modelBenchmarks.test.ts`
Expected: FAIL — Datei existiert nicht (ENOENT)

- [ ] **Step 3: JSON anlegen**

```json
{
  "note": "Manuell gepflegt. Quelle: https://artificialanalysis.ai — Schlüssel in normalisierter Form (ohne Datums-Suffix). Modelle ohne Eintrag erscheinen nicht im Scatter.",
  "source": "Artificial Analysis Intelligence Index",
  "asOf": "2026-06",
  "scores": {
    "claude-opus-4-8": 61,
    "claude-opus-4-7": 57,
    "claude-sonnet-4-6": 52,
    "gpt-5.5": 59
  }
}
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `npx vitest run tests/modelBenchmarks.test.ts`
Expected: PASS (4 Tests)

- [ ] **Step 5: Commit**

```bash
git add src/config/model-benchmarks.json tests/modelBenchmarks.test.ts
git commit -m "feat(models): add static Artificial Analysis benchmark scores"
```

---

### Task 3: `modelsData.ts` — Backfill-Aggregation

**Files:**
- Create: `src/main/modelsData.ts`
- Test: `tests/modelsData.test.ts`

- [ ] **Step 1: Failing Test schreiben**

```ts
// tests/modelsData.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildModelsData } from "../src/main/modelsData";
import { defaultSettings } from "../src/config/settings";
import type { BackfillDayRecord } from "../src/reports/types";

const SETTINGS = { ...defaultSettings, pricingOfflineMode: true };
const BENCHMARKS_FILE = path.join(__dirname, "..", "src", "config", "model-benchmarks.json");

function record(
  date: string,
  provider: "claude" | "codex",
  perModel: BackfillDayRecord["perModel"],
): BackfillDayRecord {
  const totals = Object.values(perModel).reduce(
    (acc, m) => ({
      inputTokens: acc.inputTokens + m.inputTokens,
      outputTokens: acc.outputTokens + m.outputTokens,
      cacheCreationTokens: acc.cacheCreationTokens + m.cacheCreationTokens,
      cacheReadTokens: acc.cacheReadTokens + m.cacheReadTokens,
      totalTokens: acc.totalTokens + m.totalTokens,
      costUSD: acc.costUSD + m.costUSD,
    }),
    { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUSD: 0 },
  );
  return { date, provider, ...totals, sessionCount: 1, models: Object.keys(perModel), perModel };
}

const PM = (input: number, output: number, costUSD: number) => ({
  inputTokens: input, outputTokens: output,
  cacheCreationTokens: 0, cacheReadTokens: 0,
  totalTokens: input + output, costUSD,
});

describe("buildModelsData — backfill aggregation", () => {
  it("emits one ModelDay per date/provider/model", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [
        record("2026-01-01", "claude", { "claude-opus-4-8": PM(100, 50, 1.5) }),
        record("2026-01-01", "codex",  { "gpt-5.5": PM(200, 80, 0.9) }),
        record("2026-01-02", "claude", { "claude-opus-4-8": PM(10, 5, 0.2) }),
      ],
      claudeEntries: [],
      codexEvents: [],
    });
    expect(data.days).toHaveLength(3);
    const d1 = data.days.find(d => d.date === "2026-01-01" && d.provider === "claude");
    expect(d1?.model).toBe("claude-opus-4-8");
    expect(d1?.costUSD).toBeCloseTo(1.5);
  });

  it("normalizes model names and merges entries that collapse to the same name", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [
        record("2026-01-01", "claude", {
          "claude-haiku-4-5-20251001": PM(100, 10, 0.1),
          "claude-haiku-4-5":          PM(50, 5, 0.05),
        }),
      ],
      claudeEntries: [],
      codexEvents: [],
    });
    expect(data.days).toHaveLength(1);
    expect(data.days[0].model).toBe("claude-haiku-4-5");
    expect(data.days[0].inputTokens).toBe(150);
    expect(data.days[0].costUSD).toBeCloseTo(0.15);
  });

  it("filters synthetic and unknown models", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [
        record("2026-01-01", "claude", {
          "<synthetic>": PM(5, 1, 0),
          "unknown":     PM(5, 1, 0),
          "claude-opus-4-8": PM(100, 50, 1.0),
        }),
      ],
      claudeEntries: [],
      codexEvents: [],
    });
    expect(data.days).toHaveLength(1);
    expect(data.days[0].model).toBe("claude-opus-4-8");
  });

  it("days are sorted by date ascending", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [
        record("2026-01-03", "claude", { "claude-opus-4-8": PM(1, 1, 0.1) }),
        record("2026-01-01", "claude", { "claude-opus-4-8": PM(1, 1, 0.1) }),
      ],
      claudeEntries: [],
      codexEvents: [],
    });
    expect(data.days.map(d => d.date)).toEqual(["2026-01-01", "2026-01-03"]);
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run tests/modelsData.test.ts`
Expected: FAIL — `Cannot find module '../src/main/modelsData'`

- [ ] **Step 3: Implementierung (Backfill-Teil + Benchmarks-Laden, Live-Tail folgt in Task 4)**

```ts
// src/main/modelsData.ts
import fs from "node:fs/promises";
import path from "node:path";
import type { Settings } from "../config/settings";
import { defaultSettings } from "../config/settings";
import { getDebugLogDir } from "../config/paths";
import { readBackfillDayRecords } from "../reports/backfill-reader";
import { generateUsageReport } from "../reports/reportService";
import type { BackfillDayRecord } from "../reports/types";
import type { ClaudeUsageEntry } from "../pricing/jsonl-reader";
import type { CodexTokenEvent } from "../pricing/codex-log-reader";
import { LiteLLMFetcher } from "../pricing/litellm-fetcher";
import { normalizeModelName, isIgnoredModel } from "../shared/modelNames";

export interface ModelDay {
  date: string; // YYYY-MM-DD (UTC)
  provider: "claude" | "codex";
  model: string; // normalisiert
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number; // Codex: immer 0
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
}

export interface ModelPricingRate {
  inputPerMTok: number;
  cacheReadPerMTok: number;
}

export interface ModelsData {
  days: ModelDay[];
  benchmarks: Record<string, number>;
  benchmarksAsOf: string;
  pricing: Record<string, ModelPricingRate>;
  generatedAt: string;
}

export interface ModelsDataDeps {
  settings?: Settings;
  backfillRecords?: BackfillDayRecord[];
  backfillLogDir?: string;
  claudeEntries?: ClaudeUsageEntry[];
  codexEvents?: CodexTokenEvent[];
  benchmarksFile?: string;
}

// tsc kopiert keine JSON-Dateien nach dist/ — zur Laufzeit aus src/ lesen,
// gleiches Muster wie das Laden von index.html in detailsWindow.ts.
const DEFAULT_BENCHMARKS_FILE = path.join(__dirname, "..", "..", "src", "config", "model-benchmarks.json");

export async function buildModelsData(deps: ModelsDataDeps = {}): Promise<ModelsData> {
  const settings = deps.settings ?? defaultSettings;
  const records = deps.backfillRecords
    ?? await readBackfillDayRecords(deps.backfillLogDir ?? getDebugLogDir());

  const dayMap = new Map<string, ModelDay>();
  for (const r of records) {
    for (const [rawModel, pm] of Object.entries(r.perModel)) {
      addDay(dayMap, r.date, r.provider, rawModel, {
        inputTokens: pm.inputTokens,
        outputTokens: pm.outputTokens,
        cacheCreationTokens: pm.cacheCreationTokens,
        cacheReadTokens: pm.cacheReadTokens,
        totalTokens: pm.totalTokens,
        costUSD: pm.costUSD,
      });
    }
  }

  await mergeLiveTail(dayMap, records, settings, deps);

  const days = Array.from(dayMap.values())
    .sort((a, b) => a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

  const { benchmarks, benchmarksAsOf } = await readBenchmarks(deps.benchmarksFile ?? DEFAULT_BENCHMARKS_FILE);
  const pricing = await collectPricing(days, settings);

  return { days, benchmarks, benchmarksAsOf, pricing, generatedAt: new Date().toISOString() };
}

type DayTotals = Omit<ModelDay, "date" | "provider" | "model">;

function addDay(
  map: Map<string, ModelDay>,
  date: string,
  provider: "claude" | "codex",
  rawModel: string,
  totals: DayTotals,
): void {
  if (isIgnoredModel(rawModel)) return;
  const model = normalizeModelName(rawModel);
  const key = `${date}\0${provider}\0${model}`;
  const existing = map.get(key);
  if (existing) {
    existing.inputTokens += totals.inputTokens;
    existing.outputTokens += totals.outputTokens;
    existing.cacheCreationTokens += totals.cacheCreationTokens;
    existing.cacheReadTokens += totals.cacheReadTokens;
    existing.totalTokens += totals.totalTokens;
    existing.costUSD += totals.costUSD;
  } else {
    map.set(key, { date, provider, model, ...totals });
  }
}

// Live-Tail: wird in Task 4 implementiert.
async function mergeLiveTail(
  _dayMap: Map<string, ModelDay>,
  _records: BackfillDayRecord[],
  _settings: Settings,
  _deps: ModelsDataDeps,
): Promise<void> {
  // noch leer
}

async function readBenchmarks(file: string): Promise<{ benchmarks: Record<string, number>; benchmarksAsOf: string }> {
  try {
    const json = JSON.parse(await fs.readFile(file, "utf8")) as {
      asOf?: string;
      scores?: Record<string, unknown>;
    };
    const benchmarks: Record<string, number> = {};
    for (const [model, score] of Object.entries(json.scores ?? {})) {
      if (typeof score === "number" && Number.isFinite(score)) benchmarks[model] = score;
    }
    return { benchmarks, benchmarksAsOf: json.asOf ?? "" };
  } catch {
    // Spec-Fehlerfall: JSON fehlt/defekt → leere Benchmarks, Renderer blendet Scatter aus
    return { benchmarks: {}, benchmarksAsOf: "" };
  }
}

async function collectPricing(days: ModelDay[], settings: Settings): Promise<Record<string, ModelPricingRate>> {
  const fetcher = new LiteLLMFetcher(settings.pricingOfflineMode);
  const result: Record<string, ModelPricingRate> = {};
  const models = new Set(days.map(d => d.model));
  for (const model of models) {
    const p = await fetcher.getModelPricing(model);
    if (!p || typeof p.input_cost_per_token !== "number") continue;
    result[model] = {
      inputPerMTok: p.input_cost_per_token * 1e6,
      cacheReadPerMTok: (p.cache_read_input_token_cost ?? 0) * 1e6,
    };
  }
  return result;
}
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `npx vitest run tests/modelsData.test.ts`
Expected: PASS (4 Tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/modelsData.ts tests/modelsData.test.ts
git commit -m "feat(models): aggregate backfill records into per-model day buckets"
```

---

### Task 4: `modelsData.ts` — Live-Tail-Merge

**Files:**
- Modify: `src/main/modelsData.ts` (Funktion `mergeLiveTail`)
- Test: `tests/modelsData.test.ts` (erweitern)

- [ ] **Step 1: Failing Tests ergänzen**

In `tests/modelsData.test.ts` anhängen:

```ts
import type { ClaudeUsageEntry } from "../src/pricing/jsonl-reader";
import type { CodexTokenEvent } from "../src/pricing/codex-log-reader";

function claudeEntry(isoTs: string, model: string, output: number): ClaudeUsageEntry {
  return {
    provider: "claude", timestamp: isoTs, model,
    project: "p", session: "s",
    inputTokens: 10, outputTokens: output, cacheCreationTokens: 0, cacheReadTokens: 0,
    costUSD: 0.5,
  };
}

function codexEvent(isoTs: string, model: string, output: number): CodexTokenEvent {
  return {
    timestamp: isoTs, model, isFallback: false, session: "s", directory: ".",
    inputTokens: 10, cachedInputTokens: 0, outputTokens: output,
    reasoningOutputTokens: 0, totalTokens: 10 + output,
  };
}

describe("buildModelsData — live tail merge", () => {
  it("adds live days strictly after the provider's last backfill date", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [
        record("2026-01-10", "claude", { "claude-opus-4-8": PM(100, 50, 1.0) }),
      ],
      claudeEntries: [
        claudeEntry("2026-01-10T12:00:00.000Z", "claude-opus-4-8", 99),  // selber Tag → ignoriert
        claudeEntry("2026-01-11T12:00:00.000Z", "claude-opus-4-8", 42),  // danach → übernommen
      ],
      codexEvents: [],
    });
    const backfillDay = data.days.find(d => d.date === "2026-01-10");
    expect(backfillDay?.outputTokens).toBe(50); // unverändert, kein Doppelzählen
    const liveDay = data.days.find(d => d.date === "2026-01-11");
    expect(liveDay?.outputTokens).toBe(42);
  });

  it("falls back to live-only when a provider has no backfill records", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [],
      claudeEntries: [claudeEntry("2026-01-05T08:00:00.000Z", "claude-sonnet-4-6", 7)],
      codexEvents: [codexEvent("2026-01-06T08:00:00.000Z", "gpt-5.5", 11)],
    });
    expect(data.days.find(d => d.provider === "claude")?.date).toBe("2026-01-05");
    expect(data.days.find(d => d.provider === "codex")?.date).toBe("2026-01-06");
  });

  it("normalizes live model names too", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [],
      claudeEntries: [claudeEntry("2026-01-05T08:00:00.000Z", "claude-haiku-4-5-20251001", 3)],
      codexEvents: [],
    });
    expect(data.days[0].model).toBe("claude-haiku-4-5");
  });
});
```

- [ ] **Step 2: Tests laufen lassen — neue müssen fehlschlagen**

Run: `npx vitest run tests/modelsData.test.ts`
Expected: FAIL — Live-Tage fehlen (`mergeLiveTail` ist leer)

- [ ] **Step 3: `mergeLiveTail` implementieren**

Den Platzhalter in `src/main/modelsData.ts` ersetzen:

```ts
/**
 * Ergänzt Tage, die strikt NACH dem letzten Backfill-Datum des jeweiligen
 * Providers liegen, aus den Live-JSONLs. Backfill-Tage werden nie ersetzt
 * (kein Doppelzählen am Schnitt-Tag). timezone "UTC" hält die Datums-Semantik
 * identisch zu den Backfill-Records (UTC-Tageskeys).
 */
async function mergeLiveTail(
  dayMap: Map<string, ModelDay>,
  records: BackfillDayRecord[],
  settings: Settings,
  deps: ModelsDataDeps,
): Promise<void> {
  for (const provider of ["claude", "codex"] as const) {
    const lastBackfillDate = records
      .filter(r => r.provider === provider)
      .reduce<string | undefined>((max, r) => (!max || r.date > max ? r.date : max), undefined);

    const report = await generateUsageReport(
      {
        provider,
        type: "daily",
        timezone: "UTC",
        order: "asc",
        breakdown: true,
        ...(lastBackfillDate ? { since: lastBackfillDate } : {}),
      },
      {
        settings,
        ...(deps.claudeEntries ? { claudeEntries: deps.claudeEntries } : {}),
        ...(deps.codexEvents ? { codexEvents: deps.codexEvents } : {}),
      },
    );

    for (const row of report.rows) {
      if (lastBackfillDate && row.bucket <= lastBackfillDate) continue; // strikt danach
      for (const b of row.modelBreakdowns ?? []) {
        addDay(dayMap, row.bucket, provider, b.model, {
          inputTokens: b.inputTokens,
          outputTokens: b.outputTokens,
          cacheCreationTokens: b.cacheCreationTokens,
          cacheReadTokens: b.cacheReadTokens,
          totalTokens: b.totalTokens,
          costUSD: b.costUSD,
        });
      }
    }
  }
}
```

**Wichtig:** In Tests immer `claudeEntries: []` / `codexEvents: []` explizit übergeben (leeres Array ≠ undefined) — sonst liest `generateUsageReport` die echten lokalen Logs. Die Tests aus Task 3 tun das bereits.

- [ ] **Step 4: Alle modelsData-Tests laufen lassen**

Run: `npx vitest run tests/modelsData.test.ts`
Expected: PASS (7 Tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/modelsData.ts tests/modelsData.test.ts
git commit -m "feat(models): merge live tail after last backfill date per provider"
```

---

### Task 5: Pricing im Payload

**Files:**
- Modify: `src/main/modelsData.ts` (bereits in Task 3 angelegt — hier nur Test)
- Test: `tests/modelsData.test.ts` (erweitern)

`collectPricing` existiert seit Task 3; dieser Task verifiziert es.

- [ ] **Step 1: Test ergänzen**

```ts
describe("buildModelsData — pricing & benchmarks", () => {
  it("includes per-model pricing rates from offline fallback prices", async () => {
    const data = await buildModelsData({
      settings: SETTINGS, // pricingOfflineMode: true → deterministische FALLBACK_PRICES
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [record("2026-01-01", "claude", { "claude-haiku-4-5": PM(10, 5, 0.01) })],
      claudeEntries: [],
      codexEvents: [],
    });
    const rate = data.pricing["claude-haiku-4-5"];
    expect(rate).toBeDefined();
    expect(rate.inputPerMTok).toBeCloseTo(0.8);      // 8e-7 × 1e6
    expect(rate.cacheReadPerMTok).toBeCloseTo(0.08); // 8e-8 × 1e6
  });

  it("exposes benchmark scores with asOf", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: BENCHMARKS_FILE,
      backfillRecords: [],
      claudeEntries: [],
      codexEvents: [],
    });
    expect(data.benchmarks["claude-opus-4-8"]).toBe(61);
    expect(data.benchmarksAsOf).toMatch(/^\d{4}-\d{2}$/);
  });

  it("returns empty benchmarks when the file is missing (spec error case)", async () => {
    const data = await buildModelsData({
      settings: SETTINGS,
      benchmarksFile: path.join(__dirname, "does-not-exist.json"),
      backfillRecords: [],
      claudeEntries: [],
      codexEvents: [],
    });
    expect(data.benchmarks).toEqual({});
    expect(data.benchmarksAsOf).toBe("");
  });
});
```

- [ ] **Step 2: Tests laufen lassen**

Run: `npx vitest run tests/modelsData.test.ts`
Expected: PASS (10 Tests) — falls FAIL, `collectPricing`/`readBenchmarks` gegen Task-3-Code prüfen

- [ ] **Step 3: Commit**

```bash
git add tests/modelsData.test.ts
git commit -m "test(models): cover pricing rates and benchmark loading"
```

---

### Task 6: Worker-Task `"models"` + IPC-Handler `models:get`

**Files:**
- Modify: `src/main/analyticsWorker.ts:15-24` (WorkerInput-Union) und `:26-27` (run-Branch)
- Modify: `src/main/detailsWindow.ts:33-35` (Cache), `:115-118` (clear), nach `:270` (Handler)

- [ ] **Step 1: WorkerInput zur Union machen**

In `src/main/analyticsWorker.ts` den Import ergänzen und das Interface ersetzen:

```ts
import { buildModelsData, type ModelsData } from "./modelsData";
```

```ts
// ersetzt: interface WorkerInput { task: "get" | "summary"; ... }
interface AnalyticsTaskInput {
  task: "get" | "summary";
  claudeProjectsDirs: string[];
  codexSessionsDirs: string[];
  periodStartMs: number;
  windowDays: number;
  since: string;
  settings: Settings;
  cacheHitRate: { claude: number; codex: number };
}

interface ModelsTaskInput {
  task: "models";
  settings: Settings;
}

type WorkerInput = AnalyticsTaskInput | ModelsTaskInput;
```

Und am Anfang von `run()`:

```ts
async function run(input: WorkerInput): Promise<AnalyticsSummary | AnalyticsData | ModelsData> {
  if (input.task === "models") {
    return buildModelsData({ settings: input.settings });
  }
  // ... bestehender Code unverändert (input ist hier AnalyticsTaskInput)
```

- [ ] **Step 2: Build prüfen**

Run: `npm run build`
Expected: kein TypeScript-Fehler

- [ ] **Step 3: detailsWindow verdrahten**

In `src/main/detailsWindow.ts`:

```ts
// Import ergänzen (bei den anderen Type-Imports):
import type { ModelsData } from "./modelsData";

// Bei den Caches (nach analyticsDataCache, Zeile ~34):
private readonly modelsDataCache = new AsyncResultCache<ModelsData>();

// In clearAnalyticsCaches():
this.modelsDataCache.clear();

// In registerIpcHandlers(), direkt nach dem "analytics:get"-Handler:
ipcMain.handle("models:get", async () => {
  const settings = await loadSettings();
  return this.modelsDataCache.get("models", () => runAnalyticsWorker({
    task: "models",
    settings,
  }) as Promise<ModelsData>);
});
```

- [ ] **Step 4: Build + alle Tests**

Run: `npm run build && npx vitest run`
Expected: Build OK, alle Tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/analyticsWorker.ts src/main/detailsWindow.ts
git commit -m "feat(models): add models worker task and models:get IPC handler"
```

---

### Task 7: `models-calc.js` — Fenster, Metriken, ISO-Wochen

**Files:**
- Create: `src/renderer/tabs/models-calc.js`
- Test: `tests/modelsCalc.test.ts`

UMD-Muster: im Renderer als `QB.modelsCalc` verfügbar, in vitest per `require` importierbar.

- [ ] **Step 1: Failing Tests schreiben**

```ts
// tests/modelsCalc.test.ts
import { describe, it, expect } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const calc = require("../src/renderer/tabs/models-calc.js");

type Day = {
  date: string; provider: "claude" | "codex"; model: string;
  inputTokens: number; outputTokens: number;
  cacheCreationTokens: number; cacheReadTokens: number;
  totalTokens: number; costUSD: number;
};

function day(date: string, model: string, over: Partial<Day> = {}): Day {
  return {
    date, model,
    provider: model.startsWith("claude") ? "claude" : "codex",
    inputTokens: 100, outputTokens: 50,
    cacheCreationTokens: 0, cacheReadTokens: 0,
    totalTokens: 150, costUSD: 1,
    ...over,
  };
}

describe("filterWindow", () => {
  const days = [day("2026-01-01", "gpt-5.5"), day("2026-03-01", "gpt-5.5"), day("2026-03-10", "gpt-5.5")];

  it("'all' returns everything", () => {
    expect(calc.filterWindow(days, "all", "2026-03-10")).toHaveLength(3);
  });

  it("'30d' keeps the last 30 days including today", () => {
    const result = calc.filterWindow(days, "30d", "2026-03-10");
    expect(result.map((d: Day) => d.date)).toEqual(["2026-03-01", "2026-03-10"]);
  });

  it("previousWindow returns the same-length window before", () => {
    const prev = calc.previousWindow(days, "30d", "2026-03-10");
    expect(prev.map((d: Day) => d.date)).toEqual(["2026-01-01"].filter(d => d >= "2026-01-10"));
    // 2026-01-01 liegt vor dem Vorfenster (2026-01-10..2026-02-08) → leer
    expect(prev).toHaveLength(0);
  });
});

describe("metricOf", () => {
  const d = day("2026-01-01", "gpt-5.5", {
    inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3,
    cacheReadTokens: 4, totalTokens: 10, costUSD: 5,
  });
  it("maps every metric key", () => {
    expect(calc.metricOf(d, "input")).toBe(1);
    expect(calc.metricOf(d, "output")).toBe(2);
    expect(calc.metricOf(d, "cacheCreation")).toBe(3);
    expect(calc.metricOf(d, "cacheRead")).toBe(4);
    expect(calc.metricOf(d, "total")).toBe(10);
    expect(calc.metricOf(d, "cost")).toBe(5);
  });
});

describe("isoWeek", () => {
  it("matches the reportService ISO week semantics", () => {
    expect(calc.isoWeek("2026-01-01")).toBe("2026-W01");
    expect(calc.isoWeek("2025-12-29")).toBe("2026-W01"); // Montag der Woche 1/2026
    expect(calc.isoWeek("2025-09-24")).toBe("2025-W39");
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `npx vitest run tests/modelsCalc.test.ts`
Expected: FAIL — Modul existiert nicht

- [ ] **Step 3: Modul-Grundgerüst implementieren**

```js
// src/renderer/tabs/models-calc.js
// Pure Berechnungen für den Models-Tab. UMD: läuft im Renderer (QB.modelsCalc)
// und in vitest (module.exports). KEINE DOM- oder Chart.js-Abhängigkeiten.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.QB = root.QB || {}; root.QB.modelsCalc = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isoAddDays(iso, delta) {
    const dt = new Date(iso + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + delta);
    return dt.toISOString().slice(0, 10);
  }

  function windowDays(win) { return win === '30d' ? 30 : 90; }

  // win: '30d' | '90d' | 'all'; today: 'YYYY-MM-DD'
  function filterWindow(days, win, today) {
    if (win === 'all') return days.slice();
    const start = isoAddDays(today, -(windowDays(win) - 1));
    return days.filter((d) => d.date >= start && d.date <= today);
  }

  // Gleich langes Fenster unmittelbar davor (Spec: „Vorperiode").
  function previousWindow(days, win, today) {
    if (win === 'all') return [];
    const n = windowDays(win);
    const start = isoAddDays(today, -(2 * n - 1));
    const end = isoAddDays(today, -n);
    return days.filter((d) => d.date >= start && d.date <= end);
  }

  function metricOf(d, metric) {
    switch (metric) {
      case 'input':         return d.inputTokens;
      case 'output':        return d.outputTokens;
      case 'cacheRead':     return d.cacheReadTokens;
      case 'cacheCreation': return d.cacheCreationTokens;
      case 'cost':          return d.costUSD;
      default:              return d.totalTokens;
    }
  }

  // Identische Semantik wie isoWeekBucket in src/reports/reportService.ts.
  function isoWeek(iso) {
    const date = new Date(iso + 'T00:00:00Z');
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return date.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
  }

  return { isoAddDays, filterWindow, previousWindow, metricOf, isoWeek };
});
```

- [ ] **Step 4: Tests laufen lassen — müssen bestehen**

Run: `npx vitest run tests/modelsCalc.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/tabs/models-calc.js tests/modelsCalc.test.ts
git commit -m "feat(models): add window/metric/iso-week calc helpers (UMD)"
```

---

### Task 8: `models-calc.js` — Stack-Serien, „Andere", Farb-Reihenfolge

**Files:**
- Modify: `src/renderer/tabs/models-calc.js`
- Test: `tests/modelsCalc.test.ts` (erweitern)

- [ ] **Step 1: Failing Tests ergänzen**

```ts
describe("buildStack", () => {
  const days = [
    day("2026-01-05", "claude-opus-4-8", { outputTokens: 80 }),
    day("2026-01-05", "gpt-5.5",         { outputTokens: 20 }),
    day("2026-01-12", "claude-opus-4-8", { outputTokens: 50 }),
  ];

  it("groups daily when granularity is 'daily'", () => {
    const s = calc.buildStack(days, "output", "daily", 0);
    expect(s.buckets).toEqual(["2026-01-05", "2026-01-12"]);
    const opus = s.series.find((x: any) => x.model === "claude-opus-4-8");
    expect(opus.values).toEqual([80, 50]);
  });

  it("groups by ISO week when granularity is 'weekly'", () => {
    const s = calc.buildStack(days, "output", "weekly", 0);
    expect(s.buckets).toEqual(["2026-W02", "2026-W03"]);
  });

  it("folds models below the share threshold into 'Andere'", () => {
    const withTiny = [...days, day("2026-01-05", "gpt-5.4-mini", { outputTokens: 1 })];
    const s = calc.buildStack(withTiny, "output", "daily", 0.05);
    expect(s.series.map((x: any) => x.model)).toContain("Andere");
    expect(s.series.map((x: any) => x.model)).not.toContain("gpt-5.4-mini");
    expect(s.othersGrouped).toEqual(["gpt-5.4-mini"]);
  });

  it("'Andere' is always the last series", () => {
    const withTiny = [...days, day("2026-01-05", "gpt-5.4-mini", { outputTokens: 1 })];
    const s = calc.buildStack(withTiny, "output", "daily", 0.05);
    expect(s.series[s.series.length - 1].model).toBe("Andere");
  });
});

describe("modelColorOrder", () => {
  it("orders models by first appearance date", () => {
    const days2 = [
      day("2026-02-01", "gpt-5.5"),
      day("2026-01-01", "claude-opus-4-8"),
      day("2026-01-15", "gpt-5.4"),
    ];
    expect(calc.modelColorOrder(days2)).toEqual(["claude-opus-4-8", "gpt-5.4", "gpt-5.5"]);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — neue müssen fehlschlagen**

Run: `npx vitest run tests/modelsCalc.test.ts`
Expected: FAIL — `buildStack is not a function`

- [ ] **Step 3: Implementieren**

In `models-calc.js` vor dem `return` einfügen und das `return`-Objekt erweitern:

```js
  /**
   * → { buckets: string[], series: [{ model, provider, values: number[] }], othersGrouped: string[] }
   * series enthält absolute Werte; die 100%-Normalisierung passiert beim Chart-Aufbau.
   * othersThreshold: Anteil am Gesamtwert des Fensters, unter dem ein Modell in „Andere" fällt (z.B. 0.01).
   */
  function buildStack(days, metric, granularity, othersThreshold) {
    const bucketOf = granularity === 'weekly' ? (d) => isoWeek(d.date) : (d) => d.date;
    const buckets = Array.from(new Set(days.map(bucketOf))).sort();
    const idx = new Map(buckets.map((b, i) => [b, i]));

    const perModel = new Map(); // model → { provider, values[] , sum }
    let grandTotal = 0;
    for (const d of days) {
      const v = metricOf(d, metric);
      grandTotal += v;
      let entry = perModel.get(d.model);
      if (!entry) {
        entry = { provider: d.provider, values: new Array(buckets.length).fill(0), sum: 0 };
        perModel.set(d.model, entry);
      }
      entry.values[idx.get(bucketOf(d))] += v;
      entry.sum += v;
    }

    const series = [];
    const othersGrouped = [];
    let others = null;
    for (const [model, e] of perModel) {
      if (grandTotal > 0 && e.sum / grandTotal < othersThreshold) {
        othersGrouped.push(model);
        if (!others) others = { model: 'Andere', provider: 'other', values: new Array(buckets.length).fill(0) };
        for (let i = 0; i < e.values.length; i++) others.values[i] += e.values[i];
      } else {
        series.push({ model, provider: e.provider, values: e.values });
      }
    }
    series.sort((a, b) => a.model.localeCompare(b.model));
    if (others) series.push(others);
    othersGrouped.sort();
    return { buckets, series, othersGrouped };
  }

  // Reihenfolge des ERSTEN Auftretens über die GESAMTE Historie — Basis für
  // stabile Farbzuordnung über Fenster-/Metrikwechsel hinweg (Spec „Farben").
  function modelColorOrder(allDays) {
    const first = new Map();
    for (const d of allDays) {
      const cur = first.get(d.model);
      if (!cur || d.date < cur) first.set(d.model, d.date);
    }
    return Array.from(first.entries())
      .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
      .map(([model]) => model);
  }
```

`return`-Objekt erweitern: `{ isoAddDays, filterWindow, previousWindow, metricOf, isoWeek, buildStack, modelColorOrder }`

- [ ] **Step 4: Tests laufen lassen**

Run: `npx vitest run tests/modelsCalc.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/tabs/models-calc.js tests/modelsCalc.test.ts
git commit -m "feat(models): stacked series builder with Andere grouping and stable color order"
```

---

### Task 9: `models-calc.js` — KPIs und Tabellenzeilen

**Files:**
- Modify: `src/renderer/tabs/models-calc.js`
- Test: `tests/modelsCalc.test.ts` (erweitern)

- [ ] **Step 1: Failing Tests ergänzen**

```ts
const BENCH = { "claude-opus-4-8": 61, "gpt-5.5": 59 };

describe("computeKpis", () => {
  const cur = [
    day("2026-03-01", "claude-opus-4-8", { outputTokens: 100, totalTokens: 1_000_000, costUSD: 3 }),
    day("2026-03-02", "gpt-5.5",         { outputTokens: 300, totalTokens: 1_000_000, costUSD: 1 }),
  ];
  const prev = [
    day("2026-02-01", "claude-opus-4-8", { totalTokens: 1_000_000, costUSD: 8 }),
  ];

  it("counts active models and delta vs previous window", () => {
    const k = calc.computeKpis(cur, prev, BENCH);
    expect(k.activeModels).toBe(2);
    expect(k.activeModelsDelta).toBe(1);
  });

  it("identifies top model by cost and by output", () => {
    const k = calc.computeKpis(cur, prev, BENCH);
    expect(k.topCost.model).toBe("claude-opus-4-8");
    expect(k.topCost.sharePct).toBeCloseTo(75);
    expect(k.topOutput.model).toBe("gpt-5.5");
  });

  it("computes effective $/MTok and delta vs previous window", () => {
    const k = calc.computeKpis(cur, prev, BENCH);
    expect(k.effPerMTok).toBeCloseTo(2);        // $4 / 2M tok × 1M
    expect(k.effPerMTokDeltaPct).toBeCloseTo(-75); // vorher $8/MTok
  });

  it("nulls deltas when previous window is empty (window 'all')", () => {
    const k = calc.computeKpis(cur, [], BENCH);
    expect(k.activeModelsDelta).toBeNull();
    expect(k.effPerMTokDeltaPct).toBeNull();
  });

  it("picks best value model (score per effective $/MTok)", () => {
    const k = calc.computeKpis(cur, prev, BENCH);
    // opus: 61 / 3 ≈ 20.3 — gpt-5.5: 59 / 1 = 59 → gpt-5.5
    expect(k.bestValue.model).toBe("gpt-5.5");
  });

  it("computes top-3 cost concentration", () => {
    const k = calc.computeKpis(cur, prev, BENCH);
    expect(k.top3SharePct).toBe(100); // nur 2 Modelle
  });
});

describe("tableRows", () => {
  const days = [
    day("2026-03-01", "claude-opus-4-8", {
      inputTokens: 100, cacheReadTokens: 300, outputTokens: 50,
      totalTokens: 1_000_000, costUSD: 2,
    }),
    day("2026-03-05", "claude-opus-4-8", {
      inputTokens: 100, cacheReadTokens: 100, outputTokens: 50,
      totalTokens: 1_000_000, costUSD: 2,
    }),
  ];

  it("aggregates per model with first/last usage and cache hit rate", () => {
    const rows = calc.tableRows(days, BENCH);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.firstUsed).toBe("2026-03-01");
    expect(r.lastUsed).toBe("2026-03-05");
    expect(r.cacheHitRate).toBeCloseTo(400 / 600); // cacheRead/(input+cacheRead)
    expect(r.effPerMTok).toBeCloseTo(2);           // $4 / 2M × 1M
    expect(r.score).toBe(61);
    expect(r.scorePerDollar).toBeCloseTo(61 / 2);
  });

  it("sets score and scorePerDollar to null for unknown models", () => {
    const rows = calc.tableRows([day("2026-03-01", "gpt-5-codex-mini")], BENCH);
    expect(rows[0].score).toBeNull();
    expect(rows[0].scorePerDollar).toBeNull();
  });

  it("sorts by cost descending by default", () => {
    const rows = calc.tableRows([
      day("2026-03-01", "gpt-5.5", { costUSD: 1 }),
      day("2026-03-01", "claude-opus-4-8", { costUSD: 9 }),
    ], BENCH);
    expect(rows[0].model).toBe("claude-opus-4-8");
  });
});
```

- [ ] **Step 2: Tests laufen lassen — neue müssen fehlschlagen**

Run: `npx vitest run tests/modelsCalc.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementieren**

```js
  function aggregateByModel(days) {
    const map = new Map();
    for (const d of days) {
      let m = map.get(d.model);
      if (!m) {
        m = {
          model: d.model, provider: d.provider,
          inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0,
          cacheReadTokens: 0, totalTokens: 0, costUSD: 0,
          firstUsed: d.date, lastUsed: d.date,
        };
        map.set(d.model, m);
      }
      m.inputTokens += d.inputTokens;
      m.outputTokens += d.outputTokens;
      m.cacheCreationTokens += d.cacheCreationTokens;
      m.cacheReadTokens += d.cacheReadTokens;
      m.totalTokens += d.totalTokens;
      m.costUSD += d.costUSD;
      if (d.date < m.firstUsed) m.firstUsed = d.date;
      if (d.date > m.lastUsed) m.lastUsed = d.date;
    }
    return Array.from(map.values());
  }

  // null bei costUSD 0 (Modell ohne Pricing, Spec-Fehlerfall) oder 0 Tokens.
  function effPerMTokOf(costUSD, totalTokens) {
    return costUSD > 0 && totalTokens > 0 ? (costUSD / totalTokens) * 1e6 : null;
  }

  function computeKpis(days, prevDays, benchmarks) {
    const agg = aggregateByModel(days);
    const prevAgg = aggregateByModel(prevDays);
    const totalCost = agg.reduce((s, m) => s + m.costUSD, 0);
    const totalTokens = agg.reduce((s, m) => s + m.totalTokens, 0);
    const prevCost = prevAgg.reduce((s, m) => s + m.costUSD, 0);
    const prevTokens = prevAgg.reduce((s, m) => s + m.totalTokens, 0);

    const byCost = agg.slice().sort((a, b) => b.costUSD - a.costUSD);
    const byOutput = agg.slice().sort((a, b) => b.outputTokens - a.outputTokens);

    const effPerMTok = effPerMTokOf(totalCost, totalTokens);
    const prevEff = effPerMTokOf(prevCost, prevTokens);

    let bestValue = null;
    for (const m of agg) {
      const score = benchmarks[m.model];
      const eff = effPerMTokOf(m.costUSD, m.totalTokens);
      if (typeof score !== 'number' || !eff) continue;
      const value = score / eff;
      if (!bestValue || value > bestValue.scorePerDollar) {
        bestValue = { model: m.model, provider: m.provider, scorePerDollar: value };
      }
    }

    return {
      activeModels: agg.length,
      activeModelsDelta: prevDays.length > 0 ? agg.length - prevAgg.length : null,
      topCost: byCost[0]
        ? { model: byCost[0].model, provider: byCost[0].provider, costUSD: byCost[0].costUSD,
            sharePct: totalCost > 0 ? (byCost[0].costUSD / totalCost) * 100 : 0 }
        : null,
      topOutput: byOutput[0]
        ? { model: byOutput[0].model, provider: byOutput[0].provider, outputTokens: byOutput[0].outputTokens }
        : null,
      effPerMTok,
      effPerMTokDeltaPct: effPerMTok != null && prevEff ? ((effPerMTok - prevEff) / prevEff) * 100 : null,
      bestValue,
      top3SharePct: totalCost > 0
        ? (byCost.slice(0, 3).reduce((s, m) => s + m.costUSD, 0) / totalCost) * 100
        : 0,
    };
  }

  function tableRows(days, benchmarks) {
    const agg = aggregateByModel(days);
    const totalCost = agg.reduce((s, m) => s + m.costUSD, 0);
    return agg.map((m) => {
      const eff = effPerMTokOf(m.costUSD, m.totalTokens);
      const score = typeof benchmarks[m.model] === 'number' ? benchmarks[m.model] : null;
      const cacheBase = m.inputTokens + m.cacheReadTokens;
      return {
        ...m,
        effPerMTok: eff,
        score,
        scorePerDollar: score != null && eff ? score / eff : null,
        sharePct: totalCost > 0 ? (m.costUSD / totalCost) * 100 : 0,
        cacheHitRate: cacheBase > 0 ? m.cacheReadTokens / cacheBase : null,
      };
    }).sort((a, b) => b.costUSD - a.costUSD);
  }
```

`return`-Objekt erweitern um: `aggregateByModel, computeKpis, tableRows`.

- [ ] **Step 4: Tests laufen lassen**

Run: `npx vitest run tests/modelsCalc.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/tabs/models-calc.js tests/modelsCalc.test.ts
git commit -m "feat(models): KPI and table-row computation"
```

---

### Task 10: `models-calc.js` — Scatter, Adoption, Cache-Effizienz, Provider-Ribbon

**Files:**
- Modify: `src/renderer/tabs/models-calc.js`
- Test: `tests/modelsCalc.test.ts` (erweitern)

- [ ] **Step 1: Failing Tests ergänzen**

```ts
describe("scatterPoints", () => {
  it("emits only models with score and effective price", () => {
    const rows = calc.tableRows([
      day("2026-03-01", "claude-opus-4-8", { totalTokens: 1_000_000, costUSD: 3 }),
      day("2026-03-01", "gpt-5-codex-mini"),
    ], BENCH);
    const pts = calc.scatterPoints(rows);
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({ model: "claude-opus-4-8", x: 3, y: 61 });
    expect(pts[0].r).toBeGreaterThan(0);
  });
});

describe("adoptionTimeline", () => {
  it("returns per-model month intensities relative to the model's peak month", () => {
    const t = calc.adoptionTimeline([
      day("2026-01-10", "gpt-5.5", { outputTokens: 100 }),
      day("2026-02-10", "gpt-5.5", { outputTokens: 50 }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].model).toBe("gpt-5.5");
    expect(t[0].months).toEqual([
      { month: "2026-01", intensity: 1 },
      { month: "2026-02", intensity: 0.5 },
    ]);
  });
});

describe("cacheEfficiency", () => {
  it("computes hit rate and saved USD from pricing rates", () => {
    const days = [day("2026-03-01", "claude-opus-4-8", { inputTokens: 100, cacheReadTokens: 900 })];
    const pricing = { "claude-opus-4-8": { inputPerMTok: 15, cacheReadPerMTok: 1.5 } };
    const e = calc.cacheEfficiency(days, pricing);
    expect(e).toHaveLength(1);
    expect(e[0].hitRate).toBeCloseTo(0.9);
    expect(e[0].savedUSD).toBeCloseTo((900 / 1e6) * (15 - 1.5));
  });

  it("skips models without pricing", () => {
    const days = [day("2026-03-01", "gpt-5.5", { cacheReadTokens: 100 })];
    expect(calc.cacheEfficiency(days, {})).toHaveLength(0);
  });
});

describe("providerRibbon", () => {
  it("returns claude share per bucket", () => {
    const days = [
      day("2026-01-05", "claude-opus-4-8", { outputTokens: 75 }),
      day("2026-01-05", "gpt-5.5",         { outputTokens: 25 }),
    ];
    const r = calc.providerRibbon(days, "output", "daily");
    expect(r).toEqual([{ bucket: "2026-01-05", claudeShare: 0.75 }]);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — neue müssen fehlschlagen**

Run: `npx vitest run tests/modelsCalc.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementieren**

```js
  // Bubble-Radius: 4–18px, skaliert mit Wurzel des Kostenanteils (Flächen-Wahrnehmung).
  function scatterPoints(rows) {
    return rows
      .filter((r) => r.score != null && r.effPerMTok != null)
      .map((r) => ({
        model: r.model, provider: r.provider,
        x: r.effPerMTok, y: r.score,
        r: 4 + Math.sqrt(Math.max(r.sharePct, 0)) * 1.4,
        sharePct: r.sharePct,
      }));
  }

  // Pro Modell: Monate mit Deckkraft relativ zum stärksten Monat des Modells (Spec).
  function adoptionTimeline(days) {
    const byModel = new Map();
    for (const d of days) {
      const month = d.date.slice(0, 7);
      let m = byModel.get(d.model);
      if (!m) { m = { provider: d.provider, months: new Map() }; byModel.set(d.model, m); }
      m.months.set(month, (m.months.get(month) || 0) + d.outputTokens);
    }
    return Array.from(byModel.entries()).map(([model, m]) => {
      const max = Math.max(...m.months.values());
      const months = Array.from(m.months.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([month, v]) => ({ month, intensity: max > 0 ? v / max : 0 }));
      return { model, provider: m.provider, first: months[0].month, last: months[months.length - 1].month, months };
    }).sort((a, b) => a.first.localeCompare(b.first) || a.model.localeCompare(b.model));
  }

  function cacheEfficiency(days, pricing) {
    return aggregateByModel(days)
      .filter((m) => pricing[m.model] && (m.inputTokens + m.cacheReadTokens) > 0)
      .map((m) => {
        const rate = pricing[m.model];
        return {
          model: m.model, provider: m.provider,
          hitRate: m.cacheReadTokens / (m.inputTokens + m.cacheReadTokens),
          savedUSD: (m.cacheReadTokens / 1e6) * Math.max(rate.inputPerMTok - rate.cacheReadPerMTok, 0),
        };
      })
      .sort((a, b) => b.savedUSD - a.savedUSD);
  }

  // Claude-Anteil je Bucket für das 3px-Ribbon unter dem Hero-Chart.
  function providerRibbon(days, metric, granularity) {
    const bucketOf = granularity === 'weekly' ? (d) => isoWeek(d.date) : (d) => d.date;
    const map = new Map(); // bucket → { claude, total }
    for (const d of days) {
      const b = bucketOf(d);
      const v = metricOf(d, metric);
      let e = map.get(b);
      if (!e) { e = { claude: 0, total: 0 }; map.set(b, e); }
      if (d.provider === 'claude') e.claude += v;
      e.total += v;
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([bucket, e]) => ({ bucket, claudeShare: e.total > 0 ? e.claude / e.total : 0 }));
  }
```

`return`-Objekt erweitern um: `scatterPoints, adoptionTimeline, cacheEfficiency, providerRibbon`.

- [ ] **Step 4: Alle Calc-Tests laufen lassen**

Run: `npx vitest run tests/modelsCalc.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/tabs/models-calc.js tests/modelsCalc.test.ts
git commit -m "feat(models): scatter, adoption timeline, cache efficiency, provider ribbon calc"
```

---

### Task 11: `charts.js` — `createStacked100`

**Files:**
- Modify: `src/renderer/shared/charts.js` (am Ende anfügen)

Kein Unit-Test (Chart.js-Wrapper, kein DOM-Test-Setup im Repo) — Verifikation via Build + manueller Smoke in Task 14.

- [ ] **Step 1: Helper implementieren**

```js
// 100% gestapelte Balken für den Models-Tab. datasets[i].rawValues trägt die
// Absolutwerte für den Tooltip; data ist bereits in Prozent normalisiert.
QB.charts.createStacked100 = function(ctx, labels, datasets, opts) {
  const fmtAbs = opts?.format === 'cost'
    ? (v) => '$' + (v < 0.01 ? Number(v).toFixed(4) : Number(v).toFixed(2))
    : (v) => QB.fmtTokens(v);
  return new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      datasets: { bar: { categoryPercentage: 1.0, barPercentage: 0.96 } }, // flush, 1px Lücke
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f1319',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#b4c8d8',
          bodyColor: '#8298aa',
          padding: 8,
          filter: (item) => item.parsed.y > 0,
          callbacks: {
            label: (item) => {
              const raw = item.dataset.rawValues?.[item.dataIndex] ?? 0;
              return ` ${item.dataset.label}: ${fmtAbs(raw)} (${item.parsed.y.toFixed(1)}%)`;
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: '#506070',
            font: { family: "'IBM Plex Mono', monospace", size: 9 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 10,
          },
        },
        y: {
          stacked: true,
          min: 0,
          max: 100,
          grid: { color: 'rgba(255,255,255,0.04)' }, // Hairlines bei 25/50/75
          border: { display: false },
          ticks: {
            color: '#506070',
            font: { family: "'IBM Plex Mono', monospace", size: 9 },
            stepSize: 25,
            callback: (v) => (v === 0 || v === 100 ? '' : v + '%'),
          },
        },
      },
    },
  });
};
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/shared/charts.js
git commit -m "feat(models): add 100% stacked bar chart helper"
```

---

### Task 12: `index.html` — Tab, View, Styles, Includes

**Files:**
- Modify: `src/renderer/index.html:1417-1420` (Tab-Nav), `:1509-1514` (Views), `:1394-1402` (Scripts), `:1604-1626` (switchTab), `:1824` (Prefetch), Styles nach dem Analytics-Block (~Zeile 1010)

- [ ] **Step 1: Tab-Button einfügen**

Nach dem Analytics-Button (`index.html:1418`):

```html
      <button class="tab-btn"        id="tab-models"       data-tab="models">Models</button>
```

- [ ] **Step 2: View-Container einfügen**

Nach dem Analytics-View (`index.html:1514`):

```html
  <!-- ── Models View ──────────────────────────────────────── -->
  <div class="view" id="view-models" hidden>
    <div class="analytics-wrap" id="models-content">
      <div class="empty"><div class="spinner"></div><span>Lädt…</span></div>
    </div>
  </div>
```

- [ ] **Step 3: Scripts einbinden**

Nach `tabs/analytics.js` (`index.html:1400`):

```html
  <script src="tabs/models-calc.js"></script>
  <script src="tabs/models.js"></script>
```

- [ ] **Step 4: switchTab erweitern**

In `switchTab` (`index.html:1604-1621`) ergänzen:

```js
      document.getElementById('view-models').hidden = tab !== 'models';
```
und:
```js
      if (tab === 'models')        QB.renderModels();
```
Listener (nach `index.html:1624`):
```js
    document.getElementById('tab-models').addEventListener('click',        () => switchTab('models'));
```
Prefetch (`index.html:1824`, daneben):
```js
      if (QB.prefetchModels) QB.prefetchModels();
```

- [ ] **Step 5: Styles einfügen**

Nach dem `.top-models-table`-Block (~`index.html:1010`):

```css
    /* ══ MODELS TAB ════════════════════════════════════════════ */
    .mod-kpi-grid {
      display: grid; grid-template-columns: 2fr repeat(5, 1fr); gap: 5px; margin-bottom: 6px;
    }
    .mod-kpi-lead .an-stat-val {
      font-size: 24px; /* Hero-Zahl wie .an-peak-hero */
    }
    .mod-kpi-trend {
      display: inline-block; margin-left: 6px;
      font-family: 'IBM Plex Mono', monospace; font-size: 10px;
      font-variant-numeric: tabular-nums;
    }
    .mod-kpi-trend.good { color: var(--green); }
    .mod-kpi-trend.bad  { color: var(--orange); }
    .mod-kpi-trend.flat { color: var(--t300); }
    .mod-kpi-sub { font-size: 8.5px; color: var(--t400); margin-top: 3px; }

    .mod-hero-wrap { height: 200px; position: relative; }
    .mod-ribbon { display: flex; gap: 1px; height: 3px; margin-top: 4px; }
    .mod-ribbon-cell { flex: 1; display: flex; border-radius: 1px; overflow: hidden; }
    .mod-ribbon-claude { background: var(--claude-col); height: 100%; }
    .mod-ribbon-codex  { background: var(--codex-col);  height: 100%; }

    .mod-head-rows { display: flex; flex-direction: column; gap: 5px; margin-bottom: 8px; }
    .mod-pills { display: flex; gap: 3px; flex-wrap: wrap; }
    .mod-pills .pill { padding: 3px 10px; font-size: 10px; height: auto; position: relative; }
    /* Hit-Area auf Kopfzeilen-Höhe ausdehnen, ohne Nachbar-Überlappung */
    .mod-pills .pill::before { content: ''; position: absolute; inset: -4px 0; }

    .mod-scatter-wrap { height: 220px; position: relative; }
    .mod-scatter-note { font-size: 8.5px; color: var(--t400); margin-top: 6px; }

    .mod-table-scroll { overflow-x: auto; }
    .mod-table { width: 100%; border-collapse: collapse; font-size: 10px; white-space: nowrap; }
    .mod-table th {
      font-size: 8px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--t400); text-align: right; padding: 4px 7px;
      border-bottom: 1px solid var(--border); cursor: pointer; user-select: none;
      transition-property: color; transition-duration: 120ms;
    }
    .mod-table th:hover { color: var(--t200); }
    .mod-table th:active { scale: 0.96; }
    .mod-table th.txt { text-align: left; }
    .mod-table .sort-caret {
      display: inline-block; margin-left: 3px;
      transition-property: rotate; transition-duration: 120ms;
      transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
    }
    .mod-table th.sorted-asc .sort-caret { rotate: 180deg; }
    .mod-table td {
      padding: 4px 7px; border-bottom: 1px solid rgba(255,255,255,0.04);
      font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums;
      text-align: right; color: var(--t200);
      transition-property: background; transition-duration: 120ms;
    }
    .mod-table td.txt { text-align: left; font-family: 'DM Sans', system-ui, sans-serif; color: var(--t100); }
    .mod-table tbody tr:hover td { background: var(--bg-card-hover); }
    .mod-table tr.mod-total td { border-bottom: none; color: var(--t100); font-weight: 500; }
    .mod-table tr.mod-total:hover td { background: none; }
    .mod-dot { display: inline-block; width: 7px; height: 7px; border-radius: 2px; margin-right: 5px; }

    .mod-adopt-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    .mod-adopt-lbl {
      width: 130px; flex-shrink: 0; font-size: 9.5px; color: var(--t300);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .mod-adopt-track { flex: 1; display: flex; gap: 1px; height: 8px; }
    .mod-adopt-seg { flex: 1; border-radius: 1px; }

    .mod-cache-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    .mod-cache-lbl {
      width: 130px; flex-shrink: 0; font-size: 9.5px; color: var(--t300);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .mod-cache-track { flex: 1; height: 7px; background: rgba(255,255,255,0.04); border-radius: 2px; }
    .mod-cache-fill { height: 100%; border-radius: 2px; }
    .mod-cache-val {
      width: 92px; flex-shrink: 0; text-align: right;
      font-family: 'IBM Plex Mono', monospace; font-size: 8.5px;
      font-variant-numeric: tabular-nums; color: var(--t400);
    }

    .mod-note { font-size: 9.5px; color: var(--t400); padding: 4px 0; }

    /* Gestaffelter Eintritt — nur beim ersten Öffnen (Klasse wird per JS gesetzt) */
    @keyframes modEnter { from { opacity: 0; translate: 0 4px; } to { opacity: 1; translate: 0 0; } }
    .mod-stagger > * { animation: modEnter 360ms cubic-bezier(0.2, 0, 0, 1) both; }
    .mod-stagger > *:nth-child(1) { animation-delay: 0ms; }
    .mod-stagger > *:nth-child(2) { animation-delay: 70ms; }
    .mod-stagger > *:nth-child(3) { animation-delay: 140ms; }
    .mod-stagger > *:nth-child(4) { animation-delay: 210ms; }
    .mod-stagger > *:nth-child(5) { animation-delay: 280ms; }
```

- [ ] **Step 6: Build prüfen + Commit**

Run: `npm run build`
Expected: OK (HTML wird nicht kompiliert, aber Build darf nicht brechen)

```bash
git add src/renderer/index.html
git commit -m "feat(models): add Models tab shell, styles and wiring"
```

---

### Task 13: `models.js` — Tab-Rendering

**Files:**
- Create: `src/renderer/tabs/models.js`

Rendering ist im Repo nicht unit-getestet (kein DOM-Setup) — Logik steckt in `models-calc.js` (getestet); `models.js` ist dünne Verdrahtung. Verifikation: Task 14.

- [ ] **Step 1: Komplettes Modul implementieren**

```js
/* global QB, Chart */
'use strict';

window.QB = window.QB || {};

(function () {
  const calc = QB.modelsCalc;

  let _data = null;
  let _dataPromise = null;
  let _stackChart = null;
  let _scatterChart = null;
  let _animated = false;

  // UI-State (lokales Recompute, kein IPC bei Wechsel)
  let _win = 'all';        // '30d' | '90d' | 'all'
  let _metric = 'output';  // 'output'|'input'|'cacheRead'|'cacheCreation'|'total'|'cost'
  let _provider = 'all';   // 'all' | 'claude' | 'codex'
  let _sortKey = 'costUSD';
  let _sortDesc = true;

  const METRIC_LABELS = [
    ['output', 'Output'], ['input', 'Input'], ['cacheRead', 'Cache Read'],
    ['cacheCreation', 'Cache Creation'], ['total', 'Total'], ['cost', 'Kosten'],
  ];
  const CLAUDE_PALETTE = ['#DA785B', '#E89B6F', '#C05A45', '#F0B27A', '#A8442F', '#F5D0A9'];
  const CODEX_PALETTE  = ['#4B55C8', '#6E8EE8', '#56C8D8', '#3A3F8F', '#7A6FF0', '#2E6FBF'];
  const OTHER_COLOR = '#475460';

  QB.renderModels = async function renderModels() {
    const container = document.getElementById('models-content');
    if (!container) return;
    if (_data) { renderUI(); return; }
    container.innerHTML = '<div class="empty"><div class="loading-dots"><span></span><span></span><span></span></div></div>';
    try {
      _data = await loadData();
      renderUI();
    } catch (e) {
      console.error('models:get failed', e);
      container.innerHTML = '<div class="empty"><span>Fehler beim Laden</span></div>';
    }
  };

  QB.prefetchModels = function prefetchModels() {
    void loadData().catch((e) => console.error('models prefetch failed', e));
  };

  QB.clearModelsCache = function clearModelsCache() {
    _data = null;
    _dataPromise = null;
  };

  function loadData() {
    if (_data) return Promise.resolve(_data);
    if (!_dataPromise) {
      _dataPromise = QB.ipc.invoke('models:get')
        .then((d) => { _data = d; return d; })
        .catch((err) => { _dataPromise = null; throw err; });
    }
    return _dataPromise;
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  function visibleDays() {
    const byWin = calc.filterWindow(_data.days, _win, today());
    return _provider === 'all' ? byWin : byWin.filter((d) => d.provider === _provider);
  }

  function colorFor(model, provider, order) {
    if (model === 'Andere') return OTHER_COLOR;
    const palette = provider === 'claude' ? CLAUDE_PALETTE : CODEX_PALETTE;
    const siblings = order.filter((m) => _modelProvider.get(m) === provider);
    return palette[Math.max(siblings.indexOf(model), 0) % palette.length];
  }

  let _modelProvider = new Map();
  let _colorOrder = [];

  function renderUI() {
    const container = document.getElementById('models-content');
    _modelProvider = new Map(_data.days.map((d) => [d.model, d.provider]));
    _colorOrder = calc.modelColorOrder(_data.days);
    const hasBenchmarks = Object.keys(_data.benchmarks).length > 0;

    container.innerHTML = `
      <div class="${_animated ? '' : 'mod-stagger'}" id="mod-root">
        <div class="mod-kpi-grid" id="mod-kpis"></div>

        <div class="an-section">
          <div class="an-section-head">
            <span class="an-section-title">MODELL-VERTEILUNG</span>
            <div class="an-window-pills mod-pills" id="mod-win-pills">
              <button class="pill" data-win="30d">30D</button>
              <button class="pill" data-win="90d">90D</button>
              <button class="pill" data-win="all">Alles</button>
            </div>
          </div>
          <div class="mod-head-rows">
            <div class="mod-pills" id="mod-metric-pills">
              ${METRIC_LABELS.map(([k, l]) => `<button class="pill" data-metric="${k}">${l}</button>`).join('')}
            </div>
            <div class="mod-pills" id="mod-provider-pills">
              <button class="pill" data-prov="all">Alle</button>
              <button class="pill" data-prov="claude">Claude</button>
              <button class="pill" data-prov="codex">Codex</button>
            </div>
          </div>
          <div class="mod-hero-wrap"><canvas id="mod-stack-canvas"></canvas></div>
          <div class="mod-ribbon" id="mod-ribbon"></div>
          <div class="mod-note" id="mod-stack-note" hidden></div>
          <div class="mod-note">Historie ab ${_data.days.length > 0 ? _data.days[0].date : '—'}</div>
        </div>

        ${hasBenchmarks ? `
        <div class="an-section">
          <div class="an-section-head"><span class="an-section-title">PREIS vs. INTELLIGENZ</span></div>
          <div class="mod-scatter-wrap"><canvas id="mod-scatter-canvas"></canvas></div>
          <div class="mod-scatter-note">x: effektiver $/MTok basierend auf deiner echten Nutzung (inkl. Cache) ·
            Quelle: ${_data.benchmarksAsOf ? `Artificial Analysis Intelligence Index, Stand ${_data.benchmarksAsOf}` : 'Artificial Analysis'}</div>
        </div>` : `
        <div class="an-section"><div class="mod-note">Benchmark-Daten nicht verfügbar — Scatter ausgeblendet.</div></div>`}

        <div class="an-section">
          <div class="an-section-head"><span class="an-section-title">MODELLE IM DETAIL</span></div>
          <div class="mod-table-scroll"><table class="mod-table" id="mod-table"></table></div>
        </div>

        <div class="an-row2">
          <div class="an-section">
            <div class="an-section-head"><span class="an-section-title">MODELL-ADOPTION</span></div>
            <div id="mod-adoption"></div>
          </div>
          <div class="an-section">
            <div class="an-section-head"><span class="an-section-title">CACHE-EFFIZIENZ</span></div>
            <div id="mod-cache"></div>
          </div>
        </div>
      </div>`;
    _animated = true;

    bindPills();
    syncPills();
    renderKpis();
    renderStack(true);
    if (hasBenchmarks) renderScatter();
    renderTable();
    renderAdoption();
    renderCache();
  }

  function bindPills() {
    document.querySelectorAll('#mod-win-pills .pill').forEach((p) =>
      p.addEventListener('click', () => { _win = p.dataset.win; refreshLocal(); }));
    document.querySelectorAll('#mod-metric-pills .pill').forEach((p) =>
      p.addEventListener('click', () => { _metric = p.dataset.metric; refreshLocal(); }));
    document.querySelectorAll('#mod-provider-pills .pill').forEach((p) =>
      p.addEventListener('click', () => { _provider = p.dataset.prov; refreshLocal(); }));
  }

  function syncPills() {
    document.querySelectorAll('#mod-win-pills .pill').forEach((p) => p.classList.toggle('active', p.dataset.win === _win));
    document.querySelectorAll('#mod-metric-pills .pill').forEach((p) => p.classList.toggle('active', p.dataset.metric === _metric));
    document.querySelectorAll('#mod-provider-pills .pill').forEach((p) => p.classList.toggle('active', p.dataset.prov === _provider));
  }

  // Fenster-/Metrik-/Provider-Wechsel: lokales Recompute, Chart-Instanzen mutieren.
  function refreshLocal() {
    syncPills();
    renderKpis();
    renderStack(false);
    renderTable();
    renderAdoption();
    renderCache();
  }

  function renderKpis() {
    const el = document.getElementById('mod-kpis');
    const days = visibleDays();
    const prev = _provider === 'all'
      ? calc.previousWindow(_data.days, _win, today())
      : calc.previousWindow(_data.days, _win, today()).filter((d) => d.provider === _provider);
    const k = calc.computeKpis(days, prev, _data.benchmarks);

    const trend = (deltaPct, invert) => {
      if (deltaPct == null) return '';
      const good = invert ? deltaPct < 0 : deltaPct > 0;
      const cls = deltaPct === 0 ? 'flat' : good ? 'good' : 'bad';
      const arrow = deltaPct === 0 ? '→' : deltaPct > 0 ? '▲' : '▼';
      return `<span class="mod-kpi-trend ${cls}">${arrow}${Math.abs(deltaPct).toFixed(0)}%</span>`;
    };

    el.innerHTML = `
      <div class="an-stat-tile mod-kpi-lead">
        <div class="an-stat-lbl">Ø $/MTok effektiv</div>
        <div class="an-stat-val">${k.effPerMTok != null ? '$' + k.effPerMTok.toFixed(2) : '—'}${trend(k.effPerMTokDeltaPct, true)}</div>
        <div class="mod-kpi-sub">Gesamtkosten ÷ Gesamttokens, inkl. Cache</div>
      </div>
      <div class="an-stat-tile">
        <div class="an-stat-lbl">Aktive Modelle</div>
        <div class="an-stat-val">${k.activeModels}${k.activeModelsDelta != null
          ? `<span class="mod-kpi-trend flat">${k.activeModelsDelta >= 0 ? '+' : ''}${k.activeModelsDelta}</span>` : ''}</div>
      </div>
      <div class="an-stat-tile">
        <div class="an-stat-lbl">Top nach Kosten</div>
        <div class="an-stat-val" title="${k.topCost ? k.topCost.model : ''}">${k.topCost ? shortName(k.topCost.model) : '—'}</div>
        <div class="mod-kpi-sub">${k.topCost ? '$' + k.topCost.costUSD.toFixed(0) + ' · ' + k.topCost.sharePct.toFixed(0) + '%' : ''}</div>
      </div>
      <div class="an-stat-tile">
        <div class="an-stat-lbl">Top nach Output</div>
        <div class="an-stat-val" title="${k.topOutput ? k.topOutput.model : ''}">${k.topOutput ? shortName(k.topOutput.model) : '—'}</div>
        <div class="mod-kpi-sub">${k.topOutput ? QB.fmtTokens(k.topOutput.outputTokens) : ''}</div>
      </div>
      <div class="an-stat-tile">
        <div class="an-stat-lbl">Preis/Leistung</div>
        <div class="an-stat-val" title="${k.bestValue ? k.bestValue.model : ''}">${k.bestValue ? shortName(k.bestValue.model) : '—'}</div>
        <div class="mod-kpi-sub">${k.bestValue ? 'Score/$ am höchsten' : 'kein Score verfügbar'}</div>
      </div>
      <div class="an-stat-tile">
        <div class="an-stat-lbl">Top-3-Anteil</div>
        <div class="an-stat-val">${k.top3SharePct.toFixed(0)}%</div>
        <div class="mod-kpi-sub">Kosten-Konzentration</div>
      </div>`;
  }

  function shortName(model) {
    return model.replace(/^claude-/, '').replace(/^gpt-/, 'gpt-');
  }

  function renderStack(initial) {
    const note = document.getElementById('mod-stack-note');
    const days = visibleDays();
    const granularity = _win === 'all' ? 'weekly' : 'daily';
    const stack = calc.buildStack(days, _metric, granularity, 0.01);

    const empty = stack.series.length === 0
      || stack.series.every((s) => s.values.every((v) => v === 0));
    note.hidden = !empty;
    if (empty) {
      note.textContent = _metric === 'cacheCreation' && _provider === 'codex'
        ? 'Cache-Creation-Tokens gibt es nur bei Claude.'
        : 'Keine Daten im gewählten Fenster.';
    }

    const totals = stack.buckets.map((_, i) => stack.series.reduce((s, x) => s + x.values[i], 0));
    const datasets = stack.series.map((s) => ({
      label: s.model,
      data: s.values.map((v, i) => (totals[i] > 0 ? (v / totals[i]) * 100 : 0)),
      rawValues: s.values,
      backgroundColor: colorFor(s.model, s.provider, _colorOrder),
      hoverBackgroundColor: colorFor(s.model, s.provider, _colorOrder) + 'E6',
    }));

    if (_stackChart && !initial) {
      _stackChart.data.labels = stack.buckets;
      _stackChart.data.datasets = datasets;
      _stackChart.update(); // Canvas nie neu erstellen — kein Flash, unterbrechbar
    } else {
      if (_stackChart) _stackChart.destroy();
      const ctx = document.getElementById('mod-stack-canvas').getContext('2d');
      _stackChart = QB.charts.createStacked100(ctx, stack.buckets, datasets,
        { format: _metric === 'cost' ? 'cost' : 'tokens' });
    }

    renderRibbon(days, granularity);
  }

  function renderRibbon(days, granularity) {
    const el = document.getElementById('mod-ribbon');
    const ribbon = calc.providerRibbon(days, _metric, granularity);
    el.innerHTML = ribbon.map((r) => `
      <div class="mod-ribbon-cell" title="${r.bucket}: Claude ${(r.claudeShare * 100).toFixed(0)}%">
        <div class="mod-ribbon-claude" style="width:${(r.claudeShare * 100).toFixed(1)}%"></div>
        <div class="mod-ribbon-codex" style="width:${((1 - r.claudeShare) * 100).toFixed(1)}%"></div>
      </div>`).join('');
  }

  function renderScatter() {
    const rows = calc.tableRows(visibleDays(), _data.benchmarks);
    const pts = calc.scatterPoints(rows);
    const data = {
      datasets: [{
        data: pts.map((p) => ({ x: p.x, y: p.y, r: p.r })),
        pointsMeta: pts,
        backgroundColor: pts.map((p) => QB.providerColor(p.provider) + 'CC'),
        borderColor: pts.map((p) => QB.providerColor(p.provider)),
        borderWidth: 1,
        hoverRadius: 2, // Chart.js addiert auf r
      }],
    };
    if (_scatterChart) {
      _scatterChart.data = data;
      _scatterChart.update();
      return;
    }
    const ctx = document.getElementById('mod-scatter-canvas').getContext('2d');
    // Value-Quadrant: Verlauf zur „smart & günstig"-Ecke oben links
    const quadrant = {
      id: 'modQuadrant',
      beforeDraw(chart) {
        const { ctx: c, chartArea: a } = chart;
        if (!a) return;
        const g = c.createLinearGradient(a.left, a.top, a.right, a.bottom);
        g.addColorStop(0, 'rgba(82,208,23,0.05)');
        g.addColorStop(0.5, 'rgba(82,208,23,0)');
        c.save(); c.fillStyle = g; c.fillRect(a.left, a.top, a.right - a.left, a.bottom - a.top); c.restore();
      },
    };
    _scatterChart = new Chart(ctx, {
      type: 'bubble',
      data,
      plugins: [quadrant],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0f1319', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1,
            titleColor: '#b4c8d8', bodyColor: '#8298aa', padding: 8,
            callbacks: {
              label: (item) => {
                const p = item.dataset.pointsMeta[item.dataIndex];
                return ` ${p.model}: Score ${p.y} · $${p.x.toFixed(2)}/MTok · ${p.sharePct.toFixed(1)}% der Kosten`;
              },
            },
          },
        },
        scales: {
          x: {
            title: { display: true, text: '$ / MTok (effektiv)', color: '#506070', font: { size: 9 } },
            grid: { color: 'rgba(255,255,255,0.04)' }, border: { display: false },
            ticks: { color: '#506070', font: { family: "'IBM Plex Mono', monospace", size: 9 },
                     callback: (v) => '$' + Number(v).toFixed(1) },
          },
          y: {
            title: { display: true, text: 'Intelligence Index', color: '#506070', font: { size: 9 } },
            grid: { color: 'rgba(255,255,255,0.04)' }, border: { display: false },
            ticks: { color: '#506070', font: { family: "'IBM Plex Mono', monospace", size: 9 } },
          },
        },
      },
    });
  }

  const COLUMNS = [
    ['model', 'Modell', 'txt'], ['inputTokens', 'Input', 'num'], ['outputTokens', 'Output', 'num'],
    ['cacheReadTokens', 'Cache R', 'num'], ['cacheCreationTokens', 'Cache C', 'num'],
    ['totalTokens', 'Total', 'num'], ['costUSD', 'Kosten', 'num'], ['effPerMTok', '$/MTok', 'num'],
    ['score', 'Score', 'num'], ['scorePerDollar', 'Score/$', 'num'], ['sharePct', 'Anteil', 'num'],
    ['cacheHitRate', 'Cache-Hit', 'num'], ['firstUsed', 'Erste', 'num'], ['lastUsed', 'Letzte', 'num'],
  ];

  function renderTable() {
    const table = document.getElementById('mod-table');
    const rows = calc.tableRows(visibleDays(), _data.benchmarks);
    rows.sort((a, b) => {
      const av = a[_sortKey], bv = b[_sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
      return _sortDesc ? -cmp : cmp;
    });

    const fmt = {
      model: (r) => `<span class="mod-dot" style="background:${QB.providerColor(r.provider)}"></span>${r.model}`,
      inputTokens: (r) => QB.fmtTokens(r.inputTokens),
      outputTokens: (r) => QB.fmtTokens(r.outputTokens),
      cacheReadTokens: (r) => QB.fmtTokens(r.cacheReadTokens),
      cacheCreationTokens: (r) => r.provider === 'codex' ? '—' : QB.fmtTokens(r.cacheCreationTokens),
      totalTokens: (r) => QB.fmtTokens(r.totalTokens),
      costUSD: (r) => '$' + r.costUSD.toFixed(2),
      effPerMTok: (r) => r.effPerMTok != null ? '$' + r.effPerMTok.toFixed(2) : '—',
      score: (r) => r.score != null ? r.score : '—',
      scorePerDollar: (r) => r.scorePerDollar != null ? r.scorePerDollar.toFixed(1) : '—',
      sharePct: (r) => r.sharePct.toFixed(1) + '%',
      cacheHitRate: (r) => r.cacheHitRate != null ? (r.cacheHitRate * 100).toFixed(0) + '%' : '—',
      firstUsed: (r) => r.firstUsed,
      lastUsed: (r) => r.lastUsed,
    };

    const totals = rows.reduce((acc, r) => ({
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + r.cacheCreationTokens,
      totalTokens: acc.totalTokens + r.totalTokens,
      costUSD: acc.costUSD + r.costUSD,
    }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUSD: 0 });

    table.innerHTML = `
      <thead><tr>${COLUMNS.map(([key, label, cls]) => `
        <th class="${cls === 'txt' ? 'txt' : ''} ${_sortKey === key ? (_sortDesc ? 'sorted-desc' : 'sorted-asc') : ''}" data-key="${key}">
          ${label}${_sortKey === key ? '<span class="sort-caret">▾</span>' : ''}
        </th>`).join('')}</tr></thead>
      <tbody>
        ${rows.map((r) => `<tr>${COLUMNS.map(([key, , cls]) =>
          `<td class="${cls === 'txt' ? 'txt' : ''}">${fmt[key](r)}</td>`).join('')}</tr>`).join('')}
        <tr class="mod-total">
          <td class="txt">Σ ${rows.length} Modelle</td>
          <td>${QB.fmtTokens(totals.inputTokens)}</td><td>${QB.fmtTokens(totals.outputTokens)}</td>
          <td>${QB.fmtTokens(totals.cacheReadTokens)}</td><td>${QB.fmtTokens(totals.cacheCreationTokens)}</td>
          <td>${QB.fmtTokens(totals.totalTokens)}</td><td>$${totals.costUSD.toFixed(2)}</td>
          <td>${totals.totalTokens > 0 ? '$' + ((totals.costUSD / totals.totalTokens) * 1e6).toFixed(2) : '—'}</td>
          <td colspan="6"></td>
        </tr>
      </tbody>`;

    table.querySelectorAll('th').forEach((th) => th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (_sortKey === key) { _sortDesc = !_sortDesc; } else { _sortKey = key; _sortDesc = true; }
      renderTable(); // instant, kein Reorder-Geanimiere (Spec)
    }));
  }

  function renderAdoption() {
    const el = document.getElementById('mod-adoption');
    const timeline = calc.adoptionTimeline(visibleDays());
    if (timeline.length === 0) { el.innerHTML = '<div class="mod-note">Keine Daten.</div>'; return; }
    const allMonths = [];
    const first = timeline.reduce((min, t) => (t.first < min ? t.first : min), timeline[0].first);
    const last = timeline.reduce((max, t) => (t.last > max ? t.last : max), timeline[0].last);
    for (let m = first; m <= last; m = nextMonth(m)) allMonths.push(m);

    el.innerHTML = timeline.map((t) => {
      const byMonth = new Map(t.months.map((x) => [x.month, x.intensity]));
      return `
        <div class="mod-adopt-row">
          <div class="mod-adopt-lbl" title="${t.model}">${t.model}</div>
          <div class="mod-adopt-track">${allMonths.map((m) => {
            const i = byMonth.get(m);
            return `<div class="mod-adopt-seg" style="background:${i != null
              ? QB.providerColor(t.provider) : 'rgba(255,255,255,0.03)'};opacity:${i != null ? (0.25 + i * 0.75).toFixed(2) : 1}"></div>`;
          }).join('')}</div>
        </div>`;
    }).join('');
  }

  function nextMonth(ym) {
    const [y, m] = ym.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }

  function renderCache() {
    const el = document.getElementById('mod-cache');
    const eff = calc.cacheEfficiency(visibleDays(), _data.pricing);
    if (eff.length === 0) { el.innerHTML = '<div class="mod-note">Keine Cache-Daten oder Preise verfügbar.</div>'; return; }
    el.innerHTML = eff.map((e) => `
      <div class="mod-cache-row">
        <div class="mod-cache-lbl" title="${e.model}">${e.model}</div>
        <div class="mod-cache-track">
          <div class="mod-cache-fill" style="width:${(e.hitRate * 100).toFixed(1)}%;background:${QB.providerColor(e.provider)};opacity:0.75"></div>
        </div>
        <div class="mod-cache-val">${(e.hitRate * 100).toFixed(0)}% · spart $${e.savedUSD.toFixed(0)}</div>
      </div>`).join('');
  }
})();
```

- [ ] **Step 2: Build + alle Tests**

Run: `npm run build && npx vitest run`
Expected: Build OK, alle Tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/tabs/models.js
git commit -m "feat(models): render Models tab (KPIs, hero stack, scatter, table, insights)"
```

---

### Task 14: Gesamtverifikation

**Files:** keine neuen

- [ ] **Step 1: Vollständiger Test- und Build-Lauf**

Run: `npx vitest run && npm run build`
Expected: alle Tests PASS, Build OK

- [ ] **Step 2: Manueller Smoke-Test**

Run: `npm run dev`

Checkliste (mit echten lokalen Daten, ~9 Monate Backfill):
1. Tab „Models" erscheint zwischen Analytics und Alerts; Klick lädt ohne Fehler.
2. Default: Fenster „Alles", Metrik „Output" — wöchentliche 100%-Balken über die volle Historie, Provider-Ribbon darunter.
3. Metrik „Kosten" umschalten → Chart aktualisiert ohne Flash; „Cache Creation" + Provider „Codex" → Leerhinweis.
4. 30D/90D → tägliche Balken; KPI-Trends erscheinen (bei „Alles" keine Trends).
5. Scatter zeigt nur Modelle mit Score; Tooltip mit Score/$/Anteil; Fußnote mit asOf.
6. Tabelle sortiert per Klick (Caret dreht), Summenzeile stimmt, Codex-Zeilen zeigen „—" bei Cache C.
7. Adoption-Timeline und Cache-Effizienz gefüllt.
8. Stagger-Animation nur beim ersten Öffnen des Tabs.
9. DevTools-Konsole: keine Fehler.

- [ ] **Step 3: Commit (falls Fixes nötig waren), sonst fertig**

```bash
git status
```

---

## Hinweise für die Ausführung

- **Niemals echte lokale Logs in Tests lesen:** `claudeEntries: []` / `codexEvents: []` und `pricingOfflineMode: true` in jedem `buildModelsData`-Test.
- **Reihenfolge einhalten:** Tasks 1–5 (Main-Datenpfad) → 6 (IPC) → 7–10 (Calc) → 11–13 (UI) → 14 (Verifikation).
- Bei Chart.js-Fragen: vorhandene Muster in `src/renderer/shared/charts.js` und `analytics.js` sind die Referenz.

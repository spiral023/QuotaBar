# Backfill-basierter Historien-Report – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `generateUsageReport` kann mit `source: "backfill"` aufgerufen werden und liest dann aus vorberechneten `*.backfill.jsonl`-Dateien statt aus den Quell-JSONL — deutlich schneller für historische Abfragen.

**Architecture:** Ein neuer `backfill-reader.ts` liest alle `*.backfill.jsonl`-Dateien und extrahiert `tokens.daySummary`-Events zu `BackfillDayRecord[]`. `reportService.ts` bekommt einen neuen Codepfad, der bei `source: "backfill"` diese Records in `ReportRow[]` umwandelt (daily/weekly/monthly; kein LiteLLM-Fetch nötig). Session-Level-Reports und Project-Filter sind mit Backfill nicht unterstützt und fallen auf `"live"` zurück.

**Tech Stack:** TypeScript, Node.js fs/promises, Vitest

---

## File Map

| Datei | Status | Verantwortung |
|-------|--------|--------------|
| `src/reports/backfill-reader.ts` | NEU | Liest `*.backfill.jsonl`, gibt `BackfillDayRecord[]` zurück |
| `src/reports/types.ts` | ÄNDERN | `source?: "live" \| "backfill"` in `ReportRequest`; `BackfillDayRecord` |
| `src/reports/reportService.ts` | ÄNDERN | Backfill-Pfad in `generateUsageReport`, `buildRowsFromBackfill` |
| `tests/backfill-reader.test.ts` | NEU | Unit-Tests für den Reader |
| `tests/reports.test.ts` | ÄNDERN | Integration-Tests für `source: "backfill"` |

---

## Task 1: `BackfillDayRecord`-Typ definieren

**Files:**
- Modify: `src/reports/types.ts`

- [ ] **Schritt 1: Typ zu `types.ts` hinzufügen**

Füge am Ende der Datei `src/reports/types.ts` ein:

```typescript
export interface BackfillPerModelEntry {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
}

export interface BackfillDayRecord {
  date: string; // YYYY-MM-DD UTC
  provider: "claude" | "codex";
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  sessionCount: number;
  models: string[];
  perModel: Record<string, BackfillPerModelEntry>;
}
```

- [ ] **Schritt 2: `source` zu `ReportRequest` hinzufügen**

In `src/reports/types.ts`, `ReportRequest` um ein optionales Feld erweitern:

```typescript
export interface ReportRequest {
  provider?: ReportProvider;
  type?: ReportType;
  since?: string;
  until?: string;
  timezone?: string;
  project?: string;
  instances?: boolean;
  costMode?: CostMode;
  codexSpeed?: CodexSpeed;
  order?: ReportOrder;
  breakdown?: boolean;
  source?: "live" | "backfill"; // "live" ist default (bisheriges Verhalten)
}
```

- [ ] **Schritt 3: TypeScript kompilieren, keine Fehler**

```bash
npm run build
```
Erwartung: kein Fehler.

- [ ] **Schritt 4: Commit**

```bash
git add src/reports/types.ts
git commit -m "feat(reports): add BackfillDayRecord type and source field to ReportRequest"
```

---

## Task 2: `backfill-reader.ts` – Skeleton + Leere-Dir-Test

**Files:**
- Create: `src/reports/backfill-reader.ts`
- Create: `tests/backfill-reader.test.ts`

- [ ] **Schritt 1: Failing-Test schreiben**

Neue Datei `tests/backfill-reader.test.ts`:

```typescript
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBackfillDayRecords } from "../src/reports/backfill-reader";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-bfr-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("readBackfillDayRecords", () => {
  it("gibt [] zurück wenn Verzeichnis nicht existiert", async () => {
    const result = await readBackfillDayRecords(path.join(tmpDir, "nonexistent"));
    expect(result).toEqual([]);
  });

  it("gibt [] zurück wenn Verzeichnis leer ist", async () => {
    const result = await readBackfillDayRecords(tmpDir);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Schritt 2: Test ausführen – muss scheitern**

```bash
npx vitest run tests/backfill-reader.test.ts
```
Erwartung: FAIL – `readBackfillDayRecords` ist nicht definiert.

- [ ] **Schritt 3: Skeleton implementieren**

Neue Datei `src/reports/backfill-reader.ts`:

```typescript
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { BackfillDayRecord, BackfillPerModelEntry } from "./types";

export async function readBackfillDayRecords(
  logDir: string,
  since?: Date,
): Promise<BackfillDayRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(logDir);
  } catch {
    return [];
  }
  const files = entries
    .filter((e) => e.endsWith(".backfill.jsonl"))
    .map((e) => path.join(logDir, e));

  const records: BackfillDayRecord[] = [];
  for (const file of files) {
    records.push(...(await parseBackfillFile(file, since)));
  }
  return records.sort((a, b) => a.date.localeCompare(b.date));
}

async function parseBackfillFile(
  filePath: string,
  since?: Date,
): Promise<BackfillDayRecord[]> {
  const records: BackfillDayRecord[] = [];
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        const record = parseDaySummary(event, since);
        if (record) records.push(record);
      } catch {
        // ungültige Zeile überspringen
      }
    }
  } catch {
    // Datei nicht lesbar – ignorieren
  }
  return records;
}

function parseDaySummary(
  event: Record<string, unknown>,
  since?: Date,
): BackfillDayRecord | null {
  if (event.kind !== "tokens.daySummary") return null;
  const provider = event.provider;
  if (provider !== "claude" && provider !== "codex") return null;
  const date = typeof event.date === "string" ? event.date : null;
  if (!date) return null;
  if (since && new Date(`${date}T00:00:00.000Z`) < since) return null;

  const perModelRaw = event.perModel;
  const perModel: Record<string, BackfillPerModelEntry> = {};
  if (perModelRaw && typeof perModelRaw === "object" && !Array.isArray(perModelRaw)) {
    for (const [model, pm] of Object.entries(perModelRaw as Record<string, unknown>)) {
      if (!pm || typeof pm !== "object" || Array.isArray(pm)) continue;
      const p = pm as Record<string, unknown>;
      const inputTokens = num(p.input);
      const outputTokens = num(p.output);
      const cacheCreationTokens = num(p.cacheCreation);
      const cacheReadTokens = num(p.cacheRead ?? p.cachedInput);
      const reasoningOutput = num(p.reasoningOutput);
      const totalTokens = provider === "claude"
        ? inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
        : inputTokens + outputTokens + reasoningOutput;
      perModel[model] = {
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        totalTokens,
        costUSD: num(p.costUSD),
      };
    }
  }

  return {
    date,
    provider,
    inputTokens: num(event.input),
    outputTokens: num(event.output),
    cacheCreationTokens: num(event.cacheCreation),
    cacheReadTokens: num(event.cacheRead ?? event.cachedInput),
    totalTokens: num(event.totalTokens),
    costUSD: num(event.totalCostUSD),
    sessionCount: num(event.sessionCount),
    models: Array.isArray(event.models) ? (event.models as string[]) : [],
    perModel,
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
```

- [ ] **Schritt 4: Tests ausführen – müssen grün sein**

```bash
npx vitest run tests/backfill-reader.test.ts
```
Erwartung: 2 Tests PASS.

- [ ] **Schritt 5: Commit**

```bash
git add src/reports/backfill-reader.ts tests/backfill-reader.test.ts
git commit -m "feat(reports): add backfill-reader skeleton"
```

---

## Task 3: Backfill-Reader – Parsen von daySummary-Events

**Files:**
- Modify: `tests/backfill-reader.test.ts`
- (Implementierung ist bereits in Task 2 vollständig – hier nur Tests ergänzen)

- [ ] **Schritt 1: Tests für Claude- und Codex-Parsing schreiben**

In `tests/backfill-reader.test.ts`, nach den bestehenden Tests ergänzen:

```typescript
async function writeBackfill(filePath: string, events: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // jeder Event bekommt ein ts-Feld (wie echter Recorder), nur kind/date etc. zählen
  await fs.writeFile(
    filePath,
    events.map((e) => JSON.stringify({ ts: new Date().toISOString(), ...e as object })).join("\n") + "\n",
    "utf8",
  );
}

it("parst Claude-daySummary korrekt", async () => {
  await writeBackfill(path.join(tmpDir, "2026-05-20.backfill.jsonl"), [
    {
      kind: "tokens.daySummary", provider: "claude", date: "2026-05-20",
      input: 1000, output: 500, cacheCreation: 200, cacheRead: 3000,
      totalTokens: 4700, totalCostUSD: 0.025, sessionCount: 3,
      models: ["claude-sonnet-4-6"],
      perModel: {
        "claude-sonnet-4-6": { input: 1000, output: 500, cacheCreation: 200, cacheRead: 3000, costUSD: 0.025 },
      },
    },
  ]);

  const records = await readBackfillDayRecords(tmpDir);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    date: "2026-05-20",
    provider: "claude",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 200,
    cacheReadTokens: 3000,
    totalTokens: 4700,
    costUSD: 0.025,
    sessionCount: 3,
    models: ["claude-sonnet-4-6"],
  });
  expect(records[0].perModel["claude-sonnet-4-6"]).toMatchObject({
    inputTokens: 1000, outputTokens: 500,
    cacheCreationTokens: 200, cacheReadTokens: 3000,
    totalTokens: 4700, costUSD: 0.025,
  });
});

it("parst Codex-daySummary korrekt (cachedInput → cacheReadTokens)", async () => {
  await writeBackfill(path.join(tmpDir, "2026-05-21.backfill.jsonl"), [
    {
      kind: "tokens.daySummary", provider: "codex", date: "2026-05-21",
      input: 50000, output: 800, cachedInput: 47000, reasoningOutput: 200,
      totalTokens: 51000, totalCostUSD: 1.23, sessionCount: 2,
      models: ["gpt-5.5"],
      perModel: {
        "gpt-5.5": { input: 50000, output: 800, cachedInput: 47000, reasoningOutput: 200, costUSD: 1.23 },
      },
    },
  ]);

  const records = await readBackfillDayRecords(tmpDir);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    date: "2026-05-21", provider: "codex",
    inputTokens: 50000, outputTokens: 800,
    cacheReadTokens: 47000,   // cachedInput landet hier
    cacheCreationTokens: 0,
    totalTokens: 51000, costUSD: 1.23,
  });
  expect(records[0].perModel["gpt-5.5"].cacheReadTokens).toBe(47000);
});

it("filtert nach since-Datum", async () => {
  await writeBackfill(path.join(tmpDir, "2026-05-18.backfill.jsonl"), [
    { kind: "tokens.daySummary", provider: "claude", date: "2026-05-18",
      input: 1, output: 1, totalTokens: 2, totalCostUSD: 0, sessionCount: 1, models: [], perModel: {} },
  ]);
  await writeBackfill(path.join(tmpDir, "2026-05-20.backfill.jsonl"), [
    { kind: "tokens.daySummary", provider: "claude", date: "2026-05-20",
      input: 2, output: 2, totalTokens: 4, totalCostUSD: 0, sessionCount: 1, models: [], perModel: {} },
  ]);

  const since = new Date("2026-05-19T00:00:00.000Z");
  const records = await readBackfillDayRecords(tmpDir, since);
  expect(records).toHaveLength(1);
  expect(records[0].date).toBe("2026-05-20");
});

it("ignoriert non-daySummary-Zeilen und ungültiges JSON", async () => {
  await writeBackfill(path.join(tmpDir, "2026-05-20.backfill.jsonl"), [
    { kind: "tokens.usage", provider: "claude", model: "x", session: "s", input: 1, output: 1 },
    { kind: "backfill.start", days: [] },
  ]);
  // eine ungültige Zeile direkt hinzufügen
  await fs.appendFile(path.join(tmpDir, "2026-05-20.backfill.jsonl"), "not-json\n", "utf8");

  const records = await readBackfillDayRecords(tmpDir);
  expect(records).toHaveLength(0);
});
```

- [ ] **Schritt 2: Tests ausführen**

```bash
npx vitest run tests/backfill-reader.test.ts
```
Erwartung: alle 6 Tests PASS.

- [ ] **Schritt 3: Alle Tests grün**

```bash
npx vitest run
```
Erwartung: alle Tests PASS.

- [ ] **Schritt 4: Commit**

```bash
git add tests/backfill-reader.test.ts
git commit -m "test(reports): add backfill-reader parsing and filtering tests"
```

---

## Task 4: `buildRowsFromBackfill` in `reportService.ts`

**Files:**
- Modify: `src/reports/reportService.ts`

- [ ] **Schritt 1: `ReportDeps` erweitern**

In `src/reports/reportService.ts`, `ReportDeps` um zwei Felder ergänzen:

```typescript
export interface ReportDeps {
  settings?: Settings;
  claudeProjectsDirs?: string[];
  codexSessionsDirs?: string[];
  codexConfigPaths?: string[];
  claudeEntries?: ClaudeUsageEntry[];
  codexEvents?: CodexTokenEvent[];
  backfillLogDir?: string;           // Pfad zum debug-Verzeichnis
  backfillRecords?: BackfillDayRecord[]; // direkte Übergabe für Tests
}
```

- [ ] **Schritt 2: Import hinzufügen**

Am Anfang von `src/reports/reportService.ts` nach den bestehenden Imports:

```typescript
import { readBackfillDayRecords } from "./backfill-reader";
import type { BackfillDayRecord } from "./types";
```

- [ ] **Schritt 3: `source` normalisieren**

In der `normalizeRequest`-Funktion das neue Feld ergänzen:

```typescript
function normalizeRequest(request: ReportRequest) {
  return {
    provider: request.provider ?? "all",
    type: request.type ?? "daily",
    since: request.since,
    until: request.until,
    timezone: request.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    project: request.project?.trim() || undefined,
    instances: Boolean(request.instances),
    costMode: request.costMode ?? "auto",
    codexSpeed: request.codexSpeed ?? "auto",
    order: request.order ?? "desc",
    breakdown: Boolean(request.breakdown),
    source: request.source ?? "live",
  } as const;
}
```

- [ ] **Schritt 4: Backfill-Pfad in `generateUsageReport` einbauen**

Den Beginn von `generateUsageReport` so ändern:

```typescript
export async function generateUsageReport(request: ReportRequest, deps: ReportDeps = {}): Promise<ReportResult> {
  const normalized = normalizeRequest(request);

  // Backfill-Pfad: schneller, nutzt vorberechnete daySummary-Events.
  // Einschränkungen: kein session-Typ, kein project-Filter, kein instances-Flag.
  const useBackfill = normalized.source === "backfill"
    && normalized.type !== "session"
    && !normalized.project
    && !normalized.instances;

  if (useBackfill) {
    const sinceDate = normalized.since ? new Date(`${normalized.since}T00:00:00.000Z`) : undefined;
    const records = deps.backfillRecords
      ?? await readBackfillDayRecords(deps.backfillLogDir ?? getDebugLogDir(), sinceDate);
    const rows = buildRowsFromBackfill(records, normalized).sort(
      (a, b) => normalized.order === "asc" ? a.bucket.localeCompare(b.bucket) : b.bucket.localeCompare(a.bucket),
    );
    return {
      request: normalized,
      rows,
      totals: sumRows(rows),
      generatedAt: new Date().toISOString(),
    };
  }

  // bisheriger Live-Pfad
  const settings = deps.settings ?? defaultSettings;
  const fetcher = new LiteLLMFetcher(settings.pricingOfflineMode);
  const rows: ReportRow[] = [];
  const start = new Date("1970-01-01T00:00:00.000Z");
  // ... (restlicher Code unverändert)
```

Außerdem muss `getDebugLogDir` importiert werden:

```typescript
import { getClaudeProjectsDirs, getCodexConfigPaths, getCodexSessionsDirs, getDebugLogDir } from "../config/paths";
```

- [ ] **Schritt 5: `buildRowsFromBackfill` implementieren**

Neue private Funktion am Ende von `reportService.ts` (vor den Hilfsfunktionen):

```typescript
function buildRowsFromBackfill(
  records: BackfillDayRecord[],
  request: ReturnType<typeof normalizeRequest>,
): ReportRow[] {
  // Filtere nach Provider und until-Datum
  const filtered = records.filter((r) => {
    if (request.provider !== "all" && r.provider !== request.provider) return false;
    if (request.until && r.date > request.until) return false;
    return true;
  });

  // Gruppiere nach provider + bucket
  const buckets = new Map<string, BackfillDayRecord[]>();
  for (const r of filtered) {
    // Verwende Mittag UTC als Proxy-Timestamp für Zeitzonen-Bucketing
    const timestamp = `${r.date}T12:00:00.000Z`;
    const bucket = bucketFor(timestamp, request.type, request.timezone);
    const key = `${r.provider}\0${bucket}`;
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }

  const rows: ReportRow[] = [];
  for (const [key, list] of buckets) {
    const [provider, bucket] = key.split("\0") as ["claude" | "codex", string];
    const totals = list.reduce(
      (acc, r) => ({
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        cacheCreationTokens: acc.cacheCreationTokens + r.cacheCreationTokens,
        cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
        totalTokens: acc.totalTokens + r.totalTokens,
        costUSD: acc.costUSD + r.costUSD,
      }),
      { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUSD: 0 },
    );

    const modelSet = new Set<string>();
    const modelAgg = new Map<string, BackfillPerModelEntry>();
    for (const r of list) {
      r.models.forEach((m) => modelSet.add(m));
      for (const [model, pm] of Object.entries(r.perModel)) {
        const acc = modelAgg.get(model) ?? { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUSD: 0 };
        modelAgg.set(model, {
          inputTokens: acc.inputTokens + pm.inputTokens,
          outputTokens: acc.outputTokens + pm.outputTokens,
          cacheCreationTokens: acc.cacheCreationTokens + pm.cacheCreationTokens,
          cacheReadTokens: acc.cacheReadTokens + pm.cacheReadTokens,
          totalTokens: acc.totalTokens + pm.totalTokens,
          costUSD: acc.costUSD + pm.costUSD,
        });
      }
    }

    const row: ReportRow = {
      bucket,
      provider,
      ...totals,
      models: Array.from(modelSet),
    };

    if (request.breakdown) {
      row.modelBreakdowns = Array.from(modelAgg.entries()).map(([model, pm]) => ({
        model,
        inputTokens: pm.inputTokens,
        outputTokens: pm.outputTokens,
        cacheCreationTokens: pm.cacheCreationTokens,
        cacheReadTokens: pm.cacheReadTokens,
        totalTokens: pm.totalTokens,
        costUSD: pm.costUSD,
      }));
    }

    rows.push(row);
  }
  return rows;
}
```

Außerdem fehlt der Import für `BackfillPerModelEntry` (wird in `buildRowsFromBackfill` verwendet) — zu den bestehenden Type-Imports ergänzen:

```typescript
import type { BackfillDayRecord, BackfillPerModelEntry } from "./types";
```

- [ ] **Schritt 6: TypeScript kompilieren**

```bash
npm run build
```
Erwartung: kein Fehler.

- [ ] **Schritt 7: Alle bisherigen Tests noch grün**

```bash
npx vitest run
```
Erwartung: alle Tests PASS.

- [ ] **Schritt 8: Commit**

```bash
git add src/reports/reportService.ts
git commit -m "feat(reports): add buildRowsFromBackfill and source:backfill routing"
```

---

## Task 5: Integration-Tests für `source: "backfill"`

**Files:**
- Modify: `tests/reports.test.ts`

- [ ] **Schritt 1: Tests schreiben**

In `tests/reports.test.ts` eine neue `describe`-Gruppe nach den bestehenden Tests ergänzen:

```typescript
describe("source: backfill", () => {
  async function writeBackfill(dir: string, events: unknown[]): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    const lines = events.map((e) => JSON.stringify({ ts: new Date().toISOString(), ...e as object }));
    // Dateiname aus dem date-Feld des ersten daySummary-Events bestimmen
    const date = (events.find((e) => (e as { kind?: string }).kind === "tokens.daySummary") as { date?: string } | undefined)?.date ?? "2026-01-01";
    await fs.writeFile(path.join(dir, `${date}.backfill.jsonl`), lines.join("\n") + "\n", "utf8");
  }

  it("gibt tägliche Claude-Zeilen mit vorberechneten Kosten zurück", async () => {
    const logDir = path.join(tmpRoot, "backfill-daily");
    await writeBackfill(logDir, [
      { kind: "tokens.daySummary", provider: "claude", date: "2026-05-18",
        input: 1000, output: 500, cacheCreation: 0, cacheRead: 2000,
        totalTokens: 3500, totalCostUSD: 0.05, sessionCount: 2,
        models: ["claude-sonnet-4-6"],
        perModel: { "claude-sonnet-4-6": { input: 1000, output: 500, cacheCreation: 0, cacheRead: 2000, costUSD: 0.05 } } },
    ]);
    await writeBackfill(logDir, [
      { kind: "tokens.daySummary", provider: "claude", date: "2026-05-19",
        input: 200, output: 100, cacheCreation: 0, cacheRead: 500,
        totalTokens: 800, totalCostUSD: 0.01, sessionCount: 1,
        models: ["claude-sonnet-4-6"],
        perModel: { "claude-sonnet-4-6": { input: 200, output: 100, cacheCreation: 0, cacheRead: 500, costUSD: 0.01 } } },
    ]);

    const report = await generateUsageReport({
      provider: "claude", type: "daily",
      since: "2026-05-18", until: "2026-05-19",
      timezone: "UTC", order: "asc", source: "backfill",
    }, { backfillLogDir: logDir });

    expect(report.rows).toHaveLength(2);
    expect(report.rows[0]).toMatchObject({ bucket: "2026-05-18", provider: "claude", costUSD: 0.05, inputTokens: 1000 });
    expect(report.rows[1]).toMatchObject({ bucket: "2026-05-19", provider: "claude", costUSD: 0.01 });
    expect(report.totals.costUSD).toBeCloseTo(0.06, 6);
  });

  it("aggregiert mehrere Tage zu wöchentlichen Zeilen", async () => {
    const logDir = path.join(tmpRoot, "backfill-weekly");
    // 2026-05-18 = Montag (KW21), 2026-05-25 = Montag (KW22)
    for (const [date, cost] of [["2026-05-18", 1.0], ["2026-05-19", 2.0], ["2026-05-25", 3.0]] as [string, number][]) {
      await writeBackfill(logDir, [
        { kind: "tokens.daySummary", provider: "codex", date,
          input: 1000, output: 100, cachedInput: 900, reasoningOutput: 10,
          totalTokens: 1110, totalCostUSD: cost, sessionCount: 1,
          models: ["gpt-5.5"],
          perModel: { "gpt-5.5": { input: 1000, output: 100, cachedInput: 900, reasoningOutput: 10, costUSD: cost } } },
      ]);
    }

    const report = await generateUsageReport({
      provider: "codex", type: "weekly",
      timezone: "UTC", order: "asc", source: "backfill",
    }, { backfillLogDir: logDir });

    expect(report.rows).toHaveLength(2);
    expect(report.rows[0]).toMatchObject({ bucket: "2026-W21", costUSD: 3.0 }); // 1.0 + 2.0
    expect(report.rows[1]).toMatchObject({ bucket: "2026-W22", costUSD: 3.0 });
  });

  it("fällt auf live zurück wenn type=session und source=backfill", async () => {
    const logDir = path.join(tmpRoot, "backfill-session-fallback");
    const claudeRoot = path.join(tmpRoot, "claude-fallback", "projects");
    await writeJsonl(path.join(claudeRoot, "proj", "session.jsonl"), [
      { timestamp: "2026-05-18T10:00:00.000Z", costUSD: 5,
        message: { id: "m1", model: "claude-haiku-4-5", usage: { output_tokens: 100 } } },
    ]);

    // source=backfill + type=session → muss live-Pfad nehmen
    const report = await generateUsageReport({
      provider: "claude", type: "session",
      timezone: "UTC", source: "backfill",
    }, {
      settings: { ...defaultSettings, pricingOfflineMode: true },
      claudeProjectsDirs: [claudeRoot],
      codexSessionsDirs: [],
      codexConfigPaths: [],
      backfillLogDir: logDir,
    });

    // Live-Pfad liefert session-Zeilen (backfill kennt keine Sessions)
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.rows[0].session).toBeDefined();
  });

  it("gibt model-Breakdowns zurück wenn breakdown=true", async () => {
    const logDir = path.join(tmpRoot, "backfill-breakdown");
    await writeBackfill(logDir, [
      { kind: "tokens.daySummary", provider: "claude", date: "2026-05-18",
        input: 1000, output: 500, cacheCreation: 0, cacheRead: 0,
        totalTokens: 1500, totalCostUSD: 0.02, sessionCount: 1,
        models: ["claude-sonnet-4-6", "claude-haiku-4-5"],
        perModel: {
          "claude-sonnet-4-6": { input: 800, output: 400, cacheCreation: 0, cacheRead: 0, costUSD: 0.015 },
          "claude-haiku-4-5":  { input: 200, output: 100, cacheCreation: 0, cacheRead: 0, costUSD: 0.005 },
        } },
    ]);

    const report = await generateUsageReport({
      provider: "claude", type: "daily", timezone: "UTC",
      source: "backfill", breakdown: true,
    }, { backfillLogDir: logDir });

    expect(report.rows[0].modelBreakdowns).toHaveLength(2);
    const sonnet = report.rows[0].modelBreakdowns!.find((b) => b.model === "claude-sonnet-4-6");
    expect(sonnet).toMatchObject({ inputTokens: 800, costUSD: 0.015 });
  });
});
```

- [ ] **Schritt 2: Tests ausführen – müssen grün sein**

```bash
npx vitest run tests/reports.test.ts
```
Erwartung: alle Tests (inkl. neue) PASS.

- [ ] **Schritt 3: Alle Tests grün**

```bash
npx vitest run
```
Erwartung: alle Tests PASS.

- [ ] **Schritt 4: Commit**

```bash
git add tests/reports.test.ts
git commit -m "test(reports): integration tests for source:backfill report generation"
```

---

## Bekannte Einschränkungen (kein separater Task nötig)

| Szenario | Verhalten |
|----------|-----------|
| `source: "backfill"` + `type: "session"` | Fällt auf live zurück |
| `source: "backfill"` + `project: "x"` | Fällt auf live zurück |
| `source: "backfill"` + `instances: true` | Fällt auf live zurück |
| `costMode` bei `source: "backfill"` | Ignoriert — Kosten kommen direkt aus den Backfill-Dateien |
| Tage ohne Backfill-Datei | Tauchen nicht in den Ergebnissen auf |
| Backfill mit `totalCostUSD: 0` (alte Dateien vor dem LiteLLM-Fix) | Korrekt — Kosten sind 0, kein Fehler |

---

## Self-Review

**Spec coverage:**
- ✅ `backfill-reader.ts` liest und parst `tokens.daySummary`
- ✅ `since`-Filter im Reader
- ✅ `source: "backfill"` in `ReportRequest`
- ✅ Daily/weekly/monthly Aggregation aus Backfill
- ✅ `provider` Filter (all/claude/codex)
- ✅ `until` Filter
- ✅ `breakdown` mit `modelBreakdowns`
- ✅ Fallback auf live für session/project/instances
- ✅ `backfillLogDir` default auf `getDebugLogDir()`
- ✅ `backfillRecords` für Test-Injection

**Placeholder-Scan:** Keine TBDs, keine offenen Punkte.

**Type-Konsistenz:**
- `BackfillPerModelEntry` in `types.ts` definiert, in `backfill-reader.ts` und `reportService.ts` importiert ✅
- `BackfillDayRecord` in `types.ts`, exportiert aus `backfill-reader.ts` re-exportiert ✅ (nein – importiert direkt aus `./types` in beiden Dateien)
- `bucketFor` ist in `reportService.ts` bereits privat vorhanden und wird von `buildRowsFromBackfill` genutzt ✅

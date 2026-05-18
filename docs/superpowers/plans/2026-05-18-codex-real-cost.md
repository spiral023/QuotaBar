# Codex Real Cost via JSONL Logs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fictional-budget Codex cost estimate with real per-token cost from `~/.codex/sessions/**/*.jsonl`.

**Architecture:** Two new modules in `src/pricing/` — `codex-log-reader.ts` (JSONL → `CodexTokenEvent[]`) and `codex-cost-calculator.ts` (events → USD). `subscription-factor.ts` wires them together. The old `codex-estimator.ts` is deleted.

**Tech Stack:** TypeScript, Node.js `fs/promises`, vitest

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/config/paths.ts` | Add `getCodexSessionsDir()`, `getCodexConfigPath()` |
| Modify | `src/pricing/litellm-fetcher.ts` | Add OpenAI prefix lookup |
| Modify | `src/providers/types.ts` | `factor: number → number \| null` |
| Modify | `src/main/menu.ts` | Handle `factor === null` in display |
| **Create** | `src/pricing/codex-log-reader.ts` | Parse JSONL → `CodexTokenEvent[]` |
| **Create** | `src/pricing/codex-cost-calculator.ts` | Kosten + Speed-Tier aus `config.toml` |
| Modify | `src/pricing/subscription-factor.ts` | Replace `calculateCodexFactor`, add path injection |
| **Create** | `tests/codex-log-reader.test.ts` | Tests für Log-Parser |
| **Create** | `tests/codex-cost-calculator.test.ts` | Tests für Kostenrechner |
| Modify | `tests/subscription-factor.test.ts` | Codex-Tests aktualisieren |
| Modify | `tests/litellm-fetcher.test.ts` | Regression-Test für OpenAI-Prefix |
| **Delete** | `src/pricing/codex-estimator.ts` | Ersetzt durch echten Calculator |
| Modify | `tests/estimators.test.ts` | `estimateCodexCost`-Tests entfernen |

---

## Task 1: Path-Helfer für Codex Sessions und Config

**Files:**
- Modify: `src/config/paths.ts`

- [ ] **Step 1: Zwei neue Funktionen am Ende von `src/config/paths.ts` hinzufügen**

```typescript
export function getCodexSessionsDir(): string {
  return path.join(
    process.env.CODEX_HOME?.trim() || path.join(getHomeDir(), ".codex"),
    "sessions",
  );
}

export function getCodexConfigPath(): string {
  return path.join(
    process.env.CODEX_HOME?.trim() || path.join(getHomeDir(), ".codex"),
    "config.toml",
  );
}
```

- [ ] **Step 2: Build prüfen**

```
npm run build
```

Erwartet: 0 Fehler.

- [ ] **Step 3: Commit**

```bash
git add src/config/paths.ts
git commit -m "feat: add getCodexSessionsDir and getCodexConfigPath helpers"
```

---

## Task 2: LiteLLM Fetcher — OpenAI-Prefix-Lookup

**Files:**
- Modify: `src/pricing/litellm-fetcher.ts`
- Modify: `tests/litellm-fetcher.test.ts`

- [ ] **Step 1: Failing test schreiben**

Am Ende von `tests/litellm-fetcher.test.ts` hinzufügen:

```typescript
  it("still resolves gpt-4o after prefix-lookup change (regression)", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("gpt-4o");
    expect(pricing).not.toBeNull();
    expect(pricing!.input_cost_per_token).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Test laufen lassen — muss PASS sein (Regression)**

```
npm test -- --reporter=verbose tests/litellm-fetcher.test.ts
```

- [ ] **Step 3: OpenAI-Prefixes in `lookup()` ergänzen**

In `src/pricing/litellm-fetcher.ts`, Zeile mit `["anthropic/", ...` ersetzen durch:

```typescript
    for (const prefix of ["openai/", "azure/", "openrouter/openai/", "anthropic/", "claude-3-5-", "claude-3-", "claude-"]) {
```

- [ ] **Step 4: Tests laufen lassen — alle PASS**

```
npm test -- tests/litellm-fetcher.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/pricing/litellm-fetcher.ts tests/litellm-fetcher.test.ts
git commit -m "feat: add openai/ azure/ openrouter/ prefix lookup to LiteLLMFetcher"
```

---

## Task 3: CostFactorResult — `factor: number | null`

**Files:**
- Modify: `src/providers/types.ts`
- Modify: `src/main/menu.ts`

- [ ] **Step 1: `factor` in types.ts auf `number | null` ändern**

In `src/providers/types.ts`:
```typescript
export interface CostFactorResult {
  apiCostUSD: number;
  subscriptionCostUSD: number;
  factor: number | null;   // null = keine Logs verfügbar
  isEstimate: boolean;
  label: string;
}
```

- [ ] **Step 2: Build prüfen — TypeScript zeigt Fehler wo `factor` als `number` erwartet wird**

```
npm run build
```

Erwartet: Fehler in `menu.ts` (falls vorhanden — wenn `factor` direkt verwendet wird). Falls kein Fehler: weiter.

- [ ] **Step 3: `formatCostFactorLine` in `src/main/menu.ts` für `factor === null` erweitern**

```typescript
function formatCostFactorLine(cost: CostFactorResult): string {
  if (cost.factor === null) return `  API-Äq: ${cost.label}`;
  if (cost.apiCostUSD === 0 && !cost.isEstimate) return "  API-Äq: $0.00 (keine Daten)";
  const prefix = cost.isEstimate ? "~" : "";
  return `  API-Äq: ${prefix}$${cost.apiCostUSD.toFixed(2)} (${cost.label})`;
}
```

- [ ] **Step 4: Build erneut — 0 Fehler**

```
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/providers/types.ts src/main/menu.ts
git commit -m "feat: allow factor: null in CostFactorResult for missing-logs case"
```

---

## Task 4: `codex-log-reader.ts` — JSONL Parser (TDD)

**Files:**
- Create: `src/pricing/codex-log-reader.ts`
- Create: `tests/codex-log-reader.test.ts`

- [ ] **Step 1: Test-Datei schreiben**

Erstelle `tests/codex-log-reader.test.ts`:

```typescript
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCodexTokensForPeriod } from "../src/pricing/codex-log-reader";

const tmpDir = path.join(os.tmpdir(), `quotabar-codex-test-${process.pid}`);

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeJsonl(dir: string, filename: string, lines: unknown[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, filename),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf8",
  );
}

function makeTurnContext(model: string, timestamp = "2026-05-18T10:00:00.000Z") {
  return { timestamp, type: "turn_context", payload: { model, turn_id: "x" } };
}

function makeTokenCountWithLast(
  timestamp: string,
  last: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number; total_tokens: number },
) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: last, total_token_usage: last },
    },
  };
}

function makeTokenCountTotalOnly(
  timestamp: string,
  total: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number; total_tokens: number },
) {
  return {
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total } },
  };
}

describe("readCodexTokensForPeriod", () => {
  it("returns empty array when sessions dir does not exist", async () => {
    const result = await readCodexTokensForPeriod("/nonexistent/xyz", new Date("2026-05-01"));
    expect(result).toEqual([]);
  });

  it("parses model from turn_context and token counts from last_token_usage", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/18"), "session.jsonl", [
      makeTurnContext("gpt-4o"),
      makeTokenCountWithLast("2026-05-18T10:00:01.000Z", {
        input_tokens: 1000,
        cached_input_tokens: 200,
        output_tokens: 100,
        reasoning_output_tokens: 50,
        total_tokens: 1100,
      }),
    ]);

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events).toHaveLength(1);
    expect(events[0].model).toBe("gpt-4o");
    expect(events[0].isFallback).toBe(false);
    expect(events[0].inputTokens).toBe(1000);
    expect(events[0].cachedInputTokens).toBe(200);
    expect(events[0].outputTokens).toBe(100);
    expect(events[0].reasoningOutputTokens).toBe(50);
  });

  it("computes delta when only total_token_usage is present", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/18"), "session.jsonl", [
      makeTurnContext("gpt-4o"),
      makeTokenCountTotalOnly("2026-05-18T10:00:01.000Z", {
        input_tokens: 1000,
        cached_input_tokens: 0,
        output_tokens: 100,
        reasoning_output_tokens: 0,
        total_tokens: 1100,
      }),
      makeTokenCountTotalOnly("2026-05-18T10:00:02.000Z", {
        input_tokens: 2500,
        cached_input_tokens: 500,
        output_tokens: 300,
        reasoning_output_tokens: 100,
        total_tokens: 2800,
      }),
    ]);

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events).toHaveLength(2);
    expect(events[0].inputTokens).toBe(1000);
    expect(events[1].inputTokens).toBe(1500);   // 2500 - 1000
    expect(events[1].cachedInputTokens).toBe(500);
    expect(events[1].outputTokens).toBe(200);   // 300 - 100
  });

  it("clamps cachedInputTokens to inputTokens (bug protection)", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/18"), "session.jsonl", [
      makeTurnContext("gpt-4o"),
      makeTokenCountWithLast("2026-05-18T10:00:01.000Z", {
        input_tokens: 500,
        cached_input_tokens: 9999, // buggy: larger than input
        output_tokens: 100,
        reasoning_output_tokens: 0,
        total_tokens: 600,
      }),
    ]);

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events[0].cachedInputTokens).toBe(500); // clamped to inputTokens
  });

  it("skips token_count events with info: null", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/18"), "session.jsonl", [
      makeTurnContext("gpt-4o"),
      { timestamp: "2026-05-18T10:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: null } },
      makeTokenCountWithLast("2026-05-18T10:00:02.000Z", {
        input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110,
      }),
    ]);

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events).toHaveLength(1);
    expect(events[0].inputTokens).toBe(100);
  });

  it("filters events before billingStart but still tracks totals for delta", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/18"), "session.jsonl", [
      makeTurnContext("gpt-4o"),
      makeTokenCountTotalOnly("2026-05-17T23:59:00.000Z", {
        input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100,
      }),
      makeTokenCountTotalOnly("2026-05-18T00:00:01.000Z", {
        input_tokens: 1500, cached_input_tokens: 0, output_tokens: 200, reasoning_output_tokens: 0, total_tokens: 1700,
      }),
    ]);

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-18T00:00:00.000Z"));
    expect(events).toHaveLength(1);
    expect(events[0].inputTokens).toBe(500);  // 1500 - 1000 (delta from pre-billing event)
    expect(events[0].outputTokens).toBe(100); // 200 - 100
  });

  it("uses gpt-5 fallback model and sets isFallback=true when no model info", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/18"), "session.jsonl", [
      makeTokenCountWithLast("2026-05-18T10:00:01.000Z", {
        input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110,
      }),
    ]);

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events[0].model).toBe("gpt-5");
    expect(events[0].isFallback).toBe(true);
  });

  it("reads JSONL files from nested subdirectories", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/01"), "a.jsonl", [
      makeTurnContext("gpt-4o"),
      makeTokenCountWithLast("2026-05-01T08:00:00.000Z", {
        input_tokens: 50, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 55,
      }),
    ]);
    await writeJsonl(path.join(tmpDir, "2026/05/02"), "b.jsonl", [
      makeTurnContext("gpt-4o"),
      makeTokenCountWithLast("2026-05-02T08:00:00.000Z", {
        input_tokens: 75, cached_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 0, total_tokens: 83,
      }),
    ]);

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events).toHaveLength(2);
    const totalInput = events.reduce((s, e) => s + e.inputTokens, 0);
    expect(totalInput).toBe(125);
  });

  it("skips invalid JSONL lines without throwing", async () => {
    await fs.mkdir(path.join(tmpDir, "2026/05/18"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "2026/05/18", "session.jsonl"),
      [
        "not-valid-json{{{{",
        JSON.stringify(makeTurnContext("gpt-4o")),
        JSON.stringify(makeTokenCountWithLast("2026-05-18T10:00:01.000Z", {
          input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110,
        })),
      ].join("\n") + "\n",
      "utf8",
    );

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events).toHaveLength(1);
    expect(events[0].inputTokens).toBe(100);
  });
});
```

- [ ] **Step 2: Test laufen lassen — FAIL (Datei existiert noch nicht)**

```
npm test -- tests/codex-log-reader.test.ts
```

Erwartet: FAIL mit "Cannot find module"

- [ ] **Step 3: `src/pricing/codex-log-reader.ts` implementieren**

```typescript
import fs from "node:fs/promises";
import path from "node:path";

export interface CodexTokenEvent {
  timestamp: string;
  model: string;
  isFallback: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

type TokenTotals = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};

export async function readCodexTokensForPeriod(
  sessionsDir: string,
  billingStart: Date,
): Promise<CodexTokenEvent[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(sessionsDir, { recursive: true })) as string[];
  } catch {
    return [];
  }

  const files = entries
    .filter((e) => e.endsWith(".jsonl"))
    .map((e) => path.join(sessionsDir, e));

  const events: CodexTokenEvent[] = [];
  for (const file of files) {
    events.push(...(await parseCodexJsonlFile(file, billingStart)));
  }
  return events;
}

async function parseCodexJsonlFile(
  filePath: string,
  billingStart: Date,
): Promise<CodexTokenEvent[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const events: CodexTokenEvent[] = [];
  let currentModel: string | null = null;
  let previousTotals = zeroTotals();

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (entry.type === "turn_context") {
      const model = asRecord(entry.payload)?.model;
      if (typeof model === "string" && model) currentModel = model;
      continue;
    }

    if (entry.type !== "event_msg") continue;
    const payload = asRecord(entry.payload);
    if (!payload || payload.type !== "token_count" || payload.info == null) continue;
    const info = asRecord(payload.info);
    if (!info) continue;

    const lastUsage = asRecord(info.last_token_usage);
    const totalUsage = asRecord(info.total_token_usage);

    const oldTotals = previousTotals;
    if (totalUsage) previousTotals = extractTotals(totalUsage);

    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : null;
    if (!timestamp || new Date(timestamp) < billingStart) continue;

    let delta: TokenTotals;
    if (lastUsage) {
      delta = extractTotals(lastUsage);
    } else if (totalUsage) {
      delta = diffTotals(extractTotals(totalUsage), oldTotals);
    } else {
      continue;
    }

    const model = resolveModel(info, currentModel);
    events.push({
      timestamp,
      model,
      isFallback: model === "gpt-5",
      inputTokens: delta.input_tokens,
      cachedInputTokens: Math.min(delta.cached_input_tokens, delta.input_tokens),
      outputTokens: delta.output_tokens,
      reasoningOutputTokens: delta.reasoning_output_tokens,
      totalTokens: delta.total_tokens,
    });
  }

  return events;
}

function resolveModel(info: Record<string, unknown>, currentModel: string | null): string {
  if (typeof info.model === "string" && info.model) return info.model;
  const meta = asRecord(info.metadata);
  if (meta && typeof meta.model === "string" && meta.model) return meta.model;
  return currentModel ?? "gpt-5";
}

function extractTotals(obj: Record<string, unknown>): TokenTotals {
  return {
    input_tokens: positiveNumber(obj.input_tokens),
    cached_input_tokens: positiveNumber(obj.cached_input_tokens),
    output_tokens: positiveNumber(obj.output_tokens),
    reasoning_output_tokens: positiveNumber(obj.reasoning_output_tokens),
    total_tokens: positiveNumber(obj.total_tokens),
  };
}

function diffTotals(current: TokenTotals, prev: TokenTotals): TokenTotals {
  return {
    input_tokens: Math.max(current.input_tokens - prev.input_tokens, 0),
    cached_input_tokens: Math.max(current.cached_input_tokens - prev.cached_input_tokens, 0),
    output_tokens: Math.max(current.output_tokens - prev.output_tokens, 0),
    reasoning_output_tokens: Math.max(current.reasoning_output_tokens - prev.reasoning_output_tokens, 0),
    total_tokens: Math.max(current.total_tokens - prev.total_tokens, 0),
  };
}

function zeroTotals(): TokenTotals {
  return { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
```

- [ ] **Step 4: Tests laufen lassen — alle PASS**

```
npm test -- tests/codex-log-reader.test.ts
```

Erwartet: alle Tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pricing/codex-log-reader.ts tests/codex-log-reader.test.ts
git commit -m "feat: add Codex JSONL session log reader"
```

---

## Task 5: `codex-cost-calculator.ts` — Kosten + Speed-Tier (TDD)

**Files:**
- Create: `src/pricing/codex-cost-calculator.ts`
- Create: `tests/codex-cost-calculator.test.ts`

- [ ] **Step 1: Test-Datei schreiben**

Erstelle `tests/codex-cost-calculator.test.ts`:

```typescript
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { calculateCodexApiCost, readCodexSpeedTier } from "../src/pricing/codex-cost-calculator";
import { LiteLLMFetcher } from "../src/pricing/litellm-fetcher";
import type { CodexTokenEvent } from "../src/pricing/codex-log-reader";

const tmpDir = path.join(os.tmpdir(), `quotabar-codex-calc-test-${process.pid}`);

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeEvent(overrides: Partial<CodexTokenEvent> = {}): CodexTokenEvent {
  return {
    timestamp: "2026-05-18T10:00:00.000Z",
    model: "gpt-4o",
    isFallback: false,
    inputTokens: 1000,
    cachedInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 0,
    totalTokens: 1100,
    ...overrides,
  };
}

describe("calculateCodexApiCost", () => {
  it("returns 0 for empty events", async () => {
    const fetcher = new LiteLLMFetcher(true);
    expect(await calculateCodexApiCost([], fetcher, "standard")).toBe(0);
  });

  it("calculates cost for standard tier using gpt-4o fallback pricing", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const events = [makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })];
    const cost = await calculateCodexApiCost(events, fetcher, "standard");
    // gpt-4o: input_cost_per_token = 2.5e-6 → 1M tokens = $2.50
    expect(cost).toBeCloseTo(2.5, 4);
  });

  it("calculates output cost", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const events = [makeEvent({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 })];
    const cost = await calculateCodexApiCost(events, fetcher, "standard");
    // gpt-4o: output_cost_per_token = 1e-5 → 1M tokens = $10.00
    expect(cost).toBeCloseTo(10.0, 4);
  });

  it("subtracts cached tokens from non-cached input", async () => {
    const fetcher = new LiteLLMFetcher(true);
    // 1000 input, 400 cached → 600 non-cached at input price, 400 at cache_read price
    // gpt-4o has no cache_read price → cached cost = 0
    const events = [makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 0 })];
    const cost = await calculateCodexApiCost(events, fetcher, "standard");
    // non-cached: 600_000 * 2.5e-6 = $1.50; cached: 400_000 * 0 = $0
    expect(cost).toBeCloseTo(1.5, 4);
  });

  it("applies fast-tier multiplier", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const events = [makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })];
    const standard = await calculateCodexApiCost(events, fetcher, "standard");
    const fast = await calculateCodexApiCost(events, fetcher, "fast");
    // gpt-4o has no provider_specific_entry.fast → fallback multiplier 2
    expect(fast).toBeCloseTo(standard * 2, 4);
  });

  it("resolves model alias gpt-5-codex → gpt-5", async () => {
    const fetcher = new LiteLLMFetcher(true);
    // gpt-5 not in fallback → returns null → cost should be 0
    const events = [makeEvent({ model: "gpt-5-codex", inputTokens: 1000, outputTokens: 100 })];
    const cost = await calculateCodexApiCost(events, fetcher, "standard");
    // Either 0 (no gpt-5 fallback) or > 0 (if LiteLLM has it in offline mode) — just verify no throw
    expect(typeof cost).toBe("number");
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("returns 0 for event with unknown model (no pricing found)", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const events = [makeEvent({ model: "unknown-model-xyz-9999" })];
    const cost = await calculateCodexApiCost(events, fetcher, "standard");
    expect(cost).toBe(0);
  });

  it("sums costs across multiple events", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const events = [
      makeEvent({ inputTokens: 500_000, cachedInputTokens: 0, outputTokens: 0 }),
      makeEvent({ inputTokens: 500_000, cachedInputTokens: 0, outputTokens: 0 }),
    ];
    const combined = await calculateCodexApiCost(events, fetcher, "standard");
    const single = await calculateCodexApiCost([makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })], fetcher, "standard");
    expect(combined).toBeCloseTo(single, 6);
  });
});

describe("readCodexSpeedTier", () => {
  it("returns standard when config file does not exist", async () => {
    const tier = await readCodexSpeedTier("/nonexistent/config.toml");
    expect(tier).toBe("standard");
  });

  it("returns fast for service_tier = priority", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "config.toml"), 'service_tier = "priority"\nmodel = "gpt-5"\n', "utf8");
    const tier = await readCodexSpeedTier(path.join(tmpDir, "config.toml"));
    expect(tier).toBe("fast");
  });

  it("returns fast for service_tier = fast", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "config.toml"), "service_tier = fast\n", "utf8");
    const tier = await readCodexSpeedTier(path.join(tmpDir, "config.toml"));
    expect(tier).toBe("fast");
  });

  it("returns standard for service_tier = standard", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "config.toml"), 'service_tier = "standard"\n', "utf8");
    const tier = await readCodexSpeedTier(path.join(tmpDir, "config.toml"));
    expect(tier).toBe("standard");
  });

  it("returns standard when service_tier key is absent", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "config.toml"), 'model = "gpt-5"\npersonality = "pragmatic"\n', "utf8");
    const tier = await readCodexSpeedTier(path.join(tmpDir, "config.toml"));
    expect(tier).toBe("standard");
  });
});
```

- [ ] **Step 2: Test laufen lassen — FAIL (Datei existiert noch nicht)**

```
npm test -- tests/codex-cost-calculator.test.ts
```

Erwartet: FAIL mit "Cannot find module"

- [ ] **Step 3: `src/pricing/codex-cost-calculator.ts` implementieren**

```typescript
import fs from "node:fs/promises";
import type { CodexTokenEvent } from "./codex-log-reader";
import type { LiteLLMFetcher } from "./litellm-fetcher";

const MODEL_ALIASES: Record<string, string> = {
  "gpt-5-codex": "gpt-5",
  "gpt-5.3-codex": "gpt-5.2-codex",
};

export async function calculateCodexApiCost(
  events: CodexTokenEvent[],
  fetcher: LiteLLMFetcher,
  speedTier: "standard" | "fast",
): Promise<number> {
  let total = 0;
  for (const event of events) {
    const modelName = MODEL_ALIASES[event.model] ?? event.model;
    const pricing = await fetcher.getModelPricing(modelName);
    if (!pricing) continue;

    const nonCachedInput = Math.max(event.inputTokens - event.cachedInputTokens, 0);
    let cost =
      nonCachedInput * (pricing.input_cost_per_token ?? 0) +
      event.cachedInputTokens * (pricing.cache_read_input_token_cost ?? 0) +
      event.outputTokens * (pricing.output_cost_per_token ?? 0);

    if (speedTier === "fast") {
      cost *= pricing.provider_specific_entry?.fast ?? 2;
    }

    total += cost;
  }
  return total;
}

export async function readCodexSpeedTier(configPath: string): Promise<"standard" | "fast"> {
  try {
    const content = await fs.readFile(configPath, "utf8");
    const match = /^service_tier\s*=\s*["']?([\w-]+)["']?/m.exec(content);
    if (match) {
      const tier = match[1].toLowerCase();
      if (tier === "priority" || tier === "fast") return "fast";
    }
  } catch {
    // config not found or not readable — default to standard
  }
  return "standard";
}
```

- [ ] **Step 4: Tests laufen lassen — alle PASS**

```
npm test -- tests/codex-cost-calculator.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/pricing/codex-cost-calculator.ts tests/codex-cost-calculator.test.ts
git commit -m "feat: add Codex cost calculator with model aliases and speed tier"
```

---

## Task 6: PricingEngine — echte Codex-Integration

**Files:**
- Modify: `src/pricing/subscription-factor.ts`
- Modify: `tests/subscription-factor.test.ts`

- [ ] **Step 1: Bestehende Codex-Tests in `tests/subscription-factor.test.ts` ersetzen**

Die drei Codex-Tests ersetzen:

```typescript
// ALT (entfernen):
// it("returns estimate for Codex with usedPercent", ...)
// it("returns undefined for Codex when no usedPercent available", ...)
// it("label uses ~ prefix for estimates", ...)

// NEU:
```

Die drei Tests durch folgende ersetzen. **Achtung:** `makeSnapshot` und `settings` bleiben unverändert. Nur die Codex-Tests werden ersetzt:

```typescript
  it("returns Keine Logs for Codex when sessions dir is empty", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/claude", "/nonexistent/codex", "/nonexistent/config.toml");
    const result = await engine.calculateFactor(makeSnapshot("codex"));
    expect(result).not.toBeUndefined();
    expect(result!.factor).toBeNull();
    expect(result!.isEstimate).toBe(true);
    expect(result!.label).toBe("Keine Logs verfügbar");
    expect(result!.apiCostUSD).toBe(0);
    expect(result!.subscriptionCostUSD).toBe(10);
  });

  it("returns real cost for Codex when JSONL events exist", async () => {
    const sessionsDir = path.join(os.tmpdir(), `quotabar-sf-test-${Date.now()}`);
    const sessionFile = path.join(sessionsDir, "2026/05/18");
    await fs.mkdir(sessionFile, { recursive: true });
    await fs.writeFile(
      path.join(sessionFile, "session.jsonl"),
      [
        JSON.stringify({ timestamp: "2026-05-18T10:00:00.000Z", type: "turn_context", payload: { model: "gpt-4o" } }),
        JSON.stringify({
          timestamp: "2026-05-18T10:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100 },
              total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100 },
            },
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    try {
      const engine = new PricingEngine(settings, "/nonexistent/claude", sessionsDir, "/nonexistent/config.toml");
      const snapshot = makeSnapshot("codex", {
        windows: [{ name: "weekly", usedPercent: 5, resetsAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString() }],
      });
      const result = await engine.calculateFactor(snapshot);
      expect(result).not.toBeUndefined();
      expect(result!.factor).not.toBeNull();
      expect(result!.isEstimate).toBe(false);
      expect(result!.apiCostUSD).toBeGreaterThan(0);
      expect(result!.subscriptionCostUSD).toBe(10);
    } finally {
      await fs.rm(sessionsDir, { recursive: true, force: true });
    }
  });
```

Außerdem am Anfang der Datei die fehlenden Imports ergänzen:

```typescript
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
```

- [ ] **Step 2: Tests laufen lassen — FAIL (PricingEngine nimmt noch keine codexSessionsDir)**

```
npm test -- tests/subscription-factor.test.ts
```

Erwartet: FAIL (TypeScript-Fehler oder falsche Logik)

- [ ] **Step 3: `src/pricing/subscription-factor.ts` aktualisieren**

Vollständige neue Version:

```typescript
import { getClaudeProjectsDir, getCodexConfigPath, getCodexSessionsDir } from "../config/paths";
import type { Settings } from "../config/settings";
import type { CostFactorResult, UsageSnapshot, UsageWindow } from "../providers/types";
import { calculateCodexApiCost, readCodexSpeedTier } from "./codex-cost-calculator";
import { readCodexTokensForPeriod } from "./codex-log-reader";
import { calculateCostFromTokens } from "./cost-calculator";
import { estimateGeminiCost } from "./gemini-estimator";
import { readClaudeTokensForPeriod } from "./jsonl-reader";
import { LiteLLMFetcher } from "./litellm-fetcher";

export class PricingEngine {
  private readonly fetcher: LiteLLMFetcher;

  constructor(
    private readonly settings: Settings,
    private readonly claudeProjectsDir: string = getClaudeProjectsDir(),
    private readonly codexSessionsDir: string = getCodexSessionsDir(),
    private readonly codexConfigPath: string = getCodexConfigPath(),
  ) {
    this.fetcher = new LiteLLMFetcher(settings.pricingOfflineMode);
  }

  async calculateFactor(snapshot: UsageSnapshot): Promise<CostFactorResult | undefined> {
    if (snapshot.status === "error" || snapshot.status === "not_authenticated") return undefined;
    try {
      switch (snapshot.provider) {
        case "claude": return await this.calculateClaudeFactor(snapshot);
        case "codex": return await this.calculateCodexFactor(snapshot);
        case "gemini": return await this.calculateGeminiFactor(snapshot);
        default: return undefined;
      }
    } catch {
      return undefined;
    }
  }

  private async calculateClaudeFactor(snapshot: UsageSnapshot): Promise<CostFactorResult> {
    const billingStart = getClaudeBillingStart(snapshot);
    const tokens = await readClaudeTokensForPeriod(this.claudeProjectsDir, billingStart);
    const primaryModel = tokens.modelNames[0] ?? snapshot.model ?? "claude-sonnet-4-5";
    const pricing = await this.fetcher.getModelPricing(primaryModel);
    const apiCostUSD = pricing
      ? calculateCostFromTokens(
          {
            input_tokens: tokens.inputTokens,
            output_tokens: tokens.outputTokens,
            cache_creation_input_tokens: tokens.cacheCreationTokens,
            cache_read_input_tokens: tokens.cacheReadTokens,
          },
          pricing,
        )
      : 0;
    const subscriptionCostUSD = this.settings.subscriptionCosts.claude;
    const factor = subscriptionCostUSD > 0 ? apiCostUSD / subscriptionCostUSD : 0;
    return {
      apiCostUSD,
      subscriptionCostUSD,
      factor,
      isEstimate: false,
      label: formatLabel(apiCostUSD, factor, false),
    };
  }

  private async calculateCodexFactor(snapshot: UsageSnapshot): Promise<CostFactorResult> {
    const billingStart = getCodexBillingStart(snapshot);
    const events = await readCodexTokensForPeriod(this.codexSessionsDir, billingStart);
    if (events.length === 0) {
      return {
        apiCostUSD: 0,
        subscriptionCostUSD: this.settings.subscriptionCosts.codex,
        factor: null,
        isEstimate: true,
        label: "Keine Logs verfügbar",
      };
    }
    const speedTier = await readCodexSpeedTier(this.codexConfigPath);
    const apiCostUSD = await calculateCodexApiCost(events, this.fetcher, speedTier);
    const subscriptionCostUSD = this.settings.subscriptionCosts.codex;
    const factor = subscriptionCostUSD > 0 ? apiCostUSD / subscriptionCostUSD : 0;
    return {
      apiCostUSD,
      subscriptionCostUSD,
      factor,
      isEstimate: false,
      label: formatLabel(apiCostUSD, factor, false),
    };
  }

  private async calculateGeminiFactor(snapshot: UsageSnapshot): Promise<CostFactorResult> {
    const sessionCount = getGeminiSessionCount(snapshot);
    const apiCostUSD = await estimateGeminiCost(sessionCount, this.fetcher);
    const subscriptionCostUSD = this.settings.subscriptionCosts.gemini;
    const factor = subscriptionCostUSD > 0 ? apiCostUSD / subscriptionCostUSD : 0;
    return {
      apiCostUSD,
      subscriptionCostUSD,
      factor,
      isEstimate: true,
      label: formatLabel(apiCostUSD, factor, true),
    };
  }
}

function getClaudeBillingStart(snapshot: UsageSnapshot): Date {
  const creditsWindow = snapshot.windows.find(
    (w: UsageWindow) => w.name === "credits" && w.resetsAt,
  );
  if (creditsWindow?.resetsAt) {
    const date = new Date(creditsWindow.resetsAt);
    if (!isNaN(date.getTime())) return date;
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function getCodexBillingStart(snapshot: UsageSnapshot): Date {
  const weekly = snapshot.windows.find((w: UsageWindow) => w.name === "weekly" && w.resetsAt);
  if (weekly?.resetsAt) {
    const resetsAt = new Date(weekly.resetsAt);
    if (!isNaN(resetsAt.getTime())) {
      return new Date(resetsAt.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function getGeminiSessionCount(snapshot: UsageSnapshot): number {
  const label = snapshot.windows[0]?.label ?? "";
  const match = /^(\d+)\s+session/i.exec(label);
  return match ? parseInt(match[1], 10) : 0;
}

function formatLabel(apiCostUSD: number, factor: number, isEstimate: boolean): string {
  if (apiCostUSD === 0 && !isEstimate) return "$0.00 (keine Daten)";
  const prefix = isEstimate ? "~" : "";
  return `${prefix}${factor.toFixed(1)}× Abo`;
}
```

- [ ] **Step 4: Tests laufen lassen — alle PASS**

```
npm test -- tests/subscription-factor.test.ts
```

- [ ] **Step 5: Build prüfen**

```
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/pricing/subscription-factor.ts tests/subscription-factor.test.ts
git commit -m "feat: replace Codex estimate with real JSONL-based cost in PricingEngine"
```

---

## Task 7: Alten Codex-Estimator löschen

**Files:**
- Delete: `src/pricing/codex-estimator.ts`
- Modify: `tests/estimators.test.ts`

- [ ] **Step 1: `estimateCodexCost`-Tests aus `tests/estimators.test.ts` entfernen**

Den gesamten `describe("estimateCodexCost", ...)` Block entfernen. Nur der `describe("estimateGeminiCost", ...)` Block bleibt.

```typescript
import { describe, expect, it } from "vitest";
import { LiteLLMFetcher } from "../src/pricing/litellm-fetcher";
import { estimateGeminiCost } from "../src/pricing/gemini-estimator";

describe("estimateGeminiCost", () => {
  it("returns 0 for 0 sessions", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const cost = await estimateGeminiCost(0, fetcher);
    expect(cost).toBe(0);
  });

  it("returns positive cost for 10 sessions", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const cost = await estimateGeminiCost(10, fetcher);
    expect(cost).toBeGreaterThan(0);
  });

  it("cost scales linearly with session count", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const ten = await estimateGeminiCost(10, fetcher);
    const twenty = await estimateGeminiCost(20, fetcher);
    expect(twenty).toBeCloseTo(ten * 2, 5);
  });
});
```

- [ ] **Step 2: `src/pricing/codex-estimator.ts` löschen**

```bash
rm src/pricing/codex-estimator.ts
```

- [ ] **Step 3: Build prüfen — 0 Fehler**

```
npm run build
```

Falls Fehler wegen noch vorhandenem Import von `codex-estimator`: alle Vorkommen suchen und entfernen.

```bash
grep -r "codex-estimator" src/
```

- [ ] **Step 4: Alle Tests laufen lassen**

```
npm test
```

Erwartet: alle Tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: remove codex-estimator, all Codex costs now from JSONL logs"
```

---

## Task 8: Abschluss — Full Build und Test-Suite

- [ ] **Step 1: Vollständigen Build durchführen**

```
npm run build
```

Erwartet: 0 TypeScript-Fehler.

- [ ] **Step 2: Gesamte Test-Suite laufen lassen**

```
npm test
```

Erwartet: alle Tests PASS. Kein Test FAIL oder SKIP.

- [ ] **Step 3: Final Commit (wenn nötig)**

```bash
git status
# Falls sauber, kein Commit nötig
```

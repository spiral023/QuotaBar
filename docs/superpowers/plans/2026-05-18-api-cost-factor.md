# API-Kosten-Faktor-Berechnung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Im Tray-Menü pro Provider anzeigen, wie viel die genutzte Claude/Codex/Gemini-Nutzung als Pay-per-Use API gekostet hätte vs. das monatliche Abo.

**Architecture:** Neues Modul `src/pricing/` mit 5 Dateien. Claude: exakte Kosten via JSONL-Logs + LiteLLM-Preise. Codex/Gemini: Schätzungen (markiert mit `~`). `PricingEngine`-Klasse wird als optionaler Parameter in `RefreshLoop` eingehängt und bereichert jeden Snapshot mit `costFactor?` vor dem Store-Update.

**Tech Stack:** TypeScript, Node.js fs/promises (rekursives readdir), native fetch (Electron/Node 20), vitest.

---

## Dateistruktur

**Neu:**
- `src/pricing/cost-calculator.ts` – ModelPricing-Typ + reine Token→USD-Funktionen
- `src/pricing/litellm-fetcher.ts` – HTTP-Fetch, In-Memory-Cache, Modell-Lookup
- `src/pricing/jsonl-reader.ts` – liest `~/.claude/projects/**/*.jsonl`, aggregiert Tokens
- `src/pricing/codex-estimator.ts` – schätzt Codex-Kosten aus usedPercent
- `src/pricing/gemini-estimator.ts` – schätzt Gemini-Kosten aus Session-Anzahl
- `src/pricing/subscription-factor.ts` – PricingEngine-Klasse (Top-Level-Koordinator)
- `tests/cost-calculator.test.ts`
- `tests/litellm-fetcher.test.ts`
- `tests/jsonl-reader.test.ts`
- `tests/subscription-factor.test.ts`

**Geändert:**
- `src/providers/types.ts` – CostFactorResult + costFactor? auf UsageSnapshot
- `src/config/settings.ts` – subscriptionCosts + pricingOfflineMode
- `src/config/paths.ts` – getClaudeProjectsDir()
- `src/usage/refreshLoop.ts` – optionaler PricingEngine-Parameter
- `src/main/menu.ts` – Kostenzeile pro Provider-Block
- `src/main/main.ts` – PricingEngine erstellen und verdrahten

---

## Task 1: Foundation – Types, Settings, Paths

**Files:**
- Modify: `src/providers/types.ts`
- Modify: `src/config/settings.ts`
- Modify: `src/config/paths.ts`

- [ ] **Step 1.1: CostFactorResult zu types.ts hinzufügen**

In `src/providers/types.ts` das Interface `CostFactorResult` nach dem Import-Statement einfügen und `costFactor?` zu `UsageSnapshot` hinzufügen:

```typescript
import type { UsagePace } from "../usage/usagePace";

export interface CostFactorResult {
  apiCostUSD: number;
  subscriptionCostUSD: number;
  factor: number;
  isEstimate: boolean;
  label: string;
}

export type UsageStatus = "ok" | "not_authenticated" | "error" | "stale";

// ... (UsageProvider, UsageWindow unverändert) ...

export interface UsageSnapshot {
  provider: string;
  status: UsageStatus;
  planType?: string;
  model?: string;
  identity?: {
    email?: string;
    accountId?: string;
  };
  windows: UsageWindow[];
  updatedAt: string;
  errorMessage?: string;
  costFactor?: CostFactorResult;
}
```

- [ ] **Step 1.2: Settings um Pricing-Felder erweitern**

`src/config/settings.ts` vollständig ersetzen:

```typescript
import fs from "node:fs/promises";
import { ensureConfigDir } from "../main/logging";
import { getSettingsPath } from "./paths";

export interface SubscriptionCosts {
  claude: number;
  codex: number;
  gemini: number;
}

export interface Settings {
  pollIntervalSeconds: number;
  providerTimeoutMs: number;
  subscriptionCosts: SubscriptionCosts;
  pricingOfflineMode: boolean;
}

export const defaultSettings: Settings = {
  pollIntervalSeconds: 60,
  providerTimeoutMs: 10_000,
  subscriptionCosts: { claude: 20, codex: 10, gemini: 19 },
  pricingOfflineMode: false
};

export async function loadSettings(overrides: Partial<Settings> = {}): Promise<Settings> {
  try {
    const parsed = JSON.parse(await fs.readFile(getSettingsPath(), "utf8")) as Partial<Settings>;
    return normalizeSettings({ ...defaultSettings, ...parsed, ...overrides });
  } catch {
    await saveSettings({ ...defaultSettings, ...overrides });
    return normalizeSettings({ ...defaultSettings, ...overrides });
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(getSettingsPath(), `${JSON.stringify(normalizeSettings(settings), null, 2)}\n`, "utf8");
}

function normalizeSettings(settings: Settings): Settings {
  const sub = settings.subscriptionCosts ?? {};
  return {
    pollIntervalSeconds: Math.max(15, Math.floor(Number(settings.pollIntervalSeconds) || defaultSettings.pollIntervalSeconds)),
    providerTimeoutMs: Math.max(1000, Math.floor(Number(settings.providerTimeoutMs) || defaultSettings.providerTimeoutMs)),
    subscriptionCosts: {
      claude: Math.max(0, Number((sub as Partial<SubscriptionCosts>).claude) || defaultSettings.subscriptionCosts.claude),
      codex: Math.max(0, Number((sub as Partial<SubscriptionCosts>).codex) || defaultSettings.subscriptionCosts.codex),
      gemini: Math.max(0, Number((sub as Partial<SubscriptionCosts>).gemini) || defaultSettings.subscriptionCosts.gemini),
    },
    pricingOfflineMode: Boolean(settings.pricingOfflineMode)
  };
}
```

- [ ] **Step 1.3: getClaudeProjectsDir zu paths.ts hinzufügen**

Am Ende von `src/config/paths.ts` anfügen:

```typescript
export function getClaudeProjectsDir(): string {
  return path.join(getHomeDir(), ".claude", "projects");
}
```

- [ ] **Step 1.4: Build prüfen**

```
npm run build
```

Erwartet: 0 TypeScript-Fehler.

- [ ] **Step 1.5: Commit**

```
git add src/providers/types.ts src/config/settings.ts src/config/paths.ts
git commit -m "feat: add CostFactorResult type, extend Settings with pricing config"
```

---

## Task 2: cost-calculator.ts (TDD)

**Files:**
- Create: `src/pricing/cost-calculator.ts`
- Create: `tests/cost-calculator.test.ts`

`ModelPricing` wird hier definiert (ist ein reiner Datentyp). `litellm-fetcher.ts` importiert es von hier.

- [ ] **Step 2.1: Failing tests schreiben**

Erstelle `tests/cost-calculator.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { calculateTieredCost, calculateCostFromTokens } from "../src/pricing/cost-calculator";
import type { ModelPricing } from "../src/pricing/cost-calculator";

describe("calculateTieredCost", () => {
  it("returns 0 for undefined tokens", () => {
    expect(calculateTieredCost(undefined, 3e-6, 1.5e-6)).toBe(0);
  });

  it("returns 0 for zero tokens", () => {
    expect(calculateTieredCost(0, 3e-6, 1.5e-6)).toBe(0);
  });

  it("uses base price below 200k threshold", () => {
    expect(calculateTieredCost(100_000, 3e-6, 1.5e-6)).toBeCloseTo(100_000 * 3e-6);
  });

  it("applies tiered pricing above 200k tokens", () => {
    const cost = calculateTieredCost(250_000, 3e-6, 1.5e-6);
    expect(cost).toBeCloseTo(200_000 * 3e-6 + 50_000 * 1.5e-6);
  });

  it("uses only base price when tieredPrice is undefined", () => {
    expect(calculateTieredCost(300_000, 3e-6, undefined)).toBeCloseTo(300_000 * 3e-6);
  });

  it("returns 0 when basePrice is undefined", () => {
    expect(calculateTieredCost(100_000, undefined, undefined)).toBe(0);
  });
});

describe("calculateCostFromTokens", () => {
  it("sums input and output costs", () => {
    const pricing: ModelPricing = {
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
    };
    const cost = calculateCostFromTokens({ input_tokens: 1000, output_tokens: 200 }, pricing);
    expect(cost).toBeCloseTo(1000 * 3e-6 + 200 * 15e-6);
  });

  it("includes cache creation and read costs", () => {
    const pricing: ModelPricing = {
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
      cache_creation_input_token_cost: 3.75e-6,
      cache_read_input_token_cost: 0.3e-6,
    };
    const cost = calculateCostFromTokens(
      { input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 1000 },
      pricing,
    );
    expect(cost).toBeCloseTo(100 * 3e-6 + 100 * 15e-6 + 500 * 3.75e-6 + 1000 * 0.3e-6);
  });

  it("applies fast mode multiplier", () => {
    const pricing: ModelPricing = {
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
      provider_specific_entry: { fast: 6 },
    };
    const normal = calculateCostFromTokens({ input_tokens: 1000, output_tokens: 100 }, pricing);
    const fast = calculateCostFromTokens({ input_tokens: 1000, output_tokens: 100, speed: "fast" }, pricing);
    expect(fast).toBeCloseTo(normal * 6);
  });

  it("ignores fast multiplier in standard mode", () => {
    const pricing: ModelPricing = {
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
      provider_specific_entry: { fast: 6 },
    };
    const cost = calculateCostFromTokens({ input_tokens: 1000, output_tokens: 100, speed: "standard" }, pricing);
    expect(cost).toBeCloseTo(1000 * 3e-6 + 100 * 15e-6);
  });
});
```

- [ ] **Step 2.2: Tests laufen lassen (erwartet: FAIL)**

```
npm test -- cost-calculator
```

Erwartet: FAIL mit „Cannot find module".

- [ ] **Step 2.3: cost-calculator.ts implementieren**

Erstelle `src/pricing/cost-calculator.ts`:

```typescript
export interface ModelPricing {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
  provider_specific_entry?: { fast?: number };
}

export interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  speed?: "standard" | "fast";
}

const TIERED_THRESHOLD = 200_000;

export function calculateTieredCost(
  totalTokens: number | undefined,
  basePrice: number | undefined,
  tieredPrice: number | undefined,
): number {
  if (totalTokens == null || totalTokens <= 0) return 0;
  if (totalTokens > TIERED_THRESHOLD && tieredPrice != null) {
    const belowCost = basePrice != null ? TIERED_THRESHOLD * basePrice : 0;
    return belowCost + (totalTokens - TIERED_THRESHOLD) * tieredPrice;
  }
  if (basePrice != null) return totalTokens * basePrice;
  return 0;
}

export function calculateCostFromTokens(tokens: TokenCounts, pricing: ModelPricing): number {
  const inputCost = calculateTieredCost(
    tokens.input_tokens,
    pricing.input_cost_per_token,
    pricing.input_cost_per_token_above_200k_tokens,
  );
  const outputCost = calculateTieredCost(
    tokens.output_tokens,
    pricing.output_cost_per_token,
    pricing.output_cost_per_token_above_200k_tokens,
  );
  const cacheCreationCost = calculateTieredCost(
    tokens.cache_creation_input_tokens,
    pricing.cache_creation_input_token_cost,
    pricing.cache_creation_input_token_cost_above_200k_tokens,
  );
  const cacheReadCost = calculateTieredCost(
    tokens.cache_read_input_tokens,
    pricing.cache_read_input_token_cost,
    pricing.cache_read_input_token_cost_above_200k_tokens,
  );
  const baseCost = inputCost + outputCost + cacheCreationCost + cacheReadCost;
  const multiplier = tokens.speed === "fast" ? (pricing.provider_specific_entry?.fast ?? 1) : 1;
  return baseCost * multiplier;
}
```

- [ ] **Step 2.4: Tests laufen lassen (erwartet: PASS)**

```
npm test -- cost-calculator
```

Erwartet: alle 10 Tests PASS.

- [ ] **Step 2.5: Commit**

```
git add src/pricing/cost-calculator.ts tests/cost-calculator.test.ts
git commit -m "feat: add cost-calculator with tiered pricing and fast-mode multiplier"
```

---

## Task 3: litellm-fetcher.ts (TDD)

**Files:**
- Create: `src/pricing/litellm-fetcher.ts`
- Create: `tests/litellm-fetcher.test.ts`

- [ ] **Step 3.1: Failing tests schreiben**

Erstelle `tests/litellm-fetcher.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { LiteLLMFetcher } from "../src/pricing/litellm-fetcher";

describe("LiteLLMFetcher (offline mode)", () => {
  it("returns fallback pricing for claude-sonnet-4-5", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("claude-sonnet-4-5");
    expect(pricing).not.toBeNull();
    expect(pricing!.input_cost_per_token).toBeGreaterThan(0);
    expect(pricing!.output_cost_per_token).toBeGreaterThan(0);
  });

  it("returns fallback pricing for gpt-4o", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("gpt-4o");
    expect(pricing).not.toBeNull();
    expect(pricing!.input_cost_per_token).toBeGreaterThan(0);
  });

  it("returns fallback pricing for gemini-2.0-flash", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("gemini-2.0-flash");
    expect(pricing).not.toBeNull();
  });

  it("finds model by anthropic/ prefix", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("anthropic/claude-sonnet-4-5");
    expect(pricing).toBeNull(); // not in fallback map with that prefix — direct match only
  });

  it("returns null for unknown model", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("unknown-model-xyz-9999");
    expect(pricing).toBeNull();
  });

  it("caches results across multiple calls", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const first = await fetcher.getModelPricing("claude-sonnet-4-5");
    const second = await fetcher.getModelPricing("claude-sonnet-4-5");
    expect(first).toBe(second); // same object reference = cached
  });
});
```

- [ ] **Step 3.2: Tests laufen lassen (erwartet: FAIL)**

```
npm test -- litellm-fetcher
```

Erwartet: FAIL mit „Cannot find module".

- [ ] **Step 3.3: litellm-fetcher.ts implementieren**

Erstelle `src/pricing/litellm-fetcher.ts`:

```typescript
import type { ModelPricing } from "./cost-calculator";

export type { ModelPricing };

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const FALLBACK_PRICES: Record<string, ModelPricing> = {
  "claude-opus-4": {
    input_cost_per_token: 1.5e-5,
    output_cost_per_token: 7.5e-5,
    cache_creation_input_token_cost: 1.875e-5,
    cache_read_input_token_cost: 1.5e-6,
    provider_specific_entry: { fast: 6 },
  },
  "claude-sonnet-4-5": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_creation_input_token_cost: 3.75e-6,
    cache_read_input_token_cost: 3e-7,
  },
  "claude-haiku-4-5": {
    input_cost_per_token: 8e-7,
    output_cost_per_token: 4e-6,
    cache_creation_input_token_cost: 1e-6,
    cache_read_input_token_cost: 8e-8,
  },
  "gpt-4o": {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1e-5,
  },
  "gemini-2.0-flash": {
    input_cost_per_token: 7.5e-8,
    output_cost_per_token: 3e-7,
  },
};

export class LiteLLMFetcher {
  private cache: Map<string, ModelPricing> | null = null;

  constructor(private readonly offlineMode: boolean = false) {}

  async getModelPricing(modelName: string): Promise<ModelPricing | null> {
    const map = await this.getPricingMap();
    return this.lookup(modelName, map);
  }

  private async getPricingMap(): Promise<Map<string, ModelPricing>> {
    if (this.cache) return this.cache;
    if (this.offlineMode) {
      this.cache = new Map(Object.entries(FALLBACK_PRICES));
      return this.cache;
    }
    try {
      const response = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = (await response.json()) as Record<string, unknown>;
      this.cache = buildPricingMap(json);
    } catch {
      this.cache = new Map(Object.entries(FALLBACK_PRICES));
    }
    return this.cache;
  }

  private lookup(modelName: string, pricing: Map<string, ModelPricing>): ModelPricing | null {
    if (pricing.has(modelName)) return pricing.get(modelName)!;
    for (const prefix of ["anthropic/", "claude-3-5-", "claude-3-", "claude-"]) {
      const key = `${prefix}${modelName}`;
      if (pricing.has(key)) return pricing.get(key)!;
    }
    const lower = modelName.toLowerCase();
    for (const [key, value] of pricing) {
      const k = key.toLowerCase();
      if (k.includes(lower) || lower.includes(k)) return value;
    }
    return null;
  }
}

function buildPricingMap(json: Record<string, unknown>): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const [key, value] of Object.entries(json)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      map.set(key, value as ModelPricing);
    }
  }
  for (const [key, value] of Object.entries(FALLBACK_PRICES)) {
    if (!map.has(key)) map.set(key, value);
  }
  return map;
}
```

- [ ] **Step 3.4: Tests laufen lassen (erwartet: PASS)**

```
npm test -- litellm-fetcher
```

Erwartet: alle 6 Tests PASS.

- [ ] **Step 3.5: Commit**

```
git add src/pricing/litellm-fetcher.ts tests/litellm-fetcher.test.ts
git commit -m "feat: add LiteLLMFetcher with offline fallback prices and model lookup"
```

---

## Task 4: jsonl-reader.ts (TDD)

**Files:**
- Create: `src/pricing/jsonl-reader.ts`
- Create: `tests/jsonl-reader.test.ts`

- [ ] **Step 4.1: Failing tests schreiben**

Erstelle `tests/jsonl-reader.test.ts`:

```typescript
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readClaudeTokensForPeriod } from "../src/pricing/jsonl-reader";

const tmpDir = path.join(os.tmpdir(), `quotabar-test-${process.pid}`);

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeJsonl(dir: string, filename: string, entries: unknown[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

describe("readClaudeTokensForPeriod", () => {
  it("returns zeros when directory does not exist", async () => {
    const result = await readClaudeTokensForPeriod("/nonexistent/path/xyz", new Date("2026-05-01"));
    expect(result).toEqual({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, modelNames: [] });
  });

  it("aggregates tokens from entries within billing period", async () => {
    const projectDir = path.join(tmpDir, "proj1");
    await writeJsonl(projectDir, "session.jsonl", [
      {
        timestamp: "2026-05-10T10:00:00.000Z",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } },
      },
      {
        timestamp: "2026-05-15T12:00:00.000Z",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 200, output_tokens: 80 } },
      },
    ]);

    const result = await readClaudeTokensForPeriod(tmpDir, new Date("2026-05-01T00:00:00.000Z"));
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(130);
    expect(result.cacheCreationTokens).toBe(20);
    expect(result.cacheReadTokens).toBe(30);
    expect(result.modelNames).toContain("claude-sonnet-4-5");
  });

  it("excludes entries before billing period", async () => {
    const projectDir = path.join(tmpDir, "proj1");
    await writeJsonl(projectDir, "session.jsonl", [
      {
        timestamp: "2026-04-30T23:59:59.000Z",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 999, output_tokens: 999 } },
      },
      {
        timestamp: "2026-05-01T00:00:00.001Z",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 5 } },
      },
    ]);

    const result = await readClaudeTokensForPeriod(tmpDir, new Date("2026-05-01T00:00:00.000Z"));
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
  });

  it("skips invalid JSONL lines without throwing", async () => {
    const projectDir = path.join(tmpDir, "proj1");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "session.jsonl"),
      [
        "not valid json{{{{",
        JSON.stringify({ timestamp: "2026-05-10T10:00:00.000Z", message: { model: "claude-sonnet-4-5", usage: { input_tokens: 50, output_tokens: 25 } } }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await readClaudeTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(result.inputTokens).toBe(50);
    expect(result.outputTokens).toBe(25);
  });

  it("reads JSONL files from nested subdirectories", async () => {
    const nested = path.join(tmpDir, "proj", "subdir");
    await writeJsonl(nested, "chat.jsonl", [
      { timestamp: "2026-05-12T08:00:00.000Z", message: { model: "claude-opus-4", usage: { input_tokens: 77, output_tokens: 33 } } },
    ]);

    const result = await readClaudeTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(result.inputTokens).toBe(77);
    expect(result.modelNames).toContain("claude-opus-4");
  });

  it("deduplicates model names", async () => {
    const projectDir = path.join(tmpDir, "proj1");
    await writeJsonl(projectDir, "session.jsonl", [
      { timestamp: "2026-05-10T10:00:00.000Z", message: { model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 5 } } },
      { timestamp: "2026-05-11T10:00:00.000Z", message: { model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 5 } } },
    ]);

    const result = await readClaudeTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(result.modelNames.filter((m) => m === "claude-sonnet-4-5").length).toBe(1);
  });
});
```

- [ ] **Step 4.2: Tests laufen lassen (erwartet: FAIL)**

```
npm test -- jsonl-reader
```

Erwartet: FAIL mit „Cannot find module".

- [ ] **Step 4.3: jsonl-reader.ts implementieren**

Erstelle `src/pricing/jsonl-reader.ts`:

```typescript
import fs from "node:fs/promises";
import path from "node:path";

export interface AggregatedTokens {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelNames: string[];
}

const EMPTY: AggregatedTokens = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, modelNames: [] };

export async function readClaudeTokensForPeriod(
  projectsDir: string,
  billingStart: Date,
): Promise<AggregatedTokens> {
  let files: string[];
  try {
    const entries = await fs.readdir(projectsDir, { recursive: true });
    files = (entries as string[]).filter((e) => e.endsWith(".jsonl")).map((e) => path.join(projectsDir, e));
  } catch {
    return { ...EMPTY };
  }

  const totals = { ...EMPTY, modelNames: [] as string[] };
  const modelSet = new Set<string>();

  for (const file of files) {
    await processJsonlFile(file, billingStart, totals, modelSet);
  }

  totals.modelNames = Array.from(modelSet);
  return totals;
}

async function processJsonlFile(
  filePath: string,
  billingStart: Date,
  totals: AggregatedTokens,
  modelSet: Set<string>,
): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      processEntry(entry, billingStart, totals, modelSet);
    } catch {
      // skip invalid lines
    }
  }
}

function processEntry(
  entry: Record<string, unknown>,
  billingStart: Date,
  totals: AggregatedTokens,
  modelSet: Set<string>,
): void {
  const ts = typeof entry.timestamp === "string" ? entry.timestamp : null;
  if (!ts) return;
  if (new Date(ts) < billingStart) return;

  const msg = entry.message;
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
  const message = msg as Record<string, unknown>;

  const model = typeof message.model === "string" ? message.model : null;
  if (model) modelSet.add(model);

  const usage = message.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
  const u = usage as Record<string, unknown>;

  totals.inputTokens += numberFrom(u.input_tokens);
  totals.outputTokens += numberFrom(u.output_tokens);
  totals.cacheCreationTokens += numberFrom(u.cache_creation_input_tokens);
  totals.cacheReadTokens += numberFrom(u.cache_read_input_tokens);
}

function numberFrom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
```

- [ ] **Step 4.4: Tests laufen lassen (erwartet: PASS)**

```
npm test -- jsonl-reader
```

Erwartet: alle 6 Tests PASS.

- [ ] **Step 4.5: Commit**

```
git add src/pricing/jsonl-reader.ts tests/jsonl-reader.test.ts
git commit -m "feat: add JSONL reader for Claude token aggregation"
```

---

## Task 5: codex-estimator.ts + gemini-estimator.ts (TDD)

**Files:**
- Create: `src/pricing/codex-estimator.ts`
- Create: `src/pricing/gemini-estimator.ts`
- Create: `tests/estimators.test.ts`

- [ ] **Step 5.1: Failing tests schreiben**

Erstelle `tests/estimators.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { LiteLLMFetcher } from "../src/pricing/litellm-fetcher";
import { estimateCodexCost } from "../src/pricing/codex-estimator";
import { estimateGeminiCost } from "../src/pricing/gemini-estimator";

describe("estimateCodexCost", () => {
  it("returns 0 for 0% usage", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const cost = await estimateCodexCost(0, fetcher);
    expect(cost).toBe(0);
  });

  it("returns positive cost for 100% usage", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const cost = await estimateCodexCost(100, fetcher);
    expect(cost).toBeGreaterThan(0);
  });

  it("cost at 50% is half of cost at 100%", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const full = await estimateCodexCost(100, fetcher);
    const half = await estimateCodexCost(50, fetcher);
    expect(half).toBeCloseTo(full / 2, 5);
  });
});

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

- [ ] **Step 5.2: Tests laufen lassen (erwartet: FAIL)**

```
npm test -- estimators
```

Erwartet: FAIL mit „Cannot find module".

- [ ] **Step 5.3: codex-estimator.ts implementieren**

Erstelle `src/pricing/codex-estimator.ts`:

```typescript
import { calculateCostFromTokens } from "./cost-calculator";
import type { LiteLLMFetcher } from "./litellm-fetcher";

const CODEX_REFERENCE_INPUT_TOKENS = 2_000_000;
const CODEX_REFERENCE_OUTPUT_TOKENS = 500_000;
const CODEX_MODEL = "gpt-4o";

export async function estimateCodexCost(usedPercent: number, fetcher: LiteLLMFetcher): Promise<number> {
  if (usedPercent <= 0) return 0;
  const pricing = await fetcher.getModelPricing(CODEX_MODEL);
  if (!pricing) return 0;
  const fraction = usedPercent / 100;
  return calculateCostFromTokens(
    {
      input_tokens: Math.round(CODEX_REFERENCE_INPUT_TOKENS * fraction),
      output_tokens: Math.round(CODEX_REFERENCE_OUTPUT_TOKENS * fraction),
    },
    pricing,
  );
}
```

- [ ] **Step 5.4: gemini-estimator.ts implementieren**

Erstelle `src/pricing/gemini-estimator.ts`:

```typescript
import { calculateCostFromTokens } from "./cost-calculator";
import type { LiteLLMFetcher } from "./litellm-fetcher";

const GEMINI_AVG_INPUT_PER_SESSION = 5_000;
const GEMINI_AVG_OUTPUT_PER_SESSION = 1_000;
const GEMINI_MODEL = "gemini-2.0-flash";

export async function estimateGeminiCost(sessionCount: number, fetcher: LiteLLMFetcher): Promise<number> {
  if (sessionCount <= 0) return 0;
  const pricing = await fetcher.getModelPricing(GEMINI_MODEL);
  if (!pricing) return 0;
  return calculateCostFromTokens(
    {
      input_tokens: GEMINI_AVG_INPUT_PER_SESSION * sessionCount,
      output_tokens: GEMINI_AVG_OUTPUT_PER_SESSION * sessionCount,
    },
    pricing,
  );
}
```

- [ ] **Step 5.5: Tests laufen lassen (erwartet: PASS)**

```
npm test -- estimators
```

Erwartet: alle 6 Tests PASS.

- [ ] **Step 5.6: Commit**

```
git add src/pricing/codex-estimator.ts src/pricing/gemini-estimator.ts tests/estimators.test.ts
git commit -m "feat: add Codex and Gemini cost estimators"
```

---

## Task 6: PricingEngine / subscription-factor.ts (TDD)

**Files:**
- Create: `src/pricing/subscription-factor.ts`
- Create: `tests/subscription-factor.test.ts`

- [ ] **Step 6.1: Failing tests schreiben**

Erstelle `tests/subscription-factor.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { PricingEngine } from "../src/pricing/subscription-factor";
import type { Settings } from "../src/config/settings";
import type { UsageSnapshot } from "../src/providers/types";

const settings: Settings = {
  pollIntervalSeconds: 60,
  providerTimeoutMs: 10_000,
  subscriptionCosts: { claude: 20, codex: 10, gemini: 19 },
  pricingOfflineMode: true,
};

function makeSnapshot(provider: string, overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    provider,
    status: "ok",
    windows: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("PricingEngine", () => {
  it("returns undefined for error snapshots", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    const snapshot = makeSnapshot("claude", { status: "error" });
    expect(await engine.calculateFactor(snapshot)).toBeUndefined();
  });

  it("returns undefined for not_authenticated snapshots", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    const snapshot = makeSnapshot("claude", { status: "not_authenticated" });
    expect(await engine.calculateFactor(snapshot)).toBeUndefined();
  });

  it("returns zero cost for Claude when no JSONL dir exists", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    const snapshot = makeSnapshot("claude");
    const result = await engine.calculateFactor(snapshot);
    expect(result).toMatchObject({
      apiCostUSD: 0,
      subscriptionCostUSD: 20,
      factor: 0,
      isEstimate: false,
    });
  });

  it("returns estimate for Codex with usedPercent", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    const snapshot = makeSnapshot("codex", {
      windows: [{ name: "fiveHour", usedPercent: 50 }],
    });
    const result = await engine.calculateFactor(snapshot);
    expect(result).not.toBeUndefined();
    expect(result!.isEstimate).toBe(true);
    expect(result!.subscriptionCostUSD).toBe(10);
    expect(result!.apiCostUSD).toBeGreaterThan(0);
  });

  it("returns undefined for Codex when no usedPercent available", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    const snapshot = makeSnapshot("codex", { windows: [] });
    const result = await engine.calculateFactor(snapshot);
    expect(result).toBeUndefined();
  });

  it("returns estimate for Gemini with label containing session count", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    const snapshot = makeSnapshot("gemini", {
      windows: [{ name: "session", label: "5 sessions (gemini-2.0-flash)" }],
    });
    const result = await engine.calculateFactor(snapshot);
    expect(result).not.toBeUndefined();
    expect(result!.isEstimate).toBe(true);
    expect(result!.subscriptionCostUSD).toBe(19);
  });

  it("label uses ~ prefix for estimates", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    const snapshot = makeSnapshot("codex", {
      windows: [{ name: "fiveHour", usedPercent: 60 }],
    });
    const result = await engine.calculateFactor(snapshot);
    expect(result!.label).toMatch(/^~/);
  });

  it("label has no ~ prefix for exact Claude result", async () => {
    const engine = new PricingEngine(settings, "/nonexistent/path");
    const snapshot = makeSnapshot("claude");
    const result = await engine.calculateFactor(snapshot);
    expect(result!.label).not.toMatch(/^~/);
  });
});
```

- [ ] **Step 6.2: Tests laufen lassen (erwartet: FAIL)**

```
npm test -- subscription-factor
```

Erwartet: FAIL mit „Cannot find module".

- [ ] **Step 6.3: subscription-factor.ts implementieren**

Erstelle `src/pricing/subscription-factor.ts`:

```typescript
import { getClaudeProjectsDir } from "../config/paths";
import type { Settings } from "../config/settings";
import type { CostFactorResult, UsageSnapshot, UsageWindow } from "../providers/types";
import { calculateCostFromTokens } from "./cost-calculator";
import { estimateCodexCost } from "./codex-estimator";
import { estimateGeminiCost } from "./gemini-estimator";
import { readClaudeTokensForPeriod } from "./jsonl-reader";
import { LiteLLMFetcher } from "./litellm-fetcher";

export class PricingEngine {
  private readonly fetcher: LiteLLMFetcher;

  constructor(
    private readonly settings: Settings,
    private readonly claudeProjectsDir: string = getClaudeProjectsDir(),
  ) {
    this.fetcher = new LiteLLMFetcher(settings.pricingOfflineMode);
  }

  async calculateFactor(snapshot: UsageSnapshot): Promise<CostFactorResult | undefined> {
    if (snapshot.status === "error" || snapshot.status === "not_authenticated") return undefined;
    try {
      switch (snapshot.provider) {
        case "claude": return this.calculateClaudeFactor(snapshot);
        case "codex": return this.calculateCodexFactor(snapshot);
        case "gemini": return this.calculateGeminiFactor(snapshot);
        default: return undefined;
      }
    } catch {
      return undefined;
    }
  }

  private async calculateClaudeFactor(snapshot: UsageSnapshot): Promise<CostFactorResult> {
    const billingStart = getBillingStart(snapshot);
    const tokens = await readClaudeTokensForPeriod(this.claudeProjectsDir, billingStart);
    const primaryModel = tokens.modelNames[0] ?? snapshot.model ?? "claude-sonnet-4-5";
    const pricing = await this.fetcher.getModelPricing(primaryModel);
    const apiCostUSD = pricing
      ? calculateCostFromTokens({
          input_tokens: tokens.inputTokens,
          output_tokens: tokens.outputTokens,
          cache_creation_input_tokens: tokens.cacheCreationTokens,
          cache_read_input_tokens: tokens.cacheReadTokens,
        }, pricing)
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

  private async calculateCodexFactor(snapshot: UsageSnapshot): Promise<CostFactorResult | undefined> {
    const usedPercent = getUsedPercent(snapshot);
    if (usedPercent == null) return undefined;
    const apiCostUSD = await estimateCodexCost(usedPercent, this.fetcher);
    const subscriptionCostUSD = this.settings.subscriptionCosts.codex;
    const factor = subscriptionCostUSD > 0 ? apiCostUSD / subscriptionCostUSD : 0;
    return {
      apiCostUSD,
      subscriptionCostUSD,
      factor,
      isEstimate: true,
      label: formatLabel(apiCostUSD, factor, true),
    };
  }

  private async calculateGeminiFactor(snapshot: UsageSnapshot): Promise<CostFactorResult | undefined> {
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

function getBillingStart(snapshot: UsageSnapshot): Date {
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

function getUsedPercent(snapshot: UsageSnapshot): number | undefined {
  for (const name of ["weekly", "fiveHour", "monthly", "credits"] as UsageWindow["name"][]) {
    const w = snapshot.windows.find((w) => w.name === name);
    if (w?.usedPercent != null) return w.usedPercent;
  }
  return undefined;
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

- [ ] **Step 6.4: Tests laufen lassen (erwartet: PASS)**

```
npm test -- subscription-factor
```

Erwartet: alle 8 Tests PASS.

- [ ] **Step 6.5: Alle Tests laufen lassen**

```
npm test
```

Erwartet: alle Tests PASS.

- [ ] **Step 6.6: Commit**

```
git add src/pricing/subscription-factor.ts tests/subscription-factor.test.ts
git commit -m "feat: add PricingEngine coordinating Claude/Codex/Gemini cost calculations"
```

---

## Task 7: Integration – RefreshLoop, menu.ts, main.ts

**Files:**
- Modify: `src/usage/refreshLoop.ts`
- Modify: `src/main/menu.ts`
- Modify: `src/main/main.ts`

- [ ] **Step 7.1: PricingEngine als optionalen Parameter in RefreshLoop einfügen**

`src/usage/refreshLoop.ts` – Klassen-Konstruktor und `refreshNow()` erweitern:

```typescript
import { UsageProvider, UsageSnapshot, errorSnapshot } from "../providers/types";
import { toErrorMessage } from "../shared/errors";
import { log } from "../main/logging";
import { UsageStore } from "./usageStore";
import { computeLinearPace, toRateWindow } from "./usagePace";
import type { PricingEngine } from "../pricing/subscription-factor";

export type RefreshListener = (snapshots: UsageSnapshot[]) => void;

export class RefreshLoop {
  private timer: NodeJS.Timeout | null = null;
  private isRefreshing = false;
  private readonly listeners = new Set<RefreshListener>();

  constructor(
    private readonly providers: UsageProvider[],
    private readonly store: UsageStore,
    private readonly intervalSeconds: number,
    private readonly timeoutMs: number,
    private readonly pricingEngine?: PricingEngine
  ) {}

  onRefresh(listener: RefreshListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    void this.refreshNow();
    this.timer = setInterval(() => void this.refreshNow(), this.intervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refreshNow(): Promise<UsageSnapshot[]> {
    if (this.isRefreshing) {
      return this.store.getAll();
    }

    this.isRefreshing = true;
    try {
      const snapshots = await Promise.all(this.providers.map((provider) => this.fetchWithTimeout(provider)));
      const now = new Date();
      for (const snapshot of snapshots) {
        for (const window of snapshot.windows) {
          if (window.name === "weekly") {
            window.pace = computeLinearPace(toRateWindow(window), now);
          }
        }
        if (this.pricingEngine) {
          snapshot.costFactor = await this.pricingEngine.calculateFactor(snapshot);
        }
      }
      const merged = this.store.update(snapshots);
      for (const listener of this.listeners) listener(merged);
      return merged;
    } finally {
      this.isRefreshing = false;
    }
  }

  private async fetchWithTimeout(provider: UsageProvider): Promise<UsageSnapshot> {
    try {
      return await withTimeout(provider.fetchUsage(), this.timeoutMs, `${provider.displayName} timed out`);
    } catch (error) {
      log.warn(`${provider.id} refresh failed: ${toErrorMessage(error)}`);
      return errorSnapshot(provider.id, toErrorMessage(error), "error");
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
```

- [ ] **Step 7.2: Kostenzeile in menu.ts hinzufügen**

In `src/main/menu.ts` den Import von `CostFactorResult` hinzufügen und `snapshotToMenuLines` erweitern:

Die bestehende `types`-Import-Zeile in `src/main/menu.ts` (Zeile 4) ersetzen – `CostFactorResult` ergänzen:
```typescript
// vorher:
import { UsageProvider, UsageSnapshot } from "../providers/types";
// nachher:
import { CostFactorResult, UsageProvider, UsageSnapshot } from "../providers/types";
```

In `snapshotToMenuLines` am Ende vor dem `return lines` die Kostenzeile einfügen:

```typescript
function snapshotToMenuLines(displayName: string, snapshot: UsageSnapshot): string[] {
  if (snapshot.provider === "gemini") {
    const label = snapshot.windows[0]?.label ?? "local sessions unavailable";
    const lines = [`${displayName}: ${label}`];
    if (snapshot.costFactor) lines.push(formatCostFactorLine(snapshot.costFactor));
    return lines;
  }

  const lines = snapshot.windows.length > 0
    ? snapshot.windows.flatMap((window, index) => {
      const label = index === 0 ? displayName : window.name === "weekly" ? "Weekly" : window.label ?? titleCase(window.name);
      const usage = typeof window.usedPercent === "number" ? `${Math.round(window.usedPercent)}%` : window.label ?? "unknown";
      const reset = window.resetsAt ? ` (resets in ${formatTimeRemaining(window.resetsAt)})` : "";
      const mainLine = `${label}: ${usage}${reset}`;
      const paceLine = window.name === "weekly" && window.pace != null ? formatPaceLine(window.pace) : null;
      return paceLine != null ? [mainLine, paceLine] : [mainLine];
    })
    : [`${displayName}: ${snapshot.status}`];

  if (snapshot.status === "stale") {
    lines[0] = `${lines[0]} (stale)`;
  }

  if (snapshot.costFactor) {
    lines.push(formatCostFactorLine(snapshot.costFactor));
  }

  return lines;
}
```

Neue Hilfsfunktion am Ende der Datei anfügen:

```typescript
function formatCostFactorLine(cost: CostFactorResult): string {
  if (cost.apiCostUSD === 0 && !cost.isEstimate) return "  API-Äq: $0.00 (keine Daten)";
  const prefix = cost.isEstimate ? "~" : "";
  return `  API-Äq: ${prefix}$${cost.apiCostUSD.toFixed(2)} (${cost.label})`;
}
```

- [ ] **Step 7.3: PricingEngine in main.ts verdrahten**

`src/main/main.ts` – den Import und die Konstruktion ergänzen:

```typescript
import { app } from "electron";
import { runFirstRunPrompt } from "../config/firstRun";
import { loadSettings } from "../config/settings";
import { createProviderRegistry } from "../providers/providerRegistry";
import { PricingEngine } from "../pricing/subscription-factor";
import { RefreshLoop } from "../usage/refreshLoop";
import { UsageStore } from "../usage/usageStore";
import { applyStartupFlag } from "./autostart";
import { initializeLogging, log } from "./logging";
import { TrayController } from "./tray";
import { initializeUpdater } from "./updater";
```

Im `app.whenReady()` Block die Zeile, die `RefreshLoop` erstellt, ersetzen:

```typescript
const settings = await loadSettings(cli.pollIntervalSeconds ? { pollIntervalSeconds: cli.pollIntervalSeconds } : {});
const providers = createProviderRegistry(settings.providerTimeoutMs);
const store = new UsageStore();
const pricingEngine = new PricingEngine(settings);
const refreshLoop = new RefreshLoop(providers, store, settings.pollIntervalSeconds, settings.providerTimeoutMs, pricingEngine);
```

- [ ] **Step 7.4: Build prüfen**

```
npm run build
```

Erwartet: 0 TypeScript-Fehler.

- [ ] **Step 7.5: Alle Tests laufen lassen**

```
npm test
```

Erwartet: alle Tests PASS, keine Regressionen.

- [ ] **Step 7.6: App manuell testen**

```
npm run dev
```

Prüfen:
- App startet ohne Fehler
- Tray-Menü öffnet sich
- Pro Provider mit gültigem Snapshot erscheint eine „API-Äq:"-Zeile
- Codex/Gemini-Zeilen beginnen mit `~`
- Claude-Zeile ohne `~` (oder `$0.00 (keine Daten)` wenn kein JSONL-Verzeichnis)

- [ ] **Step 7.7: Final Commit**

```
git add src/usage/refreshLoop.ts src/main/menu.ts src/main/main.ts
git commit -m "feat: wire PricingEngine into RefreshLoop and display cost factor in tray menu"
```

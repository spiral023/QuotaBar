# Historical Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve calculated Claude and Codex token costs with the locally observed price applicable at each event timestamp, without changing provider-supplied or persisted backfill costs.

**Architecture:** `LiteLLMFetcher` remains the current-price source. A new `HistoricalPricingResolver` records only resolved model pricing epochs in a compact cache and selects the latest epoch at or before an event timestamp. All calculated cost paths use that resolver; source `costUSD` and backfill report rows retain their existing precedence and values.

**Tech Stack:** TypeScript, Node `fs/promises` and `crypto`, Vitest, Electron main process.

---

## File structure

- Create: `src/pricing/historical-pricing-resolver.ts` — compact price-epoch persistence and timestamp-based lookup.
- Modify: `src/config/paths.ts` — cache path for the epoch file.
- Modify: `src/pricing/litellm-fetcher.ts` — export the LiteLLM source URL for provenance.
- Modify: `src/pricing/codex-cost-calculator.ts`, `src/pricing/subscription-factor.ts`, and `src/reports/reportService.ts` — use event-time resolution for calculated costs.
- Modify: `src/main/debugBackfill.ts` and `src/main/main.ts` — apply the resolver when writing future summaries only.
- Create: `tests/historical-pricing-resolver.test.ts`.
- Modify: `tests/codex-cost-calculator.test.ts`, `tests/reports.test.ts`, `tests/subscription-factor.test.ts`, and `tests/debugBackfill.test.ts`.

### Task 1: Add the compact resolver

**Files:**
- Create: `src/pricing/historical-pricing-resolver.ts`
- Modify: `src/config/paths.ts:44`
- Modify: `src/pricing/litellm-fetcher.ts:12`
- Test: `tests/historical-pricing-resolver.test.ts`

- [ ] **Step 1: Write the failing epoch-selection test**

```ts
it("uses the epoch observed before each event when a model price changes", async () => {
  const historyPath = path.join(tmpDir, "history.json");
  const oldResolver = new HistoricalPricingResolver(
    { getModelPricing: async () => ({ input_cost_per_token: 2e-6 }) },
    { historyPath, now: () => new Date("2026-05-01T00:00:00.000Z") },
  );
  await oldResolver.getModelPricing("gpt-test", "2026-05-02T12:00:00.000Z");

  const newResolver = new HistoricalPricingResolver(
    { getModelPricing: async () => ({ input_cost_per_token: 1e-6 }) },
    { historyPath, now: () => new Date("2026-06-01T00:00:00.000Z") },
  );

  expect((await newResolver.getModelPricing("gpt-test", "2026-05-02T12:00:00.000Z"))?.input_cost_per_token).toBe(2e-6);
  expect((await newResolver.getModelPricing("gpt-test", "2026-06-02T12:00:00.000Z"))?.input_cost_per_token).toBe(1e-6);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/historical-pricing-resolver.test.ts`

Expected: FAIL with a missing-module error for `historical-pricing-resolver`.

- [ ] **Step 3: Write the failing legacy-fallback test**

```ts
it("uses the current price when no epoch predates a legacy event", async () => {
  const resolver = new HistoricalPricingResolver(
    { getModelPricing: async () => ({ output_cost_per_token: 4e-6 }) },
    { historyPath: path.join(tmpDir, "empty.json"), now: () => new Date("2026-06-01T00:00:00.000Z") },
  );

  expect((await resolver.getModelPricing("claude-test", "2026-01-01T00:00:00.000Z"))?.output_cost_per_token).toBe(4e-6);
});
```

- [ ] **Step 4: Implement the compact store**

```ts
export interface ModelPricingLookup {
  getModelPricing(modelName: string): Promise<ModelPricing | null>;
}

export class HistoricalPricingResolver {
  constructor(
    private readonly lookup: ModelPricingLookup,
    private readonly options: HistoricalPricingResolverOptions = {},
  ) {}

  async getModelPricing(modelName: string, eventTimestamp: string): Promise<ModelPricing | null> {
    const current = await this.lookup.getModelPricing(modelName);
    if (!current) return null;
    const fetchedAt = (this.options.now ?? (() => new Date()))().toISOString();
    const history = await this.load();
    this.remember(history, modelName, current, fetchedAt);
    await this.save(history);
    return this.select(history, modelName, eventTimestamp) ?? current;
  }
}
```

Add `getHistoricalPricingPath()` in `paths.ts` returning `cache/historical-model-prices.json`. Export `LITELLM_PRICING_SOURCE` in the fetcher and use it for its HTTP request. Version the serialized file as `1`, store `source` and per-model `epochs`, and persist only the fields in `ModelPricing`. Hash canonical JSON with SHA-256; append only if the newest epoch checksum differs. Select with `epoch.fetchedAt <= eventTimestamp`. Missing, invalid, or unsupported history files act as empty history. Write to a sibling temporary file and rename it atomically.

- [ ] **Step 5: Run the resolver tests and verify GREEN**

Run: `npm test -- tests/historical-pricing-resolver.test.ts`

Expected: PASS; the older event uses the old rate, the newer event uses the new rate, and pre-history uses the current compatibility rate.

- [ ] **Step 6: Write and run a checksum/deduplication test**

```ts
it("stores one unchanged epoch with source and checksum", async () => {
  const historyPath = path.join(tmpDir, "dedupe.json");
  const resolver = new HistoricalPricingResolver(
    { getModelPricing: async () => ({ input_cost_per_token: 2e-6 }) },
    { historyPath, now: () => new Date("2026-06-01T00:00:00.000Z") },
  );
  await resolver.getModelPricing("gpt-test", "2026-06-02T00:00:00.000Z");
  await resolver.getModelPricing("gpt-test", "2026-06-03T00:00:00.000Z");

  const persisted = JSON.parse(await fs.readFile(historyPath, "utf8"));
  expect(persisted.source).toBe(LITELLM_PRICING_SOURCE);
  expect(persisted.epochs["gpt-test"]).toHaveLength(1);
  expect(persisted.epochs["gpt-test"][0].checksum).toMatch(/^[a-f0-9]{64}$/);
});
```

Run: `npm test -- tests/historical-pricing-resolver.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/config/paths.ts src/pricing/litellm-fetcher.ts src/pricing/historical-pricing-resolver.ts tests/historical-pricing-resolver.test.ts
git commit -m "feat: store historical model price epochs"
```

### Task 2: Use the resolver in the Codex calculator

**Files:**
- Modify: `src/pricing/codex-cost-calculator.ts:3-56`
- Modify: `tests/codex-cost-calculator.test.ts:1-110`

- [ ] **Step 1: Write the failing regression test**

```ts
it("uses the pricing epoch at each Codex event timestamp", async () => {
  const resolver = await priceResolverWithEpochs(tmpDir, "gpt-4o", [
    ["2026-05-01T00:00:00.000Z", { input_cost_per_token: 2e-6 }],
    ["2026-06-01T00:00:00.000Z", { input_cost_per_token: 1e-6 }],
  ]);
  const cost = await calculateCodexApiCost([
    makeEvent({ timestamp: "2026-05-02T00:00:00.000Z", inputTokens: 1_000_000, outputTokens: 0 }),
    makeEvent({ timestamp: "2026-06-02T00:00:00.000Z", inputTokens: 1_000_000, outputTokens: 0 }),
  ], resolver, "standard");

  expect(cost).toBeCloseTo(3, 9);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/codex-cost-calculator.test.ts`

Expected: FAIL because calculator accepts a current fetcher rather than an event-time resolver.

- [ ] **Step 3: Replace current-rate fetcher parameters**

```ts
export async function calculateCodexApiCostBreakdown(
  events: CodexTokenEvent[],
  pricing: HistoricalPricingResolver,
  speedTier: "standard" | "fast",
): Promise<CostBreakdown> {
  for (const event of events) {
    const modelName = MODEL_ALIASES[event.model] ?? event.model;
    const modelPricing = await pricing.getModelPricing(modelName, event.timestamp);
    if (!modelPricing) continue;
    // Preserve existing input/cache/output and fast-tier math.
  }
}
```

Update `calculateCodexApiCost` and `findUnpricedCodexModels` to take the resolver and pass each event timestamp.

- [ ] **Step 4: Convert existing calculator tests to a deterministic offline resolver and verify GREEN**

Run: `npm test -- tests/codex-cost-calculator.test.ts`

Expected: PASS, including existing cache and fast-tier coverage.

- [ ] **Step 5: Commit**

```bash
git add src/pricing/codex-cost-calculator.ts tests/codex-cost-calculator.test.ts
git commit -m "feat: price Codex events by timestamp"
```

### Task 3: Integrate live reports and Cost Factor

**Files:**
- Modify: `src/reports/reportService.ts:1-330`
- Modify: `src/pricing/subscription-factor.ts:1-160`
- Modify: `tests/reports.test.ts:1-193`
- Modify: `tests/subscription-factor.test.ts:1-245`

- [ ] **Step 1: Write a failing report precedence/history test**

```ts
it("keeps source costUSD and applies historical pricing only to missing Claude costs", async () => {
  const pricingResolver = await priceResolverWithEpochs(tmpRoot, "claude-test", [
    ["2026-05-01T00:00:00.000Z", { output_cost_per_token: 4e-6 }],
    ["2026-06-01T00:00:00.000Z", { output_cost_per_token: 2e-6 }],
  ]);
  const report = await generateUsageReport({ provider: "claude", type: "daily", timezone: "UTC", costMode: "auto", order: "asc" }, {
    pricingResolver,
    claudeEntries: [
      claudeEntry("2026-05-02T00:00:00.000Z", "claude-test", 1_000_000),
      claudeEntry("2026-06-02T00:00:00.000Z", "claude-test", 1_000_000),
      { ...claudeEntry("2026-06-02T01:00:00.000Z", "claude-test", 1_000_000), costUSD: 7 },
    ],
  });

  expect(report.rows.map((row) => row.costUSD)).toEqual([4, 9]);
});
```

- [ ] **Step 2: Run the report test and verify RED**

Run: `npm test -- tests/reports.test.ts`

Expected: FAIL because `ReportDeps` has no resolver injection or uses one current price for both rows.

- [ ] **Step 3: Integrate per-entry pricing in reports**

Add `pricingResolver?: HistoricalPricingResolver` to `ReportDeps`, construct the default resolver around `LiteLLMFetcher`, and pass it into Claude/Codex builders. In `auto`, retain every provider-supplied Claude `costUSD`; calculate only missing entries one at a time with `getModelPricing(entry.model, entry.timestamp)`. In `calculate`, calculate every Claude entry using its event timestamp. Aggregate actual per-entry cost components so component totals remain equal to the historical row total.

- [ ] **Step 4: Write the failing Cost Factor regression test**

```ts
it("keeps earlier Claude Cost Factor costs after a later lower price epoch", async () => {
  const engine = new PricingEngine(settings, claudeDir, undefined, undefined, undefined, { pricingResolver });
  const result = await engine.calculateFactor(makeSnapshot("claude"));
  expect(result?.apiCostUSD).toBeCloseTo(6, 9);
});
```

- [ ] **Step 5: Run the Cost Factor test and verify RED**

Run: `npm test -- tests/subscription-factor.test.ts`

Expected: FAIL because `PricingEngine` cannot inject or use a historical resolver.

- [ ] **Step 6: Integrate per-entry pricing in Cost Factor**

Give `PricingEngine` an optional test-only resolver injection and default it to `new HistoricalPricingResolver(new LiteLLMFetcher(settings.pricingOfflineMode))`. Calculate missing Claude entries individually, and use the resolver for Codex costs and missing-model discovery. Keep `isEstimate: false` and current labels; the accepted fallback has no estimate indicator.

- [ ] **Step 7: Run both suites and verify GREEN**

Run: `npm test -- tests/reports.test.ts tests/subscription-factor.test.ts`

Expected: PASS; existing source costs remain unchanged and earlier calculated costs survive a cheaper later epoch.

- [ ] **Step 8: Commit**

```bash
git add src/reports/reportService.ts src/pricing/subscription-factor.ts tests/reports.test.ts tests/subscription-factor.test.ts
git commit -m "feat: resolve live costs from price history"
```

### Task 4: Write future backfill summaries with event-time prices

**Files:**
- Modify: `src/main/debugBackfill.ts:1-280`
- Modify: `src/main/main.ts:140-155,271-290`
- Modify: `tests/debugBackfill.test.ts:1-145`
- Modify: `tests/reports.test.ts:194-315`

- [ ] **Step 1: Write a failing new-backfill-summary test**

```ts
it("writes new backfill summaries using event-time pricing", async () => {
  const pricingResolver = await priceResolverWithEpochs(tmpDir, "gpt-4o", [
    ["2026-05-01T00:00:00.000Z", { input_cost_per_token: 2e-6 }],
    ["2026-06-01T00:00:00.000Z", { input_cost_per_token: 1e-6 }],
  ]);
  await runBackfill({ recorder, logDir, claudeProjectsDirs: [], codexSessionsDirs: [sessionsDir], pricingResolver, force: true });

  expect(readDaySummary(logDir, "2026-05-02").totalCostUSD).toBeCloseTo(2, 9);
  expect(readDaySummary(logDir, "2026-06-02").totalCostUSD).toBeCloseTo(1, 9);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/debugBackfill.test.ts`

Expected: FAIL because `BackfillOptions` accepts a fetcher/current price rather than a resolver.

- [ ] **Step 3: Integrate resolver when writing summaries**

Replace the optional backfill fetcher with `pricingResolver?: HistoricalPricingResolver`. Calculate missing Claude entries and Codex events at their individual timestamps. In `main.ts`, construct one app-lifetime resolver around the current `backfillFetcher` and pass it to manual and scheduled `runBackfill` calls. Do not modify `readBackfillDayRecords`, `buildRowsFromBackfill`, existing backfill files, or `BACKFILL_REPAIR_VERSION`.

- [ ] **Step 4: Add and run a byte/value stability test for existing backfill reports**

```ts
it("returns stored backfill report costs without consulting pricing", async () => {
  const before = await fs.readFile(path.join(logDir, "2026-05-18.backfill.jsonl"), "utf8");
  const report = await generateUsageReport({ source: "backfill", provider: "claude", type: "daily", timezone: "UTC" }, { backfillLogDir: logDir });

  expect(report.rows[0].costUSD).toBe(0.05);
  expect(await fs.readFile(path.join(logDir, "2026-05-18.backfill.jsonl"), "utf8")).toBe(before);
});
```

Run: `npm test -- tests/debugBackfill.test.ts tests/reports.test.ts`

Expected: PASS; only newly generated summaries use epochs and stored reports/files are unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/main/debugBackfill.ts src/main/main.ts tests/debugBackfill.test.ts tests/reports.test.ts
git commit -m "feat: preserve historical prices in new backfill costs"
```

### Task 5: Document and verify

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add an English documentation note**

```md
### Historical API cost pricing

QuotaBar keeps compact local price epochs for models it has resolved. Calculated events use the latest locally observed price at or before their timestamp. Claude costs supplied in source logs and stored backfill summaries remain authoritative. Older installations without an applicable epoch use the current price for compatibility.
```

- [ ] **Step 2: Run the complete test suite**

Run: `npm test`

Expected: PASS with zero failures.

- [ ] **Step 3: Run the TypeScript build**

Run: `npm run build`

Expected: exit code `0`.

- [ ] **Step 4: Inspect and commit**

```bash
git diff --check
git status --short
git add README.md
git commit -m "docs: explain historical cost pricing"
```

No renderer files change, so the Electron-window verification in `TESTING.md` is not required.

## Plan self-review

- Tasks 1–4 cover epoch selection, compact source/checksum-backed storage, current-price compatibility fallback, provider `costUSD` precedence, live reports, Cost Factor, new backfill summaries, and immutable stored backfill reports.
- The plan deliberately omits an estimate marker and a “current prices” UI mode, per the accepted product decision.
- LiteLLM commit dates are not used as provider-effective dates.


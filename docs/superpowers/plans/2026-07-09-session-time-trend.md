# Session Time Trend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Analytics chart that tracks average measurable session duration over time by provider.

**Architecture:** The main worker computes the session duration time series from existing `ActivityEntry` data and returns it in `AnalyticsData`. The renderer consumes that ready-to-chart data, applies the existing provider toggle, and renders a dedicated Chart.js line chart with explanatory copy.

**Tech Stack:** TypeScript, Electron, plain renderer JavaScript, Chart.js, Vitest.

---

## File Structure

- Modify `src/main/analyticsSummary.ts`: add `SessionDurationBucket`, helper functions, and `AnalyticsData.sessionDurationBuckets`.
- Modify `src/main/analyticsWorker.ts`: build the daily session-duration buckets from Claude, Codex, and combined activity entries.
- Modify `src/renderer/tabs/analytics.js`: add chart state, markup, rendering, provider updates, and test hooks.
- Modify `tests/analyticsDeepDive.test.ts`: add focused tests for session-duration bucket behavior.

### Task 1: Add Session Duration Bucket Tests

**Files:**
- Modify: `tests/analyticsDeepDive.test.ts`

- [ ] **Step 1: Write failing tests**

Add imports for `buildSessionDurationBuckets` and `aggregateSessionDurationBuckets`, then add tests covering daily, weekly, monthly, combined, single-entry, and invalid timestamp behavior.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/analyticsDeepDive.test.ts`

Expected: FAIL because the new functions are not exported yet.

### Task 2: Implement Session Duration Aggregation

**Files:**
- Modify: `src/main/analyticsSummary.ts`

- [ ] **Step 1: Add production code**

Add:

- `SessionDurationBucket`
- `buildSessionDurationBuckets(entries, since, until)`
- `aggregateSessionDurationBuckets(daily, agg)`

Use local day keys for daily buckets, ISO week starts for weekly buckets, and month starts for monthly buckets.

- [ ] **Step 2: Run focused tests**

Run: `npm test -- tests/analyticsDeepDive.test.ts`

Expected: PASS for the new aggregation tests and existing Analytics deep-dive tests.

### Task 3: Wire Worker Data

**Files:**
- Modify: `src/main/analyticsSummary.ts`
- Modify: `src/main/analyticsWorker.ts`

- [ ] **Step 1: Extend `AnalyticsData`**

Add `sessionDurationBuckets` with `daily`, `weekly`, and `monthly` arrays.

- [ ] **Step 2: Build data in worker**

After `claudeActivity`, `codexActivity`, and `allActivity` are created, compute daily buckets for each provider, then aggregate to weekly and monthly.

- [ ] **Step 3: Run focused tests and build**

Run: `npm test -- tests/analyticsDeepDive.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: TypeScript build exits with code 0.

### Task 4: Render Analytics Chart

**Files:**
- Modify: `src/renderer/tabs/analytics.js`

- [ ] **Step 1: Add chart state and markup**

Add `_sessionTimeChart`, a new `AVG SESSION TIME` section after `ACTIVITY STATS`, the explanatory sentence, and a canvas.

- [ ] **Step 2: Add renderer helpers**

Add helpers to pick session-duration buckets for `daily`, `weekly`, and `monthly`, falling back from `hourly` to `daily`.

- [ ] **Step 3: Re-render on provider and resolution changes**

Call the new builder from `_renderResults()` and `_applyProvider()`. Rebuild it when the aggregation control changes.

- [ ] **Step 4: Add renderer test hooks**

Expose pure helper functions through `QB.__analyticsTest` so renderer behavior can be unit-checked later without a browser.

### Task 5: Verify

**Files:**
- No additional files.

- [ ] **Step 1: Run required commands**

Run: `npm test`

Expected: all tests pass.

Run: `npm run build`

Expected: TypeScript build exits with code 0.

- [ ] **Step 2: Manual Electron verification**

Run or use the existing Electron test workflow from `TESTING.md`, open Analytics, switch `Day`, `Wk`, `Mo`, and `Hr`, and verify the new chart renders readable provider-specific lines with the explanation text.

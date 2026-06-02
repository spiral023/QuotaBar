# Window Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 5h-window ETA, burn-rate indicator, and limit-warning badge to the Live tab, plus collapsible token details.

**Architecture:** Enable `computeLinearPace` for the fiveHour window (1-line fix), add a `BurnRateTracker` ring-buffer class for %/h computation, attach both plus `safetyGapSeconds` to `UsageWindow` in `refreshLoop.ts`, then render new badges and a collapsible token section in the vanilla-JS frontend.

**Tech Stack:** TypeScript (backend), vanilla JS + inline CSS in `src/renderer/index.html`, Vitest for tests.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `src/providers/types.ts` | Add `burnRatePctPerHour`, `safetyGapSeconds` to `UsageWindow` |
| Modify | `src/usage/usagePace.ts` | Add `computeSafetyGap()` export |
| **Create** | `src/usage/burnRateTracker.ts` | Rolling %/h ring-buffer |
| Modify | `src/usage/refreshLoop.ts` | Wire up all three computations |
| **Create** | `tests/burnRateTracker.test.ts` | Unit tests for BurnRateTracker |
| Modify | `tests/usagePace.test.ts` | Add `computeSafetyGap` tests |
| Modify | `tests/refreshLoop.test.ts` | Tests for new window fields |
| Modify | `src/renderer/tabs/live.js` | New render functions + collapsible |
| Modify | `src/renderer/index.html` | CSS for new components |

---

### Task 1: Extend UsageWindow type

**Files:**
- Modify: `src/providers/types.ts`

- [ ] **Step 1: Add the two new optional fields to `UsageWindow`**

In `src/providers/types.ts`, find the `UsageWindow` interface (currently at line 33) and add two fields after `pace`:

```typescript
export interface UsageWindow {
  name: "session" | "fiveHour" | "weekly" | "monthly" | "credits";
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string;
  windowSeconds?: number;
  label?: string;
  pace?: UsagePace | null;
  burnRatePctPerHour?: number | null;
  safetyGapSeconds?: number | null;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/providers/types.ts
git commit -m "feat(types): add burnRatePctPerHour and safetyGapSeconds to UsageWindow"
```

---

### Task 2: Add computeSafetyGap to usagePace.ts

**Files:**
- Modify: `src/usage/usagePace.ts`
- Modify: `tests/usagePace.test.ts`

- [ ] **Step 1: Write failing tests for computeSafetyGap**

Append to `tests/usagePace.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { computeLinearPace, computeSafetyGap, RateWindow } from "../src/usage/usagePace";
import type { UsagePace } from "../src/usage/usagePace";

// --- existing tests above, add new describe block below ---

const GAP_NOW = new Date("2026-01-01T12:00:00.000Z");

function gapResetsAt(offsetSeconds: number): string {
  return new Date(GAP_NOW.getTime() + offsetSeconds * 1000).toISOString();
}

function makePace(overrides: Partial<UsagePace>): UsagePace {
  return {
    stage: "onTrack",
    deltaPercent: 0,
    expectedUsedPercent: 50,
    actualUsedPercent: 50,
    etaSeconds: null,
    willLastToReset: true,
    ...overrides,
  };
}

describe("computeSafetyGap", () => {
  it("willLastToReset=true → returns timeToReset (safe, large positive)", () => {
    const resetsAt = gapResetsAt(3600);
    const pace = makePace({ willLastToReset: true, etaSeconds: null });
    expect(computeSafetyGap(resetsAt, pace, GAP_NOW)).toBeCloseTo(3600, 0);
  });

  it("etaSeconds < timeToReset → positive gap (blocking duration = timeToReset - etaSeconds)", () => {
    const resetsAt = gapResetsAt(3600);
    const pace = makePace({ willLastToReset: false, etaSeconds: 1800 });
    // gap = 3600 - 1800 = 1800 (user will be blocked for 30min after hitting limit)
    expect(computeSafetyGap(resetsAt, pace, GAP_NOW)).toBeCloseTo(1800, 0);
  });

  it("small etaSeconds → small gap (almost no time until limit)", () => {
    const resetsAt = gapResetsAt(3600);
    const pace = makePace({ willLastToReset: false, etaSeconds: 600 });
    expect(computeSafetyGap(resetsAt, pace, GAP_NOW)).toBeCloseTo(3000, 0);
  });

  it("past reset → null", () => {
    const resetsAt = gapResetsAt(-1);
    const pace = makePace({ willLastToReset: false, etaSeconds: 600 });
    expect(computeSafetyGap(resetsAt, pace, GAP_NOW)).toBeNull();
  });

  it("etaSeconds=null and willLastToReset=false → null (no data)", () => {
    const resetsAt = gapResetsAt(3600);
    const pace = makePace({ willLastToReset: false, etaSeconds: null });
    expect(computeSafetyGap(resetsAt, pace, GAP_NOW)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/usagePace.test.ts
```

Expected: `computeSafetyGap` is not exported → import error or test failure.

- [ ] **Step 3: Implement computeSafetyGap in usagePace.ts**

Append to the end of `src/usage/usagePace.ts`:

```typescript
export function computeSafetyGap(
  resetsAt: string,
  pace: UsagePace,
  now: Date = new Date()
): number | null {
  const timeToReset = (new Date(resetsAt).getTime() - now.getTime()) / 1000;
  if (timeToReset <= 0) return null;
  if (pace.willLastToReset) return timeToReset;
  if (pace.etaSeconds !== null) return timeToReset - pace.etaSeconds;
  return null;
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npx vitest run tests/usagePace.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/usage/usagePace.ts tests/usagePace.test.ts
git commit -m "feat(usagePace): add computeSafetyGap pure function"
```

---

### Task 3: Create BurnRateTracker

**Files:**
- Create: `src/usage/burnRateTracker.ts`
- Create: `tests/burnRateTracker.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/burnRateTracker.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { BurnRateTracker } from "../src/usage/burnRateTracker";

function atOffset(baseMs: number, offsetMinutes: number): Date {
  return new Date(baseMs + offsetMinutes * 60_000);
}

describe("BurnRateTracker", () => {
  const BASE = new Date("2026-01-01T12:00:00.000Z").getTime();

  it("returns null with fewer than 3 recorded points", () => {
    const t = new BurnRateTracker();
    t.record("claude", "fiveHour", 10, atOffset(BASE, 0));
    t.record("claude", "fiveHour", 15, atOffset(BASE, 5));
    expect(t.getBurnRate("claude", "fiveHour")).toBeNull();
  });

  it("returns null when time span is less than 2 minutes", () => {
    const t = new BurnRateTracker();
    t.record("claude", "fiveHour", 10, atOffset(BASE, 0));
    t.record("claude", "fiveHour", 11, atOffset(BASE, 0.5));
    t.record("claude", "fiveHour", 12, atOffset(BASE, 1));
    expect(t.getBurnRate("claude", "fiveHour")).toBeNull();
  });

  it("computes correct burn rate in %/h — 6% over 30min = 12%/h", () => {
    const t = new BurnRateTracker();
    t.record("claude", "fiveHour", 0,  atOffset(BASE,  0));
    t.record("claude", "fiveHour", 3,  atOffset(BASE, 15));
    t.record("claude", "fiveHour", 6,  atOffset(BASE, 30));
    expect(t.getBurnRate("claude", "fiveHour")).toBeCloseTo(12, 0);
  });

  it("resets buffer when pct drops by more than 15pp (window cycle boundary)", () => {
    const t = new BurnRateTracker();
    t.record("claude", "fiveHour", 80, atOffset(BASE,  0));
    t.record("claude", "fiveHour", 90, atOffset(BASE, 10));
    // Large drop → new cycle detected, buffer resets to just this point
    t.record("claude", "fiveHour",  5, atOffset(BASE, 20));
    // Only 1 point after reset → null
    expect(t.getBurnRate("claude", "fiveHour")).toBeNull();
  });

  it("accumulates correctly after a reset-detected drop", () => {
    const t = new BurnRateTracker();
    t.record("claude", "fiveHour", 80, atOffset(BASE,  0));
    t.record("claude", "fiveHour", 90, atOffset(BASE, 10));
    t.record("claude", "fiveHour",  5, atOffset(BASE, 20)); // reset detected
    t.record("claude", "fiveHour", 10, atOffset(BASE, 30));
    t.record("claude", "fiveHour", 15, atOffset(BASE, 40));
    // 3 points: 5@20min, 10@30min, 15@40min → 10% over 20min = 30%/h
    expect(t.getBurnRate("claude", "fiveHour")).toBeCloseTo(30, 0);
  });

  it("provider and windowName are tracked independently", () => {
    const t = new BurnRateTracker();
    t.record("claude", "fiveHour", 0,  atOffset(BASE,  0));
    t.record("claude", "fiveHour", 6,  atOffset(BASE, 30));
    t.record("claude", "fiveHour", 12, atOffset(BASE, 60));
    expect(t.getBurnRate("claude", "weekly")).toBeNull();
    expect(t.getBurnRate("codex", "fiveHour")).toBeNull();
  });

  it("keeps at most 8 points per key (ring buffer)", () => {
    const t = new BurnRateTracker();
    for (let i = 0; i <= 10; i++) {
      t.record("claude", "fiveHour", i, atOffset(BASE, i * 5));
    }
    // Should still return a valid rate using the most recent 5 of 8 points
    const rate = t.getBurnRate("claude", "fiveHour");
    expect(rate).not.toBeNull();
    // Last 5 points: i=6..10, pct=6..10, over 20min → 4%/20min = 12%/h
    expect(rate).toBeCloseTo(12, 0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/burnRateTracker.test.ts
```

Expected: module not found error.

- [ ] **Step 3: Implement BurnRateTracker**

Create `src/usage/burnRateTracker.ts`:

```typescript
interface SnapshotPoint {
  ts: number;
  pct: number;
}

const RESET_DROP_THRESHOLD = 15;
const MAX_POINTS = 8;
const MIN_POINTS = 3;
const MIN_SPAN_MS = 2 * 60 * 1000;

export class BurnRateTracker {
  private readonly history = new Map<string, SnapshotPoint[]>();

  record(provider: string, windowName: string, pct: number, now: Date): void {
    const key = `${provider}:${windowName}`;
    const arr = this.history.get(key) ?? [];
    const point: SnapshotPoint = { ts: now.getTime(), pct };
    if (arr.length > 0 && pct < arr[arr.length - 1].pct - RESET_DROP_THRESHOLD) {
      this.history.set(key, [point]);
      return;
    }
    arr.push(point);
    if (arr.length > MAX_POINTS) arr.shift();
    this.history.set(key, arr);
  }

  getBurnRate(provider: string, windowName: string): number | null {
    const arr = this.history.get(`${provider}:${windowName}`);
    if (!arr || arr.length < MIN_POINTS) return null;
    const recent = arr.slice(-5);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dtMs = last.ts - first.ts;
    if (dtMs < MIN_SPAN_MS) return null;
    return ((last.pct - first.pct) / dtMs) * 3_600_000;
  }
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npx vitest run tests/burnRateTracker.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/usage/burnRateTracker.ts tests/burnRateTracker.test.ts
git commit -m "feat(burnRateTracker): add rolling %/h burn rate ring-buffer"
```

---

### Task 4: Wire up in RefreshLoop

**Files:**
- Modify: `src/usage/refreshLoop.ts`
- Modify: `tests/refreshLoop.test.ts`

- [ ] **Step 1: Write failing tests for the new window fields**

Append at the bottom of `tests/refreshLoop.test.ts` (inside a new `describe` block, after the existing ones):

```typescript
describe("RefreshLoop window intelligence", () => {
  it("attaches pace to fiveHour window (not just weekly)", async () => {
    const store = new UsageStore();
    const resetsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString(); // 2h from now
    const provider = makeProvider("claude", async () => ({
      provider: "claude",
      status: "ok" as const,
      windows: [{ name: "fiveHour" as const, usedPercent: 20, windowSeconds: 18000, resetsAt }],
      updatedAt: new Date().toISOString(),
    }));
    const loop = new RefreshLoop([provider], store, 60, 10_000);
    await loop.refreshNow();
    const win = store.get("claude")?.windows.find(w => w.name === "fiveHour");
    expect(win?.pace).not.toBeUndefined();
    expect(win?.pace).not.toBeNull();
  });

  it("burnRatePctPerHour is null after first refresh (insufficient history)", async () => {
    const store = new UsageStore();
    const resetsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const provider = makeProvider("claude", async () => ({
      provider: "claude",
      status: "ok" as const,
      windows: [{ name: "fiveHour" as const, usedPercent: 30, windowSeconds: 18000, resetsAt }],
      updatedAt: new Date().toISOString(),
    }));
    const loop = new RefreshLoop([provider], store, 60, 10_000);
    await loop.refreshNow();
    const win = store.get("claude")?.windows.find(w => w.name === "fiveHour");
    // Only 1 recorded point → not enough for burn rate
    expect(win?.burnRatePctPerHour).toBeNull();
  });

  it("safetyGapSeconds is set when pace resolves willLastToReset", async () => {
    const store = new UsageStore();
    // 20% used, 2h left in a 5h window → pace will compute willLastToReset
    const resetsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const provider = makeProvider("claude", async () => ({
      provider: "claude",
      status: "ok" as const,
      windows: [{ name: "fiveHour" as const, usedPercent: 20, windowSeconds: 18000, resetsAt }],
      updatedAt: new Date().toISOString(),
    }));
    const loop = new RefreshLoop([provider], store, 60, 10_000);
    await loop.refreshNow();
    const win = store.get("claude")?.windows.find(w => w.name === "fiveHour");
    expect(win?.safetyGapSeconds).not.toBeNull();
    // willLastToReset case → safetyGapSeconds ≈ timeToReset ≈ 7200s
    expect(win?.safetyGapSeconds).toBeGreaterThan(7000);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/refreshLoop.test.ts
```

Expected: the 3 new tests in the last describe block fail (pace not on fiveHour, fields undefined).

- [ ] **Step 3: Apply changes to refreshLoop.ts**

Add the import at the top of `src/usage/refreshLoop.ts` (after existing imports):

```typescript
import { BurnRateTracker } from "./burnRateTracker";
import { computeSafetyGap } from "./usagePace";
```

Add the tracker as a private field inside the `RefreshLoop` class (after the `backoff` field):

```typescript
private readonly burnRateTracker = new BurnRateTracker();
```

Replace the current window-processing loop in `refreshNow` (lines 61–65):

```typescript
// BEFORE:
for (const window of snapshot.windows) {
  if (window.name === "weekly") {
    window.pace = computeLinearPace(toRateWindow(window), now);
  }
}

// AFTER:
for (const window of snapshot.windows) {
  if (window.name === "weekly" || window.name === "fiveHour") {
    window.pace = computeLinearPace(toRateWindow(window), now);
  }
  if (typeof window.usedPercent === "number" && window.resetsAt) {
    this.burnRateTracker.record(snapshot.provider, window.name, window.usedPercent, now);
    window.burnRatePctPerHour = this.burnRateTracker.getBurnRate(snapshot.provider, window.name);
  }
  if (window.pace && window.resetsAt) {
    window.safetyGapSeconds = computeSafetyGap(window.resetsAt, window.pace, now);
  }
}
```

- [ ] **Step 4: Run all tests**

```bash
npx vitest run
```

Expected: all tests pass. The 3 new refreshLoop tests must be green.

- [ ] **Step 5: Commit**

```bash
git add src/usage/refreshLoop.ts
git commit -m "feat(refreshLoop): enable 5h pace, burn rate, and safety gap computation"
```

---

### Task 5: Frontend — new render logic in live.js

**Files:**
- Modify: `src/renderer/tabs/live.js`

There are no unit tests for the renderer (vanilla JS, DOM-dependent). Manual testing step is at the end.

- [ ] **Step 1: Add helper function `fmtDuration`**

In `src/renderer/tabs/live.js`, add this function immediately after the existing `clamp` helper (around line 23):

```javascript
function fmtDuration(seconds) {
  const s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}min`;
}
```

- [ ] **Step 2: Add `windowInsightHtml` function**

Add this function after `fmtDuration`:

```javascript
function windowInsightHtml(win) {
  if (!win) return '';
  const pace = win.pace;
  const burnRate = win.burnRatePctPerHour;
  const burnStr = (burnRate !== null && burnRate !== undefined)
    ? `${burnRate >= 0 ? '+' : ''}${burnRate.toFixed(1)} %/h`
    : null;
  const burnTip = 'Ø Verbrauchsrate aus den letzten Messungen.\nBasis: Δ% ÷ Δt (bis zu 5 Snapshots).';
  const burnHtml = burnStr
    ? `<span class="burn-rate" title="${QB.esc(burnTip)}">${QB.esc(burnStr)}</span>`
    : '';

  if (!pace || pace.willLastToReset || pace.etaSeconds === null) {
    return burnHtml ? `<div class="bar-sub-row">${burnHtml}</div>` : '';
  }

  // Limit will be hit before the reset
  const etaMin = Math.round(pace.etaSeconds / 60);
  const isCritical = pace.etaSeconds <= 900;   // ≤ 15 min
  const isWarn     = pace.etaSeconds <= 1800;  // ≤ 30 min
  if (!isCritical && !isWarn) {
    // > 30 min: informational only, just show burn rate
    return burnHtml ? `<div class="bar-sub-row">${burnHtml}</div>` : '';
  }

  const cls = isCritical ? 'gap-critical' : 'gap-warn';
  let blockInfo = '';
  let tip = `Hochrechnung: bei aktuellem Tempo wird das Fenster in ~${etaMin}min voll.`;
  if (win.safetyGapSeconds !== null && win.safetyGapSeconds !== undefined) {
    const blockMin = Math.round(win.safetyGapSeconds / 60);
    if (blockMin > 0) {
      blockInfo = ` · Reset in ${fmtDuration(win.safetyGapSeconds + pace.etaSeconds)}`;
      tip += `\nDann noch ~${blockMin}min bis zum nächsten Reset.`;
    }
  }
  if (burnStr) tip += `\nAktuelles Tempo: ${burnStr}.`;
  const label = `⚠ Limit ~${etaMin}min${blockInfo}`;
  return `<div class="bar-sub-row">
    <span class="safety-gap ${cls}" title="${QB.esc(tip)}">${QB.esc(label)}</span>
    ${burnHtml}
  </div>`;
}
```

- [ ] **Step 3: Refactor tokenDetailHtml into two functions**

The current `tokenDetailHtml(cf)` function (around line 66) always renders an expanded grid. Rename it to `tokenDetailInnerHtml` and add a new `tokenCollapseHtml` that wraps it:

Replace the current `tokenDetailHtml` function with:

```javascript
function tokenDetailInnerHtml(cf) {
  if (!cf?.tokenUsage) return '';
  const t = cf.tokenUsage;
  const cells = [
    ['Input',   QB.fmtTokens(t.inputTokens),        false],
    ['Output',  QB.fmtTokens(t.outputTokens),       false],
    ['Cache +', QB.fmtTokens(t.cacheCreationTokens),false],
    ['Cache ▷', QB.fmtTokens(t.cacheReadTokens), false],
    ['Total',   QB.fmtTokens(t.totalTokens),         false],
    ['Cost',    `$${(cf.apiCostUSD || 0).toFixed(2)}`, true],
  ];
  const cellsHtml = cells.map(([lbl, val, isCost]) =>
    `<div class="token-cell">
      <span class="token-cell-lbl">${lbl}</span>
      <span class="token-cell-val${isCost ? ' is-cost' : ''}">${val}</span>
    </div>`
  ).join('');
  const modelsHtml = t.models?.length > 0
    ? `<div class="token-models">${QB.esc(t.models.join(', '))}</div>` : '';
  return `<div class="token-section"><div class="token-grid">${cellsHtml}</div>${modelsHtml}</div>`;
}

function tokenCollapseHtml(cf, provider) {
  const inner = tokenDetailInnerHtml(cf);
  if (!inner) return '';
  const id = `tc-${QB.esc(provider)}`;
  let isOpen = false;
  try { isOpen = localStorage.getItem('tokenDetailsOpen') === '1'; } catch {}
  return `<div class="token-collapse${isOpen ? ' open' : ''}" id="${QB.esc(id)}">
    <button class="token-toggle" aria-expanded="${isOpen}"
            onclick="QB.toggleTokenSection('${QB.esc(id)}')">
      <svg class="toggle-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Token Details
    </button>
    <div class="token-body">${inner}</div>
  </div>`;
}
```

- [ ] **Step 4: Add QB.toggleTokenSection method**

At the bottom of `src/renderer/tabs/live.js`, before the `QB.renderLive` assignment, add:

```javascript
QB.toggleTokenSection = function toggleTokenSection(id) {
  const container = document.getElementById(id);
  if (!container) return;
  const isOpen = container.classList.toggle('open');
  const btn = container.querySelector('.token-toggle');
  if (btn) btn.setAttribute('aria-expanded', String(isOpen));
  try { localStorage.setItem('tokenDetailsOpen', isOpen ? '1' : '0'); } catch {}
};
```

- [ ] **Step 5: Update `renderStandard` to use new functions**

Replace the entire `renderStandard` function (currently lines 174–212) with this version:

```javascript
function renderStandard(snap, name, delay) {
  const fiveH  = snap.windows.find(w => w.name === 'fiveHour');
  const weekly = snap.windows.find(w => w.name === 'weekly');
  const rawPct = fiveH?.usedPercent;
  const hasPct = typeof rawPct === 'number';
  const pct    = hasPct ? rawPct : 0;
  const color  = hasPct ? QB.usageColor(pct) : 'gray';
  const pctTxt = hasPct ? `${Math.round(pct)}%` : '—';
  const fhId   = `cd-${snap.provider}-5h`;
  const wkId   = `cd-${snap.provider}-wk`;
  if (fiveH?.resetsAt)  _countdowns.push({ id: fhId, resetsAt: fiveH.resetsAt });
  if (weekly?.resetsAt) _countdowns.push({ id: wkId, resetsAt: weekly.resetsAt });
  const fhCd = fiveH?.resetsAt  ? QB.formatCountdown(fiveH.resetsAt)  : '';
  const wkCd = weekly?.resetsAt ? QB.formatCountdown(weekly.resetsAt) : '';
  const fhExpected = timeProgressPct(fiveH);
  const fhInsight  = windowInsightHtml(fiveH);

  let bars = `<div class="bar-group">
    <div class="bar-meta">
      <span class="bar-tag">5-Hour</span>
      <span class="bar-cd" id="${fhId}">${fhCd}</span>
    </div>
    <div class="bar-track thick">
      <div class="bar-fill c-${color}" style="width:${clamp(pct,0,100)}%"></div>
      ${timeMarkerHtml(pct, fhExpected)}
    </div>
    ${fhInsight}
  </div>`;

  if (weekly && typeof weekly.usedPercent === 'number') {
    const wc = QB.usageColor(weekly.usedPercent);
    const wkExpected = weekly.pace?.expectedUsedPercent ?? timeProgressPct(weekly);
    bars += `<div class="bar-group">
      <div class="bar-meta">
        <span class="bar-tag">Weekly</span>
        <span class="bar-cd" id="${wkId}">${wkCd}</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill c-${wc}" style="width:${clamp(weekly.usedPercent,0,100)}%"></div>
        ${timeMarkerHtml(weekly.usedPercent, wkExpected)}
      </div>
    </div>`;
  }

  const bdgs = [];
  if (snap.status === 'stale') bdgs.push(`<span class="badge b-stale">Stale</span>`);
  if (weekly?.pace) bdgs.push(`<span class="badge ${paceClass(weekly.pace.stage)}">${paceLabel(weekly.pace.stage)}</span>`);
  const costHtml = costBadgeHtml(snap.costFactor);
  if (costHtml) bdgs.push(costHtml);
  const accent = QB.accentVar(hasPct ? pct : null);
  const tokenHtml = tokenCollapseHtml(snap.costFactor, snap.provider);

  return `<div class="card has-accent" style="--card-accent:${accent};${delay}">
    <div class="card-body">
      ${providerIconHtml(snap.provider)}
      <div class="card-info">
        <div class="card-head">
          <span class="prov-name">${QB.esc(name)}</span>
          <div class="card-right">
            <span class="prov-pct" style="color:var(--${color})">${pctTxt}</span>
            <span class="card-chevron">›</span>
          </div>
        </div>
        ${bars}
        ${bdgs.length ? `<div class="badges">${bdgs.join('')}</div>` : ''}
        ${tokenHtml}
      </div>
    </div>
  </div>`;
}
```

Note: `tokenDetailHtml` is renamed to `tokenDetailInnerHtml` above. Also update the call in `renderGemini` (the function just below `renderStandard`) from:

```javascript
${tokenDetailHtml(snap.costFactor)}
```

to:

```javascript
${tokenDetailInnerHtml(snap.costFactor)}
```

`renderGemini` keeps using the inner (non-collapsible) version because Gemini cards have no detailed token grid to warrant a toggle.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/tabs/live.js
git commit -m "feat(live): add burn-rate, limit-ETA insight, and collapsible token details"
```

---

### Task 6: CSS for new components

**Files:**
- Modify: `src/renderer/index.html`

All CSS is inline in the `<style>` tag. The token-section block starts at line 574. Add all new rules immediately after the closing `}` of `.token-models` (around line 612), before the `/* ══ ANALYTICS */` comment.

- [ ] **Step 1: Add CSS for bar-sub-row, safety-gap, burn-rate**

Find the line `/* ══ ANALYTICS ═══════...` in `src/renderer/index.html` and insert the following CSS block immediately before it:

```css
    /* ── Window insight row ─────────────────────────────────────── */
    .bar-sub-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
      min-height: 18px;
      flex-wrap: wrap;
    }
    .safety-gap {
      display: inline-flex;
      align-items: center;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 9px;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      padding: 2px 6px;
      border-radius: var(--r-badge);
      line-height: 1.45;
      cursor: default;
      white-space: nowrap;
    }
    .gap-warn {
      background: rgba(255,140,0,0.08);
      color: #ffa030;
      border: 1px solid rgba(255,140,0,0.22);
    }
    .gap-critical {
      background: rgba(255,68,68,0.1);
      color: #ff7272;
      border: 1px solid rgba(255,68,68,0.26);
      animation: gap-pulse 2s ease-in-out infinite;
    }
    @keyframes gap-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(255,68,68,0); }
      50%       { box-shadow: 0 0 0 3px rgba(255,68,68,0.14); }
    }
    .burn-rate {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 9px;
      font-variant-numeric: tabular-nums;
      color: var(--t400);
      cursor: default;
      white-space: nowrap;
    }

    /* ── Token collapse ──────────────────────────────────────────── */
    .token-collapse { margin-top: 6px; }
    .token-toggle {
      display: flex;
      align-items: center;
      gap: 5px;
      width: 100%;
      padding: 5px 0 4px;
      background: none;
      border: none;
      border-top: 1px solid var(--border);
      color: var(--t400);
      font-family: 'DM Sans', system-ui, sans-serif;
      font-size: 8.5px;
      font-weight: 600;
      letter-spacing: 0.09em;
      text-transform: uppercase;
      cursor: pointer;
      text-align: left;
      outline: none;
      transition: color 120ms;
    }
    .token-toggle:hover { color: var(--t200); }
    .toggle-chevron {
      flex-shrink: 0;
      transform: rotate(-90deg);
      transition: transform 200ms cubic-bezier(0.4, 0, 0.2, 1);
      color: inherit;
    }
    .token-collapse.open .toggle-chevron { transform: rotate(0deg); }
    .token-body {
      max-height: 0;
      overflow: hidden;
      transition: max-height 220ms cubic-bezier(0.4, 0, 0.2, 1);
    }
    .token-collapse.open .token-body { max-height: 200px; }
    /* Remove the top-border from token-section when inside collapse
       (the toggle button already has the border) */
    .token-collapse .token-section {
      border-top: none;
      padding-top: 4px;
    }
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/index.html
git commit -m "feat(css): add safety-gap, burn-rate, and token-collapse styles"
```

---

### Task 7: Manual UI verification

There are no automated tests for the renderer. Verify all changes manually.

- [ ] **Step 1: Start the app**

```bash
npm run dev
```

This builds TypeScript and starts Electron in headless mode. Open the tray icon to show the popup.

- [ ] **Step 2: Verify token detail collapse**

Open the QuotaBar popup. Each provider card should show a "Token Details ▾" toggle at the bottom (collapsed by default). Click it → section expands with smooth animation. Click again → collapses. Reload → state persists.

- [ ] **Step 3: Verify burn rate appears after 3 refreshes**

Wait for 3+ refresh cycles (or reduce `pollIntervalSeconds` temporarily in settings to 15s). The burn rate `+X.X %/h` should appear as muted monospace text in the bar-sub-row of the 5h bar.

- [ ] **Step 4: Verify limit warning badge**

Temporarily set the fiveHour `usedPercent` very high (or simulate by reading an actual high-usage snapshot). If the pace computation determines `etaSeconds ≤ 1800`, the `⚠ Limit ~Xmin` badge should appear in orange (`gap-warn`). If `≤ 900s`, it should appear red with a pulsing glow (`gap-critical`).

If live data doesn't trigger the warning, you can verify the logic by opening DevTools and checking:
```javascript
// In DevTools console after QB.renderLive is called:
// Check if the fiveHour window has pace set
```

- [ ] **Step 5: Verify tooltips**

Hover over:
- The `⚠ Limit ~Xmin` badge → tooltip should explain the ETA math and burn rate
- The `+X.X %/h` text → tooltip explains Δ% ÷ Δt

- [ ] **Step 6: Run full test suite one final time**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: window intelligence — 5h ETA, burn rate, safety gap, collapsible tokens"
```

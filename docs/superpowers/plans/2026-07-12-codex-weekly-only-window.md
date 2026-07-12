# Codex Weekly-Only Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correctly recognize Codex five-hour and seven-day quota windows by duration and render weekly-only accounts without a fabricated five-hour limit.

**Architecture:** Keep the unofficial API shape inside the Codex provider and convert positional API slots into semantic `UsageWindow` values using `limit_window_seconds`. Downstream consumers continue using semantic names; the Live renderer makes both rows optional, while the tray uses Weekly only as a fallback when Five-Hour is absent.

**Tech Stack:** Electron, TypeScript, browser JavaScript, Vitest, Node `vm`, Playwright Core

---

## File map

- Modify `src/providers/codex.ts`: classify positional Codex API windows by their known duration, deduplicate them, and remove the unsafe durationless fallback.
- Modify `tests/normalization.test.ts`: specify weekly-only, swapped-slot, duplicate, and unknown-duration normalization behavior.
- Modify `src/renderer/tabs/live.js`: render the Five-Hour group only when that semantic window exists and expose the pure card renderer to the existing VM tests.
- Modify `tests/liveRenderer.test.ts`: verify weekly-only and normal two-window card markup.
- Modify `src/icon/iconState.ts`: prefer Five-Hour and fall back to Weekly for the tray bar.
- Modify `tests/iconState.test.ts`: specify the fallback and preference rules.
- Temporarily create `verify-main.cjs` and `verify-drive.cjs`: launch and inspect the real Electron renderer; delete both before completion.

### Task 1: Duration-based Codex window normalization

**Files:**
- Modify: `tests/normalization.test.ts`
- Modify: `src/providers/codex.ts`

- [ ] **Step 1: Add failing provider normalization tests**

Append these tests inside `describe("provider snapshot normalization", ...)` in `tests/normalization.test.ts`:

```ts
  it("normalizes a weekly-only Codex primary window by duration", () => {
    const snapshot = normalizeCodexUsageResponse({
      rate_limit: {
        primary_window: {
          used_percent: 1,
          limit_window_seconds: 604800,
          reset_at: "2026-07-19T12:00:00.000Z",
        },
      },
    });

    expect(snapshot.windows).toEqual([{
      name: "weekly",
      usedPercent: 1,
      resetsAt: "2026-07-19T12:00:00.000Z",
      windowSeconds: 604800,
    }]);
  });

  it("classifies Codex windows correctly when API slots are swapped", () => {
    const snapshot = normalizeCodexUsageResponse({
      rate_limit: {
        primary_window: { used_percent: 31, limit_window_seconds: 604800 },
        secondary_window: { used_percent: 67, limit_window_seconds: 18000 },
      },
    });

    expect(snapshot.windows).toEqual([
      { name: "fiveHour", usedPercent: 67, windowSeconds: 18000 },
      { name: "weekly", usedPercent: 31, windowSeconds: 604800 },
    ]);
  });

  it("keeps the more complete Codex window when both slots have the same duration", () => {
    const snapshot = normalizeCodexUsageResponse({
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 604800 },
        secondary_window: {
          used_percent: 13,
          limit_window_seconds: 604800,
          reset_at: "2026-07-19T12:00:00.000Z",
        },
      },
    });

    expect(snapshot.windows).toEqual([{
      name: "weekly",
      usedPercent: 13,
      resetsAt: "2026-07-19T12:00:00.000Z",
      windowSeconds: 604800,
    }]);
  });

  it("does not guess a Codex quota type without a known duration", () => {
    const snapshot = normalizeCodexUsageResponse({
      used_percent: 44,
      rate_limit: {
        primary_window: { used_percent: 33 },
        secondary_window: { used_percent: 22, limit_window_seconds: 3600 },
      },
    });

    expect(snapshot.windows).toEqual([]);
  });
```

- [ ] **Step 2: Run the focused tests and confirm the current positional behavior fails**

Run:

```powershell
npx vitest run tests/normalization.test.ts
```

Expected: FAIL in the four new tests because `primary_window` is currently always named `fiveHour`, slots are not duration-classified, duplicates are retained, and the top-level percentage creates a fabricated Five-Hour window.

- [ ] **Step 3: Implement known-duration classification and deterministic deduplication**

In `src/providers/codex.ts`, add constants near `CODEX_USAGE_URL`:

```ts
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEKLY_SECONDS = 7 * 24 * 60 * 60;
const WINDOW_ORDER: UsageWindow["name"][] = ["fiveHour", "weekly"];
```

Replace the positional window pushes and top-level fallback in `normalizeCodexUsageResponse`:

```ts
  const candidates = [primary, secondary]
    .filter((window): window is Record<string, unknown> => window !== undefined)
    .map(toKnownUsageWindow)
    .filter((window): window is UsageWindow => window !== undefined);

  for (const name of WINDOW_ORDER) {
    const matches = candidates.filter((window) => window.name === name);
    if (matches.length > 0) windows.push(matches.reduce(preferCompleteWindow));
  }
```

Replace `toUsageWindow(window, name)` with these focused helpers:

```ts
function toKnownUsageWindow(window: Record<string, unknown>): UsageWindow | undefined {
  const seconds = numberFrom(window.limit_window_seconds) ?? numberFrom(window.windowSeconds);
  const name = classifyWindowDuration(seconds);
  if (!name) return undefined;

  const used = numberFrom(window.used_percent) ?? numberFrom(window.usage_percent) ?? percentFromUtilization(window.utilization);
  const reset = normalizeReset(window.reset_at ?? window.resetsAt);
  return {
    name,
    ...(typeof used === "number" ? { usedPercent: clampPercent(used) } : {}),
    ...(reset ? { resetsAt: reset } : {}),
    windowSeconds: seconds,
  };
}

function classifyWindowDuration(seconds: number | undefined): "fiveHour" | "weekly" | undefined {
  if (seconds === FIVE_HOUR_SECONDS) return "fiveHour";
  if (seconds === WEEKLY_SECONDS) return "weekly";
  return undefined;
}

function preferCompleteWindow(left: UsageWindow, right: UsageWindow): UsageWindow {
  return completenessScore(right) > completenessScore(left) ? right : left;
}

function completenessScore(window: UsageWindow): number {
  return (typeof window.usedPercent === "number" ? 4 : 0)
    + (window.resetsAt ? 2 : 0)
    + (typeof window.windowSeconds === "number" ? 1 : 0);
}
```

Remove the now-unused top-level `used_percent`/`usage_percent` fallback. Keep credits handling unchanged.

- [ ] **Step 4: Run normalization tests and type-check the provider change**

Run:

```powershell
npx vitest run tests/normalization.test.ts tests/codexLogging.test.ts
npm run build
```

Expected: both test files PASS and TypeScript exits with code 0.

- [ ] **Step 5: Commit the normalization change**

```powershell
git add src/providers/codex.ts tests/normalization.test.ts
git commit -m "fix: classify Codex quota windows by duration"
```

### Task 2: Optional Five-Hour row in the Live card

**Files:**
- Modify: `tests/liveRenderer.test.ts`
- Modify: `src/renderer/tabs/live.js`

- [ ] **Step 1: Extend the VM harness and add failing card-markup tests**

In `tests/liveRenderer.test.ts`, extend the local types and VM setup:

```ts
type UsageWindow = {
  name: string;
  usedPercent?: number;
  resetsAt?: string;
  windowSeconds?: number;
};

type Snapshot = {
  provider: string;
  status: string;
  windows: UsageWindow[];
  identity?: { email?: string };
};
```

Initialize `qb` with the renderer dependencies and expose `renderStandard` in the return type:

```ts
  const qb = {
    esc: (value: unknown) => String(value),
    usageColor: () => "green",
    accentVar: () => "var(--green)",
    formatCountdown: () => "6d 23h",
    fmtTokens: (value: number) => String(value),
    settings: {},
  };
```

```ts
  renderStandard: (snapshot: Snapshot, name: string, delay: string, accountIndex: number) => string;
```

Add these tests:

```ts
  it("renders only the Weekly row for a weekly-only Codex snapshot", () => {
    const helpers = loadLiveHelpers();
    const html = helpers.renderStandard({
      provider: "codex",
      status: "ok",
      windows: [{
        name: "weekly",
        usedPercent: 1,
        resetsAt: "2026-07-19T12:00:00.000Z",
        windowSeconds: 604800,
      }],
    }, "Codex", "", 1);

    expect(html).toContain("Wk 1%");
    expect(html).toContain(">Weekly<");
    expect(html).not.toContain(">5-Hour<");
  });

  it("keeps both rows for a two-window snapshot", () => {
    const helpers = loadLiveHelpers();
    const html = helpers.renderStandard({
      provider: "codex",
      status: "ok",
      windows: [
        { name: "fiveHour", usedPercent: 25, windowSeconds: 18000 },
        { name: "weekly", usedPercent: 10, windowSeconds: 604800 },
      ],
    }, "Codex", "", 1);

    expect(html).toContain(">5-Hour<");
    expect(html).toContain(">Weekly<");
  });
```

- [ ] **Step 2: Run the renderer test and verify the weekly-only case fails**

Run:

```powershell
npx vitest run tests/liveRenderer.test.ts
```

Expected: FAIL because `renderStandard` is not exposed yet; after exposure alone, the weekly-only assertion still fails because the Five-Hour group is unconditional.

- [ ] **Step 3: Make the Five-Hour markup conditional**

In `renderStandard` in `src/renderer/tabs/live.js`, replace the unconditional `bars` initialization with:

```js
  const barGroups = [];
  if (fiveH && typeof fiveH.usedPercent === 'number') {
    barGroups.push(`<div class="bar-group">
      <div class="bar-meta">
        <span class="bar-tag">5-Hour</span>
        <span class="bar-cd" id="${fhId}">${fhCd}</span>
      </div>
      <div class="bar-track thick">
        <div class="bar-fill c-${fiveColor}" style="width:${clamp(pct,0,100)}%"></div>
        ${timeMarkerHtml(pct, fhExpected)}
      </div>
      ${fhInsight}
    </div>`);
  }
```

Replace `bars +=` in the Weekly branch with `barGroups.push(...)`, including the existing Weekly template unchanged, and replace `${bars}` in the returned card with `${barGroups.join('')}`.

Expose the pure renderer in the existing test hook:

```js
QB.__liveTest = {
  effectiveUsageWindow,
  effectiveUsageLabel,
  orderSnapshots,
  renderStandard,
};
```

- [ ] **Step 4: Run renderer tests**

Run:

```powershell
npx vitest run tests/liveRenderer.test.ts
```

Expected: PASS, including both weekly-only and two-window markup cases.

- [ ] **Step 5: Commit the renderer change**

```powershell
git add src/renderer/tabs/live.js tests/liveRenderer.test.ts
git commit -m "fix: render Codex weekly-only quota cards"
```

### Task 3: Weekly fallback for the tray indicator

**Files:**
- Modify: `tests/iconState.test.ts`
- Modify: `src/icon/iconState.ts`

- [ ] **Step 1: Change the existing weekly-only expectation and add a preference test**

Replace the test named `returns usedPercent=undefined when no fiveHour window present` in `tests/iconState.test.ts` with:

```ts
  it("falls back to weekly usage when no fiveHour window is present", () => {
    const state = buildIconState([snap("codex", "ok", [{ name: "weekly", usedPercent: 30 }])]);
    expect(state.bars).toEqual([{ provider: "codex", usedPercent: 30, isStale: false }]);
  });

  it("prefers fiveHour usage when both quota windows are present", () => {
    const state = buildIconState([snap("codex", "ok", [
      { name: "fiveHour", usedPercent: 25 },
      { name: "weekly", usedPercent: 80 },
    ])]);
    expect(state.bars).toEqual([{ provider: "codex", usedPercent: 25, isStale: false }]);
  });
```

- [ ] **Step 2: Run the focused tray test and confirm fallback failure**

Run:

```powershell
npx vitest run tests/iconState.test.ts
```

Expected: the weekly fallback test FAILS with `usedPercent: undefined`; the Five-Hour preference test passes.

- [ ] **Step 3: Implement the semantic fallback**

In `src/icon/iconState.ts`, replace the single Five-Hour lookup with:

```ts
    const fiveHour = snap.windows.find((window) => window.name === "fiveHour");
    const weekly = snap.windows.find((window) => window.name === "weekly");
    const win = fiveHour ?? weekly;
```

Keep the existing returned `BarData` shape and provider ordering unchanged.

- [ ] **Step 4: Run tray tests**

Run:

```powershell
npx vitest run tests/iconState.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the tray fallback**

```powershell
git add src/icon/iconState.ts tests/iconState.test.ts
git commit -m "fix: use weekly Codex quota in tray fallback"
```

### Task 4: Full verification and real Electron UI check

**Files:**
- Temporarily create and delete: `verify-main.cjs`
- Temporarily create and delete: `verify-drive.cjs`
- Verify: all modified source and test files

- [ ] **Step 1: Run the complete automated verification required by AGENTS.md**

Run:

```powershell
npm test
npm run build
```

Expected: the complete Vitest suite passes and TypeScript exits with code 0.

- [ ] **Step 2: Create the temporary Electron entry point**

Create `verify-main.cjs` exactly as follows:

```js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { DetailsWindowController } = require('./dist/main/detailsWindow.js');

app.whenReady().then(async () => {
  new DetailsWindowController(() => null, undefined);
  const win = new BrowserWindow({
    width: 900,
    height: 660,
    frame: false,
    backgroundColor: '#090c10',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await win.loadFile(path.join(__dirname, 'src/renderer/index.html'));
});
```

- [ ] **Step 3: Create a temporary Playwright driver with weekly-only and two-window fixtures**

Create `verify-drive.cjs` exactly as follows:

```js
const { _electron } = require('playwright-core');

delete process.env.ELECTRON_RUN_AS_NODE;

(async () => {
  const app = await _electron.launch({ args: ['verify-main.cjs'], cwd: __dirname });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  await page.evaluate(() => {
    document.body.classList.add('view-dashboard');
    document.body.classList.remove('view-compact');
    window.QB.renderLive([{
      provider: 'codex',
      status: 'ok',
      windows: [{
        name: 'weekly',
        usedPercent: 1,
        resetsAt: new Date(Date.now() + 604000000).toISOString(),
        windowSeconds: 604800,
      }],
      updatedAt: new Date().toISOString(),
    }]);
  });

  const weeklyText = await page.locator('[data-provider="codex"]').innerText();
  if (!weeklyText.includes('Weekly') || weeklyText.includes('5-Hour')) {
    throw new Error(`Weekly-only card is incorrect: ${weeklyText}`);
  }
  await page.screenshot({ path: 'verify-codex-weekly-only.png' });

  await page.evaluate(() => {
    window.QB.renderLive([{
      provider: 'codex',
      status: 'ok',
      windows: [
        { name: 'fiveHour', usedPercent: 25, windowSeconds: 18000 },
        { name: 'weekly', usedPercent: 10, windowSeconds: 604800 },
      ],
      updatedAt: new Date().toISOString(),
    }]);
  });

  const twoWindowText = await page.locator('[data-provider="codex"]').innerText();
  if (!twoWindowText.includes('5-Hour') || !twoWindowText.includes('Weekly')) {
    throw new Error(`Two-window card regressed: ${twoWindowText}`);
  }
  await page.screenshot({ path: 'verify-codex-two-window.png' });
  await app.close();
})();
```

- [ ] **Step 4: Run the real Electron verification and inspect both screenshots**

Run:

```powershell
node verify-drive.cjs
```

Expected: exit code 0 and both `verify-codex-weekly-only.png` and `verify-codex-two-window.png` exist. Inspect both images: the weekly-only card has one correctly aligned Weekly row, and the two-window card retains the existing Five-Hour and Weekly layout at 900×660.

- [ ] **Step 5: Remove all verification artifacts and ensure they are not staged**

Delete `verify-main.cjs`, `verify-drive.cjs`, `verify-codex-weekly-only.png`, and `verify-codex-two-window.png` using `Remove-Item -LiteralPath` after resolving each path inside the repository root.

Run:

```powershell
git status --short
```

Expected: no verification scripts, screenshots, build output, `dist`, `release`, `package-output`, or `node_modules` are staged or newly tracked.

- [ ] **Step 6: Review the final diff for scope and sensitive output**

Run:

```powershell
git diff HEAD~3 --check
git diff HEAD~3 --stat
rg -n -S "Authorization|Bearer |accessToken|cookie|JWT" src/providers/codex.ts tests/normalization.test.ts src/renderer/tabs/live.js tests/liveRenderer.test.ts src/icon/iconState.ts tests/iconState.test.ts
```

Expected: `git diff --check` is clean; only the planned provider, renderer, icon, and test files changed; the sensitive-string scan finds only pre-existing credential handling in `src/providers/codex.ts`, with no secrets or raw payload logging added.

- [ ] **Step 7: Record any final verification-only fix in a focused commit**

If verification required a source or test correction, stage only those planned files and commit:

```powershell
git add src/providers/codex.ts tests/normalization.test.ts src/renderer/tabs/live.js tests/liveRenderer.test.ts src/icon/iconState.ts tests/iconState.test.ts
git commit -m "test: finalize Codex weekly-only compatibility"
```

If no correction was required, do not create an empty commit.

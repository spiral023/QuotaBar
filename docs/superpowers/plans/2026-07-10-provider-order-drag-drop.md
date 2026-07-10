# Provider Order Drag-and-Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users reorder whole provider cards in the Live tab and immediately apply the persisted order to every tray surface.

**Architecture:** Add one normalized `providerOrder` setting and a small shared TypeScript ordering helper. Keep renderer Pointer Events behavior isolated in a plain-JavaScript controller, while `TrayController` consumes the same normalized order for icon bars, tooltip lines, and menu sections. Provider polling and `UsageStore` ordering remain unchanged.

**Tech Stack:** Electron 42, TypeScript 5.8, vanilla JavaScript/Pointer Events, CSS transforms, Vitest 4.

---

## File Map

- Create `src/providers/providerOrder.ts`: known provider order, normalization, and generic stable sorting.
- Create `src/renderer/shared/provider-order.js`: pure drag calculations plus Pointer Events controller.
- Create `tests/providerOrder.test.ts`: shared order/settings migration coverage.
- Create `tests/providerOrderRenderer.test.ts`: renderer helper, threshold, placement, commit, and rollback coverage.
- Modify `src/config/settings.ts`: persist and normalize `providerOrder`.
- Modify `src/icon/iconState.ts`: build ordered generic tray bars.
- Modify `src/icon/renderTrayIcon.ts`: render generic ordered bars rather than fixed provider fields.
- Modify `src/main/tray.ts`: hold the current order and apply it to icon, tooltip, and menu.
- Modify `src/main/detailsWindow.ts`: return normalized settings and notify main after saving.
- Modify `src/main/main.ts`: initialize and live-update the tray order.
- Modify `src/main/menu.ts`: receive providers already sorted by presentation order.
- Modify `src/renderer/index.html`: load the drag controller before the Live tab.
- Modify `src/renderer/tabs/live.js`: sort snapshots, tag cards, and attach persistence callbacks.
- Modify `src/renderer/styles.css`: drag, placeholder, cursor, and reduced-motion styles.
- Modify existing icon/settings/live tests where their public shapes change.

### Task 1: Shared Provider-Order Model and Settings Migration

**Files:**
- Create: `src/providers/providerOrder.ts`
- Create: `tests/providerOrder.test.ts`
- Modify: `src/config/settings.ts`
- Modify: `tests/settings.test.ts`

- [ ] **Step 1: Write failing normalization and stable-sort tests**

Create tests that require the default, reject unknown/duplicate values, append missing known providers, and sort without mutating input:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_ORDER,
  normalizeProviderOrder,
  sortByProviderOrder,
} from "../src/providers/providerOrder";

describe("provider order", () => {
  it("normalizes unknown, duplicate, and missing provider IDs", () => {
    expect(normalizeProviderOrder(["codex", "unknown", "codex"])).toEqual(["codex", "claude"]);
    expect(normalizeProviderOrder(undefined)).toEqual(DEFAULT_PROVIDER_ORDER);
  });

  it("sorts provider-bearing values without mutating the input", () => {
    const input = [{ provider: "claude" }, { provider: "codex" }];
    const result = sortByProviderOrder(input, ["codex", "claude"], item => item.provider);
    expect(result.map(item => item.provider)).toEqual(["codex", "claude"]);
    expect(input.map(item => item.provider)).toEqual(["claude", "codex"]);
  });
});
```

Add settings assertions:

```ts
expect(defaultSettings.providerOrder).toEqual(["claude", "codex"]);
expect(normalizeSettings({
  ...defaultSettings,
  providerOrder: ["codex", "invalid", "codex"],
}).providerOrder).toEqual(["codex", "claude"]);
```

- [ ] **Step 2: Run the tests and verify the missing API failure**

Run: `npx vitest run tests/providerOrder.test.ts tests/settings.test.ts`

Expected: FAIL because `providerOrder.ts` and `Settings.providerOrder` do not exist.

- [ ] **Step 3: Implement the minimal shared model**

Create `src/providers/providerOrder.ts`:

```ts
export const DEFAULT_PROVIDER_ORDER = ["claude", "codex"] as const;

export function normalizeProviderOrder(value: unknown): string[] {
  const known = new Set<string>(DEFAULT_PROVIDER_ORDER);
  const seen = new Set<string>();
  const result: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string" || !known.has(item) || seen.has(item)) continue;
      seen.add(item);
      result.push(item);
    }
  }
  for (const provider of DEFAULT_PROVIDER_ORDER) {
    if (!seen.has(provider)) result.push(provider);
  }
  return result;
}

export function sortByProviderOrder<T>(
  items: readonly T[],
  order: unknown,
  providerId: (item: T) => string,
): T[] {
  const rank = new Map(normalizeProviderOrder(order).map((id, index) => [id, index]));
  return [...items].sort((a, b) =>
    (rank.get(providerId(a)) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(providerId(b)) ?? Number.MAX_SAFE_INTEGER));
}
```

Add `providerOrder: string[]` to `Settings`, use `[...DEFAULT_PROVIDER_ORDER]` in `defaultSettings`, and return `normalizeProviderOrder(settings.providerOrder)` from `normalizeSettings`.

- [ ] **Step 4: Run focused tests and commit**

Run: `npx vitest run tests/providerOrder.test.ts tests/settings.test.ts tests/settingsLoad.test.ts`

Expected: PASS.

Commit:

```powershell
git add src/providers/providerOrder.ts src/config/settings.ts tests/providerOrder.test.ts tests/settings.test.ts
git commit -m "feat: persist provider display order"
```

### Task 2: Order-Aware Tray State, Tooltip, and Menu

**Files:**
- Modify: `src/icon/iconState.ts`
- Modify: `src/icon/renderTrayIcon.ts`
- Modify: `src/main/tray.ts`
- Modify: `tests/iconState.test.ts`
- Create: `tests/trayPresentation.test.ts`

- [ ] **Step 1: Write failing ordered icon-state and tooltip tests**

Update icon-state expectations to a generic ordered `bars` array and add:

```ts
const state = buildIconState([
  snap("claude", "ok", [{ name: "fiveHour", usedPercent: 50 }]),
  snap("codex", "ok", [{ name: "fiveHour", usedPercent: 75 }]),
], ["codex", "claude"]);

expect(state.bars.map(bar => bar.provider)).toEqual(["codex", "claude"]);
```

Export `buildTooltip` from `src/main/tray.ts` and assert:

```ts
expect(buildTooltip(snapshots, ["codex", "claude"]).split("\n")).toEqual([
  "QuotaBar",
  "Codex: 75%",
  "Claude: 50%",
]);
```

- [ ] **Step 2: Run tests and verify they fail on the fixed tray shape/order**

Run: `npx vitest run tests/iconState.test.ts tests/trayPresentation.test.ts`

Expected: FAIL because `TrayIconState` still has hard-coded `codex` and `claude` fields and `buildTooltip` is fixed/private.

- [ ] **Step 3: Implement generic ordered tray bars**

Change the render types to:

```ts
export interface BarData {
  provider: string;
  usedPercent?: number;
  isStale: boolean;
}

export interface TrayIconState {
  bars: BarData[];
  hasError: boolean;
}
```

Make `buildIconState(snapshots, providerOrder)` sort snapshots with `sortByProviderOrder`, filter to `ok`/`stale`, and map each usable snapshot to one `BarData`. In `renderTrayIcon`, derive the cache key from `state.bars` and use `const slots = state.bars`; initialize empty state as `{ bars: [], hasError: false }`.

In `TrayController`, add normalized state and the update method:

```ts
private providerOrder: string[];

setProviderOrder(order: unknown): void {
  this.providerOrder = normalizeProviderOrder(order);
  void this.update();
}
```

Pass `this.providerOrder` to icon-state and tooltip calls. Sort `this.providers` with `sortByProviderOrder(this.providers, this.providerOrder, provider => provider.id)` before calling `buildContextMenu`, making tray-menu sections follow the same order.

- [ ] **Step 4: Run focused tests and commit**

Run: `npx vitest run tests/iconState.test.ts tests/trayPresentation.test.ts`

Expected: PASS with explicit Codex-first and Claude-first cases.

Commit:

```powershell
git add src/icon/iconState.ts src/icon/renderTrayIcon.ts src/main/tray.ts tests/iconState.test.ts tests/trayPresentation.test.ts
git commit -m "feat: apply provider order to tray surfaces"
```

### Task 3: Save-to-Tray Propagation

**Files:**
- Modify: `src/main/detailsWindow.ts`
- Modify: `src/main/main.ts`
- Create: `tests/settingsSave.test.ts`

- [ ] **Step 1: Write a failing settings-save callback test**

Extract a small exported helper from `detailsWindow.ts` so IPC behavior is testable without constructing a browser window:

```ts
export async function mergeAndSaveSettings(
  partial: Record<string, unknown>,
  onSaved?: (settings: Settings, changedKeys: string[]) => void,
): Promise<Settings> {
  const current = await loadSettings();
  await saveSettings({ ...current, ...partial });
  const saved = await loadSettings();
  onSaved?.(saved, Object.keys(partial));
  return saved;
}
```

Mock settings storage and assert that saving `{ providerOrder: ["codex", "claude"] }` returns the normalized settings and invokes the callback once with `providerOrder` among the changed keys.

- [ ] **Step 2: Run the callback test and verify it fails**

Run: `npx vitest run tests/settingsSave.test.ts`

Expected: FAIL because `mergeAndSaveSettings` and the callback do not exist.

- [ ] **Step 3: Wire normalized saves to the tray**

Add an optional third constructor parameter to `DetailsWindowController`:

```ts
private readonly onSettingsSaved?: (settings: Settings, changedKeys: string[]) => void
```

Use `mergeAndSaveSettings` inside the `settings:save` handler, preserve proxy reconfiguration, clear caches, and return the normalized saved settings to the renderer.

Initialize the tray with `settings.providerOrder`. Construct the dashboard controller with a callback that calls `tray.setProviderOrder(saved.providerOrder)` only when `changedKeys.includes("providerOrder")`.

- [ ] **Step 4: Run focused tests and commit**

Run: `npx vitest run tests/settingsSave.test.ts tests/settings.test.ts tests/iconState.test.ts`

Expected: PASS.

Commit:

```powershell
git add src/main/detailsWindow.ts src/main/main.ts tests/settingsSave.test.ts
git commit -m "feat: update tray after provider reorder"
```

### Task 4: Pointer-Events Drag Controller

**Files:**
- Create: `src/renderer/shared/provider-order.js`
- Create: `tests/providerOrderRenderer.test.ts`
- Modify: `src/renderer/index.html`

- [ ] **Step 1: Write failing pure renderer-controller tests**

Load the script in a VM like `tests/liveRenderer.test.ts` and test the exposed helpers:

```ts
expect(api.hasPassedThreshold({ x: 10, y: 10 }, { x: 15, y: 12 })).toBe(false);
expect(api.hasPassedThreshold({ x: 10, y: 10 }, { x: 17, y: 10 })).toBe(true);
expect(api.insertionIndex([100, 200], 150)).toBe(1);

await expect(api.persistOrder(
  ["codex", "claude"],
  ["claude", "codex"],
  async next => ({ providerOrder: next }),
)).resolves.toEqual({ order: ["codex", "claude"], saved: true });

await expect(api.persistOrder(
  ["codex", "claude"],
  ["claude", "codex"],
  async () => { throw new Error("save failed"); },
)).resolves.toEqual({ order: ["claude", "codex"], saved: false });
```

- [ ] **Step 2: Run tests and verify the controller API is missing**

Run: `npx vitest run tests/providerOrderRenderer.test.ts`

Expected: FAIL because `src/renderer/shared/provider-order.js` does not exist.

- [ ] **Step 3: Implement calculations and the DOM controller**

Expose this API on `QB.providerOrderDrag`:

```js
function hasPassedThreshold(start, current, threshold = 6) {
  return Math.hypot(current.x - start.x, current.y - start.y) >= threshold;
}

function insertionIndex(midpoints, pointerY) {
  const index = midpoints.findIndex(midpoint => pointerY < midpoint);
  return index === -1 ? midpoints.length : index;
}

async function persistOrder(next, previous, save) {
  try {
    const result = await save(next);
    return { order: result?.providerOrder ?? next, saved: true };
  } catch {
    return { order: previous, saved: false };
  }
}
```

Implement `attach(container, { onCommit })` with one active pointer: record the starting position/order, begin after the threshold, replace the card with an equal-height placeholder, move the card to `document.body` with fixed geometry, place the placeholder by card midpoints, and commit on release. `Escape`, `pointercancel`, lost capture, and blur call the same cleanup path with the original order. Return a detach function that removes listeners and cancels an active drag.

Add the script before `tabs/live.js` in `index.html`:

```html
<script src="shared/provider-order.js"></script>
```

- [ ] **Step 4: Run renderer tests and commit**

Run: `npx vitest run tests/providerOrderRenderer.test.ts`

Expected: PASS.

Commit:

```powershell
git add src/renderer/shared/provider-order.js src/renderer/index.html tests/providerOrderRenderer.test.ts
git commit -m "feat: add provider card drag controller"
```

### Task 5: Live-Tab Integration and Visual States

**Files:**
- Modify: `src/renderer/tabs/live.js`
- Modify: `src/renderer/styles.css`
- Modify: `tests/liveRenderer.test.ts`

- [ ] **Step 1: Write failing Live ordering tests**

Expose `orderSnapshots` through `QB.__liveTest` and assert both healthy and auth-error cards are reordered:

```ts
const snapshots = [
  { provider: "claude", status: "ok", windows: [] },
  { provider: "codex", status: "not_authenticated", windows: [] },
];
expect(helpers.orderSnapshots(snapshots, ["codex", "claude"])
  .map(snapshot => snapshot.provider)).toEqual(["codex", "claude"]);
```

- [ ] **Step 2: Run the Live test and verify it fails**

Run: `npx vitest run tests/liveRenderer.test.ts`

Expected: FAIL because `orderSnapshots` is not exported or used.

- [ ] **Step 3: Sort, tag, attach, and persist**

Add `data-provider-card`, `data-provider`, `aria-roledescription="draggable provider card"`, and `tabindex="0"` to every card variant. Sort before mapping:

```js
function orderSnapshots(snapshots, order = QB.settings?.providerOrder) {
  const rank = new Map((Array.isArray(order) ? order : ['claude', 'codex'])
    .map((provider, index) => [provider, index]));
  return [...snapshots].sort((a, b) =>
    (rank.get(a.provider) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(b.provider) ?? Number.MAX_SAFE_INTEGER));
}
```

Detach the prior controller before replacing `content.innerHTML`, attach after rendering, and commit through:

```js
onCommit: async (nextOrder) => {
  const saved = await QB.ipc.invoke('settings:save', { providerOrder: nextOrder });
  QB.settings = { ...(QB.settings || {}), providerOrder: saved.providerOrder };
  return saved;
}
```

Keep window-budget hydration on the same sorted snapshot array so DOM lookup and animation sequence remain deterministic.

- [ ] **Step 4: Add drag visuals and reduced-motion behavior**

Add these drag-state styles:

```css
.provider-card { cursor: grab; touch-action: pan-y; }
.provider-card.is-dragging {
  cursor: grabbing;
  position: fixed;
  z-index: 10000;
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.42);
  transform: scale(1.015);
  user-select: none;
}
.provider-card-placeholder {
  border: 1px dashed var(--green);
  border-radius: var(--r-card);
  background: color-mix(in srgb, var(--green) 7%, transparent);
}
body.is-provider-dragging { cursor: grabbing; user-select: none; }

@media (prefers-reduced-motion: reduce) {
  .provider-card, .provider-card-placeholder { transition: none; }
}
```

- [ ] **Step 5: Run focused renderer tests and commit**

Run: `npx vitest run tests/liveRenderer.test.ts tests/providerOrderRenderer.test.ts`

Expected: PASS.

Commit:

```powershell
git add src/renderer/tabs/live.js src/renderer/styles.css tests/liveRenderer.test.ts
git commit -m "feat: reorder live provider cards by drag"
```

### Task 6: Full Verification and Real Electron QA

**Files:**
- No source changes planned; any failure returns to the task that owns the affected behavior.

- [ ] **Step 1: Run lint and all automated tests**

Run:

```powershell
npm run lint
npm test
```

Expected: both commands exit 0; no failed tests.

- [ ] **Step 2: Build the TypeScript application**

Run: `npm run build`

Expected: TypeScript exits 0 and updates `dist/` without compiler errors.

- [ ] **Step 3: Follow the real-window verification procedure**

Read `TESTING.md`, launch the development Electron app, and verify:

1. Drag Codex above Claude by grabbing the body of the Codex card.
2. Confirm a click without six pixels of movement does not reorder.
3. Confirm expandable card controls still work.
4. Confirm the top tray bar now represents Codex and the tooltip/menu list Codex first.
5. Drag Claude back above Codex and confirm all tray surfaces update immediately.
6. Close and reopen the dashboard/app and confirm the saved order remains.
7. Verify an auth/error-state card remains draggable if such a state is available; otherwise confirm via the renderer test fixture.
8. Press `Escape` during a drag and confirm the original order is restored.

- [ ] **Step 4: Inspect the final diff and repository state**

Run:

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only intentional source/test changes and ignored build output.

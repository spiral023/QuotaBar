# Window Intelligence — 5h/7d Quota Visibility

**Date:** 2026-06-02  
**Status:** Approved

## Problem

The current Live-Tab shows raw percentage and a time-progress marker. Users can't answer the most important question: *"Wann werde ich blockiert?"* They see 62% but don't know whether they have 3 hours or 20 minutes of capacity left.

Real data confirms the 5h window is the binding constraint: it hit 100% twice in the last 7 days (2026-05-26 and 2026-06-01). The weekly window was never critical.

## Solution Overview

Three new signals, all derived from existing snapshot data, displayed in the Live-Tab card per provider window. All work for both Claude and Codex.

- **A) 5h ETA** — extend the existing `computeLinearPace` to the fiveHour window
- **B) Burn Rate** — rolling %/h from a lightweight in-memory snapshot buffer
- **C) Safety Gap** — single signed number: seconds until limit minus seconds until reset

Tooltips explain every derived number so users understand the math.

---

## Backend Architecture

### A — 5h Window Pace (1-line fix)

[refreshLoop.ts:63](../../../src/usage/refreshLoop.ts) currently gates pace computation behind `window.name === "weekly"`. Change to:

```typescript
if (window.name === "weekly" || window.name === "fiveHour") {
  window.pace = computeLinearPace(toRateWindow(window), now);
}
```

`computeLinearPace` already handles any window size correctly via `windowMinutes`. This immediately gives `etaSeconds` and `willLastToReset` on the 5h window.

### B — Burn Rate Tracker

New file: `src/usage/burnRateTracker.ts`

- **Data:** `Map<"${provider}:${windowName}", SnapshotPoint[]>` — max 8 points per key
- **Record:** called each refresh cycle with `(provider, windowName, usedPercent, timestamp)`
- **Compute:** linear regression over the most recent 5 contiguous points (reset-detected when % drops by >15pp — window cycle boundary). Returns `%/h`, positive = consuming quota.
- **Minimum data:** needs ≥3 points with ≥2min span, else returns `null`
- **Lifetime:** in-memory only, lives in `RefreshLoop` instance. Resets on app restart. That's fine — it rehydrates within 3 poll intervals.

`RefreshLoop` holds one `BurnRateTracker` instance. After pace computation, records each window and attaches `burnRatePctPerHour` to the window.

### C — Safety Gap

New pure function in `src/usage/usagePace.ts`:

```typescript
export function computeSafetyGap(
  resetsAt: string,
  pace: UsagePace,
  now: Date
): number | null
```

Logic:
```
timeToReset = (resetsAt - now) in seconds
if pace.willLastToReset  → return timeToReset   (large positive, safe)
if pace.etaSeconds ≠ null → return timeToReset - pace.etaSeconds
else                       → return null
```

Interpretation:
- `> 0` — quota outlasts the reset by this many seconds (safe)
- `< 0` — quota runs out this many seconds *before* the reset (user gets blocked)
- `null` — not enough data yet

Called from `refreshLoop.ts` immediately after pace is computed.

### Type Extensions

`UsageWindow` gets two optional fields:

```typescript
burnRatePctPerHour?: number | null   // %/h, null if insufficient data
safetyGapSeconds?:  number | null    // signed seconds, null if unknown
```

No breaking changes — both optional, defaults to undefined (treated as null in renderer).

---

## Frontend Design

### Aesthetic Direction

"System monitor" — dense, precise, monospace numerals for derived metrics, color-coded glow on the Safety Gap badge. Existing dark theme and CSS variables are preserved. Changes are additive.

### Card Layout (per provider)

```
[Logo] Provider Name                           72%

5-HOUR                            Reset in 1h 23m
[████████████████░░░░░░░] ↑ time-marker
⚠ −38min bis Limit  ·  +14 %/h               ← NEW ROW

WEEKLY                            Reset in 2d 4h
[████░░░░░░░░░░░░░░░░░░░] ↑ time-marker
Far Behind  ·  17.6× Abo

▸ Token Details                               ← COLLAPSIBLE
  Input 217k  Out 4.8M  Cache+ 25M  C▷ 591M
  Total 621M  ·  $351.89
```

### Safety Gap Badge

Displayed below the 5h bar. Hidden when `safetyGapSeconds` is null.

| Condition | Display text | CSS class |
|---|---|---|
| `> 1800s` (>30min safe) | *(kein Badge — Stille = kein Stress)* | — |
| `1–1800s` (1s–30min Puffer) | `⚡ Noch ~22min Puffer` | `gap-warn` |
| `≤ 0` (Limit vor Reset) | `⚠ −38min · Limit vor Reset` | `gap-critical` |

`gap-critical` gets a subtle `box-shadow` pulse animation (CSS keyframes, no JS).

Existing `willLastToReset` condition (from weekly pace): shown as badge `Reicht bis Reset` — unchanged.

### Burn Rate

Inline after the Safety Gap badge: `+14 %/h` in monospace.  
Only rendered when `burnRatePctPerHour !== null`. Sign always shown. Muted color — secondary information.

### Tooltips

Every derived number gets a `title` attribute explaining the formula:

| Element | Tooltip text |
|---|---|
| Safety Gap (negative) | `Aktuelles Tempo: +14%/h. Fenster voll in ~38min. Reset erst in 1h 16min → 38min Deficit.` |
| Safety Gap (positive) | `Aktuelles Tempo: +14%/h. Fenster reicht bis Reset und noch ~22min darüber hinaus.` |
| Burn Rate `+14 %/h` | `Durchschnittliche Verbrauchsrate aus den letzten 3 Messungen. Basis: Δ% ÷ Δt.` |
| 5h ETA (from pace) | `Hochrechnung: falls Tempo konstant bleibt, wird das Fenster in ~38min voll sein.` |

Tooltips use the existing `data-tip` / `title` pattern already used on the ROI badge.

### Collapsible Token Details

**Toggle button:** replaces the current always-visible token section header. Arrow `▸`/`▾` rotates 90° on open.

**Animation:** CSS `max-height` transition from `0` to `200px` (covers the tallest plausible grid). No JS layout recalc.

**Persistence:** `localStorage.getItem('tokenDetailsOpen')` — boolean. Default: `false` (collapsed). Survives reload.

**DOM structure:**
```html
<div class="token-collapse" id="tc-claude">
  <button class="token-toggle" aria-expanded="false" aria-controls="tc-claude-body">
    <svg class="toggle-chevron">…</svg>
    Token Details
  </button>
  <div class="token-body" id="tc-claude-body" hidden>
    <!-- existing token-grid unchanged -->
  </div>
</div>
```

`hidden` attribute removed via JS on open (for accessibility). CSS transition handles visual animation.

---

## Files Changed

| File | Change type |
|---|---|
| `src/providers/types.ts` | Add `burnRatePctPerHour`, `safetyGapSeconds` to `UsageWindow` |
| `src/usage/usagePace.ts` | Add `computeSafetyGap()` export |
| `src/usage/burnRateTracker.ts` | **New file** — `BurnRateTracker` class |
| `src/usage/refreshLoop.ts` | Activate 5h pace, integrate BurnRateTracker, call computeSafetyGap |
| `src/renderer/tabs/live.js` | New render functions, collapsible token section |
| CSS (in renderer) | New classes: `.safety-gap`, `.gap-warn`, `.gap-critical`, `.burn-rate`, `.token-collapse`, `.token-toggle`, `.token-body`, `.toggle-chevron` |

---

## Out of Scope

- Historical burn-rate baseline ("above your p95") — future analytics addition
- Codex token-level JSONL analysis — not available for Codex
- Weekly window Safety Gap — not shown (weekly window is never the constraint in observed data; keep UI clean)
- Persistent burn-rate history across app restarts

---

## Open Questions

None — all resolved during design.

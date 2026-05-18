# Pace-Berechnung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lineare Pace-Berechnung für das `weekly`-Fenster jedes Providers implementieren und im Tray-Menü anzeigen.

**Architecture:** Pure-function `computeLinearPace` in `src/usage/usagePace.ts` mit `RateWindow`-Adapter. Pace wird nach jedem Fetch in `refreshLoop.ts` an das `weekly`-Window angehängt. `menu.ts` liest das fertige Ergebnis und rendert eine eingerückte Pace-Zeile. `types.ts` bekommt ein optionales `pace`-Feld auf `UsageWindow`.

**Tech Stack:** TypeScript, Electron, Vitest

---

## File Map

| Datei | Typ | Verantwortung |
|---|---|---|
| `src/usage/usagePace.ts` | NEU | Types, Adapter, Berechnungslogik |
| `tests/usagePace.test.ts` | NEU | 7 Testfälle für computeLinearPace |
| `src/providers/types.ts` | ÄNDERUNG | `pace?: UsagePace \| null` zu `UsageWindow` |
| `src/usage/refreshLoop.ts` | ÄNDERUNG | Pace nach Fetch anhängen |
| `src/main/menu.ts` | ÄNDERUNG | Pace-Zeile im Menü rendern |

---

## Task 1: usagePace.ts — Types + Berechnungslogik (TDD)

**Files:**
- Create: `tests/usagePace.test.ts`
- Create: `src/usage/usagePace.ts`

- [ ] **Step 1: Testdatei anlegen (noch ohne Implementation — erwartet Importfehler)**

Erstelle `tests/usagePace.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { computeLinearPace, RateWindow } from "../src/usage/usagePace";

const SEVEN_DAYS_S = 7 * 24 * 3600;
const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeWindow(
  elapsedFraction: number,
  usedPercent: number,
  windowMinutes = 10080
): RateWindow {
  const duration = windowMinutes * 60;
  const elapsed = duration * elapsedFraction;
  const timeUntilReset = duration - elapsed;
  const resetsAt = new Date(NOW.getTime() + timeUntilReset * 1000);
  return { usedPercent, windowMinutes, resetsAt };
}

describe("computeLinearPace", () => {
  it("onTrack: elapsed=50%, actual=50% → delta≈0, willLastToReset=true", () => {
    const result = computeLinearPace(makeWindow(0.5, 50), NOW);
    expect(result).not.toBeNull();
    expect(result!.stage).toBe("onTrack");
    expect(result!.deltaPercent).toBeCloseTo(0, 1);
    expect(result!.willLastToReset).toBe(true);
    expect(result!.etaSeconds).toBeNull();
  });

  it("farAhead: elapsed=30%, actual=45% → delta=+15, stage=farAhead", () => {
    const result = computeLinearPace(makeWindow(0.3, 45), NOW);
    expect(result).not.toBeNull();
    expect(result!.stage).toBe("farAhead");
    expect(result!.deltaPercent).toBeCloseTo(15, 1);
  });

  it("high burn: elapsed=50%, actual=80% → etaSeconds gesetzt, willLastToReset=false", () => {
    const result = computeLinearPace(makeWindow(0.5, 80), NOW);
    expect(result).not.toBeNull();
    expect(result!.etaSeconds).not.toBeNull();
    expect(result!.willLastToReset).toBe(false);
    // candidate = (20 / (80/302400)) ≈ 75600s ≈ 21h, kleiner als timeUntilReset (302400s)
    expect(result!.etaSeconds!).toBeCloseTo(75600, -2);
  });

  it("null wenn resetsAt=null", () => {
    const w: RateWindow = { usedPercent: 50, windowMinutes: 10080, resetsAt: null };
    expect(computeLinearPace(w, NOW)).toBeNull();
  });

  it("elapsed>0, actual=0 → willLastToReset=true, kein ETA", () => {
    const result = computeLinearPace(makeWindow(0.5, 0), NOW);
    expect(result).not.toBeNull();
    expect(result!.willLastToReset).toBe(true);
    expect(result!.etaSeconds).toBeNull();
  });

  it("elapsed=0, actual>0 → null (ungültiger Zustand)", () => {
    // resetsAt genau duration von jetzt → elapsed=0
    const resetsAt = new Date(NOW.getTime() + SEVEN_DAYS_S * 1000);
    const w: RateWindow = { usedPercent: 10, windowMinutes: 10080, resetsAt };
    expect(computeLinearPace(w, NOW)).toBeNull();
  });

  it("timeUntilReset > duration → null", () => {
    const resetsAt = new Date(NOW.getTime() + (SEVEN_DAYS_S + 1) * 1000);
    const w: RateWindow = { usedPercent: 50, windowMinutes: 10080, resetsAt };
    expect(computeLinearPace(w, NOW)).toBeNull();
  });
});
```

- [ ] **Step 2: Tests ausführen — erwartet Fehler (Modul nicht gefunden)**

```
npm test -- --reporter=verbose tests/usagePace.test.ts
```

Erwartet: `Error: Cannot find module '../src/usage/usagePace'`

- [ ] **Step 3: `src/usage/usagePace.ts` implementieren**

Erstelle `src/usage/usagePace.ts`:

```typescript
export type PaceStage =
  | "onTrack"
  | "slightlyAhead"
  | "ahead"
  | "farAhead"
  | "slightlyBehind"
  | "behind"
  | "farBehind";

export interface UsagePace {
  stage: PaceStage;
  deltaPercent: number;
  expectedUsedPercent: number;
  actualUsedPercent: number;
  etaSeconds: number | null;
  willLastToReset: boolean;
}

export interface RateWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: Date | null;
}

export function toRateWindow(w: {
  usedPercent?: number;
  windowSeconds?: number;
  resetsAt?: string;
}): RateWindow {
  return {
    usedPercent: w.usedPercent ?? 0,
    windowMinutes: w.windowSeconds != null ? w.windowSeconds / 60 : null,
    resetsAt: w.resetsAt ? new Date(w.resetsAt) : null,
  };
}

export function computeLinearPace(
  window: RateWindow,
  now: Date = new Date()
): UsagePace | null {
  if (!window.resetsAt) return null;
  const windowMinutes = window.windowMinutes ?? 10080;
  if (windowMinutes <= 0) return null;

  const duration = windowMinutes * 60;
  const timeUntilReset = (window.resetsAt.getTime() - now.getTime()) / 1000;

  if (timeUntilReset <= 0) return null;
  if (timeUntilReset > duration) return null;

  const elapsed = clamp(duration - timeUntilReset, 0, duration);
  const expected = clamp((elapsed / duration) * 100, 0, 100);
  const actual = clamp(window.usedPercent, 0, 100);

  if (elapsed === 0 && actual > 0) return null;

  const delta = actual - expected;
  const stage = stageFor(delta);

  let etaSeconds: number | null = null;
  let willLastToReset = false;

  if (elapsed > 0 && actual > 0) {
    const rate = actual / elapsed;
    if (rate > 0) {
      const remaining = Math.max(0, 100 - actual);
      const candidate = remaining / rate;
      if (candidate >= timeUntilReset) {
        willLastToReset = true;
      } else {
        etaSeconds = candidate;
      }
    }
  } else if (elapsed > 0 && actual === 0) {
    willLastToReset = true;
  }

  return {
    stage,
    deltaPercent: delta,
    expectedUsedPercent: expected,
    actualUsedPercent: actual,
    etaSeconds,
    willLastToReset,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function stageFor(delta: number): PaceStage {
  const abs = Math.abs(delta);
  if (abs <= 2) return "onTrack";
  if (abs <= 6) return delta >= 0 ? "slightlyAhead" : "slightlyBehind";
  if (abs <= 12) return delta >= 0 ? "ahead" : "behind";
  return delta >= 0 ? "farAhead" : "farBehind";
}
```

- [ ] **Step 4: Tests ausführen — alle 7 müssen grün sein**

```
npm test -- --reporter=verbose tests/usagePace.test.ts
```

Erwartet: `7 passed`

- [ ] **Step 5: Commit**

```
git add src/usage/usagePace.ts tests/usagePace.test.ts
git commit -m "feat: add computeLinearPace with RateWindow adapter"
```

---

## Task 2: types.ts — pace-Feld zu UsageWindow hinzufügen

**Files:**
- Modify: `src/providers/types.ts`

- [ ] **Step 1: Import + Feld hinzufügen**

Ändere `src/providers/types.ts` — füge den Import oben ein und `pace` zum Interface:

```typescript
import type { UsagePace } from "../usage/usagePace";

export interface UsageWindow {
  name: "session" | "fiveHour" | "weekly" | "monthly" | "credits";
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string;
  windowSeconds?: number;
  label?: string;
  pace?: UsagePace | null;   // linear pace, only populated for weekly windows
}
```

- [ ] **Step 2: TypeScript-Build prüfen**

```
npm run build
```

Erwartet: keine Fehler

- [ ] **Step 3: Commit**

```
git add src/providers/types.ts
git commit -m "feat: add pace field to UsageWindow"
```

---

## Task 3: refreshLoop.ts — Pace nach Fetch anhängen

**Files:**
- Modify: `src/usage/refreshLoop.ts:1,42-44`

- [ ] **Step 1: Import und Pace-Attachment hinzufügen**

Ändere `src/usage/refreshLoop.ts`:

Import-Zeile oben hinzufügen (nach den bestehenden Imports):

```typescript
import { computeLinearPace, toRateWindow } from "./usagePace";
```

In `refreshNow()` die Zeile `const merged = this.store.update(snapshots);` ERSETZEN durch:

```typescript
const now = new Date();
for (const snapshot of snapshots) {
  for (const window of snapshot.windows) {
    if (window.name === "weekly") {
      window.pace = computeLinearPace(toRateWindow(window), now);
    }
  }
}
const merged = this.store.update(snapshots);
```

- [ ] **Step 2: TypeScript-Build prüfen**

```
npm run build
```

Erwartet: keine Fehler

- [ ] **Step 3: Alle bestehenden Tests noch grün**

```
npm test
```

Erwartet: alle Tests bestehen

- [ ] **Step 4: Commit**

```
git add src/usage/refreshLoop.ts
git commit -m "feat: attach linear pace to weekly windows after fetch"
```

---

## Task 4: menu.ts — Pace-Zeile rendern

**Files:**
- Modify: `src/main/menu.ts`

- [ ] **Step 1: Import und formatPaceLine-Funktion hinzufügen**

Ändere `src/main/menu.ts`:

Import-Zeile oben ergänzen:

```typescript
import { PaceStage, UsagePace } from "../usage/usagePace";
```

Neue Hilfsfunktion am Ende der Datei (nach `titleCase`) hinzufügen:

```typescript
function formatPaceLine(pace: UsagePace): string {
  const STAGE_LABELS: Record<PaceStage, string> = {
    onTrack: "On track",
    slightlyAhead: "Slightly ahead",
    ahead: "Ahead",
    farAhead: "Far ahead",
    slightlyBehind: "Slightly behind",
    behind: "Behind",
    farBehind: "Far behind",
  };
  const label = STAGE_LABELS[pace.stage];
  const delta =
    pace.stage !== "onTrack"
      ? ` (${pace.deltaPercent >= 0 ? "+" : "−"}${Math.round(Math.abs(pace.deltaPercent))}%)`
      : "";
  const eta = pace.willLastToReset
    ? " · Lasts to reset"
    : pace.etaSeconds != null
      ? ` · Runs out in ${formatTimeRemaining(new Date(Date.now() + pace.etaSeconds * 1000))}`
      : "";
  return `  Pace: ${label}${delta}${eta}`;
}
```

- [ ] **Step 2: snapshotToMenuLines auf flatMap umstellen**

In `snapshotToMenuLines`, die `.map(...)` auf `.flatMap(...)` umstellen und die Pace-Zeile einbauen.

Ersetze diesen Block in `snapshotToMenuLines`:

```typescript
const lines = snapshot.windows.length > 0
  ? snapshot.windows.map((window, index) => {
    const label = index === 0 ? displayName : window.name === "weekly" ? "Weekly" : window.label ?? titleCase(window.name);
    const usage = typeof window.usedPercent === "number" ? `${Math.round(window.usedPercent)}%` : window.label ?? "unknown";
    const reset = window.resetsAt ? ` (resets in ${formatTimeRemaining(window.resetsAt)})` : "";
    return `${label}: ${usage}${reset}`;
  })
  : [`${displayName}: ${snapshot.status}`];
```

durch:

```typescript
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
```

- [ ] **Step 3: Build + alle Tests**

```
npm run build && npm test
```

Erwartet: Build erfolgreich, alle Tests grün

- [ ] **Step 4: Commit**

```
git add src/main/menu.ts
git commit -m "feat: show pace line in tray menu for weekly windows"
```

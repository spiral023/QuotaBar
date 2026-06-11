# 5h-Fenster-Budget & Weekly-Prognose — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** QuotaBar zeigt pro Provider, wie viele volle 5h-Fenster in ein Weekly-Fenster passen — mit Kennzahlen (verbraucht/übrig), Budget-Leiste, Verlaufsgraph und Prognose, wann das Weekly-Limit erreicht wird.

**Architecture:** Ein persistierter `WindowRatioTracker` lernt bei jedem Poll-Zyklus das Verhältnis ΔWeekly%/Δ5h% (Hybrid: einmalig aus vorhandenen Debug-Logs geseedet). Kennzahlen werden im `RefreshLoop` an jeden `UsageSnapshot` gehängt. Graph-Serie und Prognose (Wochenprofil → linear → Burn-Rate) berechnet der bestehende `analyticsWorker` on demand über einen neuen IPC-Kanal `windowBudget:get`.

**Tech Stack:** TypeScript (strict, CommonJS), Electron, Vitest, Chart.js (vendored `assets/vendor/chart.min.js`), Vanilla-JS-Renderer (`src/renderer/`).

**Spec:** `docs/superpowers/specs/2026-06-11-window-budget-design.md`

**Konventionen:** Tests laufen mit `npx vitest run <datei>`. Build-Check: `npm run build`. Commits nach jedem grünen Task. Kommentare im Code auf Deutsch oder Englisch passend zur umgebenden Datei.

---

### Task 1: `windowRatio.ts` — purer Akkumulator + Tracker

**Files:**
- Create: `src/usage/windowRatio.ts`
- Test: `tests/windowRatio.test.ts`

- [ ] **Step 1.1: Failing Test schreiben**

```ts
// tests/windowRatio.test.ts
import { describe, expect, it } from "vitest";
import {
  computeBudget,
  clearTransients,
  emptyProviderState,
  emptyRatioFile,
  recordObservation,
  WindowRatioTracker,
  MIN_SAMPLE_FIVE_PCT,
  DECAY_CAP_FIVE_PCT,
  type ProviderRatioState,
} from "../src/usage/windowRatio";

function feed(state: ProviderRatioState, pairs: Array<[number, number]>, resetsAt = "2026-06-08T10:00:00Z"): ProviderRatioState {
  let s = state;
  for (const [five, weekly] of pairs) {
    s = recordObservation(s, { fivePct: five, weeklyPct: weekly, fiveResetsAt: resetsAt });
  }
  return s;
}

describe("recordObservation", () => {
  it("akkumuliert ko-okkurrierende positive Deltas", () => {
    const s = feed(emptyProviderState(), [[0, 0], [10, 3], [25, 8]]);
    expect(s.sumFivePct).toBe(25);
    expect(s.sumWeeklyPct).toBe(8);
    expect(s.pairCount).toBe(2);
  });

  it("verwirft Paare mit Δ5h ≤ 0 (Reset oder idle)", () => {
    const s = feed(emptyProviderState(), [[50, 10], [50, 10], [5, 12]]);
    expect(s.sumFivePct).toBe(0);
    expect(s.pairCount).toBe(0);
    // last-Werte sind trotzdem aktualisiert
    expect(s.lastFive).toBe(5);
  });

  it("verwirft Paare mit ΔWeekly < 0 (Weekly-Reset)", () => {
    const s = feed(emptyProviderState(), [[10, 90], [20, 2]]);
    expect(s.sumFivePct).toBe(0);
  });

  it("verwirft Paare bei geändertem fiveHour-resetsAt (Rollover)", () => {
    let s = recordObservation(emptyProviderState(), { fivePct: 80, weeklyPct: 50, fiveResetsAt: "2026-06-08T10:00:00Z" });
    s = recordObservation(s, { fivePct: 90, weeklyPct: 55, fiveResetsAt: "2026-06-08T15:00:00Z" });
    expect(s.sumFivePct).toBe(0);
    expect(s.lastFiveResetsAt).toBe("2026-06-08T15:00:00Z");
  });

  it("akzeptiert Paare ohne resetsAt (Claude liefert es teils nicht)", () => {
    let s = recordObservation(emptyProviderState(), { fivePct: 10, weeklyPct: 5 });
    s = recordObservation(s, { fivePct: 20, weeklyPct: 8 });
    expect(s.sumFivePct).toBe(10);
    expect(s.sumWeeklyPct).toBe(3);
  });

  it("verwirft Paare bei gesättigtem Weekly (≥ 99,5 %)", () => {
    const s = feed(emptyProviderState(), [[10, 100], [30, 100]]);
    expect(s.sumFivePct).toBe(0);
  });

  it("setzt den State bei planType-Wechsel zurück", () => {
    let s = recordObservation(emptyProviderState(), { fivePct: 0, weeklyPct: 0, planType: "pro" });
    s = recordObservation(s, { fivePct: 50, weeklyPct: 20, planType: "pro" });
    expect(s.sumFivePct).toBe(50);
    s = recordObservation(s, { fivePct: 60, weeklyPct: 22, planType: "max" });
    expect(s.sumFivePct).toBe(0);
    expect(s.lastPlanType).toBe("max");
  });

  it("halbiert beide Summen oberhalb des Decay-Deckels", () => {
    let s = emptyProviderState();
    s = { ...s, sumFivePct: DECAY_CAP_FIVE_PCT - 10, sumWeeklyPct: 900, lastFive: 0, lastWeekly: 0 };
    s = recordObservation(s, { fivePct: 50, weeklyPct: 15 });
    expect(s.sumFivePct).toBeCloseTo((DECAY_CAP_FIVE_PCT - 10 + 50) / 2);
    expect(s.sumWeeklyPct).toBeCloseTo(915 / 2);
  });
});

describe("computeBudget", () => {
  it("meldet learning unterhalb der Mindest-Stichprobe", () => {
    const s = { ...emptyProviderState(), sumFivePct: MIN_SAMPLE_FIVE_PCT - 1, sumWeeklyPct: 50 };
    const b = computeBudget(s, 40);
    expect(b.learning).toBe(true);
    if (b.learning) expect(b.sampleFivePct).toBe(MIN_SAMPLE_FIVE_PCT - 1);
  });

  it("meldet learning bei undefined State", () => {
    expect(computeBudget(undefined, 40).learning).toBe(true);
  });

  it("berechnet Fenster pro Woche, verbraucht und übrig", () => {
    // 900 % 5h-Nutzung erzeugten 300 % Weekly → 3 Fenster pro Woche
    const s = { ...emptyProviderState(), sumFivePct: 900, sumWeeklyPct: 300 };
    const b = computeBudget(s, 62);
    expect(b.learning).toBe(false);
    if (!b.learning) {
      expect(b.windowsPerWeek).toBeCloseTo(3);
      expect(b.usedWindows).toBeCloseTo(1.86);
      expect(b.remainingWindows).toBeCloseTo(1.14);
    }
  });

  it("klemmt remainingWindows bei Weekly > 100 % auf 0", () => {
    const s = { ...emptyProviderState(), sumFivePct: 900, sumWeeklyPct: 300 };
    const b = computeBudget(s, 110);
    if (!b.learning) expect(b.remainingWindows).toBe(0);
  });
});

describe("clearTransients", () => {
  it("löscht last-Werte, behält Summen und planType", () => {
    const file = emptyRatioFile();
    file.providers.claude = { ...emptyProviderState(), sumFivePct: 500, sumWeeklyPct: 160, lastFive: 80, lastWeekly: 30, lastFiveResetsAt: "x", lastPlanType: "pro" };
    const out = clearTransients(file);
    expect(out.providers.claude.lastFive).toBeNull();
    expect(out.providers.claude.lastWeekly).toBeNull();
    expect(out.providers.claude.lastFiveResetsAt).toBeNull();
    expect(out.providers.claude.sumFivePct).toBe(500);
    expect(out.providers.claude.lastPlanType).toBe("pro");
  });
});

describe("WindowRatioTracker", () => {
  it("record + getBudget über die Klassen-API", () => {
    const t = new WindowRatioTracker();
    t.record("codex", { fivePct: 0, weeklyPct: 0 });
    t.record("codex", { fivePct: 100, weeklyPct: 14 });
    t.record("codex", { fivePct: 0, weeklyPct: 14 });   // 5h-Reset → verworfen
    t.record("codex", { fivePct: 100, weeklyPct: 28 });
    const b = t.getBudget("codex", 28);
    expect(b.learning).toBe(false);
    if (!b.learning) expect(b.windowsPerWeek).toBeCloseTo(200 / 28);
  });

  it("mergeSeed addiert Summen und setzt seededThrough", () => {
    const t = new WindowRatioTracker();
    t.record("claude", { fivePct: 0, weeklyPct: 0 });
    t.record("claude", { fivePct: 50, weeklyPct: 16 });
    const seed = emptyRatioFile();
    seed.providers.claude = { ...emptyProviderState(), sumFivePct: 850, sumWeeklyPct: 284, pairCount: 99 };
    seed.seededThrough = "2026-06-10";
    t.mergeSeed(seed);
    expect(t.getFile().providers.claude.sumFivePct).toBe(900);
    expect(t.getFile().providers.claude.sumWeeklyPct).toBe(300);
    expect(t.getFile().seededThrough).toBe("2026-06-10");
  });
});
```

- [ ] **Step 1.2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run tests/windowRatio.test.ts`
Expected: FAIL — `Cannot find module '../src/usage/windowRatio'`

- [ ] **Step 1.3: Implementierung**

```ts
// src/usage/windowRatio.ts
export interface ProviderRatioState {
  sumFivePct: number;
  sumWeeklyPct: number;
  pairCount: number;
  lastFive: number | null;
  lastWeekly: number | null;
  lastFiveResetsAt: string | null;
  lastPlanType: string | null;
}

export interface WindowRatioFile {
  version: 1;
  seededThrough: string | null;
  providers: Record<string, ProviderRatioState>;
}

/** Mindestens zwei volle 5h-Fenster an Beobachtung, bevor das Verhältnis als belastbar gilt. */
export const MIN_SAMPLE_FIVE_PCT = 200;
/** Schutz gegen Division durch ~0 bei extremer Ganzzahl-Rundung des Weekly-Werts. */
export const MIN_SAMPLE_WEEKLY_PCT = 5;
/** Exponentielles Vergessen: oberhalb dieses Deckels werden beide Summen halbiert. */
export const DECAY_CAP_FIVE_PCT = 3000;
export const WEEKLY_SATURATION_PCT = 99.5;

export function emptyProviderState(): ProviderRatioState {
  return {
    sumFivePct: 0,
    sumWeeklyPct: 0,
    pairCount: 0,
    lastFive: null,
    lastWeekly: null,
    lastFiveResetsAt: null,
    lastPlanType: null,
  };
}

export function emptyRatioFile(): WindowRatioFile {
  return { version: 1, seededThrough: null, providers: {} };
}

export interface RatioObservation {
  fivePct: number;
  weeklyPct: number;
  fiveResetsAt?: string | null;
  planType?: string | null;
}

/**
 * Verarbeitet eine Beobachtung (ein Snapshot) und liefert den neuen State.
 * Ein "Paar" sind zwei aufeinanderfolgende Beobachtungen; nur Paare mit
 * ko-okkurrierendem Wachstum beider Fenster fließen in die Summen ein.
 */
export function recordObservation(state: ProviderRatioState, obs: RatioObservation): ProviderRatioState {
  let s = state;
  if (obs.planType != null && s.lastPlanType != null && obs.planType !== s.lastPlanType) {
    s = emptyProviderState();
  }
  const next: ProviderRatioState = { ...s };
  if (s.lastFive !== null && s.lastWeekly !== null) {
    const dFive = obs.fivePct - s.lastFive;
    const dWeekly = obs.weeklyPct - s.lastWeekly;
    const rollover = s.lastFiveResetsAt != null && obs.fiveResetsAt != null && obs.fiveResetsAt !== s.lastFiveResetsAt;
    const saturated = s.lastWeekly >= WEEKLY_SATURATION_PCT;
    if (dFive > 0 && dWeekly >= 0 && !rollover && !saturated) {
      next.sumFivePct = s.sumFivePct + dFive;
      next.sumWeeklyPct = s.sumWeeklyPct + dWeekly;
      next.pairCount = s.pairCount + 1;
      if (next.sumFivePct > DECAY_CAP_FIVE_PCT) {
        next.sumFivePct /= 2;
        next.sumWeeklyPct /= 2;
      }
    }
  }
  next.lastFive = obs.fivePct;
  next.lastWeekly = obs.weeklyPct;
  next.lastFiveResetsAt = obs.fiveResetsAt ?? null;
  next.lastPlanType = obs.planType ?? s.lastPlanType;
  return next;
}

export interface WindowBudget {
  learning: false;
  windowsPerWeek: number;
  usedWindows: number;
  remainingWindows: number;
  sampleFivePct: number;
}

export interface WindowBudgetLearning {
  learning: true;
  sampleFivePct: number;
}

export type WindowBudgetInfo = WindowBudget | WindowBudgetLearning;

export function computeBudget(state: ProviderRatioState | undefined, weeklyUsedPercent: number): WindowBudgetInfo {
  if (!state || state.sumFivePct < MIN_SAMPLE_FIVE_PCT || state.sumWeeklyPct < MIN_SAMPLE_WEEKLY_PCT) {
    return { learning: true, sampleFivePct: state?.sumFivePct ?? 0 };
  }
  const windowsPerWeek = state.sumFivePct / state.sumWeeklyPct;
  const usedWindows = (weeklyUsedPercent / 100) * windowsPerWeek;
  return {
    learning: false,
    windowsPerWeek,
    usedWindows,
    remainingWindows: Math.max(0, windowsPerWeek - usedWindows),
    sampleFivePct: state.sumFivePct,
  };
}

/**
 * Löscht die last-Werte aller Provider. Beim App-Start aufrufen: ein Paar
 * über eine App-Pause hinweg (Stunden/Tage) wäre wertlos bis irreführend.
 * lastPlanType bleibt erhalten, damit ein Plan-Wechsel während der Pause
 * trotzdem erkannt wird.
 */
export function clearTransients(file: WindowRatioFile): WindowRatioFile {
  const providers: Record<string, ProviderRatioState> = {};
  for (const [name, s] of Object.entries(file.providers)) {
    providers[name] = { ...s, lastFive: null, lastWeekly: null, lastFiveResetsAt: null };
  }
  return { ...file, providers };
}

export class WindowRatioTracker {
  constructor(private file: WindowRatioFile = emptyRatioFile()) {}

  record(provider: string, obs: RatioObservation): void {
    const prev = this.file.providers[provider] ?? emptyProviderState();
    this.file.providers[provider] = recordObservation(prev, obs);
  }

  getBudget(provider: string, weeklyUsedPercent: number): WindowBudgetInfo {
    return computeBudget(this.file.providers[provider], weeklyUsedPercent);
  }

  /** Addiert Seed-Summen (aus Debug-Logs) auf den bestehenden State. */
  mergeSeed(seed: WindowRatioFile): void {
    for (const [provider, s] of Object.entries(seed.providers)) {
      const cur = this.file.providers[provider] ?? emptyProviderState();
      this.file.providers[provider] = {
        ...cur,
        sumFivePct: cur.sumFivePct + s.sumFivePct,
        sumWeeklyPct: cur.sumWeeklyPct + s.sumWeeklyPct,
        pairCount: cur.pairCount + s.pairCount,
      };
    }
    this.file.seededThrough = seed.seededThrough;
  }

  getFile(): WindowRatioFile {
    return this.file;
  }
}
```

- [ ] **Step 1.4: Test laufen lassen — muss grün sein**

Run: `npx vitest run tests/windowRatio.test.ts`
Expected: PASS (alle Tests)

- [ ] **Step 1.5: Commit**

```bash
git add src/usage/windowRatio.ts tests/windowRatio.test.ts
git commit -m "feat: add window ratio accumulator for 5h-to-weekly budget"
```

---

### Task 2: Persistenz — `windowRatioStore.ts` + Pfad

**Files:**
- Create: `src/usage/windowRatioStore.ts`
- Modify: `src/config/paths.ts` (nach `getUsageSnapshotCachePath`, ~Zeile 37)
- Test: `tests/windowRatioStore.test.ts`

- [ ] **Step 2.1: Failing Test schreiben**

```ts
// tests/windowRatioStore.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyProviderState, emptyRatioFile } from "../src/usage/windowRatio";
import { loadWindowRatioFile, saveWindowRatioFile } from "../src/usage/windowRatioStore";

describe("windowRatioStore", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-ratio-"));
    file = path.join(dir, "sub", "window-ratio.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("Roundtrip: save → load liefert identische Daten", async () => {
    const data = emptyRatioFile();
    data.seededThrough = "2026-06-10";
    data.providers.claude = { ...emptyProviderState(), sumFivePct: 900, sumWeeklyPct: 300, pairCount: 42 };
    await saveWindowRatioFile(file, data);
    const loaded = await loadWindowRatioFile(file);
    expect(loaded).toEqual(data);
  });

  it("liefert leeren State bei fehlender Datei", async () => {
    const loaded = await loadWindowRatioFile(path.join(dir, "missing.json"));
    expect(loaded).toEqual(emptyRatioFile());
  });

  it("liefert leeren State bei defekter Datei", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{ kaputt", "utf8");
    const loaded = await loadWindowRatioFile(file);
    expect(loaded).toEqual(emptyRatioFile());
  });

  it("liefert leeren State bei falscher Struktur", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 99, foo: true }), "utf8");
    const loaded = await loadWindowRatioFile(file);
    expect(loaded).toEqual(emptyRatioFile());
  });
});
```

- [ ] **Step 2.2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run tests/windowRatioStore.test.ts`
Expected: FAIL — `Cannot find module '../src/usage/windowRatioStore'`

- [ ] **Step 2.3: Implementierung**

```ts
// src/usage/windowRatioStore.ts
import fs from "node:fs/promises";
import path from "node:path";
import { emptyRatioFile, type ProviderRatioState, type WindowRatioFile } from "./windowRatio";

export async function loadWindowRatioFile(filePath: string): Promise<WindowRatioFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!isWindowRatioFile(parsed)) return emptyRatioFile();
    return parsed;
  } catch {
    return emptyRatioFile();
  }
}

export async function saveWindowRatioFile(filePath: string, file: WindowRatioFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

function isWindowRatioFile(value: unknown): value is WindowRatioFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (r.version !== 1) return false;
  if (r.seededThrough !== null && typeof r.seededThrough !== "string") return false;
  if (!r.providers || typeof r.providers !== "object" || Array.isArray(r.providers)) return false;
  return Object.values(r.providers as Record<string, unknown>).every(isProviderState);
}

function isProviderState(value: unknown): value is ProviderRatioState {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r.sumFivePct === "number"
    && typeof r.sumWeeklyPct === "number"
    && typeof r.pairCount === "number";
}
```

In `src/config/paths.ts` direkt nach `getUsageSnapshotCachePath()` einfügen:

```ts
export function getWindowRatioPath(): string {
  return path.join(getAppConfigDir(), "window-ratio.json");
}
```

- [ ] **Step 2.4: Tests laufen lassen — muss grün sein**

Run: `npx vitest run tests/windowRatioStore.test.ts tests/paths.test.ts`
Expected: PASS

- [ ] **Step 2.5: Commit**

```bash
git add src/usage/windowRatioStore.ts src/config/paths.ts tests/windowRatioStore.test.ts
git commit -m "feat: persist window ratio state to window-ratio.json"
```

---

### Task 3: Seeder aus Debug-Logs

**Files:**
- Create: `src/main/windowRatioSeeder.ts`
- Test: `tests/windowRatioSeeder.test.ts`

- [ ] **Step 3.1: Failing Test schreiben**

```ts
// tests/windowRatioSeeder.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedFromDebugLogs } from "../src/main/windowRatioSeeder";

function snapLine(provider: string, fivePct: number, weeklyPct: number, ts: string, fiveResetsAt?: string): string {
  const windows = [
    { name: "fiveHour", usedPercent: fivePct, windowSeconds: 18000, ...(fiveResetsAt ? { resetsAt: fiveResetsAt } : {}) },
    { name: "weekly", usedPercent: weeklyPct, windowSeconds: 604800 },
  ];
  return JSON.stringify({ ts, kind: "snapshot", provider, status: "ok", windows, fetchedAt: ts });
}

describe("seedFromDebugLogs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-seed-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("akkumuliert Snapshot-Paare über mehrere Tagesdateien", async () => {
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("codex", 0, 0, "2026-06-09T08:00:00Z"),
      snapLine("codex", 40, 6, "2026-06-09T09:00:00Z"),
      `{"ts":"2026-06-09T09:01:00Z","kind":"refresh.start","providers":["codex"],"trigger":"interval"}`,
      "nicht-json-zeile",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(dir, "2026-06-10.jsonl"), [
      snapLine("codex", 60, 9, "2026-06-10T08:00:00Z"),
    ].join("\n"), "utf8");

    const seed = await seedFromDebugLogs(dir);
    // Paare: (0→40, 0→6) und (40→60, 6→9) — Dateigrenzen sind egal
    expect(seed.providers.codex.sumFivePct).toBe(60);
    expect(seed.providers.codex.sumWeeklyPct).toBe(9);
    expect(seed.seededThrough).toBe("2026-06-10");
    // Transienten sind nach dem Seed gelöscht
    expect(seed.providers.codex.lastFive).toBeNull();
  });

  it("ignoriert .backfill.jsonl-Dateien und fremde Events", async () => {
    await fs.writeFile(path.join(dir, "2026-06-09.backfill.jsonl"),
      snapLine("codex", 0, 0, "2026-06-09T08:00:00Z"), "utf8");
    const seed = await seedFromDebugLogs(dir);
    expect(seed.providers.codex).toBeUndefined();
    expect(seed.seededThrough).toBeNull();
  });

  it("trennt Provider sauber", async () => {
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 0, 0, "2026-06-09T08:00:00Z"),
      snapLine("codex", 10, 1, "2026-06-09T08:00:01Z"),
      snapLine("claude", 30, 10, "2026-06-09T09:00:00Z"),
      snapLine("codex", 20, 2, "2026-06-09T09:00:01Z"),
    ].join("\n"), "utf8");
    const seed = await seedFromDebugLogs(dir);
    expect(seed.providers.claude.sumFivePct).toBe(30);
    expect(seed.providers.claude.sumWeeklyPct).toBe(10);
    expect(seed.providers.codex.sumFivePct).toBe(10);
    expect(seed.providers.codex.sumWeeklyPct).toBe(1);
  });

  it("liefert leeres Ergebnis bei fehlendem Verzeichnis", async () => {
    const seed = await seedFromDebugLogs(path.join(dir, "gibtsnicht"));
    expect(seed.providers).toEqual({});
    expect(seed.seededThrough).toBeNull();
  });
});
```

- [ ] **Step 3.2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run tests/windowRatioSeeder.test.ts`
Expected: FAIL — `Cannot find module '../src/main/windowRatioSeeder'`

- [ ] **Step 3.3: Implementierung**

```ts
// src/main/windowRatioSeeder.ts
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  clearTransients,
  emptyProviderState,
  emptyRatioFile,
  recordObservation,
  type WindowRatioFile,
} from "../usage/windowRatio";

const LIVE_LOG_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * Einmal-Seed: liest alle Live-Debug-Logs (Snapshot-Events) chronologisch und
 * füttert denselben Akkumulator wie der Live-Tracker. Backfill-Dateien
 * enthalten keine Snapshot-Events und werden ignoriert.
 */
export async function seedFromDebugLogs(logDir: string): Promise<WindowRatioFile> {
  const result = emptyRatioFile();
  let entries: string[];
  try {
    entries = await fs.readdir(logDir);
  } catch {
    return result;
  }
  const files = entries
    .map((e) => LIVE_LOG_RE.exec(e))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => a[1].localeCompare(b[1]));

  for (const match of files) {
    await seedFile(path.join(logDir, match[0]), result);
    result.seededThrough = match[1];
  }
  return clearTransients(result);
}

async function seedFile(filePath: string, result: WindowRatioFile): Promise<void> {
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('"kind":"snapshot"')) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.kind !== "snapshot" || event.status !== "ok") continue;
      const provider = typeof event.provider === "string" ? event.provider : null;
      if (!provider) continue;
      const windows = Array.isArray(event.windows) ? (event.windows as Array<Record<string, unknown>>) : [];
      const five = windows.find((w) => w.name === "fiveHour");
      const weekly = windows.find((w) => w.name === "weekly");
      if (typeof five?.usedPercent !== "number" || typeof weekly?.usedPercent !== "number") continue;
      const prev = result.providers[provider] ?? emptyProviderState();
      result.providers[provider] = recordObservation(prev, {
        fivePct: five.usedPercent,
        weeklyPct: weekly.usedPercent,
        fiveResetsAt: typeof five.resetsAt === "string" ? five.resetsAt : null,
        planType: typeof event.planType === "string" ? event.planType : null,
      });
    }
  } catch {
    // Datei nicht lesbar — überspringen
  }
}
```

- [ ] **Step 3.4: Test laufen lassen — muss grün sein**

Run: `npx vitest run tests/windowRatioSeeder.test.ts`
Expected: PASS

- [ ] **Step 3.5: Commit**

```bash
git add src/main/windowRatioSeeder.ts tests/windowRatioSeeder.test.ts
git commit -m "feat: seed window ratio tracker from existing debug logs"
```

---

### Task 4: Integration — RefreshLoop, Snapshot-Typ, main.ts

**Files:**
- Modify: `src/providers/types.ts` (UsageSnapshot, ~Zeile 46)
- Modify: `src/usage/refreshLoop.ts` (Konstruktor ~Zeile 26, refreshNow ~Zeile 93)
- Modify: `src/main/main.ts` (Imports + Wiring ~Zeile 63 und onRefresh-Listener ~Zeile 87)
- Test: `tests/refreshLoop.test.ts` (neue describe-Gruppe anhängen)

- [ ] **Step 4.1: Failing Test schreiben** — in `tests/refreshLoop.test.ts` am Dateiende anhängen:

```ts
import { WindowRatioTracker, emptyRatioFile, emptyProviderState } from "../src/usage/windowRatio";

describe("RefreshLoop windowBudget", () => {
  function snapWithWindows(provider: string, fivePct: number, weeklyPct: number): UsageSnapshot {
    return {
      provider,
      status: "ok",
      windows: [
        { name: "fiveHour", usedPercent: fivePct, windowSeconds: 18000 },
        { name: "weekly", usedPercent: weeklyPct, windowSeconds: 604800 },
      ],
      updatedAt: new Date().toISOString(),
    };
  }

  it("füttert den Tracker und hängt windowBudget an den Snapshot", async () => {
    const store = new UsageStore();
    const file = emptyRatioFile();
    file.providers.claude = { ...emptyProviderState(), sumFivePct: 900, sumWeeklyPct: 300 };
    const tracker = new WindowRatioTracker(file);
    const provider = makeProvider("claude", async () => snapWithWindows("claude", 30, 62));
    const loop = new RefreshLoop([provider], store, 60, 10_000, undefined, undefined, tracker);

    const [snap] = await loop.refreshNow();
    expect(snap.windowBudget).toBeDefined();
    expect(snap.windowBudget?.learning).toBe(false);
    if (snap.windowBudget && !snap.windowBudget.learning) {
      expect(snap.windowBudget.windowsPerWeek).toBeCloseTo(3);
      expect(snap.windowBudget.usedWindows).toBeCloseTo(1.86);
    }
  });

  it("hängt kein windowBudget an, wenn das Weekly-Fenster fehlt", async () => {
    const store = new UsageStore();
    const tracker = new WindowRatioTracker();
    const provider = makeProvider("claude", async () => okSnap("claude"));
    const loop = new RefreshLoop([provider], store, 60, 10_000, undefined, undefined, tracker);

    const [snap] = await loop.refreshNow();
    expect(snap.windowBudget).toBeUndefined();
  });
});
```

- [ ] **Step 4.2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run tests/refreshLoop.test.ts`
Expected: FAIL — RefreshLoop akzeptiert kein 7. Argument / `windowBudget` ist undefined

- [ ] **Step 4.3: Typ erweitern** — in `src/providers/types.ts`:

Import oben ergänzen:

```ts
import type { WindowBudgetInfo } from "../usage/windowRatio";
```

In `UsageSnapshot` nach `costFactor?: CostFactorResult;` ergänzen:

```ts
  windowBudget?: WindowBudgetInfo;
```

- [ ] **Step 4.4: RefreshLoop erweitern** — in `src/usage/refreshLoop.ts`:

Import ergänzen:

```ts
import type { WindowRatioTracker } from "./windowRatio";
```

Konstruktor-Parameter ergänzen (nach `recorder`):

```ts
    private readonly recorder?: DebugRecorder,
    private readonly windowRatioTracker?: WindowRatioTracker
```

In `refreshNow`, innerhalb von `for (const snapshot of snapshots) { ... }`, direkt nach der inneren Fenster-Schleife (nach Zeile `}` der `for (const window of snapshot.windows)`-Schleife) einfügen:

```ts
        if (this.windowRatioTracker && snapshot.status === "ok") {
          const five = snapshot.windows.find((w) => w.name === "fiveHour");
          const weekly = snapshot.windows.find((w) => w.name === "weekly");
          if (typeof five?.usedPercent === "number" && typeof weekly?.usedPercent === "number") {
            this.windowRatioTracker.record(snapshot.provider, {
              fivePct: five.usedPercent,
              weeklyPct: weekly.usedPercent,
              fiveResetsAt: five.resetsAt ?? null,
              planType: snapshot.planType ?? null,
            });
            snapshot.windowBudget = this.windowRatioTracker.getBudget(snapshot.provider, weekly.usedPercent);
          }
        }
```

- [ ] **Step 4.5: Test laufen lassen — muss grün sein**

Run: `npx vitest run tests/refreshLoop.test.ts`
Expected: PASS

- [ ] **Step 4.6: main.ts verdrahten** — in `src/main/main.ts`:

Imports ergänzen:

```ts
import { WindowRatioTracker, clearTransients } from "../usage/windowRatio";
import { loadWindowRatioFile, saveWindowRatioFile } from "../usage/windowRatioStore";
import { seedFromDebugLogs } from "./windowRatioSeeder";
```

`getWindowRatioPath` in den bestehenden paths-Import (Zeile 17) aufnehmen.

Vor der `RefreshLoop`-Erzeugung (Zeile 63) einfügen:

```ts
      const windowRatioPath = getWindowRatioPath();
      const ratioFile = await loadWindowRatioFile(windowRatioPath);
      const windowRatioTracker = new WindowRatioTracker(clearTransients(ratioFile));
      if (!ratioFile.seededThrough) {
        // Einmal-Seed aus vorhandenen Debug-Logs — bewusst nicht awaited,
        // damit der App-Start nicht auf das Log-Parsing wartet.
        void seedFromDebugLogs(getDebugLogDir())
          .then((seed) => {
            windowRatioTracker.mergeSeed(seed);
            return saveWindowRatioFile(windowRatioPath, windowRatioTracker.getFile());
          })
          .catch((err: unknown) => {
            log.warn(`Window-ratio seed failed: ${err instanceof Error ? err.message : String(err)}`);
          });
      }
```

`RefreshLoop`-Erzeugung um den Tracker erweitern:

```ts
      const refreshLoop = new RefreshLoop(providers, store, settings.pollIntervalSeconds, settings.providerTimeoutMs, pricingEngine, recorder, windowRatioTracker);
```

Im bestehenden `refreshLoop.onRefresh(...)`-Listener (Zeile 87) nach dem `saveCachedSnapshots`-Aufruf ergänzen:

```ts
        void saveWindowRatioFile(windowRatioPath, windowRatioTracker.getFile()).catch((err: unknown) => {
          log.warn(`Window-ratio save failed: ${err instanceof Error ? err.message : String(err)}`);
        });
```

- [ ] **Step 4.7: Build + alle Tests**

Run: `npm run build && npx vitest run`
Expected: Build ohne Fehler, alle Tests PASS

- [ ] **Step 4.8: Commit**

```bash
git add src/providers/types.ts src/usage/refreshLoop.ts src/main/main.ts tests/refreshLoop.test.ts
git commit -m "feat: wire window ratio tracker into refresh loop and app startup"
```

---

### Task 5: Prognose — `weeklyForecast.ts`

**Files:**
- Create: `src/main/weeklyForecast.ts`
- Test: `tests/weeklyForecast.test.ts`

- [ ] **Step 5.1: Failing Test schreiben**

```ts
// tests/weeklyForecast.test.ts
import { describe, expect, it } from "vitest";
import { buildWeeklyProfile, computeWeeklyForecast, type WeeklyProfile } from "../src/main/weeklyForecast";
import type { BackfillDayRecord } from "../src/reports/types";

function day(date: string, provider: "claude" | "codex", totalTokens: number): BackfillDayRecord {
  return {
    date, provider, totalTokens,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    costUSD: 0, sessionCount: 1, models: [], perModel: {},
  };
}

// 2026-06-11 ist ein Donnerstag
const NOW = new Date("2026-06-11T12:00:00.000Z");

describe("buildWeeklyProfile", () => {
  it("mittelt Token pro Wochentag über 28 Tage", () => {
    const records = [
      day("2026-06-08", "claude", 4_000_000), // Montag
      day("2026-06-01", "claude", 2_000_000), // Montag (Vorwoche)
      day("2026-06-09", "claude", 1_000_000), // Dienstag
      day("2026-06-10", "codex", 9_000_000),  // anderer Provider — ignorieren
      day("2026-04-01", "claude", 9_000_000), // älter als 28 Tage — ignorieren
    ];
    const p = buildWeeklyProfile(records, "claude", NOW);
    // Montag: (4M + 2M) / 4 Vorkommen in 28 Tagen
    expect(p.avgTokensPerWeekday[1]).toBeCloseTo(1_500_000);
    expect(p.avgTokensPerWeekday[2]).toBeCloseTo(250_000);
    expect(p.avgTokensPerWeekday[3]).toBe(0);
    expect(p.weeksOfData).toBe(2);
  });
});

describe("computeWeeklyForecast", () => {
  const flatProfile: WeeklyProfile = {
    // jeden Tag gleich viel → Profil-Prognose verhält sich linear
    avgTokensPerWeekday: new Array(7).fill(2_400_000),
    weeksOfData: 4,
  };

  it("Profil-Prognose: findet den 100%-Schnittpunkt", () => {
    // 50 % verbraucht bei 12M Token → 1 % je 240k Token.
    // Profil: 2,4M/Tag = 100k/h → 100k × (1/240k) ≈ 0,4167 %/h.
    // Fehlende 50 % → 120 h. Reset erst in 144 h → Schnittpunkt existiert.
    const fc = computeWeeklyForecast({
      weeklyUsedPercent: 50,
      weeklyResetsAt: new Date(NOW.getTime() + 144 * 3600_000).toISOString(),
      tokensInCurrentWindow: 12_000_000,
      burnRatePctPerHour: null,
      pace: null,
      profile: flatProfile,
      now: NOW,
    });
    expect(fc.primaryKind).toBe("profile");
    expect(fc.primaryLastsUntilReset).toBe(false);
    const hours = (new Date(fc.primaryAt!).getTime() - NOW.getTime()) / 3600_000;
    expect(hours).toBeGreaterThan(115);
    expect(hours).toBeLessThan(125);
  });

  it("Profil-Prognose: reicht bis zum Reset, wenn 100 % nicht erreicht wird", () => {
    const fc = computeWeeklyForecast({
      weeklyUsedPercent: 10,
      weeklyResetsAt: new Date(NOW.getTime() + 24 * 3600_000).toISOString(),
      tokensInCurrentWindow: 12_000_000,
      burnRatePctPerHour: null,
      pace: null,
      profile: flatProfile,
      now: NOW,
    });
    expect(fc.primaryLastsUntilReset).toBe(true);
    expect(fc.primaryAt).toBeNull();
  });

  it("fällt auf linear (pace) zurück, wenn das Profil zu dünn ist", () => {
    const fc = computeWeeklyForecast({
      weeklyUsedPercent: 60,
      weeklyResetsAt: new Date(NOW.getTime() + 48 * 3600_000).toISOString(),
      tokensInCurrentWindow: 12_000_000,
      burnRatePctPerHour: null,
      pace: {
        stage: "ahead", deltaPercent: 10, expectedUsedPercent: 50, actualUsedPercent: 60,
        etaSeconds: 36_000, willLastToReset: false,
      },
      profile: { avgTokensPerWeekday: new Array(7).fill(0), weeksOfData: 1 },
      now: NOW,
    });
    expect(fc.primaryKind).toBe("linear");
    expect(fc.primaryAt).toBe(new Date(NOW.getTime() + 36_000_000).toISOString());
  });

  it("linear: willLastToReset wird durchgereicht", () => {
    const fc = computeWeeklyForecast({
      weeklyUsedPercent: 20,
      weeklyResetsAt: new Date(NOW.getTime() + 48 * 3600_000).toISOString(),
      tokensInCurrentWindow: 0,
      burnRatePctPerHour: null,
      pace: {
        stage: "onTrack", deltaPercent: 0, expectedUsedPercent: 20, actualUsedPercent: 20,
        etaSeconds: null, willLastToReset: true,
      },
      profile: { avgTokensPerWeekday: new Array(7).fill(0), weeksOfData: 0 },
      now: NOW,
    });
    expect(fc.primaryKind).toBe("linear");
    expect(fc.primaryLastsUntilReset).toBe(true);
  });

  it("Burn-Rate-Prognose: Termin vor dem Reset", () => {
    const fc = computeWeeklyForecast({
      weeklyUsedPercent: 80,
      weeklyResetsAt: new Date(NOW.getTime() + 100 * 3600_000).toISOString(),
      tokensInCurrentWindow: 0,
      burnRatePctPerHour: 2, // 20 % fehlen → 10 h
      pace: null,
      profile: { avgTokensPerWeekday: new Array(7).fill(0), weeksOfData: 0 },
      now: NOW,
    });
    expect(fc.burnRateAt).toBe(new Date(NOW.getTime() + 10 * 3600_000).toISOString());
    expect(fc.burnRateLastsUntilReset).toBe(false);
  });

  it("Burn-Rate 0 %/h → reicht bis zum Reset", () => {
    const fc = computeWeeklyForecast({
      weeklyUsedPercent: 80,
      weeklyResetsAt: new Date(NOW.getTime() + 100 * 3600_000).toISOString(),
      tokensInCurrentWindow: 0,
      burnRatePctPerHour: 0,
      pace: null,
      profile: { avgTokensPerWeekday: new Array(7).fill(0), weeksOfData: 0 },
      now: NOW,
    });
    expect(fc.burnRateAt).toBeNull();
    expect(fc.burnRateLastsUntilReset).toBe(true);
  });

  it("Burn-Rate null → keine Sekundär-Prognose", () => {
    const fc = computeWeeklyForecast({
      weeklyUsedPercent: 80,
      weeklyResetsAt: null,
      tokensInCurrentWindow: 0,
      burnRatePctPerHour: null,
      pace: null,
      profile: { avgTokensPerWeekday: new Array(7).fill(0), weeksOfData: 0 },
      now: NOW,
    });
    expect(fc.burnRateLastsUntilReset).toBeNull();
    expect(fc.primaryAt).toBeNull();
  });
});
```

- [ ] **Step 5.2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run tests/weeklyForecast.test.ts`
Expected: FAIL — `Cannot find module '../src/main/weeklyForecast'`

- [ ] **Step 5.3: Implementierung**

```ts
// src/main/weeklyForecast.ts
import type { UsagePace } from "../usage/usagePace";
import type { BackfillDayRecord } from "../reports/types";

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const PROFILE_DAYS = 28;
const MIN_PROFILE_WEEKS = 2;

export interface WeeklyProfile {
  /** Index 0 = Sonntag … 6 = Samstag (Date.getUTCDay) */
  avgTokensPerWeekday: number[];
  weeksOfData: number;
}

/**
 * Typische Token-Menge pro Wochentag aus den Backfill-Tagessummen der
 * letzten 28 Tage. 28 Tage ≙ jeder Wochentag kommt genau 4× vor, daher
 * ist der Divisor konstant 4 (Tage ohne Nutzung zählen als 0).
 */
export function buildWeeklyProfile(records: BackfillDayRecord[], provider: "claude" | "codex", now: Date): WeeklyProfile {
  const sinceMs = now.getTime() - PROFILE_DAYS * DAY_MS;
  const totals = new Array<number>(7).fill(0);
  const weeks = new Set<number>();
  for (const r of records) {
    if (r.provider !== provider) continue;
    const dayMs = new Date(`${r.date}T00:00:00.000Z`).getTime();
    if (Number.isNaN(dayMs) || dayMs < sinceMs || dayMs > now.getTime()) continue;
    totals[new Date(dayMs).getUTCDay()] += r.totalTokens;
    weeks.add(Math.floor(dayMs / (7 * DAY_MS)));
  }
  return {
    avgTokensPerWeekday: totals.map((t) => t / 4),
    weeksOfData: weeks.size,
  };
}

export interface WeeklyForecastInput {
  weeklyUsedPercent: number;
  weeklyResetsAt: string | null;
  /** Token-Summe des Providers innerhalb des aktuellen Weekly-Fensters (Tagesgranularität). */
  tokensInCurrentWindow: number;
  burnRatePctPerHour: number | null;
  pace: UsagePace | null;
  profile: WeeklyProfile;
  now: Date;
}

export interface WeeklyForecastResult {
  primaryAt: string | null;
  primaryKind: "profile" | "linear";
  primaryLastsUntilReset: boolean;
  burnRateAt: string | null;
  /** null = keine Burn-Rate verfügbar */
  burnRateLastsUntilReset: boolean | null;
}

export function computeWeeklyForecast(input: WeeklyForecastInput): WeeklyForecastResult {
  const nowMs = input.now.getTime();
  const resetMs = input.weeklyResetsAt ? new Date(input.weeklyResetsAt).getTime() : null;

  // Sekundär: aktuelle Burn-Rate, linear hochgerechnet
  let burnRateAt: string | null = null;
  let burnRateLastsUntilReset: boolean | null = null;
  if (input.burnRatePctPerHour !== null) {
    if (input.burnRatePctPerHour > 0 && input.weeklyUsedPercent < 100) {
      const atMs = nowMs + ((100 - input.weeklyUsedPercent) / input.burnRatePctPerHour) * HOUR_MS;
      if (resetMs !== null && atMs >= resetMs) {
        burnRateLastsUntilReset = true;
      } else {
        burnRateAt = new Date(atMs).toISOString();
        burnRateLastsUntilReset = false;
      }
    } else {
      burnRateLastsUntilReset = true;
    }
  }

  // Primär: Wochenprofil — stündliche Simulation bis zum Reset
  const profileUsable = input.profile.weeksOfData >= MIN_PROFILE_WEEKS
    && input.tokensInCurrentWindow > 0
    && input.weeklyUsedPercent > 0
    && input.weeklyUsedPercent < 100
    && resetMs !== null
    && input.profile.avgTokensPerWeekday.some((t) => t > 0);
  if (profileUsable) {
    const pctPerToken = input.weeklyUsedPercent / input.tokensInCurrentWindow;
    let pct = input.weeklyUsedPercent;
    for (let t = nowMs; t < resetMs!; t += HOUR_MS) {
      pct += pctPerToken * (input.profile.avgTokensPerWeekday[new Date(t).getUTCDay()] / 24);
      if (pct >= 100) {
        return {
          primaryAt: new Date(t + HOUR_MS).toISOString(),
          primaryKind: "profile",
          primaryLastsUntilReset: false,
          burnRateAt,
          burnRateLastsUntilReset,
        };
      }
    }
    return { primaryAt: null, primaryKind: "profile", primaryLastsUntilReset: true, burnRateAt, burnRateLastsUntilReset };
  }

  // Fallback: lineare Pace (Wochen-Durchschnitt seit Fensterbeginn)
  if (input.pace) {
    if (input.pace.willLastToReset || input.pace.etaSeconds === null) {
      return { primaryAt: null, primaryKind: "linear", primaryLastsUntilReset: true, burnRateAt, burnRateLastsUntilReset };
    }
    return {
      primaryAt: new Date(nowMs + input.pace.etaSeconds * 1000).toISOString(),
      primaryKind: "linear",
      primaryLastsUntilReset: false,
      burnRateAt,
      burnRateLastsUntilReset,
    };
  }
  return { primaryAt: null, primaryKind: "linear", primaryLastsUntilReset: false, burnRateAt, burnRateLastsUntilReset };
}
```

- [ ] **Step 5.4: Test laufen lassen — muss grün sein**

Run: `npx vitest run tests/weeklyForecast.test.ts`
Expected: PASS

- [ ] **Step 5.5: Commit**

```bash
git add src/main/weeklyForecast.ts tests/weeklyForecast.test.ts
git commit -m "feat: add weekly forecast with profile, linear and burn-rate projections"
```

---

### Task 6: Graph-Serie — `windowBudgetSeries.ts`

**Files:**
- Create: `src/main/windowBudgetSeries.ts`
- Test: `tests/windowBudgetSeries.test.ts`

- [ ] **Step 6.1: Failing Test schreiben**

```ts
// tests/windowBudgetSeries.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readWeeklySeries } from "../src/main/windowBudgetSeries";

function snapLine(provider: string, fivePct: number, weeklyPct: number, ts: string, fiveResetsAt?: string): string {
  const windows = [
    { name: "fiveHour", usedPercent: fivePct, windowSeconds: 18000, ...(fiveResetsAt ? { resetsAt: fiveResetsAt } : {}) },
    { name: "weekly", usedPercent: weeklyPct, windowSeconds: 604800 },
  ];
  return JSON.stringify({ ts, kind: "snapshot", provider, status: "ok", windows, fetchedAt: ts });
}

describe("readWeeklySeries", () => {
  let dir: string;
  const START = new Date("2026-06-09T00:00:00.000Z").getTime();
  const NOW = new Date("2026-06-11T00:00:00.000Z").getTime();

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-series-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("bucketet Weekly-Werte auf 30-Minuten-Raster (letzter Wert gewinnt)", async () => {
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 5, 10, "2026-06-09T08:01:00Z"),
      snapLine("claude", 6, 11, "2026-06-09T08:15:00Z"),  // gleicher Bucket → überschreibt
      snapLine("claude", 8, 14, "2026-06-09T08:40:00Z"),  // nächster Bucket
      snapLine("codex", 50, 50, "2026-06-09T08:20:00Z"),   // anderer Provider
    ].join("\n"), "utf8");

    const s = await readWeeklySeries(dir, "claude", START, NOW);
    expect(s.points).toHaveLength(2);
    expect(s.points[0].weeklyPct).toBe(11);
    expect(s.points[1].weeklyPct).toBe(14);
    expect(new Date(s.points[0].t).getTime()).toBe(new Date("2026-06-09T08:00:00Z").getTime());
  });

  it("ignoriert Snapshots außerhalb des Zeitfensters", async () => {
    await fs.writeFile(path.join(dir, "2026-06-08.jsonl"),
      snapLine("claude", 5, 10, "2026-06-08T08:00:00Z"), "utf8");
    const s = await readWeeklySeries(dir, "claude", START, NOW);
    expect(s.points).toHaveLength(0);
  });

  it("erkennt 5h-Resets über resetsAt-Wechsel", async () => {
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 80, 30, "2026-06-09T09:00:00Z", "2026-06-09T10:00:00Z"),
      snapLine("claude", 81, 31, "2026-06-09T09:30:00Z", "2026-06-09T10:00:00Z"),
      snapLine("claude", 2, 31, "2026-06-09T10:30:00Z", "2026-06-09T15:30:00Z"),
    ].join("\n"), "utf8");
    const s = await readWeeklySeries(dir, "claude", START, NOW);
    expect(s.fiveHourResets).toEqual(["2026-06-09T10:30:00Z"]);
  });

  it("erkennt 5h-Resets über Prozent-Einbruch, wenn resetsAt fehlt", async () => {
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 80, 30, "2026-06-09T09:00:00Z"),
      snapLine("claude", 2, 30, "2026-06-09T10:30:00Z"),
    ].join("\n"), "utf8");
    const s = await readWeeklySeries(dir, "claude", START, NOW);
    expect(s.fiveHourResets).toEqual(["2026-06-09T10:30:00Z"]);
  });

  it("liefert leere Serie bei fehlendem Verzeichnis", async () => {
    const s = await readWeeklySeries(path.join(dir, "nix"), "claude", START, NOW);
    expect(s.points).toEqual([]);
    expect(s.fiveHourResets).toEqual([]);
  });
});
```

- [ ] **Step 6.2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run tests/windowBudgetSeries.test.ts`
Expected: FAIL — `Cannot find module '../src/main/windowBudgetSeries'`

- [ ] **Step 6.3: Implementierung**

```ts
// src/main/windowBudgetSeries.ts
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const LIVE_LOG_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const RESET_DROP_PCT = 15;

export interface WeeklySeriesPoint {
  t: string;
  weeklyPct: number;
}

export interface WindowBudgetSeries {
  points: WeeklySeriesPoint[];
  fiveHourResets: string[];
}

/**
 * Liest die Weekly-Auslastung eines Providers aus den Live-Debug-Logs als
 * Zeitreihe (gebuckted) und markiert 5h-Fenster-Resets. Quelle sind die
 * Snapshot-Events; Backfill-Dateien enthalten keine und werden ignoriert.
 */
export async function readWeeklySeries(
  logDir: string,
  provider: string,
  windowStartMs: number,
  nowMs: number,
  bucketMinutes = 30,
): Promise<WindowBudgetSeries> {
  const empty: WindowBudgetSeries = { points: [], fiveHourResets: [] };
  let entries: string[];
  try {
    entries = await fs.readdir(logDir);
  } catch {
    return empty;
  }
  const startKey = utcDateKey(new Date(windowStartMs));
  const files = entries
    .map((e) => LIVE_LOG_RE.exec(e))
    .filter((m): m is RegExpExecArray => m !== null && m[1] >= startKey)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map((m) => path.join(logDir, m[0]));

  const bucketMs = bucketMinutes * 60_000;
  const buckets = new Map<number, number>();
  const resets: string[] = [];
  let prevFivePct: number | null = null;
  let prevFiveResetsAt: string | null = null;

  for (const file of files) {
    try {
      const rl = createInterface({
        input: createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes('"kind":"snapshot"')) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event.kind !== "snapshot" || event.provider !== provider || event.status !== "ok") continue;
        const ts = typeof event.ts === "string" ? event.ts : null;
        if (!ts) continue;
        const tsMs = new Date(ts).getTime();
        if (Number.isNaN(tsMs) || tsMs < windowStartMs || tsMs > nowMs) continue;
        const windows = Array.isArray(event.windows) ? (event.windows as Array<Record<string, unknown>>) : [];
        const weekly = windows.find((w) => w.name === "weekly");
        const five = windows.find((w) => w.name === "fiveHour");
        if (typeof weekly?.usedPercent === "number") {
          buckets.set(Math.floor(tsMs / bucketMs) * bucketMs, weekly.usedPercent);
        }
        if (typeof five?.usedPercent === "number") {
          const fiveResetsAt = typeof five.resetsAt === "string" ? five.resetsAt : null;
          if (prevFiveResetsAt !== null && fiveResetsAt !== null && fiveResetsAt !== prevFiveResetsAt) {
            resets.push(ts);
          } else if (prevFivePct !== null && five.usedPercent < prevFivePct - RESET_DROP_PCT) {
            resets.push(ts);
          }
          prevFivePct = five.usedPercent;
          prevFiveResetsAt = fiveResetsAt;
        }
      }
    } catch {
      // Datei nicht lesbar — überspringen
    }
  }

  const points = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, pct]) => ({ t: new Date(ms).toISOString(), weeklyPct: pct }));
  return { points, fiveHourResets: resets };
}

function utcDateKey(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
```

Hinweis zum Test "erkennt 5h-Resets über resetsAt-Wechsel": der erwartete Wert ist genau **ein** Reset, weil der Wechsel von `10:00` auf `15:30` als ein Ereignis zählt — der Prozent-Einbruch (81 → 2) löst wegen `else if` nicht doppelt aus.

- [ ] **Step 6.4: Test laufen lassen — muss grün sein**

Run: `npx vitest run tests/windowBudgetSeries.test.ts`
Expected: PASS

- [ ] **Step 6.5: Commit**

```bash
git add src/main/windowBudgetSeries.ts tests/windowBudgetSeries.test.ts
git commit -m "feat: read weekly usage series from live debug logs"
```

---

### Task 7: Worker-Task + IPC `windowBudget:get`

**Files:**
- Modify: `src/main/analyticsWorker.ts` (neuer Task-Typ)
- Modify: `src/main/detailsWindow.ts` (IPC-Handler + Cache)

Kein eigener Unit-Test: der Worker-Code ist reine Komposition der in Task 5/6 getesteten Funktionen; der IPC-Handler folgt dem getesteten Muster der bestehenden Handler. Verifikation über `npm run build` + GUI-Test in Task 9.

- [ ] **Step 7.1: Worker-Task ergänzen** — in `src/main/analyticsWorker.ts`:

Imports ergänzen:

```ts
import { readBackfillDayRecords } from "../reports/backfill-reader";
import { buildWeeklyProfile, computeWeeklyForecast, type WeeklyForecastResult } from "./weeklyForecast";
import { readWeeklySeries, type WindowBudgetSeries } from "./windowBudgetSeries";
import type { UsagePace } from "../usage/usagePace";
```

Nach `interface ModelsTaskInput` ergänzen:

```ts
interface WindowBudgetTaskInput {
  task: "windowBudget";
  logDir: string;
  nowMs: number;
  providers: Array<{
    provider: "claude" | "codex";
    weeklyUsedPercent: number;
    weeklyResetsAt: string | null;
    burnRatePctPerHour: number | null;
    pace: UsagePace | null;
  }>;
}

export interface WindowBudgetProviderData {
  series: WindowBudgetSeries;
  forecast: WeeklyForecastResult;
  hasSeriesData: boolean;
}

export interface WindowBudgetData {
  perProvider: Record<string, WindowBudgetProviderData>;
}
```

`WorkerInput` erweitern:

```ts
type WorkerInput = AnalyticsTaskInput | ModelsTaskInput | WindowBudgetTaskInput;
```

In `run(...)` direkt nach dem `models`-Zweig ergänzen (Rückgabetyp der Funktion um `WindowBudgetData` erweitern):

```ts
  if (input.task === "windowBudget") {
    return buildWindowBudgetData(input);
  }
```

Am Dateiende (vor `handleRequest`) die Funktion ergänzen:

```ts
const DAY_MS = 24 * 3600 * 1000;
const WEEK_MS = 7 * DAY_MS;

async function buildWindowBudgetData(input: WindowBudgetTaskInput): Promise<WindowBudgetData> {
  const now = new Date(input.nowMs);
  const records = await readBackfillDayRecords(input.logDir, new Date(input.nowMs - 28 * DAY_MS));
  const perProvider: Record<string, WindowBudgetProviderData> = {};
  for (const p of input.providers) {
    const resetMs = p.weeklyResetsAt ? new Date(p.weeklyResetsAt).getTime() : null;
    const windowStartMs = resetMs !== null ? resetMs - WEEK_MS : input.nowMs - WEEK_MS;
    const series = await readWeeklySeries(input.logDir, p.provider, windowStartMs, input.nowMs);
    const profile = buildWeeklyProfile(records, p.provider, now);
    const windowStartKey = new Date(windowStartMs).toISOString().slice(0, 10);
    const tokensInCurrentWindow = records
      .filter((r) => r.provider === p.provider && r.date >= windowStartKey)
      .reduce((sum, r) => sum + r.totalTokens, 0);
    const forecast = computeWeeklyForecast({
      weeklyUsedPercent: p.weeklyUsedPercent,
      weeklyResetsAt: p.weeklyResetsAt,
      tokensInCurrentWindow,
      burnRatePctPerHour: p.burnRatePctPerHour,
      pace: p.pace,
      profile,
      now,
    });
    perProvider[p.provider] = { series, forecast, hasSeriesData: series.points.length > 0 };
  }
  return { perProvider };
}
```

- [ ] **Step 7.2: IPC-Handler ergänzen** — in `src/main/detailsWindow.ts`:

Imports ergänzen: `getDebugLogDir` in den bestehenden paths-Import (Zeile 9) aufnehmen, dazu:

```ts
import type { WindowBudgetData } from "./analyticsWorker";
```

Bei den Cache-Feldern (~Zeile 37) ergänzen:

```ts
  private readonly windowBudgetCache = new AsyncResultCache<WindowBudgetData>();
```

In `clearAnalyticsCaches()` ergänzen:

```ts
    this.windowBudgetCache.clear();
```

In `registerIpcHandlers()` neben den anderen Handlern ergänzen:

```ts
    ipcMain.handle("windowBudget:get", async (): Promise<WindowBudgetData> => {
      const snapshots = this.lastSnapshots ?? [];
      const providers = snapshots
        .filter((s) => s.status === "ok" || s.status === "stale")
        .flatMap((s) => {
          const weekly = s.windows.find((w) => w.name === "weekly");
          if (!weekly || typeof weekly.usedPercent !== "number") return [];
          if (s.provider !== "claude" && s.provider !== "codex") return [];
          return [{
            provider: s.provider,
            weeklyUsedPercent: weekly.usedPercent,
            weeklyResetsAt: weekly.resetsAt ?? null,
            burnRatePctPerHour: weekly.burnRatePctPerHour ?? null,
            pace: weekly.pace ?? null,
          }];
        });
      if (providers.length === 0) return { perProvider: {} };
      return this.windowBudgetCache.get("windowBudget", () =>
        runAnalyticsWorker({
          task: "windowBudget",
          logDir: getDebugLogDir(),
          nowMs: Date.now(),
          providers,
        }) as Promise<WindowBudgetData>
      );
    });
```

Hinweis: `AsyncResultCache.get(key, factory)` erwartet einen String-Key (siehe `src/main/asyncResultCache.ts`); die anderen Handler nutzen dasselbe Muster.

- [ ] **Step 7.3: Build + alle Tests**

Run: `npm run build && npx vitest run`
Expected: Build ohne Fehler, alle Tests PASS

- [ ] **Step 7.4: Commit**

```bash
git add src/main/analyticsWorker.ts src/main/detailsWindow.ts
git commit -m "feat: add windowBudget worker task and IPC handler"
```

---

### Task 8: Renderer — Budget-Leiste + Kennzahlen (immer sichtbar)

**Files:**
- Modify: `src/renderer/tabs/live.js` (neue Funktion + Einbau in `renderStandard`)
- Modify: `src/renderer/index.html` (CSS, bei den `.token-*`-Regeln ~Zeile 668)

Renderer-Code hat keine Vitest-Abdeckung (Browser-Kontext); Verifikation per GUI-Test in Task 9 (siehe `TESTING.md`-Konvention des Projekts).

- [ ] **Step 8.1: CSS ergänzen** — in `src/renderer/index.html`, direkt vor der Regel `.token-toggle` (~Zeile 668):

```css
    /* ── Fenster-Budget (5h ↔ Weekly) ─────────────────────── */
    .wb-row { margin-top: 7px; }
    .wb-bar { display: flex; gap: 2px; height: 10px; }
    .wb-seg {
      position: relative; flex: 1; background: var(--bg3, #23262e);
      border-radius: 3px; overflow: hidden;
    }
    .wb-seg.wb-free { background: none; border: 1px dashed var(--t500, #3a3e48); }
    .wb-fill { position: absolute; inset: 0; right: auto; background: var(--blue, #4a9eda); }
    .wb-fill.wb-current { background: var(--blue-light, #7cc0f0); }
    .wb-stats {
      display: flex; justify-content: space-between;
      font-size: 10px; color: var(--t400); margin-top: 3px;
    }
    .wb-learning { font-size: 10px; color: var(--t400); font-style: italic; }
```

Hinweis: Existieren die CSS-Variablen `--bg3`, `--t500`, `--blue`, `--blue-light` im Stylesheet nicht, die Fallback-Werte aus den `var(...)`-Defaults direkt verwenden (die bestehenden Variablen oben in der Datei prüfen und passende nehmen — z. B. nutzt das Projekt `--t200`/`--t400` für Text).

- [ ] **Step 8.2: Budget-Leiste in live.js** — in `src/renderer/tabs/live.js` nach `tokenCollapseHtml` (~Zeile 157) einfügen:

```js
function fmtWindows(n) {
  return n.toFixed(1).replace('.', ',');
}

function windowBudgetRowHtml(snap) {
  const wb = snap.windowBudget;
  if (!wb) return '';
  if (wb.learning) {
    const tip = 'QuotaBar lernt das Verhältnis zwischen 5h- und Weekly-Limit aus deiner Nutzung.\n'
      + `Fortschritt: ${Math.round(wb.sampleFivePct)} % von 200 % 5h-Nutzung beobachtet.`;
    return `<div class="wb-row"><span class="wb-learning" data-tip="${QB.esc(tip)}">Fenster-Budget: lernt noch…</span></div>`;
  }
  const total = wb.windowsPerWeek;
  const segCount = Math.max(1, Math.ceil(total));
  const segs = [];
  for (let i = 0; i < segCount; i++) {
    const capacity = Math.min(1, total - i);          // letztes Segment ggf. partiell
    const used = clamp(wb.usedWindows - i, 0, capacity);
    const fillPct = capacity > 0 ? (used / capacity) * 100 : 0;
    const isCurrent = wb.usedWindows > i && wb.usedWindows < i + capacity;
    const isFree = used === 0;
    segs.push(`<div class="wb-seg${isFree ? ' wb-free' : ''}" style="flex:${capacity.toFixed(2)}">`
      + (fillPct > 0 ? `<div class="wb-fill${isCurrent ? ' wb-current' : ''}" style="width:${fillPct.toFixed(0)}%"></div>` : '')
      + `</div>`);
  }
  const tip = `Weekly-Budget umgerechnet in volle 5h-Fenster.\n`
    + `Gelernt aus deiner Nutzung: ~${fmtWindows(total)} volle 5h-Fenster passen in ein Weekly-Fenster.`;
  return `<div class="wb-row" data-tip="${QB.esc(tip)}">
    <div class="wb-bar">${segs.join('')}</div>
    <div class="wb-stats">
      <span>5h-Fenster: ${fmtWindows(wb.usedWindows)} verbraucht</span>
      <span>${fmtWindows(wb.remainingWindows)} übrig</span>
    </div>
  </div>`;
}
```

- [ ] **Step 8.3: Einbau in renderStandard** — in `renderStandard` den Weekly-Block erweitern. Aus:

```js
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
```

wird:

```js
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
      ${windowBudgetRowHtml(snap)}
    </div>`;
  }
```

- [ ] **Step 8.4: Build-Check + Commit**

Run: `npm run build`
Expected: keine Fehler (live.js ist plain JS, aber der Build prüft nichts daran — der Check stellt nur sicher, dass nichts anderes kaputt ist)

```bash
git add src/renderer/tabs/live.js src/renderer/index.html
git commit -m "feat: show 5h window budget bar in provider cards"
```

---

### Task 9: Renderer — Aufklapp-Graph + Prognose

**Files:**
- Modify: `src/renderer/tabs/live.js` (Collapse-Sektion, Hydration, Chart-Aufruf)
- Modify: `src/renderer/shared/charts.js` (neue Chart-Funktion)
- Modify: `src/renderer/index.html` (CSS für `.wb-collapse`-Teile)

- [ ] **Step 9.1: Chart-Funktion in charts.js** — am Dateiende von `src/renderer/shared/charts.js` ergänzen (Stil der bestehenden `QB.*Chart`-Funktionen in der Datei übernehmen, insbesondere Farben/Grid-Optionen):

```js
/**
 * Weekly-Budget-Verlauf: kumulierte Weekly-% über das aktuelle Fenster,
 * gestrichelte Projektion bis zur Prognose, vertikale 5h-Reset-Marker.
 * series: { points: [{t, weeklyPct}], fiveHourResets: [iso] }
 * forecast: { primaryAt, primaryLastsUntilReset, ... }
 */
QB.weeklyBudgetChart = function (ctx, series, forecast, windowEndIso) {
  const histData = series.points.map(p => ({ x: new Date(p.t).getTime(), y: p.weeklyPct }));
  const datasets = [{
    label: 'Weekly',
    data: histData,
    borderColor: '#4a9eda',
    backgroundColor: 'rgba(74,158,218,0.08)',
    borderWidth: 2,
    pointRadius: 0,
    fill: true,
    tension: 0.2,
  }];
  if (histData.length > 0 && forecast && forecast.primaryAt && !forecast.primaryLastsUntilReset) {
    const last = histData[histData.length - 1];
    datasets.push({
      label: 'Prognose',
      data: [last, { x: new Date(forecast.primaryAt).getTime(), y: 100 }],
      borderColor: '#d95757',
      borderWidth: 1.5,
      borderDash: [5, 4],
      pointRadius: 0,
      fill: false,
    });
  }
  const resetMs = series.fiveHourResets.map(t => new Date(t).getTime());
  const resetLines = {
    id: 'wbResetLines',
    afterDraw(chart) {
      const { ctx: c, chartArea, scales } = chart;
      if (!scales.x) return;
      c.save();
      c.strokeStyle = 'rgba(139,144,160,0.35)';
      c.setLineDash([3, 3]);
      for (const ms of resetMs) {
        const x = scales.x.getPixelForValue(ms);
        if (x < chartArea.left || x > chartArea.right) continue;
        c.beginPath();
        c.moveTo(x, chartArea.top);
        c.lineTo(x, chartArea.bottom);
        c.stroke();
      }
      c.restore();
    },
  };
  const xMax = windowEndIso ? new Date(windowEndIso).getTime() : undefined;
  return new Chart(ctx, {
    type: 'line',
    data: { datasets },
    plugins: [resetLines],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: {
          type: 'linear',
          min: histData.length > 0 ? histData[0].x : undefined,
          max: xMax,
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: {
            color: '#8b90a0',
            font: { size: 9 },
            maxTicksLimit: 7,
            callback: (v) => new Date(v).toLocaleDateString('de-DE', { weekday: 'short' }),
          },
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#8b90a0', font: { size: 9 }, callback: (v) => `${v}%` },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => new Date(items[0].parsed.x).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
            label: (item) => `${item.parsed.y.toFixed(1)} %`,
          },
        },
      },
    },
  });
};
```

- [ ] **Step 9.2: CSS ergänzen** — in `src/renderer/index.html` unter den `.wb-*`-Regeln aus Task 8:

```css
    .wb-chart-wrap { height: 120px; margin-top: 6px; }
    .wb-forecast { font-size: 10px; color: var(--t400); margin-top: 5px; line-height: 1.5; }
    .wb-forecast .wb-fc-main { color: var(--t200); }
    .wb-hint { font-size: 10px; color: var(--t400); font-style: italic; margin-top: 6px; }
```

- [ ] **Step 9.3: Collapse-Sektion + Hydration in live.js** — nach `windowBudgetRowHtml` einfügen:

```js
// Chart-Instanzen pro Provider, damit Re-Renders sie sauber ersetzen
const _wbCharts = {};
let _wbDataPromise = null;

function windowBudgetCollapseHtml(snap) {
  const wb = snap.windowBudget;
  if (!wb || wb.learning) return '';
  const id = `wbc-${QB.esc(snap.provider)}`;
  let isOpen = false;
  try { isOpen = localStorage.getItem('windowBudgetOpen') === '1'; } catch {}
  return `<div class="token-collapse${isOpen ? ' open' : ''}" id="${id}">
    <button class="token-toggle" aria-expanded="${isOpen}"
            onclick="QB.toggleWindowBudget('${id}', '${QB.esc(snap.provider)}')">
      <svg class="toggle-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Fenster-Budget
    </button>
    <div class="token-body">
      <div class="wb-chart-wrap"><canvas id="wb-chart-${QB.esc(snap.provider)}"></canvas></div>
      <div class="wb-forecast" id="wb-forecast-${QB.esc(snap.provider)}">Lädt…</div>
    </div>
  </div>`;
}

function wbForecastHtml(fc) {
  const fmt = (iso) => new Date(iso).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const kindLbl = fc.primaryKind === 'profile' ? 'Wochenprofil' : 'linear';
  const main = fc.primaryLastsUntilReset
    ? 'Reicht voraussichtlich bis zum Reset'
    : fc.primaryAt
      ? `Limit erreicht: ~${fmt(fc.primaryAt)} (${kindLbl})`
      : 'Keine Prognose möglich';
  let burn = '';
  if (fc.burnRateLastsUntilReset === true) burn = '<br>Bei aktuellem Tempo: reicht bis zum Reset';
  else if (fc.burnRateAt) burn = `<br>Bei aktuellem Tempo: ~${fmt(fc.burnRateAt)}`;
  return `<span class="wb-fc-main">${QB.esc(main)}</span>${burn}`;
}

async function hydrateWindowBudgets(snapshots) {
  const wanted = snapshots.filter(s => s.windowBudget && !s.windowBudget.learning);
  if (wanted.length === 0) return;
  try {
    if (!_wbDataPromise) _wbDataPromise = QB.ipc.invoke('windowBudget:get');
    const data = await _wbDataPromise;
    for (const snap of wanted) {
      const d = data.perProvider?.[snap.provider];
      const fcEl = document.getElementById(`wb-forecast-${snap.provider}`);
      const canvas = document.getElementById(`wb-chart-${snap.provider}`);
      if (!d || !fcEl || !canvas) continue;
      fcEl.innerHTML = wbForecastHtml(d.forecast);
      if (_wbCharts[snap.provider]) { _wbCharts[snap.provider].destroy(); delete _wbCharts[snap.provider]; }
      if (d.hasSeriesData) {
        const weekly = snap.windows.find(w => w.name === 'weekly');
        _wbCharts[snap.provider] = QB.weeklyBudgetChart(
          canvas.getContext('2d'), d.series, d.forecast, weekly?.resetsAt ?? null);
      } else {
        canvas.closest('.wb-chart-wrap').innerHTML =
          '<div class="wb-hint">Kein Verlauf verfügbar — Debug-Logging ist deaktiviert (Einstellungen).</div>';
      }
    }
  } catch (e) {
    console.error('windowBudget:get failed', e);
  }
}
```

Toggle-Funktion neben `QB.toggleTokenSection` registrieren:

```js
QB.toggleWindowBudget = function toggleWindowBudget(id, provider) {
  const container = document.getElementById(id);
  if (!container) return;
  const isOpen = container.classList.toggle('open');
  const btn = container.querySelector('.token-toggle');
  if (btn) btn.setAttribute('aria-expanded', String(isOpen));
  try { localStorage.setItem('windowBudgetOpen', isOpen ? '1' : '0'); } catch {}
};
```

In `renderStandard` die Sektion einbauen — aus:

```js
        ${bars}
        ${bdgs.length ? `<div class="badges">${bdgs.join('')}</div>` : ''}
        ${tokenHtml}
```

wird:

```js
        ${bars}
        ${bdgs.length ? `<div class="badges">${bdgs.join('')}</div>` : ''}
        ${windowBudgetCollapseHtml(snap)}
        ${tokenHtml}
```

In `QB.renderLive` die Hydration anstoßen und den Daten-Cache invalidieren — aus:

```js
  el.innerHTML   = overview + cards + tip;
  startCd();
```

wird:

```js
  el.innerHTML   = overview + cards + tip;
  _wbDataPromise = null; // neue Snapshots → Budget-Daten neu laden
  void hydrateWindowBudgets(snapshots);
  startCd();
```

- [ ] **Step 9.4: GUI-Test** — App starten und Sichtprüfung:

Run: `npm run dev`

Checkliste:
1. Live-Tab: Provider-Karten (Claude, Codex) zeigen unter dem Weekly-Balken die segmentierte Budget-Leiste mit „5h-Fenster: X,X verbraucht · X,X übrig" (Seed aus vorhandenen Debug-Logs sollte sofort greifen — erwartete Größenordnung: Claude ~3, Codex ~6,5–7 Fenster/Woche).
2. Toggle „Fenster-Budget" aufklappen: Liniengraph mit Weekly-Verlauf, gestrichelte rote Projektion (falls Limit vor Reset erreicht wird), graue vertikale 5h-Reset-Marker.
3. Prognose-Text unter dem Graph: Primär-Termin (Wochenprofil oder linear) + „Bei aktuellem Tempo: …".
4. Toggle-Zustand übersteht einen Refresh (localStorage).
5. `%USERPROFILE%\.quotabar-win\window-ratio.json` existiert nach ~1 Minute Laufzeit und enthält Summen pro Provider.

- [ ] **Step 9.5: Commit**

```bash
git add src/renderer/tabs/live.js src/renderer/shared/charts.js src/renderer/index.html
git commit -m "feat: add window budget chart and forecast to provider cards"
```

---

### Task 10: Doku + Aufräumen

**Files:**
- Modify: `docs/how-quotabar-calculates.md` (neue Sektion vor „Debug-Log und Backfill")
- Delete: `tmp-ratio-analysis.mjs` (Analyse-Skript aus der Design-Phase, untracked)

- [ ] **Step 10.1: Doku-Sektion ergänzen** — in `docs/how-quotabar-calculates.md` vor der Sektion `## Debug-Log und Backfill` einfügen:

```markdown
## Fenster-Budget (5h ↔ Weekly)

QuotaBar lernt aus der eigenen Nutzung, wie viele volle 5h-Fenster in ein Weekly-Fenster passen. Bei jedem Poll-Zyklus werden die Prozent-Zuwächse beider Fenster verglichen:

```
r = Σ ΔWeekly% / Σ Δ5h%        Fenster pro Woche = 1 / r
```

Verworfen werden Paare mit 5h-Reset (Δ5h ≤ 0 oder `resetsAt`-Wechsel), Weekly-Reset (ΔWeekly < 0) und gesättigtem Weekly (≥ 99,5 %). Das Verhältnis gilt erst ab 200 % beobachteter 5h-Nutzung als belastbar — vorher zeigt die Karte „lernt noch…".

Der State liegt in `%USERPROFILE%\.quotabar-win\window-ratio.json` und wird beim ersten Start einmalig aus den vorhandenen Live-Debug-Logs geseedet. Bei einem `planType`-Wechsel wird neu gelernt; oberhalb von 3000 % Summe werden beide Summen halbiert (exponentielles Vergessen), damit sich Limit-Änderungen der Anbieter durchsetzen.

**Prognose:** Der Termin „Limit erreicht ~…" basiert primär auf dem Wochenprofil (durchschnittliche Token pro Wochentag der letzten 4 Wochen, ab 2 Wochen Historie), sonst auf der linearen Wochen-Durchschnittsrate. Zusätzlich wird die aktuelle Burn-Rate als „Bei aktuellem Tempo: …" angezeigt.
```

- [ ] **Step 10.2: Analyse-Skript löschen**

```powershell
Remove-Item tmp-ratio-analysis.mjs
```

- [ ] **Step 10.3: Finale Verifikation**

Run: `npm run build && npx vitest run`
Expected: Build ohne Fehler, alle Tests PASS

- [ ] **Step 10.4: Commit**

```bash
git add docs/how-quotabar-calculates.md
git commit -m "docs: document window budget calculation and forecast"
```

---

## Self-Review-Notizen

- **Spec-Abdeckung:** Kernberechnung/Filter/Seeding/Drift-Schutz (Task 1–4), Kennzahlen (Task 1 + 8), Prognose 3-stufig (Task 5 + 7 + 9), Budget-Leiste (Task 8), Graph mit Resets + Projektion (Task 6 + 9), Fehlerfälle: learning-State (Task 1/8), Debug-Logging aus → Hinweis (Task 9, `hasSeriesData`), fehlendes Weekly → keine Sektion (Task 4/8 geben leer zurück), fehlendes `resetsAt` → Δ-Filter + 7-Tage-Fallback (Task 1/6/7).
- **Typ-Konsistenz:** `WindowBudgetInfo` (Task 1) wird in Task 4 (Snapshot) und Task 8 (Renderer, untyped JS) verwendet; `WindowBudgetSeries`/`WeeklyForecastResult` (Task 5/6) in Task 7 (Worker) und Task 9 (Renderer).
- **Bewusste Vereinfachungen:** `tokensInCurrentWindow` hat Tagesgranularität (erster Tag des Fensters zählt ganz) — für die Prognose-Form ausreichend, im Spec vermerkt. Renderer-Code ohne Unit-Tests (Projekt-Konvention, GUI-Test in Task 9).

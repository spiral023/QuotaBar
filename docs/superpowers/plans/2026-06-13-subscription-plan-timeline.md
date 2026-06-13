# Abo-Plan-Timeline mit Währungsumrechnung — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zeitlich begrenzte, pro Anbieter konfigurierbare Abo-Plan-Perioden (mit Overlap, Freitext-Name, €/$-Kosten und tagesaktueller FX-Umrechnung), die ROI/Kosten korrekt zeitvariabel berechnen und Plan-Wechsel in den Analytics- und History-Charts markieren.

**Architecture:** Backend ist Single Source of Truth. Ein FX-Fetcher (Frankfurter, lokal gecacht) und eine reine Kosten-Engine (`plan-cost.ts`) liefern pro Tag die USD-Abokosten. Diese speisen sowohl den Live-Faktor (Main) als auch den Analytics-Worker. Das Frontend (neuer „Abos"-Tab) verwaltet die Pläne und rendert fertige Werte + Wechsel-Marker.

**Tech Stack:** TypeScript (Main/Worker), Vitest, Electron-Renderer (Vanilla JS), Chart.js 4 (vendored). Spec: `docs/superpowers/specs/2026-06-13-subscription-plan-timeline-design.md`. Branch: `feature/subscription-plan-timeline`.

**Frontend-Hinweis:** Tasks 11–14 sind Renderer-Arbeit. Dieses Repo hat keine Renderer-Unit-Tests; Verifikation dort = `npm run build` + `npm run lint` + manueller App-Check. Für UI-Bau und -Politur jeweils `/frontend-design` bzw. `/make-interfaces-feel-better` heranziehen.

---

## File Structure

**Neu:**
- `src/pricing/fx-fetcher.ts` — Wechselkurs-Abruf (Frankfurter) + Disk-Cache + Lookup
- `src/pricing/plan-cost.ts` — reine Kosten-Engine (`dailySubCostUSD`, `periodSubCostUSD`, `planChangePoints`)
- `src/renderer/tabs/plans.js` — „Abos"-Tab-Renderer
- `tests/fxFetcher.test.ts`, `tests/planCost.test.ts`, `tests/settingsPlans.test.ts`

**Geändert:**
- `src/config/settings.ts` — `PlanPeriod`, `Settings.plans`, Migration
- `src/config/paths.ts` — `getFxCachePath()`
- `src/pricing/subscription-factor.ts` — Live-Faktor nutzt `periodSubCostUSD`
- `src/main/analyticsSummary.ts` — `DailyBucket` + `claudeSubUSD`/`codexSubUSD`
- `src/main/analyticsWorker.ts` — FX-Map empfangen, Sub-USD je Bucket, `planChanges`
- `src/main/detailsWindow.ts` — `plans:get`/`plans:save`/`fx:status`, FX-Backfill vor Worker-Aufruf, `planChanges` in `analytics:get`/`reports:get`
- `src/renderer/index.html` — Tab „Abos", View, alte Abo-Kosten-Felder entfernen, Settings-Save anpassen, CSS, Script-Tag
- `src/renderer/shared/charts.js` — Plan-Wechsel-Marker-Plugin
- `src/renderer/tabs/analytics.js` — kumulativer ROI mit zeitvariablem Nenner + Marker + „kein Abo"-Zustand
- `src/renderer/tabs/history.js` — Marker

---

## Task 1: Datenmodell & Settings-Migration

**Files:**
- Modify: `src/config/settings.ts`
- Test: `tests/settingsPlans.test.ts`

- [ ] **Step 1: Failing-Test schreiben**

`tests/settingsPlans.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { normalizeSettings, defaultSettings, type Settings } from "../src/config/settings";

describe("settings plans migration", () => {
  it("ergänzt plans: [] wenn nicht vorhanden", () => {
    const raw = { ...defaultSettings } as Partial<Settings>;
    delete (raw as Record<string, unknown>).plans;
    const s = normalizeSettings(raw as Settings);
    expect(Array.isArray(s.plans)).toBe(true);
    expect(s.plans).toHaveLength(0);
  });

  it("erfindet KEINE Pläne aus Legacy-subscriptionCosts", () => {
    const raw = { ...defaultSettings, subscriptionCosts: { claude: 100, codex: 20 } } as unknown as Settings;
    delete (raw as Record<string, unknown>).plans;
    const s = normalizeSettings(raw);
    expect(s.plans).toHaveLength(0);
  });

  it("normalisiert valide Pläne und verwirft kaputte Einträge", () => {
    const raw = { ...defaultSettings, plans: [
      { id: "a", provider: "claude", name: "Pro", amount: 20, currency: "USD", startsAt: "2026-01-01T00:00:00.000Z", endsAt: null },
      { id: "b", provider: "x", name: "", amount: -5, currency: "GBP", startsAt: "nope", endsAt: null },
    ] } as unknown as Settings;
    const s = normalizeSettings(raw);
    expect(s.plans).toHaveLength(1);
    expect(s.plans[0].id).toBe("a");
  });
});
```

- [ ] **Step 2: Test ausführen (muss fehlschlagen)**

Run: `npx vitest run tests/settingsPlans.test.ts`
Expected: FAIL (`plans` existiert nicht auf `Settings`).

- [ ] **Step 3: Implementieren**

In `src/config/settings.ts`:
- Typen ergänzen (vor `Settings`):
```ts
export type PlanCurrency = "USD" | "EUR";

export interface PlanPeriod {
  id: string;
  provider: "claude" | "codex";
  name: string;
  amount: number;        // Monatsbetrag in `currency`
  currency: PlanCurrency;
  startsAt: string;      // ISO datetime
  endsAt: string | null; // ISO datetime | null = läuft weiter
}
```
- `Settings`-Interface: `subscriptionCosts: SubscriptionCosts;` ersetzen durch `plans: PlanPeriod[];`. `SubscriptionCosts` als deprecated belassen (für Legacy-Lesen), aber aus `Settings` entfernen.
- `defaultSettings`: `subscriptionCosts: { claude: 20, codex: 20 }` ersetzen durch `plans: []`.
- In `normalizeSettings` den `subscriptionCosts`-Block entfernen und `plans` normalisieren:
```ts
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;
const validProviders = new Set(["claude", "codex"]);
const validCurrencies = new Set(["USD", "EUR"]);
const rawPlans = Array.isArray((settings as { plans?: unknown }).plans)
  ? ((settings as { plans: unknown[] }).plans)
  : [];
const plans: PlanPeriod[] = rawPlans.flatMap((p) => {
  const o = (p ?? {}) as Partial<PlanPeriod>;
  if (typeof o.id !== "string" || !o.id) return [];
  if (!validProviders.has(o.provider as string)) return [];
  if (typeof o.name !== "string" || o.name.trim() === "") return [];
  if (!(Number(o.amount) >= 0)) return [];
  if (!validCurrencies.has(o.currency as string)) return [];
  if (typeof o.startsAt !== "string" || !ISO_RE.test(o.startsAt)) return [];
  const endsAt = (typeof o.endsAt === "string" && ISO_RE.test(o.endsAt)) ? o.endsAt : null;
  return [{
    id: o.id, provider: o.provider as "claude" | "codex", name: o.name.trim(),
    amount: Number(o.amount), currency: o.currency as PlanCurrency,
    startsAt: o.startsAt, endsAt,
  }];
});
```
und im Rückgabe-Objekt `subscriptionCosts: {...}` durch `plans,` ersetzen.

- [ ] **Step 4: Test ausführen (muss bestehen)**

Run: `npx vitest run tests/settingsPlans.test.ts`
Expected: PASS (3 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/settings.ts tests/settingsPlans.test.ts
git commit -m "feat(settings): plan-period model replacing flat subscriptionCosts"
```

---

## Task 2: FX-Fetcher (Wechselkurse)

**Files:**
- Modify: `src/config/paths.ts` (Cache-Pfad)
- Create: `src/pricing/fx-fetcher.ts`
- Test: `tests/fxFetcher.test.ts`

- [ ] **Step 1: Cache-Pfad ergänzen**

In `src/config/paths.ts` nach `getUsageSnapshotCachePath`:
```ts
export function getFxCachePath(): string {
  return path.join(getAppConfigDir(), "cache", "fx-rates.json");
}
```

- [ ] **Step 2: Failing-Test schreiben**

`tests/fxFetcher.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFxLookup, FALLBACK_EURUSD } from "../src/pricing/fx-fetcher";

describe("makeFxLookup", () => {
  it("liefert exakten Tageskurs", () => {
    const fx = makeFxLookup({ "2026-03-10": 1.09, "2026-03-11": 1.10 }, false);
    expect(fx.rate("EURUSD", "2026-03-11")).toEqual({ value: 1.10, estimated: false });
  });

  it("forward-fill über EZB-Lücken (Wochenende)", () => {
    const fx = makeFxLookup({ "2026-03-13": 1.08 }, false); // Fr
    // Sa/So ohne Kurs → letzter vorheriger Wert, als estimated markiert
    expect(fx.rate("EURUSD", "2026-03-14")).toEqual({ value: 1.08, estimated: true });
  });

  it("Fallback wenn Map leer", () => {
    const fx = makeFxLookup({}, true);
    expect(fx.rate("EURUSD", "2026-03-14")).toEqual({ value: FALLBACK_EURUSD, estimated: true });
  });
});
```

- [ ] **Step 3: Test ausführen (muss fehlschlagen)**

Run: `npx vitest run tests/fxFetcher.test.ts`
Expected: FAIL (Modul fehlt).

- [ ] **Step 4: Implementieren**

`src/pricing/fx-fetcher.ts`:
```ts
import fs from "node:fs/promises";
import path from "node:path";
import { getFxCachePath } from "../config/paths";

export type FxPair = "EURUSD";
export interface FxRate { value: number; estimated: boolean; }
export interface FxLookup { rate(pair: FxPair, day: string): FxRate; }

export const FALLBACK_EURUSD = 1.08;

// Reiner Lookup aus einer Tages-Map. Fehlende Tage: letzter vorheriger Kurs
// (estimated=true). Ganz leer: Fallback (estimated=true).
export function makeFxLookup(map: Record<string, number>, anyEstimated: boolean): FxLookup {
  const days = Object.keys(map).sort();
  return {
    rate(_pair, day) {
      const exact = map[day];
      if (exact !== undefined) return { value: exact, estimated: anyEstimated };
      let prev: string | undefined;
      for (const d of days) { if (d <= day) prev = d; else break; }
      if (prev !== undefined) return { value: map[prev], estimated: true };
      if (days.length > 0) return { value: map[days[0]], estimated: true };
      return { value: FALLBACK_EURUSD, estimated: true };
    },
  };
}

interface FxCache { EURUSD: Record<string, number>; }

export class FxFetcher {
  private cache: FxCache | null = null;
  private anyEstimated = false;

  constructor(
    private readonly offlineMode = false,
    private readonly cachePath: string = getFxCachePath(),
  ) {}

  // Stellt sicher, dass alle Handelstage in [minDay, maxDay] geladen/gecacht sind.
  async ensureRange(minDay: string, maxDay: string): Promise<void> {
    await this.load();
    const have = this.cache!.EURUSD;
    const needFetch = !this.offlineMode && this.missingBusinessDay(have, minDay, maxDay);
    if (!needFetch) { if (this.offlineMode) this.anyEstimated = true; return; }
    try {
      const url = `https://api.frankfurter.dev/v1/${minDay}..${maxDay}?base=EUR&symbols=USD`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { rates?: Record<string, { USD?: number }> };
      for (const [day, obj] of Object.entries(json.rates ?? {})) {
        if (typeof obj?.USD === "number") have[day] = obj.USD;
      }
      await this.save();
    } catch {
      this.anyEstimated = true; // Abruf fehlgeschlagen → vorhandene/Fallback-Kurse
    }
  }

  lookup(): FxLookup {
    return makeFxLookup(this.cache?.EURUSD ?? {}, this.anyEstimated || this.offlineMode);
  }

  exportRange(_pair: FxPair, minDay: string, maxDay: string): Record<string, number> {
    const src = this.cache?.EURUSD ?? {};
    const out: Record<string, number> = {};
    for (const [d, v] of Object.entries(src)) if (d >= minDay && d <= maxDay) out[d] = v;
    return out;
  }

  get estimated(): boolean { return this.anyEstimated || this.offlineMode; }

  private missingBusinessDay(have: Record<string, number>, minDay: string, maxDay: string): boolean {
    // Heuristik: fehlt mind. ein Werktag (Mo–Fr) im Bereich → nachladen.
    for (let d = new Date(`${minDay}T00:00:00Z`); d <= new Date(`${maxDay}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const key = d.toISOString().slice(0, 10);
      if (have[key] === undefined) return true;
    }
    return false;
  }

  private async load(): Promise<void> {
    if (this.cache) return;
    try {
      this.cache = JSON.parse(await fs.readFile(this.cachePath, "utf8")) as FxCache;
      if (!this.cache.EURUSD) this.cache.EURUSD = {};
    } catch {
      this.cache = { EURUSD: {} };
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    await fs.writeFile(this.cachePath, JSON.stringify(this.cache), "utf8");
  }
}

// Geteilte Instanz: ein FX-Owner für Main + Pricing-Engine.
export const sharedFxFetcher = new FxFetcher();
```

- [ ] **Step 5: Test ausführen (muss bestehen)**

Run: `npx vitest run tests/fxFetcher.test.ts`
Expected: PASS (3 Tests).

- [ ] **Step 6: Commit**

```bash
git add src/pricing/fx-fetcher.ts src/config/paths.ts tests/fxFetcher.test.ts
git commit -m "feat(pricing): FX fetcher with Frankfurter source and disk cache"
```

---

## Task 3: Kosten-Engine (`plan-cost.ts`)

**Files:**
- Create: `src/pricing/plan-cost.ts`
- Test: `tests/planCost.test.ts`

- [ ] **Step 1: Failing-Test schreiben**

`tests/planCost.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import type { PlanPeriod } from "../src/config/settings";
import { makeFxLookup } from "../src/pricing/fx-fetcher";
import { dailySubCostUSD, periodSubCostUSD, planChangePoints } from "../src/pricing/plan-cost";

const fx = makeFxLookup({ "2026-03-10": 1.10 }, false);
const plan = (o: Partial<PlanPeriod>): PlanPeriod => ({
  id: "x", provider: "claude", name: "Pro", amount: 30, currency: "USD",
  startsAt: "2026-03-01T00:00:00.000Z", endsAt: null, ...o,
});

describe("dailySubCostUSD", () => {
  it("voller aktiver Tag = amount/30 (USD)", () => {
    expect(dailySubCostUSD([plan({})], "claude", "2026-03-10", fx)).toBeCloseTo(1.0, 6);
  });
  it("Lücke = 0", () => {
    expect(dailySubCostUSD([plan({ startsAt: "2026-04-01T00:00:00.000Z" })], "claude", "2026-03-10", fx)).toBe(0);
  });
  it("Overlap summiert beide Pläne", () => {
    const v = dailySubCostUSD([plan({ id: "a" }), plan({ id: "b", amount: 60 })], "claude", "2026-03-10", fx);
    expect(v).toBeCloseTo(1.0 + 2.0, 6);
  });
  it("€ wird mit Tageskurs umgerechnet", () => {
    const v = dailySubCostUSD([plan({ currency: "EUR", amount: 30 })], "claude", "2026-03-10", fx);
    expect(v).toBeCloseTo(1.0 * 1.10, 6);
  });
  it("Grenztag wird anteilig nach Uhrzeit prorat", () => {
    // Start 12:00 UTC → halber Tag aktiv → halbe Tageskosten
    const v = dailySubCostUSD([plan({ startsAt: "2026-03-10T12:00:00.000Z" })], "claude", "2026-03-10", fx);
    expect(v).toBeGreaterThan(0.4); expect(v).toBeLessThan(0.6);
  });
  it("ignoriert anderen Anbieter", () => {
    expect(dailySubCostUSD([plan({ provider: "codex" })], "claude", "2026-03-10", fx)).toBe(0);
  });
});

describe("periodSubCostUSD", () => {
  it("summiert Tageskosten über den Bereich", () => {
    const v = periodSubCostUSD([plan({})], "claude", "2026-03-10", "2026-03-12", fx);
    expect(v).toBeCloseTo(3.0, 6); // 3 volle Tage à 1.0
  });
});

describe("planChangePoints", () => {
  it("liefert Start- und Endpunkte im Bereich", () => {
    const pts = planChangePoints(
      [plan({ name: "Pro", startsAt: "2026-03-05T00:00:00.000Z", endsAt: "2026-03-20T00:00:00.000Z" })],
      "claude", "2026-03-01", "2026-03-31");
    expect(pts.map(p => p.day)).toEqual(["2026-03-05", "2026-03-20"]);
  });
});
```

- [ ] **Step 2: Test ausführen (muss fehlschlagen)**

Run: `npx vitest run tests/planCost.test.ts`
Expected: FAIL (Modul fehlt).

- [ ] **Step 3: Implementieren**

`src/pricing/plan-cost.ts`:
```ts
import type { PlanPeriod } from "../config/settings";
import type { FxLookup } from "./fx-fetcher";

const DAY_MS = 86_400_000;

function localDayBounds(day: string): { start: number; end: number } {
  const start = new Date(`${day}T00:00:00`).getTime(); // lokale Mitternacht
  return { start, end: start + DAY_MS };
}

// Anteil des Tages [start,end), in dem [from,to) aktiv ist (0..1).
function activeFraction(plan: PlanPeriod, dayStart: number, dayEnd: number): number {
  const from = new Date(plan.startsAt).getTime();
  const to = plan.endsAt ? new Date(plan.endsAt).getTime() : Number.POSITIVE_INFINITY;
  const lo = Math.max(from, dayStart);
  const hi = Math.min(to, dayEnd);
  if (hi <= lo) return 0;
  return (hi - lo) / DAY_MS;
}

export function dailySubCostUSD(
  plans: PlanPeriod[], provider: "claude" | "codex", day: string, fx: FxLookup,
): number {
  const { start, end } = localDayBounds(day);
  let sum = 0;
  for (const p of plans) {
    if (p.provider !== provider) continue;
    const frac = activeFraction(p, start, end);
    if (frac <= 0) continue;
    const perDay = (p.amount / 30) * frac;
    sum += p.currency === "EUR" ? perDay * fx.rate("EURUSD", day).value : perDay;
  }
  return sum;
}

export function periodSubCostUSD(
  plans: PlanPeriod[], provider: "claude" | "codex",
  sinceDay: string, untilDay: string, fx: FxLookup,
): number {
  let sum = 0;
  for (const day of eachLocalDay(sinceDay, untilDay)) {
    sum += dailySubCostUSD(plans, provider, day, fx);
  }
  return sum;
}

export interface PlanChangePoint { day: string; provider: "claude" | "codex"; label: string; }

export function planChangePoints(
  plans: PlanPeriod[], provider: "claude" | "codex",
  sinceDay: string, untilDay: string,
): PlanChangePoint[] {
  const inRange = (d: string) => d >= sinceDay && d <= untilDay;
  const mine = plans.filter(p => p.provider === provider);
  const pts: PlanChangePoint[] = [];
  for (const p of mine) {
    const startDay = p.startsAt.slice(0, 10);
    if (inRange(startDay)) {
      const ended = mine.find(q => q.id !== p.id && q.endsAt && q.endsAt.slice(0, 10) === startDay);
      const overlapping = mine.some(q => q.id !== p.id && q.startsAt < p.startsAt && (!q.endsAt || q.endsAt > p.startsAt));
      const label = ended ? `${ended.name} → ${p.name}` : overlapping ? `+ ${p.name}` : p.name;
      pts.push({ day: startDay, provider, label });
    }
    if (p.endsAt) {
      const endDay = p.endsAt.slice(0, 10);
      const replaced = mine.some(q => q.id !== p.id && q.startsAt.slice(0, 10) === endDay);
      if (inRange(endDay) && !replaced) pts.push({ day: endDay, provider, label: `${p.name} endet` });
    }
  }
  return pts.sort((a, b) => a.day.localeCompare(b.day));
}

function eachLocalDay(sinceDay: string, untilDay: string): string[] {
  const pad = (v: number) => String(v).padStart(2, "0");
  const start = new Date(`${sinceDay}T00:00:00`);
  const end = new Date(`${untilDay}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const days: string[] = [];
  for (let i = 0; i < 100_000; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    if (d > end) break;
    days.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }
  return days;
}
```

- [ ] **Step 4: Test ausführen (muss bestehen)**

Run: `npx vitest run tests/planCost.test.ts`
Expected: PASS (alle Beschreibungen).

- [ ] **Step 5: Commit**

```bash
git add src/pricing/plan-cost.ts tests/planCost.test.ts
git commit -m "feat(pricing): time-varying plan-cost engine with FX and proration"
```

---

## Task 4: Live-Faktor auf Plan-Modell umstellen

**Files:**
- Modify: `src/pricing/subscription-factor.ts`
- Test: bestehende Suite (`npx vitest run`)

- [ ] **Step 1: Implementieren — Claude-Faktor**

In `src/pricing/subscription-factor.ts`:
- Imports ergänzen:
```ts
import { sharedFxFetcher } from "./fx-fetcher";
import { periodSubCostUSD } from "./plan-cost";
```
- Helfer (Datei-Ende) für lokalen Tagesschlüssel:
```ts
function localDayKey(ms: number): string {
  const d = new Date(ms); const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
```
- In `calculateClaudeFactor` den Block ab `const subscriptionCostUSD = currentSettings.subscriptionCosts.claude;` bis `const factor = ...` ersetzen durch:
```ts
const sinceDay = localDayKey(billingStart.getTime() > 0 ? billingStart.getTime()
  : (entries.length ? Math.min(...entries.map(e => new Date(e.timestamp).getTime())) : Date.now()));
const untilDay = localDayKey(Date.now());
await sharedFxFetcher.ensureRange(sinceDay, untilDay);
const fx = sharedFxFetcher.lookup();
const periodSubCost = periodSubCostUSD(currentSettings.plans, "claude", sinceDay, untilDay, fx);
const subscriptionCostUSD = periodSubCost;
const factor = periodSubCost > 0 ? apiCostUSD / periodSubCost : null;
```
- Im Rückgabe-Objekt `factor` darf jetzt `null` sein; `label`: bei `factor === null` → `"Kein Abo hinterlegt"`. `formatLabel` anpassen:
```ts
function formatLabel(apiCostUSD: number, factor: number | null, isEstimate: boolean): string {
  if (factor === null) return "Kein Abo hinterlegt";
  if (apiCostUSD === 0 && !isEstimate) return "$0.00 (keine Daten)";
  const prefix = isEstimate ? "~" : "";
  return `${prefix}${factor.toFixed(1)}× Abo`;
}
```
- `effectiveDays`/`windowDays` im Ergebnis bleiben wie gehabt (für Anzeige). `subscriptionCostUSD` ist nun die effektive Summe.
- Analog in `calculateCodexFactor`: denselben FX/periodSubCost-Block mit `"codex"` und der Codex-`events`-Zeitbasis verwenden; den `subscriptionCostUSD`-Wert ersetzen; `factor` ggf. `null`.

> Prüfe `CostFactorResult.factor`-Typ in `src/providers/types.ts`: muss `number | null` zulassen (ist es bereits, da Codex `factor: null` setzt). Falls nicht, dort auf `number | null` erweitern.

- [ ] **Step 2: Build + bestehende Tests**

Run: `npm run build && npx vitest run`
Expected: Build ok; Tests grün. Falls ein Test `subscriptionCosts` referenziert, in Step 3 anpassen.

- [ ] **Step 3: Test-Fallout beheben (falls vorhanden)**

Suche Tests, die `subscriptionCosts` setzen, und ersetze durch `plans: [{ id:"t", provider, name:"Test", amount:20, currency:"USD", startsAt:"2020-01-01T00:00:00.000Z", endsAt:null }]`.

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/pricing/subscription-factor.ts src/providers/types.ts tests/
git commit -m "feat(pricing): live cost factor uses time-varying plan cost"
```

---

## Task 5: Analytics-Worker — Sub-USD je Bucket + planChanges

**Files:**
- Modify: `src/main/analyticsSummary.ts`, `src/main/analyticsWorker.ts`
- Test: `tests/analyticsGet.test.ts`

- [ ] **Step 1: `DailyBucket` erweitern (Test zuerst)**

In `tests/analyticsGet.test.ts` einen Test ergänzen:
```ts
it("dailyBuckets tragen claudeSubUSD/codexSubUSD (default 0)", () => {
  const { since, until } = rangeEndingToday(3);
  const b = buildDailyBuckets([], [], since, until);
  expect(b[0].claudeSubUSD).toBe(0);
  expect(b[0].codexSubUSD).toBe(0);
});
```

- [ ] **Step 2: Test ausführen (muss fehlschlagen)**

Run: `npx vitest run tests/analyticsGet.test.ts`
Expected: FAIL (Feld fehlt).

- [ ] **Step 3: Implementieren — `analyticsSummary.ts`**

`DailyBucket` um Felder erweitern und in `buildDailyBuckets` mit 0 initialisieren:
```ts
export interface DailyBucket {
  date: string;
  claudeUSD: number;
  codexUSD: number;
  claudeQuotaPct: number | null;
  codexQuotaPct: number | null;
  claudeSubUSD: number;  // USD-Abokosten dieses Tages (Claude)
  codexSubUSD: number;   // USD-Abokosten dieses Tages (Codex)
}
```
Im `days.map(...)`-Objekt `claudeSubUSD: 0, codexSubUSD: 0,` ergänzen (werden im Worker befüllt).

- [ ] **Step 4: Implementieren — `analyticsWorker.ts`**

- Imports:
```ts
import { dailySubCostUSD, planChangePoints, type PlanChangePoint } from "../pricing/plan-cost";
import { makeFxLookup } from "../pricing/fx-fetcher";
```
- `AnalyticsTaskInput` erweitern: `eurUsdRates?: Record<string, number>; fxEstimated?: boolean;` (FX-Map kommt aus dem Main-Prozess).
- Im `get`-Zweig nach `const dailyBuckets = buildDailyBuckets(...)`:
```ts
const fx = makeFxLookup(input.eurUsdRates ?? {}, input.fxEstimated ?? false);
const plans = input.settings.plans;
for (const b of dailyBuckets) {
  b.claudeSubUSD = dailySubCostUSD(plans, "claude", b.date, fx);
  b.codexSubUSD  = dailySubCostUSD(plans, "codex",  b.date, fx);
}
const planChanges: PlanChangePoint[] = [
  ...planChangePoints(plans, "claude", input.since, input.until ?? input.since),
  ...planChangePoints(plans, "codex",  input.since, input.until ?? input.since),
];
```
- `planChanges` ins `AnalyticsData`-Ergebnis aufnehmen (Feld in `analyticsSummary.ts`-Interface `AnalyticsData` ergänzen: `planChanges: PlanChangePoint[];` mit Import des Typs).

- [ ] **Step 5: Tests ausführen**

Run: `npx vitest run tests/analyticsGet.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/analyticsSummary.ts src/main/analyticsWorker.ts tests/analyticsGet.test.ts
git commit -m "feat(analytics): per-day subscription USD and plan-change points in worker"
```

---

## Task 6: IPC — plans CRUD, FX-Backfill, planChanges in Reports

**Files:**
- Modify: `src/main/detailsWindow.ts`
- Test: Build + bestehende Suite

- [ ] **Step 1: Imports & FX-Backfill im `analytics:get`-Handler**

In `src/main/detailsWindow.ts`:
- Imports:
```ts
import { sharedFxFetcher } from "../pricing/fx-fetcher";
import { planChangePoints } from "../pricing/plan-cost";
```
- Im `analytics:get`-Handler vor dem Worker-Aufruf FX laden und Map übergeben:
```ts
await sharedFxFetcher.ensureRange(since, until);
const eurUsdRates = sharedFxFetcher.exportRange("EURUSD", since, until);
const fxEstimated = sharedFxFetcher.estimated;
```
und im `runAnalyticsWorker({...})`-Objekt `eurUsdRates, fxEstimated,` ergänzen. Cache-Key um Plan-Signatur erweitern, damit Planänderungen den Cache umgehen:
```ts
const planSig = JSON.stringify(settings.plans);
return this.analyticsDataCache.get(`get:${since}:${until}:${planSig}`, () => runAnalyticsWorker({ ... }) ...);
```

- [ ] **Step 2: `reports:get` um planChanges ergänzen**

Im `reports:get`-Handler nach `const report = await generateUsageReport(...)`:
```ts
const sinceDay = request.since ?? report.rows[0]?.bucket?.slice(0, 10);
const untilDay = request.until ?? new Date().toISOString().slice(0, 10);
const planChanges = (sinceDay && untilDay) ? [
  ...planChangePoints(settings.plans, "claude", sinceDay, untilDay),
  ...planChangePoints(settings.plans, "codex",  sinceDay, untilDay),
] : [];
return { ...report, planChanges };
```
(`settings` ist im Handler bereits via `loadSettings()` vorhanden — sonst ergänzen.)

- [ ] **Step 3: Neue IPC-Kanäle plans/fx**

Im `registerIpcHandlers()`:
```ts
ipcMain.handle("plans:get", async () => {
  const settings = await loadSettings();
  return settings.plans;
});

ipcMain.handle("plans:save", async (_, plans: unknown) => {
  const current = await loadSettings();
  await saveSettings({ ...current, plans: Array.isArray(plans) ? (plans as typeof current.plans) : [] });
  this.clearAnalyticsCaches();
  log.info("Plans saved via dashboard");
  return { ok: true };
});

ipcMain.handle("fx:status", () => ({ estimated: sharedFxFetcher.estimated }));
```

- [ ] **Step 4: Build + Tests**

Run: `npm run build && npx vitest run`
Expected: Build ok, Tests grün.

- [ ] **Step 5: Commit**

```bash
git add src/main/detailsWindow.ts
git commit -m "feat(ipc): plans CRUD, FX backfill, plan-change points in reports"
```

---

## Task 7: Settings-Tab — alte Abo-Kosten-Felder entfernen

**Files:**
- Modify: `src/renderer/index.html`
- Verify: `npm run build && npm run lint`

- [ ] **Step 1: HTML-Block entfernen**

In `src/renderer/index.html` die `s-section` „Subscription Cost / month" (ca. Zeilen 2167–2185, Block mit `#cost-claude`/`#cost-codex`) **vollständig entfernen**. An ihrer Stelle ein Hinweis:
```html
<div class="s-section">
  <div class="s-section-title">Abos</div>
  <div class="s-hint">Abo-Pläne &amp; Kosten werden jetzt im Tab <b>Abos</b> verwaltet.</div>
</div>
```

- [ ] **Step 2: Settings-Load/Save bereinigen**

- Zeilen, die `cost-claude`/`cost-codex` lesen/schreiben (ca. 2357–2358 und 2382–2385), entfernen. Das Save-`payload` darf `subscriptionCosts` nicht mehr enthalten.

- [ ] **Step 3: Verifizieren**

Run: `npm run build && npm run lint`
Expected: kein Fehler; keine Referenz auf `cost-claude`/`cost-codex` mehr (`grep -rn "cost-claude" src/renderer` → leer).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/index.html
git commit -m "refactor(settings-ui): remove flat subscription cost fields (moved to Abos tab)"
```

---

## Task 8: „Abos"-Tab — Gerüst (Tab, View, Routing)

**Files:**
- Modify: `src/renderer/index.html`
- Verify: App startet, Tab schaltbar

- [ ] **Step 1: Tab-Button + View + Script**

- In `<nav class="tab-nav">` nach dem History-Button:
```html
<button class="tab-btn" id="tab-plans" data-tab="plans">Abos</button>
```
- Neue View vor `#view-system` o. ä.:
```html
<div class="view" id="view-plans" hidden>
  <div class="pl-wrap" id="plans-content">
    <div class="empty"><div class="spinner"></div><span>Lädt…</span></div>
  </div>
</div>
```
- Script-Tag bei den anderen Tab-Skripten:
```html
<script src="tabs/plans.js"></script>
```

- [ ] **Step 2: Routing verdrahten**

- Click-Handler analog zu den anderen: `document.getElementById('tab-plans').addEventListener('click', () => switchTab('plans'));`
- In `switchTab`/Render-Dispatch: `if (tab === 'plans') QB.renderPlans();`
- In den `hidden`-Togglezeilen `#view-plans` mit aufnehmen (analog zu `#view-history`).

- [ ] **Step 3: Verifizieren**

Run: `npm run build`
Manuell: App starten, Tab „Abos" erscheint und ist anklickbar (zeigt Ladezustand).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/index.html
git commit -m "feat(plans-ui): scaffold Abos tab (button, view, routing)"
```

---

## Task 9: „Abos"-Tab — Renderer-Logik (`plans.js`)

**Files:**
- Create: `src/renderer/tabs/plans.js`
- Verify: `npm run lint` + manueller Check

> UI-Bau mit `/frontend-design`. Markup-Struktur unten ist die funktionale Basis; Gestaltung dort verfeinern.

- [ ] **Step 1: Grundgerüst + Laden**

`src/renderer/tabs/plans.js`:
```js
/* global QB */
'use strict';
window.QB = window.QB || {};

let _plans = [];
let _fxEstimated = false;
let _editing = null; // PlanPeriod-Entwurf oder null

const PROVIDERS = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex',  label: 'Codex'  },
];
const NAME_SUGGESTIONS = ['Pro', 'Max', 'Max 20×', 'Team'];

QB.renderPlans = async function renderPlans() {
  const c = document.getElementById('plans-content');
  if (!c) return;
  try {
    [_plans, { estimated: _fxEstimated }] = await Promise.all([
      QB.ipc.invoke('plans:get'),
      QB.ipc.invoke('fx:status').catch(() => ({ estimated: false })),
    ]);
    _renderUI();
  } catch (e) {
    console.error('plans:get failed', e);
    c.innerHTML = '<div class="empty"><span>Fehler beim Laden</span></div>';
  }
};

function _uid() { return 'p_' + Math.random().toString(36).slice(2, 10); }

async function _save() {
  await QB.ipc.invoke('plans:save', _plans);
  if (QB.clearAnalyticsCache) QB.clearAnalyticsCache();
}
```

- [ ] **Step 2: Rendering (Karten je Anbieter, Leerzustand, Liste)**

```js
function _fmtAmount(p) {
  const sym = p.currency === 'EUR' ? '€' : '$';
  return `${sym}${Number(p.amount).toFixed(0)}`;
}
function _fmtRange(p) {
  const d = s => s ? new Date(s).toLocaleDateString('de-AT', { day: '2-digit', month: 'short', year: '2-digit' }) : '';
  return `${d(p.startsAt)} – ${p.endsAt ? d(p.endsAt) : 'läuft'}`;
}
function _isActive(p) {
  const now = Date.now();
  return new Date(p.startsAt).getTime() <= now && (!p.endsAt || new Date(p.endsAt).getTime() > now);
}

function _renderUI() {
  const c = document.getElementById('plans-content');
  c.innerHTML = PROVIDERS.map(prov => {
    const list = _plans.filter(p => p.provider === prov.id)
      .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
    const body = list.length ? list.map(p => `
      <div class="pl-row${_isActive(p) ? ' is-active' : ''}">
        <div class="pl-row-main">
          <span class="pl-row-name">${QB.esc(p.name)}</span>
          ${_isActive(p) ? '<span class="pl-badge">aktiv</span>' : ''}
        </div>
        <div class="pl-row-meta">
          <span class="pl-row-range">${_fmtRange(p)}</span>
          <span class="pl-row-amt">${_fmtAmount(p)}<span class="pl-row-cyc">/Mo</span></span>
        </div>
        <div class="pl-row-actions">
          <button class="pl-mini" data-act="edit" data-id="${p.id}">Bearbeiten</button>
          <button class="pl-mini" data-act="change" data-id="${p.id}">Preis ändern ab…</button>
          <button class="pl-mini pl-danger" data-act="del" data-id="${p.id}">Löschen</button>
        </div>
      </div>`).join('') : `
      <div class="pl-empty">
        <div class="pl-empty-text">Noch kein Abo für ${prov.label} hinterlegt</div>
        <button class="pl-add-cta" data-act="add" data-prov="${prov.id}">Abo hinzufügen</button>
      </div>`;
    return `
      <div class="pl-card">
        <div class="pl-card-head">
          <span class="pl-card-title">${prov.label}</span>
          ${list.length ? `<button class="pl-mini" data-act="add" data-prov="${prov.id}">+ Abo</button>` : ''}
        </div>
        <div class="pl-list">${body}</div>
      </div>`;
  }).join('') + (_fxEstimated ? '<div class="pl-fx-note">Wechselkurse teils geschätzt (offline / kein Kurs verfügbar).</div>' : '');

  c.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', () => _onAction(btn.dataset)));
  if (_editing) _renderEditor();
}
```

- [ ] **Step 3: Aktionen + Editor-Formular**

```js
function _onAction(ds) {
  if (ds.act === 'add')    _editing = { id: _uid(), provider: ds.prov, name: '', amount: '', currency: 'USD', startsAt: _nowLocalIso(), endsAt: null, _mode: 'add' };
  if (ds.act === 'edit')   _editing = { ..._plans.find(p => p.id === ds.id), _mode: 'edit' };
  if (ds.act === 'change') { const o = _plans.find(p => p.id === ds.id); _editing = { id: _uid(), provider: o.provider, name: o.name, amount: o.amount, currency: o.currency, startsAt: _nowLocalIso(), endsAt: null, _mode: 'change', _fromId: o.id }; }
  if (ds.act === 'del')    { if (confirm('Diesen Plan löschen?')) { _plans = _plans.filter(p => p.id !== ds.id); _save().then(_renderUI); } return; }
  _renderUI();
}

function _nowLocalIso() {
  const d = new Date(); d.setSeconds(0, 0);
  const p = v => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function _renderEditor() {
  const e = _editing;
  const wrap = document.createElement('div');
  wrap.className = 'pl-modal';
  wrap.innerHTML = `
    <div class="pl-dialog">
      <div class="pl-dialog-title">${e._mode === 'edit' ? 'Abo bearbeiten' : e._mode === 'change' ? 'Preis/Stufe ändern' : 'Abo hinzufügen'}</div>
      <label class="pl-f">Name
        <input id="pl-name" list="pl-name-sugg" value="${QB.esc(e.name)}" placeholder="z. B. Pro">
        <datalist id="pl-name-sugg">${NAME_SUGGESTIONS.map(s => `<option value="${s}">`).join('')}</datalist>
      </label>
      <label class="pl-f">Betrag / Monat
        <span class="pl-amt-wrap">
          <input id="pl-amount" type="number" min="0" step="1" value="${e.amount}">
          <select id="pl-currency"><option value="USD"${e.currency==='USD'?' selected':''}>$</option><option value="EUR"${e.currency==='EUR'?' selected':''}>€</option></select>
        </span>
      </label>
      <div class="pl-fx-preview" id="pl-fx-preview"></div>
      <label class="pl-f">Start <input id="pl-start" type="datetime-local" value="${(e.startsAt||'').slice(0,16)}"></label>
      <label class="pl-f">Ende (leer = läuft weiter) <input id="pl-end" type="datetime-local" value="${(e.endsAt||'').slice(0,16)}"></label>
      <div class="pl-dialog-actions">
        <button class="pl-mini" id="pl-cancel">Abbrechen</button>
        <button class="pl-add-cta" id="pl-ok">Speichern</button>
      </div>
    </div>`;
  document.getElementById('plans-content').appendChild(wrap);

  const updatePreview = async () => {
    const cur = document.getElementById('pl-currency').value;
    const amt = parseFloat(document.getElementById('pl-amount').value) || 0;
    const prev = document.getElementById('pl-fx-preview');
    if (cur === 'EUR' && amt > 0) prev.textContent = `≈ wird mit Tageskurs in USD umgerechnet`;
    else prev.textContent = '';
  };
  ['pl-amount','pl-currency'].forEach(id => document.getElementById(id).addEventListener('input', updatePreview));
  updatePreview();

  document.getElementById('pl-cancel').addEventListener('click', () => { _editing = null; _renderUI(); });
  document.getElementById('pl-ok').addEventListener('click', _submitEditor);
}

function _submitEditor() {
  const name = document.getElementById('pl-name').value.trim();
  const amount = parseFloat(document.getElementById('pl-amount').value);
  const currency = document.getElementById('pl-currency').value;
  const startsAt = document.getElementById('pl-start').value;
  const endVal = document.getElementById('pl-end').value;
  if (!name || !(amount >= 0) || !startsAt) { alert('Bitte Name, Betrag (≥ 0) und Start angeben.'); return; }
  const endsAt = endVal ? new Date(endVal).toISOString() : null;
  const rec = { id: _editing.id, provider: _editing.provider, name, amount, currency, startsAt: new Date(startsAt).toISOString(), endsAt };

  if (_editing._mode === 'edit') _plans = _plans.map(p => p.id === rec.id ? rec : p);
  else _plans = [..._plans, rec];
  if (_editing._mode === 'change' && _editing._fromId) {
    _plans = _plans.map(p => p.id === _editing._fromId ? { ...p, endsAt: rec.startsAt } : p);
  }
  _editing = null;
  _save().then(_renderUI);
}
```

- [ ] **Step 4: Verifizieren**

Run: `npm run lint && npm run build`
Manuell: Tab „Abos" → Leerzustand, Abo hinzufügen (USD & EUR), Bearbeiten, „Preis ändern ab…" (alter Plan endet, neuer startet), Löschen; nach Speichern bleiben Werte erhalten (`plans:get`).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/tabs/plans.js
git commit -m "feat(plans-ui): Abos tab renderer with CRUD, currency, price-change shortcut"
```

---

## Task 10: „Abos"-Tab — CSS & Politur

**Files:**
- Modify: `src/renderer/index.html` (`<style>`-Block)
- Verify: manueller Check

> Mit `/make-interfaces-feel-better` umsetzen: tabular-nums für Beträge, dezentes „aktiv"-Band (linker Akzentstreifen), weiche Modal-Einblendung, optische Ausrichtung der Spalten, Hover-States analog zu `.hr-*`/`.an-*`.

- [ ] **Step 1: Basis-CSS ergänzen**

Im `<style>`-Block einen Abschnitt `/* ══ PLANS TAB ═ */` mit Klassen `.pl-wrap, .pl-card, .pl-card-head, .pl-card-title, .pl-list, .pl-row, .pl-row.is-active, .pl-badge, .pl-row-name, .pl-row-meta, .pl-row-amt, .pl-mini, .pl-danger, .pl-empty, .pl-add-cta, .pl-modal, .pl-dialog, .pl-f, .pl-amt-wrap, .pl-fx-preview, .pl-fx-note` — Stil konsistent zu vorhandenen Tokens (`var(--bg-card)`, `var(--border)`, `var(--r-card)`, `--claude-col`/`--codex-col`). Beträge mit `font-variant-numeric: tabular-nums`.

- [ ] **Step 2: Politur anwenden**

`/make-interfaces-feel-better` auf den Tab anwenden (Marker/States/Transitions). Sicherstellen: `.pl-modal` overlay zentriert, Esc/Klick-außerhalb schließt (optional in `plans.js`).

- [ ] **Step 3: Verifizieren**

Manuell: visuelle Stimmigkeit mit den anderen Tabs; Dark-Theme; Beträge rechtsbündig & tabellarisch.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/index.html
git commit -m "style(plans-ui): styling and polish for Abos tab"
```

---

## Task 11: Chart.js Plan-Wechsel-Marker-Plugin

**Files:**
- Modify: `src/renderer/shared/charts.js`
- Verify: manueller Check

- [ ] **Step 1: Inline-Plugin + Helfer ergänzen**

In `src/renderer/shared/charts.js`:
```js
// Zeichnet vertikale Linien + Labels an Plan-Wechselpunkten.
// changes: [{ label, _index }] — _index = Position auf der Kategorie-X-Achse.
QB.charts.planChangePlugin = {
  id: 'planChanges',
  afterDatasetsDraw(chart, _args, opts) {
    const changes = opts?.changes;
    if (!Array.isArray(changes) || !changes.length) return;
    const { ctx, chartArea: { top, bottom }, scales: { x } } = chart;
    ctx.save();
    for (const ch of changes) {
      if (ch._index == null) continue;
      const px = x.getPixelForValue(ch._index);
      if (px == null || isNaN(px)) continue;
      ctx.strokeStyle = 'rgba(180,200,216,0.45)';
      ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(180,200,216,0.9)';
      ctx.font = "9px 'DM Sans', system-ui, sans-serif";
      ctx.save(); ctx.translate(px + 3, top + 4); ctx.fillText(ch.label, 0, 0); ctx.restore();
    }
    ctx.restore();
  },
};

// Bildet planChanges (mit `day`) auf Bucket-Indizes ab. dayKeys = sortierte Bucket-Tage.
QB.charts.mapChangesToIndex = function(changes, dayKeys) {
  if (!Array.isArray(changes)) return [];
  return changes.map(ch => {
    let idx = dayKeys.findIndex(d => d >= ch.day);
    if (idx === -1) idx = dayKeys.length - 1;
    return { label: ch.label, _index: idx };
  }).filter(c => c._index >= 0);
};
```
- Beim `createLine`/`createStackedBar` das Plugin registrieren: in den jeweiligen `new Chart(...)`-Aufrufen `plugins: [QB.charts.planChangePlugin]` ergänzen und Optionen via `plugins.planChanges = { changes }` durchreichen. Dazu `createLine(ctx, labels, datasets, opts)` erweitern: `opts.planChanges` (bereits index-gemappt) in `options.plugins.planChanges = { changes: opts.planChanges || [] }` setzen; analog `createStackedBar`.

- [ ] **Step 2: Verifizieren**

Run: `npm run build`
Manuell (nach Tasks 12/13): Marker erscheinen an Wechseltagen.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/shared/charts.js
git commit -m "feat(charts): plan-change vertical marker plugin"
```

---

## Task 12: Analytics — zeitvariabler ROI-Nenner + Marker + „kein Abo"

**Files:**
- Modify: `src/renderer/tabs/analytics.js`
- Verify: manueller Check

- [ ] **Step 1: Kumulativen ROI auf Tages-Sub-USD umstellen**

In `src/renderer/tabs/analytics.js` `_cumulativeRoiSeries` ersetzen, sodass der Nenner die tagesgenauen `claudeSubUSD`/`codexSubUSD` summiert:
```js
function _cumulativeRoiSeries(buckets, costKey, subKey) {
  let cumCost = 0, cumSub = 0;
  return buckets.map(b => {
    cumCost += b[costKey] ?? 0;
    cumSub  += b[subKey]  ?? 0;
    return cumSub > 0 ? cumCost / cumSub : null; // null = kein Abo-Baseline
  });
}
```
und im ROI-Zweig von `_buildLineChart` aufrufen mit `('claudeUSD','claudeSubUSD')` bzw. `('codexUSD','codexSubUSD')`. `data.subscriptionCostUSD`-Nutzung dort entfernen.

- [ ] **Step 2: „Kein Abo"-Zustand**

Wenn für den gewählten Zeitraum die Summe aller `*SubUSD` 0 ist und `_chartMode === 'roi'`: statt Linie einen Hinweis-Chip „Kein Abo hinterlegt — im Tab ‚Abos' einrichten" über dem Chart einblenden (kleines `div`, Klick wechselt zu `switchTab('plans')` falls global erreichbar, sonst nur Text). Kosten-Ansicht bleibt unberührt.

- [ ] **Step 3: Marker einbinden**

In `_buildLineChart` nach dem Erstellen der `labels`/`buckets`:
```js
const dayKeys = buckets.map(b => b.date);
const changes = QB.charts.mapChangesToIndex(data.planChanges || [], dayKeys);
```
und an `createLine(..., { yFormat, planChanges: changes })` übergeben.

- [ ] **Step 4: Verifizieren**

Run: `npm run build && npm run lint`
Manuell: ROI nutzt nun echte (zeitvariable) Abokosten; bei leerem Plan „kein Abo"; Marker an Wechseln.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/tabs/analytics.js
git commit -m "feat(analytics): time-varying ROI denominator, plan markers, no-plan state"
```

---

## Task 13: History — Plan-Wechsel-Marker

**Files:**
- Modify: `src/renderer/tabs/history.js`
- Verify: manueller Check

- [ ] **Step 1: planChanges aus Report durchreichen**

In `src/renderer/tabs/history.js` dort, wo der Balkenchart (`createStackedBar`) erzeugt wird (`_renderChart`): die Bucket-Tage als `dayKeys` bilden (`labels` sind bereits Buckets — bei daily = `YYYY-MM-DD`), und:
```js
const changes = QB.charts.mapChangesToIndex(_lastReport?.planChanges || [], labels);
```
`_lastReport` beim Laden in `_loadAndRender`/`_renderResults` merken (analog `_lastRows`). An `createStackedBar(ctx, labels, [...], { yFormat, planChanges: changes })` übergeben.

> Für nicht-tägliche Auflösungen (weekly/monthly/hourly) ist die Index-Zuordnung gröber; `mapChangesToIndex` wählt den ersten Bucket `>= day`. Akzeptabel; bei `hourly` ggf. leer.

- [ ] **Step 2: Verifizieren**

Run: `npm run build && npm run lint`
Manuell: History-Balkenchart zeigt dieselben Wechsel-Marker wie Analytics.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/tabs/history.js
git commit -m "feat(history): plan-change markers in bar chart"
```

---

## Task 14: Abschluss — Gesamtlauf & Aufräumen

**Files:** —

- [ ] **Step 1: Voller Lauf**

Run: `npm run build && npm run lint && npx vitest run`
Expected: alles grün.

- [ ] **Step 2: Manueller End-to-End-Check**

App starten. Szenarien:
- Kein Plan → Analytics ROI „kein Abo", Live-Faktor „Kein Abo hinterlegt".
- Claude-Plan „Pro" $20 ab Vergangenheit anlegen → ROI/Marker erscheinen.
- „Preis ändern ab…" auf $100 → alter Plan endet, neuer startet; Marker „Pro → Pro"/Label sichtbar; ROI knickt ab.
- Zweiter paralleler Claude-Account (€-Plan) → Overlap, Summe im Nenner; „+ …"-Marker; FX-Hinweis falls offline.

- [ ] **Step 3: Restzustand committen**

Falls noch ungetrackte ROI-Arbeit aus vorheriger Sitzung im Branch liegt, separat sinnvoll committen.

```bash
git add -A && git commit -m "chore: finalize subscription-plan-timeline feature"
```

---

## Self-Review-Ergebnis

- **Spec-Abdeckung:** Datenmodell (T1), FX täglich/historisch/Cache/Offline (T2), Engine + Proration/Overlap/Lücke (T3), Live-Faktor (T4), Analytics Sub-USD + planChanges (T5), IPC + Reports-Marker (T6), Settings-Cleanup (T7), Abos-Tab Gerüst/Logik/CSS (T8–T10), Chart-Marker (T11), Analytics-ROI/Marker/Leerzustand (T12), History-Marker (T13), Abschluss (T14). Alle Spec-Abschnitte abgedeckt.
- **Typkonsistenz:** `PlanPeriod`, `DailyBucket.claudeSubUSD/codexSubUSD`, `PlanChangePoint`, `FxLookup`/`makeFxLookup`, `dailySubCostUSD`/`periodSubCostUSD`/`planChangePoints` einheitlich über Tasks verwendet.
- **Platzhalter:** keine; Backend-Code vollständig. Frontend-Tasks enthalten konkreten Startcode; Politur via genannte Skills.

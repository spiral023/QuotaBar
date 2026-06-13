# Weekly-Serie Diskontinuitäten Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Weekly-Budget-Linie an Datenlücken (App war aus) und an server-seitigen Weekly-Resets unterbrechen, statt eine irreführende gerade Linie zu interpolieren.

**Architecture:** Erkennung im Serien-Builder ([src/main/windowBudgetSeries.ts](../../../src/main/windowBudgetSeries.ts)) als reine Funktion `insertBreaks`, die nach `removeSpikes` ausgeführt wird und an Bruchstellen einen `weeklyPct: null`-Sentinel einfügt. Der Renderer ([src/renderer/shared/charts.js](../../../src/renderer/shared/charts.js)) nutzt nur `spanGaps: false`, sodass Chart.js die Linie an `null` automatisch unterbricht.

**Tech Stack:** TypeScript, Vitest, Electron, Chart.js. Test: `vitest run`. Build/Typecheck: `tsc -p tsconfig.json` (`npm run build`).

---

## Spec

Vollständige Spezifikation: [docs/superpowers/specs/2026-06-13-weekly-series-discontinuities-design.md](../specs/2026-06-13-weekly-series-discontinuities-design.md)

## Dateien

- **Modify:** [src/main/windowBudgetSeries.ts](../../../src/main/windowBudgetSeries.ts) — `WeeklySeriesPoint.weeklyPct` nullable, Konstanten, `insertBreaks`, Null-Guard in `removeSpikes`, Verdrahtung in `readWeeklySeries`.
- **Modify:** [src/renderer/shared/charts.js](../../../src/renderer/shared/charts.js) — `spanGaps: false` im Weekly-Dataset.
- **Test:** [tests/windowBudgetSeries.test.ts](../../../tests/windowBudgetSeries.test.ts) — Unit-Tests für `insertBreaks` + Integrationstests durch `readWeeklySeries`.

---

## Task 1: `insertBreaks` (reine Funktion) + nullable Typ + Konstanten

**Files:**
- Modify: `src/main/windowBudgetSeries.ts`
- Test: `tests/windowBudgetSeries.test.ts`

- [ ] **Step 1: Failing Unit-Tests für `insertBreaks` schreiben**

Am Ende von `tests/windowBudgetSeries.test.ts` (vor der schließenden `});` des äußeren `describe` ODER als neuer `describe`-Block davor) einfügen. Import oben in der Datei ergänzen:

```ts
import { readWeeklySeries, insertBreaks, GAP_THRESHOLD_MS, WEEKLY_RESET_DROP_PCT } from "../src/main/windowBudgetSeries";
```

(ersetzt die bestehende Zeile `import { readWeeklySeries } from "../src/main/windowBudgetSeries";`)

Neuer Test-Block:

```ts
describe("insertBreaks", () => {
  const pt = (t: string, weeklyPct: number | null) => ({ t, weeklyPct });

  it("exportiert sinnvolle Schwellen", () => {
    expect(GAP_THRESHOLD_MS).toBe(60 * 60_000);
    expect(WEEKLY_RESET_DROP_PCT).toBe(15);
  });

  it("fügt Bruch bei großer Zeitlücke ein (auch ohne Sturz)", () => {
    const r = insertBreaks([
      pt("2026-06-12T08:00:00Z", 10),
      pt("2026-06-12T10:00:00Z", 12), // 2h Lücke, kein Sturz
    ]);
    expect(r.map((p) => p.weeklyPct)).toEqual([10, null, 12]);
  });

  it("fügt Bruch bei Weekly-Sturz ein", () => {
    const r = insertBreaks([
      pt("2026-06-12T08:00:00Z", 67),
      pt("2026-06-12T08:30:00Z", 1), // 30 min Lücke (< Schwelle), Sturz 66 > 15
    ]);
    expect(r.map((p) => p.weeklyPct)).toEqual([67, null, 1]);
  });

  it("kein Bruch bei dichten, monotonen Daten", () => {
    const r = insertBreaks([
      pt("2026-06-12T08:00:00Z", 10),
      pt("2026-06-12T08:30:00Z", 12),
      pt("2026-06-12T09:00:00Z", 15),
    ]);
    expect(r.map((p) => p.weeklyPct)).toEqual([10, 12, 15]);
  });

  it("kein Bruch bei einzelnem verpasstem Poll (< 60 min)", () => {
    const r = insertBreaks([
      pt("2026-06-12T08:00:00Z", 10),
      pt("2026-06-12T08:45:00Z", 11), // 45 min < 60 min
    ]);
    expect(r).toHaveLength(2);
  });

  it("gibt leere/einelementige Serie unverändert zurück", () => {
    expect(insertBreaks([])).toEqual([]);
    expect(insertBreaks([pt("2026-06-12T08:00:00Z", 5)])).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag verifizieren**

Run: `npx vitest run tests/windowBudgetSeries.test.ts -t insertBreaks`
Expected: FAIL — `insertBreaks`/`GAP_THRESHOLD_MS`/`WEEKLY_RESET_DROP_PCT` sind nicht exportiert (`is not a function` / `undefined`).

- [ ] **Step 3: Typ nullable machen, Konstanten + `insertBreaks` implementieren, `removeSpikes` Null-Guard**

In `src/main/windowBudgetSeries.ts`:

(a) Interface `WeeklySeriesPoint` ändern:

```ts
export interface WeeklySeriesPoint {
  t: string;
  weeklyPct: number | null; // null = Diskontinuität (Lücke oder server-seitiger Reset)
}
```

(b) Nach der bestehenden Konstante `const SPIKE_DELTA_PCT = 20;` (oben in der Datei) ergänzen:

```ts
/** Zeitabstand zwischen zwei Punkten, ab dem die Linie als Datenlücke unterbrochen wird (App war aus). */
export const GAP_THRESHOLD_MS = 60 * 60_000;
/** Sturz der Weekly-Auslastung (Prozentpunkte), ab dem ein server-seitiger Reset angenommen wird. */
export const WEEKLY_RESET_DROP_PCT = 15;
```

(c) In `removeSpikes` als erste Zeile der `filter`-Callback einen Null-Guard ergänzen (Sentinels nie filtern, und Typ-Korrektheit bei nullable `weeklyPct`):

```ts
function removeSpikes(points: WeeklySeriesPoint[]): WeeklySeriesPoint[] {
  if (points.length < 2) return points;
  return points.filter((p, i) => {
    if (p.weeklyPct === null) return true;
    const left = i > 0 ? points[i - 1].weeklyPct : null;
    const right = i < points.length - 1 ? points[i + 1].weeklyPct : null;
    const aboveLeft = left === null || p.weeklyPct - left > SPIKE_DELTA_PCT;
    const aboveRight = right === null || p.weeklyPct - right > SPIKE_DELTA_PCT;
    return !(aboveLeft && aboveRight);
  });
}
```

(d) Neue exportierte reine Funktion direkt unter `removeSpikes` ergänzen:

```ts
/**
 * Fügt zwischen zwei aufeinanderfolgenden Punkten einen `weeklyPct: null`-Sentinel
 * ein, wenn entweder eine Datenlücke (App war aus) oder ein server-seitiger Reset
 * (Sturz der Weekly-Auslastung) vorliegt. MUSS nach `removeSpikes` laufen, sonst
 * triggert ein transienter weekly-Spike (z. B. weekly=100) einen Falsch-Bruch.
 */
export function insertBreaks(points: WeeklySeriesPoint[]): WeeklySeriesPoint[] {
  if (points.length < 2) return points;
  const out: WeeklySeriesPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (prev.weeklyPct !== null && cur.weeklyPct !== null) {
      const prevMs = new Date(prev.t).getTime();
      const curMs = new Date(cur.t).getTime();
      const gap = curMs - prevMs > GAP_THRESHOLD_MS;
      const drop = prev.weeklyPct - cur.weeklyPct > WEEKLY_RESET_DROP_PCT;
      if (gap || drop) {
        out.push({ t: new Date((prevMs + curMs) / 2).toISOString(), weeklyPct: null });
      }
    }
    out.push(cur);
  }
  return out;
}
```

- [ ] **Step 4: Tests laufen lassen, Erfolg verifizieren**

Run: `npx vitest run tests/windowBudgetSeries.test.ts -t insertBreaks`
Expected: PASS (alle 6 `insertBreaks`-Tests grün).

- [ ] **Step 5: Commit**

```bash
git add src/main/windowBudgetSeries.ts tests/windowBudgetSeries.test.ts
git commit -m "feat: insertBreaks für Diskontinuitäten in der Weekly-Serie"
```

---

## Task 2: `insertBreaks` in `readWeeklySeries` verdrahten

**Files:**
- Modify: `src/main/windowBudgetSeries.ts:105` (die `return`-Zeile von `readWeeklySeries`)
- Test: `tests/windowBudgetSeries.test.ts`

- [ ] **Step 1: Failing Integrationstests schreiben**

Im bestehenden `describe("readWeeklySeries", ...)`-Block (z. B. vor dessen schließender `});`) einfügen:

```ts
it("unterbricht die Linie über eine Datenlücke (Builder-Integration)", async () => {
  await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
    snapLine("claude", 30, 50, "2026-06-09T08:00:00Z"),
    snapLine("claude", 31, 55, "2026-06-09T08:30:00Z"),
    snapLine("claude", 2,  2,  "2026-06-09T20:00:00Z"), // ~11.5h Lücke + Sturz
  ].join("\n"), "utf8");
  const s = await readWeeklySeries(dir, "claude", START, NOW);
  expect(s.points.map((p) => p.weeklyPct)).toEqual([50, 55, null, 2]);
});

it("transienter Spike erzeugt keinen Falsch-Bruch (removeSpikes vor insertBreaks)", async () => {
  const base = new Date("2026-06-09T08:00:00Z").getTime();
  const bucket = 30 * 60 * 1000;
  await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
    snapLine("claude", 5, 5,   new Date(base).toISOString()),
    snapLine("claude", 5, 100, new Date(base + bucket).toISOString()), // Spike nach oben
    snapLine("claude", 5, 8,   new Date(base + 2 * bucket).toISOString()),
  ].join("\n"), "utf8");
  const s = await readWeeklySeries(dir, "claude", START, NOW);
  // Spike entfernt → [5, 8], dicht & monoton → kein Sentinel
  expect(s.points.map((p) => p.weeklyPct)).toEqual([5, 8]);
});
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag verifizieren**

Run: `npx vitest run tests/windowBudgetSeries.test.ts -t "Datenlücke"`
Expected: FAIL — erwartet `[50, 55, null, 2]`, erhält `[50, 55, 2]` (noch kein Sentinel, da `insertBreaks` nicht verdrahtet).

- [ ] **Step 3: `readWeeklySeries`-Return anpassen**

In `src/main/windowBudgetSeries.ts`, die letzte Zeile von `readWeeklySeries`:

```ts
  return { points: removeSpikes(points), fiveHourResets: resets };
```

ersetzen durch:

```ts
  return { points: insertBreaks(removeSpikes(points)), fiveHourResets: resets };
```

- [ ] **Step 4: Komplette Test-Datei laufen lassen, Erfolg verifizieren**

Run: `npx vitest run tests/windowBudgetSeries.test.ts`
Expected: PASS (alle Tests grün, inkl. der bestehenden Spike-/Reset-Tests — die Reihenfolge `removeSpikes` → `insertBreaks` lässt sie unverändert).

- [ ] **Step 5: Commit**

```bash
git add src/main/windowBudgetSeries.ts tests/windowBudgetSeries.test.ts
git commit -m "feat: Brüche in readWeeklySeries einfügen"
```

---

## Task 3: Renderer — Linie an `null` unterbrechen

**Files:**
- Modify: `src/renderer/shared/charts.js:148-157` (das Weekly-Dataset in `QB.weeklyBudgetChart`)

- [ ] **Step 1: `spanGaps: false` ergänzen**

In `src/renderer/shared/charts.js`, im ersten Dataset (`label: 'Weekly'`) eine Zeile ergänzen. Vorher:

```js
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
```

Nachher:

```js
  const datasets = [{
    label: 'Weekly',
    data: histData,
    borderColor: '#4a9eda',
    backgroundColor: 'rgba(74,158,218,0.08)',
    borderWidth: 2,
    pointRadius: 0,
    fill: true,
    tension: 0.2,
    spanGaps: false, // null-Punkte (Lücke/Reset) unterbrechen Linie + Fläche
  }];
```

Hinweis: `histData` mappt bereits `y: p.weeklyPct`; ein `null`-Sentinel wird so zu `y: null`. Der `last`-Punkt für die Prognose-Linie (`histData[histData.length - 1]`) ist konstruktionsbedingt immer ein realer Punkt — Sentinels stehen nur *zwischen* zwei realen Punkten, nie am Ende. Keine weitere Änderung nötig.

- [ ] **Step 2: Build verifizieren (Renderer ist untestbar — Smoke via Build)**

Run: `npm run build`
Expected: PASS (kein TS-Fehler; charts.js ist JS und wird kopiert/nicht typgeprüft, aber der Build muss grün bleiben).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/shared/charts.js
git commit -m "feat: Weekly-Chart-Linie an Diskontinuitäten unterbrechen (spanGaps)"
```

---

## Task 4: Gesamtverifikation (Build + volle Test-Suite)

**Files:** keine (nur Verifikation)

- [ ] **Step 1: Typecheck/Build über das ganze Projekt**

Run: `npm run build`
Expected: PASS — bestätigt, dass die `weeklyPct: number | null`-Änderung keine anderen Konsumenten bricht (`analyticsWorker.ts` reicht die Serie nur durch; `live.js` ist JS).

- [ ] **Step 2: Volle Test-Suite**

Run: `npm test`
Expected: PASS — alle Tests grün.

- [ ] **Step 3: Manuelle Sichtprüfung (optional, empfohlen)**

Run: `npm run dev`
Erwartung: Im FENSTER-BUDGET-Graph der Claude-Karte ist die zuvor durchgezogene Abwärtslinie über die 22h-Lücke (12.→13.06.) jetzt **unterbrochen** — der 67 %-Anstieg bleibt links sichtbar, danach beginnt rechts eine neue Linie ab ~2 %, ohne verbindende Diagonale.

---

## Self-Review

- **Spec-Abdeckung:** Erkennungsregeln (a)+(b) → Task 1 `insertBreaks`. Konstanten 60min/15% → Task 1. Reihenfolge nach `removeSpikes` → Task 2 (Verdrahtung + Order-Test). Nullable Datenstruktur → Task 1. Renderer `spanGaps:false` → Task 3. Tests (a)–(f) → Task 1 (Unit) + Task 2 (Integration: Lücke, Spike-Order). `fiveHourResets` unverändert → keine Änderung an dieser Logik. ✓
- **Platzhalter:** keine. Aller Code ausgeschrieben. ✓
- **Typkonsistenz:** `insertBreaks`, `GAP_THRESHOLD_MS`, `WEEKLY_RESET_DROP_PCT`, `WeeklySeriesPoint.weeklyPct` durchgängig identisch benannt in Tests und Implementierung. ✓

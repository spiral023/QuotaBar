# Pace-Berechnung für QuotaBar

**Datum:** 2026-05-18  
**Status:** Approved  
**Scope:** Lineare Pace-Berechnung pro Provider-Fenster (weekly), Anzeige im Tray-Menü

---

## Ziel

Für das `weekly`-Fenster jedes Providers soll berechnet werden:
- Wie weit ist der Verbrauch im Vergleich zum erwarteten linearen Fortschritt?
- Wann läuft das Budget voraussichtlich aus (ETA)?
- In welchem „Stage" befindet sich der Verbrauch?

Das Ergebnis wird als eingerückte Pace-Zeile unter der bestehenden Fensterzeile im Tray-Menü angezeigt.

---

## Architektur

### Betroffene Dateien

| Datei | Änderungstyp | Beschreibung |
|---|---|---|
| `src/usage/usagePace.ts` | NEU | RateWindow-Adapter, UsagePace-Types, computeLinearPace |
| `src/providers/types.ts` | ÄNDERUNG | `pace?: UsagePace \| null` zu `UsageWindow` hinzufügen |
| `src/usage/refreshLoop.ts` | ÄNDERUNG | `attachPace()` nach jedem Fetch aufrufen |
| `src/main/menu.ts` | ÄNDERUNG | Pace-Zeile unter weekly-Window rendern |
| `tests/usagePace.test.ts` | NEU | 7 Testfälle mit Vitest |

### Datenfluss

```
provider.fetchUsage()
  → UsageSnapshot (weekly window ohne pace)
  → attachPace(snapshot, now)           ← refreshLoop.ts
      → toRateWindow(window)            ← Adapter
      → computeLinearPace(rateWindow, now)
      → window.pace = result            ← mutiert snapshot
  → usageStore.update(snapshot)
  → buildContextMenu(snapshots)         ← liest window.pace
      → snapshotToMenuLines()           ← rendert Pace-Zeile
```

---

## Datenmodell

### Erweiterung von `UsageWindow` (types.ts)

```typescript
export interface UsageWindow {
  name: "session" | "fiveHour" | "weekly" | "monthly" | "credits";
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string;
  windowSeconds?: number;
  label?: string;
  pace?: UsagePace | null;   // NEU
}
```

### Neue Types in `usagePace.ts`

```typescript
export type PaceStage =
  | 'onTrack'
  | 'slightlyAhead'
  | 'ahead'
  | 'farAhead'
  | 'slightlyBehind'
  | 'behind'
  | 'farBehind';

export interface UsagePace {
  stage: PaceStage;
  deltaPercent: number;          // actual − expected (positiv = ahead)
  expectedUsedPercent: number;
  actualUsedPercent: number;
  etaSeconds: number | null;     // Sekunden bis Budget leer
  willLastToReset: boolean;
}

export interface RateWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: Date | null;
}
```

---

## RateWindow-Adapter

`UsageWindow` und `RateWindow` unterscheiden sich in zwei Feldern:

| UsageWindow | RateWindow |
|---|---|
| `windowSeconds?: number` | `windowMinutes: number \| null` |
| `resetsAt?: string` (ISO) | `resetsAt: Date \| null` |

```typescript
function toRateWindow(w: UsageWindow): RateWindow {
  return {
    usedPercent: w.usedPercent ?? 0,
    windowMinutes: w.windowSeconds != null ? w.windowSeconds / 60 : null,
    resetsAt: w.resetsAt ? new Date(w.resetsAt) : null,
  };
}
```

---

## Berechnungslogik: `computeLinearPace`

Signatur: `computeLinearPace(window: RateWindow, now: Date = new Date()): UsagePace | null`

### Guards

```
if resetsAt == null → return null
windowMinutes = window.windowMinutes ?? 10080   // Default: 7 Tage
if windowMinutes <= 0 → return null

duration = windowMinutes * 60                   // Sekunden
timeUntilReset = (resetsAt.getTime() − now.getTime()) / 1000

if timeUntilReset <= 0 → return null            // Reset bereits vergangen
if timeUntilReset > duration → return null      // Reset zu weit in der Zukunft
```

### Elapsed & Expected

```
elapsed = clamp(duration − timeUntilReset, 0, duration)
expected = clamp((elapsed / duration) * 100, 0, 100)
actual   = clamp(window.usedPercent, 0, 100)

if elapsed == 0 && actual > 0 → return null     // Ungültiger Zustand
```

### Delta & Stage

```
delta = actual − expected
```

| |delta| | Stage |
|---|---|
| ≤ 2 | `onTrack` |
| ≤ 6 | `slightlyAhead` / `slightlyBehind` |
| ≤ 12 | `ahead` / `behind` |
| > 12 | `farAhead` / `farBehind` |

### ETA

```
if elapsed > 0 && actual > 0:
    rate = actual / elapsed
    if rate > 0:
        remaining = max(0, 100 − actual)
        candidate = remaining / rate
        if candidate >= timeUntilReset:
            willLastToReset = true
        else:
            etaSeconds = candidate

else if elapsed > 0 && actual == 0:
    willLastToReset = true
```

### Hilfsfunktion

```typescript
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
```

---

## Integration: attachPace (refreshLoop.ts)

```typescript
function attachPace(snapshot: UsageSnapshot, now: Date): void {
  for (const window of snapshot.windows) {
    if (window.name === 'weekly') {
      window.pace = computeLinearPace(toRateWindow(window), now);
    }
  }
}
```

Aufruf in `RefreshLoop` direkt nach `provider.fetchUsage()`, vor `usageStore.update()`.

---

## Menü-Display (menu.ts)

### Stage-Label-Mapping

| Stage | Label |
|---|---|
| `onTrack` | On track |
| `slightlyAhead` | Slightly ahead |
| `ahead` | Ahead |
| `farAhead` | Far ahead |
| `slightlyBehind` | Slightly behind |
| `behind` | Behind |
| `farBehind` | Far behind |

### Format-Regeln

- `onTrack`: kein Delta anzeigen (±2% ist Rauschen)
- alle anderen Stages: Delta in Klammern mit Vorzeichen und echtem Minus-Zeichen `−`
- `willLastToReset = true`: Suffix `· Lasts to reset`
- `etaSeconds != null`: Suffix `· Runs out in X` (via `formatTimeRemaining` auf abgeleitetes Datum)
- Einrückung mit zwei Leerzeichen für visuelle Hierarchie

### Beispiele

```
Claude: 45% (resets in 3d 20h)
  Pace: Behind (−42%) · Lasts to reset

Codex: 65% (resets in 2d 1h)
  Pace: Far ahead (+18%) · Runs out in 6h 20m

Claude: 51% (resets in 3d 14h)
  Pace: On track · Lasts to reset
```

### Implementierung in `snapshotToMenuLines`

Pace-Zeile wird nach der weekly-Window-Zeile eingefügt, wenn `window.pace != null`.

```typescript
function formatPaceLine(pace: UsagePace, now: Date): string {
  const labels: Record<PaceStage, string> = {
    onTrack: 'On track',
    slightlyAhead: 'Slightly ahead',
    ahead: 'Ahead',
    farAhead: 'Far ahead',
    slightlyBehind: 'Slightly behind',
    behind: 'Behind',
    farBehind: 'Far behind',
  };
  const label = labels[pace.stage];
  const delta = pace.stage !== 'onTrack'
    ? ` (${pace.deltaPercent >= 0 ? '+' : '−'}${Math.round(Math.abs(pace.deltaPercent))}%)`
    : '';
  const eta = pace.willLastToReset
    ? ' · Lasts to reset'
    : pace.etaSeconds != null
      ? ` · Runs out in ${formatTimeRemaining(new Date(now.getTime() + pace.etaSeconds * 1000).toISOString())}`
      : '';
  return `  Pace: ${label}${delta}${eta}`;
}
```

---

## Tests (usagePace.test.ts)

7 Pflicht-Testfälle mit Vitest:

| # | Szenario | Erwartetes Ergebnis |
|---|---|---|
| 1 | elapsed=50%, actual=50% | delta=0, stage=`onTrack`, willLastToReset=true |
| 2 | elapsed=30%, actual=45% | delta=+15, stage=`farAhead` |
| 3 | elapsed=50%, actual=80% | etaSeconds gesetzt, willLastToReset=false |
| 4 | resetsAt=null | return null |
| 5 | elapsed=0, actual=0 | willLastToReset=true (kein ETA) |
| 6 | elapsed=0, actual>0 | return null (ungültiger Zustand) |
| 7 | timeUntilReset > duration | return null |

---

## Nicht im Scope (MVP)

- Historische Pace (gewichteter Median über Vorwochen) — spätere Erweiterung
- Custom BrowserWindow-Popover (wie im CodexBar-Screenshot) — natürliche nächste UI-Ausbaustufe
- Pace für andere Fenster (session, fiveHour, credits)

# Lade-Indikator statt "No provider data" beim App-Start

**Datum:** 2026-05-25
**Status:** Genehmigt

## Problem

Beim App-Start zeigt das Dashboard-Fenster sofort "No provider data", obwohl die Daten noch geladen werden. Der erste Refresh-Zyklus ist asynchron; bis er abgeschlossen ist, ist `lastSnapshots` leer. Das ist irreführend — "No provider data" bedeutet eigentlich "keine Provider konfiguriert", nicht "Daten werden noch geladen".

## Lösung

`null` als semantisches Signal für "noch nicht geladen" verwenden. Damit unterscheidet sich der Lade-Zustand klar von einem echten Leer-Zustand (keine Provider konfiguriert).

## Änderungen

### `src/main/detailsWindow.ts`

- `lastSnapshots: UsageSnapshot[] = []` → `lastSnapshots: UsageSnapshot[] | null = null`
- `pushUpdate()` sendet `snapshots: null` so lange, bis `notifyUpdate()` zum ersten Mal aufgerufen wurde
- Nach dem ersten echten Refresh enthält `lastSnapshots` nie wieder `null`

### `src/renderer/tabs/live.js`

`renderLive(snapshots)` bekommt drei Fälle:

| snapshots | Anzeige |
|-----------|---------|
| `null` | Pulsierende Punkte (Lade-Indikator) |
| `[]` | "No provider data" (echte Leerkonfiguration) |
| `[...]` | Normale Card-Ansicht |

**Animation:** Drei Punkte mit gestaffeltem `opacity`-Fade via CSS `@keyframes`. Farbe `#52d017` (bestehendes Theme-Grün), zentriert wie die bestehende `.empty`-Klasse.

### `src/renderer/index.html`

Der `quota:update`-IPC-Handler übergibt `data.snapshots` direkt an `render()`. Da `data.snapshots` nun `null` sein kann, muss `render(null)` korrekt weitergeleitet werden — keine weitere Logik nötig.

## Nicht im Scope

- Skeleton-Loader (zu aufwändig für den Nutzen)
- Timeout-Fallback nach X Sekunden (eigenes Feature)
- Änderungen am Refresh-Zyklus selbst

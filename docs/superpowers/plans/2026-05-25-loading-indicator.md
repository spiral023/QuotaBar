# Loading Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pulsierende Punkte als Lade-Indikator beim App-Start anzeigen, statt "No provider data".

**Architecture:** `null` als semantisches Signal in `lastSnapshots` — unterscheidet "noch nicht geladen" (`null`) von "keine Provider konfiguriert" (`[]`). Main-Prozess sendet `null` bis zum ersten echten Refresh. Renderer rendert bei `null` drei animierte Punkte, bei `[]` die bestehende Leer-Meldung.

**Tech Stack:** TypeScript (Electron Main), Vanilla JS (Renderer), CSS `@keyframes`

---

### Task 1: `lastSnapshots` auf `null`-Start umstellen

**Files:**
- Modify: `src/main/detailsWindow.ts:30`

- [ ] **Schritt 1: Typ und Initialwert ändern**

In `src/main/detailsWindow.ts` Zeile 30 ändern:

```typescript
// vorher:
private lastSnapshots: UsageSnapshot[] = [];

// nachher:
private lastSnapshots: UsageSnapshot[] | null = null;
```

- [ ] **Schritt 2: TypeScript-Build prüfen**

```
npm run build
```

Erwartetes Ergebnis: kein Fehler. Falls TypeScript meldet, dass `null` irgendwo nicht als `UsageSnapshot[]` passt, folgt Schritt 3.

- [ ] **Schritt 3: Typen-Fehler in `pushUpdate` und `notifyUpdate` beheben (nur wenn nötig)**

`pushUpdate` und `notifyUpdate` übergeben `lastSnapshots` direkt an das IPC-Event als serialisierten Wert — `null` ist dort valid (JSON-serialisierbar). Falls der Compiler trotzdem meckert: den Typ des IPC-Payloads in `pushUpdate` auf `UsageSnapshot[] | null` explizit annotieren:

```typescript
private pushUpdate(): void {
  if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
  this.win.webContents.send("quota:update", {
    snapshots: this.lastSnapshots,          // null | UsageSnapshot[]
    lastRefreshedAt: this.lastRefreshedAt?.toISOString() ?? null,
  });
}
```

- [ ] **Schritt 4: Build erneut prüfen**

```
npm run build
```

Erwartetes Ergebnis: kein Fehler.

- [ ] **Schritt 5: Committen**

```bash
git add src/main/detailsWindow.ts
git commit -m "feat(loading): start lastSnapshots as null to signal initial load"
```

---

### Task 2: CSS-Animation für pulsierende Punkte

**Files:**
- Modify: `src/renderer/index.html` (Style-Block, Bereich `/* ── Empty / loading ──`)

- [ ] **Schritt 1: Keyframe und Klassen einfügen**

In `src/renderer/index.html` im `<style>`-Block, direkt **nach** der `.spinner`-Regel (nach Zeile ~458, vor `/* ══ SETTINGS`), folgendes einfügen:

```css
    @keyframes pulse-dot {
      0%, 80%, 100% { opacity: 0.15; }
      40%           { opacity: 1; }
    }
    .loading-dots {
      display: flex; gap: 5px; align-items: center;
    }
    .loading-dots span {
      width: 6px; height: 6px; border-radius: 50%;
      background: #52d017;
      animation: pulse-dot 1.2s ease-in-out infinite;
    }
    .loading-dots span:nth-child(2) { animation-delay: 0.2s; }
    .loading-dots span:nth-child(3) { animation-delay: 0.4s; }
```

- [ ] **Schritt 2: Committen**

```bash
git add src/renderer/index.html
git commit -m "feat(loading): add pulsing dots CSS animation"
```

---

### Task 3: `renderLive` für `null` erweitern

**Files:**
- Modify: `src/renderer/tabs/live.js:222-235`

- [ ] **Schritt 1: Null-Zweig in `renderLive` einfügen**

In `src/renderer/tabs/live.js` die Funktion `QB.renderLive` ersetzen:

```javascript
QB.renderLive = function renderLive(snapshots) {
  const el = document.getElementById('content');
  stopCd();
  _countdowns = [];
  if (snapshots === null) {
    el.innerHTML = '<div class="empty"><div class="loading-dots"><span></span><span></span><span></span></div></div>';
    return;
  }
  if (!snapshots || snapshots.length === 0) {
    el.innerHTML = '<div class="empty"><span>No provider data</span></div>';
    return;
  }
  const overview = renderOverview(snapshots);
  const cards    = snapshots.map((snap, i) => renderCard(snap, i + 1)).join('');
  const tip      = renderTip(snapshots);
  el.innerHTML   = overview + cards + tip;
  startCd();
};
```

Wichtig: `snapshots === null` muss **vor** `!snapshots || snapshots.length === 0` stehen, da `null` sonst vom bestehenden Check abgefangen wird.

- [ ] **Schritt 2: Committen**

```bash
git add src/renderer/tabs/live.js
git commit -m "feat(loading): show pulsing dots when snapshots not yet loaded"
```

---

### Task 4: Manuelle Verifikation

- [ ] **Schritt 1: App starten**

```
npm start
```

- [ ] **Schritt 2: Dashboard sofort nach Start öffnen**

Tray-Icon anklicken, bevor der erste Refresh-Zyklus abgeschlossen ist (erste ~1–3 Sekunden nach Start). Erwartetes Ergebnis: drei pulsierende grüne Punkte im Content-Bereich.

- [ ] **Schritt 3: Warten bis Daten laden**

Nach dem ersten Refresh (Provider-Daten kommen an): Punkte verschwinden, echte Provider-Cards erscheinen automatisch.

- [ ] **Schritt 4: Leerzustand prüfen**

Wenn kein Provider konfiguriert ist (oder alle Provider deaktiviert), muss nach dem ersten Refresh weiterhin "No provider data" erscheinen — **nicht** die Lade-Punkte.

# TESTING.md

Wie man QuotaBar testet — Unit-Tests und Live-GUI-Verifikation.

## Unit-Tests

```bash
npm test          # vitest run
npm run build     # tsc — vor Abschluss immer beides ausführen
```

## Live-GUI-Test (Renderer im echten Electron)

UI-Änderungen im Renderer (`src/renderer/`) lassen sich automatisiert in einem
echten Electron-Fenster mit echten IPC-Handlern und echten Backfill-Daten
verifizieren — ohne die laufende QuotaBar-Instanz zu stören.

### Warum nicht einfach `npm run dev`?

- `main.ts` hält einen **Single-Instance-Lock** — läuft QuotaBar bereits
  (Tray), beendet sich eine zweite Instanz sofort.
- Das Fenster öffnet sich nur per Tray-Klick, was sich schlecht automatisieren
  lässt.

### Rezept

Alle IPC-Handler (`reports:get`, `settings:get`, …) werden im Konstruktor von
`DetailsWindowController` registriert. Ein minimaler Einstiegspunkt genügt
daher (kein Tray, kein Lock, keine Refresh-Loops):

**1. `verify-main.cjs`** (temporär im Repo-Root):

```js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { DetailsWindowController } = require('./dist/main/detailsWindow.js');

app.whenReady().then(async () => {
  new DetailsWindowController(() => null, undefined); // echte IPC-Handler
  const win = new BrowserWindow({
    width: 900, height: 660, frame: false, backgroundColor: '#090c10',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await win.loadFile(path.join(__dirname, 'src/renderer/index.html'));
});
```

**2. `verify-drive.cjs`** — Steuerung über `playwright-core` (bereits in den
devDependencies):

```js
const { _electron } = require('playwright-core');

// WICHTIG: VSCode/Claude-Umgebungen setzen ELECTRON_RUN_AS_NODE=1 —
// damit startet Electron als reines Node und `require('electron')`
// liefert kein app-Objekt ("Process failed to launch").
delete process.env.ELECTRON_RUN_AS_NODE;

(async () => {
  const app  = await _electron.launch({ args: ['verify-main.cjs'], cwd: __dirname });
  const page = await app.firstWindow();          // normale Playwright-Page
  await page.waitForLoadState('domcontentloaded');

  // Dashboard-Modus erzwingen (Tab-Navigation ist im Compact-Modus versteckt)
  await page.evaluate(() => {
    document.body.classList.add('view-dashboard');
    document.body.classList.remove('view-compact');
  });

  await page.click('#tab-history');
  await page.screenshot({ path: 'verify.png' });

  // Auch der Main-Prozess ist erreichbar, z. B. für Fenstergrößen-Tests:
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(750, 660); // Minimalbreite Dashboard
  });

  await app.close();
})();
```

Ausführen mit `node verify-drive.cjs`.

### Nützliche Mess-Muster

- **„Alles in einer Zeile?"** — eindeutige `top`-Werte der Flex-Kinder zählen:

  ```js
  const tops = [...new Set([...bar.children].map(e => Math.round(e.getBoundingClientRect().top)))];
  // tops.length > 2 (Höhenvarianz eingerechnet) → Umbruch
  ```

- **Platzbudget** — Kindbreiten + Gaps aufsummieren und mit der verfügbaren
  Content-Breite vergleichen; so weiß man exakt, wie viele Pixel fehlen.
- **Screenshots** mit dem Read-Tool ansehen, aber Layout-Aussagen immer
  zusätzlich messen — Pixel lügen nicht, Augen schon.

### Rahmenbedingungen

- Vorher `npm run build`, falls `src/main/` geändert wurde (der Renderer wird
  direkt aus `src/renderer/` geladen und braucht keinen Build).
- Relevante Fenstergrößen: Dashboard 900×660 (Standard), 750×520 (Minimum),
  Compact 340×560.
- Die `verify-*.cjs`-Dateien und Screenshots sind Wegwerf-Artefakte: nach der
  Verifikation löschen, nicht committen.

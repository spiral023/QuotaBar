# Testing QuotaBar

How to run unit tests and verify QuotaBar in a real Electron window.

## Unit tests

```bash
npm test          # vitest run
npm run build     # tsc — always run both before completion
```

## Live renderer verification in Electron

Renderer changes under `src/renderer/` must be checked in a real Electron window with real IPC handlers. Use an isolated entry point so the running QuotaBar tray instance and production data remain untouched.

### Why not use `npm run dev`?

- `main.ts` holds a single-instance lock. If QuotaBar is already running in the tray, a second instance exits immediately.
- The app window normally opens through the tray, which is awkward to automate.

### Isolated recipe

All view IPC handlers are registered by `DetailsWindowController`. A minimal temporary entry point is sufficient—no tray, lock, or refresh loops.

1. Create `verify-main.cjs` temporarily in the repository root:

```js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { DetailsWindowController } = require('./dist/main/detailsWindow.js');

app.whenReady().then(async () => {
  new DetailsWindowController(() => null, undefined);
  const win = new BrowserWindow({
    width: 900, height: 660, frame: false, backgroundColor: '#090c10',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await win.loadFile(path.join(__dirname, 'src/renderer/index.html'));
});
```

2. Create `verify-drive.cjs` to control it through the existing `playwright-core` dependency:

```js
const { _electron } = require('playwright-core');

// Editor and agent environments may set this. Electron must not run as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

(async () => {
  const electronApp = await _electron.launch({ args: ['verify-main.cjs'], cwd: __dirname });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  await page.evaluate(() => {
    document.body.classList.add('view-dashboard');
    document.body.classList.remove('view-compact');
  });

  await page.click('#tab-history');
  await page.screenshot({ path: 'verify.png' });

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(750, 660);
  });

  await electronApp.close();
})();
```

Run it with `node verify-drive.cjs`.

### Useful measurement patterns

- To detect wrapping, count unique `top` positions of flex children:

  ```js
  const tops = [...new Set([...bar.children].map((element) => Math.round(element.getBoundingClientRect().top)))];
  // More than two positions, allowing for height variance, indicates wrapping.
  ```

- For a width budget, add child widths and gaps and compare them with the available content width.
- Inspect screenshots visually, but also measure layout in the page; screenshots alone do not prove dimensions or overflow.

### Portable cross-user fixture test

Never run archive tests against `%USERPROFILE%\.quotabar-win`. Create disposable homes under `%TEMP%`, pass those exact directories to the portable store and archive APIs, and remove the fixture tree afterward.

```powershell
$fixtureRoot = Join-Path $env:TEMP ("quotabar-portable-" + [guid]::NewGuid())
$aliceHome = Join-Path $fixtureRoot "Alice"
$bobHome = Join-Path $fixtureRoot "Bob"
New-Item -ItemType Directory -Force $aliceHome, $bobHome | Out-Null
```

The automated or temporary harness must then:

1. Set Alice's app directory to `$aliceHome\.quotabar-win` and populate it only through portable store APIs with synthetic usage, quota, and machine-independent settings. Use a synthetic configured root such as `C:\Users\Alice\.claude`; do not copy provider credentials or logs.
2. Export Alice's portable archive and verify its manifest. Assert that it contains no `auth.json`, `.credentials.json`, provider JSONL source logs, app logs, caches, backup directories, or ingestion state.
3. Set Bob's app directory to `$bobHome\.quotabar-win`, stage Alice's portable export, and apply the pending import. Separately verify that the automatic backup exists outside Bob's app directory under `$bobHome\QuotaBar Backups\`, matches the recorded size and checksum, and can be reopened with every entry readable. Never pass the automatic backup to System Import: it is a private full same-machine recovery artifact, not a portable archive.
4. Assert replacement semantics: Bob's previous portable statistics/settings are absent and Alice's synthetic portable values are present. Do not expect a merge.
5. Load Bob's settings and System data. Assert that no active Claude or Codex root starts with `C:\Users\Alice`, that target roots resolve under Bob's fixture home, and that the only reported migration value is one of `pending`, `running`, `complete`, or `failed`.
6. Launch the isolated Electron harness with Bob's fixture environment, open **System**, and verify the QuotaBar panel shows the expected `Portable data` state plus the Export and Import controls. Select only Alice's portable export ZIP in System Import. Confirm replacement and backup copy, then cancel before any second import; never select an automatic backup ZIP there.
7. Close Electron and remove `$fixtureRoot` in a `finally` block. Also remove temporary `verify-*.cjs` files and screenshots.

When launching fixture Electron processes, override both `USERPROFILE` and `HOME` before importing QuotaBar modules, and give Electron a fixture-only `userData` directory. Print fixture paths and counts only—never file contents, tokens, cookies, authorization headers, or JWTs.

### Verification conditions

- Run `npm run build` first when `src/main/` changed. Renderer files are loaded directly.
- Check Dashboard at 900×660 and 750×520, and Compact at 340×560.
- In the System panel, visually verify `Portable data: Ready`, `Portable data: Preparing`, and `Portable data: Needs attention` with synthetic states. Confirm the status does not expose migration-file contents.
- Temporary harnesses, fixture data, ZIP files, and screenshots are disposable artifacts and must not be committed.

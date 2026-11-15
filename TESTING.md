# Testing QuotaBar

How to run unit tests and verify QuotaBar in a real Electron window.

## Unit tests

```bash
npm run typecheck # strict source and test typecheck
npm test          # vitest run
npm run build     # tsc — always run both before completion
```

## Automated Electron smoke test

Use the Node version in `.nvmrc` and the npm version declared in `package.json`.

```bash
npm ci
npm run verify
npm run test:electron
npm run package
```

`test:electron` launches the actual Electron runtime with real IPC handlers and
synthetic usage in a disposable home. It checks seven tabs at 900×660 and
750×520, the compact window, portable Ready/Preparing/Needs attention states,
import/export cancellation, renderer sandbox settings, blocked navigation and
window creation, invalid inputs, and rejection of an unregistered window.
Screenshots are written to ignored `package-output/smoke/` for visual review.
The fixture is removed in `finally`. It never starts provider polling or reads
production credentials. Installer and auto-update installation still need a
separate acceptance test; building an installer alone does not prove installation.

Maintenance validation on 2026-11-14 used Node 22.23.4, npm 11.21.1 and Electron
45.3.2. The full suite passed 1,491 tests (seven subprocess fixtures skipped in
the ordinary parent run), plus strict typecheck, lint, build and the live smoke
test including onboarding. Setup, portable and ZIP builds succeeded. Fifty
runtime files in `app.asar` matched the working build, including the bundled
preload, renderer modules, CSS, Chart.js and local font assets/licenses.

The setup installer was also installed, launched and silently uninstalled in a
network-isolated Windows Sandbox. Product version was 2.3.1.0 and user settings
survived the default uninstall. The host installation was not used for this
acceptance test. A real auto-update installation was not exercised.

## Live renderer verification in Electron

Renderer changes under `src/renderer/` must be checked in a real Electron window with real IPC handlers. Use an isolated entry point so the running QuotaBar tray instance and production data remain untouched.

### Why not use `npm run dev`?

- `main.ts` holds a single-instance lock. If QuotaBar is already running in the tray, a second instance exits immediately.
- The app window normally opens through the tray, which is awkward to automate.

### Isolated recipe

All view IPC handlers are registered by `DetailsWindowController`. A minimal temporary entry point is sufficient—no tray, lock, or refresh loops. The driver creates a disposable home first; the Electron entry point applies that home before importing any QuotaBar module.

1. Create `verify-main.cjs` temporarily in the repository root:

```js
const path = require('path');
const { app } = require('electron');

const fixtureRoot = process.env.QB_FIXTURE_ROOT;
if (!fixtureRoot) throw new Error('QB_FIXTURE_ROOT is required');
process.env.USERPROFILE = fixtureRoot;
process.env.HOME = fixtureRoot;
app.setPath('userData', path.join(fixtureRoot, 'electron-user-data'));

// Import only after the fixture environment and Electron userData are isolated.
const { DetailsWindowController } = require('./dist/main/detailsWindow.js');

app.whenReady().then(() => {
  global.verifyController = new DetailsWindowController(() => null, undefined);
  global.verifyController.open(() => {});
});
```

2. Create `verify-drive.cjs` to control it through the existing `playwright-core` dependency:

```js
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');

// Editor and agent environments may set this. Electron must not run as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

(async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'quotabar-renderer-'));
  let electronApp;
  try {
    electronApp = await _electron.launch({
      args: ['verify-main.cjs'],
      cwd: __dirname,
      env: {
        ...process.env,
        QB_FIXTURE_ROOT: fixtureRoot,
        USERPROFILE: fixtureRoot,
        HOME: fixtureRoot,
      },
    });
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await page.evaluate(() => {
      document.body.classList.add('view-dashboard');
      document.body.classList.remove('view-compact');
    });

    await page.click('#tab-system');
    await page.screenshot({ path: path.join(fixtureRoot, 'verify.png') });

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(750, 660);
    });
  } finally {
    if (electronApp) await electronApp.close();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
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
- Check Dashboard at 900×660 and 750×520, and Compact at its current minimum size, 411×672.
- In the System panel, visually verify `Portable data: Ready`, `Portable data: Preparing`, and `Portable data: Needs attention` with synthetic states. Confirm the status does not expose migration-file contents.
- Temporary harnesses, fixture data, ZIP files, and screenshots are disposable artifacts and must not be committed.


### Persisted daily metrics

`PortableUsageStore.readDaily(timeZone, range)` caches additive provider/model
metrics by local calendar day. Daily, weekly and monthly portable reports and
Models consume these rows. Hourly, project, instance and session reports, plus
detailed activity/session analytics, retain canonical event reads.

The cache is disposable (`usage/daily-rollups/` and
`usage/daily-rollups-revision`), excluded from portable exports, and scoped by
schema version, timezone, partition identities and a durable write generation.
The generation changes under the portable root lock before source writes,
including append and interrupted-transaction recovery. Metadata-only ingestion
checkpoints preserve the cache. A corrupt/stale/unwritable cache falls back to
canonical data. Partial instant ranges read the affected boundary groups from
canonical events; stored cost components are reconciled per event before summing.
Missing pricing evidence remains unavailable in Models.

Run `node tools/benchmark-rollups.cjs` after building, with the declared Node
runtime. It compares raw, first-cache and fresh-process cached daily reports on
100,000 synthetic events, checks numerical equivalence at six decimal places,
and asserts zero JSONL reads on cache hits. It cleans its own disposable home.
Tracked source changes rebuild only affected UTC-month contributions, then
merge local-day rows. Untracked external changes rebuild the full snapshot with
global ID deduplication. Run `node tools/benchmark-incremental-rollups.cjs` to
measure a daily read after one changed month with canonical-result verification.

### Real installed auto-update test

Run `npm run test:update` on Windows with Windows Sandbox enabled. The test
builds NSIS versions 2.3.1 and 2.3.2 from the current source with a guest-local
generic update feed. The repository version, public releases and host
installation remain unchanged. Publishing is disabled.

The guest installs into a custom directory, seeds synthetic settings/usage,
starts the production packaged app, and controls its real renderer over CDP.
It verifies rejection of a deliberately wrong SHA-512, retries a valid download,
clicks **Install update**, and observes the new executable version and automatic
relaunch. Only after that observation does it reopen with CDP to verify the new
version, retained settings and identical canonical usage bytes, plus an idle
update check with no newer version. Development updater stubs are not used.

Builds and result JSON/screenshots are under `package-output/update-smoke/`.
The read-only guest mapping contains only those fixture builds; the writable
mapping contains only that run's results. Guest networking, clipboard, camera
and microphone are disabled. The HTTP server listens on guest loopback.
The guest shuts down afterward. A failed run reports its artifact directory.
The test does not cover public GitHub/CDN delivery, certificate signing or
SmartScreen reputation. It must not be added as an unattended CI release step.

The installed test also exercises custom-directory NSIS detection and the
first packaged CLI argument (`--open-window`). These regressions have focused
unit coverage in `appIdentity.test.ts` and `cli.test.ts`.

Automatic relaunch must now be a newly created main process, excluding Chromium
children, with the updated version's startup recorded before the separate CDP
verification launch. Older runs observed any surviving QuotaBar PID; that alone
did not prove a successful automatic main-process restart. A failure reports its
phase and leaves `dataRetained` null until the data comparison actually runs.
Credential-free guest process traces and startup diagnostics distinguish a failed
automatic launch from changed usage data. Diagnostic manual starts never count
as a passing automatic relaunch.

The live updater pushes `update:state` to the existing System panel. Only the
version/update panel is replaced, preserving drafts and transfer dialogs. The
Electron smoke test checks progress, the install button and an edited root field;
the installed test requires the button to appear without navigation or reload.
The usage checksum baseline is captured after the original app finishes startup
migration/cost enrichment, with the seeded token and cost values checked before
installing. This separates normal initial serialization from update retention.
Imported ISO timestamps with offsets remain individual derived rows so lexical
ordering cannot distort exact instant ranges.


### Maintenance verification — 2026-11-14

Validated on Node 22.23.4/npm 11.21.1 after a clean `npm ci`: strict TypeScript
7 checks, ESLint, 1,519 passing tests (seven subprocess fixture placeholders
skipped), build, isolated live Electron 45.3.2 smoke and all Windows package
targets (NSIS, portable EXE, ZIP). Full and production npm audits both reported
zero vulnerabilities. No first-party source file exceeds 1,500 lines.

The real installed update 2.3.1 → 2.3.2 passed in Windows Sandbox, including bad
SHA-512 rejection, retry, the live Install button, NSIS replacement, automatic
relaunch, retained settings and byte-identical canonical usage after the settled
baseline. The updated System UI reported 2.3.2/Installed/Up to date; its final
check found no newer version. Missing old blockmap metadata exercised the real
full-download fallback. Differential patch download itself was not validated.
Both fixture ASARs matched 170 current runtime files. The standard package build
retains the GitHub provider; guest-local feed configuration is fixture-only.

This run's local evidence is `package-output/update-smoke/results-1794671170124/`
(`result.json`, `verified.json` and the checksum-error/ready/updated screenshots).
These disposable files are ignored by Git. No public release was published and
no host installation was replaced. GitHub/CDN delivery, signing and SmartScreen
remain outside this isolated validation.


### Renderer and module maintenance — 2026-11-15

The real Electron smoke now includes reverse-order analytics responses,
invalidation during an outstanding request, literal markup in update errors and
versions, distinct sub-dollar cost-axis labels, and retained settings drafts.
The tests intercept only fixture analytics responses; provider polling remains
disabled. Screenshots include `analytics-request-order.png` and
`system-literal-update-error.png` under `package-output/smoke/`.

`npm run typecheck` checks application/tests plus the renderer IPC helper and
analytics data loader with `checkJs`. Compile-only IPC checks reject unknown
channels, invalid date arguments and nonexistent response fields. Other legacy
renderer scripts remain JavaScript and are covered by unit/live tests.

`npm run test:coverage` produces text, HTML and JSON summaries in ignored
`coverage/`. Its scope is authentication, portable persistence/archive modules,
updater orchestration/state and shared activity metrics; it is not whole-app or
real-Electron coverage. Token refresh tests mock persistence and HTTP. Updater
unit tests mock Electron/updater events and timers; installed acceptance remains
the separate Windows Sandbox test above.


Final validation on 2026-11-15: clean npm ci, strict application/test/renderer
checks, ESLint, 1,545 passing tests (seven child-fixture placeholders skipped),
coverage with 92.32% lines and 83.38% branches in the selected scope, build and
isolated Electron 45.3.2 smoke all passed. The latest renderer regressions include
active-view reload after settings invalidation and rendering prefetched replacement
data on tab reentry. NSIS, portable EXE and ZIP builds succeeded. Both npm audits
reported zero known vulnerabilities.

The installed Sandbox test passed installation, bad SHA-512 rejection,
valid retry/download, the real install action, automatic relaunch and retained
settings/usage. Its two fixture installers contain 183 runtime files matching the
current build/source, allowing text line-ending normalization. Public delivery,
code signing and SmartScreen reputation remain outside this fixture test.

### Final review verification — 2026-11-15

After the final review corrections, `npm run verify` passed on Node 22.23.4/npm
11.21.2: application/test/renderer typechecks, lint, 1,556 tests and build. Seven
child-fixture placeholders remain intentionally skipped. Coverage passed with
92.37% lines and 83.57% branches in the selected scope described above. Both full
and production-only npm audits reported zero known vulnerabilities.

The real Electron smoke passed all seven tabs at both window sizes, compact and
onboarding views, request-order/cache-invalidation regressions, literal update
markup and retained settings drafts. NSIS, portable EXE and ZIP packaging passed.
All runtime source modules are below 1,000 lines; the largest is 988 lines.

The final installed Sandbox acceptance also passed checksum rejection, retry,
download, installation, automatic relaunch, retained settings and canonical usage,
and the final no-newer-update check. Both fixture installers matched 183 runtime
files. Evidence is in `package-output/update-smoke/results-1794703161632/`, including
`result.json`, `verified.json`, `rejected-checksum.png`, `ready-to-install.png` and
`updated-system.png`. This remains a guest-local feed test with the public-delivery,
signing and SmartScreen boundaries stated above.

Review findings and their regression coverage are recorded in
`docs/reviews/2026-11-15-maintenance-final-review.md`.

### Large-history performance and retention

Build first with the declared Node/npm versions, then run from the repository root:

```powershell
node --expose-gc tools/benchmark-store.cjs
node --expose-gc tools/benchmark-pipelines.cjs 250000
node --expose-gc tools/benchmark-cache-churn.cjs
node --expose-gc tools/soak-runtime.cjs 30 100000
node tools/electron-soak.cjs 30
```

All inputs and homes are synthetic and disposable. The pipeline test reads real
JSONL files, uses deterministic local price enrichment, exports a portable ZIP,
stages it over an existing large destination with a backup, applies it and checks
canonical event equality through the same previously warmed destination store.
Store tests also check insert/update/existing counts and canonical result hashes.

`compare-write-performance.cjs <baseline-dist>` alternates three fresh processes
per version/workload at 100,000 and 250,000 events. The baseline must be built with
the same compiler/dependencies/runtime. Its parent directory needs the matching
`package.json`, as in a normal checkout/build. `QB_BENCHMARK_DIST` also selects a
compiled tree for individual store/pipeline/cache-churn runs. Run timing comparisons
without concurrent QuotaBar tests, builds or soak processes. See PERFORMANCE.md
for timing boundaries, measured values and limitations.

The runtime soak repeatedly mutates usage, reads daily rows, rotates source files,
loads/invalidates main and renderer request caches and rotates asynchronous logs.
It checks canonical totals, cache hits/capacity, final log delivery, file limits
and heap retention after garbage collection and invalidation. Its renderer cache
is run as the real module in a VM with a local IPC substitute; actual IPC and
workers are covered by the separate real Electron soak.

The Electron soak opens the real dashboard with 100,000 events, alternates both
window sizes and seven tabs, sends worker queries and simulates ingestion updates.
It samples main/renderer heaps, RSS, DOM nodes and Chart.js instances and rejects
renderer errors or continuing heap growth after warmup. It never starts provider
polling or opens the host installation. The test disables background animation
throttling for its own window and restores it if minimized, so occlusion by another
acceptance window does not pause the active-use workload. This is not an idle-power
test. Failure diagnostics capture window state and a screenshot before cleanup.
Results/screenshots are ignored under
`package-output/performance-ingestion/`. Duration arguments are actual elapsed
minutes, not accelerated application time; a 30-minute pass does not establish
day-long production behavior. These manual load tests are not ordinary CI steps.

### Write/retention validation — 2026-11-15

Node 22.23.4/npm 11.21.2 passed strict application/test/renderer typechecking,
lint, 1,566 tests (seven child-fixture placeholders intentionally skipped), build
and selected-scope coverage: 92.37% lines and 83.52% branches. The ordinary real
Electron smoke passed both sizes, seven tabs, compact/onboarding and renderer
regressions. NSIS, portable EXE and ZIP packaging also succeeded.

The runtime and real Electron retention tests each passed 30 actual minutes with
100,000 initial events. Runtime: 897 cycles/90 appends, a bounded parse cache,
flat live post-GC heap, canonical rollup equality and intact final log delivery.
Electron: 180 cycles/18 appends, no renderer errors, six charts and 2,503 DOM nodes
after warmup. Detailed measurements and limits are in PERFORMANCE.md.

Two final isolated installed-update acceptances passed with the normal production
entry point (`dist/main/main.js`), not a diagnostic wrapper. Both observed the new
main process and version before verification, rejected the bad checksum, retried,
installed/relaunched and retained settings plus byte-identical usage. Both ASARs
matched 183 runtime files. Evidence directories are
`package-output/update-smoke/results-1794744035270/` and
`package-output/update-smoke/results-1794744316350/`, including `relaunch.json`,
`verified.json` and before/after usage snapshots. No public update was published.

Earlier Sandbox attempts during concurrent verification ended in automatic
startup before the usage comparison. A diagnostic run and both final unmodified
isolated runs passed; the earlier startup-abort cause was not established. Run
installed acceptance separately from timing/soak workloads for reproducible
results, and keep resource-saturated startup as a separate follow-up. This round
does not establish update reliability under resource saturation.

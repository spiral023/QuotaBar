const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');

delete process.env.ELECTRON_RUN_AS_NODE;

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quotabar-smoke-'));
  const output = path.resolve('package-output/smoke');
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'quotabar-smoke', version: require('../package.json').version, main: path.resolve('tools/electron-smoke-main.cjs') }));
  let electron;
  try {
    electron = await _electron.launch({
      args: [root],
      env: { ...process.env, QB_FIXTURE_ROOT: root, USERPROFILE: root, HOME: root }
    });
    const page = await electron.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'boot.png') });
    process.stdout.write('Electron window opened\n');
    await page.waitForFunction(() => window.QB?.ipc && document.querySelector('#titlebar-version')?.textContent);
    await page.evaluate(() => document.fonts.ready);
    const runtime = await electron.evaluate(() => process.versions.electron);
    assert.match(runtime, /^45\./);
    const preferences = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.sandbox, true);

    for (const [width, height] of [[900, 660], [750, 520]]) {
      await electron.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
      for (const tab of ['live', 'analytics', 'models', 'history', 'notifications', 'plans', 'system']) {
        await page.click(`#tab-${tab}`);
        await page.waitForFunction(() => !document.body.innerText.includes('Preparing data'));
        process.stdout.write(`Checked tab ${tab} at ${width}\n`);
        if (tab === 'analytics') await page.waitForSelector('#an-line-canvas');
        if (tab === 'system') await page.waitForSelector('#sys-export-portable-data');
        await page.screenshot({ animations: 'disabled', path: path.join(output, `${width}-${tab}.png`) });
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }

    await page.fill('#sys-codex-root-new', 'C:\\draft-root');
    await electron.evaluate(() => global.smokeController.notifyUpdateState({
      status: 'downloading', currentVersion: '2.3.1', newVersion: '2.3.2', downloadPercent: 42, error: null,
    }));
    await page.waitForFunction(() => document.querySelector('#sys-update-check')?.disabled);
    await electron.evaluate(() => global.smokeController.notifyUpdateState({
      status: 'ready', currentVersion: '2.3.1', newVersion: '2.3.2', downloadPercent: 100, error: null,
    }));
    await page.waitForSelector('#sys-update-install');
    assert.equal(await page.inputValue('#sys-codex-root-new'), 'C:\\draft-root');
    await page.locator('#sys-update-install').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'system-update-ready.png') });

    for (const [state, text] of [['preparing', 'Preparing'], ['failed', 'Needs attention'], ['ready', 'Ready']]) {
      await electron.evaluate(async (_, value) => global.smokeSetState(value), state);
      await page.click('#sys-refresh');
      await page.waitForFunction(value => document.querySelector('#system-content').innerText.includes(value), text);
      await page.getByText(`Portable data: ${text}`, { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ animations: 'disabled', path: path.join(output, `system-${state}.png`) });
    }

    const cancellations = await page.evaluate(async () => ({
      export: await QB.ipc.invoke('system:export-portable-data'),
      import: await QB.ipc.invoke('system:import-portable-data'),
    }));
    assert.equal(cancellations.export.cancelled, true);
    assert.equal(cancellations.import.cancelled, true);
    assert.equal(await page.evaluate(() => { try { QB.ipc.invoke('arbitrary:channel'); return false; } catch { return true; } }), true);
    assert.equal(await page.evaluate(() => { try { QB.ipc.invoke('settings:save', null); return false; } catch { return true; } }), true);
    assert.equal(await page.evaluate(() => window.open('https://example.com') === null), true);
    await page.evaluate(() => { location.href = 'https://example.com'; });
    assert.match(page.url(), /index\.html$/);

    const rogueRejected = await electron.evaluate(async ({ BrowserWindow }, files) => {
      const rogue = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: files.preload } });
      try {
        await rogue.loadFile(files.html);
        return await rogue.webContents.executeJavaScript('window.__QB_IPC_BRIDGE__.invoke("settings:get").then(() => false, () => true)');
      } finally { rogue.destroy(); }
    }, { preload: path.resolve("dist/main/preload.js"), html: path.resolve("src/renderer/index.html") });
    assert.equal(rogueRejected, true);

    const [compact] = await Promise.all([electron.waitForEvent('window'), page.evaluate(() => QB.ipc.invoke('window:set-view', 'compact')).catch(error => { if (!/closed/i.test(error.message)) throw error; })]);
    await compact.waitForFunction(() => document.body?.classList.contains('view-compact'));
    await compact.waitForFunction(() => document.querySelectorAll('[data-provider-card]').length === 2);
    await compact.screenshot({ animations: 'disabled', path: path.join(output, 'compact.png') });
    const [onboarding] = await Promise.all([electron.waitForEvent('window'), electron.evaluate(() => global.smokeOpenOnboarding())]);
    onboarding.on('pageerror', error => errors.push(error.message));
    onboarding.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await onboarding.waitForSelector('.agent-card');
    assert.equal(await onboarding.evaluate(() => performance.getEntriesByType('resource').some(entry => /^https?:/.test(entry.name))), false);
    assert.equal(await onboarding.evaluate(() => QB.ipc.invoke('settings:get').then(() => false, () => true)), true);
    await onboarding.screenshot({ animations: 'disabled', path: path.join(output, 'onboarding.png') });
    // Do not change the machine's login settings during fixture verification.
    await onboarding.locator('label.tgl').click();
    assert.equal(await onboarding.locator('#tog-autostart').isChecked(), false);
    await onboarding.click('#btn-start');
    assert.deepEqual(errors, []);
    process.stdout.write(JSON.stringify({ electron: runtime, dashboardSizes: ['900x660', '750x520'], tabs: 7, portableStates: 3, ipcRejections: 'passed', screenshots: output }) + '\n');
  } finally {
    if (electron) await electron.close();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('quotabar-smoke-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });

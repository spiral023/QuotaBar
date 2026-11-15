// Repeated real Electron navigation, worker queries and ingestion invalidation in an isolated home.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { _electron } = require('playwright-core');
const { fixture } = require('./performance-fixture.cjs');
delete process.env.ELECTRON_RUN_AS_NODE;

(async () => {
  const minutes = Number(process.argv[2] || 30), count = 100000;
  assert.ok(Number.isFinite(minutes) && minutes >= 1 && minutes <= 120);
  const owned = await fixture('smoke');
  const output = path.resolve('package-output/performance-ingestion'); await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(owned.root, 'package.json'), JSON.stringify({ name: 'quotabar-soak', version: require('../package.json').version,
    main: path.resolve('tools/electron-smoke-main.cjs') }));
  let electron, cdp, page;
  try {
    electron = await _electron.launch({ args: ['--js-flags=--expose-gc', owned.root], timeout: 120000,
      env: { ...process.env, QB_FIXTURE_ROOT: owned.root, USERPROFILE: owned.root, HOME: owned.root, QB_SMOKE_EVENTS: String(count) } });
    page = await electron.firstWindow(); const errors = [];
    page.setDefaultTimeout(60000);
    // Keep this active-use stress test running when other acceptance windows occlude it.
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForFunction(() => window.QB?.createAnalyticsData);
    await page.evaluate(() => { window.soakData = QB.createAnalyticsData(); });
    cdp = await page.context().newCDPSession(page);
    const started = performance.now(), samples = [], now = Date.now(); let cycles = 0, inserted = 0, nextSample = started;
    const tabs = ['analytics', 'models', 'history', 'system', 'live', 'notifications', 'plans'];
    async function checkpoint() {
      await page.click('#tab-analytics'); await page.waitForSelector('#an-line-canvas');
      await cdp.send('HeapProfiler.collectGarbage');
      const heap = await cdp.send('Runtime.getHeapUsage');
      const main = await electron.evaluate(() => { global.gc?.(); return process.memoryUsage(); });
      const dom = await page.evaluate(() => ({ nodes: document.getElementsByTagName('*').length, charts: Object.keys(Chart.instances).length }));
      assert.ok(dom.charts < 40, 'Chart instances grew beyond the live dashboard budget');
      assert.ok(dom.nodes < 15000, 'Dashboard DOM kept growing across navigation');
      assert.deepEqual(errors, []);
      samples.push({ seconds: Math.round((performance.now() - started) / 1000), cycles, inserted,
        rendererHeapMiB: Math.round(heap.usedSize / 1048576 * 100) / 100,
        mainHeapMiB: Math.round(main.heapUsed / 1048576 * 100) / 100, mainRssMiB: Math.round(main.rss / 1048576), ...dom });
      await fs.writeFile(path.join(output, 'electron-soak.json'), JSON.stringify({ minutes, count, samples }, null, 2));
      process.stdout.write(JSON.stringify(samples.at(-1)) + '\n');
    }
    while (performance.now() - started < minutes * 60000) {
      const cycleStarted = performance.now();
      if (cycles % 10 === 0) {
        const result = await electron.evaluate(async (_, index) => {
          const result = await global.smokeUsageStore.reconcile([{ schemaVersion: 1, id: String(index).padStart(64, '0'), provider: 'claude',
            occurredAt: new Date().toISOString(), model: 'claude-sonnet-4-6', sessionKey: 'soak-session', source: 'claude-log', synthetic: false,
            inputTokens: 1000, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningOutputTokens: 0,
            costUSD: .01, inputCostUSD: .008, outputCostUSD: .002, cacheCreationCostUSD: 0, cacheReadCostUSD: 0 }]);
          await global.smokeSetState('ready'); await global.smokeController.prewarmAnalytics(); return result;
        }, count + inserted);
        assert.equal(result.inserted, 1); inserted++;
        await page.evaluate(() => { QB.clearAnalyticsCache(); window.soakData.clear(); });
      }
      await electron.evaluate(({ BrowserWindow }, cycle) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win.isMinimized()) win.restore();
        win.show(); win.setSize(...(cycle % 2 ? [750, 520] : [900, 660]));
      }, cycles);
      await page.click(`#tab-${tabs[cycles % tabs.length]}`);
      await page.waitForFunction(() => !document.body.innerText.includes('Preparing data'));
      const query = { since: new Date(now - (cycles % 48 + 1) * 86400000).toISOString().slice(0, 10),
        until: new Date(now).toISOString().slice(0, 10), timeZone: 'UTC' };
      assert.equal(await page.evaluate(async query => Boolean(await window.soakData.load(query)), query), true);
      cycles++;
      if (performance.now() >= nextSample) {
        await checkpoint(); nextSample = performance.now() + 60000;
        if (samples.length === 1) await page.screenshot({ animations: 'disabled', path: path.join(output, 'electron-soak-start.png') });
      }
      await pause(Math.max(1, 10000 - (performance.now() - cycleStarted)));
    }
    await checkpoint();
    const length = await electron.evaluate(async () => (await global.smokeUsageStore.read()).length);
    assert.equal(length, count + inserted);
    const steady = samples.filter(value => value.seconds >= Math.min(480, minutes * 20000));
    if (steady.length >= 3) {
      assert.ok(samples.at(-1).rendererHeapMiB - steady[0].rendererHeapMiB < 32, 'Renderer heap kept growing after warmup');
      assert.ok(samples.at(-1).mainHeapMiB - steady[0].mainHeapMiB < 16, 'Main heap kept growing after warmup');
    }
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'electron-soak-end.png') });
    const result = { passed: true, minutes, elapsedSeconds: Math.round((performance.now() - started) / 1000), count, cycles, inserted, samples };
    await fs.writeFile(path.join(output, 'electron-soak.json'), JSON.stringify(result, null, 2));
    process.stdout.write(JSON.stringify({ ...result, samples: undefined }) + '\n');
  } catch (error) {
    if (electron) {
      const state = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({
        visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused(), bounds: win.getBounds(),
        loading: win.webContents.isLoading(), destroyed: win.webContents.isDestroyed(),
      }))).catch(() => ({ unavailable: true }));
      await fs.writeFile(path.join(output, 'electron-soak-failure.json'), JSON.stringify(state, null, 2));
      await page?.screenshot({ animations: 'disabled', timeout: 10000, path: path.join(output, 'electron-soak-failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    if (cdp) await cdp.detach().catch(() => {});
    if (electron) await electron.close();
    await owned.cleanup();
  }
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });

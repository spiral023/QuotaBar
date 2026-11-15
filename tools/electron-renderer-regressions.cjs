const assert = require('node:assert/strict');
const path = require('node:path');

/** Exercise request ordering and literal text through the real Chromium DOM. */
module.exports = async function rendererRegressions(electron, page, output) {
  await page.click('#tab-analytics');
  await page.waitForSelector('#an-line-canvas');
  await page.evaluate(async () => {
    const ipc = QB.ipc;
    const baseline = await ipc.invoke('analytics:get', { since: '2026-01-01', until: '2026-12-31', timeZone: 'UTC' });
    window.__rendererAudit = { ipc, baseline, pending: [] };
    QB.ipc = { ...ipc, invoke(channel, ...args) {
      if (channel !== 'analytics:get') return ipc.invoke(channel, ...args);
      return new Promise(resolve => window.__rendererAudit.pending.push(resolve));
    } };
    QB.clearAnalyticsCache();
    void QB.renderAnalytics();
  });
  try {
    await page.waitForFunction(() => window.__rendererAudit.pending.length === 1);
    await page.fill('#an-from', '2026-01-01'); await page.dispatchEvent('#an-from', 'change');
    await page.waitForFunction(() => window.__rendererAudit.pending.length === 2);
    await page.evaluate(() => {
      const audit = window.__rendererAudit;
      audit.data = cost => ({ ...structuredClone(audit.baseline), dailyBuckets: [{ date: '2026-01-01', days: 1, claudeUSD: cost, codexUSD: 0 }] });
      audit.pending[1](audit.data(.22));
    });
    await page.waitForFunction(() => Chart.getChart(document.getElementById('an-line-canvas'))?.data.datasets[0].data[0] === .22);
    await page.evaluate(() => window.__rendererAudit.pending[0](window.__rendererAudit.data(.11)));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => Chart.getChart(document.getElementById('an-line-canvas')).data.datasets[0].data[0]), .22);
    const labels = await page.evaluate(() => Chart.getChart(document.getElementById('an-line-canvas')).scales.y.ticks.map(tick => tick.label));
    assert.equal(new Set(labels).size, labels.length, 'Sub-dollar cost ticks must remain distinct');
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'analytics-request-order.png') });
    await page.evaluate(() => { QB.clearAnalyticsCache(); void QB.renderAnalytics(); });
    await page.waitForFunction(() => window.__rendererAudit.pending.length === 3);
    await page.evaluate(() => { QB.clearAnalyticsCache(); window.__rendererAudit.pending[2](window.__rendererAudit.data(.33)); });
    await page.waitForFunction(() => window.__rendererAudit.pending.length === 4);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#an-line-canvas').count(), 0, 'Invalidated responses must not recreate a chart');
    await page.evaluate(() => window.__rendererAudit.pending[3](window.__rendererAudit.data(.44)));
    await page.waitForFunction(() => Chart.getChart(document.getElementById('an-line-canvas'))?.data.datasets[0].data[0] === .44);
  } finally {
    await page.evaluate(async () => { QB.ipc = window.__rendererAudit.ipc; delete window.__rendererAudit; QB.clearAnalyticsCache(); await QB.renderAnalytics(); });
  }

  await page.click('#tab-system');
  await electron.evaluate(() => global.smokeController.notifyUpdateState({
    status: 'error', currentVersion: '2.4.0', newVersion: null, downloadPercent: 0,
    error: '<strong id="injected-update-error">Synthetic update failure</strong>',
  }));
  await page.waitForFunction(() => document.querySelector('.sys-update-sub')?.textContent.includes('<strong'));
  assert.equal(await page.locator('#injected-update-error').count(), 0);
  await page.screenshot({ animations: 'disabled', path: path.join(output, 'system-literal-update-error.png') });
  await electron.evaluate(() => global.smokeController.notifyUpdateState({
    status: 'available', currentVersion: '2.4.0', newVersion: '<i id="injected-update-version">next</i>', downloadPercent: 0, error: null,
  }));
  await page.waitForFunction(() => document.querySelector('.sys-update-title')?.textContent.includes('<i'));
  assert.equal(await page.locator('#injected-update-version').count(), 0);
  await electron.evaluate(() => global.smokeController.notifyUpdateState({ status: 'idle', currentVersion: '2.4.0', newVersion: null, downloadPercent: 0, error: null }));
};

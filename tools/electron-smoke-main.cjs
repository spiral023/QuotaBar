const path = require('node:path');
const { app, dialog } = require('electron');

const fixtureRoot = process.env.QB_FIXTURE_ROOT;
if (!fixtureRoot || !path.basename(fixtureRoot).startsWith('quotabar-smoke-')) throw new Error('An isolated smoke fixture is required');
process.env.USERPROFILE = fixtureRoot;
process.env.HOME = fixtureRoot;
app.setPath('userData', path.join(fixtureRoot, 'electron-user-data'));
app.on('window-all-closed', () => { });

const { DetailsWindowController } = require('../dist/main/detailsWindow');
const { saveSettings, defaultSettings } = require('../dist/config/settings');
const { getSharedUsageStore } = require('../dist/portable/usageStore');
const { markMigrationRunning, markMigrationComplete, markMigrationFailed } = require('../dist/portable/migration');
const { getPortableMigrationPath } = require('../dist/config/paths');
const { initializeUpdater } = require('../dist/main/updater');
const { openOnboardingWindow } = require('../dist/main/onboardingWindow');
global.smokeOpenOnboarding = () => openOnboardingWindow([]);

app.whenReady().then(async () => {
  await saveSettings({ ...defaultSettings, pinned: true, pricingOfflineMode: true, proxy: { mode: 'off', url: '' } });
  const store = getSharedUsageStore();
  const now = Date.now();
  const count = Number(process.env.QB_SMOKE_EVENTS || 120);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000000) throw new Error('Invalid synthetic event count');
  const spacing = Math.min(3600_000, 360 * 86400000 / count);
  global.smokeUsageStore = store;
  await store.upsert(Array.from({ length: count }, (_, index) => ({
    schemaVersion: 1, id: String(index).padStart(64, '0'), provider: index % 2 ? 'codex' : 'claude',
    occurredAt: new Date(now - index * spacing).toISOString(),
    model: index % 2 ? 'gpt-5.4' : 'claude-sonnet-4-6', sessionKey: `synthetic-${Math.floor(index / 6)}`,
    source: index % 2 ? 'codex-log' : 'claude-log', synthetic: false,
    inputTokens: 1000, outputTokens: 100, cacheReadTokens: 100, cacheCreationTokens: 0, reasoningOutputTokens: 0,
    costUSD: 0.01, inputCostUSD: 0.007, outputCostUSD: 0.002, cacheReadCostUSD: 0.001, cacheCreationCostUSD: 0,
  })));
  global.smokeSetState = async state => {
    if (state === 'ready') {
      await markMigrationRunning(getPortableMigrationPath());
      await markMigrationComplete(getPortableMigrationPath(), await store.getRevision(), store);
    } else {
      await markMigrationRunning(getPortableMigrationPath());
      if (state === 'failed') await markMigrationFailed(getPortableMigrationPath(), 'ingestion_failed');
    }
  };
  await global.smokeSetState('ready');
  // Native dialogs are deliberately cancelled; archive bytes and rollback are tested separately.
  dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined });
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  await initializeUpdater();
  global.smokeController = new DetailsWindowController(() => null);
  global.smokeController.notifyUpdate(['claude', 'codex'].map(provider => ({
    provider, status: 'ok', updatedAt: new Date().toISOString(),
    windows: [{ name: 'fiveHour', usedPercent: 25, windowSeconds: 18000 }, { name: 'weekly', usedPercent: 40, windowSeconds: 604800 }],
  })));
  global.smokeController.open(() => { });
}).catch(() => { process.stderr.write('Smoke fixture initialization failed\n'); app.exit(1); });

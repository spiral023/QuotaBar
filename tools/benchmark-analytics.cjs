const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function sample(count) {
  const { runAnalyticsTask } = require(path.join(path.resolve(process.env.QB_BENCHMARK_DIST || path.join(__dirname, '../dist')), 'main/analyticsWorker'));
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  const end = Date.parse('2026-12-31T23:59:59.999Z');
  // Summary sparklines use the current calendar day. Freeze it across A/B runs.
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(end); }
    static now() { return end; }
  };
  const events = Array.from({ length: count }, (_, index) => ({
    schemaVersion: 1, id: String(index).padStart(64, '0'), provider: index % 2 ? 'codex' : 'claude',
    occurredAt: new Date(start + (index % 365) * 86400000 + Math.floor(index / 365) * 1000).toISOString(),
    model: index % 2 ? 'gpt-5.4' : 'claude-sonnet-4-6', sessionKey: `session-${Math.floor(index / 20)}`,
    projectName: 'synthetic', source: index % 2 ? 'codex-log' : 'claude-log', synthetic: false,
    inputTokens: 1000, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningOutputTokens: 0,
    costUSD: 0.01, inputCostUSD: 0.008, outputCostUSD: 0.002, cacheReadCostUSD: 0, cacheCreationCostUSD: 0,
  }));
  const started = performance.now();
  const result = await runAnalyticsTask({ task: 'get', periodStartMs: start, periodEndMs: end, nowMs: end,
    windowDays: 365, since: '2026-01-01', until: '2026-12-31', timeZone: 'Europe/Vienna',
    settings: { plans: [], pricingOfflineMode: true, minModelTokenSharePct: 0 }, cacheHitRate: { claude: 0, codex: 0 },
  }, { usageEvents: events, readQuotaSnapshots: async () => [] });
  return { ms: Math.round(performance.now() - started), rssMiB: Math.round(process.memoryUsage().rss / 1048576),
    hash: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
}

if (process.argv[2] === '--sample') {
  sample(Number(process.argv[3])).then(result => process.stdout.write(JSON.stringify(result))).catch(() => { process.exitCode = 1; });
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quotabar-benchmark-'));
  try {
    for (const count of [10000, 100000]) {
      const samples = Array.from({ length: 3 }, () => {
        const result = spawnSync(process.execPath, [__filename, '--sample', String(count)], {
          encoding: 'utf8', timeout: 60_000, env: { ...process.env, USERPROFILE: root, HOME: root },
        });
        assert.equal(result.status, 0, 'Synthetic analytics benchmark failed');
        return JSON.parse(result.stdout);
      });
      assert.equal(new Set(samples.map(value => value.hash)).size, 1, 'Analytics results differ between fresh processes');
      process.stdout.write(JSON.stringify({ count, samples, medianMs: samples.map(value => value.ms).sort((a, b) => a - b)[1], node: process.version }) + '\n');
    }
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('quotabar-benchmark-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

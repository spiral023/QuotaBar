const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function sample(mode, root) {
  const { PortableUsageStore } = require('../dist/portable/usageStore');
  const { generateUsageReport } = require('../dist/reports/reportService');
  let jsonlReads = 0;
  const store = new PortableUsageStore(root, { ...fs, readFile: (...args) => {
    if (String(args[0]).endsWith('.jsonl')) jsonlReads++;
    return fs.readFile(...args);
  } });
  const started = performance.now();
  const deps = mode === 'raw' ? { usageEvents: await store.read() } : { usageStore: store };
  const report = await generateUsageReport({ type: 'daily', timezone: 'Europe/Vienna', order: 'asc', breakdown: true }, deps);
  const elapsed = performance.now() - started;
  const canonical = JSON.stringify({ rows: report.rows, totals: report.totals }, (_, value) => typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value);
  return { mode, ms: Math.round(elapsed), jsonlReads, rssMiB: Math.round(process.memoryUsage().rss / 1048576),
    hash: createHash('sha256').update(canonical).digest('hex') };
}

(async () => {
  if (process.argv[2] === '--sample') {
    process.stdout.write(JSON.stringify(await sample(process.argv[3], process.argv[4])));
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quotabar-rollup-benchmark-'));
  try {
    // Resolve paths only after redirecting the synthetic fixture home.
    process.env.USERPROFILE = root;
    process.env.HOME = root;
    const { PortableUsageStore } = require('../dist/portable/usageStore');
    const count = 100_000;
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    await new PortableUsageStore(root).upsert(Array.from({ length: count }, (_, index) => ({
      schemaVersion: 1, id: String(index).padStart(64, '0'), provider: index % 2 ? 'codex' : 'claude',
      occurredAt: new Date(start + index % 365 * 86400000 + Math.floor(index / 365) * 1000).toISOString(),
      model: index % 2 ? 'gpt-5.4' : 'claude-sonnet-4-6', sessionKey: 'synthetic',
      source: index % 2 ? 'codex-log' : 'claude-log', synthetic: false,
      inputTokens: 1000, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningOutputTokens: 0,
      costUSD: .01, inputCostUSD: .008, outputCostUSD: .002,
    })));
    const samples = [];
    for (const mode of ['raw', 'raw', 'raw', 'cold', 'warm', 'warm', 'warm']) {
      const result = spawnSync(process.execPath, [__filename, '--sample', mode, root], {
        encoding: 'utf8', timeout: 120_000, env: { ...process.env, USERPROFILE: root, HOME: root },
      });
      assert.equal(result.status, 0, 'Rollup benchmark child failed');
      samples.push(JSON.parse(result.stdout));
    }
    assert.equal(new Set(samples.map(sample => sample.hash)).size, 1, 'Rollups changed report results at six decimal places');
    assert.ok(samples.filter(sample => sample.mode === 'warm').every(sample => sample.jsonlReads === 0), 'Persisted cache was bypassed');
    process.stdout.write(JSON.stringify({ count, node: process.version, samples }, null, 2) + '\n');
  } finally {
    assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'quotabar-rollup-benchmark-')));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

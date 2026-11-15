const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const dist = path.resolve(process.env.QB_BENCHMARK_DIST || path.join(__dirname, '../dist'));
const { PortableUsageStore } = require(path.join(dist, 'portable/usageStore'));
const { aggregateDaily } = require(path.join(dist, 'portable/dailyRollups'));
const canonical = value => JSON.stringify(value, (_, item) => typeof item === 'number' ? Math.round(item * 1e6) / 1e6 : item);
const event = index => ({
  schemaVersion: 1, id: String(index).padStart(64, '0'), provider: 'claude',
  occurredAt: new Date(Date.parse('2026-01-01T00:00:00Z') + (index % 360) * 86400000 + Math.floor(index / 360) * 1000).toISOString(),
  model: 'claude-sonnet-4-6', sessionKey: `synthetic-${index}`, source: 'claude-log', synthetic: false,
  inputTokens: 1000, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningOutputTokens: 0,
  costUSD: .01, inputCostUSD: .008, outputCostUSD: .002, cacheCreationCostUSD: 0, cacheReadCostUSD: 0,
});

async function sample(root) {
  const writer = new PortableUsageStore(root);
  await writer.readDaily('Europe/Vienna');
  await writer.upsert([{ ...event(100000), occurredAt: '2026-12-15T12:00:00.000Z' }]);
  let jsonlReads = 0;
  const reader = new PortableUsageStore(root, { ...fs, readFile: (...args) => {
    if (String(args[0]).endsWith('.jsonl')) jsonlReads++;
    return fs.readFile(...args);
  } });
  const start = performance.now();
  const rows = await reader.readDaily('Europe/Vienna');
  const ms = Math.round(performance.now() - start);
  assert.equal(canonical(rows), canonical(aggregateDaily(await writer.read(), 'Europe/Vienna')), 'Incremental totals differ from canonical events');
  return { ms, jsonlReads, rssMiB: Math.round(process.memoryUsage().rss / 1048576), hash: createHash('sha256').update(canonical(rows)).digest('hex') };
}

(async () => {
  if (process.argv[2] === '--sample') { process.stdout.write(JSON.stringify(await sample(process.argv[3]))); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quotabar-incremental-benchmark-'));
  try {
    const seed = path.join(root, 'seed');
    await new PortableUsageStore(seed).upsert(Array.from({ length: 100000 }, (_, index) => event(index)));
    const samples = [];
    for (let index = 0; index < 3; index++) {
      const fixture = path.join(root, `sample-${index}`); await fs.cp(seed, fixture, { recursive: true });
      const result = spawnSync(process.execPath, [__filename, '--sample', fixture], {
        encoding: 'utf8', timeout: 60000, env: { ...process.env, USERPROFILE: root, HOME: root },
      });
      assert.equal(result.status, 0, 'Incremental benchmark failed'); samples.push(JSON.parse(result.stdout));
    }
    assert.equal(new Set(samples.map(value => value.hash)).size, 1);
    process.stdout.write(JSON.stringify({ count: 100000, samples, medianMs: samples.map(value => value.ms).sort((a, b) => a - b)[1], node: process.version }) + '\n');
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('quotabar-incremental-benchmark-'));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(() => { process.stderr.write('Synthetic incremental benchmark failed\n'); process.exitCode = 1; });

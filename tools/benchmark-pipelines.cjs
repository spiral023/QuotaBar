// Actual JSONL ingestion and portable ZIP import, isolated from provider accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { event, fixture, dist, hash, memory } = require('./performance-fixture.cjs');

(async () => {
  const count = Number(process.argv[2] || 100000);
  assert.ok(Number.isSafeInteger(count) && count >= 1000);
  const owned = await fixture('pipeline-benchmark');
  try {
    const { PortableUsageStore } = require(path.join(dist(), 'portable/usageStore'));
    const { ingestPortableUsage } = require(path.join(dist(), 'portable/ingestion'));
    const { exportPortableData, stagePortableImport, applyPendingImport } = require(path.join(dist(), 'portable/archiveService'));
    const { canonicalSerialize } = require(path.join(dist(), 'portable/usageEventCodec'));
    const projects = path.join(owned.root, 'projects'), sourceApp = path.join(owned.root, 'source');
    await fs.mkdir(projects); const sourceFiles = 100;
    const line = index => JSON.stringify({ timestamp: event(index).occurredAt, sessionId: `session-${index % sourceFiles}`, cwd: 'Fixture', costUSD: .01,
      message: { id: `message-${index}`, model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 100 } } }) + '\n';
    for (let source = 0; source < sourceFiles; source++) {
      const rows = []; for (let index = source; index < count; index += sourceFiles) rows.push(line(index));
      await fs.writeFile(path.join(projects, `session-${source}.jsonl`), rows.join(''));
    }
    const store = new PortableUsageStore(path.join(sourceApp, 'usage'));
    const options = { store, claudeProjectsDirs: [projects], codexSessionsDirs: [],
      enrichCosts: async events => events.map(value => ({ ...value, inputCostUSD: .008, outputCostUSD: .002,
        cacheCreationCostUSD: 0, cacheReadCostUSD: 0, pricingVersion: 'fixture-v1' })) };
    const measures = [];
    async function timed(name, operation) {
      global.gc?.(); const cpu = process.cpuUsage(), started = performance.now();
      const result = await operation(); const ms = Math.round(performance.now() - started), used = process.cpuUsage(cpu);
      global.gc?.(); measures.push({ name, ms, cpuMs: Math.round((used.user + used.system) / 1000), memoryMiB: memory(), result });
      return result;
    }
    let profiler;
    if (process.env.QB_PROFILE_FILE) {
      const { Session } = require('node:inspector'); profiler = new Session(); profiler.connect();
      await new Promise((resolve, reject) => profiler.post('Profiler.enable', error => error ? reject(error) : resolve()));
      await new Promise((resolve, reject) => profiler.post('Profiler.start', error => error ? reject(error) : resolve()));
    }
    const first = await timed('initial-jsonl-ingestion', () => ingestPortableUsage(options));
    if (profiler) {
      const profile = await new Promise((resolve, reject) => profiler.post('Profiler.stop', (error, result) => error ? reject(error) : resolve(result.profile)));
      profiler.disconnect(); await fs.writeFile(process.env.QB_PROFILE_FILE, JSON.stringify(profile));
    }
    assert.equal(first.inserted, count); assert.deepEqual(first.errors, []);
    const idle = await timed('first-unchanged-ingestion', () => ingestPortableUsage(options));
    assert.equal(idle.changed, 0);
    const warmIdle = await timed('warm-unchanged-ingestion', () => ingestPortableUsage(options));
    assert.equal(warmIdle.changed, 0); assert.equal(warmIdle.inserted, 0);
    await fs.appendFile(path.join(projects, 'session-0.jsonl'), line(count));
    const changed = await timed('one-source-changed', () => ingestPortableUsage(options));
    assert.equal(changed.inserted, 1); assert.equal(changed.changed, 1); assert.deepEqual(changed.errors, []);
    const before = await store.read(), zip = path.join(owned.root, 'portable.zip');
    await exportPortableData(sourceApp, zip); // Archive creation is not part of import timing.
    const targetHome = path.join(owned.root, 'target'), targetApp = path.join(targetHome, '.quotabar-win');
    await fs.mkdir(targetApp, { recursive: true });
    await fs.cp(sourceApp, targetApp, { recursive: true });
    const targetStore = new PortableUsageStore(path.join(targetApp, 'usage'));
    await targetStore.upsert([{ ...before[0], id: 'f'.repeat(64) }]);
    await targetStore.read(); // Exercise cache invalidation and backup of an existing large destination.
    await timed('archive-stage', () => stagePortableImport(zip, targetApp, targetHome));
    const applied = await timed('archive-apply', () => applyPendingImport(targetApp));
    assert.equal(applied.applied, true);
    const imported = await targetStore.read();
    assert.equal(hash(imported.map(canonicalSerialize)), hash(before.map(canonicalSerialize)));
    process.stdout.write(JSON.stringify({ count, node: process.version, measures, hash: hash(before.map(canonicalSerialize)), maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }) + '\n');
  } finally { await owned.cleanup(); }
})().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

// Fresh-process canonical-store writes; source decoding and archive staging are measured separately.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { event, fixture, dist, hash, memory } = require('./performance-fixture.cjs');

async function sample(count) {
  const owned = await fixture('store-benchmark');
  try {
    const { PortableUsageStore } = require(path.join(dist(), 'portable/usageStore'));
    const { canonicalSerialize } = require(path.join(dist(), 'portable/usageEventCodec'));
    const io = { reads: 0, readBytes: 0, writes: 0, writeBytes: 0 };
    const store = new PortableUsageStore(path.join(owned.root, 'usage'), { ...fs,
      readFile: async (...args) => { const result = await fs.readFile(...args); io.reads++; io.readBytes += Buffer.byteLength(result); return result; },
      writeFile: async (...args) => { io.writes++; io.writeBytes += Buffer.byteLength(args[1]); return fs.writeFile(...args); },
    });
    const input = Array.from({ length: count }, (_, index) => event(index));
    const measures = [];
    async function timed(name, operation) {
      global.gc?.(); const before = { ...io }, cpu = process.cpuUsage(), start = performance.now();
      const result = await operation();
      const ms = Math.round(performance.now() - start), used = process.cpuUsage(cpu);
      global.gc?.();
      measures.push({ name, ms, cpuMs: Math.round((used.user + used.system) / 1000),
        io: Object.fromEntries(Object.keys(io).map(key => [key, io[key] - before[key]])), memoryMiB: memory(), result });
    }
    await timed('bulk-upsert', () => store.upsert(input));
    await store.read(); // Load the same partitions on both sides of the warm comparison.
    let profiler;
    if (process.env.QB_PROFILE_FILE) {
      const { Session } = require('node:inspector'); profiler = new Session(); profiler.connect();
      await new Promise((resolve, reject) => profiler.post('Profiler.enable', error => error ? reject(error) : resolve()));
      await new Promise((resolve, reject) => profiler.post('Profiler.start', error => error ? reject(error) : resolve()));
    }
    await timed('full-reconcile-unchanged', () => store.reconcile(input));
    await timed('empty-reconcile', () => store.reconcile([]));
    const added = { ...event(count), occurredAt: '2026-12-30T12:00:00.000Z' };
    await timed('append-one', () => store.reconcile([added]));
    const changed = { ...input[0], outputTokens: 123, costUSD: .02 };
    await timed('update-one', () => store.reconcile([changed]));
    if (profiler) {
      const profile = await new Promise((resolve, reject) => profiler.post('Profiler.stop', (error, result) => error ? reject(error) : resolve(result.profile)));
      profiler.disconnect(); await fs.writeFile(process.env.QB_PROFILE_FILE, JSON.stringify(profile));
    }
    const actual = await store.read();
    const expected = [...input.slice(1), changed, added].sort((a, b) => a.id.localeCompare(b.id));
    assert.equal(hash([...actual].sort((a, b) => a.id.localeCompare(b.id)).map(canonicalSerialize)), hash(expected.map(canonicalSerialize)));
    assert.deepEqual(measures.map(item => item.result), [
      { inserted: count, existing: 0 }, { inserted: 0, updated: 0, existing: count },
      { inserted: 0, updated: 0, existing: 0 }, { inserted: 1, updated: 0, existing: 0 }, { inserted: 0, updated: 1, existing: 0 },
    ]);
    return { count, node: process.version, measures, hash: hash(actual.map(canonicalSerialize)), maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) };
  } finally { await owned.cleanup(); }
}

(async () => {
  if (process.argv[2] === '--sample') { process.stdout.write(JSON.stringify(await sample(Number(process.argv[3])))); return; }
  for (const count of [100000, 250000]) {
    const samples = [];
    for (let index = 0; index < 3; index++) {
      const child = spawnSync(process.execPath, ['--expose-gc', __filename, '--sample', String(count)], { encoding: 'utf8', timeout: 180000 });
      assert.equal(child.status, 0, `Store benchmark failed: ${child.stderr}`); samples.push(JSON.parse(child.stdout));
    }
    assert.equal(new Set(samples.map(item => item.hash)).size, 1, 'Canonical results changed across samples');
    process.stdout.write(JSON.stringify({ count, samples }) + '\n');
  }
})().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

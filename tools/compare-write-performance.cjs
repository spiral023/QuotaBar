// Alternate baseline/current fresh processes; never time overlapping workloads.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const baseline = path.resolve(process.argv[2] || 'package-output/performance-ingestion/baseline-dist');
const updated = path.resolve('dist');
for (const count of [100000, 250000]) {
  for (const workload of ['store', 'pipelines']) {
    const samples = { baseline: [], updated: [] };
    for (let index = 0; index < 3; index++) for (const [version, dist] of [['baseline', baseline], ['updated', updated]]) {
      const args = workload === 'store' ? ['--sample', String(count)] : [String(count)];
      const result = spawnSync(process.execPath, ['--expose-gc', path.join(__dirname, `benchmark-${workload}.cjs`), ...args], {
        encoding: 'utf8', timeout: 180000, env: { ...process.env, QB_BENCHMARK_DIST: dist },
      });
      assert.equal(result.status, 0, `${version} ${workload} benchmark failed: ${result.stderr}`);
      const sample = JSON.parse(result.stdout); samples[version].push(sample);
      process.stderr.write(`${version} ${workload} ${count} sample ${index + 1}: ${sample.measures.map(value => `${value.name}=${value.ms}ms`).join(', ')}\n`);
    }
    assert.equal(new Set([...samples.baseline, ...samples.updated].map(value => value.hash)).size, 1, 'Baseline/current canonical hashes differ');
    process.stdout.write(JSON.stringify({ workload, count, ...samples }) + '\n');
  }
}

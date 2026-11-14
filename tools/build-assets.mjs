import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

// Sandboxed Electron 45 preloads can require Electron, but no local Node modules.
await build({
  entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.js', bundle: true,
  platform: 'browser', format: 'cjs', target: 'chrome148', external: ['electron']
});
const chart = (await readFile('node_modules/chart.js/dist/chart.umd.js', 'utf8'))
  .replace(/^\/\/# sourceMappingURL=.*$/gm, '').trimEnd() + '\n';
await writeFile('assets/vendor/chart.min.js', chart);

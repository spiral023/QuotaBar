import { readFile } from 'node:fs/promises';
import path from 'node:path';

const nodeVersion = (await readFile(new URL('../.nvmrc', import.meta.url), 'utf8')).trim();
const { packageManager } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const npmVersion = process.env.npm_execpath
  ? JSON.parse(await readFile(path.resolve(path.dirname(process.env.npm_execpath), '../package.json'), 'utf8')).version
  : undefined;
if (process.versions.node !== nodeVersion || `npm@${npmVersion}` !== packageManager) {
  process.stderr.write(`Use Node ${nodeVersion} and ${packageManager}; see .nvmrc and package.json.\n`);
  process.exitCode = 1;
}

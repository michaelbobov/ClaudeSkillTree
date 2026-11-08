// Bundles a TypeScript script with esbuild into out/scripts and runs it with Node.
//   node scripts/run-ts.mjs <file.ts> [args...]
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error('usage: node scripts/run-ts.mjs <file.ts> [args...]');
  process.exit(2);
}
const outfile = path.resolve('out/scripts', path.basename(entry).replace(/\.ts$/, '.cjs'));
await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile, logLevel: 'warning', external: ['vscode'] });
const r = spawnSync(process.execPath, [outfile, ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);

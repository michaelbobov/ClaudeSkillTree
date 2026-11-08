// One command that proves the extension works, for humans and for unattended /goal runs.
//   npm run verify          build + unit + integration (real VS Code) + package + screenshots
//   npm run verify:quick    build + unit only
// Ends with "VERIFY PASS ..." (exit 0) or "VERIFY FAIL at <step>" (exit 1).
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const quick = process.argv.includes('--quick');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = path.join(root, 'out', 'verify');
fs.mkdirSync(outDir, { recursive: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const summary = [];

function run(args) {
  const r = spawnSync(npm, args, { cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function fail(step, output, extra = '') {
  const tail = output.split('\n').slice(-80).join('\n');
  console.log(tail);
  console.log(`\nVERIFY FAIL at ${step}${extra ? `: ${extra}` : ''}`);
  console.log(`completed: ${summary.join('  ') || 'nothing'}`);
  process.exit(1);
}

// 1. Typecheck + bundles
let r = run(['run', 'build']);
if (!r.ok) fail('build', r.out);
summary.push('build=ok');

// 2. Unit tests
const vitestJson = path.join(outDir, 'vitest.json');
fs.rmSync(vitestJson, { force: true });
r = run(['exec', '--', 'vitest', 'run', '--reporter=default', '--reporter=json', `--outputFile=${vitestJson}`]);
let unit = { numPassedTests: 0, numTotalTests: 0, numFailedTests: -1 };
try {
  unit = JSON.parse(fs.readFileSync(vitestJson, 'utf8'));
} catch {
  /* reported below */
}
if (!r.ok || unit.numFailedTests !== 0 || unit.numTotalTests === 0) fail('unit', r.out, `${unit.numPassedTests}/${unit.numTotalTests} passed`);
summary.push(`unit=${unit.numPassedTests}/${unit.numTotalTests}`);

let integrationTitles = [];
if (!quick) {
  // 3. Integration tests inside a real VS Code
  r = run(['run', 'test:integration']);
  const passing = Number(/(\d+) passing/.exec(r.out)?.[1] ?? 0);
  const failing = Number(/(\d+) failing/.exec(r.out)?.[1] ?? 0);
  integrationTitles = r.out.split('\n').filter((l) => /^\s*✔/.test(l)).map((l) => l.trim().replace(/\s*\(\d+ms\)$/, ''));
  if (!r.ok || failing > 0 || passing === 0) fail('integration', r.out, `${passing} passing, ${failing} failing`);
  summary.push(`integration=${passing}/${passing + failing}`);

  // 4. VSIX package
  r = run(['run', 'package']);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const vsix = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
  if (!r.ok || !fs.existsSync(vsix)) fail('package', r.out);
  summary.push(`package=${path.basename(vsix)}(${Math.round(fs.statSync(vsix).size / 1024)}KB)`);

  // 5. Screenshots for self-review
  const p = spawnSync(process.execPath, [path.join(root, 'scripts/preview/preview.mjs')], { cwd: root, encoding: 'utf8' });
  const pout = `${p.stdout ?? ''}${p.stderr ?? ''}`;
  if (p.status !== 0) fail('preview', pout);
  const ok = /PREVIEW OK (\d+)/.exec(pout);
  summary.push(ok ? `preview=${ok[1]} screenshots in out/preview` : `preview=${(/PREVIEW SKIPPED (.*)/.exec(pout)?.[1] ?? 'skipped').trim()}`);
}

console.log('');
for (const t of integrationTitles) console.log(`  integration ${t}`);
console.log(`VERIFY PASS ${summary.join('  ')}${quick ? '  (quick: integration/package/preview not run)' : ''}`);

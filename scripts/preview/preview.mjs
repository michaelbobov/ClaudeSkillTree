// Renders the built webview in headless Chrome with VS Code-like theme variables and writes
// screenshots to out/preview/*.png, so UI can be checked without a person or a local server.
//   node scripts/preview/preview.mjs            # your real skills (~/.claude/skills + this folder)
//   node scripts/preview/preview.mjs --fixtures # deterministic test/fixtures data
// Prints "PREVIEW OK <n> screenshots" or "PREVIEW SKIPPED <reason>" (exit 0) / "PREVIEW FAIL" (exit 1).
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const out = path.join(root, 'out', 'preview');
const assets = path.join(root, 'dist', 'webview', 'assets');
const fixtures = process.argv.includes('--fixtures');
fs.mkdirSync(out, { recursive: true });

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

if (!fs.existsSync(path.join(assets, 'index.js'))) {
  console.log('PREVIEW FAIL dist/webview is missing; run npm run build first');
  process.exit(1);
}
const chrome = findChrome();
if (!chrome) {
  console.log('PREVIEW SKIPPED no Chrome/Chromium found (set CHROME_PATH)');
  process.exit(0);
}

// 1. State snapshot from the real scanner.
const dumper = path.join(out, 'dump-state.cjs');
await esbuild.build({ entryPoints: [path.join(root, 'scripts/preview/dump-state.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: dumper, logLevel: 'warning' });
const home = fixtures ? path.join(root, 'test/fixtures/home') : os.homedir();
const ws = fixtures ? path.join(root, 'test/fixtures/workspace') : (process.env.SKILLTREE_PREVIEW_WS ?? root);
const stateFile = path.join(out, 'state.json');
const dump = spawnSync(process.execPath, [dumper, home, ws, stateFile], { encoding: 'utf8' });
if (dump.status !== 0) {
  console.log('PREVIEW FAIL could not build state\n' + dump.stdout + dump.stderr);
  process.exit(1);
}
process.stdout.write(dump.stdout);

// 2. One self-contained HTML file (file:// cannot load module scripts or fonts separately).
const font = fs.readFileSync(path.join(assets, 'codicon.ttf')).toString('base64');
const css = fs.readFileSync(path.join(assets, 'index.css'), 'utf8').replace(/url\(["']?\.?\/?codicon\.ttf[^)]*\)/g, `url(data:font/ttf;base64,${font})`);
const js = fs.readFileSync(path.join(assets, 'index.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
const data = fs.readFileSync(stateFile, 'utf8').replace(/<\//g, '<\\/');
const theme = fs.readFileSync(path.join(root, 'scripts/preview/theme.css'), 'utf8');
const boot = fs.readFileSync(path.join(root, 'scripts/preview/boot.js'), 'utf8');
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${theme}</style><style>${css}</style></head><body><div id="root"></div>
<script>window.__DATA__=${data};</script><script>${boot}</script><script type="module">${js}</script></body></html>`;
const page = path.join(out, 'preview.html');
fs.writeFileSync(page, html);

// 3. Scenarios. Add Marketplace / Activity scenarios here as those views land.
const dumped = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const state = dumped.state;
const firstSkill = state.skills[0]?.id ?? '';
const previewId = encodeURIComponent(dumped.previewId ?? '');
const usageSel = encodeURIComponent(dumped.usageSelect ?? firstSkill);
const marketing = process.env.PREVIEW_SET === 'marketing';
const scale = process.env.PREVIEW_SCALE ?? '1';
const allScenarios = [
  ['graph-dark', '1440,860', ''],
  ['graph-light', '1440,860', 'theme=light'],
  ['graph-hc', '1440,860', 'theme=hc'],
  ['inspector-dark', '1440,1000', `select=${encodeURIComponent(firstSkill)}`],
  ['list-light', '1440,760', `theme=light&view=list&sel=${encodeURIComponent(firstSkill)}`],
  ['narrow-dark', '640,800', `select=${encodeURIComponent(firstSkill)}`],
  ['empty-dark', '1100,700', 'empty=1'],
  ['usage-dark', '1440,900', `usage=1&select=${usageSel}`],
  ['usage-light', '1440,900', `usage=1&theme=light&select=${usageSel}`],
  ['usage-hc', '1440,900', `usage=1&theme=hc&select=${usageSel}`],
  ['usage-recent-dark', '1440,860', 'usage=1&order=recent'],
  ['usage-list-dark', '1440,760', `usage=1&view=list&order=most&sel=${usageSel}`],
  ['market-dark', '1440,900', 'page=marketplace'],
  ['market-light', '1440,900', 'page=marketplace&theme=light'],
  ['market-hc', '1440,900', 'page=marketplace&theme=hc'],
  ['market-foryou-dark', '1440,900', 'page=marketplace&foryou=1'],
  ['market-foryou-light', '1440,900', 'page=marketplace&foryou=1&theme=light'],
  ['market-project-dark', '1440,900', 'page=marketplace&project=1&foryou=1'],
  ['market-project-light', '1440,900', 'page=marketplace&project=1&theme=light'],
  ['market-project-narrow-dark', '640,900', 'page=marketplace&project=1'],
  ['market-preview-dark', '1440,1000', `page=marketplace&sel=${previewId}`],
  ['market-narrow-dark', '640,900', `page=marketplace&sel=${previewId}`],
  ['activity-off-dark', '1200,700', 'page=activity'],
  ['activity-dark', '1300,700', 'page=activity&fixture=1'],
  ['activity-light', '1300,700', 'page=activity&fixture=1&theme=light'],
  ['activity-hc', '1300,700', 'page=activity&fixture=1&theme=hc'],
  ['activity-narrow-dark', '600,700', 'page=activity&fixture=1'],
  ['live-dark', '1300,760', 'live=1&order=recent'],
  ['live-light', '1300,760', 'live=1&theme=light'],
  ['live-narrow-dark', '600,700', 'live=1&view=list'],
];
// PREVIEW_SET=marketing: a few tight crops for the website (pair with SKILLTREE_USAGE_LOG and PREVIEW_SCALE=2).
const marketingScenarios = [
  ['mk-tree-used', '1280,800', `usage=1&order=recent&select=${usageSel}`],
  ['mk-hero', '800,640', `usage=1&order=recent&select=${usageSel}`],
  ['mk-tree', '1240,760', 'usage=1&order=recent'],
  ['mk-activity', '720,640', 'page=activity&fixture=1'],
  ['mk-foryou', '1280,820', 'page=marketplace&foryou=1'],
  ['mk-market', '1280,820', 'page=marketplace'],
  ['mk-preview', '1280,900', `page=marketplace&sel=${previewId}`],
];
// PREVIEW_ONLY=<regex>: render only the matching scenarios (quick checks).
const only = process.env.PREVIEW_ONLY ? new RegExp(process.env.PREVIEW_ONLY) : null;
const scenarios = (marketing ? marketingScenarios : allScenarios).filter(([name]) => !only || only.test(name));
const profile = path.join(out, 'chrome-profile');
const written = [];
for (const [name, size, query] of scenarios) {
  const file = path.join(out, `${name}.png`);
  fs.rmSync(file, { force: true });
  spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--force-device-scale-factor=${scale}`, '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, `--window-size=${size}`, '--virtual-time-budget=4000', `--screenshot=${file}`, `file://${page}?${query}`], { encoding: 'utf8', timeout: 60000 });
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) written.push(file);
  else console.log(`  missing screenshot: ${name}`);
}
if (written.length !== scenarios.length) {
  console.log(`PREVIEW FAIL ${written.length}/${scenarios.length} screenshots`);
  process.exit(1);
}
console.log(`PREVIEW OK ${written.length} screenshots (${fixtures ? 'fixtures' : 'real skills'})`);
for (const f of written) console.log(`  ${path.relative(root, f)}`);

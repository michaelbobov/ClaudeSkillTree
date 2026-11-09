// Builds the web demo of SkillTree into out/demo/: the real webview (all three tabs) driven by a
// small shell that plays the extension host and replays recorded skill use.
//   node scripts/demo/build-demo.mjs <activity.jsonl recorded by SkillTree's hooks>
// Run `npm run build` first. The output is static files: index.html, app.html, shell.js, demo-data.js.
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const log = process.argv[2];
if (!log || !fs.existsSync(log)) {
  console.log('DEMO FAIL pass the activity.jsonl to replay');
  process.exit(1);
}
const assets = path.join(root, 'dist', 'webview', 'assets');
if (!fs.existsSync(path.join(assets, 'index.js'))) {
  console.log('DEMO FAIL dist/webview is missing; run npm run build first');
  process.exit(1);
}
const out = path.join(root, 'out', 'demo');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 1. The skills, catalog and usage summary, from the same scanner the screenshots use.
const tmp = path.join(root, 'out', 'demo-build');
fs.mkdirSync(tmp, { recursive: true });
const dumper = path.join(tmp, 'dump-state.cjs');
await esbuild.build({ entryPoints: [path.join(root, 'scripts/preview/dump-state.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: dumper, logLevel: 'warning' });
const stateFile = path.join(tmp, 'state.json');
const dump = spawnSync(process.execPath, [dumper, os.homedir(), root, stateFile], { encoding: 'utf8', env: { ...process.env, SKILLTREE_USAGE_LOG: log } });
if (dump.status !== 0) {
  console.log('DEMO FAIL could not build state\n' + dump.stdout + dump.stderr);
  process.exit(1);
}
const d = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

// 2. Demo data. Skill bodies are not included (the demo never shows SKILL.md text of local skills).
const events = fs
  .readFileSync(log, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  // Only the project folder's name is kept, not where it is.
  .map(({ v, ts, source, skill, sessionId, projectDir, commandSource, hadArgs }) => ({ v, ts, source, skill, sessionId, cwd: null, projectDir: projectDir ? path.basename(projectDir) : null, commandSource, hadArgs }));
const market = {
  ...d.market,
  forYou: d.marketForYou,
  entries: d.market.entries.map((e) => ({ ...e, description: e.description.slice(0, 400), files: e.files.slice(0, 20) })),
};
const data = { state: d.state, market, events };
// Local paths are shown relative to the home folder, so the published demo carries no user name.
const json = JSON.stringify(data).split(JSON.stringify(os.homedir()).slice(1, -1)).join('~');
fs.writeFileSync(path.join(out, 'demo-data.js'), `window.__DEMO__=${json.replace(/<\//g, '<\\/')};\n`);

// 3. One self-contained tab page (the built webview, codicons inlined, dark theme variables).
const font = fs.readFileSync(path.join(assets, 'codicon.ttf')).toString('base64');
const css = fs.readFileSync(path.join(assets, 'index.css'), 'utf8').replace(/url\(["']?\.?\/?codicon\.ttf[^)]*\)/g, `url(data:font/ttf;base64,${font})`);
const js = fs.readFileSync(path.join(assets, 'index.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
const theme = fs.readFileSync(path.join(root, 'scripts/preview/theme.css'), 'utf8');
const boot = fs.readFileSync(path.join(root, 'scripts/demo/app-boot.js'), 'utf8');
// The same policy as the extension's webviews (src/views/webviewHtml.ts), with hashes in place of a
// nonce: no network, no frames, no forms, images only from data: URIs. SKILL.md text fetched by the
// shell is rendered by markdown-it with html:false, as in VS Code.
const hash = (s) => `'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`;
const csp = [
  "default-src 'none'",
  'img-src data:',
  "style-src 'unsafe-inline'",
  'font-src data:',
  `script-src ${hash(boot)} ${hash(js)}`,
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');
fs.writeFileSync(
  path.join(out, 'app.html'),
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${theme}</style><style>${css}</style></head><body><div id="root"></div>\n<script>${boot}</script><script type="module">${js}</script></body></html>`,
);

// 4. The shell and its page.
await esbuild.build({ entryPoints: [path.join(root, 'scripts/demo/shell.ts')], bundle: true, platform: 'browser', format: 'iife', target: 'es2020', outfile: path.join(out, 'shell.js'), logLevel: 'warning', minify: true });
fs.copyFileSync(path.join(root, 'scripts/demo/index.html'), path.join(out, 'index.html'));

const size = (f) => `${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)} KB`;
console.log(`DEMO OK ${d.state.skills.length} skills, ${market.entries.length} catalog entries, ${events.length} recorded events → out/demo (app.html ${size('app.html')}, demo-data.js ${size('demo-data.js')}, shell.js ${size('shell.js')})`);

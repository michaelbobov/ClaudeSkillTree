// npm run dev [-- <folder>] [-- --no-build]
// Builds the extension and opens an Extension Development Host window with SkillTree loaded,
// without needing F5. Opens test/fixtures/workspace (the sample project) unless a folder is given.
// Running it again reloads the existing development window.
import { spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const folderArg = args.find((a) => !a.startsWith('--'));
const folder = path.resolve(folderArg ?? path.join(root, 'test', 'fixtures', 'workspace'));

function findCodeCli() {
  const candidates = [
    process.env.SKILLTREE_CODE_CLI,
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    path.join(process.env.HOME ?? '', 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of process.platform === 'win32' ? ['code.cmd', 'code.exe'] : ['code']) {
      const p = path.join(dir, name);
      if (dir && fs.existsSync(p)) return p;
    }
  }
  return null;
}

if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
  console.error(`DEV FAIL: folder not found: ${folder}`);
  process.exit(1);
}

if (!noBuild) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('DEV FAIL: npm run build failed (see above).');
    process.exit(r.status ?? 1);
  }
}

const code = findCodeCli();
if (!code) {
  console.error('DEV FAIL: VS Code CLI not found. Install the "code" command (Command Palette: "Shell Command: Install \'code\' command in PATH") or set SKILLTREE_CODE_CLI.');
  process.exit(1);
}

const child = spawn(code, [`--extensionDevelopmentPath=${root}`, folder], { stdio: 'ignore', detached: true });
child.on('error', (err) => {
  console.error(`DEV FAIL: could not start VS Code: ${err.message}`);
  process.exit(1);
});
child.unref();
console.log(`DEV OK: opened an Extension Development Host for ${folder}`);
console.log('Look for the window titled "[Extension Development Host]" and click the SkillTree icon in its Activity Bar.');

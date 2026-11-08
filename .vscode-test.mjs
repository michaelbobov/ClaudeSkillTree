// Integration tests run inside a real VS Code (Extension Development Host).
// Fixtures are copied to a temp directory so tests can create files without touching the repo,
// and SKILLTREE_HOME points "personal" skills at the fixture home instead of your real ~/.claude.
import { defineConfig } from '@vscode/test-cli';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltree-it-'));
fs.cpSync(path.resolve('test/fixtures'), tmp, { recursive: true });

const installed = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const useInstalled = process.platform === 'darwin' && fs.existsSync(installed) && !process.env.SKILLTREE_TEST_DOWNLOAD;

export default defineConfig({
  files: 'out/integration/**/*.test.js',
  workspaceFolder: path.join(tmp, 'workspace'),
  env: { SKILLTREE_HOME: path.join(tmp, 'home'), SKILLTREE_TEST_TMP: tmp },
  mocha: { ui: 'tdd', timeout: 60000 },
  ...(useInstalled ? { useInstallation: { fromPath: installed } } : { version: 'stable' }),
  launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
});

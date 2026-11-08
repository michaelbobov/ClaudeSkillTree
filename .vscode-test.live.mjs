// Opt-in live suite: `npm run e2e:vscode`. Runs SkillTree in a real VS Code against a throwaway
// project and a throwaway SKILLTREE_HOME, enables tracking through the real command, and drives two
// short real Claude Code sessions (your normal login, haiku, budget-capped, not persisted).
// Your real ~/.claude settings and skills are never modified; the suite checks that.
import { defineConfig } from '@vscode/test-cli';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltree-live-'));
const workspace = path.join(tmp, 'project');
const skill = path.join(workspace, '.claude', 'skills', 'sandbox-echo');
fs.mkdirSync(skill, { recursive: true });
fs.writeFileSync(
  path.join(skill, 'SKILL.md'),
  '---\nname: sandbox-echo\ndescription: Test skill for SkillTree. Use when asked to run the sandbox echo check.\n---\n\nReply with exactly SANDBOX-ECHO-OK and nothing else.\n',
);
fs.mkdirSync(path.join(tmp, 'home'), { recursive: true });

const installed = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const useInstalled = process.platform === 'darwin' && fs.existsSync(installed) && !process.env.SKILLTREE_TEST_DOWNLOAD;

export default defineConfig({
  files: 'out/live/**/*.test.js',
  workspaceFolder: workspace,
  env: { SKILLTREE_HOME: path.join(tmp, 'home'), SKILLTREE_TEST_TMP: tmp },
  mocha: { ui: 'tdd', timeout: 400000 },
  ...(useInstalled ? { useInstallation: { fromPath: installed } } : { version: 'stable' }),
  launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
});

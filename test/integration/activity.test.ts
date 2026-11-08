import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SkillTreeApi } from '../../src/extension';

const EXTENSION_ID = 'skilltree-local.skilltree';
const fixtures = path.resolve(__dirname, '../../test/fixtures/hooks');

async function waitFor(check: () => boolean, timeoutMs = 15000, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function hashOrNull(file: string): Promise<string | null> {
  try {
    return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  } catch {
    return null;
  }
}

suite('SkillTree activity tracking', () => {
  let api: SkillTreeApi;
  const home = () => process.env.SKILLTREE_HOME!;
  const sandboxSettings = () => path.join(home(), '.claude', 'settings.json');
  const realSettings = path.join(os.homedir(), '.claude', 'settings.json');
  const original = JSON.stringify({ model: 'sonnet', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/bin/true' }] }] } }, null, 2) + '\n';

  suiteSetup(async () => {
    api = await vscode.extensions.getExtension<SkillTreeApi>(EXTENSION_ID)!.activate();
    assert.ok(api.test);
    assert.notEqual(path.resolve(home()), path.resolve(os.homedir()), 'tests run against a sandbox home');
  });

  suiteTeardown(async () => {
    if (api.activity().enabled) await vscode.commands.executeCommand('skilltree.disableTracking');
    api.test?.setTrackingConsent(undefined);
  });

  test('enabling and disabling tracking edits only the sandbox settings and restores the backup', async () => {
    const realBefore = await hashOrNull(realSettings);
    await fs.mkdir(path.dirname(sandboxSettings()), { recursive: true });
    await fs.writeFile(sandboxSettings(), original);
    let asked = 0;
    api.test!.setTrackingConsent(async (d) => {
      asked++;
      assert.equal(d.userSettings, sandboxSettings());
      return 'user';
    });

    const enabled = await vscode.commands.executeCommand<{ status: string; message: string }>('skilltree.enableTracking');
    assert.equal(enabled.status, 'enabled', enabled.message);
    assert.equal(asked, 1, 'consent was requested');
    const json = JSON.parse(await fs.readFile(sandboxSettings(), 'utf8'));
    assert.equal(json.model, 'sonnet');
    assert.equal(json.hooks.PreToolUse.length, 2);
    assert.equal(json.hooks.PreToolUse[1].matcher, 'Skill');
    assert.equal(json.hooks.PreToolUse[1].hooks[0].async, undefined, 'runs in the foreground so short sessions cannot drop the event');
    assert.ok(json.hooks.PreToolUse[1].hooks[0].timeout <= 10, 'short timeout');
    assert.ok(Array.isArray(json.hooks.UserPromptExpansion));
    assert.ok((await fs.readdir(path.dirname(sandboxSettings()))).some((n) => n.startsWith('settings.json.skilltree-backup-')), 'backup written');
    assert.equal(api.activity().enabled, true);

    const disabled = await vscode.commands.executeCommand<{ status: string; message: string }>('skilltree.disableTracking');
    assert.equal(disabled.status, 'disabled', disabled.message);
    assert.equal(await fs.readFile(sandboxSettings(), 'utf8'), original, 'original settings restored byte-for-byte');
    assert.deepEqual((await fs.readdir(path.dirname(sandboxSettings()))).filter((n) => n.startsWith('settings.json.')), [], 'backup removed after restore');
    assert.equal(api.activity().enabled, false);
    assert.equal(await hashOrNull(realSettings), realBefore, 'real ~/.claude/settings.json untouched');
  });

  test('records hook event fixtures and shows them in Activity', async () => {
    // The badge counts uses recorded while Recent Activity is not on screen.
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    api.test!.setTrackingConsent(async () => 'user');
    const enabled = await vscode.commands.executeCommand<{ status: string; message: string }>('skilltree.enableTracking');
    assert.equal(enabled.status, 'enabled', enabled.message);
    const settings = JSON.parse(await fs.readFile(sandboxSettings(), 'utf8'));

    // Run each installed handler exactly as Claude Code would: exec form, payload on stdin.
    const run = (event: 'PreToolUse' | 'UserPromptExpansion', fixture: string) => {
      const groups = settings.hooks[event] as { matcher?: string; hooks: { command: string; args: string[] }[] }[];
      const handler = groups.find((g) => g.hooks.some((h) => h.args?.[0]?.endsWith('record-skill-event.mjs')))!.hooks[0];
      return spawnSync(handler.command, handler.args, {
        input: require('node:fs').readFileSync(path.join(fixtures, fixture), 'utf8'),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: vscode.workspace.workspaceFolders![0].uri.fsPath },
      });
    };
    for (const r of [run('PreToolUse', 'pre-tool-use-skill.json'), run('UserPromptExpansion', 'user-prompt-expansion.json'), run('PreToolUse', 'pre-tool-use-bash.json')]) {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '', 'recorder prints nothing');
    }

    await api.refreshActivity();
    const state = api.activity();
    assert.equal(state.events.length, 2, 'two skill events (Bash ignored)');
    assert.deepEqual(state.events.map((e) => e.source).sort(), ['PreToolUse:Skill', 'UserPromptExpansion']);
    assert.deepEqual(state.events.map((e) => e.skill).sort(), ['example-skill', 'frontend-design']);
    const log = await fs.readFile(state.logFile, 'utf8');
    assert.ok(!log.includes('arg1') && !log.includes('header calmer'), 'no prompt text or arguments stored');

    // Visible without opening the Skill Tree: status bar item and Activity Bar badge.
    const ind = api.test!.indicators();
    assert.match(ind.statusText ?? '', /^\$\(pulse\) (example-skill|frontend-design) · just now$/, 'status bar shows the latest recorded skill');
    assert.equal(ind.badge, 2, 'badge counts uses recorded since tracking was enabled');
    await vscode.commands.executeCommand('skilltree.skills.focus');
    await waitFor(() => api.test!.indicators().badge === 0, 10000, 'badge clears once Recent Activity is visible');

    await vscode.commands.executeCommand('skilltree.openActivity');
    await waitFor(() => api.isActivityReady(), 20000, 'activity webview ready');
    await waitFor(() => api.activityRenderedCount() === 2, 20000, 'activity rendered both events');

    const disabled = await vscode.commands.executeCommand<{ status: string }>('skilltree.disableTracking');
    assert.equal(disabled.status, 'disabled');
    const off = api.test!.indicators();
    assert.match(off.statusText ?? '', /^\$\(type-hierarchy\) \d+ skills?$/, 'with tracking off the status bar shows the skill count, no usage');
    assert.equal(off.badge, 0, 'no badge when tracking is off');
  });
});

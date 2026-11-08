// Live end-to-end check of activity tracking, exactly as a user would do it, but automated:
// enable tracking with the real command → use a skill in real Claude Code sessions → the events show
// up by themselves (log watcher, no manual refresh) in Recent Activity, the Activity panel and the
// Skill Tree inspector data → disable restores the settings. Run with `npm run e2e:vscode`.
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SkillTreeApi } from '../../src/extension';
import { findClaudeBinary, NOT_LOGGED_IN, runClaude } from '../../scripts/lib/claude';
import { findNode } from '../../src/services/activityNode';
import type { ConfirmRequest } from '../../src/services/marketplace';

const EXTENSION_ID = 'skilltree-local.skilltree';
const MODEL_PROMPT = 'Run the sandbox echo check using the sandbox-echo skill.';

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`);
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

/** The extension host's env minus Electron/VS Code internals, so Claude Code starts as from a terminal. */
function claudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(ELECTRON_|VSCODE_)/.test(k)) env[k] = v;
  return env;
}

suite('SkillTree live: real Claude Code session', () => {
  let api: SkillTreeApi;
  const workspace = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
  const home = () => process.env.SKILLTREE_HOME!;
  const projectSettings = () => path.join(workspace(), '.claude', 'settings.local.json');
  const realFiles = ['settings.json', 'settings.local.json'].map((f) => path.join(os.homedir(), '.claude', f));

  suiteSetup(async () => {
    api = await vscode.extensions.getExtension<SkillTreeApi>(EXTENSION_ID)!.activate();
    assert.ok(api.test, 'test hooks available');
    assert.notEqual(path.resolve(home()), path.resolve(os.homedir()), 'runs against a sandbox home');
  });

  suiteTeardown(async () => {
    if (api?.activity().enabled) await vscode.commands.executeCommand('skilltree.disableTracking');
  });

  test('enable tracking, use a skill in Claude Code, see it in Recent Activity, Activity and the Skill Tree, then disable', async () => {
    const bin = findClaudeBinary();
    assert.ok(bin, 'Claude Code binary found (VS Code extension, CLAUDE_BIN or PATH)');
    // The badge counts uses recorded while the SkillTree sidebar is not on screen.
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    const realBefore = await Promise.all(realFiles.map(hashOrNull));

    // The sandbox skill is discovered like any project skill.
    await api.rescan();
    const skill = api.snapshot().skills.find((s) => s.name === 'sandbox-echo');
    assert.ok(skill, 'sandbox-echo skill scanned');
    assert.equal(skill!.source, 'project');

    // 1. Enable through the real command; the consent dialog is answered "Enable for this project".
    api.test!.setTrackingConsent(async (d) => {
      assert.equal(d.projectSettings, projectSettings(), 'offers the workspace settings.local.json');
      return 'project';
    });
    const enabled = await vscode.commands.executeCommand<{ status: string; message: string }>('skilltree.enableTracking');
    assert.equal(enabled.status, 'enabled', enabled.message);
    const hooks = JSON.parse(await fs.readFile(projectSettings(), 'utf8')).hooks;
    assert.equal(hooks.PreToolUse[0].matcher, 'Skill');
    assert.ok(hooks.PreToolUse[0].hooks[0].args[0].startsWith(home()), 'recorder lives in the sandbox home');
    assert.equal(api.activity().events.length, 0, 'nothing recorded before Claude Code runs');
    assert.deepEqual(api.test!.recentActivityItems(), [], 'Recent Activity starts empty');

    // 2. A typed slash command (UserPromptExpansion). Nothing below calls refresh: the log watcher must notice.
    const env = claudeEnv();
    const typed = await runClaude(bin!, workspace(), '/sandbox-echo', env, { settingSources: 'project,local' });
    if (NOT_LOGGED_IN.test(typed.out)) throw new Error(`Claude Code is not logged in: ${typed.out.trim().split('\n')[0]}`);
    console.log(`    claude "/sandbox-echo" → exit ${typed.code}: ${typed.out.trim().split('\n').pop()}`);
    await waitFor(() => api.activity().events.some((e) => e.source === 'UserPromptExpansion' && e.skill === 'sandbox-echo'), 30000, 'the typed command event to appear');

    // 3. Claude decides to use the skill (PreToolUse on the Skill tool).
    // The model decides whether to call the Skill tool, so allow one more attempt; the event itself is still required.
    const invokedEvent = () => api.activity().events.some((e) => e.source === 'PreToolUse:Skill' && e.skill === 'sandbox-echo');
    for (let attempt = 1; attempt <= 2 && !invokedEvent(); attempt++) {
      const invoked = await runClaude(bin!, workspace(), MODEL_PROMPT, env, { settingSources: 'project,local' });
      console.log(`    claude "${MODEL_PROMPT}" (attempt ${attempt}) → exit ${invoked.code}: ${invoked.out.trim().split('\n').pop()}`);
      try {
        await waitFor(invokedEvent, 20000, 'the Skill tool event to appear');
      } catch (err) {
        console.log(`    no Skill tool event yet; Claude's output was:\n${invoked.out.trim().slice(0, 600)}`);
        if (attempt === 2) throw err;
      }
    }

    const events = api.activity().events;
    for (const e of events) console.log(`    EVENT ${JSON.stringify(e)}`);
    assert.equal(events.length, 2, 'exactly the two real uses were recorded');
    assert.equal(new Set(events.map((e) => e.sessionId)).size, 2, 'two separate sessions');
    const logText = await fs.readFile(api.activity().logFile, 'utf8');
    assert.ok(!logText.includes('Run the sandbox echo check'), 'prompt text is not stored');

    // 4. Where a user sees it.
    const rows = api.test!.recentActivityItems();
    console.log(`    Recent Activity rows: ${rows.map((r) => `${r.label} (${r.description})`).join(' | ')}`);
    assert.deepEqual(rows.map((r) => r.label), ['sandbox-echo', 'sandbox-echo']);
    assert.ok(rows.some((r) => r.description.startsWith('typed')) && rows.some((r) => r.description.startsWith('Claude')), 'rows label how the skill was used');

    const usage = api.test!.graphState().activity?.bySkill['sandbox-echo'];
    assert.ok(usage, 'the Skill Tree receives the recorded use');
    assert.deepEqual({ count: usage!.count, typed: usage!.typed, invoked: usage!.invoked, sessions: usage!.sessions }, { count: 2, typed: 1, invoked: 1, sessions: 2 });
    assert.equal(usage!.lastSource, 'PreToolUse:Skill', 'latest use is the model-invoked one');

    const ind = api.test!.indicators();
    console.log(`    Status bar: "${ind.statusText}" · badge ${ind.badge}`);
    assert.equal(ind.statusText, '$(pulse) sandbox-echo · just now', 'status bar shows the skill just used');
    assert.equal(ind.badge, 2, 'Activity Bar badge counts both uses');

    await vscode.commands.executeCommand('skilltree.openActivity');
    await waitFor(() => api.isActivityReady(), 20000, 'Activity panel ready');
    await waitFor(() => api.activityRenderedCount() === 2, 20000, 'Activity panel to render both events');

    // 5. Disable restores the workspace exactly (the settings file did not exist before).
    const disabled = await vscode.commands.executeCommand<{ status: string; message: string }>('skilltree.disableTracking');
    assert.equal(disabled.status, 'disabled', disabled.message);
    assert.equal(await hashOrNull(projectSettings()), null, 'settings.local.json removed again');
    assert.deepEqual(await Promise.all(realFiles.map(hashOrNull)), realBefore, 'real ~/.claude settings untouched');
  });

  test('Claude finds a skill in the catalog, asks to install it, the user approves, and Claude can use it', async () => {
    const bin = findClaudeBinary();
    const node = findNode();
    assert.ok(bin && node);
    const realBefore = await Promise.all(realFiles.map(hashOrNull));

    // Tracking on, so the Skill tool call on the newly installed skill is recorded.
    api.test!.setTrackingConsent(async () => 'project');
    const enabled = await vscode.commands.executeCommand<{ status: string; message: string }>('skilltree.enableTracking');
    assert.equal(enabled.status, 'enabled', enabled.message);

    // The user approves in the dialog; capture what it showed.
    const asked: ConfirmRequest[] = [];
    api.test!.setConfirm(async (req) => (asked.push(req), true));
    await api.refreshCatalog(); // the real bundled catalog
    api.test!.startClaudeBridge();
    const bridge = api.test!.claudeBridgeDir();
    await waitFor(() => require('node:fs').existsSync(path.join(bridge, 'catalog.json')), 10000, 'catalog snapshot');

    // Claude Code gets SkillTree's MCP server only for this run (no config is registered anywhere).
    const server = path.resolve(__dirname, '../../dist/mcp/skilltree-mcp.mjs');
    const mcpConfig = path.join(process.env.SKILLTREE_TEST_TMP!, 'mcp.json');
    await fs.writeFile(mcpConfig, JSON.stringify({ mcpServers: { skilltree: { command: node, args: [server, path.dirname(bridge)] } } }));
    const prompt = 'I need to fill in a PDF form in this project. Before anything else, find a suitable skill in the SkillTree catalog and install it, then invoke it with the Skill tool and tell me in one sentence what it says to do first.';
    const run = await runClaude(bin!, workspace(), prompt, claudeEnv(), {
      settingSources: 'project,local',
      allowedTools: 'Skill,mcp__skilltree__search_skills,mcp__skilltree__install_skill',
      extraArgs: ['--mcp-config', mcpConfig, '--strict-mcp-config'],
      budgetUsd: '0.60',
      timeoutMs: 240000,
    });
    console.log(`    claude → exit ${run.code}: ${run.out.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`);

    assert.equal(asked.length >= 1, true, 'Claude asked to install a skill (the confirmation dialog was shown)');
    const req = asked[0];
    console.log(`    Dialog: Claude wants to install "${req.plan.entry.name}" from ${req.plan.entry.owner}/${req.plan.entry.repo}@${req.plan.entry.commitSha.slice(0, 7)} · reason: "${req.requestedBy?.reason}"`);
    assert.equal(req.requestedBy?.by, 'claude');
    assert.ok((req.requestedBy?.reason ?? '').length > 5, 'Claude gave a reason');
    const folder = path.join(workspace(), '.claude', 'skills', req.plan.folderName);
    assert.ok(require('node:fs').existsSync(path.join(folder, 'SKILL.md')), 'skill installed into the project');
    assert.ok(require('node:fs').existsSync(path.join(folder, '.skilltree-source.json')), 'with SkillTree provenance');

    const invokedNew = () => api.activity().events.some((e) => e.source === 'PreToolUse:Skill' && e.skill === req.plan.folderName);
    try {
      await waitFor(invokedNew, 15000, 'Claude to invoke the newly installed skill');
      console.log(`    Recorded: Claude invoked "${req.plan.folderName}" via the Skill tool in the same session`);
    } catch {
      // Whether Claude invokes it right away is the model's choice; the skill must be usable regardless.
      console.log(`    Claude did not invoke "${req.plan.folderName}" in that session; checking it is usable with a follow-up prompt`);
      await runClaude(bin!, workspace(), `Use the ${req.plan.folderName} skill and reply with its first step in one sentence.`, claudeEnv(), { settingSources: 'project,local' });
      await waitFor(invokedNew, 30000, 'Claude to invoke the installed skill');
      console.log(`    Recorded: Claude invoked "${req.plan.folderName}" via the Skill tool (follow-up session)`);
    }

    const disabled = await vscode.commands.executeCommand<{ status: string }>('skilltree.disableTracking');
    assert.equal(disabled.status, 'disabled');
    api.test!.setConfirm(undefined);
    assert.deepEqual(await Promise.all(realFiles.map(hashOrNull)), realBefore, 'real ~/.claude settings untouched');
  });

  test('unprompted: an ordinary request gets a fitting catalog skill suggested in VS Code, approved and installed', async () => {
    const bin = findClaudeBinary();
    const node = findNode();
    assert.ok(bin && node);
    const nodeFs = require('node:fs') as typeof import('node:fs');
    const realBefore = await Promise.all(realFiles.map(hashOrNull));
    api.test!.setTrackingConsent(async () => 'project');
    assert.equal((await vscode.commands.executeCommand<{ status: string }>('skilltree.enableTracking')).status, 'enabled');
    const asked: ConfirmRequest[] = [];
    api.test!.setConfirm(async (req) => (asked.push(req), true));
    const notified: { name: string; repo: string }[] = [];
    api.test!.setSuggestionChoice(async (s) => (notified.push(s), 'project'));
    api.test!.startClaudeBridge();
    const bridge = api.test!.claudeBridgeDir();
    await waitFor(() => nodeFs.existsSync(path.join(bridge, 'catalog.json')), 10000, 'catalog snapshot');

    // The suggestion hook, as "Let Claude suggest skills" installs it (here in the project's settings).
    const suggest = path.resolve(__dirname, '../../dist/recorder/suggest-skills.mjs');
    const projectSettings = path.join(workspace(), '.claude', 'settings.json');
    await fs.writeFile(projectSettings, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: node, args: [suggest, path.dirname(bridge)], timeout: 5 }] }] } }));
    await fs.mkdir(path.join(workspace(), 'src'), { recursive: true });
    await fs.writeFile(path.join(workspace(), 'src', 'Modal.tsx'), 'export function Modal({ open, children }: { open: boolean; children: React.ReactNode }) {\n  if (!open) return null;\n  return <div className="modal">{children}</div>;\n}\n');
    const server = path.resolve(__dirname, '../../dist/mcp/skilltree-mcp.mjs');
    const mcpConfig = path.join(process.env.SKILLTREE_TEST_TMP!, 'mcp2.json');
    await fs.writeFile(mcpConfig, JSON.stringify({ mcpServers: { skilltree: { command: node, args: [server, path.dirname(bridge)] } } }));

    const prompt = 'Add a nice entrance and exit animation to the modal in src/Modal.tsx.';
    const run = await runClaude(bin!, workspace(), prompt, claudeEnv(), {
      settingSources: 'project,local',
      allowedTools: 'Skill,Read,Edit,Write,mcp__skilltree__search_skills,mcp__skilltree__install_skill',
      extraArgs: ['--mcp-config', mcpConfig, '--strict-mcp-config'],
      budgetUsd: '0.80',
      timeoutMs: 300000,
    });
    console.log(`    prompt: "${prompt}" → exit ${run.code}`);
    const suggested = path.join(bridge, 'suggested.json');
    console.log(`    hook suggested: ${nodeFs.existsSync(suggested) ? nodeFs.readFileSync(suggested, 'utf8').slice(0, 300) : '(nothing)'}`);
    if (asked.length === 0) console.log(`    Claude output:\n${run.out.trim().slice(-1500)}`);
    console.log(`    Notification: ${notified.map((n) => `"${n.name}" (${n.repo})`).join(', ') || '(none)'}`);
    assert.ok(notified.length >= 1, 'SkillTree suggested a skill for an ordinary request');
    assert.ok(asked.length >= 1, 'the user confirmed an install');
    const req = asked[0];
    console.log(`    Dialog (${req.requestedBy?.by}): install "${req.plan.entry.name}" from ${req.plan.entry.owner}/${req.plan.entry.repo}`);
    console.log(`    Claude itself also asked via install_skill: ${asked.some((a) => a.requestedBy?.by === 'claude')}`);
    assert.match(`${req.plan.entry.name} ${req.plan.entry.description}`, /anim|motion|transition/i, 'the suggestion fits the request');
    assert.ok(nodeFs.existsSync(path.join(workspace(), '.claude', 'skills', req.plan.folderName, 'SKILL.md')), 'installed after approval');
    try {
      await waitFor(() => api.activity().events.some((e) => e.source === 'PreToolUse:Skill' && e.skill === req.plan.folderName), 20000, 'Claude to use the new skill');
      console.log(`    Recorded: Claude invoked "${req.plan.folderName}" right after installing it`);
    } catch {
      console.log(`    Note: Claude installed "${req.plan.folderName}" but did not invoke it via the Skill tool in this run`);
    }
    console.log(`    Modal.tsx changed: ${!nodeFs.readFileSync(path.join(workspace(), 'src', 'Modal.tsx'), 'utf8').includes('return <div className="modal">{children}</div>;')}`);

    api.test!.setSuggestionChoice(undefined);
    await fs.rm(projectSettings, { force: true });
    assert.equal((await vscode.commands.executeCommand<{ status: string }>('skilltree.disableTracking')).status, 'disabled');
    api.test!.setConfirm(undefined);
    assert.deepEqual(await Promise.all(realFiles.map(hashOrNull)), realBefore, 'real ~/.claude settings untouched');
  });
});

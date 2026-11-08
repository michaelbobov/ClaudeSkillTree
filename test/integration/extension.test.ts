import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SkillTreeApi } from '../../src/extension';

const EXTENSION_ID = 'skilltree-local.skilltree';

async function waitFor(check: () => boolean, timeoutMs = 15000, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

suite('SkillTree extension', () => {
  let api: SkillTreeApi;
  const workspace = () => vscode.workspace.workspaceFolders![0].uri.fsPath;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<SkillTreeApi>(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} is installed in the development host`);
    api = await ext.activate();
  });

  test('contributes its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['skilltree.openGraph', 'skilltree.refresh', 'skilltree.openSkillFile', 'skilltree.createProjectSkill']) {
      assert.ok(commands.includes(id), `${id} is registered`);
    }
  });

  test('the sidebar is a data tree; the views open from its title actions, the status bar menu and a walkthrough', async () => {
    await api.rescan();
    const rows = api.test!.sidebarRows();
    assert.equal(rows[0].label, 'This project', 'skills grouped by where they live');
    for (const action of ['Skill Tree', 'Marketplace', 'Activity', 'Usage tracking', 'Claude skill suggestions']) {
      assert.ok(!rows.some((r) => r.label === action), `no tree row used as a button (${action})`);
    }
    const pkg = vscode.extensions.getExtension('skilltree-local.skilltree')!.packageJSON;
    const nav = (pkg.contributes.menus['view/title'] as { command: string; group?: string }[]).filter((m) => m.group?.startsWith('navigation')).map((m) => m.command);
    assert.deepEqual(nav.slice(0, 3), ['skilltree.openGraph', 'skilltree.openMarketplace', 'skilltree.openActivity']);
    assert.equal(pkg.contributes.walkthroughs[0].steps.length, 5, 'Get Started walkthrough');
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['skilltree.menu', 'skilltree.openWalkthrough', 'skilltree.openGraph', 'skilltree.openMarketplace', 'skilltree.openActivity']) assert.ok(cmds.includes(c), c);
  });

  test('the Activity Bar container and sidebar view open', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.skilltree');
    await vscode.commands.executeCommand('skilltree.skills.focus');
  });

  test('scans the fixture project and personal skills with distinct scopes', async () => {
    const state = await api.rescan();
    assert.equal(state.status, 'ready');
    const ids = state.skills.map((s) => s.id).sort();
    assert.deepEqual(ids, ['personal/example', 'personal/personal-helper', 'project/workspace/example']);
    const project = state.skills.find((s) => s.id === 'project/workspace/example')!;
    assert.equal(project.source, 'project');
    assert.equal(project.shadowedBy, 'personal/example', 'personal skill takes precedence over the project skill');
  });

  test('opens the Skill Tree editor and the webview script loads under the CSP', async () => {
    await vscode.commands.executeCommand('skilltree.openGraph');
    assert.ok(api.isGraphOpen());
    await waitFor(() => api.isGraphReady(), 20000, 'webview ready message');
  });

  test('opening a skill opens its actual SKILL.md', async () => {
    await vscode.commands.executeCommand('skilltree.openSkillFile', 'project/workspace/example');
    await waitFor(() => !!vscode.window.activeTextEditor, 5000, 'active editor');
    const doc = vscode.window.activeTextEditor!.document;
    assert.equal(await fs.realpath(doc.uri.fsPath), await fs.realpath(path.join(workspace(), '.claude/skills/example/SKILL.md')));
    assert.match(doc.getText(), /Example project skill/);
  });

  test('a newly added project skill appears after refresh', async () => {
    const file = path.join(workspace(), '.claude/skills/added-later/SKILL.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '---\nname: added-later\ndescription: Added during the test\n---\nBody\n');
    try {
      await vscode.commands.executeCommand('skilltree.refresh');
      const state = api.snapshot();
      const added = state.skills.find((s) => s.id === 'project/workspace/added-later');
      assert.ok(added, 'new skill is listed');
      assert.equal(added!.description, 'Added during the test');
    } finally {
      await fs.rm(path.dirname(file), { recursive: true, force: true });
    }
    await vscode.commands.executeCommand('skilltree.refresh');
    assert.ok(!api.snapshot().skills.some((s) => s.id === 'project/workspace/added-later'), 'removed skill disappears');
  });
});

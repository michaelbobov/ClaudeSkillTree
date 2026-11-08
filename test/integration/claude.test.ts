import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SkillTreeApi } from '../../src/extension';
import { CATALOG_SCHEMA_VERSION, type Catalog } from '../../src/shared/catalog';
import { parseInstallResponse } from '../../src/shared/bridge';
import type { ConfirmRequest } from '../../src/services/marketplace';
import { fixtureEntry, waitFor } from './helpers';

const EXTENSION_ID = 'skilltree-local.skilltree';

suite('SkillTree Claude recommendations', () => {
  let api: SkillTreeApi;
  const workspace = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
  const tmp = () => process.env.SKILLTREE_TEST_TMP!;
  const base = () => path.join(process.env.SKILLTREE_HOME!, '.claude', 'skilltree');

  suiteSetup(async () => {
    api = await vscode.extensions.getExtension<SkillTreeApi>(EXTENSION_ID)!.activate();
    assert.ok(api.test);
  });

  suiteTeardown(async () => {
    api.test?.setCatalog(undefined);
    api.test?.setSourceDir(undefined);
    api.test?.setConfirm(undefined);
    api.test?.setClaudeCli(undefined);
    api.test?.setClaudeConsent(undefined);
  });

  test('registers the MCP server with Claude Code only after consent, and removes it again', async () => {
    const calls: string[][] = [];
    api.test!.setClaudeCli(async (args) => (calls.push(args), { code: 0, out: 'ok' }));
    api.test!.setClaudeConsent(async () => false);
    const declined = await vscode.commands.executeCommand<{ status: string }>('skilltree.enableClaudeRecommendations');
    assert.equal(declined.status, 'cancelled');
    assert.equal(calls.length, 0, 'nothing registered without consent');

    api.test!.setClaudeConsent(async () => true);
    const enabled = await vscode.commands.executeCommand<{ status: string; message: string }>('skilltree.enableClaudeRecommendations');
    assert.equal(enabled.status, 'enabled', enabled.message);
    const server = path.join(base(), 'skilltree-mcp.mjs');
    assert.deepEqual(calls[0].slice(0, 6), ['mcp', 'add', '--scope', 'user', 'skilltree', '--']);
    assert.deepEqual(calls[0].slice(-2), [server, base()]);
    assert.ok(existsSync(server), 'server copied to a stable location');
    const settingsFile = path.join(process.env.SKILLTREE_HOME!, '.claude', 'settings.json');
    const hookArgs = () => {
      if (!existsSync(settingsFile)) return [];
      const s = JSON.parse(require('node:fs').readFileSync(settingsFile, 'utf8'));
      return ((s.hooks?.UserPromptSubmit ?? []) as { hooks: { args?: string[] }[] }[]).flatMap((g) => g.hooks.map((h) => h.args?.[0]));
    };
    assert.deepEqual(hookArgs(), [path.join(base(), 'suggest-skills.mjs')], 'UserPromptSubmit suggestion hook added');

    const disabled = await vscode.commands.executeCommand<{ status: string }>('skilltree.disableClaudeRecommendations');
    assert.equal(disabled.status, 'disabled');
    assert.deepEqual(calls[1], ['mcp', 'remove', '--scope', 'user', 'skilltree']);
    assert.ok(!existsSync(server), 'server file removed');
    assert.deepEqual(hookArgs(), [], 'suggestion hook removed');
  });

  test('installs a skill Claude asked for after the user confirms, and reports back', async () => {
    const mirror = path.join(tmp(), 'mirror-claude');
    const entry = await fixtureEntry(mirror, 'claude-asked-demo');
    const catalog: Catalog = { schemaVersion: CATALOG_SCHEMA_VERSION, generatedAt: '2026-01-01T00:00:00Z', source: 'sample', repositories: ['example-owner/example-skills'], entries: [entry] };
    api.test!.setCatalog(catalog);
    api.test!.setSourceDir(mirror);
    const asked: ConfirmRequest[] = [];
    api.test!.setConfirm(async (req) => (asked.push(req), true));
    await api.refreshCatalog();
    api.test!.startClaudeBridge();

    // The bridge publishes the validated catalog for the MCP server.
    const bridge = api.test!.claudeBridgeDir();
    await waitFor(() => existsSync(path.join(bridge, 'catalog.json')), 10000, 'catalog snapshot for the MCP server');

    // Play the MCP server: write an install request like src/mcp/tools.ts does.
    const id = crypto.randomUUID();
    const request = { v: 1, id, skillId: entry.id, scope: 'project', reason: 'The task needs the demo skill.', projectDir: realpathSync(workspace()), createdAt: new Date().toISOString() };
    await fs.mkdir(path.join(bridge, 'requests'), { recursive: true });
    await fs.writeFile(path.join(bridge, 'requests', `${id}.json`), JSON.stringify(request));

    const resFile = path.join(bridge, 'responses', `${id}.json`);
    await waitFor(() => existsSync(resFile), 20000, 'the install response');
    const res = parseInstallResponse(JSON.parse(await fs.readFile(resFile, 'utf8')));
    assert.equal(res?.status, 'installed', res?.message);
    assert.equal(res?.command, '/claude-asked-demo');
    assert.equal(asked[0].kind, 'install');
    assert.deepEqual(asked[0].requestedBy, { by: 'claude', reason: 'The task needs the demo skill.' }, 'the dialog shows Claude\'s reason');
    assert.ok(existsSync(path.join(workspace(), '.claude', 'skills', 'claude-asked-demo', 'SKILL.md')), 'installed into the project');

    // A declined request is reported as cancelled and changes nothing.
    api.test!.setConfirm(async () => false);
    const id2 = crypto.randomUUID();
    await fs.writeFile(path.join(bridge, 'requests', `${id2}.json`), JSON.stringify({ ...request, id: id2, scope: 'global' }));
    const res2File = path.join(bridge, 'responses', `${id2}.json`);
    await waitFor(() => existsSync(res2File), 20000, 'the declined response');
    assert.equal(parseInstallResponse(JSON.parse(await fs.readFile(res2File, 'utf8')))?.status, 'cancelled');
    assert.ok(!existsSync(path.join(process.env.SKILLTREE_HOME!, '.claude', 'skills', 'claude-asked-demo')), 'nothing installed globally');

    await fs.rm(path.join(workspace(), '.claude', 'skills', 'claude-asked-demo'), { recursive: true, force: true });
  });

  test('shows a prompt-matched suggestion as a notification and installs it after both confirmations', async () => {
    const mirror = path.join(tmp(), 'mirror-suggest');
    const entry = await fixtureEntry(mirror, 'suggested-demo');
    api.test!.setCatalog({ schemaVersion: CATALOG_SCHEMA_VERSION, generatedAt: '2026-01-01T00:00:00Z', source: 'sample', repositories: ['example-owner/example-skills'], entries: [entry] });
    api.test!.setSourceDir(mirror);
    const shown: { name: string; repo: string }[] = [];
    api.test!.setSuggestionChoice(async (s) => (shown.push(s), 'project'));
    const asked: ConfirmRequest[] = [];
    api.test!.setConfirm(async (req) => (asked.push(req), true));
    await api.refreshCatalog();
    api.test!.startClaudeBridge();

    // Play the UserPromptSubmit hook.
    const bridge = api.test!.claudeBridgeDir();
    const id = crypto.randomUUID();
    await fs.mkdir(path.join(bridge, 'suggestions'), { recursive: true });
    await fs.writeFile(path.join(bridge, 'suggestions', `${id}.json`), JSON.stringify({ v: 1, id, skillIds: [entry.id], projectDir: realpathSync(workspace()), sessionId: 'sess-1', createdAt: new Date().toISOString() }));

    const dest = path.join(workspace(), '.claude', 'skills', 'suggested-demo', 'SKILL.md');
    await waitFor(() => existsSync(dest), 20000, 'the suggested skill to be installed');
    assert.deepEqual(shown, [{ name: 'suggested-demo', repo: 'example-owner/example-skills' }], 'one notification');
    assert.equal(asked[0].requestedBy?.by, 'suggestion', 'the confirmation dialog still ran');
    assert.ok(!existsSync(path.join(bridge, 'suggestions', `${id}.json`)), 'suggestion consumed');
    api.test!.setSuggestionChoice(undefined);
    await fs.rm(path.dirname(dest), { recursive: true, force: true });
  });
});

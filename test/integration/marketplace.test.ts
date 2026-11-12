import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SkillTreeApi } from '../../src/extension';
import { CATALOG_SCHEMA_VERSION, type Catalog } from '../../src/shared/catalog';
import { SHA, fixtureEntry, waitFor } from './helpers';

const EXTENSION_ID = 'skilltree-local.skilltree';
suite('SkillTree marketplace', () => {
  let api: SkillTreeApi;
  let ext: vscode.Extension<SkillTreeApi>;
  const workspace = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
  const tmp = () => process.env.SKILLTREE_TEST_TMP!;

  suiteSetup(async () => {
    ext = vscode.extensions.getExtension<SkillTreeApi>(EXTENSION_ID)!;
    api = await ext.activate();
    assert.ok(api.test, 'test hooks are available in test mode');
    // The default catalog URL is the hosted daily catalog; these tests stay offline and deterministic.
    await vscode.workspace.getConfiguration('skilltree').update('catalogUrl', '', vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(async () => {
    api.test?.setCatalog(undefined);
    api.test?.setSourceDir(undefined);
    api.test?.setConfirm(undefined);
    await vscode.workspace.getConfiguration('skilltree').update('catalogUrl', undefined, vscode.ConfigurationTarget.Global);
  });

  test('marketplace renders the catalog with provenance', async () => {
    api.test!.setCatalog(undefined);
    const state = await api.refreshCatalog();
    assert.equal(state.origin, 'bundled');
    assert.equal(state.catalog?.source, 'github-index');
    assert.ok(state.entries.length > 0, 'bundled catalog has entries');
    for (const e of state.entries) {
      assert.match(e.commitSha, /^[0-9a-f]{40}$/);
      assert.ok(e.sourceUrl.includes(`/tree/${e.commitSha}`), `${e.id} source URL is pinned`);
      assert.ok(e.indexedAt);
    }
    await vscode.commands.executeCommand('skilltree.openMarketplace');
    await waitFor(() => api.isMarketplaceReady(), 20000, 'marketplace webview ready');
    await waitFor(() => api.marketplaceRenderedCount() === state.entries.length, 20000, 'marketplace rendered every entry');
  });

  test('installs a catalog skill into a sandbox project and shows it as installed', async () => {
    const mirror = path.join(tmp(), 'mirror');
    const entry = await fixtureEntry(mirror, 'it-install-demo');
    const catalog: Catalog = { schemaVersion: CATALOG_SCHEMA_VERSION, generatedAt: '2026-01-01T00:00:00Z', source: 'sample', repositories: ['example-owner/example-skills'], entries: [entry] };
    const asked: string[] = [];
    api.test!.setCatalog(catalog);
    api.test!.setSourceDir(mirror);
    api.test!.setConfirm(async (req) => {
      asked.push(req.kind);
      return req.kind === 'install';
    });
    let state = await api.refreshCatalog();
    assert.equal(state.entries[0].installState, 'not-installed');

    const result = await vscode.commands.executeCommand<{ status: string; destDir?: string; message?: string }>('skilltree.installEntry', entry.id, 'project');
    assert.equal(result.status, 'installed', result.message);
    assert.deepEqual(asked, ['install'], 'the user was asked to confirm');
    const dest = path.join(workspace(), '.claude', 'skills', 'it-install-demo');
    assert.match(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'), /Integration-test skill/);
    const record = JSON.parse(await fs.readFile(path.join(dest, '.skilltree-source.json'), 'utf8'));
    assert.equal(record.commitSha, SHA);

    await waitFor(() => api.marketplace().entries[0]?.installState === 'installed', 10000, 'entry shown as installed');
    state = api.marketplace();
    assert.deepEqual(state.entries[0].localIds, ['project/workspace/it-install-demo']);
    const local = api.snapshot().skills.find((s) => s.id === 'project/workspace/it-install-demo');
    assert.equal(local?.installedFrom?.id, entry.id);
  });

  test('refuses to overwrite an existing skill without confirmation', async () => {
    const dest = path.join(workspace(), '.claude', 'skills', 'it-install-demo');
    await fs.writeFile(path.join(dest, 'SKILL.md'), 'local edits that must survive\n');
    const asked: string[] = [];
    api.test!.setConfirm(async (req) => {
      asked.push(req.kind);
      return req.kind === 'install'; // decline the replace prompt
    });
    const id = api.marketplace().entries[0].id;
    const result = await vscode.commands.executeCommand<{ status: string; message?: string }>('skilltree.installEntry', id, 'project');
    assert.equal(result.status, 'cancelled');
    assert.deepEqual(asked, ['install', 'replace'], 'the replace prompt was shown');
    assert.equal(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'), 'local edits that must survive\n');
    const leftovers = (await fs.readdir(path.dirname(dest))).filter((n) => n.startsWith('.skilltree-'));
    assert.deepEqual(leftovers, [], 'no staging or backup folders left behind');
    await fs.rm(dest, { recursive: true, force: true });
    await api.rescan();
  });

  test('falls back to the cached catalog when offline', async () => {
    api.test!.setCatalog(undefined);
    api.test!.setSourceDir(undefined);
    const url = 'http://127.0.0.1:9/catalog.json'; // nothing listens on the discard port
    const bundled = JSON.parse(await fs.readFile(path.join(ext.extensionPath, 'dist', 'catalog.json'), 'utf8'));
    const cacheFile = api.test!.catalogCacheFile();
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify({ url, fetchedAt: '2026-01-02T03:04:05.000Z', catalog: bundled }));
    await vscode.workspace.getConfiguration('skilltree').update('catalogUrl', url, vscode.ConfigurationTarget.Global);
    const state = await api.refreshCatalog();
    assert.equal(state.origin, 'cache');
    assert.equal(state.fetchedAt, '2026-01-02T03:04:05.000Z');
    assert.match(state.error ?? '', /127\.0\.0\.1/);
    assert.equal(state.entries.length, bundled.entries.length);
    await vscode.workspace.getConfiguration('skilltree').update('catalogUrl', '', vscode.ConfigurationTarget.Global);
  });
});

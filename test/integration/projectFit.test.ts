import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SkillTreeApi } from '../../src/extension';
import { CATALOG_SCHEMA_VERSION, type Catalog } from '../../src/shared/catalog';
import { fixtureEntry, waitFor } from './helpers';

const EXTENSION_ID = 'skilltree-local.skilltree';

suite('SkillTree for this project', () => {
  let api: SkillTreeApi;
  const workspace = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
  const tmp = () => process.env.SKILLTREE_TEST_TMP!;
  const manifest = () => path.join(workspace(), 'package.json');
  const suggested = (id: string) => !!api.marketplace().forProject?.items.some((i) => i.id === id);

  suiteSetup(async () => {
    api = await vscode.extensions.getExtension<SkillTreeApi>(EXTENSION_ID)!.activate();
    assert.ok(api.test, 'test hooks are available in test mode');
  });

  suiteTeardown(async () => {
    api.test?.setCatalog(undefined);
    api.test?.setSourceDir(undefined);
    api.test?.setConfirm(undefined);
    await vscode.workspace.getConfiguration('skilltree').update('projectSuggestions', undefined, vscode.ConfigurationTarget.Global);
    await fs.rm(manifest(), { force: true });
    await fs.rm(path.join(workspace(), '.claude', 'skills', 'nextjs-fit-demo'), { recursive: true, force: true });
  });

  test('suggests a skill for a technology the folder uses, follows changes, and drops it once installed', async () => {
    const mirror = path.join(tmp(), 'mirror-fit');
    const next = await fixtureEntry(mirror, 'nextjs-fit-demo');
    const other = await fixtureEntry(mirror, 'it-other-demo');
    const catalog: Catalog = { schemaVersion: CATALOG_SCHEMA_VERSION, generatedAt: '2026-01-01T00:00:00Z', source: 'sample', repositories: ['example-owner/example-skills'], entries: [next, other] };
    api.test!.setCatalog(catalog);
    api.test!.setSourceDir(mirror);
    await api.refreshCatalog();

    // The fixture folder has no known technology yet.
    assert.equal(api.marketplace().forProject, undefined);

    // Adding a manifest is picked up by the file watcher, without a refresh.
    await fs.writeFile(manifest(), JSON.stringify({ name: 'fit-demo', dependencies: { next: '15.0.0', react: '19.0.0' } }));
    await waitFor(() => suggested(next.id), 20000, 'the Next.js skill is suggested after package.json appears');
    const fp = api.marketplace().forProject!;
    assert.equal(fp.summary, 'React and Next.js');
    assert.equal(fp.items.find((i) => i.id === next.id)?.reason, 'About Next.js (package.json: next)');
    assert.ok(!suggested(other.id), 'a skill that names no technology of this folder is not suggested');

    // The setting turns it off and on again.
    await vscode.workspace.getConfiguration('skilltree').update('projectSuggestions', false, vscode.ConfigurationTarget.Global);
    await waitFor(() => api.marketplace().forProject === undefined, 20000, 'suggestions cleared when the setting is off');
    await vscode.workspace.getConfiguration('skilltree').update('projectSuggestions', undefined, vscode.ConfigurationTarget.Global);
    await waitFor(() => suggested(next.id), 20000, 'suggestions back when the setting is on');

    // Installing it (with the usual confirmation) removes it from the suggestions.
    api.test!.setConfirm(async (req) => req.kind === 'install');
    const result = await vscode.commands.executeCommand<{ status: string; message?: string }>('skilltree.installEntry', next.id, 'project');
    assert.equal(result.status, 'installed', result.message);
    await waitFor(() => !suggested(next.id), 20000, 'an installed skill is no longer suggested');
  });
});

// Shared helpers for integration tests (bundled into each test file).
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gitBlobSha } from '../../src/core/installer';
import { entryId, pinnedSourceUrl, type CatalogEntry } from '../../src/shared/catalog';

export const SHA = '0123456789abcdef0123456789abcdef01234567';

export async function waitFor(check: () => boolean, timeoutMs = 15000, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A local mirror laid out like <root>/<owner>/<repo>/<sha>/<path>, plus the matching catalog entry. */
export async function fixtureEntry(mirror: string, name: string): Promise<CatalogEntry> {
  const dir = `skills/${name}`;
  const files: Record<string, string> = {
    'SKILL.md': `---\nname: ${name}\ndescription: Integration-test skill installed from a local mirror.\n---\n\n# ${name}\n`,
    'reference.md': '# Reference\n',
  };
  const list = [];
  for (const [rel, text] of Object.entries(files)) {
    const buf = Buffer.from(text);
    const abs = path.join(mirror, 'example-owner', 'example-skills', SHA, 'skills', name, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);
    list.push({ path: rel, size: buf.length, sha: gitBlobSha(buf), kind: 'markdown' as const });
  }
  return {
    id: entryId('example-owner', 'example-skills', dir),
    name,
    description: 'Integration-test skill installed from a local mirror.',
    category: 'Testing',
    categorySource: 'inferred',
    owner: 'example-owner',
    repo: 'example-skills',
    path: dir,
    sourceUrl: pinnedSourceUrl('example-owner', 'example-skills', SHA, dir),
    commitSha: SHA,
    license: null,
    licenseSource: null,
    updatedAt: '2026-01-01T00:00:00Z',
    indexedAt: '2026-01-01T00:00:00Z',
    kind: 'skill',
    files: list,
    warnings: [],
  };
}


// Builds a catalog entry plus a matching local mirror (for directoryProvider) from file contents.
// The owner "example-owner" is fictional and used only in tests.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gitBlobSha } from '../../../src/core/installer';
import { CATALOG_SCHEMA_VERSION, entryId, pinnedSourceUrl, type Catalog, type CatalogEntry, type CatalogFile } from '../../../src/shared/catalog';

export const SHA = 'c'.repeat(40);

export async function makeEntry(
  mirrorRoot: string,
  files: Record<string, string>,
  opts: { name?: string; dir?: string; commitSha?: string; kinds?: Record<string, CatalogFile['kind']> } = {},
): Promise<CatalogEntry> {
  const dir = opts.dir ?? `skills/${opts.name ?? 'demo-skill'}`;
  const commitSha = opts.commitSha ?? SHA;
  const list: CatalogFile[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const buf = Buffer.from(content);
    const abs = path.join(mirrorRoot, 'example-owner', 'example-skills', commitSha, ...dir.split('/'), ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);
    list.push({ path: rel, size: buf.length, sha: gitBlobSha(buf), kind: opts.kinds?.[rel] ?? (rel.endsWith('.md') ? 'markdown' : 'other') });
  }
  return {
    id: entryId('example-owner', 'example-skills', dir),
    name: opts.name ?? 'demo-skill',
    description: 'Demo skill for tests',
    category: 'Testing',
    categorySource: 'inferred',
    owner: 'example-owner',
    repo: 'example-skills',
    path: dir,
    sourceUrl: pinnedSourceUrl('example-owner', 'example-skills', commitSha, dir),
    commitSha,
    license: 'MIT',
    licenseSource: 'frontmatter',
    updatedAt: '2025-12-31T00:00:00Z',
    indexedAt: '2026-01-01T00:00:00Z',
    kind: 'skill',
    files: list,
    warnings: [],
  };
}

export function catalogOf(entries: CatalogEntry[], source: Catalog['source'] = 'github-index'): Catalog {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt: '2026-01-01T00:00:00Z',
    source,
    repositories: [...new Set(entries.map((e) => `${e.owner}/${e.repo}`))],
    entries,
    skipped: [],
  };
}

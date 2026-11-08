import { CATALOG_LIMITS } from '../../src/shared/catalog';
import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { installStateFor, isSafeRelativePath, parseInstallRecord, pinnedSourceUrl, validateCatalog, type CatalogEntry } from '../../src/shared/catalog';
import { SHA, catalogOf } from './helpers/catalogFixtures';

const entry: CatalogEntry = {
  id: 'example-owner/example-skills:skills/demo',
  name: 'demo',
  description: 'Demo',
  category: 'Testing',
  categorySource: 'inferred',
  owner: 'example-owner',
  repo: 'example-skills',
  path: 'skills/demo',
  sourceUrl: pinnedSourceUrl('example-owner', 'example-skills', SHA, 'skills/demo'),
  commitSha: SHA,
  license: null,
  licenseSource: null,
  updatedAt: null,
  indexedAt: '2026-01-01T00:00:00Z',
  kind: 'skill',
  files: [{ path: 'SKILL.md', size: 10, sha: 'd'.repeat(40), kind: 'markdown' }],
  warnings: [],
};

const errorsOf = (patch: Partial<CatalogEntry> | Record<string, unknown>, top: Record<string, unknown> = {}) => {
  const r = validateCatalog({ ...catalogOf([{ ...entry, ...patch } as CatalogEntry]), ...top });
  return r.ok ? [] : r.errors;
};

describe('validateCatalog', () => {
  it('accepts a valid catalog', () => {
    expect(validateCatalog(catalogOf([entry])).ok).toBe(true);
  });

  it('validates repository stats: owner/repo keys, non-negative integer stars, ISO dates', () => {
    const ok = { ...catalogOf([entry]), repositoryStats: { 'o/r': { stars: 12, fetchedAt: '2026-01-01T00:00:00Z' } } };
    expect(validateCatalog(ok).ok).toBe(true);
    for (const bad of [
      { 'o/r': { stars: -1, fetchedAt: '2026-01-01T00:00:00Z' } },
      { 'o/r': { stars: 1.5, fetchedAt: '2026-01-01T00:00:00Z' } },
      { 'o/r': { stars: '9k', fetchedAt: '2026-01-01T00:00:00Z' } },
      { 'o/r': { stars: 3, fetchedAt: 'yesterday' } },
      { '../x': { stars: 3, fetchedAt: '2026-01-01T00:00:00Z' } },
      [],
    ]) {
      expect(validateCatalog({ ...catalogOf([entry]), repositoryStats: bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('accepts the bundled real catalog and the labeled sample', () => {
    for (const f of ['data/catalog.json', 'data/catalog.sample.json']) {
      const r = validateCatalog(JSON.parse(fs.readFileSync(f, 'utf8')));
      expect(r.ok, f).toBe(true);
    }
    expect(JSON.parse(fs.readFileSync('data/catalog.sample.json', 'utf8')).source).toBe('sample');
  });

  it('rejects non-objects, unknown schema versions and bad sources', () => {
    expect(validateCatalog(null).ok).toBe(false);
    expect(validateCatalog([]).ok).toBe(false);
    expect(errorsOf({}, { schemaVersion: 2 })[0]).toMatch(/schemaVersion/);
    expect(errorsOf({}, { source: 'made-up' })[0]).toMatch(/source/);
  });

  it('rejects missing fields and wrong types', () => {
    expect(errorsOf({ name: '' }).join()).toMatch(/name/);
    expect(errorsOf({ category: 'Gardening' }).join()).toMatch(/category/);
    expect(errorsOf({ files: 'nope' } as never).join()).toMatch(/files/);
    expect(errorsOf({ license: 5 } as never).join()).toMatch(/license/);
    expect(errorsOf({ license: null, licenseSource: 'frontmatter' }).join()).toMatch(/licenseSource/);
  });

  it('requires a 40-hex commit SHA and a source URL pinned to it', () => {
    expect(errorsOf({ commitSha: 'main' }).join()).toMatch(/commitSha/);
    expect(errorsOf({ sourceUrl: 'https://github.com/example-owner/example-skills/tree/main/skills/demo' }).join()).toMatch(/pinned/);
  });

  it('requires a consistent id and rejects duplicates', () => {
    expect(errorsOf({ id: 'other/thing:x' }).join()).toMatch(/id must be/);
    const r = validateCatalog(catalogOf([entry, entry]));
    expect(r.ok).toBe(false);
  });

  it('rejects unsafe paths, missing SKILL.md and oversized files', () => {
    expect(errorsOf({ path: '../escape' }).join()).toMatch(/path/);
    expect(errorsOf({ files: [{ path: '../x', size: 1, sha: 'd'.repeat(40), kind: 'other' }] }).join()).toMatch(/safe relative path/);
    expect(errorsOf({ files: [{ path: 'README.md', size: 1, sha: 'd'.repeat(40), kind: 'markdown' }] }).join()).toMatch(/SKILL.md/);
    expect(errorsOf({ files: [{ path: 'SKILL.md', size: CATALOG_LIMITS.maxFileBytes + 1, sha: 'd'.repeat(40), kind: 'markdown' }] }).join()).toMatch(/size/);
  });
});

describe('isSafeRelativePath', () => {
  it('rejects traversal, absolute and odd paths', () => {
    for (const p of ['../a', 'a/../b', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', './a', 'a/./b', 'nul\u0000']) expect(isSafeRelativePath(p), p).toBe(false);
    for (const p of ['SKILL.md', 'scripts/run.sh', '.claude/skills/x/SKILL.md', 'refs/A B (1).md']) expect(isSafeRelativePath(p), p).toBe(true);
    expect(isSafeRelativePath('', true)).toBe(true);
    expect(isSafeRelativePath('')).toBe(false);
  });
});

describe('installStateFor', () => {
  it('treats a same-named skill installed some other way as possibly installed', () => {
    const e = { ...entry, name: 'design-taste-frontend', path: 'skills/taste-skill' } as CatalogEntry;
    expect(installStateFor(e, [{ id: 'personal/design-taste-frontend', source: 'personal', dirName: 'design-taste-frontend', name: 'design-taste-frontend' }])).toEqual({ state: 'unknown', localIds: ['personal/design-taste-frontend'] });
    expect(installStateFor(e, [{ id: 'synced/x', source: 'synced', dirName: 'x', name: 'Design-Taste-Frontend' }]).state).toBe('unknown');
    expect(installStateFor(e, [{ id: 'personal/other', source: 'personal', dirName: 'other', name: 'other' }]).state).toBe('not-installed');
  });

  const rec = { id: entry.id, commitSha: SHA };
  it('uses exact provenance, never name alone', () => {
    expect(installStateFor(entry, []).state).toBe('not-installed');
    expect(installStateFor(entry, [{ id: 'personal/demo', source: 'personal', dirName: 'demo', installedFrom: rec }])).toEqual({ state: 'installed', localIds: ['personal/demo'] });
    expect(installStateFor(entry, [{ id: 'personal/demo', source: 'personal', dirName: 'demo', installedFrom: { ...rec, commitSha: 'e'.repeat(40) } }]).state).toBe('update-available');
    expect(installStateFor(entry, [{ id: 'personal/demo', source: 'personal', dirName: 'demo' }]).state).toBe('unknown');
    expect(installStateFor(entry, [{ id: 'synced/demo', source: 'synced', dirName: 'demo' }]).state).toBe('not-installed');
  });
});

describe('parseInstallRecord', () => {
  it('accepts only consistent records', () => {
    const good = { schema: 1, id: entry.id, owner: entry.owner, repo: entry.repo, path: entry.path, commitSha: SHA, sourceUrl: entry.sourceUrl, indexedAt: entry.indexedAt, installedAt: '2026-01-02T00:00:00Z' };
    expect(parseInstallRecord(good)).not.toBeNull();
    expect(parseInstallRecord({ ...good, id: 'x' })).toBeNull();
    expect(parseInstallRecord({ ...good, sourceUrl: 'https://evil.example' })).toBeNull();
    expect(parseInstallRecord('nope')).toBeNull();
  });
});

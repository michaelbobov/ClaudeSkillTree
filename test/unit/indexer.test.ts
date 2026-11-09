import { CATALOG_LIMITS } from '../../src/shared/catalog';
import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCatalog, dedupeEntries, fetchRepositoryStats, fileKind, mergeCatalogs, filesForSkill, indexRepository, RateLimitError, recategorizeCatalog, replayHttpClient, searchRepositories, skillDirectories, type HttpClient } from '../../src/core/githubIndex';
import { validateCatalog } from '../../src/shared/catalog';

const routes = JSON.parse(fs.readFileSync('test/fixtures/github/routes.json', 'utf8'));
const now = () => new Date('2026-01-01T00:00:00Z');

describe('indexRepository (replayed fixture)', () => {
  it('produces pinned, validated entries and explains skips', async () => {
    const catalog = await buildCatalog({ repositories: ['example-owner/example-skills', 'example-owner/missing-repo'] }, replayHttpClient(routes), { now });
    expect(validateCatalog(catalog).ok).toBe(true);
    expect(catalog.entries.map((e) => e.path)).toEqual(['skills/good-skill', 'skills/no-frontmatter', 'skills/plugin-part']);
    const good = catalog.entries[0];
    expect(good.commitSha).toBe('a'.repeat(40));
    expect(good.sourceUrl).toBe(`https://github.com/example-owner/example-skills/tree/${'a'.repeat(40)}/skills/good-skill`);
    expect(good.license).toBe('MIT');
    expect(good.licenseSource).toBe('frontmatter');
    expect(good.files.map((f) => [f.path, f.kind])).toEqual([
      ['SKILL.md', 'markdown'],
      ['link', 'symlink'],
      ['reference.md', 'markdown'],
      ['scripts/run.sh', 'script'],
    ]);
    expect(good.warnings.join(' ')).toMatch(/script/);
    expect(good.warnings.join(' ')).toMatch(/symbolic link/);
    expect(good.warnings.join(' ')).toMatch(/Pre-approves tools/);
    const noFm = catalog.entries[1];
    expect(noFm.name).toBe('no-frontmatter');
    expect(noFm.description).toBe('Instructions without frontmatter.');
    expect(noFm.license).toBe('Apache-2.0');
    expect(noFm.licenseSource).toBe('repository');
    expect(catalog.entries[2].kind).toBe('plugin-unsupported');
    expect(catalog.skipped?.map((s) => s.reason)).toEqual([expect.stringMatching(/limit/), expect.stringMatching(/not found/)]);
    expect(catalog.repositories).toEqual(['example-owner/example-skills']);
  });

  it('raises a clear error when rate limited', async () => {
    const http = { get: async () => ({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1767225600' }, body: '{}' }) };
    await expect(indexRepository('example-owner/example-skills', http)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('rejects invalid repository names without requests', async () => {
    const r = await indexRepository('../etc', { get: async () => { throw new Error('should not be called'); } });
    expect(r.skipped[0].reason).toMatch(/invalid/);
  });
});

describe('tree helpers', () => {
  it('finds skill directories and classifies files', () => {
    const tree = [
      { path: 'SKILL.md', mode: '100644', type: 'blob' as const, sha: '1'.repeat(40), size: 1 },
      { path: 'a/SKILL.md', mode: '100644', type: 'blob' as const, sha: '1'.repeat(40), size: 1 },
      { path: 'a/NOTSKILL.md', mode: '100644', type: 'blob' as const, sha: '1'.repeat(40), size: 1 },
    ];
    expect(skillDirectories(tree)).toEqual(['', 'a']);
    expect(fileKind({ path: 'x', mode: '120000', type: 'blob' })).toBe('symlink');
    expect(fileKind({ path: 'x', mode: '160000', type: 'commit' })).toBe('submodule');
    expect(fileKind({ path: 'bin/tool', mode: '100755', type: 'blob' })).toBe('executable');
    expect(fileKind({ path: 'x.py', mode: '100644', type: 'blob' })).toBe('script');
  });

  it('enforces file count limits', () => {
    const tree = Array.from({ length: CATALOG_LIMITS.maxFilesPerSkill + 5 }, (_, i) => ({ path: `s/f${i}.md`, mode: '100644', type: 'blob' as const, sha: '1'.repeat(40), size: 1 }));
    expect(filesForSkill(tree, 's').problem).toMatch(/more than/);
  });
});

describe('repository search', () => {
  const q = (query: string, page = 1) => `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=30&page=${page}`;
  const item = (full_name: string, fork = false) => ({ full_name, private: false, fork });
  const searchRoutes = {
    [q('topic:a')]: { status: 200, body: { items: [item('o/one'), item('o/fork-of-one', true), item('o/two'), item('o/three')] } },
    [q('topic:b')]: { status: 200, body: { items: [item('o/two'), item('o/four'), item('o/five')] } },
  };

  it('ranks by stars and skips forks', async () => {
    expect(await searchRepositories('topic:a', replayHttpClient(searchRoutes), 10)).toEqual(['o/one', 'o/two', 'o/three']);
  });

  it('caps repositories added by all queries together', async () => {
    const requested: string[] = [];
    const inner = replayHttpClient(searchRoutes);
    const http: HttpClient = { get: (url, accept) => (requested.push(url), inner.get(url, accept)) };
    const catalog = await buildCatalog({ repositories: ['seed/repo'], searchQueries: ['topic:a', 'topic:b'], maxSearchRepositories: 4 }, http, { search: true, now });
    const indexedRepos = [...new Set(requested.filter((u) => u.startsWith('https://api.github.com/repos/')).map((u) => u.split('/').slice(4, 6).join('/')))];
    expect(indexedRepos).toEqual(['seed/repo', 'o/one', 'o/two', 'o/three', 'o/four']);
    expect(catalog.entries).toEqual([]);
  });

  it('adds recently created repositories from the same queries when newWithinDays is set', async () => {
    const recent = `https://api.github.com/search/repositories?q=${encodeURIComponent('topic:a created:>2025-12-02')}&sort=stars&order=desc&per_page=30&page=1`;
    const requested: string[] = [];
    const inner = replayHttpClient({ ...searchRoutes, [recent]: { status: 200, body: { items: [item('o/fresh'), item('o/one')] } } });
    const http: HttpClient = { get: (url, accept) => (requested.push(url), inner.get(url, accept)) };
    await buildCatalog({ repositories: [], searchQueries: ['topic:a'], maxSearchRepositories: 1, newWithinDays: 30, maxNewRepositories: 5 }, http, { search: true, now });
    expect(requested).toContain(recent);
    expect(requested.some((u) => u === 'https://api.github.com/repos/o/fresh')).toBe(true);
  });
});

describe('dedupeEntries', () => {
  const entry = (owner: string, repo: string, p: string, sha: string) =>
    ({ id: `${owner}/${repo}:${p}`, owner, repo, path: p, files: [{ path: 'SKILL.md', size: 1, sha, kind: 'markdown' }] }) as unknown as import('../../src/shared/catalog').CatalogEntry;

  it('keeps one copy of a byte-identical SKILL.md: earliest repository, then shortest path', () => {
    const r = dedupeEntries(
      [entry('b', 'copy', 'skills/pdf', 'a'.repeat(40)), entry('a', 'seed', 'nested/deep/pdf', 'a'.repeat(40)), entry('a', 'seed', 'pdf', 'a'.repeat(40)), entry('a', 'seed', 'docx', 'b'.repeat(40))],
      ['a/seed', 'b/copy'],
    );
    expect(r.entries.map((e) => e.id)).toEqual(['a/seed:pdf', 'a/seed:docx']);
    expect(r.skipped).toEqual([
      { repo: 'b/copy', path: 'skills/pdf', reason: 'same SKILL.md as a/seed:pdf' },
      { repo: 'a/seed', path: 'nested/deep/pdf', reason: 'same SKILL.md as a/seed:pdf' },
    ]);
  });
});

describe('fetchRepositoryStats', () => {
  it('reads stargazers_count from the repository metadata, skipping invalid names and missing data', async () => {
    const http = replayHttpClient({
      'https://api.github.com/repos/o/one': { status: 200, body: { stargazers_count: 42 } },
      'https://api.github.com/repos/o/two': { status: 200, body: {} },
    });
    expect(await fetchRepositoryStats(['o/one', 'o/two', 'o/missing', '../etc'], http, now)).toEqual({ 'o/one': { stars: 42, fetchedAt: '2026-01-01T00:00:00.000Z' } });
  });
});

describe('mergeCatalogs', () => {
  const e = (repo: string, p: string, sha: string) => {
    const [owner, name] = repo.split('/');
    return { id: `${repo}:${p}`, owner, repo: name, path: p, files: [{ path: 'SKILL.md', size: 1, sha, kind: 'markdown' }] } as unknown as import('../../src/shared/catalog').CatalogEntry;
  };
  const cat = (repositories: string[], entries: ReturnType<typeof e>[], stars: Record<string, number>) =>
    ({ schemaVersion: 1, generatedAt: '2026-01-01T00:00:00Z', source: 'github-index', repositories, entries, skipped: [], repositoryStats: Object.fromEntries(Object.entries(stars).map(([k, v]) => [k, { stars: v, fetchedAt: '2026-01-01T00:00:00Z' }])) }) as unknown as import('../../src/shared/catalog').Catalog;

  it('replaces re-indexed repositories, appends new ones and drops copies of existing skills', () => {
    const base = cat(['a/one', 'b/two'], [e('a/one', 'x', '1'.repeat(40)), e('b/two', 'old', '2'.repeat(40))], { 'a/one': 5, 'b/two': 6 });
    const addition = cat(['b/two', 'c/three'], [e('b/two', 'new', '3'.repeat(40)), e('c/three', 'copy-of-x', '1'.repeat(40)), e('c/three', 'y', '4'.repeat(40))], { 'b/two': 7, 'c/three': 8 });
    const m = mergeCatalogs(base, addition);
    expect(m.repositories).toEqual(['a/one', 'b/two', 'c/three']);
    expect(m.entries.map((x) => x.id)).toEqual(['a/one:x', 'b/two:new', 'c/three:y']);
    expect(m.skipped).toEqual([{ repo: 'c/three', path: 'copy-of-x', reason: 'same SKILL.md as a/one:x' }]);
    expect(m.repositoryStats).toMatchObject({ 'a/one': { stars: 5 }, 'b/two': { stars: 7 }, 'c/three': { stars: 8 } });
  });
});

describe('dedupeEntries: mirrors and fixtures', () => {
  const entry = (p: string, name: string, sha: string) =>
    ({ id: `o/r:${p}`, owner: 'o', repo: 'r', path: p, name, files: [{ path: 'SKILL.md', size: 1, sha, kind: 'markdown' }] }) as unknown as import('../../src/shared/catalog').CatalogEntry;

  it('keeps one copy per skill name in a repository, preferring .claude/skills then skills/', () => {
    const r = dedupeEntries([entry('.cursor/skills/polish', 'polish', '1'.repeat(40)), entry('.claude/skills/polish', 'polish', '2'.repeat(40)), entry('skills/polish', 'polish', '3'.repeat(40)), entry('skills/audit', 'audit', '4'.repeat(40))], ['o/r']);
    expect(r.entries.map((e) => e.path)).toEqual(['.claude/skills/polish', 'skills/audit']);
    expect(r.skipped.map((s) => s.path)).toEqual(['.cursor/skills/polish', 'skills/polish']);
  });

  it('does not treat SKILL.md files in test fixtures or node_modules as published skills', () => {
    const blob = (path: string) => ({ path, mode: '100644', type: 'blob' as const, sha: '1'.repeat(40), size: 1 });
    expect(skillDirectories([blob('skills/a/SKILL.md'), blob('tests/oracle/x/.claude/skills/b/SKILL.md'), blob('pkg/node_modules/c/SKILL.md'), blob('fixtures/d/SKILL.md'), blob('SKILL.md')])).toEqual(['', 'skills/a']);
  });

  it('does not index a SKILL.md that is a symbolic link (its blob is only the target path)', () => {
    const item = (path: string, mode: string) => ({ path, mode, type: 'blob' as const, sha: '1'.repeat(40), size: 30 });
    expect(skillDirectories([item('.gemini/skills/okr/SKILL.md', '120000'), item('skills/okr/SKILL.md', '100644'), item('skills/run/SKILL.md', '100755')])).toEqual(['skills/okr', 'skills/run']);
  });
});

describe('recategorizeCatalog', () => {
  const file = (kind: 'markdown' | 'symlink') => [{ path: 'SKILL.md', size: 30, sha: '1'.repeat(40), kind }];
  const entry = (p: string, name: string, description: string, extra: Record<string, unknown> = {}) =>
    ({ id: `o/r:${p}`, owner: 'o', repo: 'r', path: p, name, description, category: 'Other', categorySource: 'default', files: file('markdown'), ...extra }) as unknown as import('../../src/shared/catalog').CatalogEntry;

  it('re-infers automatic categories, keeps frontmatter ones, and drops linked SKILL.md entries', () => {
    const catalog = {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00Z',
      source: 'github-index',
      repositories: ['o/r'],
      entries: [
        entry('finance/skills/close', 'month-end-close', 'Run the close.'),
        entry('skills/mine', 'mine', 'Whatever.', { category: 'Design', categorySource: 'frontmatter' }),
        entry('.gemini/skills/okr', 'okr', '../../../commands/okr.md', { files: file('symlink') }),
      ],
    } as unknown as import('../../src/shared/catalog').Catalog;
    const r = recategorizeCatalog(catalog);
    expect(r.dropped).toBe(1);
    expect(r.moved).toBe(1);
    expect(r.catalog.entries.map((e) => [e.name, e.category, e.categorySource])).toEqual([
      ['month-end-close', 'Business', 'inferred'],
      ['mine', 'Design', 'frontmatter'],
    ]);
    expect(r.catalog.skipped).toEqual([{ repo: 'o/r', path: '.gemini/skills/okr', reason: 'SKILL.md is a symbolic link' }]);
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { profileProject, profileSummary, recommendForProject, TECH_RULES, type ProjectProfile } from '../../src/shared/projectFit';
import { manifestDeps, scanProject } from '../../src/core/projectScan';
import { availableFor } from '../../src/shared/recommend';
import type { Catalog, CatalogEntry } from '../../src/shared/catalog';

const entry = (repo: string, name: string, description: string, p = `skills/${name}`): CatalogEntry =>
  ({ id: `${repo}:${p}`, name, description, owner: repo.split('/')[0], repo: repo.split('/')[1], path: p, category: 'Frontend', kind: 'skill', files: [] }) as unknown as CatalogEntry;

const catalogOf = (entries: CatalogEntry[], stars: Record<string, number> = {}): Catalog =>
  ({
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00Z',
    source: 'github-index',
    repositories: [],
    entries,
    repositoryStats: Object.fromEntries(Object.entries(stars).map(([k, v]) => [k, { stars: v, fetchedAt: '2026-01-01T00:00:00Z' }])),
  }) as unknown as Catalog;

const all = () => true;

describe('profileProject', () => {
  it('detects technologies from dependencies, config files and file counts, with evidence', () => {
    const p = profileProject({
      files: ['package.json', 'next.config.mjs', 'tailwind.config.ts', 'scripts/a.py', '.github/workflows/ci.yml', 'Dockerfile'],
      deps: [{ manifest: 'package.json', names: ['next', 'react', 'react-dom', '@playwright/test'] }],
    });
    const byId = Object.fromEntries(p.techs.map((t) => [t.id, t.evidence]));
    expect(byId.nextjs).toBe('package.json: next');
    expect(byId.react).toBe('package.json: react');
    expect(byId.playwright).toBe('package.json: @playwright/test');
    expect(byId.tailwind).toBe('tailwind.config.ts');
    expect(byId['github-actions']).toBe('.github/workflows/ci.yml');
    expect(byId.docker).toBe('Dockerfile');
    // One stray .py script does not make a Python project (needs 3 files or a Python manifest).
    expect(byId.python).toBeUndefined();
  });

  it('counts extension-only technologies above their threshold', () => {
    const p = profileProject({ files: ['a.py', 'b.py', 'pkg/c.py', 'main.tf'], deps: [] });
    expect(p.techs.map((t) => [t.id, t.evidence])).toEqual([
      ['python', '3 .py files'],
      ['terraform', '1 .tf file'],
    ]);
  });

  it('ignores a language seen only in a few helper scripts of a project in another language', () => {
    const swift = Array.from({ length: 30 }, (_, i) => `App/View${i}.swift`);
    const p = profileProject({ files: [...swift, 'tools/a.py', 'tools/b.py', 'tools/c.py', 'tools/d.py'], deps: [] });
    expect(p.techs.map((t) => t.id)).toEqual(['swift']);
    // A Python manifest is evidence on its own, whatever the file counts.
    const q = profileProject({ files: [...swift, 'tools/a.py', 'requirements.txt'], deps: [] });
    expect(q.techs.map((t) => [t.id, t.evidence])).toEqual([
      ['python', 'requirements.txt'],
      ['swift', '30 .swift files'],
    ]);
  });

  it('recognises a VS Code extension from engines.vscode', () => {
    const p = profileProject({ files: ['package.json'], deps: [{ manifest: 'package.json', names: ['engines:vscode'] }] });
    expect(p.techs).toEqual([{ id: 'vscode-extension', label: 'VS Code extension', evidence: 'package.json: engines.vscode' }]);
  });

  it('finds nothing in an empty folder', () => {
    expect(profileProject({ files: [], deps: [] }).techs).toEqual([]);
  });
});

describe('mentions do not match inside other words', () => {
  const rule = (id: string) => TECH_RULES.find((r) => r.id === id)!.mentions;
  it.each([
    ['rust', 'Build trust with users', false],
    ['rust', 'Idiomatic Rust error handling', true],
    ['expo', 'Export data as CSV', false],
    ['expo', 'Expo Router navigation', true],
    ['angular', 'Draw rectangular layouts', false],
    ['react', 'React Native screens', false],
    ['react-native', 'React Native screens', true],
    ['go', 'Go to the next step', false],
    ['go', 'Write idiomatic Go code', true],
    ['stripe', 'A striped table', false],
  ])('%s vs "%s" → %s', (id, text, expected) => {
    expect(rule(id).test(text)).toBe(expected);
  });
});

describe('recommendForProject', () => {
  const profile: ProjectProfile = {
    techs: [
      { id: 'nextjs', label: 'Next.js', evidence: 'package.json: next' },
      { id: 'playwright', label: 'Playwright', evidence: 'package.json: @playwright/test' },
    ],
  };

  it('ranks name mentions above description mentions and explains each with evidence', () => {
    const cat = catalogOf([
      entry('a/skills', 'web-perf', 'Speed up Next.js apps and check them with Playwright'),
      entry('d/skills', 'release-notes', 'Write release notes for Next.js projects'),
      entry('b/skills', 'nextjs-app-router', 'Patterns for the App Router'),
      entry('c/skills', 'copywriting', 'Write marketing copy'),
    ]);
    const recs = recommendForProject(cat, profile, all);
    expect(recs.map((r) => r.id)).toEqual(['b/skills:skills/nextjs-app-router', 'a/skills:skills/web-perf']);
    expect(recs[0].reason).toBe('About Next.js (package.json: next)');
    expect(recs[1].reason).toBe('Mentions Next.js and Playwright (package.json: next, @playwright/test)');
    // One passing mention in a description (release-notes) is not enough.
  });

  it('scores skills that cover several of your technologies higher, then by repository stars', () => {
    const cat = catalogOf(
      [entry('a/skills', 'e2e', 'End-to-end tests for Next.js apps with Playwright'), entry('b/skills', 'next-tips', 'Tips'), entry('c/skills', 'nextjs-seo', 'SEO')],
      { 'b/skills': 10, 'c/skills': 500 },
    );
    expect(recommendForProject(cat, profile, all).map((r) => r.id)).toEqual(['c/skills:skills/nextjs-seo', 'a/skills:skills/e2e']);
    // "next-tips" does not say Next.js: "next" alone is too common a word to count.
  });

  it('skips skills you already have and limits each repository', () => {
    const cat = catalogOf([
      entry('big/skills', 'playwright-a', ''),
      entry('big/skills', 'playwright-b', ''),
      entry('big/skills', 'playwright-c', ''),
      entry('small/skills', 'playwright-d', ''),
    ]);
    const have = availableFor([{ name: 'playwright-a', dirName: 'playwright-a' }], new Map());
    expect(recommendForProject(cat, profile, have).map((r) => r.id)).toEqual([
      'big/skills:skills/playwright-b',
      'big/skills:skills/playwright-c',
      'small/skills:skills/playwright-d',
    ]);
    expect(recommendForProject(cat, profile, all, { perRepo: 1 }).map((r) => r.id)).toEqual(['big/skills:skills/playwright-a', 'small/skills:skills/playwright-d']);
  });

  it('counts languages only in names, below frameworks, and caps long description lists', () => {
    const p: ProjectProfile = {
      techs: [
        { id: 'python', label: 'Python', evidence: 'pyproject.toml' },
        { id: 'swift', label: 'Swift', evidence: '10 .swift files' },
        { id: 'fastapi', label: 'FastAPI', evidence: 'pyproject.toml: fastapi' },
        { id: 'django', label: 'Django', evidence: 'pyproject.toml: django' },
        { id: 'flask', label: 'Flask', evidence: 'pyproject.toml: flask' },
      ],
    };
    const cat = catalogOf([
      entry('a/skills', 'code-reviewer', 'Reviews Python and Swift code'),
      entry('b/skills', 'async-python-patterns', 'Async patterns'),
      entry('c/skills', 'fastapi-service', 'Build APIs'),
      entry('d/skills', 'web-backends', 'Covers FastAPI, Django and Flask'),
    ]);
    const recs = recommendForProject(cat, p, all);
    // fastapi in name (3) > python in name (2) = three frameworks in the description (capped at 2) > languages in the description (0).
    expect(recs.map((r) => r.id)).toEqual(['c/skills:skills/fastapi-service', 'b/skills:skills/async-python-patterns', 'd/skills:skills/web-backends']);
    expect(recs[2].reason).toBe('Mentions FastAPI, Django and Flask (pyproject.toml: fastapi, django, flask)');
  });

  it('suggests nothing without detected technologies or matching skills', () => {
    const cat = catalogOf([entry('a/skills', 'nextjs', '')]);
    expect(recommendForProject(cat, { techs: [] }, all)).toEqual([]);
    expect(recommendForProject(catalogOf([entry('a/skills', 'copy', 'Write copy')]), profile, all)).toEqual([]);
  });

  it('summarises the profile in one line', () => {
    expect(profileSummary(profile)).toBe('Next.js and Playwright');
    const many: ProjectProfile = { techs: 'abcdefg'.split('').map((x) => ({ id: x, label: x.toUpperCase(), evidence: '' })) };
    expect(profileSummary(many)).toBe('A, B, C, D, E and 2 more');
  });
});

describe('manifestDeps', () => {
  it('reads package.json dependency blocks and engines.vscode', () => {
    const pkg = JSON.stringify({ dependencies: { react: '^19' }, devDependencies: { '@playwright/test': '1' }, engines: { vscode: '^1.95.0' } });
    expect(manifestDeps('package.json', pkg).sort()).toEqual(['@playwright/test', 'engines:vscode', 'react']);
  });
  it('reads requirements.txt, ignoring comments, options and versions', () => {
    expect(manifestDeps('requirements.txt', '# web\nDjango>=5\n-r base.txt\npandas==2.2 # data\n\nfastapi[all]\n').sort()).toEqual(['django', 'fastapi', 'pandas']);
  });
  it('reads pyproject.toml (PEP 621 and Poetry)', () => {
    const toml = '[project]\ndependencies = [\n  "fastapi>=0.110",\n  "torch",\n]\n\n[tool.poetry.dependencies]\npython = "^3.12"\nflask = "^3"\n';
    expect(manifestDeps('pyproject.toml', toml).sort()).toEqual(['fastapi', 'flask', 'torch']);
  });
  it('reads Cargo.toml, go.mod and Gemfile', () => {
    expect(manifestDeps('Cargo.toml', '[package]\nname = "x"\n[dependencies]\nserde = "1"\ntokio = { version = "1" }\n').sort()).toEqual(['serde', 'tokio']);
    expect(manifestDeps('go.mod', 'module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n)\n')).toEqual(['github.com/gin-gonic/gin']);
    expect(manifestDeps('Gemfile', "source 'https://rubygems.org'\ngem 'rails', '~> 7'\n")).toEqual(['rails']);
  });
  it('returns [] for malformed files', () => {
    expect(manifestDeps('package.json', '{ not json')).toEqual([]);
  });
});

describe('scanProject', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (rel: string, text = '') => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };

  it('lists files and manifests but skips dependency, build and hidden folders', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-scan-'));
    write('package.json', JSON.stringify({ dependencies: { next: '15' } }));
    write('app/page.tsx');
    write('node_modules/react/package.json', JSON.stringify({ dependencies: { 'loose-envify': '1' } }));
    write('.git/config');
    write('.next/server.js');
    write('.github/workflows/ci.yml');
    write('packages/web/package.json', JSON.stringify({ devDependencies: { vitest: '2' } }));
    const facts = await scanProject(dir);
    expect(facts.files).toContain('app/page.tsx');
    expect(facts.files).toContain('.github/workflows/ci.yml');
    expect(facts.files.some((f) => f.startsWith('node_modules') || f.startsWith('.git/') || f.startsWith('.next'))).toBe(false);
    expect(facts.deps).toEqual([
      { manifest: 'package.json', names: ['next'] },
      { manifest: 'packages/web/package.json', names: ['vitest'] },
    ]);
  });

  it('stops at the file limit and does not follow symlinks', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-scan-'));
    for (let i = 0; i < 30; i++) write(`src/f${String(i).padStart(2, '0')}.ts`);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'st-outside-'));
    fs.writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ dependencies: { stripe: '1' } }));
    fs.symlinkSync(outside, path.join(dir, 'linked'));
    try {
      const facts = await scanProject(dir, { maxFiles: 10, maxDepth: 5, maxManifestBytes: 1024, maxManifests: 5 });
      expect(facts.files.length).toBe(10);
      const full = await scanProject(dir);
      expect(full.files.some((f) => f.startsWith('linked'))).toBe(false);
      expect(full.deps).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

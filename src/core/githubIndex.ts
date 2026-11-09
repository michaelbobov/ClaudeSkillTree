// GitHub catalog indexer core. Reads public repository metadata and SKILL.md text; never executes
// anything it downloads. Network access is injected (HttpClient) so tests can replay fixtures.

import * as path from 'node:path';
import { parseSkillMarkdown } from './frontmatter';
import { inferCategory } from './organize';
import {
  CATALOG_LIMITS,
  CATALOG_SCHEMA_VERSION,
  entryId,
  encodePath,
  installFolderName,
  isSafeInstallFolderName,
  isSafeRelativePath,
  pinnedSourceUrl,
  type Catalog,
  type CatalogEntry,
  type CatalogFile,
  type CatalogFileKind,
  type CatalogSkip,
  type RepositoryStats,
} from '../shared/catalog';

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpClient {
  get(url: string, accept?: string): Promise<HttpResponse>;
}

export class RateLimitError extends Error {
  constructor(public readonly resetAt: Date | null) {
    super(`GitHub API rate limit reached${resetAt ? `; resets at ${resetAt.toISOString()}` : ''}. Set GITHUB_TOKEN for a higher limit.`);
  }
}

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

const SCRIPT_EXT = new Set(['.sh', '.bash', '.zsh', '.fish', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl', '.php', '.ps1', '.bat', '.cmd', '.exe', '.lua', '.go', '.rs', '.jar', '.swift', '.applescript']);
const MD_EXT = new Set(['.md', '.markdown', '.mdx', '.txt']);
/** Files whose presence means this is a Claude Code plugin component, not a plain skill. */
const PLUGIN_MARKERS = ['.claude-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json'];

/** GitHub owner/repo names: letters, digits, "-", "_", "." but never "." or ".." alone. */
export function isGitHubName(s: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(s) && s !== '.' && s !== '..';
}

export interface IndexOptions {
  now?: () => Date;
  log?: (message: string) => void;
}

interface TreeItem {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

function parseJson<T>(res: HttpResponse, what: string): T {
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new Error(`Invalid JSON from GitHub for ${what}`);
  }
}

async function api<T>(http: HttpClient, url: string, what: string): Promise<{ status: number; data: T | null }> {
  const res = await http.get(url, 'application/vnd.github+json');
  if ((res.status === 403 || res.status === 429) && (res.headers['x-ratelimit-remaining'] === '0' || res.status === 429)) {
    const reset = Number(res.headers['x-ratelimit-reset']);
    throw new RateLimitError(Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null);
  }
  if (res.status === 404 || res.status === 451) return { status: res.status, data: null };
  if (res.status < 200 || res.status >= 300) throw new Error(`GitHub returned ${res.status} for ${what}`);
  return { status: res.status, data: parseJson<T>(res, what) };
}

export function fileKind(item: Pick<TreeItem, 'path' | 'mode' | 'type'>): CatalogFileKind {
  if (item.mode === '120000') return 'symlink';
  if (item.type === 'commit' || item.mode === '160000') return 'submodule';
  const ext = path.posix.extname(item.path).toLowerCase();
  if (SCRIPT_EXT.has(ext)) return 'script';
  if (item.mode === '100755') return 'executable';
  if (MD_EXT.has(ext)) return 'markdown';
  return 'other';
}

/** Finds skill directories in a recursive git tree listing. */
/** Test fixtures, vendored dependencies: SKILL.md files there are not published skills. */
const NOT_PUBLISHED = /(^|\/)(tests?|__tests__|fixtures?|node_modules)\//i;

export function skillDirectories(tree: TreeItem[]): string[] {
  return tree
    // A SKILL.md that is a symbolic link is not indexed: its blob is the link's target path, not
    // instructions, and the installer never writes links.
    .filter((t) => t.type === 'blob' && t.mode !== '120000' && (t.path === 'SKILL.md' || t.path.endsWith('/SKILL.md')) && !NOT_PUBLISHED.test(t.path))
    .map((t) => (t.path === 'SKILL.md' ? '' : t.path.slice(0, -'/SKILL.md'.length)))
    .sort();
}

export function filesForSkill(tree: TreeItem[], dir: string): { files: CatalogFile[]; problem?: string } {
  const prefix = dir ? `${dir}/` : '';
  const files: CatalogFile[] = [];
  let total = 0;
  for (const t of tree) {
    if (t.type === 'tree') continue;
    if (prefix && !t.path.startsWith(prefix)) continue;
    const rel = t.path.slice(prefix.length);
    if (!isSafeRelativePath(rel)) return { files, problem: `unsafe file path "${rel.slice(0, 80)}"` };
    const kind = fileKind(t);
    const size = kind === 'submodule' ? 0 : t.size ?? 0;
    if (size > CATALOG_LIMITS.maxFileBytes) return { files, problem: `file ${rel} is ${size} bytes (limit ${CATALOG_LIMITS.maxFileBytes})` };
    total += size;
    files.push({ path: rel, size, sha: t.sha, kind });
    if (files.length > CATALOG_LIMITS.maxFilesPerSkill) return { files, problem: `more than ${CATALOG_LIMITS.maxFilesPerSkill} files` };
  }
  if (total > CATALOG_LIMITS.maxSkillBytes) return { files, problem: `total size ${total} bytes (limit ${CATALOG_LIMITS.maxSkillBytes})` };
  files.sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)));
  return { files };
}

function warningsFor(files: CatalogFile[], fm: Record<string, unknown> | null, declaresHooks: boolean, parseErrors: string[]): string[] {
  const w: string[] = [];
  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (files.length > CATALOG_LIMITS.largeSkillFiles || bytes > CATALOG_LIMITS.largeSkillBytes) w.push(`Large skill: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB.`);
  const scripts = files.filter((f) => f.kind === 'script').length;
  const execs = files.filter((f) => f.kind === 'executable').length;
  const links = files.filter((f) => f.kind === 'symlink').length;
  const subs = files.filter((f) => f.kind === 'submodule').length;
  if (scripts) w.push(`Contains ${scripts} script file${scripts === 1 ? '' : 's'} that Claude may run when the skill is used.`);
  if (execs) w.push(`Contains ${execs} other executable file${execs === 1 ? '' : 's'}.`);
  if (links) w.push(`Contains ${links} symbolic link${links === 1 ? '' : 's'}; SkillTree will not install them.`);
  if (subs) w.push(`References ${subs} git submodule${subs === 1 ? '' : 's'}; SkillTree will not install them.`);
  if (declaresHooks) w.push('Declares hooks in its frontmatter that are registered when the skill is invoked.');
  const tools = fm?.['allowed-tools'];
  if (tools !== undefined && tools !== null && tools !== '') {
    const list = Array.isArray(tools) ? tools.join(', ') : String(tools);
    w.push(`Pre-approves tools while active: ${list.slice(0, 160)}`);
  }
  for (const e of parseErrors) w.push(`SKILL.md: ${e.slice(0, 200)}`);
  return w;
}

export interface RepoIndexResult {
  repo: string;
  entries: CatalogEntry[];
  skipped: CatalogSkip[];
  /** From the repository metadata call (no extra request). */
  stats?: RepositoryStats;
}

export async function indexRepository(fullName: string, http: HttpClient, opts: IndexOptions = {}): Promise<RepoIndexResult> {
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const log = opts.log ?? (() => undefined);
  const skipped: CatalogSkip[] = [];
  const entries: CatalogEntry[] = [];
  const [owner, repo, extra] = fullName.split('/');
  if (!owner || !repo || extra !== undefined || !isGitHubName(owner) || !isGitHubName(repo)) {
    return { repo: fullName, entries, skipped: [{ repo: fullName, path: '', reason: 'invalid repository name' }] };
  }

  type RepoInfo = { full_name: string; default_branch: string; private: boolean; archived: boolean; license: { spdx_id: string | null } | null; stargazers_count?: number };
  const info = await api<RepoInfo>(http, `${API}/repos/${owner}/${repo}`, `${fullName} metadata`);
  if (!info.data) return { repo: fullName, entries, skipped: [{ repo: fullName, path: '', reason: `repository not found (HTTP ${info.status})` }] };
  if (info.data.private) return { repo: fullName, entries, skipped: [{ repo: fullName, path: '', reason: 'repository is private' }] };
  const repoLicense = info.data.license?.spdx_id && info.data.license.spdx_id !== 'NOASSERTION' ? info.data.license.spdx_id : null;

  type CommitInfo = { sha: string; commit: { committer: { date: string } | null; tree: { sha: string } } };
  const commit = await api<CommitInfo>(http, `${API}/repos/${owner}/${repo}/commits/${encodeURIComponent(info.data.default_branch)}`, `${fullName} head commit`);
  if (!commit.data || !/^[0-9a-f]{40}$/.test(commit.data.sha)) return { repo: fullName, entries, skipped: [{ repo: fullName, path: '', reason: 'could not resolve the default branch commit' }] };
  const commitSha = commit.data.sha;
  const updatedAt = commit.data.commit.committer?.date ?? null;

  type TreeInfo = { tree: TreeItem[]; truncated: boolean };
  const tree = await api<TreeInfo>(http, `${API}/repos/${owner}/${repo}/git/trees/${commit.data.commit.tree.sha}?recursive=1`, `${fullName} tree`);
  if (!tree.data) return { repo: fullName, entries, skipped: [{ repo: fullName, path: '', reason: 'tree not available' }] };
  if (tree.data.truncated) skipped.push({ repo: fullName, path: '', reason: 'repository tree is truncated by GitHub; some skills may be missing' });

  const dirs = skillDirectories(tree.data.tree);
  log(`${fullName}@${commitSha.slice(0, 7)}: ${dirs.length} SKILL.md file(s)`);
  for (const dir of dirs) {
    const id = entryId(owner, repo, dir);
    if (!isSafeRelativePath(dir, true)) {
      skipped.push({ repo: fullName, path: dir.slice(0, 120), reason: 'unsafe directory path' });
      continue;
    }
    const folder = installFolderName({ path: dir, repo });
    if (!isSafeInstallFolderName(folder)) {
      skipped.push({ repo: fullName, path: dir, reason: `folder name "${folder}" cannot be installed safely` });
      continue;
    }
    const { files, problem } = filesForSkill(tree.data.tree, dir);
    if (problem) {
      skipped.push({ repo: fullName, path: dir, reason: problem });
      continue;
    }
    const skillMd = files.find((f) => f.path === 'SKILL.md');
    if (!skillMd) continue;
    const rawUrl = `${RAW}/${owner}/${repo}/${commitSha}/${encodePath(dir ? `${dir}/SKILL.md` : 'SKILL.md')}`;
    const res = await http.get(rawUrl, 'text/plain');
    if (res.status !== 200) {
      skipped.push({ repo: fullName, path: dir, reason: `SKILL.md not readable (HTTP ${res.status})` });
      continue;
    }
    const parsed = parseSkillMarkdown(res.body, folder);
    if (parsed.issues.some((i) => i.message.includes('refuses'))) {
      skipped.push({ repo: fullName, path: dir, reason: 'skill name contains characters Claude Code refuses' });
      continue;
    }
    const parseErrors = parsed.issues.filter((i) => i.level === 'error').map((i) => i.message);
    const fm = parsed.frontmatter;
    const fmLicense = typeof fm?.license === 'string' && fm.license.trim() ? fm.license.trim().slice(0, 200) : null;
    // Only real plugin manifests count; an agents/ or hooks/ folder of Markdown is ordinary skill content.
    const pluginMarker = PLUGIN_MARKERS.find((m) => files.some((f) => f.path === m));
    const kind = pluginMarker ? 'plugin-unsupported' : 'skill';
    const warnings = warningsFor(files, fm, parsed.declaresHooks, parseErrors);
    if (pluginMarker) warnings.unshift(`Plugin component (${pluginMarker}); plugin installation is not supported yet.`);
    if (info.data.archived) warnings.push('Repository is archived.');
    const category = parsed.frontmatterCategory ?? inferCategory(parsed.name, parsed.description, { path: dir, repository: `${owner}/${repo}` });
    entries.push({
      id,
      name: parsed.name.slice(0, 200),
      description: parsed.description.slice(0, 4000),
      category,
      categorySource: parsed.frontmatterCategory ? 'frontmatter' : category === 'Other' ? 'default' : 'inferred',
      owner,
      repo,
      path: dir,
      sourceUrl: pinnedSourceUrl(owner, repo, commitSha, dir),
      commitSha,
      license: fmLicense ?? repoLicense,
      licenseSource: fmLicense ? 'frontmatter' : repoLicense ? 'repository' : null,
      updatedAt,
      indexedAt: now,
      kind,
      files,
      warnings,
    });
  }
  const stars = info.data.stargazers_count;
  return { repo: fullName, entries, skipped, ...(Number.isSafeInteger(stars) && stars! >= 0 ? { stats: { stars: stars!, fetchedAt: now } } : {}) };
}

/** Repository search (broader discovery). Returns "owner/repo" names. */
/** Public, non-fork repositories matching a search query, most-starred first. */
export async function searchRepositories(query: string, http: HttpClient, maxRepos: number): Promise<string[]> {
  const names: string[] = [];
  if (maxRepos <= 0) return names;
  for (let page = 1; names.length < maxRepos && page <= 5; page++) {
    const url = `${API}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=30&page=${page}`;
    const res = await api<{ items: { full_name: string; private: boolean; fork: boolean }[] }>(http, url, `search "${query}"`);
    const items = res.data?.items ?? [];
    for (const it of items) if (!it.private && !it.fork && !names.includes(it.full_name)) names.push(it.full_name);
    if (items.length < 30) break;
  }
  return names.slice(0, maxRepos);
}

/**
 * Drops entries whose SKILL.md is byte-identical (same git blob) to another entry's: the same skill
 * copied into several folders or repositories. Keeps the copy from the earliest repository in
 * `repoOrder`, then the shortest path.
 */
export function dedupeEntries(entries: readonly CatalogEntry[], repoOrder: readonly string[]): { entries: CatalogEntry[]; skipped: CatalogSkip[] } {
  const rank = new Map(repoOrder.map((r, i) => [r.toLowerCase(), i]));
  const repoRank = (e: CatalogEntry) => rank.get(`${e.owner}/${e.repo}`.toLowerCase()) ?? repoOrder.length;
  // Prefer the conventional location (skills/… or .claude/skills/…) over per-agent mirrors such as .cursor/skills/….
  const pathRank = (e: CatalogEntry) => (/^\.claude\/skills\//.test(e.path) ? 0 : /^skills\//.test(e.path) ? 1 : /^\./.test(e.path) ? 3 : 2);
  const better = (a: CatalogEntry, b: CatalogEntry) => repoRank(a) - repoRank(b) || pathRank(a) - pathRank(b) || a.path.length - b.path.length || a.id.localeCompare(b.id);
  const winners = new Map<string, CatalogEntry>();
  for (const e of entries) {
    const sha = e.files.find((f) => f.path === 'SKILL.md')?.sha;
    if (!sha) continue;
    const cur = winners.get(sha);
    if (!cur || better(e, cur) < 0) winners.set(sha, e);
  }
  // Same skill name twice in one repository (e.g. per-agent mirrors such as .cursor/skills/x and
  // .claude/skills/x): one install folder, so keep one copy.
  const byName = new Map<string, CatalogEntry>();
  const nameKey = (e: CatalogEntry) => `${e.owner}/${e.repo}\u0000${e.name || e.path}`.toLowerCase();
  for (const e of entries) {
    const cur = byName.get(nameKey(e));
    if (!cur || better(e, cur) < 0) byName.set(nameKey(e), e);
  }
  const kept: CatalogEntry[] = [];
  const skipped: CatalogSkip[] = [];
  for (const e of entries) {
    const sha = e.files.find((f) => f.path === 'SKILL.md')?.sha;
    const w = sha ? winners.get(sha) : undefined;
    const sameName = byName.get(nameKey(e));
    if (w && w !== e) skipped.push({ repo: `${e.owner}/${e.repo}`, path: e.path, reason: `same SKILL.md as ${w.id}` });
    else if (sameName && sameName !== e) skipped.push({ repo: `${e.owner}/${e.repo}`, path: e.path, reason: `another copy of "${e.name}" in this repository: ${sameName.path}` });
    else kept.push(e);
  }
  return { entries: kept, skipped };
}

export interface SeedConfig {
  repositories: string[];
  searchQueries?: string[];
  maxSearchRepositories?: number;
  /** Also search each query restricted to repositories created in the last N days (new skills), most-starred first. */
  newWithinDays?: number;
  /** Cap for repositories added by the "new" searches (on top of maxSearchRepositories). */
  maxNewRepositories?: number;
}

export async function buildCatalog(
  seed: SeedConfig,
  http: HttpClient,
  opts: IndexOptions & { search?: boolean; source?: Catalog['source'] } = {},
): Promise<Catalog> {
  const log = opts.log ?? (() => undefined);
  const repos = [...new Set(seed.repositories)];
  if (opts.search) {
    // maxSearchRepositories caps the repositories added by all queries together.
    const max = seed.maxSearchRepositories ?? 20;
    const cap = repos.length + max;
    for (const q of seed.searchQueries ?? []) {
      if (repos.length >= cap) break;
      try {
        // Ask each query for the full amount: results can overlap with repositories already listed.
        for (const r of await searchRepositories(q, http, max)) if (!repos.includes(r) && repos.length < cap) repos.push(r);
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
        log(`search "${q}" failed: ${(err as Error).message}`);
      }
    }
  }
  if (opts.search && seed.newWithinDays && seed.newWithinDays > 0) {
    const since = new Date((opts.now ?? (() => new Date()))().getTime() - seed.newWithinDays * 86400000).toISOString().slice(0, 10);
    const max = seed.maxNewRepositories ?? 10;
    const cap = repos.length + max;
    for (const q of seed.searchQueries ?? []) {
      if (repos.length >= cap) break;
      try {
        for (const r of await searchRepositories(`${q} created:>${since}`, http, max)) if (!repos.includes(r) && repos.length < cap) repos.push(r);
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
        log(`search "${q} created:>${since}" failed: ${(err as Error).message}`);
      }
    }
  }
  const entries: CatalogEntry[] = [];
  const skipped: CatalogSkip[] = [];
  const indexed: string[] = [];
  const repositoryStats: Record<string, RepositoryStats> = {};
  for (const r of repos) {
    try {
      const result = await indexRepository(r, http, opts);
      for (const e of result.entries) if (!entries.some((x) => x.id === e.id)) entries.push(e);
      skipped.push(...result.skipped);
      if (result.entries.length) {
        indexed.push(r);
        if (result.stats) repositoryStats[r] = result.stats;
      }
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      skipped.push({ repo: r, path: '', reason: (err as Error).message });
    }
  }
  const deduped = dedupeEntries(entries, repos);
  skipped.push(...deduped.skipped);
  const unique = deduped.entries.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt: (opts.now ?? (() => new Date()))().toISOString(),
    source: opts.source ?? 'github-index',
    generator: 'skilltree scripts/index-skills.ts',
    repositories: indexed,
    entries: unique,
    ...(Object.keys(repositoryStats).length ? { repositoryStats } : {}),
    skipped,
  };
}

/** Node fetch-based client with timeout and retries for transient failures. */
export function fetchHttpClient(token?: string, timeoutMs = 20000): HttpClient & { remaining: () => string | undefined } {
  let remaining: string | undefined;
  return {
    remaining: () => remaining,
    async get(url, accept = 'application/vnd.github+json') {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const headers: Record<string, string> = { Accept: accept, 'User-Agent': 'skilltree-indexer', 'X-GitHub-Api-Version': '2022-11-28' };
          if (token && url.startsWith(API)) headers.Authorization = `Bearer ${token}`;
          const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
          const body = await res.text();
          const h: Record<string, string> = {};
          res.headers.forEach((v, k) => (h[k.toLowerCase()] = v));
          if (url.startsWith(API) && h['x-ratelimit-remaining'] !== undefined) remaining = h['x-ratelimit-remaining'];
          if (res.status >= 500) {
            lastErr = new Error(`HTTP ${res.status}`);
            await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
            continue;
          }
          return { status: res.status, headers: h, body };
        } catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        } finally {
          clearTimeout(timer);
        }
      }
      throw new Error(`Request failed for ${url}: ${(lastErr as Error)?.message ?? lastErr}`);
    },
  };
}

/** Replays recorded responses: { "<url>": { status, body, headers? } }. Unknown URLs return 404. */
export function replayHttpClient(routes: Record<string, { status: number; body: unknown; headers?: Record<string, string> }>): HttpClient {
  return {
    async get(url) {
      const r = routes[url];
      if (!r) return { status: 404, headers: {}, body: '{"message":"Not Found"}' };
      return { status: r.status, headers: r.headers ?? {}, body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
    },
  };
}

/** Refreshes repositoryStats for a catalog's repositories: one metadata request each, no re-indexing. */
export async function fetchRepositoryStats(repos: readonly string[], http: HttpClient, now: () => Date = () => new Date()): Promise<Record<string, RepositoryStats>> {
  const out: Record<string, RepositoryStats> = {};
  for (const full of repos) {
    const [owner, repo, extra] = full.split('/');
    if (!owner || !repo || extra !== undefined || !isGitHubName(owner) || !isGitHubName(repo)) continue;
    const info = await api<{ stargazers_count?: number }>(http, `${API}/repos/${owner}/${repo}`, `${full} metadata`);
    const stars = info.data?.stargazers_count;
    if (Number.isSafeInteger(stars) && stars! >= 0) out[full] = { stars: stars!, fetchedAt: now().toISOString() };
  }
  return out;
}

/**
 * Merges a freshly built catalog into an existing one: repositories in `addition` replace their
 * previous entries, new repositories are appended (keeping the existing order first), stats are
 * merged, and byte-identical SKILL.md copies are dropped again.
 */
export function mergeCatalogs(base: Catalog, addition: Catalog): Catalog {
  const added = new Set(addition.repositories.map((r) => r.toLowerCase()));
  const keep = (repo: string) => !added.has(repo.toLowerCase());
  const repositories = [...base.repositories.filter(keep), ...addition.repositories];
  // Keep the base order for repositories that were re-indexed.
  const order = [...base.repositories.filter((r) => !keep(r)), ...repositories.filter((r) => !base.repositories.some((b) => b.toLowerCase() === r.toLowerCase()))];
  const ordered = [...base.repositories.filter(keep), ...order];
  const entries = [...base.entries.filter((e) => keep(`${e.owner}/${e.repo}`)), ...addition.entries];
  const deduped = dedupeEntries(entries, ordered);
  return {
    ...base,
    generatedAt: addition.generatedAt,
    repositories: ordered.filter((r) => deduped.entries.some((e) => `${e.owner}/${e.repo}`.toLowerCase() === r.toLowerCase())),
    entries: deduped.entries.sort((a, b) => a.id.localeCompare(b.id)),
    skipped: [...(base.skipped ?? []).filter((s) => keep(s.repo)), ...(addition.skipped ?? []), ...deduped.skipped],
    repositoryStats: { ...base.repositoryStats, ...addition.repositoryStats },
  };
}

/**
 * Applies the current indexing rules to an existing catalog without fetching anything: entries whose
 * SKILL.md is a symbolic link are moved to `skipped`, and automatic categories are inferred again
 * (a category from the skill's own frontmatter is kept). Used after the rules change.
 */
export function recategorizeCatalog(catalog: Catalog): { catalog: Catalog; dropped: number; moved: number } {
  const skipped = [...(catalog.skipped ?? [])];
  const entries: CatalogEntry[] = [];
  let moved = 0;
  for (const e of catalog.entries) {
    const skillMd = e.files.find((f) => f.path === 'SKILL.md');
    if (skillMd?.kind === 'symlink') {
      skipped.push({ repo: `${e.owner}/${e.repo}`, path: e.path, reason: 'SKILL.md is a symbolic link' });
      continue;
    }
    if (e.categorySource === 'frontmatter') {
      entries.push(e);
      continue;
    }
    const category = inferCategory(e.name, e.description, { path: e.path, repository: `${e.owner}/${e.repo}` });
    if (category !== e.category) moved++;
    entries.push({ ...e, category, categorySource: category === 'Other' ? 'default' : 'inferred' });
  }
  const repositories = catalog.repositories.filter((r) => entries.some((e) => `${e.owner}/${e.repo}`.toLowerCase() === r.toLowerCase()));
  return { catalog: { ...catalog, repositories, entries, skipped }, dropped: catalog.entries.length - entries.length, moved };
}

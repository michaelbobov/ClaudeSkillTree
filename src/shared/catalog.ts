// Marketplace catalog: versioned schema, strict validation and install-state matching.
// Shared by the indexer (scripts/), the extension host and the webview. Plain JSON only.

import { CATEGORIES, type Category } from './types';

export const CATALOG_SCHEMA_VERSION = 1;

/** Limits applied by the indexer, the validator and the installer. */
export const CATALOG_LIMITS = {
  maxEntries: 5000,
  maxFilesPerSkill: 2000,
  maxFileBytes: 2 * 1024 * 1024,
  maxSkillBytes: 50 * 1024 * 1024,
  /** Above either of these a skill is flagged "Large skill" in the catalog and the install dialog. */
  largeSkillFiles: 200,
  largeSkillBytes: 10 * 1024 * 1024,
  maxPathLength: 300,
  maxPathDepth: 10,
  maxCatalogBytes: 20 * 1024 * 1024,
};

export type CatalogFileKind = 'markdown' | 'script' | 'executable' | 'symlink' | 'submodule' | 'other';

export interface CatalogFile {
  /** Path relative to the skill directory, POSIX separators. */
  path: string;
  size: number;
  /** Git blob SHA-1 at the pinned commit (lets the installer verify downloads). */
  sha: string;
  kind: CatalogFileKind;
}

export type CatalogEntryKind = 'skill' | 'plugin-unsupported';

export interface CatalogEntry {
  /** `owner/repo:path` (path of the skill directory inside the repository). */
  id: string;
  name: string;
  description: string;
  category: Category;
  categorySource: 'frontmatter' | 'inferred' | 'default';
  owner: string;
  repo: string;
  /** Skill directory inside the repository ("" for a skill at the repository root). */
  path: string;
  /** https://github.com/owner/repo/tree/<commitSha>/<path> */
  sourceUrl: string;
  commitSha: string;
  /** License as declared by the skill (frontmatter) or the repository, or null when not determinable. */
  license: string | null;
  licenseSource: 'frontmatter' | 'repository' | null;
  /** Date of the pinned commit (when the repository was last updated at indexing time). */
  updatedAt: string | null;
  indexedAt: string;
  kind: CatalogEntryKind;
  files: CatalogFile[];
  /** Facts worth reviewing before install (scripts, hooks, symlinks…). Never quality judgements. */
  warnings: string[];
}

export interface CatalogSkip {
  repo: string;
  path: string;
  reason: string;
}

export interface Catalog {
  schemaVersion: number;
  generatedAt: string;
  /** "github-index" = produced by scripts/index-skills.ts; "sample" = small frozen sample for development. */
  source: 'github-index' | 'sample';
  generator?: string;
  repositories: string[];
  entries: CatalogEntry[];
  skipped?: CatalogSkip[];
  /**
   * Facts about each repository from the GitHub API, keyed by "owner/repo". Stars belong to the whole
   * repository, not to any one skill in it, and are a snapshot taken at `fetchedAt`.
   */
  repositoryStats?: Record<string, RepositoryStats>;
}

export interface RepositoryStats {
  stars: number;
  fetchedAt: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9 _.@+()[\],'&!~=-]{1,255}$/;
const KINDS: CatalogFileKind[] = ['markdown', 'script', 'executable', 'symlink', 'submodule', 'other'];

export function entryId(owner: string, repo: string, path: string): string {
  return `${owner}/${repo}:${path}`;
}

export function encodePath(p: string): string {
  return p
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');
}

export function pinnedSourceUrl(owner: string, repo: string, commitSha: string, path: string): string {
  const base = `https://github.com/${owner}/${repo}/tree/${commitSha}`;
  return path ? `${base}/${encodePath(path)}` : base;
}

/** The folder name a skill installs into (last segment of its repository path, or the repo name). */
export function installFolderName(entry: Pick<CatalogEntry, 'path' | 'repo'>): string {
  const segs = entry.path.split('/').filter(Boolean);
  return segs.length ? segs[segs.length - 1] : entry.repo;
}

/**
 * Checks a relative POSIX path from untrusted data: no absolute paths, no `..`/`.` segments, no
 * backslashes, NUL or control characters, bounded length and depth.
 */
export function isSafeRelativePath(p: string, allowEmpty = false): boolean {
  if (p === '') return allowEmpty;
  if (typeof p !== 'string' || p.length > CATALOG_LIMITS.maxPathLength) return false;
  if (p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p)) return false;
  const segs = p.split('/');
  if (segs.length > CATALOG_LIMITS.maxPathDepth) return false;
  return segs.every((s) => s !== '' && s !== '.' && s !== '..' && SAFE_SEGMENT_RE.test(s));
}

/** Folder names that must never be used as an install destination. */
export function isSafeInstallFolderName(name: string): boolean {
  return NAME_RE.test(name) && !name.startsWith('.') && name !== 'synced' && !name.toLowerCase().startsWith('anthropic-skills');
}

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
}

function str(v: unknown, max: number, allowEmpty = false): v is string {
  return typeof v === 'string' && v.length <= max && (allowEmpty || v.length > 0);
}

export type ValidationResult = { ok: true; catalog: Catalog } | { ok: false; errors: string[] };

/** Validates untrusted catalog JSON. Collects up to 50 errors; any error rejects the whole catalog. */
export function validateCatalog(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const err = (m: string) => {
    if (errors.length < 50) errors.push(m);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: ['Catalog is not a JSON object.'] };
  const c = raw as Record<string, unknown>;
  if (c.schemaVersion !== CATALOG_SCHEMA_VERSION) err(`Unsupported schemaVersion ${JSON.stringify(c.schemaVersion)} (expected ${CATALOG_SCHEMA_VERSION}).`);
  if (!isIsoDate(c.generatedAt)) err('generatedAt must be an ISO date.');
  if (c.source !== 'github-index' && c.source !== 'sample') err('source must be "github-index" or "sample".');
  if (!Array.isArray(c.repositories) || !c.repositories.every((r) => str(r, 200))) err('repositories must be an array of strings.');
  if (c.repositoryStats !== undefined) {
    const stats = c.repositoryStats;
    if (typeof stats !== 'object' || stats === null || Array.isArray(stats)) err('repositoryStats must be an object.');
    else
      for (const [k, v] of Object.entries(stats as Record<string, unknown>)) {
        const s = v as Record<string, unknown> | null;
        const [o, r, x] = k.split('/');
        if (!o || !r || x !== undefined || !NAME_RE.test(o) || !NAME_RE.test(r) || [o, r].some((p) => p === '.' || p === '..')) err(`repositoryStats key ${JSON.stringify(k).slice(0, 80)} is not owner/repo.`);
        else if (typeof s !== 'object' || s === null || !Number.isSafeInteger(s.stars) || (s.stars as number) < 0 || !isIsoDate(s.fetchedAt)) err(`repositoryStats[${k}] must have integer stars >= 0 and an ISO fetchedAt.`);
      }
  }
  if (!Array.isArray(c.entries)) {
    err('entries must be an array.');
    return { ok: false, errors };
  }
  if (c.entries.length > CATALOG_LIMITS.maxEntries) err(`Too many entries (${c.entries.length}).`);

  const ids = new Set<string>();
  c.entries.forEach((e, i) => {
    const at = `entries[${i}]`;
    if (typeof e !== 'object' || e === null) return err(`${at} is not an object.`);
    const x = e as Record<string, unknown>;
    if (!str(x.owner, 100) || !NAME_RE.test(x.owner) || x.owner === '.' || x.owner === '..') err(`${at}.owner is invalid.`);
    if (!str(x.repo, 100) || !NAME_RE.test(x.repo) || x.repo === '.' || x.repo === '..') err(`${at}.repo is invalid.`);
    if (typeof x.path !== 'string' || !isSafeRelativePath(x.path, true)) err(`${at}.path is not a safe relative path.`);
    if (!str(x.commitSha, 40) || !SHA_RE.test(x.commitSha)) err(`${at}.commitSha must be a 40-character hex commit SHA.`);
    if (typeof x.owner === 'string' && typeof x.repo === 'string' && typeof x.path === 'string') {
      const expectedId = entryId(x.owner, x.repo, x.path);
      if (x.id !== expectedId) err(`${at}.id must be "${expectedId}".`);
      else if (ids.has(expectedId)) err(`${at}.id "${expectedId}" is duplicated.`);
      else ids.add(expectedId);
      if (typeof x.commitSha === 'string' && x.sourceUrl !== pinnedSourceUrl(x.owner, x.repo, x.commitSha, x.path)) {
        err(`${at}.sourceUrl must be pinned to commitSha.`);
      }
      if (!isSafeInstallFolderName(installFolderName({ path: x.path, repo: x.repo }))) err(`${at} has an unsafe install folder name.`);
    }
    if (!str(x.name, 200)) err(`${at}.name is required.`);
    if (!str(x.description, 4000, true)) err(`${at}.description must be a string.`);
    if (!CATEGORIES.includes(x.category as Category)) err(`${at}.category is not a known category.`);
    if (!['frontmatter', 'inferred', 'default'].includes(x.categorySource as string)) err(`${at}.categorySource is invalid.`);
    if (x.license !== null && !str(x.license, 200)) err(`${at}.license must be a string or null.`);
    if (![null, 'frontmatter', 'repository'].includes(x.licenseSource as string | null)) err(`${at}.licenseSource is invalid.`);
    if (x.license === null && x.licenseSource !== null) err(`${at}.licenseSource must be null when license is null.`);
    if (x.updatedAt !== null && !isIsoDate(x.updatedAt)) err(`${at}.updatedAt must be an ISO date or null.`);
    if (!isIsoDate(x.indexedAt)) err(`${at}.indexedAt must be an ISO date.`);
    if (x.kind !== 'skill' && x.kind !== 'plugin-unsupported') err(`${at}.kind is invalid.`);
    if (!Array.isArray(x.warnings) || !x.warnings.every((w) => str(w, 300))) err(`${at}.warnings must be an array of strings.`);
    if (!Array.isArray(x.files)) return err(`${at}.files must be an array.`);
    if (x.files.length > CATALOG_LIMITS.maxFilesPerSkill) err(`${at} has too many files (${x.files.length}).`);
    let total = 0;
    let hasSkillMd = false;
    const seen = new Set<string>();
    x.files.forEach((f, j) => {
      const fat = `${at}.files[${j}]`;
      if (typeof f !== 'object' || f === null) return err(`${fat} is not an object.`);
      const y = f as Record<string, unknown>;
      if (typeof y.path !== 'string' || !isSafeRelativePath(y.path)) return err(`${fat}.path is not a safe relative path.`);
      if (seen.has(y.path.toLowerCase())) err(`${fat}.path is duplicated (case-insensitive).`);
      seen.add(y.path.toLowerCase());
      if (y.path === 'SKILL.md') hasSkillMd = true;
      if (typeof y.size !== 'number' || !Number.isInteger(y.size) || y.size < 0 || y.size > CATALOG_LIMITS.maxFileBytes) err(`${fat}.size is invalid or over the limit.`);
      else total += y.size;
      if (!str(y.sha, 40) || !SHA_RE.test(y.sha)) err(`${fat}.sha must be a 40-character hex blob SHA.`);
      if (!KINDS.includes(y.kind as CatalogFileKind)) err(`${fat}.kind is invalid.`);
    });
    if (!hasSkillMd) err(`${at}.files must include SKILL.md.`);
    if (total > CATALOG_LIMITS.maxSkillBytes) err(`${at} total size ${total} is over the limit.`);
  });

  if (c.skipped !== undefined && !Array.isArray(c.skipped)) err('skipped must be an array when present.');
  if (errors.length) return { ok: false, errors };
  return { ok: true, catalog: raw as Catalog };
}

// ---- Install state ------------------------------------------------------------------------

/** Written beside an installed skill as `.skilltree-source.json`. SKILL.md is never modified. */
export interface InstallRecord {
  schema: 1;
  id: string;
  owner: string;
  repo: string;
  path: string;
  commitSha: string;
  sourceUrl: string;
  indexedAt: string;
  installedAt: string;
}

export const INSTALL_RECORD_FILE = '.skilltree-source.json';

export function parseInstallRecord(raw: unknown): InstallRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== 1) return null;
  if (!str(r.owner, 100) || !str(r.repo, 100) || typeof r.path !== 'string') return null;
  if (!str(r.commitSha, 40) || !SHA_RE.test(r.commitSha)) return null;
  if (r.id !== entryId(r.owner, r.repo, r.path)) return null;
  if (r.sourceUrl !== pinnedSourceUrl(r.owner, r.repo, r.commitSha, r.path)) return null;
  if (!isIsoDate(r.indexedAt) || !isIsoDate(r.installedAt)) return null;
  return r as unknown as InstallRecord;
}

export type InstallState = 'not-installed' | 'installed' | 'update-available' | 'unknown';

export interface LocalSkillRef {
  id: string;
  source: string;
  dirName: string;
  /** Skill name from SKILL.md (Claude Code uses one skill per name). */
  name?: string;
  installedFrom?: { id: string; commitSha: string };
}

export interface EntryInstallInfo {
  state: InstallState;
  /** Local skill ids that correspond to this entry. */
  localIds: string[];
}

/**
 * Install state from exact provenance (`.skilltree-source.json`), never from a name match alone.
 * A local project/personal folder with the same name but no provenance is "unknown": it may or may
 * not be the same skill.
 */
export function installStateFor(entry: CatalogEntry, local: readonly LocalSkillRef[]): EntryInstallInfo {
  const matches = local.filter((s) => s.installedFrom?.id === entry.id);
  if (matches.length) {
    const upToDate = matches.some((s) => s.installedFrom?.commitSha === entry.commitSha);
    return { state: upToDate ? 'installed' : 'update-available', localIds: matches.map((s) => s.id) };
  }
  const folder = installFolderName(entry);
  const sameFolder = local.filter((s) => (s.source === 'project' || s.source === 'personal') && s.dirName === folder && !s.installedFrom);
  if (sameFolder.length) return { state: 'unknown', localIds: sameFolder.map((s) => s.id) };
  // A skill with the same name installed some other way (another tool, claude.ai sync, by hand):
  // installing would add a second skill with that name, and Claude Code only uses one of them.
  const name = entry.name.toLowerCase();
  const sameName = local.filter((s) => !s.installedFrom && s.name?.toLowerCase() === name);
  if (sameName.length) return { state: 'unknown', localIds: sameName.map((s) => s.id) };
  return { state: 'not-installed', localIds: [] };
}

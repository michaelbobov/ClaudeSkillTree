// Local skill discovery. Pure Node.js (no VS Code API) so it can be tested against temp directories.
// Works offline and without Claude Code running: it only reads SKILL.md files on disk.

import * as fs from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import * as path from 'node:path';
import { parseSkillMarkdown } from './frontmatter';
import type { ScanRootStatus, SkillIssue, SkillRecord, SkillSource, SupportingFile } from '../shared/types';
import { INSTALL_RECORD_FILE, parseInstallRecord } from '../shared/catalog';

/** Reads SkillTree's provenance file next to an installed skill, if present and well-formed. */
async function readInstallRecord(skillDir: string): Promise<SkillRecord['installedFrom']> {
  try {
    const file = path.join(skillDir, INSTALL_RECORD_FILE);
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > 64 * 1024) return undefined;
    const rec = parseInstallRecord(JSON.parse(await fs.readFile(file, 'utf8')));
    if (!rec) return undefined;
    const { id, owner, repo, path: p, commitSha, sourceUrl, installedAt } = rec;
    return { id, owner, repo, path: p, commitSha, sourceUrl, installedAt };
  } catch {
    return undefined;
  }
}

export interface ScanRoot {
  source: SkillSource;
  /** Absolute path of a `skills` directory (contains `<name>/SKILL.md`). */
  path: string;
  /** Label shown in the UI, e.g. workspace folder name. */
  label: string;
  /** Display path, e.g. ".claude/skills" or "~/.claude/skills". */
  displayPath: string;
  readOnly: boolean;
  /**
   * Prefix used by Claude Code to namespace the command, e.g. "apps/web" for nested skills or
   * "anthropic-skills" for synced skills. Undefined for top-level project/personal/managed skills.
   */
  namespace?: string;
  /** Scope key used to build stable ids, e.g. "personal", "project/my-repo", "nested/my-repo/apps/web". */
  idPrefix: string;
  /** For the synced root: the directory contains bucket folders, each containing skills. */
  bucketed?: boolean;
  /** Folder names to skip at the top level (e.g. "synced" inside ~/.claude/skills, scanned separately). */
  reservedNames?: string[];
}

export interface ScanOptions {
  /** Max SKILL.md size to read. Larger files are listed with an error. */
  maxSkillFileBytes?: number;
  /** Max supporting files listed per skill. */
  maxSupportingFiles?: number;
  /** Max directory depth for listing supporting files. */
  maxSupportingDepth?: number;
  /** Home directory used to shorten display paths. */
  homeDir?: string;
}

export interface ScanResult {
  skills: SkillRecord[];
  roots: ScanRootStatus[];
}

const DEFAULTS: Required<Omit<ScanOptions, 'homeDir'>> = {
  maxSkillFileBytes: 1024 * 1024,
  maxSupportingFiles: 200,
  maxSupportingDepth: 4,
};

const SCRIPT_EXTENSIONS = new Set([
  '.sh', '.bash', '.zsh', '.fish', '.py', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.rb', '.pl', '.php',
  '.ps1', '.psm1', '.bat', '.cmd', '.exe', '.lua', '.go', '.rs', '.jar', '.swift', '.applescript', '.scpt',
]);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.txt']);
const SKIP_LISTING_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv']);

/** Ordering for name collisions. Claude Code: enterprise over personal, personal over project. */
const PRECEDENCE: Partial<Record<SkillSource, number>> = { managed: 3, personal: 2, project: 1 };

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function shortenPath(abs: string, homeDir?: string): string {
  if (homeDir && (abs === homeDir || abs.startsWith(homeDir + path.sep))) {
    return '~' + toPosix(abs.slice(homeDir.length));
  }
  return toPosix(abs);
}

async function statOrNull(p: string): Promise<Stats | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function readDirOrError(p: string): Promise<{ entries: Dirent[] } | { error: string }> {
  try {
    return { entries: await fs.readdir(p, { withFileTypes: true }) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { error: code === 'EACCES' || code === 'EPERM' ? 'Permission denied' : (err as Error).message };
  }
}

async function listSupportingFiles(
  dir: string,
  opts: Required<Omit<ScanOptions, 'homeDir'>>,
): Promise<{ files: SupportingFile[]; truncated: boolean }> {
  const files: SupportingFile[] = [];
  let truncated = false;

  async function walk(current: string, depth: number): Promise<void> {
    if (truncated) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= opts.maxSupportingFiles) {
        truncated = true;
        return;
      }
      const abs = path.join(current, entry.name);
      const rel = toPosix(path.relative(dir, abs));
      if (depth === 0 && (entry.name === 'SKILL.md' || entry.name === INSTALL_RECORD_FILE)) continue;
      if (entry.name === '.DS_Store') continue;
      if (entry.isSymbolicLink()) {
        // Never follow symlinks inside a skill when inventorying it.
        files.push({ path: rel, size: 0, kind: 'symlink' });
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_LISTING_DIRS.has(entry.name)) continue;
        if (depth + 1 >= opts.maxSupportingDepth) {
          truncated = true;
          continue;
        }
        await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const st = await statOrNull(abs);
      const ext = path.extname(entry.name).toLowerCase();
      let kind: SupportingFile['kind'] = 'other';
      if (SCRIPT_EXTENSIONS.has(ext)) kind = 'script';
      else if (st && process.platform !== 'win32' && (st.mode & 0o111) !== 0) kind = 'executable';
      else if (MARKDOWN_EXTENSIONS.has(ext)) kind = 'markdown';
      files.push({ path: rel, size: st?.size ?? 0, kind });
    }
  }

  await walk(dir, 0);
  return { files, truncated };
}

async function readSkill(
  root: ScanRoot,
  skillDir: string,
  dirName: string,
  idPrefix: string,
  opts: Required<Omit<ScanOptions, 'homeDir'>>,
  homeDir: string | undefined,
  viaSymlink: boolean,
): Promise<SkillRecord | { skip: string }> {
  const file = path.join(skillDir, 'SKILL.md');
  const st = await statOrNull(file);
  if (!st || !st.isFile()) return { skip: 'No SKILL.md' };

  const issues: SkillIssue[] = [];
  if (viaSymlink) issues.push({ level: 'info', message: 'Skill folder is a symbolic link.' });

  let text = '';
  if (st.size > opts.maxSkillFileBytes) {
    issues.push({
      level: 'error',
      message: `SKILL.md is ${(st.size / 1024).toFixed(0)} KB, over the ${(opts.maxSkillFileBytes / 1024).toFixed(0)} KB limit SkillTree will read.`,
    });
  } else {
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      issues.push({ level: 'error', message: `Could not read SKILL.md: ${(err as Error).message}` });
    }
  }

  const parsed = parseSkillMarkdown(text, dirName);
  issues.push(...parsed.issues);
  const { files, truncated } = await listSupportingFiles(skillDir, opts);
  const scriptCount = files.filter((f) => f.kind === 'script' || f.kind === 'executable').length;
  if (scriptCount > 0) {
    issues.push({
      level: 'info',
      message: `Contains ${scriptCount} script or executable file${scriptCount === 1 ? '' : 's'} that Claude may run when the skill is used.`,
    });
  }
  if (parsed.declaresHooks) {
    issues.push({ level: 'info', message: 'Declares hooks that are registered when the skill is invoked.' });
  }

  const command = root.namespace ? `/${root.namespace}:${parsed.name}` : `/${parsed.name}`;

  return {
    id: `${idPrefix}/${dirName}`,
    name: parsed.name,
    dirName,
    command,
    description: parsed.description,
    descriptionSource: parsed.descriptionSource,
    source: root.source,
    readOnly: root.readOnly,
    rootLabel: root.label,
    dir: skillDir,
    file,
    // Synced bucket folders are opaque account ids; elide them for display (the full path stays in `file`).
    displayPath: root.bucketed ? `${root.displayPath}/…/${dirName}/SKILL.md` : shortenPath(file, homeDir),
    fields: parsed.fields,
    issues,
    supportingFiles: files,
    supportingFilesTruncated: truncated,
    declaresHooks: parsed.declaresHooks,
    frontmatterCategory: parsed.frontmatterCategory,
    modifiedAt: st.mtimeMs,
    sizeBytes: st.size,
    sameNameAs: [],
    installedFrom: await readInstallRecord(skillDir),
  };
}

/** Scans a directory containing `<skill-name>/SKILL.md` folders. */
async function scanSkillsDir(
  root: ScanRoot,
  dir: string,
  idPrefix: string,
  opts: Required<Omit<ScanOptions, 'homeDir'>>,
  homeDir: string | undefined,
  status: ScanRootStatus,
): Promise<SkillRecord[]> {
  const listing = await readDirOrError(dir);
  if ('error' in listing) {
    status.error = listing.error;
    return [];
  }
  const skills: SkillRecord[] = [];
  const entries = listing.entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // .trash, .staging, .DS_Store, ...
    if (root.reservedNames?.includes(entry.name)) continue;
    let isDir = entry.isDirectory();
    const viaSymlink = entry.isSymbolicLink();
    if (viaSymlink) {
      const target = await statOrNull(path.join(dir, entry.name));
      isDir = !!target?.isDirectory();
      if (!target) {
        status.skipped.push({ name: entry.name, reason: 'Broken symbolic link' });
        continue;
      }
    }
    if (!isDir) continue; // loose files are not skills
    const result = await readSkill(root, path.join(dir, entry.name), entry.name, idPrefix, opts, homeDir, viaSymlink);
    if ('skip' in result) status.skipped.push({ name: entry.name, reason: result.skip });
    else skills.push(result);
  }
  return skills;
}

export async function scanRoot(root: ScanRoot, options: ScanOptions = {}): Promise<{ skills: SkillRecord[]; status: ScanRootStatus }> {
  const opts = { ...DEFAULTS, ...options };
  const status: ScanRootStatus = {
    source: root.source,
    label: root.label,
    displayPath: root.displayPath,
    exists: false,
    skillCount: 0,
    skipped: [],
  };
  const st = await statOrNull(root.path);
  if (!st) return { skills: [], status };
  if (!st.isDirectory()) {
    status.error = 'Not a directory';
    return { skills: [], status };
  }
  status.exists = true;

  let skills: SkillRecord[] = [];
  if (root.bucketed) {
    const listing = await readDirOrError(root.path);
    if ('error' in listing) {
      status.error = listing.error;
    } else {
      const buckets = listing.entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const bucket of buckets) {
        // Bucket ids are opaque (account/org ids). Keep them out of stable skill ids so that
        // preferences survive a bucket rename; collisions across buckets get a suffix below.
        skills.push(
          ...(await scanSkillsDir(root, path.join(root.path, bucket.name), root.idPrefix, opts, options.homeDir, status)),
        );
      }
    }
  } else {
    skills = await scanSkillsDir(root, root.path, root.idPrefix, opts, options.homeDir, status);
  }
  status.skillCount = skills.length;
  return { skills, status };
}

/**
 * Marks name collisions. Only top-level managed/personal/project skills compete for the bare
 * command name; nested, synced and plugin skills are namespaced and do not shadow anything.
 */
export function resolveCollisions(skills: SkillRecord[]): void {
  const byName = new Map<string, SkillRecord[]>();
  for (const s of skills) {
    const key = s.name.toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(s);
    byName.set(key, list);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (const s of group) s.sameNameAs = group.filter((o) => o !== s).map((o) => o.id);

    const competing = group.filter((s) => PRECEDENCE[s.source] !== undefined);
    if (competing.length < 2) continue;
    const winner = competing.reduce((best, s) => ((PRECEDENCE[s.source] ?? 0) > (PRECEDENCE[best.source] ?? 0) ? s : best));
    for (const s of competing) {
      if (s === winner) continue;
      if (PRECEDENCE[s.source] === PRECEDENCE[winner.source]) {
        // e.g. two project folders in a multi-root workspace define the same name.
        s.issues.push({
          level: 'warning',
          message: `Another ${winner.source} skill (${winner.displayPath}) uses the same name "${s.name}".`,
        });
        continue;
      }
      s.shadowedBy = winner.id;
      s.issues.push({
        level: 'warning',
        message: `Shadowed: Claude Code runs the ${winner.source} skill "${winner.name}" (${winner.displayPath}) for ${winner.command}.`,
      });
    }
  }
}

/** Scans all roots, de-duplicates identical files (e.g. via symlinks) and resolves name collisions. */
export async function scanAll(roots: ScanRoot[], options: ScanOptions = {}): Promise<ScanResult> {
  const results = await Promise.all(roots.map((r) => scanRoot(r, options)));
  const skills: SkillRecord[] = [];
  const seenFiles = new Set<string>();
  const seenIds = new Map<string, number>();

  for (const { skills: found, status } of results) {
    let kept = 0;
    for (const skill of found) {
      let real = skill.file;
      try {
        real = await fs.realpath(skill.file);
      } catch {
        /* keep logical path */
      }
      if (seenFiles.has(real)) {
        status.skipped.push({ name: skill.dirName, reason: 'Same SKILL.md already listed from another location' });
        continue;
      }
      seenFiles.add(real);
      const n = seenIds.get(skill.id) ?? 0;
      seenIds.set(skill.id, n + 1);
      if (n > 0) skill.id = `${skill.id}~${n + 1}`;
      skills.push(skill);
      kept++;
    }
    status.skillCount = kept;
  }

  resolveCollisions(skills);
  return { skills, roots: results.map((r) => r.status) };
}

/** Builds the standard set of scan roots. */
export function standardRoots(params: {
  homeDir: string;
  workspaceFolders: { name: string; path: string }[];
  nestedSkillDirs?: { folderName: string; folderPath: string; skillsDir: string }[];
  managedDir?: string | null;
}): ScanRoot[] {
  const roots: ScanRoot[] = [];
  for (const folder of params.workspaceFolders) {
    roots.push({
      source: 'project',
      path: path.join(folder.path, '.claude', 'skills'),
      label: folder.name,
      displayPath: params.workspaceFolders.length > 1 ? `${folder.name}/.claude/skills` : '.claude/skills',
      readOnly: false,
      idPrefix: `project/${folder.name}`,
    });
  }
  for (const nested of params.nestedSkillDirs ?? []) {
    // <folder>/<subdir>/.claude/skills  →  namespace "<subdir>"
    const subdir = toPosix(path.relative(nested.folderPath, path.dirname(path.dirname(nested.skillsDir))));
    if (!subdir || subdir.startsWith('..')) continue;
    roots.push({
      source: 'nested',
      path: nested.skillsDir,
      label: `${nested.folderName}/${subdir}`,
      displayPath: `${params.workspaceFolders.length > 1 ? nested.folderName + '/' : ''}${subdir}/.claude/skills`,
      readOnly: false,
      namespace: subdir,
      idPrefix: `nested/${nested.folderName}/${subdir}`,
    });
  }
  const personal = path.join(params.homeDir, '.claude', 'skills');
  roots.push({
    source: 'personal',
    path: personal,
    label: 'Personal',
    displayPath: '~/.claude/skills',
    readOnly: false,
    idPrefix: 'personal',
    reservedNames: ['synced'],
  });
  roots.push({
    source: 'synced',
    path: path.join(personal, 'synced'),
    label: 'Synced from claude.ai',
    displayPath: '~/.claude/skills/synced',
    readOnly: true,
    namespace: 'anthropic-skills',
    idPrefix: 'synced',
    bucketed: true,
  });
  if (params.managedDir) {
    roots.push({
      source: 'managed',
      path: path.join(params.managedDir, '.claude', 'skills'),
      label: 'Managed (enterprise)',
      displayPath: shortenPath(path.join(params.managedDir, '.claude', 'skills'), params.homeDir),
      readOnly: true,
      idPrefix: 'managed',
    });
  }
  return roots;
}

/** Enterprise managed settings directory per platform (https://code.claude.com/docs/en/settings). */
export function managedSettingsDir(platform: NodeJS.Platform = process.platform): string | null {
  switch (platform) {
    case 'darwin':
      return '/Library/Application Support/ClaudeCode';
    case 'linux':
      return '/etc/claude-code';
    case 'win32':
      return 'C:\\Program Files\\ClaudeCode';
    default:
      return null;
  }
}

// Safe skill installer. Pure Node (no VS Code API) so it can be tested in temp directories.
//
// Guarantees:
// - Only files listed in a validated catalog entry are written; each is verified against its git
//   blob SHA from the pinned commit, so content matches what was previewed.
// - Paths are re-validated and every write is checked to stay inside the staging directory.
// - Symlinks and submodules are never installed. Executable bits are not preserved. Nothing runs.
// - Files are staged in a hidden folder next to the destination and moved into place in one rename.
// - An existing skill folder is never overwritten unless `replaceExisting` is set; it is then moved
//   to a hidden backup folder, and restored if anything fails.
// - Cancellation (AbortSignal) and any error roll back: nothing partial is left behind.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isContained } from './paths';
import {
  CATALOG_LIMITS,
  INSTALL_RECORD_FILE,
  encodePath,
  installFolderName,
  isSafeInstallFolderName,
  isSafeRelativePath,
  pinnedSourceUrl,
  type CatalogEntry,
  type CatalogFile,
  type InstallRecord,
} from '../shared/catalog';

export type InstallScope = 'project' | 'global';

export type InstallErrorCode = 'unsupported' | 'unsafe' | 'conflict' | 'cancelled' | 'integrity' | 'download' | 'io';

export class InstallError extends Error {
  constructor(
    public readonly code: InstallErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface SourceProvider {
  /** Returns the bytes of `relPath` inside the entry's skill directory at its pinned commit. */
  readFile(entry: CatalogEntry, relPath: string, expectedSize: number, signal?: AbortSignal): Promise<Buffer>;
}

export interface InstallPlan {
  entry: CatalogEntry;
  scope: InstallScope;
  skillsRoot: string;
  folderName: string;
  destDir: string;
  /** Files that will be written. */
  files: CatalogFile[];
  /** Files in the source that will not be installed, with the reason. */
  excluded: { path: string; reason: string }[];
  totalBytes: number;
  /** A folder with the same name already exists at the destination. */
  exists: boolean;
}

export interface InstallOutcome {
  destDir: string;
  backupDir?: string;
  filesWritten: number;
  record: InstallRecord;
}

/** Git blob SHA-1 of a file's content (what `git hash-object` prints). */
export function gitBlobSha(buf: Buffer): string {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Validates an entry for installation and computes where it would go. Throws InstallError. */
export async function planInstall(entry: CatalogEntry, skillsRoot: string, scope: InstallScope): Promise<InstallPlan> {
  if (entry.kind !== 'skill') throw new InstallError('unsupported', 'This entry is part of a Claude Code plugin. Plugin installation is not supported yet.');
  if (!/^[0-9a-f]{40}$/.test(entry.commitSha)) throw new InstallError('unsafe', 'Entry is not pinned to a commit.');
  if (entry.sourceUrl !== pinnedSourceUrl(entry.owner, entry.repo, entry.commitSha, entry.path)) throw new InstallError('unsafe', 'Entry source URL does not match its pinned commit.');
  const folderName = installFolderName(entry);
  if (!isSafeInstallFolderName(folderName)) throw new InstallError('unsafe', `"${folderName}" is not a safe skill folder name.`);
  const destDir = path.join(skillsRoot, folderName);
  if (!isContained(skillsRoot, destDir) || path.dirname(destDir) !== path.resolve(skillsRoot)) throw new InstallError('unsafe', 'Destination escapes the skills folder.');

  const files: CatalogFile[] = [];
  const excluded: InstallPlan['excluded'] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of entry.files) {
    if (!isSafeRelativePath(f.path)) throw new InstallError('unsafe', `Unsafe file path in entry: ${f.path.slice(0, 80)}`);
    if (seen.has(f.path.toLowerCase())) throw new InstallError('unsafe', `Duplicate file path: ${f.path}`);
    seen.add(f.path.toLowerCase());
    if (f.path === INSTALL_RECORD_FILE) {
      excluded.push({ path: f.path, reason: 'reserved for SkillTree provenance' });
      continue;
    }
    if (f.kind === 'symlink') {
      excluded.push({ path: f.path, reason: 'symbolic link (not installed)' });
      continue;
    }
    if (f.kind === 'submodule') {
      excluded.push({ path: f.path, reason: 'git submodule (not installed)' });
      continue;
    }
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > CATALOG_LIMITS.maxFileBytes) throw new InstallError('unsafe', `${f.path} exceeds the per-file size limit.`);
    if (!/^[0-9a-f]{40}$/.test(f.sha)) throw new InstallError('unsafe', `${f.path} has no valid content hash.`);
    total += f.size;
    files.push(f);
  }
  if (!files.some((f) => f.path === 'SKILL.md')) {
    const linked = excluded.some((e) => e.path === 'SKILL.md');
    throw new InstallError('unsafe', linked ? 'SKILL.md is a symbolic link in the repository, and SkillTree does not install links.' : 'Entry has no SKILL.md.');
  }
  if (files.length > CATALOG_LIMITS.maxFilesPerSkill) throw new InstallError('unsafe', 'Entry has too many files.');
  if (total > CATALOG_LIMITS.maxSkillBytes) throw new InstallError('unsafe', 'Entry exceeds the total size limit.');
  // Case-insensitive filesystems: a file and a directory may not collide either.
  const lower = new Set(files.map((f) => f.path.toLowerCase()));
  for (const f of files) {
    const segs = f.path.toLowerCase().split('/');
    for (let i = 1; i < segs.length; i++) if (lower.has(segs.slice(0, i).join('/'))) throw new InstallError('unsafe', `Path conflict: ${f.path}`);
  }

  return { entry, scope, skillsRoot: path.resolve(skillsRoot), folderName, destDir, files, excluded, totalBytes: total, exists: await exists(destDir) };
}

const DOWNLOAD_CONCURRENCY = 6;

export async function executeInstall(
  plan: InstallPlan,
  provider: SourceProvider,
  opts: { replaceExisting?: boolean; signal?: AbortSignal; now?: () => Date; onProgress?: (done: number, total: number, file: string) => void } = {},
): Promise<InstallOutcome> {
  const { signal } = opts;
  const checkCancel = () => {
    if (signal?.aborted) throw new InstallError('cancelled', 'Installation was cancelled. Nothing was changed.');
  };
  checkCancel();
  const destExists = await exists(plan.destDir);
  if (destExists && !opts.replaceExisting) {
    throw new InstallError('conflict', `A skill folder named "${plan.folderName}" already exists in ${plan.skillsRoot}. Nothing was changed.`);
  }

  try {
    await fs.mkdir(plan.skillsRoot, { recursive: true });
  } catch (err) {
    throw new InstallError('io', `Could not create ${plan.skillsRoot}: ${(err as Error).message}`);
  }
  const staging = path.join(plan.skillsRoot, `.skilltree-staging-${crypto.randomBytes(6).toString('hex')}`);
  await fs.mkdir(staging);
  let backupDir: string | undefined;
  let movedOld = false;
  let placed = false;
  try {
    // A few downloads in parallel (large skills have hundreds of files). Every file is still
    // size- and hash-checked against the pinned commit before it is written into the staging folder.
    let done = 0;
    let next = 0;
    let stop = false;
    const one = async (f: (typeof plan.files)[number]) => {
      checkCancel();
      let buf: Buffer;
      try {
        buf = await provider.readFile(plan.entry, f.path, f.size, signal);
      } catch (err) {
        if (signal?.aborted) throw new InstallError('cancelled', 'Installation was cancelled. Nothing was changed.');
        throw new InstallError('download', `Could not download ${f.path}: ${(err as Error).message}`);
      }
      if (buf.length !== f.size || gitBlobSha(buf) !== f.sha) {
        throw new InstallError('integrity', `${f.path} does not match the pinned commit (size or hash differs). Nothing was installed.`);
      }
      const target = path.join(staging, ...f.path.split('/'));
      if (!isContained(staging, target) || target === staging) throw new InstallError('unsafe', `Refusing to write outside the skill folder: ${f.path}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, buf, { flag: 'wx', mode: 0o644 });
      done++;
      opts.onProgress?.(done, plan.files.length, f.path);
    };
    const worker = async () => {
      while (!stop && next < plan.files.length) {
        const f = plan.files[next++];
        try {
          await one(f);
        } catch (err) {
          stop = true; // no new downloads; let the others finish before rolling back
          throw err;
        }
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, plan.files.length) }, worker));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
    const now = (opts.now ?? (() => new Date()))().toISOString();
    const record: InstallRecord = {
      schema: 1,
      id: plan.entry.id,
      owner: plan.entry.owner,
      repo: plan.entry.repo,
      path: plan.entry.path,
      commitSha: plan.entry.commitSha,
      sourceUrl: plan.entry.sourceUrl,
      indexedAt: plan.entry.indexedAt,
      installedAt: now,
    };
    await fs.writeFile(path.join(staging, INSTALL_RECORD_FILE), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    checkCancel();

    if (destExists) {
      backupDir = path.join(plan.skillsRoot, `.skilltree-backup-${plan.folderName}-${now.replace(/[:.]/g, '-')}`);
      await fs.rename(plan.destDir, backupDir);
      movedOld = true;
    } else if (await exists(plan.destDir)) {
      throw new InstallError('conflict', `"${plan.folderName}" appeared while installing. Nothing was changed.`);
    }
    await fs.rename(staging, plan.destDir);
    placed = true;
    return { destDir: plan.destDir, backupDir, filesWritten: plan.files.length, record };
  } catch (err) {
    // Roll back: remove staging, restore the previous folder if it was moved.
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (movedOld && !placed && backupDir) await fs.rename(backupDir, plan.destDir).catch(() => undefined);
    if (err instanceof InstallError) throw err;
    throw new InstallError('io', `Installation failed and was rolled back: ${(err as Error).message}`);
  }
}

/** Reads files from raw.githubusercontent.com at the entry's pinned commit. */
export function githubRawProvider(timeoutMs = 20000): SourceProvider {
  return {
    async readFile(entry, relPath, expectedSize, signal) {
      const full = entry.path ? `${entry.path}/${relPath}` : relPath;
      const url = `https://raw.githubusercontent.com/${entry.owner}/${entry.repo}/${entry.commitSha}/${encodePath(full)}`;
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      signal?.addEventListener('abort', onAbort);
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'skilltree' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Content-Length is the *compressed* size when the response is gzip-encoded, so only
        // compare it for identity responses. The blob-hash check after download is authoritative.
        const len = Number(res.headers.get('content-length') ?? '0');
        const encoded = (res.headers.get('content-encoding') ?? 'identity') !== 'identity';
        if (len > CATALOG_LIMITS.maxFileBytes || (!encoded && len && len !== expectedSize)) throw new Error(`unexpected size ${len}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > CATALOG_LIMITS.maxFileBytes) throw new Error('file too large');
        if (buf.length !== expectedSize) throw new Error(`size ${buf.length} does not match the catalog (${expectedSize})`);
        return buf;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

/**
 * Reads files from a local mirror laid out as <root>/<owner>/<repo>/<commitSha>/<path>/<file>.
 * Used by tests and offline demos; never follows symlinks out of the mirror.
 */
export function directoryProvider(root: string): SourceProvider {
  return {
    async readFile(entry, relPath) {
      const base = path.join(root, entry.owner, entry.repo, entry.commitSha, ...entry.path.split('/').filter(Boolean));
      const file = path.join(base, ...relPath.split('/'));
      if (!isContained(base, file)) throw new Error('path escapes mirror');
      const st = await fs.lstat(file);
      if (!st.isFile()) throw new Error('not a regular file');
      return fs.readFile(file);
    },
  };
}

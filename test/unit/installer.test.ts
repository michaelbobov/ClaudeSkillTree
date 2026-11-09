import { CATALOG_LIMITS } from '../../src/shared/catalog';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { directoryProvider, executeInstall, gitBlobSha, InstallError, planInstall, type SourceProvider } from '../../src/core/installer';
import { scanAll, standardRoots } from '../../src/core/scanner';
import { INSTALL_RECORD_FILE, installStateFor } from '../../src/shared/catalog';
import { makeEntry } from './helpers/catalogFixtures';

let tmp: string;
let mirror: string;
let skillsRoot: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skilltree-install-')));
  mirror = path.join(tmp, 'mirror');
  skillsRoot = path.join(tmp, 'project', '.claude', 'skills');
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const files = { 'SKILL.md': '---\nname: demo-skill\ndescription: Demo\n---\nBody\n', 'reference.md': '# Ref\n', 'scripts/run.sh': '#!/bin/sh\necho hi\n' };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof InstallError ? err.code : `other: ${(err as Error).message}`;
  }
}

describe('gitBlobSha', () => {
  it('matches git hash-object', () => {
    expect(gitBlobSha(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});

describe('installer', () => {
  it('installs into the destination, writes provenance and is detected as installed', async () => {
    const entry = await makeEntry(mirror, files, { kinds: { 'scripts/run.sh': 'script' } });
    const plan = await planInstall(entry, skillsRoot, 'project');
    expect(plan.exists).toBe(false);
    const out = await executeInstall(plan, directoryProvider(mirror));
    expect(out.filesWritten).toBe(3);
    expect(await fs.readFile(path.join(skillsRoot, 'demo-skill', 'scripts/run.sh'), 'utf8')).toBe(files['scripts/run.sh']);
    const st = await fs.stat(path.join(skillsRoot, 'demo-skill', 'scripts/run.sh'));
    expect(st.mode & 0o111).toBe(0); // executable bits are not preserved
    const record = JSON.parse(await fs.readFile(path.join(skillsRoot, 'demo-skill', INSTALL_RECORD_FILE), 'utf8'));
    expect(record).toMatchObject({ id: entry.id, commitSha: entry.commitSha, sourceUrl: entry.sourceUrl });
    // No staging leftovers
    expect((await fs.readdir(skillsRoot)).filter((n) => n.startsWith('.'))).toEqual([]);
    // Scanner sees it with provenance, and install state matches exactly
    const { skills } = await scanAll(standardRoots({ homeDir: path.join(tmp, 'home'), workspaceFolders: [{ name: 'project', path: path.join(tmp, 'project') }] }));
    expect(skills).toHaveLength(1);
    expect(skills[0].installedFrom).toMatchObject({ id: entry.id, commitSha: entry.commitSha });
    expect(skills[0].supportingFiles.some((f) => f.path === INSTALL_RECORD_FILE)).toBe(false);
    expect(installStateFor(entry, skills).state).toBe('installed');
  });

  it('refuses to overwrite an existing folder unless replace is confirmed, then keeps a backup', async () => {
    const entry = await makeEntry(mirror, files);
    await fs.mkdir(path.join(skillsRoot, 'demo-skill'), { recursive: true });
    await fs.writeFile(path.join(skillsRoot, 'demo-skill', 'SKILL.md'), 'mine');
    const plan = await planInstall(entry, skillsRoot, 'global');
    expect(plan.exists).toBe(true);
    expect(await codeOf(executeInstall(plan, directoryProvider(mirror)))).toBe('conflict');
    expect(await fs.readFile(path.join(skillsRoot, 'demo-skill', 'SKILL.md'), 'utf8')).toBe('mine');
    const out = await executeInstall(plan, directoryProvider(mirror), { replaceExisting: true });
    expect(out.backupDir).toBeDefined();
    expect(await fs.readFile(path.join(out.backupDir!, 'SKILL.md'), 'utf8')).toBe('mine');
    expect(path.basename(out.backupDir!).startsWith('.')).toBe(true); // hidden from the scanner
    expect(await fs.readFile(path.join(skillsRoot, 'demo-skill', 'SKILL.md'), 'utf8')).toBe(files['SKILL.md']);
  });

  it('rejects traversal, absolute paths and unsafe folder names in entries', async () => {
    const entry = await makeEntry(mirror, files);
    expect(await codeOf(planInstall({ ...entry, files: [...entry.files, { path: '../evil.md', size: 1, sha: 'a'.repeat(40), kind: 'markdown' }] }, skillsRoot, 'project'))).toBe('unsafe');
    expect(await codeOf(planInstall({ ...entry, files: [...entry.files, { path: '/etc/passwd', size: 1, sha: 'a'.repeat(40), kind: 'other' }] }, skillsRoot, 'project'))).toBe('unsafe');
    expect(await codeOf(planInstall({ ...entry, path: 'skills/..', id: 'x' }, skillsRoot, 'project'))).toBe('unsafe');
    expect(await codeOf(planInstall({ ...entry, files: entry.files.filter((f) => f.path !== 'SKILL.md') }, skillsRoot, 'project'))).toBe('unsafe');
    expect(await codeOf(planInstall({ ...entry, commitSha: 'main' }, skillsRoot, 'project'))).toBe('unsafe');
    expect(await codeOf(planInstall({ ...entry, kind: 'plugin-unsupported' }, skillsRoot, 'project'))).toBe('unsupported');
  });

  it('never installs symlinks or submodules and enforces size limits', async () => {
    const entry = await makeEntry(mirror, files);
    const plan = await planInstall({ ...entry, files: [...entry.files, { path: 'link', size: 5, sha: 'a'.repeat(40), kind: 'symlink' }, { path: 'vendor', size: 0, sha: 'a'.repeat(40), kind: 'submodule' }] }, skillsRoot, 'project');
    expect(plan.excluded.map((e) => e.path)).toEqual(['link', 'vendor']);
    expect(plan.files.map((f) => f.path)).not.toContain('link');
    expect(await codeOf(planInstall({ ...entry, files: [...entry.files, { path: 'big.bin', size: CATALOG_LIMITS.maxFileBytes + 1, sha: 'a'.repeat(40), kind: 'other' }] }, skillsRoot, 'project'))).toBe('unsafe');
  });

  it('refuses an entry whose SKILL.md is a symbolic link, and says why', async () => {
    const entry = await makeEntry(mirror, files);
    const linked = { ...entry, files: entry.files.map((f) => (f.path === 'SKILL.md' ? { ...f, kind: 'symlink' as const } : f)) };
    const err = await planInstall(linked, skillsRoot, 'project').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstallError);
    expect((err as InstallError).code).toBe('unsafe');
    expect((err as Error).message).toMatch(/SKILL\.md is a symbolic link/);
  });

  it('rolls back on integrity failure and leaves nothing behind', async () => {
    const entry = await makeEntry(mirror, files);
    const tampered = { ...entry, files: entry.files.map((f) => (f.path === 'reference.md' ? { ...f, sha: 'f'.repeat(40) } : f)) };
    const plan = await planInstall(tampered, skillsRoot, 'project');
    expect(await codeOf(executeInstall(plan, directoryProvider(mirror)))).toBe('integrity');
    expect(await fs.readdir(skillsRoot)).toEqual([]);
  });

  it('installs many files in parallel and still leaves nothing behind when one fails mid-way', async () => {
    const many: Record<string, string> = { 'SKILL.md': '---\nname: big-skill\n---\nbody' };
    for (let i = 0; i < 60; i++) many[`assets/a${i}.txt`] = `asset ${i}`;
    const entry = await makeEntry(mirror, many, { name: 'big-skill' });
    const ok = await executeInstall(await planInstall(entry, skillsRoot, 'project'), directoryProvider(mirror));
    expect((await fs.readdir(path.join(ok.destDir, 'assets'))).length).toBe(60);
    await fs.rm(ok.destDir, { recursive: true });

    let calls = 0;
    const flaky: SourceProvider = {
      readFile: async (e, p, size, signal) => {
        if (++calls === 25) throw new Error('connection reset');
        await new Promise((r) => setTimeout(r, 2));
        return directoryProvider(mirror).readFile(e, p, size, signal);
      },
    };
    expect(await codeOf(executeInstall(await planInstall(entry, skillsRoot, 'project'), flaky))).toBe('download');
    expect(await fs.readdir(skillsRoot)).toEqual([]);
  });

  it('restores the previous folder if replacing fails part-way', async () => {
    const entry = await makeEntry(mirror, files);
    await fs.mkdir(path.join(skillsRoot, 'demo-skill'), { recursive: true });
    await fs.writeFile(path.join(skillsRoot, 'demo-skill', 'SKILL.md'), 'mine');
    const failing: SourceProvider = { readFile: async () => { throw new Error('network down'); } };
    const plan = await planInstall(entry, skillsRoot, 'project');
    expect(await codeOf(executeInstall(plan, failing, { replaceExisting: true }))).toBe('download');
    expect(await fs.readFile(path.join(skillsRoot, 'demo-skill', 'SKILL.md'), 'utf8')).toBe('mine');
    expect((await fs.readdir(skillsRoot)).sort()).toEqual(['demo-skill']);
  });

  it('supports cancellation', async () => {
    const entry = await makeEntry(mirror, files);
    const plan = await planInstall(entry, skillsRoot, 'project');
    const ctrl = new AbortController();
    const slow: SourceProvider = {
      readFile: async (e, rel, size, signal) => {
        ctrl.abort();
        return directoryProvider(mirror).readFile(e, rel, size, signal);
      },
    };
    expect(await codeOf(executeInstall(plan, slow, { signal: ctrl.signal }))).toBe('cancelled');
    expect(await fs.readdir(skillsRoot)).toEqual([]);
  });
});

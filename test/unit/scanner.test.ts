import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanAll, scanRoot, shortenPath, standardRoots } from '../../src/core/scanner';

let tmp: string;
let home: string;
let ws: string;

async function write(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

const skill = (name: string, description = `${name} description`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skilltree-test-')));
  home = path.join(tmp, 'home');
  ws = path.join(tmp, 'repo');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(ws, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function roots(extra: Partial<Parameters<typeof standardRoots>[0]> = {}) {
  return standardRoots({ homeDir: home, workspaceFolders: [{ name: 'repo', path: ws }], ...extra });
}

describe('scanAll', () => {
  it('reports missing roots as not found and returns no skills', async () => {
    const result = await scanAll(roots(), { homeDir: home });
    expect(result.skills).toEqual([]);
    expect(result.roots.map((r) => [r.source, r.exists])).toEqual([
      ['project', false],
      ['personal', false],
      ['synced', false],
    ]);
  });

  it('finds project and personal skills with distinct scopes and stable ids', async () => {
    await write(path.join(ws, '.claude/skills/example/SKILL.md'), skill('example'));
    await write(path.join(home, '.claude/skills/writer/SKILL.md'), skill('writer'));
    const { skills, roots: status } = await scanAll(roots(), { homeDir: home });
    expect(skills.map((s) => [s.id, s.source, s.command, s.readOnly])).toEqual([
      ['project/repo/example', 'project', '/example', false],
      ['personal/writer', 'personal', '/writer', false],
    ]);
    expect(skills[1].displayPath).toBe('~/.claude/skills/writer/SKILL.md');
    expect(status.find((r) => r.source === 'project')).toMatchObject({ exists: true, skillCount: 1 });
  });

  it('skips dot folders, loose files, the reserved synced folder and folders without SKILL.md', async () => {
    const base = path.join(home, '.claude/skills');
    await write(path.join(base, 'good/SKILL.md'), skill('good'));
    await write(path.join(base, '.trash/old/SKILL.md'), skill('old'));
    await write(path.join(base, 'notes.md'), 'loose file');
    await write(path.join(base, 'empty-folder/README.md'), 'no skill here');
    await write(path.join(base, 'nested/deeper/SKILL.md'), skill('deeper'));
    const { skills, roots: status } = await scanAll(roots(), { homeDir: home });
    expect(skills.map((s) => s.name)).toEqual(['good']);
    const personal = status.find((r) => r.source === 'personal')!;
    expect(personal.skipped.map((s) => s.name).sort()).toEqual(['empty-folder', 'nested']);
  });

  it('reads synced skills from bucket folders as read-only and namespaced', async () => {
    const bucket = path.join(home, '.claude/skills/synced/abc_def');
    await write(path.join(bucket, 'pdf/SKILL.md'), skill('pdf'));
    await write(path.join(bucket, '.staging/tmp/SKILL.md'), skill('tmp'));
    await write(path.join(bucket, 'manifest.json'), '{}');
    await fs.mkdir(path.join(home, '.claude/skills/synced/.bucket-abc_def'), { recursive: true });
    const { skills } = await scanAll(roots(), { homeDir: home });
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      id: 'synced/pdf',
      source: 'synced',
      readOnly: true,
      command: '/anthropic-skills:pdf',
      displayPath: '~/.claude/skills/synced/…/pdf/SKILL.md',
    });
    expect(skills[0].file).toBe(path.join(bucket, 'pdf/SKILL.md'));
  });

  it('marks a project skill shadowed by a personal skill with the same name', async () => {
    await write(path.join(ws, '.claude/skills/deploy/SKILL.md'), skill('deploy', 'project version'));
    await write(path.join(home, '.claude/skills/deploy/SKILL.md'), skill('deploy', 'personal version'));
    const { skills } = await scanAll(roots(), { homeDir: home });
    const project = skills.find((s) => s.source === 'project')!;
    const personal = skills.find((s) => s.source === 'personal')!;
    expect(project.shadowedBy).toBe(personal.id);
    expect(personal.shadowedBy).toBeUndefined();
    expect(project.sameNameAs).toEqual([personal.id]);
    expect(personal.sameNameAs).toEqual([project.id]);
    expect(project.issues.some((i) => i.message.startsWith('Shadowed'))).toBe(true);
  });

  it('matches collisions on the effective name, not the folder name', async () => {
    await write(path.join(ws, '.claude/skills/a/SKILL.md'), skill('shared'));
    await write(path.join(home, '.claude/skills/b/SKILL.md'), skill('shared'));
    const { skills } = await scanAll(roots(), { homeDir: home });
    expect(skills.find((s) => s.source === 'project')!.shadowedBy).toBe('personal/b');
  });

  it('managed skills take precedence over personal ones', async () => {
    const managed = path.join(tmp, 'managed');
    await write(path.join(managed, '.claude/skills/lint/SKILL.md'), skill('lint'));
    await write(path.join(home, '.claude/skills/lint/SKILL.md'), skill('lint'));
    const { skills } = await scanAll(roots({ managedDir: managed }), { homeDir: home });
    expect(skills.find((s) => s.source === 'personal')!.shadowedBy).toBe('managed/lint');
    expect(skills.find((s) => s.source === 'managed')!.readOnly).toBe(true);
  });

  it('does not shadow namespaced synced skills', async () => {
    await write(path.join(home, '.claude/skills/pdf/SKILL.md'), skill('pdf'));
    await write(path.join(home, '.claude/skills/synced/b1/pdf/SKILL.md'), skill('pdf'));
    const { skills } = await scanAll(roots(), { homeDir: home });
    expect(skills.every((s) => !s.shadowedBy)).toBe(true);
    expect(skills.find((s) => s.source === 'synced')!.sameNameAs).toEqual(['personal/pdf']);
  });

  it('de-duplicates the same SKILL.md reached through a symlink', async () => {
    await write(path.join(home, '.claude/skills/real/SKILL.md'), skill('real'));
    await fs.mkdir(path.join(ws, '.claude/skills'), { recursive: true });
    await fs.symlink(path.join(home, '.claude/skills/real'), path.join(ws, '.claude/skills/linked'));
    const { skills, roots: status } = await scanAll(roots(), { homeDir: home });
    expect(skills).toHaveLength(1);
    const skipped = [...status.flatMap((r) => r.skipped)];
    expect(skipped.some((s) => s.reason.includes('already listed'))).toBe(true);
  });

  it('records broken symlinks as skipped', async () => {
    await fs.mkdir(path.join(home, '.claude/skills'), { recursive: true });
    await fs.symlink(path.join(tmp, 'nowhere'), path.join(home, '.claude/skills/broken'));
    const { roots: status } = await scanAll(roots(), { homeDir: home });
    expect(status.find((r) => r.source === 'personal')!.skipped).toEqual([{ name: 'broken', reason: 'Broken symbolic link' }]);
  });

  it('lists supporting files, flags scripts and does not follow symlinks inside a skill', async () => {
    const dir = path.join(home, '.claude/skills/tooling');
    await write(path.join(dir, 'SKILL.md'), skill('tooling'));
    await write(path.join(dir, 'reference.md'), '# ref');
    await write(path.join(dir, 'scripts/run.sh'), '#!/bin/sh\necho hi');
    await write(path.join(dir, 'bin/tool'), 'binary');
    await fs.chmod(path.join(dir, 'bin/tool'), 0o755);
    await fs.symlink('/etc/hosts', path.join(dir, 'hosts-link'));
    const { skills } = await scanAll(roots(), { homeDir: home });
    const files = Object.fromEntries(skills[0].supportingFiles.map((f) => [f.path, f.kind]));
    expect(files).toEqual({
      'bin/tool': process.platform === 'win32' ? 'other' : 'executable',
      'hosts-link': 'symlink',
      'reference.md': 'markdown',
      'scripts/run.sh': 'script',
    });
    expect(skills[0].issues.some((i) => i.message.includes('script'))).toBe(true);
  });

  it('refuses to read oversized SKILL.md files but still lists the skill', async () => {
    await write(path.join(home, '.claude/skills/huge/SKILL.md'), skill('huge') + 'x'.repeat(5000));
    const { skills } = await scanAll(roots(), { homeDir: home, maxSkillFileBytes: 1000 });
    expect(skills[0].name).toBe('huge');
    expect(skills[0].issues.some((i) => i.level === 'error' && i.message.includes('limit'))).toBe(true);
  });

  it('keeps malformed skills visible with their issues', async () => {
    await write(path.join(ws, '.claude/skills/bad-yaml/SKILL.md'), '---\nname: [oops\n---\nStill a body');
    await write(path.join(ws, '.claude/skills/no-meta/SKILL.md'), 'Just instructions.');
    const { skills } = await scanAll(roots(), { homeDir: home });
    expect(skills.map((s) => s.name).sort()).toEqual(['bad-yaml', 'no-meta']);
    expect(skills.find((s) => s.name === 'bad-yaml')!.issues.some((i) => i.level === 'error')).toBe(true);
    expect(skills.find((s) => s.name === 'no-meta')!.description).toBe('Just instructions.');
  });

  it('namespaces nested skills by their subdirectory', async () => {
    const skillsDir = path.join(ws, 'apps/web/.claude/skills');
    await write(path.join(skillsDir, 'deploy/SKILL.md'), skill('deploy'));
    await write(path.join(ws, '.claude/skills/deploy/SKILL.md'), skill('deploy'));
    const { skills } = await scanAll(roots({ nestedSkillDirs: [{ folderName: 'repo', folderPath: ws, skillsDir }] }), { homeDir: home });
    const nested = skills.find((s) => s.source === 'nested')!;
    expect(nested.command).toBe('/apps/web:deploy');
    expect(nested.id).toBe('nested/repo/apps/web/deploy');
    // Both load in Claude Code: the nested one is namespaced, so neither is shadowed.
    expect(skills.every((s) => !s.shadowedBy)).toBe(true);
  });

  it('gives distinct ids to same-named folders in separate synced buckets', async () => {
    await write(path.join(home, '.claude/skills/synced/b1/docx/SKILL.md'), skill('docx'));
    await write(path.join(home, '.claude/skills/synced/b2/docx/SKILL.md'), skill('docx'));
    const { skills } = await scanAll(roots(), { homeDir: home });
    expect(skills.map((s) => s.id).sort()).toEqual(['synced/docx', 'synced/docx~2']);
  });
});

describe('scanRoot', () => {
  it('reports a root that is a file, not a directory', async () => {
    const file = path.join(tmp, 'file');
    await write(file, 'x');
    const { status } = await scanRoot({ source: 'personal', path: file, label: 'x', displayPath: 'x', readOnly: false, idPrefix: 'personal' });
    expect(status.error).toBe('Not a directory');
  });
});

describe('shortenPath', () => {
  it('replaces the home directory with ~', () => {
    expect(shortenPath(path.join(home, '.claude/skills/x/SKILL.md'), home)).toBe('~/.claude/skills/x/SKILL.md');
    expect(shortenPath('/other/place', home)).toBe('/other/place');
  });
});

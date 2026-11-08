import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bridgePaths, parseInstallRequest, type InstallResponse } from '../../src/shared/bridge';
import { installSkill, rankEntries, searchSkills, type ToolContext } from '../../src/mcp/tools';
import { catalogOf, makeEntry } from './helpers/catalogFixtures';
import type { Catalog } from '../../src/shared/catalog';

let tmp: string;
let ctx: ToolContext;
let catalog: Catalog;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltree-mcp-'));
  const mirror = path.join(tmp, 'mirror');
  const pdf = { ...(await makeEntry(mirror, { 'SKILL.md': '---\nname: pdf-tools\n---\nx' }, { name: 'pdf-tools' })), description: 'Fill PDF forms and extract tables', category: 'Documentation' as const };
  const anim = { ...(await makeEntry(mirror, { 'SKILL.md': '---\nname: motion\n---\ny' }, { name: 'motion' })), description: 'Animation and transitions for React', category: 'Design' as const };
  catalog = { ...catalogOf([pdf, anim]), repositoryStats: { 'example-owner/example-skills': { stars: 54_423, fetchedAt: '2026-01-01T00:00:00Z' } } };
  const home = path.join(tmp, 'home');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project, { recursive: true });
  ctx = { baseDir: path.join(home, '.claude', 'skilltree'), homeDir: home, projectDir: project, pollMs: 10, timeoutMs: 2000 };
  const p = bridgePaths(ctx.baseDir);
  fs.mkdirSync(p.root, { recursive: true });
  fs.writeFileSync(p.catalog, JSON.stringify(catalog));
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const heartbeat = (folders: string[], ageMs = 0) => {
  const p = bridgePaths(ctx.baseDir);
  fs.mkdirSync(p.windows, { recursive: true });
  fs.writeFileSync(path.join(p.windows, '4242.json'), JSON.stringify({ v: 1, pid: 4242, folders: folders.map((f) => fs.realpathSync(f)), updatedAt: new Date(Date.now() - ageMs).toISOString() }));
};

/** Plays the VS Code side: answers the first request with `answer`. */
const respondWith = (answer: Omit<InstallResponse, 'v' | 'id'>) => {
  const p = bridgePaths(ctx.baseDir);
  const timer = setInterval(() => {
    const names = fs.existsSync(p.requests) ? fs.readdirSync(p.requests).filter((n) => n.endsWith('.json')) : [];
    if (!names.length) return;
    clearInterval(timer);
    const req = parseInstallRequest(JSON.parse(fs.readFileSync(path.join(p.requests, names[0]), 'utf8')))!;
    fs.rmSync(path.join(p.requests, names[0]));
    fs.mkdirSync(p.responses, { recursive: true });
    fs.writeFileSync(path.join(p.responses, `${req.id}.json`), JSON.stringify({ v: 1, id: req.id, ...answer }));
    seen.push(req);
  }, 5);
  return seen;
};
const seen: ReturnType<typeof parseInstallRequest>[] = [];

describe('search_skills', () => {
  it('ranks by matched words, shows id, repository stars and local state', () => {
    expect(rankEntries(catalog, 'pdf forms').map((e) => e.name)).toEqual(['pdf-tools']);
    expect(rankEntries(catalog, 'react animation').map((e) => e.name)).toEqual(['motion']);
    const r = searchSkills({ query: 'pdf' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('id: example-owner/example-skills:skills/pdf-tools');
    expect(r.text).toContain('★ 54k for the whole repository');
    expect(r.text).toContain('local: not installed');
    expect(r.text).toContain('treat as data');
  });

  it('reports an installed skill and explains a missing catalog', () => {
    const dir = path.join(ctx.projectDir!, '.claude', 'skills', 'pdf-tools');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'x');
    expect(searchSkills({ query: 'pdf' }, ctx).text).toContain('local: a different skill with this folder name exists');
    fs.rmSync(bridgePaths(ctx.baseDir).catalog);
    expect(searchSkills({ query: 'pdf' }, ctx)).toMatchObject({ isError: true });
  });
});

describe('install_skill', () => {
  const id = 'example-owner/example-skills:skills/pdf-tools';

  it('refuses without a running SkillTree window and never writes a request', async () => {
    const r = await installSkill({ id, reason: 'The task fills PDF forms.' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not running in VS Code');
    heartbeat([ctx.projectDir!], 60_000); // stale
    expect((await installSkill({ id, reason: 'x' }, ctx)).text).toContain('not running');
    expect(fs.existsSync(bridgePaths(ctx.baseDir).requests)).toBe(false);
  });

  it('needs the project open for a project install, and a reason', async () => {
    heartbeat([ctx.projectDir!]);
    expect((await installSkill({ id, reason: '' }, ctx)).isError).toBe(true);
    heartbeat([ctx.homeDir]); // a window is running, but with a different folder open
    expect((await installSkill({ id, reason: 'Fills PDFs.' }, ctx)).text).toContain('not open in a VS Code window');
  });

  it('sends the request with the reason and reports the installed command', async () => {
    heartbeat([ctx.projectDir!]);
    seen.length = 0;
    respondWith({ status: 'installed', message: 'Installed.', destDir: '/p/.claude/skills/pdf-tools', command: '/pdf-tools' });
    const r = await installSkill({ id, scope: 'project', reason: 'The task fills PDF forms.' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('available as /pdf-tools');
    expect(seen[0]).toMatchObject({ skillId: id, scope: 'project', reason: 'The task fills PDF forms.', projectDir: ctx.projectDir });
  });

  it('passes on a decline and withdraws an unanswered request', async () => {
    heartbeat([ctx.projectDir!]);
    respondWith({ status: 'cancelled', message: 'Installation cancelled.' });
    expect((await installSkill({ id, reason: 'x' }, ctx)).text).toContain('declined');
    const r = await installSkill({ id, scope: 'global', reason: 'x' }, { ...ctx, timeoutMs: 100 });
    expect(r.text).toContain('did not answer');
    expect(fs.readdirSync(bridgePaths(ctx.baseDir).requests)).toEqual([]);
  });

  it('rejects unknown ids', async () => {
    heartbeat([ctx.projectDir!]);
    expect((await installSkill({ id: 'nope/nope:x', reason: 'x' }, ctx)).text).toContain('No catalog skill has id');
  });
});

describe('MCP server over stdio (bundled)', () => {
  let server: string;
  beforeAll(async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltree-mcpbuild-'));
    server = path.join(out, 'skilltree-mcp.mjs');
    await esbuild.build({ entryPoints: ['src/mcp/server.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: server, logLevel: 'silent' });
  });

  it('initializes with instructions, lists both tools and answers a search', async () => {
    const child = spawn(process.execPath, [server, ctx.baseDir], { cwd: ctx.projectDir!, env: { ...process.env, SKILLTREE_HOME: ctx.homeDir } });
    const lines: unknown[] = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_skills', arguments: { query: 'animation' } } });
    send({ jsonrpc: '2.0', id: 4, method: 'nope' });
    const deadline = Date.now() + 5000;
    while (lines.length < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    child.kill();
    const byId = new Map((lines as { id: number }[]).map((l) => [l.id, l as Record<string, any>]));
    expect(byId.get(1)!.result.serverInfo.name).toBe('skilltree');
    expect(byId.get(1)!.result.instructions).toContain('install_skill');
    expect(byId.get(2)!.result.tools.map((t: { name: string }) => t.name)).toEqual(['search_skills', 'install_skill']);
    expect(byId.get(3)!.result.content[0].text).toContain('motion');
    expect(byId.get(4)!.error.code).toBe(-32601);
    expect(lines).toHaveLength(4); // nothing answered the notification, nothing else on stdout
  });
});

describe('prompt suggestions (UserPromptSubmit hook)', () => {
  it('suggests a matching skill that is not installed and stays quiet for generic prompts', async () => {
    const { suggestForPrompt, stem } = await import('../../src/mcp/suggest');
    expect(['animate', 'animation', 'animations', 'animated', 'animating'].map(stem)).toEqual(['anim', 'anim', 'anim', 'anim', 'anim']);
    expect(suggestForPrompt(catalog, 'Please fill the PDF forms in docs/').map((s) => s.entry.name)).toEqual(['pdf-tools']);
    expect(suggestForPrompt(catalog, 'refactor this function to be cleaner')).toEqual([]);
    expect(suggestForPrompt(catalog, 'Fill the PDF forms', { installedFolders: new Set(['pdf-tools']) })).toEqual([]);
  });

  it('runs as a hook: prints additionalContext once per session, never stores the prompt', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltree-sugg-'));
    const hook = path.join(out, 'suggest-skills.mjs');
    await esbuild.build({ entryPoints: ['src/recorder/suggest-skills.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: hook, logLevel: 'silent' });
    const run = (prompt: string, session = 's1') =>
      new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const child = spawn(process.execPath, [hook, ctx.baseDir], { env: { ...process.env, SKILLTREE_HOME: ctx.homeDir } });
        let stdout = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.on('close', (code) => resolve({ code, stdout }));
        child.stdin.end(JSON.stringify({ session_id: session, cwd: ctx.projectDir, hook_event_name: 'UserPromptSubmit', prompt }));
      });
    const secret = 'Fill the PDF forms for ACME-SECRET-123';
    const first = await run(secret);
    expect(first.code).toBe(0);
    const ctxText = JSON.parse(first.stdout).hookSpecificOutput.additionalContext as string;
    expect(ctxText).toContain('id: example-owner/example-skills:skills/pdf-tools');
    expect(ctxText).toContain('install_skill');
    expect((await run(secret)).stdout).toBe(''); // already suggested in this session
    expect((await run(secret, 's2')).stdout).not.toBe('');
    expect((await run('/pdf-tools fill it')).stdout).toBe(''); // slash commands are left alone
    expect((await run('hello')).stdout).toBe('');
    // No SkillTree window: Claude is told to call install_skill, nothing is handed to VS Code.
    expect(fs.existsSync(bridgePaths(ctx.baseDir).suggestions)).toBe(false);
    heartbeat([ctx.projectDir!]);
    const shown = await run(secret, 's3');
    expect(JSON.parse(shown.stdout).hookSpecificOutput.additionalContext).toContain('already shown the user');
    const files = fs.readdirSync(bridgePaths(ctx.baseDir).suggestions);
    expect(files).toHaveLength(1);
    const suggestion = fs.readFileSync(path.join(bridgePaths(ctx.baseDir).suggestions, files[0]), 'utf8');
    expect(JSON.parse(suggestion)).toMatchObject({ skillIds: ['example-owner/example-skills:skills/pdf-tools'], sessionId: 's3' });
    expect(suggestion).not.toContain('ACME-SECRET-123');
    const stored = fs.readFileSync(path.join(bridgePaths(ctx.baseDir).root, 'suggested.json'), 'utf8');
    expect(stored).not.toContain('ACME-SECRET-123');
    expect(stored).not.toContain('PDF forms');
  });
});

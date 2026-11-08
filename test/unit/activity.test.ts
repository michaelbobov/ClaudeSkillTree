import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { groupBySession, lastUseBySkill, parseActivityLog, parseHookInput, summarizeUsage, usageFor, type ActivityEvent } from '../../src/shared/activity';

const fixture = (name: string) => JSON.parse(fs.readFileSync(`test/fixtures/hooks/${name}.json`, 'utf8'));
const now = () => new Date('2026-01-01T10:00:00Z');

describe('parseHookInput', () => {
  it('records a documented UserPromptExpansion payload without prompt text or arguments', () => {
    const e = parseHookInput(fixture('user-prompt-expansion'), { projectDir: '/work/repo' }, now)!;
    expect(e).toEqual({ v: 1, ts: '2026-01-01T10:00:00.000Z', source: 'UserPromptExpansion', skill: 'example-skill', sessionId: 'abc123', cwd: '/Users/...', projectDir: '/work/repo', commandSource: 'plugin', hadArgs: true });
    expect(JSON.stringify(e)).not.toContain('arg1');
  });

  it('records a PreToolUse Skill payload and drops the skill arguments', () => {
    const e = parseHookInput(fixture('pre-tool-use-skill'), {}, now)!;
    expect(e.source).toBe('PreToolUse:Skill');
    expect(e.skill).toBe('frontend-design');
    expect(e.hadArgs).toBe(true);
    expect(JSON.stringify(e)).not.toContain('header calmer');
  });

  it('ignores other tools and MCP prompts, and tolerates unknown shapes', () => {
    expect(parseHookInput(fixture('pre-tool-use-bash'))).toBeNull();
    expect(parseHookInput(fixture('mcp-prompt-expansion'))).toBeNull();
    const odd = parseHookInput(fixture('pre-tool-use-skill-unknown-shape'))!;
    expect(odd.skill).toBeNull();
    expect(odd.inputKeys).toEqual(['unexpected']);
    expect(odd.cwd).toBeNull();
    expect(parseHookInput('nope')).toBeNull();
    expect(parseHookInput({ hook_event_name: 'Stop' })).toBeNull();
  });
});

describe('activity log', () => {
  const ev = (ts: string, skill: string | null, sessionId: string | null): ActivityEvent => ({ v: 1, ts, source: 'UserPromptExpansion', skill, sessionId, cwd: '/w', projectDir: null, hadArgs: false });

  it('parses JSONL newest-first and skips malformed lines', () => {
    const text = [JSON.stringify(ev('2026-01-01T00:00:00Z', 'a', 's1')), '{bad', '', JSON.stringify({ v: 9 }), JSON.stringify(ev('2026-01-02T00:00:00Z', 'b', 's1'))].join('\n');
    const r = parseActivityLog(text);
    expect(r.events.map((e) => e.skill)).toEqual(['b', 'a']);
    expect(r.skipped).toBe(2);
  });

  it('groups by session and finds the last use per skill', () => {
    const events = [ev('2026-01-03T00:00:00Z', 'a', 's2'), ev('2026-01-02T00:00:00Z', 'b', 's1'), ev('2026-01-01T00:00:00Z', 'a', 's1'), ev('2026-01-01T05:00:00Z', null, null)];
    const groups = groupBySession(events);
    expect(groups.map((g) => [g.sessionId, g.skills])).toEqual([
      ['s2', ['a']],
      ['s1', ['b', 'a']],
      [null, ['(unknown skill)']],
    ]);
    expect(lastUseBySkill(events).get('a')?.ts).toBe('2026-01-03T00:00:00Z');
  });
});

describe('summarizeUsage', () => {
  const ev = (skill: string | null, sessionId: string | null, ts: string, source: ActivityEvent['source'] = 'PreToolUse:Skill'): ActivityEvent => ({ v: 1, ts, source, skill, sessionId, cwd: null, projectDir: null, hadArgs: false });
  const events = [
    ev('pdf', 's1', '2026-01-01T10:00:00Z', 'UserPromptExpansion'),
    ev('PDF', 's1', '2026-01-01T10:05:00Z'),
    ev('docx', 's1', '2026-01-01T10:06:00Z'),
    ev('pdf', 's2', '2026-01-02T09:00:00Z'),
    ev('docx', 's2', '2026-01-02T09:01:00Z'),
    ev('anthropic-skills:xlsx', 's2', '2026-01-02T09:02:00Z'),
    ev(null, 's3', '2026-01-03T00:00:00Z'),
    ev('lint', null, '2026-01-04T00:00:00Z'),
  ];

  it('counts recorded uses per skill by capture source, session and recency', () => {
    const u = summarizeUsage(events);
    expect(u.totalEvents).toBe(8);
    expect(u.totalSessions).toBe(3);
    expect(u.bySkill.pdf).toEqual({ count: 3, typed: 1, invoked: 2, sessions: 2, lastTs: '2026-01-02T09:00:00Z', lastSource: 'PreToolUse:Skill', lastSessionId: 's2' });
    expect(u.bySkill.lint).toMatchObject({ count: 1, sessions: 0 });
    expect(Object.keys(u.bySkill).sort()).toEqual(['anthropic-skills:xlsx', 'docx', 'lint', 'pdf']);
  });

  it('pairs skills recorded in the same session, most shared sessions first', () => {
    expect(summarizeUsage(events).coUsage).toEqual([
      { a: 'docx', b: 'pdf', sessions: 2 },
      { a: 'anthropic-skills:xlsx', b: 'docx', sessions: 1 },
      { a: 'anthropic-skills:xlsx', b: 'pdf', sessions: 1 },
    ]);
    expect(summarizeUsage([]).coUsage).toEqual([]);
  });

  it('matches a skill by its full command first, then its bare name', () => {
    const u = summarizeUsage(events);
    expect(usageFor(u, { name: 'xlsx', command: '/anthropic-skills:xlsx' })?.count).toBe(1);
    expect(usageFor(u, { name: 'pdf', command: '/pdf' })?.count).toBe(3);
    expect(usageFor(u, { name: 'pptx', command: '/anthropic-skills:pptx' })).toBeUndefined();
    expect(usageFor(undefined, { name: 'pdf', command: '/pdf' })).toBeUndefined();
  });
});

describe('recorder hook (bundled, run like Claude Code runs it)', () => {
  let recorder: string;
  let dir: string;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltree-rec-'));
    recorder = path.join(dir, 'record-skill-event.mjs');
    await esbuild.build({ entryPoints: ['src/recorder/record-skill-event.ts'], bundle: true, platform: 'node', format: 'esm', outfile: recorder, logLevel: 'silent' });
  });

  const run = (payload: string, log: string, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [recorder, log], { input: payload, encoding: 'utf8', env: { ...process.env, ...env } });

  it('appends one event per skill invocation, prints nothing and exits 0', () => {
    const log = path.join(dir, 'a', 'activity.jsonl');
    const r1 = run(fs.readFileSync('test/fixtures/hooks/user-prompt-expansion.json', 'utf8'), log, { CLAUDE_PROJECT_DIR: '/work/repo' });
    const r2 = run(fs.readFileSync('test/fixtures/hooks/pre-tool-use-skill.json', 'utf8'), log);
    const r3 = run(fs.readFileSync('test/fixtures/hooks/pre-tool-use-bash.json', 'utf8'), log);
    for (const r of [r1, r2, r3]) {
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.source, l.skill, l.projectDir])).toEqual([
      ['UserPromptExpansion', 'example-skill', '/work/repo'],
      ['PreToolUse:Skill', 'frontend-design', null],
    ]);
    expect(fs.readFileSync(log, 'utf8')).not.toContain('/example-skill arg1');
  });

  it('exits 0 on garbage input and relative log paths', () => {
    expect(run('not json', path.join(dir, 'b.jsonl')).status).toBe(0);
    expect(fs.existsSync(path.join(dir, 'b.jsonl'))).toBe(false);
    expect(run('{}', 'relative.jsonl').status).toBe(0);
  });
});

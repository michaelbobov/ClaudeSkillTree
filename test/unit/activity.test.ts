import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { groupBySession, isInside, lastUseBySkill, liveSessions, multiSessionStatus, parseActivityLog, parseHookInput, parseSessionEnd, sessionWho, summarizeUsage, usageFor, workspaceUsage, type ActivityEvent } from '../../src/shared/activity';
import { isGeneratedPrompt } from '../../src/mcp/suggest';

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
    expect(u.bySkill.pdf).toEqual({ count: 3, typed: 1, invoked: 2, sessions: 2, lastTs: '2026-01-02T09:00:00Z', lastSource: 'PreToolUse:Skill', lastSessionId: 's2', lastProject: null, lastAgentType: null });
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

  it('writes a subagent use with its agent, and a session end with only id and time', () => {
    const log = path.join(dir, 'c', 'activity.jsonl');
    for (const f of ['pre-tool-use-skill-subagent.json', 'session-end.json']) {
      const r = run(fs.readFileSync(`test/fixtures/hooks/${f}`, 'utf8'), log);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
    const [use, end] = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(use).toMatchObject({ source: 'PreToolUse:Skill', skill: 'sandbox-echo', agentType: 'general-purpose', agentId: 'a53be242a859492a6' });
    expect(Object.keys(end).sort()).toEqual(['kind', 'sessionId', 'ts', 'v']);
    const parsed = parseActivityLog(fs.readFileSync(log, 'utf8'));
    expect([parsed.events.length, parsed.skipped, Object.keys(parsed.ended)]).toEqual([1, 0, ['151a399d-0000-4000-8000-000000000000']]);
  });

  it('exits 0 on garbage input and relative log paths', () => {
    expect(run('not json', path.join(dir, 'b.jsonl')).status).toBe(0);
    expect(fs.existsSync(path.join(dir, 'b.jsonl'))).toBe(false);
    expect(run('{}', 'relative.jsonl').status).toBe(0);
  });
});

// ---- Several agents at once ------------------------------------------------------------------
// The subagent fixture has the field names and shape Claude Code sent in a real run (2026-11-08):
// a general-purpose subagent invoked a skill; session_id was the parent session's.

const ev = (o: Partial<ActivityEvent>): ActivityEvent => ({ v: 1, ts: '2026-01-01T10:00:00.000Z', source: 'PreToolUse:Skill', skill: 'pdf', sessionId: 's1', cwd: '/w/app', projectDir: '/w/app', hadArgs: false, ...o });

describe('subagents', () => {
  it('records which subagent invoked a skill, and nothing extra for the main conversation', () => {
    const sub = parseHookInput(fixture('pre-tool-use-skill-subagent'), {}, now)!;
    expect(sub).toMatchObject({ skill: 'sandbox-echo', sessionId: 'a8f4b9f8-4cec-4302-b0c6-8b7c5e3c95d9', agentId: 'a53be242a859492a6', agentType: 'general-purpose' });
    const main = parseHookInput(fixture('pre-tool-use-skill'), {}, now)!;
    expect(main).not.toHaveProperty('agentId');
    expect(main).not.toHaveProperty('agentType');
  });

  it('keeps the project and agent of each skill\'s last use', () => {
    const u = summarizeUsage([ev({ ts: '2026-01-01T09:00:00.000Z', cwd: '/w/old', projectDir: '/w/old' }), ev({ ts: '2026-01-01T10:00:00.000Z', agentType: 'Explore', agentId: 'a1' })]).bySkill.pdf;
    expect(u).toMatchObject({ count: 2, lastProject: '/w/app', lastAgentType: 'Explore' });
  });
});

describe('workspaceUsage', () => {
  it('matches folders exactly or by containment, not by name prefix', () => {
    expect(isInside('/w/app', ['/w/app'])).toBe(true);
    expect(isInside('/w/app/packages/ui', ['/w/app/'])).toBe(true);
    expect(isInside('/w/app2', ['/w/app'])).toBe(false);
    expect(isInside('C:\\w\\app\\src', ['C:\\w\\app'])).toBe(true);
    expect(isInside(null, ['/w/app'])).toBe(false);
  });

  it('counts a project-only skill name only in this workspace, other skills everywhere', () => {
    const events = [
      ev({ skill: 'deploy', projectDir: '/w/app', cwd: '/w/app' }),
      ev({ skill: 'deploy', projectDir: '/w/other', cwd: '/w/other', sessionId: 's2' }), // another project's own "deploy"
      ev({ skill: 'pdf', projectDir: '/w/other', cwd: '/w/other', sessionId: 's2' }), // a personal skill used elsewhere
    ];
    const { all, here } = workspaceUsage(events, { workspaceDirs: ['/w/app'], projectOnlyKeys: new Set(['deploy']) });
    expect(all.bySkill.deploy.count).toBe(1);
    expect(all.bySkill.pdf.count).toBe(1);
    expect(here.bySkill.deploy.count).toBe(1);
    expect(here.bySkill.pdf).toBeUndefined();
    expect(here.totalSessions).toBe(1);
  });
});

describe('workspaceUsage across symlinks', () => {
  it('matches a workspace opened at /var/… with uses Claude Code reported at /private/var/…', () => {
    const events = [ev({ skill: 'sandbox-echo', projectDir: '/private/var/folders/x/project', cwd: '/private/var/folders/x/project' })];
    const opts = { workspaceDirs: ['/var/folders/x/project'], projectOnlyKeys: new Set(['sandbox-echo']) };
    expect(workspaceUsage(events, opts).all.bySkill['sandbox-echo']).toBeUndefined(); // compared as given: no match
    const normalize = (d: string) => d.replace(/^\/var\//, '/private/var/');
    const { all, here } = workspaceUsage(events, { ...opts, normalize });
    expect(all.bySkill['sandbox-echo'].count).toBe(1);
    expect(here.bySkill['sandbox-echo'].count).toBe(1);
  });
});

describe('liveSessions', () => {
  const at = (min: number) => new Date(Date.parse('2026-01-01T10:00:00.000Z') + min * 60_000).toISOString();
  const nowMs = Date.parse('2026-01-01T10:00:00.000Z');

  it('lists sessions with use in the last 10 minutes, newest first, with who used what', () => {
    const live = liveSessions(
      [
        ev({ sessionId: 'a', ts: at(-1), skill: 'pdf', agentType: 'general-purpose', agentId: 'x' }),
        ev({ sessionId: 'a', ts: at(-3), skill: 'animate' }),
        ev({ sessionId: 'b', ts: at(-2), skill: 'xlsx', projectDir: '/w/data', cwd: '/w/data' }),
        ev({ sessionId: 'c', ts: at(-11), skill: 'docx' }), // too old
      ],
      nowMs,
    );
    expect(live.map((l) => l.sessionId)).toEqual(['a', 'b']);
    expect(live[0]).toMatchObject({ project: '/w/app', lastSkill: 'pdf', lastAgentType: 'general-purpose', skills: ['pdf', 'animate'], agentTypes: ['general-purpose'], main: true, count: 2 });
    expect(live[1]).toMatchObject({ project: '/w/data', skills: ['xlsx'], agentTypes: [], main: true });
  });

  it('keeps typed slash commands apart from Claude\'s own skill calls (shapes from a real 4-session run)', () => {
    const live = liveSessions(
      [
        ev({ sessionId: 't', ts: at(-1), skill: 'alpha-check', source: 'UserPromptExpansion' }),
        ev({ sessionId: 'm', ts: at(-2), skill: 'beta-check', source: 'UserPromptExpansion' }),
        ev({ sessionId: 'm', ts: at(-3), skill: 'delta-check' }),
        ev({ sessionId: 's', ts: at(-4), skill: 'gamma-check', agentType: 'general-purpose', agentId: 'x' }),
        ev({ sessionId: 'c', ts: at(-5), skill: 'beta-check' }),
        ev({ sessionId: 'c', ts: at(-6), skill: 'pdf', agentType: 'Explore', agentId: 'y' }),
      ],
      nowMs,
    );
    expect(live.map((l) => [l.sessionId, sessionWho(l)])).toEqual([
      ['t', 'typed'],
      ['m', 'typed + Claude'],
      ['s', 'general-purpose subagent'],
      ['c', 'Claude + 1 subagent'],
    ]);
    expect(live[0]).toMatchObject({ typed: true, main: false });
  });

  it('says "N sessions" in the status bar only when there is more than one', () => {
    const one = liveSessions([ev({ ts: at(-1) })], nowMs);
    expect(multiSessionStatus(one)).toBeNull();
    const three = liveSessions([ev({ sessionId: 'a', ts: at(-1), skill: 'pdf' }), ev({ sessionId: 'b', ts: at(-2), skill: 'animate' }), ev({ sessionId: 'c', ts: at(-3), skill: 'pdf' })], nowMs);
    expect(multiSessionStatus(three)).toBe('3 sessions · pdf, animate');
  });
});

describe('isGeneratedPrompt', () => {
  it('recognizes a subagent reporting back (observed shape) and leaves typed prompts alone', () => {
    expect(isGeneratedPrompt('<task-notification>\n<task-id>a631ab6d36ee58f13</task-id>\n<status>completed</status>\n</task-notification>')).toBe(true);
    expect(isGeneratedPrompt('  <teammate-message from="lead">check the build</teammate-message>\n')).toBe(true);
    expect(isGeneratedPrompt('Add an entrance animation to the modal')).toBe(false);
    expect(isGeneratedPrompt('<Modal> needs an exit animation, see src/Modal.tsx')).toBe(false);
  });
});

describe('session ends', () => {
  it('records only the session id and time of a SessionEnd (real payload shape), and nothing else', () => {
    expect(parseSessionEnd(fixture('session-end'), now)).toEqual({ v: 1, kind: 'session-end', ts: '2026-01-01T10:00:00.000Z', sessionId: '151a399d-0000-4000-8000-000000000000' });
    expect(parseSessionEnd(fixture('pre-tool-use-skill'), now)).toBeNull();
    expect(parseHookInput(fixture('session-end'), {}, now)).toBeNull();
  });

  it('reads session ends from the log without counting them as skill uses or bad lines', () => {
    const end = JSON.stringify({ v: 1, kind: 'session-end', ts: '2026-01-01T10:05:00.000Z', sessionId: 's1' });
    const use = JSON.stringify(ev({ ts: '2026-01-01T10:00:00.000Z' }));
    const r = parseActivityLog([use, end, 'not json'].join('\n'));
    expect(r.events).toHaveLength(1);
    expect(r.skipped).toBe(1);
    expect(r.ended).toEqual({ s1: '2026-01-01T10:05:00.000Z' });
  });

  it('leaves ended sessions out of Live unless they used a skill after ending was reported', () => {
    const nowMs = Date.parse('2026-01-01T10:06:00.000Z');
    const events = [ev({ sessionId: 's1', ts: '2026-01-01T10:00:00.000Z' }), ev({ sessionId: 's2', ts: '2026-01-01T10:01:00.000Z' })];
    expect(liveSessions(events, nowMs, undefined, { s1: '2026-01-01T10:05:00.000Z' }).map((l) => l.sessionId)).toEqual(['s2']);
    // A resumed session (same id, new use after the recorded end) is live again.
    const resumed = [ev({ sessionId: 's1', ts: '2026-01-01T10:05:30.000Z' }), ...events];
    expect(liveSessions(resumed, nowMs, undefined, { s1: '2026-01-01T10:05:00.000Z' }).map((l) => l.sessionId)).toEqual(['s1', 's2']);
  });
});


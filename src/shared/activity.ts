// Activity events captured by SkillTree's opt-in Claude Code hooks. Pure (no VS Code API).
// See docs/HOOKS_NOTES.md for the documented hook payloads this is based on.
//
// Privacy: only the fields below are kept. Prompt text, command arguments, tool arguments and
// transcript paths are never stored.

import { parseNavTarget, type NavTarget } from './nav';

export type CaptureSource = 'PreToolUse:Skill' | 'UserPromptExpansion';

export const CAPTURE_LABELS: Record<CaptureSource, string> = {
  'PreToolUse:Skill': 'Claude invoked (Skill tool)',
  UserPromptExpansion: 'Typed /command',
};

export interface ActivityEvent {
  v: 1;
  /** ISO timestamp when the hook ran. */
  ts: string;
  source: CaptureSource;
  /** Skill or command name as reported by Claude Code; null if the payload did not include one. */
  skill: string | null;
  sessionId: string | null;
  cwd: string | null;
  projectDir: string | null;
  /** UserPromptExpansion only: where the command came from (e.g. "plugin"), as reported. */
  commandSource?: string | null;
  /** Whether the invocation had arguments (the arguments themselves are not stored). */
  hadArgs: boolean;
  /** Diagnostics when the skill name was missing: key names of tool_input (values never stored). */
  inputKeys?: string[];
  /**
   * Set when the skill was invoked inside a subagent or agent-team teammate: Claude Code's
   * `agent_id` and `agent_type` (e.g. "general-purpose", "Explore"). The session id is then the
   * parent session's. Absent for the main conversation and in logs written before this field.
   */
  agentId?: string | null;
  agentType?: string | null;
}

const MAX_FIELD = 500;

function s(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_FIELD) : null;
}

/**
 * Converts one hook stdin payload into an event, or null when it is not a skill invocation
 * (other tools, MCP prompts, malformed input).
 */
export function parseHookInput(raw: unknown, env: { projectDir?: string } = {}, now: () => Date = () => new Date()): ActivityEvent | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const base = {
    v: 1 as const,
    ts: now().toISOString(),
    sessionId: s(p.session_id),
    cwd: s(p.cwd),
    projectDir: env.projectDir ? env.projectDir.slice(0, MAX_FIELD) : null,
    // Only present inside subagents; omitted otherwise to keep log lines short.
    ...(s(p.agent_id) || s(p.agent_type) ? { agentId: s(p.agent_id), agentType: s(p.agent_type) } : {}),
  };
  if (p.hook_event_name === 'PreToolUse') {
    if (p.tool_name !== 'Skill') return null;
    const input = typeof p.tool_input === 'object' && p.tool_input !== null ? (p.tool_input as Record<string, unknown>) : {};
    const skill = s(input.skill) ?? s(input.command) ?? s(input.name);
    const args = input.args ?? input.arguments;
    const ev: ActivityEvent = { ...base, source: 'PreToolUse:Skill', skill: skill ? skill.replace(/^\//, '') : null, hadArgs: typeof args === 'string' ? args.trim() !== '' : args !== undefined && args !== null };
    if (!skill) ev.inputKeys = Object.keys(input).slice(0, 20).map((k) => k.slice(0, 50));
    return ev;
  }
  if (p.hook_event_name === 'UserPromptExpansion') {
    if (p.expansion_type !== undefined && p.expansion_type !== 'slash_command') return null;
    const name = s(p.command_name);
    return {
      ...base,
      source: 'UserPromptExpansion',
      skill: name ? name.replace(/^\//, '') : null,
      commandSource: s(p.command_source),
      hadArgs: typeof p.command_args === 'string' ? p.command_args.trim() !== '' : false,
    };
  }
  return null;
}

/** A Claude Code session ended (SessionEnd hook): only its id and the time. Not a skill use. */
export interface SessionEndRecord {
  v: 1;
  kind: 'session-end';
  ts: string;
  sessionId: string;
}

/** Converts a SessionEnd hook payload into a record, or null for anything else. */
export function parseSessionEnd(raw: unknown, now: () => Date = () => new Date()): SessionEndRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const sessionId = s(p.session_id);
  if (p.hook_event_name !== 'SessionEnd' || !sessionId) return null;
  return { v: 1, kind: 'session-end', ts: now().toISOString(), sessionId };
}

function isSessionEnd(v: unknown): v is SessionEndRecord {
  const e = v as Record<string, unknown>;
  return typeof v === 'object' && v !== null && e.v === 1 && e.kind === 'session-end' && typeof e.sessionId === 'string' && typeof e.ts === 'string' && !Number.isNaN(Date.parse(e.ts));
}

export function isActivityEvent(v: unknown): v is ActivityEvent {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return e.v === 1 && typeof e.ts === 'string' && !Number.isNaN(Date.parse(e.ts)) && (e.source === 'PreToolUse:Skill' || e.source === 'UserPromptExpansion');
}

/**
 * Parses JSONL log text, skipping malformed lines. Newest first, at most `limit` events. Session-end
 * lines are not events: `ended` maps each ended session id to when it ended.
 */
export function parseActivityLog(text: string, limit = 2000): { events: ActivityEvent[]; skipped: number; ended: Record<string, string> } {
  const events: ActivityEvent[] = [];
  const ended: Record<string, string> = {};
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (isActivityEvent(v)) events.push(v);
      else if (isSessionEnd(v)) {
        if (!ended[v.sessionId] || v.ts > ended[v.sessionId]) ended[v.sessionId] = v.ts;
      } else skipped++;
    } catch {
      skipped++;
    }
  }
  events.sort((a, b) => b.ts.localeCompare(a.ts));
  return { events: events.slice(0, limit), skipped, ended };
}

export interface SessionGroup {
  sessionId: string | null;
  project: string | null;
  start: string;
  end: string;
  events: ActivityEvent[];
  skills: string[];
}

/** Groups events by session (unknown sessions grouped together), newest session first. */
export function groupBySession(events: readonly ActivityEvent[]): SessionGroup[] {
  const map = new Map<string, SessionGroup>();
  for (const e of events) {
    const key = e.sessionId ?? '(unknown session)';
    let g = map.get(key);
    if (!g) {
      g = { sessionId: e.sessionId, project: e.projectDir ?? e.cwd, start: e.ts, end: e.ts, events: [], skills: [] };
      map.set(key, g);
    }
    g.events.push(e);
    if (e.ts < g.start) g.start = e.ts;
    if (e.ts > g.end) g.end = e.ts;
    if (!g.project) g.project = e.projectDir ?? e.cwd;
    const name = e.skill ?? '(unknown skill)';
    if (!g.skills.includes(name)) g.skills.push(name);
  }
  const groups = [...map.values()];
  for (const g of groups) g.events.sort((a, b) => b.ts.localeCompare(a.ts));
  return groups.sort((a, b) => b.end.localeCompare(a.end));
}

/** Most recent event per skill name (for the Skill Tree inspector). */
export function lastUseBySkill(events: readonly ActivityEvent[]): Map<string, ActivityEvent> {
  const out = new Map<string, ActivityEvent>();
  for (const e of events) {
    if (!e.skill) continue;
    const key = e.skill.toLowerCase();
    const prev = out.get(key);
    if (!prev || e.ts > prev.ts) out.set(key, e);
  }
  return out;
}

// ---- Usage summary for the Skill Tree ----------------------------------------------------------

export interface SkillUsage {
  /** Recorded invocations (both capture sources). */
  count: number;
  /** Typed as a /command (UserPromptExpansion). */
  typed: number;
  /** Invoked by Claude through the Skill tool (PreToolUse). */
  invoked: number;
  /** Distinct sessions with at least one recorded use. */
  sessions: number;
  lastTs: string;
  lastSource: CaptureSource;
  lastSessionId: string | null;
  /** Project folder (Claude Code's project dir, else the working directory) of the last use. */
  lastProject?: string | null;
  /** Subagent type of the last use; null when the main conversation used it. */
  lastAgentType?: string | null;
}

export interface CoUsage {
  /** Lower-case recorded skill names, a < b. */
  a: string;
  b: string;
  /** Sessions in which both were recorded. */
  sessions: number;
}

export interface UsageSummary {
  totalEvents: number;
  totalSessions: number;
  /** Keyed by lower-case skill name exactly as Claude Code reported it (e.g. "pdf" or "plugin:pdf"). */
  bySkill: Record<string, SkillUsage>;
  /** Skills recorded in the same session, most shared sessions first. Co-occurrence only, not causation. */
  coUsage: CoUsage[];
}

/** Aggregates recorded events. Events without a skill name count towards totals only. */
export function summarizeUsage(events: readonly ActivityEvent[], maxPairs = 500): UsageSummary {
  const bySkill: Record<string, SkillUsage> = {};
  const sessionsBySkill = new Map<string, Set<string>>();
  const skillsBySession = new Map<string, Set<string>>();
  for (const e of events) {
    const session = e.sessionId ?? '';
    if (e.sessionId) {
      if (!skillsBySession.has(session)) skillsBySession.set(session, new Set());
    }
    if (!e.skill) continue;
    const key = e.skill.toLowerCase();
    const u = (bySkill[key] ??= { count: 0, typed: 0, invoked: 0, sessions: 0, lastTs: e.ts, lastSource: e.source, lastSessionId: e.sessionId, lastProject: projectOf(e), lastAgentType: e.agentType ?? null });
    u.count++;
    if (e.source === 'UserPromptExpansion') u.typed++;
    else u.invoked++;
    if (e.ts >= u.lastTs) {
      u.lastTs = e.ts;
      u.lastSource = e.source;
      u.lastSessionId = e.sessionId;
      u.lastProject = projectOf(e);
      u.lastAgentType = e.agentType ?? null;
    }
    if (e.sessionId) {
      if (!sessionsBySkill.has(key)) sessionsBySkill.set(key, new Set());
      sessionsBySkill.get(key)!.add(session);
      skillsBySession.get(session)!.add(key);
    }
  }
  for (const [key, sessions] of sessionsBySkill) bySkill[key].sessions = sessions.size;

  const pairs = new Map<string, CoUsage>();
  for (const names of skillsBySession.values()) {
    const list = [...names].sort();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const id = `${list[i]}\u0000${list[j]}`;
        const p = pairs.get(id) ?? { a: list[i], b: list[j], sessions: 0 };
        p.sessions++;
        pairs.set(id, p);
      }
    }
  }
  const coUsage = [...pairs.values()].sort((x, y) => y.sessions - x.sessions || x.a.localeCompare(y.a) || x.b.localeCompare(y.b)).slice(0, maxPairs);
  return { totalEvents: events.length, totalSessions: skillsBySession.size, bySkill, coUsage };
}

/** The project a use belongs to: Claude Code's project dir, else the hook's working directory. */
export function projectOf(e: Pick<ActivityEvent, 'projectDir' | 'cwd'>): string | null {
  return e.projectDir ?? e.cwd ?? null;
}

/** Last path segment, for labels ("/a/b/my-app" → "my-app"). */
export function folderName(dir: string | null | undefined): string | null {
  return dir ? dir.split(/[\\/]/).filter(Boolean).pop() ?? dir : null;
}

/** Whether `dir` is one of `roots` or inside one. */
export function isInside(dir: string | null, roots: readonly string[]): boolean {
  if (!dir) return false;
  const clean = (p: string) => p.replace(/[\\/]+$/, '');
  const d = clean(dir);
  return roots.some((r) => {
    const root = clean(r);
    return d === root || d.startsWith(`${root}/`) || d.startsWith(`${root}\\`);
  });
}

/**
 * Usage for the Skill Tree of one VS Code window.
 * - `all`: every recorded use, except that a skill which exists only as a project skill here counts
 *   only uses from this workspace (another project's skill with the same name is a different skill).
 * - `here`: only uses recorded in this workspace's folders.
 */
export function workspaceUsage(
  events: readonly ActivityEvent[],
  opts: {
    workspaceDirs: readonly string[];
    projectOnlyKeys: ReadonlySet<string>;
    /**
     * Applied to both sides before comparing. The extension resolves symlinks (Claude Code reports
     * /private/var/… where VS Code has /var/…) and ignores case where the file system does.
     */
    normalize?: (dir: string) => string;
  },
): { all: UsageSummary; here: UsageSummary } {
  const norm = opts.normalize ?? ((d: string) => d);
  const roots = opts.workspaceDirs.map(norm);
  const inWorkspace = (e: ActivityEvent) => {
    const dir = projectOf(e);
    return isInside(dir && norm(dir), roots);
  };
  const here = events.filter(inWorkspace);
  const all = events.filter((e) => !e.skill || !opts.projectOnlyKeys.has(e.skill.toLowerCase()) || inWorkspace(e));
  return { all: summarizeUsage(all), here: summarizeUsage(here) };
}

/** A Claude Code session with recorded skill use in the last few minutes. */
export interface LiveSession {
  sessionId: string | null;
  project: string | null;
  lastTs: string;
  lastSkill: string | null;
  /** Subagent type of the last use; null for the main conversation. */
  lastAgentType: string | null;
  /** Distinct skills used in the window, newest first (as reported, lower-case). */
  skills: string[];
  /** Distinct subagent types seen in the window (the main conversation is not listed). */
  agentTypes: string[];
  /** Whether Claude, in the main conversation, invoked a skill in the window. */
  main: boolean;
  /** Whether the user typed a skill's slash command in the window. */
  typed: boolean;
  count: number;
}

/**
 * Sessions with recorded skill use in the last `windowMs` (default 10 minutes), newest first. A
 * session that ended (SessionEnd recorded after its last use) is left out; sessions that end without
 * Claude Code reporting it drop out when the window passes.
 */
export function liveSessions(events: readonly ActivityEvent[], nowMs: number, windowMs = 10 * 60 * 1000, ended: Readonly<Record<string, string>> = {}): LiveSession[] {
  const from = nowMs - windowMs;
  const map = new Map<string, LiveSession>();
  const recent = events.filter((e) => Date.parse(e.ts) >= from && Date.parse(e.ts) <= nowMs + 60_000).sort((a, b) => b.ts.localeCompare(a.ts));
  for (const e of recent) {
    const key = e.sessionId ?? '(unknown session)';
    let l = map.get(key);
    if (!l) {
      l = { sessionId: e.sessionId, project: projectOf(e), lastTs: e.ts, lastSkill: e.skill, lastAgentType: e.agentType ?? null, skills: [], agentTypes: [], main: false, typed: false, count: 0 };
      map.set(key, l);
    }
    l.count++;
    if (!l.project) l.project = projectOf(e);
    const name = e.skill?.toLowerCase();
    if (name && !l.skills.includes(name)) l.skills.push(name);
    if (e.agentType) {
      if (!l.agentTypes.includes(e.agentType)) l.agentTypes.push(e.agentType);
    } else if (e.source === 'UserPromptExpansion') l.typed = true;
    else l.main = true;
  }
  return [...map.values()].filter((l) => !(l.sessionId && ended[l.sessionId] && ended[l.sessionId] >= l.lastTs)).sort((a, b) => b.lastTs.localeCompare(a.lastTs));
}

/**
 * Status bar text when several sessions are using skills at once ("3 sessions · pdf, animate"),
 * or null for zero or one session (the newest use is shown instead).
 */
export function multiSessionStatus(live: readonly LiveSession[]): string | null {
  if (live.length < 2) return null;
  const skills = live.map((l) => l.lastSkill).filter((x): x is string => !!x);
  const shown = [...new Set(skills)].slice(0, 2);
  return `${live.length} sessions${shown.length ? ` · ${shown.join(', ')}` : ''}`;
}

/**
 * Who used skills in a live session, short: "Claude", "typed", "typed + Claude", "Explore subagent",
 * "Claude + 1 subagent", "2 subagents". A typed slash command is the user's choice, not Claude's.
 */
export function sessionWho(l: Pick<LiveSession, 'main' | 'typed' | 'agentTypes'>): string {
  const n = l.agentTypes.length;
  const parts = [l.typed ? 'typed' : '', l.main ? 'Claude' : ''].filter(Boolean);
  if (n === 0) return parts.join(' + ') || 'Claude';
  const subs = n === 1 ? `${l.agentTypes[0]} subagent` : `${n} subagents`;
  return parts.length ? `${parts.join(' + ')} + ${n} subagent${n === 1 ? '' : 's'}` : subs;
}

/** "Claude", "Claude (Explore subagent)", or "a subagent" when only the id is known. */
export function whoLabel(agentType: string | null | undefined, source: CaptureSource): string {
  if (source === 'UserPromptExpansion') return 'you (typed)';
  return agentType ? `Claude (${agentType} subagent)` : 'Claude';
}

/**
 * The names Claude Code may report for a skill, most specific first: its full command without the
 * slash (e.g. "anthropic-skills:pdf", "frontend:lint") and its bare name.
 */
export function usageKeys(skill: { name: string; command: string }): string[] {
  const keys = [skill.command.replace(/^\//, '').toLowerCase(), skill.name.toLowerCase()];
  return keys.filter((k, i) => k && keys.indexOf(k) === i);
}

/** The usage recorded for a skill (matched by command name, then bare name), if any. */
export function usageFor(summary: Pick<UsageSummary, 'bySkill'> | undefined, skill: { name: string; command: string }): SkillUsage | undefined {
  if (!summary) return undefined;
  for (const k of usageKeys(skill)) if (summary.bySkill[k]) return summary.bySkill[k];
  return undefined;
}

// ---- Activity panel contract -----------------------------------------------------------------

export interface ActivityViewState {
  enabled: boolean;
  scope: 'user' | 'project' | null;
  settingsFile: string | null;
  logFile: string;
  installedAt: string | null;
  error?: string;
  skippedLines: number;
  sessions: SessionGroup[];
  total: number;
}

export type ActivityHostMessage = { type: 'state'; state: ActivityViewState };

export type ActivityWebviewMessage =
  | { type: 'navigate'; to: NavTarget }
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'enable' }
  | { type: 'disable' }
  | { type: 'clearLog' }
  | { type: 'openSettings' }
  | { type: 'rendered'; count: number };

export function parseActivityMessage(raw: unknown): ActivityWebviewMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
    case 'refresh':
    case 'enable':
    case 'disable':
    case 'clearLog':
    case 'openSettings':
      return { type: m.type };
    case 'rendered':
      return typeof m.count === 'number' && Number.isInteger(m.count) && m.count >= 0 ? { type: 'rendered', count: m.count } : null;
    case 'navigate': {
      const to = parseNavTarget(m.to);
      return to ? { type: 'navigate', to } : null;
    }
    default:
      return null;
  }
}


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

export function isActivityEvent(v: unknown): v is ActivityEvent {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return e.v === 1 && typeof e.ts === 'string' && !Number.isNaN(Date.parse(e.ts)) && (e.source === 'PreToolUse:Skill' || e.source === 'UserPromptExpansion');
}

/** Parses JSONL log text, skipping malformed lines. Newest first, at most `limit` events. */
export function parseActivityLog(text: string, limit = 2000): { events: ActivityEvent[]; skipped: number } {
  const events: ActivityEvent[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (isActivityEvent(v)) events.push(v);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  events.sort((a, b) => b.ts.localeCompare(a.ts));
  return { events: events.slice(0, limit), skipped };
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
    const u = (bySkill[key] ??= { count: 0, typed: 0, invoked: 0, sessions: 0, lastTs: e.ts, lastSource: e.source, lastSessionId: e.sessionId });
    u.count++;
    if (e.source === 'UserPromptExpansion') u.typed++;
    else u.invoked++;
    if (e.ts >= u.lastTs) {
      u.lastTs = e.ts;
      u.lastSource = e.source;
      u.lastSessionId = e.sessionId;
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


import type { ActivityEvent, UsageSummary } from './activity';

// Data model shared by the extension host and the webview.
// Everything here must be plain JSON (it crosses the postMessage boundary).

export const CATEGORIES = [
  'Design',
  'Frontend',
  'Backend',
  'Data',
  'Security',
  'Testing',
  'Debugging',
  'Automation',
  'Agents',
  'Documentation',
  'Business',
  'Other',
] as const;

export type Category = (typeof CATEGORIES)[number];

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

/**
 * Where a skill was found.
 * - project:  <workspace folder>/.claude/skills/<name>/SKILL.md
 * - nested:   <workspace folder>/<subdir>/.claude/skills/<name>/SKILL.md
 * - personal: ~/.claude/skills/<name>/SKILL.md
 * - synced:   ~/.claude/skills/synced/<bucket>/<name>/SKILL.md (claude.ai account, managed by Claude)
 * - managed:  enterprise managed settings directory (read-only)
 */
export type SkillSource = 'project' | 'nested' | 'personal' | 'synced' | 'managed';

export const SOURCE_LABELS: Record<SkillSource, string> = {
  project: 'Project',
  nested: 'Nested',
  personal: 'Personal',
  synced: 'Synced',
  managed: 'Managed',
};

/** How the effective category was chosen. Shown in the UI so auto-assignment is never presented as fact. */
export type CategorySource = 'user' | 'frontmatter' | 'inferred' | 'default';

export type IssueLevel = 'error' | 'warning' | 'info';

export interface SkillIssue {
  level: IssueLevel;
  message: string;
}

export interface SupportingFile {
  /** Path relative to the skill directory, POSIX separators. */
  path: string;
  size: number;
  kind: 'markdown' | 'script' | 'executable' | 'symlink' | 'other';
}

export interface FrontmatterField {
  key: string;
  /** Display string (objects/arrays are rendered as compact YAML-ish text). */
  value: string;
}

export interface SkillRecord {
  /** Stable key, used for preferences and node ids. Never contains the absolute home path. */
  id: string;
  /** Effective name: frontmatter `name`, or the directory name. */
  name: string;
  dirName: string;
  /** How a user would invoke it, e.g. "/deploy", "/apps/web:deploy", "/anthropic-skills:pdf". */
  command: string;
  description: string;
  descriptionSource: 'frontmatter' | 'body' | 'none';
  source: SkillSource;
  readOnly: boolean;
  /** Human label of the root, e.g. workspace folder name or "~/.claude/skills". */
  rootLabel: string;
  /** Absolute directory and SKILL.md path (local only; never sent anywhere but the local webview). */
  dir: string;
  file: string;
  /** Short path for display: workspace-relative or "~/"-relative. */
  displayPath: string;
  fields: FrontmatterField[];
  issues: SkillIssue[];
  supportingFiles: SupportingFile[];
  supportingFilesTruncated: boolean;
  /** Frontmatter declares hooks (they run when the skill is invoked). */
  declaresHooks: boolean;
  /** Category requested by frontmatter (`category` or `metadata.category`), if it matches a known category. */
  frontmatterCategory?: Category;
  modifiedAt: number;
  sizeBytes: number;
  /** If another skill with the same command name takes precedence in Claude Code, its id. */
  shadowedBy?: string;
  /** Other skills that share this effective name (any source). */
  sameNameAs: string[];
  /** Present when SkillTree installed this skill from the catalog (`.skilltree-source.json`). */
  installedFrom?: {
    id: string;
    owner: string;
    repo: string;
    path: string;
    commitSha: string;
    sourceUrl: string;
    installedAt: string;
  };
}

/** A skill with organization (category) resolved. This is what the UI renders. */
export interface OrganizedSkill extends SkillRecord {
  category: Category;
  categorySource: CategorySource;
}

export interface ScanRootStatus {
  source: SkillSource;
  label: string;
  /** Display path (workspace-relative or ~-relative). */
  displayPath: string;
  exists: boolean;
  skillCount: number;
  /** Folders that were skipped, with a reason. */
  skipped: { name: string; reason: string }[];
  error?: string;
}

export interface NodePosition {
  x: number;
  y: number;
}

export interface SkillTreeState {
  status: 'loading' | 'ready' | 'error';
  error?: string;
  workspaceName: string | null;
  workspaceTrusted: boolean;
  skills: OrganizedSkill[];
  roots: ScanRootStatus[];
  scannedAt: number | null;
  positions: Record<string, NodePosition>;
  collapsed: Category[];
  /** Observed activity (only when the user opted in and hooks recorded events). */
  activity?: ActivitySummaryState;
}

/** Recorded skill use sent to the Skill Tree. Only events captured by SkillTree's opt-in hooks. */
export interface ActivitySummaryState extends UsageSummary {
  enabled: boolean;
  /** When tracking was enabled; nothing before this time is known. */
  since: string | null;
  /** The same counts limited to uses recorded in this window's workspace folders (absent without a folder). */
  here?: UsageSummary;
  /** Events from the last few minutes, newest first, for the Live strip (sessions working now). */
  recent?: ActivityEvent[];
  /** Session id → end time, for sessions Claude Code reported as ended (left out of the Live strip). */
  ended?: Record<string, string>;
}

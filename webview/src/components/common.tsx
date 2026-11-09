import { folderName } from '@shared/activity';
import type { Category, OrganizedSkill, SkillIssue } from '@shared/types';
import type { SkillUsage } from '@shared/activity';
import { SOURCE_LABELS } from '@shared/types';

export function CategoryDot({ category }: { category: Category }) {
  return <span className={`cat-dot cat-${category.toLowerCase()}`} aria-hidden />;
}

/** One-line scope/source text for a skill node or row. */
export function sourceText(s: OrganizedSkill): string {
  switch (s.source) {
    case 'project':
      return 'Project';
    case 'nested':
      return `Nested · ${s.rootLabel.split('/').slice(1).join('/')}`;
    case 'personal':
      return 'Personal';
    case 'synced':
      return 'Synced · read-only';
    case 'managed':
      return 'Managed · read-only';
    default:
      return SOURCE_LABELS[s.source];
  }
}

export function scopeSentence(s: OrganizedSkill): string {
  switch (s.source) {
    case 'project':
      return `Installed in this project (${s.rootLabel})`;
    case 'nested':
      return `Installed in a nested folder (${s.rootLabel})`;
    case 'personal':
      return 'Installed globally (personal, all projects)';
    case 'synced':
      return 'Synced from your claude.ai account';
    case 'managed':
      return 'Managed by your organization';
    default:
      return SOURCE_LABELS[s.source];
  }
}

export function IssueIcon({ issue }: { issue: SkillIssue }) {
  const icon = issue.level === 'error' ? 'error' : issue.level === 'warning' ? 'warning' : 'info';
  return <i className={`codicon codicon-${icon} issue-icon is-${issue.level}`} aria-label={issue.level} />;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Codicon for where a skill lives (the text is in sourceText/scopeSentence). */
export function sourceIcon(s: OrganizedSkill): string {
  switch (s.source) {
    case 'project':
      return 'folder';
    case 'nested':
      return 'folder-library';
    case 'personal':
      return 'account';
    case 'synced':
      return 'cloud';
    case 'managed':
      return 'organization';
    default:
      return 'circle-small';
  }
}

/** Compact relative time for dense rows: "now", "12m", "3h", "5d", then a date. */
export function shortAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function longDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Tooltip for a recorded-usage marker. Says exactly what was recorded and nothing more. */
export function usageTitle(u: SkillUsage): string {
  const parts = [`${u.count} recorded use${u.count === 1 ? '' : 's'}`];
  if (u.invoked) parts.push(`${u.invoked} by Claude`);
  if (u.typed) parts.push(`${u.typed} typed`);
  const where = u.lastProject ? ` in ${folderName(u.lastProject)}` : '';
  const who = u.lastSource === 'UserPromptExpansion' ? ', typed' : u.lastAgentType ? `, by a ${u.lastAgentType} subagent` : ', by Claude';
  return `${parts.join(' · ')}\nLast: ${longDate(u.lastTs)}${where}${who}\nRecorded by SkillTree's opt-in hooks.`;
}

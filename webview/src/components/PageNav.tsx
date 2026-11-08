import type { NavTarget } from '@shared/nav';

const TABS: { id: NavTarget; label: string; icon: string }[] = [
  { id: 'tree', label: 'Skill Tree', icon: 'type-hierarchy' },
  { id: 'marketplace', label: 'Marketplace', icon: 'extensions' },
  { id: 'activity', label: 'Activity', icon: 'pulse' },
];

/**
 * The three SkillTree editors as sections of one tool: always reachable from each other, styled like
 * VS Code's own panel tabs. Each tab opens (or brings forward) that editor.
 */
export function PageNav({ current, onNavigate }: { current: NavTarget; onNavigate(to: NavTarget): void }) {
  return (
    <nav className="pagenav" aria-label="SkillTree sections">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`pagenav-tab ${t.id === current ? 'is-current' : ''}`}
          aria-current={t.id === current ? 'page' : undefined}
          title={t.id === current ? t.label : `Open ${t.label}`}
          onClick={() => t.id !== current && onNavigate(t.id)}
        >
          <i className={`codicon codicon-${t.icon}`} aria-hidden />
          <span className="pagenav-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

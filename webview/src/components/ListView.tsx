import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import type { ActivitySummaryState, OrganizedSkill } from '@shared/types';
import { groupByCategory, skillCompare, type SkillOrder } from '@shared/graph';
import { usageFor, usageKeys } from '@shared/activity';
import { unusedDays } from '@shared/recommend';
import { CategoryDot, shortAgo, sourceText, usageTitle } from './common';

interface ListViewProps {
  skills: OrganizedSkill[];
  selectedId: string | null;
  onSelect(id: string | null): void;
  onOpen(id: string): void;
  activity?: ActivitySummaryState;
  order: SkillOrder;
  /** Skills of the Live session picked in the Live strip; other rows are dimmed. */
  sessionKeys?: ReadonlySet<string> | null;
}

/** Keyboard-accessible alternative to the graph: grouped rows, arrow keys move, Enter opens SKILL.md. */
export function ListView({ skills, selectedId, onSelect, onOpen, activity, order, sessionKeys }: ListViewProps) {
  const groups = useMemo(() => groupByCategory(skills, skillCompare(order, activity)), [skills, order, activity]);
  const flat = useMemo(() => groups.flatMap((g) => g.skills), [groups]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-skill-id="${CSS.escape(selectedId)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const idx = flat.findIndex((s) => s.id === selectedId);
      const move = (to: number) => {
        e.preventDefault();
        const s = flat[Math.max(0, Math.min(flat.length - 1, to))];
        if (s) onSelect(s.id);
      };
      switch (e.key) {
        case 'ArrowDown':
          return move(idx + 1);
        case 'ArrowUp':
          return move(idx === -1 ? 0 : idx - 1);
        case 'Home':
          return move(0);
        case 'End':
          return move(flat.length - 1);
        case 'Enter':
          if (selectedId) {
            e.preventDefault();
            onOpen(selectedId);
          }
          return;
        case 'Escape':
          if (selectedId) {
            e.preventDefault();
            onSelect(null);
          }
      }
    },
    [flat, selectedId, onSelect, onOpen],
  );

  const activeId = selectedId && flat.some((s) => s.id === selectedId) ? `row-${selectedId}` : undefined;

  return (
    <div
      className="list"
      ref={listRef}
      role="listbox"
      aria-label="Skills"
      tabIndex={0}
      aria-activedescendant={activeId}
      onKeyDown={onKeyDown}
    >
      {groups.map((g) => (
        <div key={g.category} role="group" aria-label={`${g.category}, ${g.skills.length} skills`}>
          <div className="list-group" aria-hidden>
            <CategoryDot category={g.category} />
            <span>{g.category}</span>
            <span className="list-count">{g.skills.length}</span>
          </div>
          {g.skills.map((s) => {
            const issue = s.issues.find((i) => i.level === 'error') ?? s.issues.find((i) => i.level === 'warning');
            const usage = usageFor(activity, s);
            return (
              <div
                key={s.id}
                id={`row-${s.id}`}
                data-skill-id={s.id}
                role="option"
                aria-selected={s.id === selectedId}
                className={`list-row ${s.id === selectedId ? 'is-selected' : ''} ${s.shadowedBy ? 'is-shadowed' : ''} ${sessionKeys ? (usageKeys(s).some((k) => sessionKeys.has(k)) ? 'is-in-session' : 'is-dimmed') : ''}`}
                onClick={() => onSelect(s.id)}
                onDoubleClick={() => onOpen(s.id)}
              >
                <span className="list-name">{s.name}</span>
                <span className="list-source">{sourceText(s)}</span>
                <span className="list-desc">{s.description || <em>No description</em>}</span>
                <span className="list-usage" title={usage ? usageTitle(usage) : undefined}>
                  {usage ? `${usage.count}× · ${shortAgo(usage.lastTs)}` : order !== 'name' && unusedDays(s, activity) !== null ? 'unused' : ''}
                </span>
                <span className="list-path mono">{s.displayPath}</span>
                <span className="list-flag">
                  {issue && (
                    <i
                      className={`codicon codicon-${issue.level === 'error' ? 'error' : 'warning'} is-${issue.level}`}
                      title={issue.message}
                      aria-label={issue.message}
                    />
                  )}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

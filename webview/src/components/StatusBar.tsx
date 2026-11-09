import type { ActivitySummaryState, SkillTreeState } from '@shared/types';
import { SOURCE_LABELS } from '@shared/types';
import { post } from '../vscodeBridge';
import { unusedDays } from '@shared/recommend';

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function Activity({ state, activity: a, scope, onScope }: { state: SkillTreeState; activity: ActivitySummaryState | undefined; scope: 'all' | 'here' | null; onScope(s: 'all' | 'here'): void }) {
  if (!a) {
    return (
      <span className="status-activity">
        <i className="codicon codicon-pulse" aria-hidden />
        <span className="status-muted">Usage not tracked</span>
        <button type="button" className="link-btn" onClick={() => post({ type: 'enableTracking' })}>
          Enable…
        </button>
      </span>
    );
  }
  const used = Object.keys(a.bySkill).length;
  const unused = state.skills.filter((s) => unusedDays(s, a) !== null).length;
  return (
    <span className="status-activity">
      <i className="codicon codicon-pulse" aria-hidden />
      {a.totalEvents === 0 ? (
        <span className="status-muted">{a.enabled ? 'Tracking on · no skill use recorded yet' : 'Tracking off'}</span>
      ) : (
        <span>
          {a.totalEvents} recorded use{a.totalEvents === 1 ? '' : 's'}
          <span className="status-muted">
            {' '}
            · {used} skill{used === 1 ? '' : 's'} · {a.totalSessions} session{a.totalSessions === 1 ? '' : 's'}
            {unused ? ` · ${unused} unused for 7+ days` : ''}
            {!a.enabled ? ' · tracking off' : ''}
          </span>
        </span>
      )}
      {scope && (
        <button
          type="button"
          className="link-btn"
          title={scope === 'all' ? 'Counting use recorded in every project. Click to count only use recorded in this workspace.' : 'Counting only use recorded in this workspace. Click to count every project.'}
          onClick={() => onScope(scope === 'all' ? 'here' : 'all')}
        >
          {scope === 'all' ? 'All projects' : 'This project'}
        </button>
      )}
      <button type="button" className="link-btn" onClick={() => post({ type: 'openActivity' })}>
        Timeline
      </button>
    </span>
  );
}

export function StatusBar({
  state,
  activity,
  scope,
  onScope,
  shown,
  filtered,
  view,
  showActivityLegend,
}: {
  state: SkillTreeState;
  activity: ActivitySummaryState | undefined;
  scope: 'all' | 'here' | null;
  onScope(s: 'all' | 'here'): void;
  shown: number;
  filtered: boolean;
  view: 'graph' | 'list';
  showActivityLegend: boolean;
}) {
  const total = state.skills.length;
  const withIssues = state.skills.filter((s) => s.issues.some((i) => i.level === 'error' || i.level === 'warning')).length;
  const bySource = state.roots
    .filter((r) => r.skillCount > 0)
    .map((r) => `${SOURCE_LABELS[r.source]} ${r.skillCount}`)
    .join(' · ');
  return (
    <footer className="statusbar">
      <span className="status-main">
        {filtered ? `${shown} of ${total} skills` : `${total} skill${total === 1 ? '' : 's'}`}
        {bySource && <span className="status-muted"> · {bySource}</span>}
        {withIssues > 0 && <span className="status-muted"> · {withIssues} with warnings</span>}
        {state.scannedAt && <span className="status-muted"> · scanned {time(state.scannedAt)}</span>}
      </span>
      {total > 0 && <Activity state={state} activity={activity} scope={scope} onScope={onScope} />}
      {view === 'graph' && total > 0 && (
        <span className="legend">
          <span className="legend-item" title="Solid lines show how skills are organized by category. They are not dependencies and do not indicate usage.">
            <svg width="18" height="6" aria-hidden>
              <line x1="0" y1="3" x2="18" y2="3" className="legend-line" />
            </svg>
            Category
          </span>
          {showActivityLegend && (
            <span className="legend-item" title="Dashed lines: recorded in the same Claude Code session as the selected skill. Co-occurrence only, not a dependency or cause.">
              <svg width="18" height="6" aria-hidden>
                <line x1="0" y1="3" x2="18" y2="3" className="legend-line legend-dashed" />
              </svg>
              Same session (recorded)
            </span>
          )}
        </span>
      )}
    </footer>
  );
}

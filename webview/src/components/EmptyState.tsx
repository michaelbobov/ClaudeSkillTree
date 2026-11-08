import type { SkillTreeState } from '@shared/types';
import { post } from '../vscodeBridge';

export function LoadingState() {
  return (
    <div className="state-panel" role="status" aria-live="polite">
      <i className="codicon codicon-loading codicon-modifier-spin" aria-hidden />
      <span>Scanning skill folders…</span>
    </div>
  );
}

export function NoMatches({ onClear }: { onClear(): void }) {
  return (
    <div className="state-panel" role="status">
      <p className="state-title">No skills match the current filters</p>
      <button type="button" className="btn btn-secondary" onClick={onClear}>
        Clear filters
      </button>
    </div>
  );
}

export function EmptyState({ state, error }: { state: SkillTreeState; error?: string }) {
  const canCreate = state.workspaceTrusted && state.workspaceName !== null;
  return (
    <div className="state-panel state-empty" role="status">
      <p className="state-title">{error ? 'Could not scan skill folders' : 'No Claude Code skills found'}</p>
      {error && <p className="is-error">{error}</p>}
      <p className="state-sub">SkillTree looked for <span className="mono">&lt;name&gt;/SKILL.md</span> in:</p>
      <ul className="state-roots">
        {state.roots.map((r) => (
          <li key={`${r.source}:${r.displayPath}`}>
            <i className={`codicon codicon-${r.exists ? 'folder' : 'circle-slash'}`} aria-hidden />
            <span className="mono">{r.displayPath}</span>
            <span className="state-note">
              {r.error ? r.error : r.exists ? `${r.skillCount} skill${r.skillCount === 1 ? '' : 's'}` : 'not found'}
            </span>
          </li>
        ))}
        {state.workspaceName === null && (
          <li>
            <i className="codicon codicon-info" aria-hidden />
            <span>Open a folder to include project skills.</span>
          </li>
        )}
      </ul>
      <div className="state-actions">
        <button type="button" className="btn btn-primary" onClick={() => post({ type: 'rescan' })}>
          <i className="codicon codicon-refresh" aria-hidden /> Rescan
        </button>
        {canCreate && (
          <button type="button" className="btn btn-secondary" onClick={() => post({ type: 'createSkill' })}>
            <i className="codicon codicon-add" aria-hidden /> Create project skill
          </button>
        )}
      </div>
    </div>
  );
}

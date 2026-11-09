import { useEffect, useMemo, useState } from 'react';
import { CAPTURE_LABELS, type ActivityHostMessage, type ActivityViewState, type ActivityWebviewMessage, type CaptureSource } from '@shared/activity';
import { channel, loadState, saveState } from '../vscodeBridge';
import { PageNav } from '../components/PageNav';

const bridge = channel<ActivityWebviewMessage, ActivityHostMessage>();

const base = (p: string | null) => (p ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : 'unknown project');
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

interface Ui {
  query: string;
  source: 'all' | CaptureSource;
}

export function ActivityApp() {
  const [state, setState] = useState<ActivityViewState | null>(null);
  const [ui, setUi] = useState<Ui>(() => ({ query: '', source: 'all', ...loadState<Ui>() }));
  useEffect(() => saveState(ui), [ui]);
  useEffect(() => {
    const off = bridge.onMessage((m) => {
      if (m.type === 'state') setState(m.state);
    });
    bridge.post({ type: 'ready' });
    return off;
  }, []);

  const sessions = useMemo(() => {
    const q = ui.query.trim().toLowerCase();
    return (state?.sessions ?? [])
      .map((g) => ({ ...g, events: g.events.filter((e) => (ui.source === 'all' || e.source === ui.source) && (!q || (e.skill ?? '').toLowerCase().includes(q))) }))
      .filter((g) => g.events.length > 0);
  }, [state, ui]);
  const shown = sessions.reduce((n, g) => n + g.events.length, 0);

  useEffect(() => {
    if (state) bridge.post({ type: 'rendered', count: shown });
  }, [state, shown]);

  let main;
  if (!state) {
    main = (
      <div className="state-panel" role="status">
        <i className="codicon codicon-loading codicon-modifier-spin" aria-hidden /> Loading activity…
      </div>
    );
  } else if (!state.enabled && state.total === 0) {
    main = (
      <div className="state-panel state-empty" role="status">
        <p className="state-title">Activity tracking is off</p>
        <p className="state-sub">
          When you opt in, SkillTree adds three Claude Code hooks (PreToolUse for the Skill tool, UserPromptExpansion for typed /commands, and SessionEnd) that append the
          time, skill name, capture source, session id, working directory and, for subagents, the subagent type to a local file. Prompt text and arguments are never recorded, nothing leaves your machine, and disabling
          restores your settings.
        </p>
        <div className="state-actions">
          <button type="button" className="btn btn-primary" onClick={() => bridge.post({ type: 'enable' })}>
            Enable activity tracking…
          </button>
        </div>
      </div>
    );
  } else if (state.total === 0) {
    main = (
      <div className="state-panel" role="status">
        <p className="state-title">No skill use recorded yet</p>
        <p className="state-sub">Events appear here after Claude Code runs a skill in a session that has loaded the updated settings.</p>
      </div>
    );
  } else if (shown === 0) {
    main = (
      <div className="state-panel" role="status">
        <p className="state-title">No events match the current filters</p>
        <button type="button" className="btn btn-secondary" onClick={() => setUi({ query: '', source: 'all' })}>
          Clear filters
        </button>
      </div>
    );
  } else {
    main = (
      <div className="timeline" role="list" aria-label="Recorded skill activity by session">
        {sessions.map((g) => (
          <section key={g.sessionId ?? 'unknown'} className="tl-session" role="listitem" aria-label={`Session ${g.sessionId ?? 'unknown'}`}>
            <header className="tl-head">
              <span className="tl-project">{base(g.project)}</span>
              <span className="mono tl-sid" title={g.sessionId ?? 'No session id in the hook payload'}>
                {g.sessionId ? `session ${g.sessionId.slice(0, 8)}` : 'unknown session'}
              </span>
              <span className="tl-range">
                {day(g.end)} {g.start === g.end ? time(g.end) : `${time(g.start)}–${time(g.end)}`}
              </span>
              <span className="tl-count">
                {g.events.length} event{g.events.length === 1 ? '' : 's'} · {g.skills.join(', ')}
              </span>
            </header>
            <ul className="tl-rows">
              {g.events.map((e, i) => (
                <li key={`${e.ts}-${i}`} className="tl-row">
                  <span className="tl-time mono">{time(e.ts)}</span>
                  <span className="tl-skill">{e.skill ?? <em>unknown skill</em>}</span>
                  <span className={`tl-source is-${e.source === 'UserPromptExpansion' ? 'typed' : 'tool'}`} title={e.source}>
                    <i className={`codicon codicon-${e.source === 'UserPromptExpansion' ? 'terminal' : 'symbol-event'}`} aria-hidden /> <span className="tl-source-label">{CAPTURE_LABELS[e.source]}</span>
                    {e.agentType && (
                      <span className="tl-agent" title={`Invoked inside a subagent (agent_type ${e.agentType}${e.agentId ? `, agent_id ${e.agentId}` : ''})`}>
                        · {e.agentType} subagent
                      </span>
                    )}
                  </span>
                  <span className="tl-cwd mono" title={e.projectDir ?? e.cwd ?? ''}>
                    {e.cwd ?? e.projectDir ?? ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="app activity">
      <PageNav current="activity" onNavigate={(to) => bridge.post({ type: 'navigate', to })} />
      <header className="toolbar" role="toolbar" aria-label="Activity controls">
        <div className="search">
          <i className="codicon codicon-search" aria-hidden />
          <input type="search" placeholder="Filter by skill" aria-label="Filter by skill name" value={ui.query} onChange={(e) => setUi((u) => ({ ...u, query: e.target.value }))} />
        </div>
        <select aria-label="Capture source" value={ui.source} onChange={(e) => setUi((u) => ({ ...u, source: e.target.value as Ui['source'] }))}>
          <option value="all">All sources</option>
          <option value="PreToolUse:Skill">{CAPTURE_LABELS['PreToolUse:Skill']}</option>
          <option value="UserPromptExpansion">{CAPTURE_LABELS.UserPromptExpansion}</option>
        </select>
        <div className="toolbar-spacer" />
        {state?.enabled ? (
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => bridge.post({ type: 'disable' })}>
            Disable tracking
          </button>
        ) : state ? (
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => bridge.post({ type: 'enable' })}>
            Enable tracking…
          </button>
        ) : null}
        <button type="button" className="icon-btn" aria-label="Reload activity log" title="Reload activity log" onClick={() => bridge.post({ type: 'refresh' })}>
          <i className="codicon codicon-refresh" aria-hidden />
        </button>
      </header>
      {state && (state.enabled || state.total > 0) && (
        <div className="mbanner" role="note">
          <div className="mbanner-line">
            <i className="codicon codicon-pulse" aria-hidden />
            <span>
              {state.enabled ? (
                <>
                  Recording via hooks in{' '}
                  <button type="button" className="link-btn mono" onClick={() => bridge.post({ type: 'openSettings' })}>
                    {state.settingsFile}
                  </button>
                  {state.installedAt ? ` since ${day(state.installedAt)}` : ''}
                </>
              ) : (
                'Tracking is off; showing previously recorded events.'
              )}
              <span className="muted"> · log {state.logFile}</span>
              {state.total > 0 && (
                <>
                  {' · '}
                  <button type="button" className="link-btn" onClick={() => bridge.post({ type: 'clearLog' })}>
                    Delete log
                  </button>
                </>
              )}
            </span>
          </div>
          <div className="mbanner-line muted">
            <i className="codicon codicon-info" aria-hidden />
            <span>Only direct hook observations are shown. Being listed means Claude Code reported the skill was invoked, not that it caused any particular change.</span>
          </div>
          {state.error && (
            <div className="mbanner-line is-warning">
              <i className="codicon codicon-warning" aria-hidden />
              <span>{state.error}</span>
            </div>
          )}
        </div>
      )}
      <div className="workspace">
        <main className="canvas mcanvas" aria-label="Activity">
          {main}
        </main>
      </div>
      {state && (
        <footer className="statusbar">
          <span>
            {shown === state.total ? `${state.total} events` : `${shown} of ${state.total} events`}
            <span className="status-muted"> · {state.sessions.length} sessions{state.skippedLines ? ` · ${state.skippedLines} unreadable log lines skipped` : ''}</span>
          </span>
        </footer>
      )}
    </div>
  );
}

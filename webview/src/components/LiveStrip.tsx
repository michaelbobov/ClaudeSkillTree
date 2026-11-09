import { folderName, sessionWho, type LiveSession } from '@shared/activity';
import { shortAgo } from './common';

export const sessionKey = (l: Pick<LiveSession, 'sessionId'>) => l.sessionId ?? '(unknown session)';

/**
 * The Claude Code sessions that used skills in the last 10 minutes, across projects. Choosing one
 * picks out its skills on the tree. Only what SkillTree's hooks recorded: when a skill was invoked,
 * in which session and project, and by the main conversation or a subagent. Not what it is doing.
 */
export function LiveStrip({ sessions, focus, onFocus, now }: { sessions: LiveSession[]; focus: string | null; onFocus(key: string | null): void; now: number }) {
  return (
    <div className="live-strip" role="group" aria-label="Claude Code sessions that used skills in the last 10 minutes">
      <span className="live-label" title="Sessions with recorded skill use in the last 10 minutes, in any project">
        <i className="codicon codicon-pulse" aria-hidden /> Live
      </span>
      <div className="live-chips">
        {sessions.map((l) => {
          const key = sessionKey(l);
          const on = focus === key;
          const project = folderName(l.project) ?? 'unknown project';
          const title = [
            `${project}${l.sessionId ? ` · session ${l.sessionId.slice(0, 8)}` : ''}`,
            l.project ?? '',
            `Skills in the last 10 minutes: ${l.skills.join(', ') || 'unknown'}`,
            `Used by: ${[l.typed ? 'you (typed)' : '', l.main ? 'Claude' : '', ...l.agentTypes.map((t) => `${t} subagent`)].filter(Boolean).join(', ')}`,
            on ? 'Click to show all skills again.' : 'Click to pick out these skills on the tree.',
          ]
            .filter(Boolean)
            .join('\n');
          return (
            <button key={key} type="button" className={`live-chip ${on ? 'is-on' : ''}`} aria-pressed={on} title={title} onClick={() => onFocus(on ? null : key)}>
              <span className="live-project">{project}</span>
              <span className="live-muted">{sessionWho(l)}</span>
              <span className="live-skill">{l.lastSkill ?? 'unknown skill'}</span>
              {l.skills.length > 1 && <span className="live-muted">+{l.skills.length - 1}</span>}
              <span className="live-muted">{shortAgo(l.lastTs, now)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

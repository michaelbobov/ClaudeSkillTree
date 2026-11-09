import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { CATEGORIES, type ActivitySummaryState, type Category, type OrganizedSkill } from '@shared/types';
import { usageFor, folderName } from '@shared/activity';
import { unusedDays } from '@shared/recommend';
import { post } from '../vscodeBridge';
import { renderMarkdown } from '../markdown';
import { CategoryDot, IssueIcon, formatBytes, longDate, scopeSentence } from './common';

export interface BodyState {
  status: 'loading' | 'ready' | 'error';
  markdown: string;
  truncated: boolean;
  error?: string;
  modifiedAt?: number;
}

interface InspectorProps {
  /** Recorded use from SkillTree's opt-in hooks; undefined when tracking was never enabled. */
  activity?: ActivitySummaryState;
  /** Skills recorded in the same sessions (visible ones). */
  coUsed: { skill: OrganizedSkill; sessions: number }[];
  skill: OrganizedSkill;
  allSkills: OrganizedSkill[];
  body: BodyState | undefined;
  narrow: boolean;
  onClose(): void;
  onSelect(id: string): void;
}

const CATEGORY_SOURCE_TEXT: Record<OrganizedSkill['categorySource'], string> = {
  user: 'Set by you',
  frontmatter: 'From SKILL.md frontmatter',
  inferred: 'Auto-assigned from name and description keywords',
  default: 'No category matched; choose one',
};

function Section({ title, children, count }: { title: string; children: ReactNode; count?: number }) {
  return (
    <section className="insp-section">
      <h3>
        {title}
        {count !== undefined && <span className="insp-count">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

export function Inspector({ skill, allSkills, body, narrow, onClose, onSelect, activity, coUsed }: InspectorProps) {
  const usage = usageFor(activity, skill);
  const unused = unusedDays(skill, activity);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [showPreview, setShowPreview] = useState(true);
  const [showFullDesc, setShowFullDesc] = useState(false);
  const longDesc = skill.description.length > 320;
  const html = useMemo(() => (body?.status === 'ready' ? renderMarkdown(body.markdown) : ''), [body]);

  useEffect(() => {
    if (narrow) closeRef.current?.focus();
  }, [narrow]);

  useEffect(() => {
    if (!narrow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [narrow, onClose]);

  const onPreviewClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href) post({ type: 'openLink', id: skill.id, href });
  };

  const shadowedBy = skill.shadowedBy ? allSkills.find((s) => s.id === skill.shadowedBy) : undefined;
  const sameName = skill.sameNameAs.map((id) => allSkills.find((s) => s.id === id)).filter((s): s is OrganizedSkill => !!s);
  const scripts = skill.supportingFiles.filter((f) => f.kind === 'script' || f.kind === 'executable');
  const visibleIssues = skill.issues;

  return (
    <aside className={`inspector ${narrow ? 'is-drawer' : ''}`} aria-label={`Details for ${skill.name}`} role={narrow ? 'dialog' : 'complementary'}>
      <div className="insp-header">
        <span className="insp-eyebrow">Skill details</span>
        <button ref={closeRef} type="button" className="icon-btn" aria-label="Close details" title="Close (Esc)" onClick={onClose}>
          <i className="codicon codicon-close" aria-hidden />
        </button>
      </div>
      <div className="insp-body">
        <h2 className="insp-title">{skill.name}</h2>
        <div className="insp-command mono">{skill.command}</div>
        <div className="insp-scope">
          <i className={`codicon codicon-${skill.readOnly ? 'lock' : skill.source === 'personal' ? 'account' : 'folder'}`} aria-hidden />
          {scopeSentence(skill)}
          {skill.readOnly && <span className="insp-ro"> · read-only</span>}
        </div>
        <div className="insp-path mono" title={skill.file}>
          {skill.displayPath}
        </div>

        <div className="insp-actions">
          <button type="button" className="btn btn-primary" onClick={() => post({ type: 'openSkill', id: skill.id })}>
            <i className="codicon codicon-go-to-file" aria-hidden /> Open SKILL.md
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => post({ type: 'copyPath', id: skill.id })}>
            <i className="codicon codicon-copy" aria-hidden /> Copy path
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => post({ type: 'revealSkill', id: skill.id })} title="Reveal in Finder / File Explorer">
            <i className="codicon codicon-folder-opened" aria-hidden /> Reveal
          </button>
        </div>

        <p className={`insp-desc ${skill.description ? '' : 'is-empty'} ${longDesc && !showFullDesc ? 'is-clamped' : ''}`}>
          {skill.description || 'No description in SKILL.md.'}
          {skill.descriptionSource === 'body' && <span className="insp-note"> (first line of the body; no description in frontmatter)</span>}
        </p>
        {longDesc && (
          <button type="button" className="link-btn insp-more" aria-expanded={showFullDesc} onClick={() => setShowFullDesc((v) => !v)}>
            {showFullDesc ? 'Show less' : 'Show more'}
          </button>
        )}

        {(shadowedBy || skill.readOnly) && (
          <div className="insp-callout">
            {shadowedBy && (
              <p>
                <i className="codicon codicon-warning is-warning" aria-hidden /> Claude Code runs{' '}
                <button type="button" className="link-btn" onClick={() => onSelect(shadowedBy.id)}>
                  {shadowedBy.name} ({shadowedBy.source})
                </button>{' '}
                for <span className="mono">{shadowedBy.command}</span>. Personal skills take precedence over project skills.
              </p>
            )}
            {skill.readOnly && (
              <p>
                <i className="codicon codicon-lock" aria-hidden />{' '}
                {skill.source === 'synced'
                  ? 'Synced skills are managed by claude.ai. Edits here can be overwritten by the next sync.'
                  : 'Managed by your organization. SkillTree will not modify it.'}
              </p>
            )}
          </div>
        )}

        <Section title="Recorded use">
          {!activity ? (
            <div className="insp-note">
              Usage tracking is off, so SkillTree does not know when this skill runs.{' '}
              <button type="button" className="link-btn" onClick={() => post({ type: 'enableTracking' })}>
                Enable tracking…
              </button>
            </div>
          ) : !usage ? (
            <div className="insp-note">
              {unused !== null ? (
                <>
                  No recorded use in {unused} days of tracking. If you don’t need it, you can remove its folder yourself:{' '}
                  <button type="button" className="link-btn" onClick={() => post({ type: 'revealSkill', id: skill.id })}>
                    Reveal
                  </button>
                </>
              ) : (
                <>No recorded use{activity.since ? ` since ${longDate(activity.since)}` : ''}.</>
              )}
            </div>
          ) : (
            <>
              <div className="insp-usage">
                <span className="insp-usage-count">{usage.count}</span>
                <span>
                  use{usage.count === 1 ? '' : 's'} in {usage.sessions || 1} session{(usage.sessions || 1) === 1 ? '' : 's'}
                  <span className="insp-note-inline">
                    {' '}
                    · {[usage.invoked ? `${usage.invoked} by Claude` : '', usage.typed ? `${usage.typed} typed` : ''].filter(Boolean).join(', ')}
                  </span>
                </span>
              </div>
              <div className="insp-note">
                Last {longDate(usage.lastTs)} · {usage.lastSource === 'UserPromptExpansion' ? 'typed as a /command' : usage.lastAgentType ? `invoked by a ${usage.lastAgentType} subagent` : 'invoked by Claude'}
                {usage.lastProject && <> · in <span title={usage.lastProject}>{folderName(usage.lastProject)}</span></>}
              </div>
              {coUsed.length > 0 && (
                <div className="insp-related">
                  <div className="insp-subhead">
                    <svg width="18" height="6" aria-hidden>
                      <line x1="0" y1="3" x2="18" y2="3" className="legend-line legend-dashed" />
                    </svg>
                    Used in the same session
                  </div>
                  <ul>
                    {coUsed.map((c) => (
                      <li key={c.skill.id}>
                        <button type="button" className="link-btn" onClick={() => onSelect(c.skill.id)}>
                          {c.skill.name}
                        </button>
                        <span className="insp-note-inline">
                          {' '}
                          {c.sessions} session{c.sessions === 1 ? '' : 's'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="insp-note">
                Recorded by SkillTree’s hooks{activity.since ? ` since ${longDate(activity.since)}` : ''}. Same-session means they ran together, not that one needs the other.{' '}
                <button type="button" className="link-btn" onClick={() => post({ type: 'openActivity' })}>
                  Timeline
                </button>
              </div>
            </>
          )}
        </Section>

        {skill.installedFrom && (
          <Section title="Source">
            <div className="insp-source">
              <div className="mono">
                {skill.installedFrom.owner}/{skill.installedFrom.repo}
                {skill.installedFrom.path ? `/${skill.installedFrom.path}` : ''}
              </div>
              <div className="insp-note">
                Commit <span className="mono">{skill.installedFrom.commitSha.slice(0, 12)}</span> · installed by SkillTree{' '}
                {new Date(skill.installedFrom.installedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
              </div>
              <button type="button" className="link-btn" onClick={() => post({ type: 'openLink', id: skill.id, href: skill.installedFrom!.sourceUrl })}>
                View source on GitHub
              </button>
            </div>
          </Section>
        )}

        <Section title="Category">
          <div className="insp-category">
            <CategoryDot category={skill.category} />
            <select
              aria-label="Category"
              value={skill.category}
              onChange={(e) => post({ type: 'setCategory', id: skill.id, category: e.target.value as Category })}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {skill.categorySource === 'user' && (
              <button type="button" className="link-btn" onClick={() => post({ type: 'setCategory', id: skill.id, category: null })}>
                Reset
              </button>
            )}
          </div>
          <div className="insp-note">{CATEGORY_SOURCE_TEXT[skill.categorySource]}. Stored by SkillTree; SKILL.md is not changed.</div>
        </Section>

        {visibleIssues.length > 0 && (
          <Section title="Notes" count={visibleIssues.length}>
            <ul className="insp-issues">
              {visibleIssues.map((issue, i) => (
                <li key={i}>
                  <IssueIcon issue={issue} />
                  <span>{issue.message}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {sameName.length > 0 && !shadowedBy && (
          <Section title="Same name elsewhere" count={sameName.length}>
            <ul className="insp-files">
              {sameName.map((s) => (
                <li key={s.id}>
                  <button type="button" className="link-btn" onClick={() => onSelect(s.id)}>
                    {s.name}
                  </button>{' '}
                  <span className="insp-note mono">{s.displayPath}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {skill.fields.length > 0 && (
          <Section title="Frontmatter">
            <dl className="insp-fields">
              {skill.fields.map((f) => (
                <div key={f.key} className="insp-field">
                  <dt className="mono">{f.key}</dt>
                  <dd>{f.value || <em>empty</em>}</dd>
                </div>
              ))}
            </dl>
          </Section>
        )}

        <Section title="Files" count={skill.supportingFiles.length + 1}>
          <ul className="insp-files">
            <li>
              <i className="codicon codicon-markdown" aria-hidden /> <span className="mono">SKILL.md</span>
              <span className="insp-note"> {formatBytes(skill.sizeBytes)}</span>
            </li>
            {skill.supportingFiles.map((f) => (
              <li
                key={f.path}
                className={f.kind === 'script' || f.kind === 'executable' ? 'is-script' : ''}
                title={f.kind === 'script' ? `${f.path} (script)` : f.kind === 'executable' ? `${f.path} (executable)` : f.path}
              >
                <i
                  className={`codicon codicon-${f.kind === 'markdown' ? 'markdown' : f.kind === 'symlink' ? 'file-symlink-file' : f.kind === 'script' || f.kind === 'executable' ? 'terminal' : 'file'}`}
                  aria-hidden
                />{' '}
                <span className="mono">{f.path}</span>
                <span className="insp-note">
                  {' '}
                  {f.kind === 'symlink' ? 'symlink, not followed' : formatBytes(f.size)}
                </span>
              </li>
            ))}
          </ul>
          {skill.supportingFilesTruncated && <div className="insp-note">List truncated.</div>}
          {scripts.length > 0 && (
            <div className="insp-note">
              <i className="codicon codicon-terminal is-warning" aria-hidden /> {scripts.length} script{scripts.length === 1 ? '' : 's'} or executable
              {scripts.length === 1 ? '' : 's'} that Claude may run when using this skill. SkillTree never runs them.
            </div>
          )}
        </Section>

        <section className="insp-section">
          <h3>
            <button type="button" className="disclosure" aria-expanded={showPreview} onClick={() => setShowPreview((v) => !v)}>
              <i className={`codicon codicon-chevron-${showPreview ? 'down' : 'right'}`} aria-hidden /> Instructions preview
            </button>
          </h3>
          {showPreview &&
            (!body || body.status === 'loading' ? (
              <div className="insp-note">Loading…</div>
            ) : body.status === 'error' ? (
              <div className="insp-note is-error">{body.error}</div>
            ) : body.markdown.trim() === '' ? (
              <div className="insp-note">SKILL.md has no instructions after the frontmatter.</div>
            ) : (
              <>
                {/* Rendered with markdown-it html:false: source HTML is escaped, not injected. */}
                <div className="markdown" onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: html }} />
                {body.truncated && <div className="insp-note">Preview truncated at 256 KB. Open the file to see everything.</div>}
              </>
            ))}
        </section>
      </div>
    </aside>
  );
}

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

/** Cards rendered per page; more load as the list scrolls (the catalog can have thousands). */
const PAGE = 60;
import { CATEGORIES } from '@shared/types';
import {
  DEFAULT_MARKET_FILTER,
  filterEntries,
  isCategoryOrAll,
  type MarketplaceEntryView,
  type MarketplaceFilter,
  type MarketplaceHostMessage,
  type MarketplaceState,
  type MarketplaceWebviewMessage,
} from '@shared/marketplace';
import { splitFrontmatterText } from './frontmatterText';
import { channel, loadState, saveState } from '../vscodeBridge';
import { renderMarkdown } from '../markdown';
import { CategoryDot, formatBytes } from '../components/common';
import { PageNav } from '../components/PageNav';

const bridge = channel<MarketplaceWebviewMessage, MarketplaceHostMessage>();
const NARROW = 760;

interface UiState extends MarketplaceFilter {
  selectedId: string | null;
}

interface PreviewState {
  status: 'loading' | 'ready' | 'error';
  text: string;
  error?: string;
}

function date(iso: string | null | undefined, withTime = false): string {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return withTime
    ? d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** 188874 → "189k", 1234 → "1.2k". */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

type Stats = Record<string, { stars: number; fetchedAt: string }>;
const NO_STATS: Stats = {};

function starsTitle(repo: string, s: { stars: number; fetchedAt: string }): string {
  return `${s.stars.toLocaleString()} GitHub stars on ${repo} (the whole repository, not this skill), as of ${date(s.fetchedAt)}`;
}

const STATE_LABEL: Record<MarketplaceEntryView['installState'], string> = {
  'not-installed': 'Not installed',
  installed: 'Installed',
  'update-available': 'Update available',
  unknown: 'Unknown',
};

const STATE_TITLE: Record<MarketplaceEntryView['installState'], string> = {
  'not-installed': 'Not installed in this project or your personal skills.',
  installed: 'Installed by SkillTree from this exact commit.',
  'update-available': 'Installed by SkillTree from an older commit; the catalog has a newer one.',
  unknown: 'A skill with this folder or name is already on this machine, installed some other way (another tool, claude.ai sync, by hand). It may be this skill or a different version. Claude Code uses one skill per name.',
};

function StateBadge({ entry }: { entry: MarketplaceEntryView }) {
  return (
    <span className={`mbadge is-${entry.installState}`} title={STATE_TITLE[entry.installState]}>
      {entry.installState === 'installed' && <i className="codicon codicon-check" aria-hidden />}
      {entry.installState === 'update-available' && <i className="codicon codicon-arrow-circle-up" aria-hidden />}
      {STATE_LABEL[entry.installState]}
    </span>
  );
}

function scopeInstalled(entry: MarketplaceEntryView, prefix: 'project/' | 'personal/'): boolean {
  return (entry.installState === 'installed' || entry.installState === 'update-available') && entry.localIds.some((id) => id.startsWith(prefix));
}

function InstallButtons({ entry, state, compact }: { entry: MarketplaceEntryView; state: MarketplaceState; compact?: boolean }) {
  if (entry.kind !== 'skill') {
    return <span className="mnote" title="This skill is part of a Claude Code plugin (agents, hooks or MCP servers). Plugin installation is not supported yet.">Plugin · not supported yet</span>;
  }
  const busy = state.busyId !== null;
  const button = (scope: 'project' | 'global') => {
    const installedHere = scopeInstalled(entry, scope === 'project' ? 'project/' : 'personal/');
    const upToDate = installedHere && entry.installState === 'installed';
    const blocked = scope === 'project' ? state.projectInstallBlocked : null;
    const label = upToDate ? (scope === 'project' ? 'In project' : 'Installed globally') : installedHere ? (scope === 'project' ? 'Update in project' : 'Update globally') : scope === 'project' ? 'Install to Project' : 'Install Globally';
    return (
      <button
        type="button"
        className={`btn btn-sm ${scope === 'project' && !upToDate && !compact ? 'btn-primary' : 'btn-secondary'}`}
        disabled={busy || upToDate || !!blocked}
        title={blocked ?? (upToDate ? 'This exact commit is already installed here.' : scope === 'project' ? 'Copy into .claude/skills/ of this workspace' : 'Copy into ~/.claude/skills/ (all projects)')}
        onClick={(e) => {
          e.stopPropagation();
          bridge.post({ type: 'install', id: entry.id, scope });
        }}
      >
        {state.busyId === entry.id ? <i className="codicon codicon-loading codicon-modifier-spin" aria-hidden /> : null}
        {compact && !installedHere ? (scope === 'project' ? 'Project' : 'Global') : label}
      </button>
    );
  };
  return (
    <>
      {button('project')}
      {button('global')}
    </>
  );
}

function Banner({ state }: { state: MarketplaceState }) {
  const c = state.catalog;
  if (!c) return null;
  const origin =
    state.origin === 'remote'
      ? `Online catalog, fetched ${state.fetchedAt ? ago(state.fetchedAt) : ''}`
      : state.origin === 'cache'
        ? `Cached catalog from ${state.fetchedAt ? ago(state.fetchedAt) : 'earlier'}`
        : 'Catalog snapshot bundled with SkillTree';
  return (
    <div className="mbanner" role="note">
      <div className="mbanner-line">
        <i className="codicon codicon-library" aria-hidden />
        <span>
          {c.source === 'sample' && <strong>Sample catalog · </strong>}
          {origin} · {state.entries.length} skills from{' '}
          <span title={c.repositories.join('\n')}>
            {c.repositories.length === 1 ? c.repositories[0] : `${c.repositories.length} repositories`}
          </span>{' '}
          · indexed {date(c.generatedAt, true)}
          {c.skippedCount > 0 && <span className="muted"> · {c.skippedCount} skipped while indexing</span>}
        </span>
      </div>
      {state.error && (
        <div className="mbanner-line is-warning">
          <i className="codicon codicon-warning" aria-hidden />
          <span>
            {state.origin === 'cache' ? 'Offline or unreachable: showing the cached copy. ' : state.origin === 'bundled' ? 'Could not load the configured catalog; showing the bundled snapshot. ' : ''}
            {state.error}
          </span>
        </div>
      )}
      <div className="mbanner-line muted">
        <i className="codicon codicon-shield" aria-hidden />
        <span>Indexed from public GitHub repositories; not reviewed for security, quality or licensing. Preview before installing. SkillTree never runs skill files.</span>
      </div>
      {state.claudeSuggestions !== undefined && (
        <div className="mbanner-line muted">
          <i className="codicon codicon-sparkle" aria-hidden />
          {state.claudeSuggestions ? (
            <span>Claude suggestions are on: when a skill here fits what you ask Claude, SkillTree suggests it. You approve every install.</span>
          ) : (
            <span>
              Claude can suggest skills from this catalog while you work. You approve every install.{' '}
              <button type="button" className="link-btn" onClick={() => bridge.post({ type: 'enableClaude' })}>
                Turn on…
              </button>
            </span>
          )}
        </div>
      )}
      {state.projectInstallBlocked && (
        <div className="mbanner-line muted">
          <i className="codicon codicon-info" aria-hidden />
          <span>{state.projectInstallBlocked}</span>
        </div>
      )}
    </div>
  );
}

function Card({ entry, state, selected, onSelect, reason }: { entry: MarketplaceEntryView; state: MarketplaceState; selected: boolean; onSelect(id: string): void; reason?: string }) {
  const onKey = (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
      e.preventDefault();
      onSelect(entry.id);
    }
  };
  const repo = `${entry.owner}/${entry.repo}`;
  const stats = state.catalog?.repositoryStats[repo];
  return (
    <article
      className={`mcard ${selected ? 'is-selected' : ''} is-${entry.installState}`}
      role="listitem"
      tabIndex={0}
      aria-label={`${entry.name}, ${repo}, ${STATE_LABEL[entry.installState]}`}
      data-entry-id={entry.id}
      onClick={() => onSelect(entry.id)}
      onKeyDown={onKey}
    >
      <div className="mcard-head">
        <span className="mcard-name">{entry.name}</span>
        <span className="mcard-repo" title={`${entry.sourceUrl}\nPinned to ${entry.commitSha.slice(0, 12)}`}>
          {repo}
          {entry.path ? <span className="mcard-path"> · {entry.path}</span> : null}
        </span>
        {stats && (
          <span className="mstars" title={starsTitle(repo, stats)}>
            <i className="codicon codicon-star-empty" aria-hidden />
            {compact(stats.stars)}
          </span>
        )}
        <span className="mcard-spacer" />
        {entry.warnings.length > 0 && (
          <span className="mwarn" title={`Review before installing:\n${entry.warnings.join('\n')}`} aria-label={`${entry.warnings.length} items to review`}>
            <i className="codicon codicon-warning" aria-hidden /> {entry.warnings.length}
          </span>
        )}
        {entry.installState !== 'not-installed' && <StateBadge entry={entry} />}
      </div>
      <p className="mcard-desc">{entry.description || <em>No description</em>}</p>
      {reason && (
        <div className="mreason" title="Suggested from your recorded skill use">
          <i className="codicon codicon-sparkle" aria-hidden /> {reason}
        </div>
      )}
      <div className="mcard-meta">
        <span className="mmeta-item" title={entry.categorySource === 'frontmatter' ? 'Category from SKILL.md' : 'Category assigned automatically from keywords'}>
          <CategoryDot category={entry.category} /> {entry.category}
        </span>
        <span className="mmeta-item mmeta-license" title={entry.license ? `License: ${entry.license}${entry.licenseSource ? ` (from ${entry.licenseSource === 'frontmatter' ? 'SKILL.md' : 'the repository'})` : ''}` : 'No license could be determined'}>
          {entry.license ?? 'License unknown'}
        </span>
        <span className="mmeta-item">{date(entry.updatedAt)}</span>
        <span className="mcard-spacer" />
        <span className="mcard-actions">
          <InstallButtons entry={entry} state={state} compact />
        </span>
      </div>
    </article>
  );
}

function PreviewPane({ entry, state, preview, narrow, onClose }: { entry: MarketplaceEntryView; state: MarketplaceState; preview: PreviewState | undefined; narrow: boolean; onClose(): void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const parts = useMemo(() => (preview?.status === 'ready' ? splitFrontmatterText(preview.text) : null), [preview]);
  const html = useMemo(() => (parts ? renderMarkdown(parts.body) : ''), [parts]);
  const total = entry.files.reduce((n, f) => n + f.size, 0);
  useEffect(() => {
    if (narrow) closeRef.current?.focus();
  }, [narrow, entry.id]);
  const blockLinks = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('a')) e.preventDefault();
  };
  return (
    <aside className={`inspector mpreview ${narrow ? 'is-drawer' : ''}`} aria-label={`Preview of ${entry.name}`} role={narrow ? 'dialog' : 'complementary'}>
      <div className="insp-header">
        <span className="insp-eyebrow">Preview</span>
        <button ref={closeRef} type="button" className="icon-btn" aria-label="Close preview" title="Close (Esc)" onClick={onClose}>
          <i className="codicon codicon-close" aria-hidden />
        </button>
      </div>
      <div className="insp-body">
        <h2 className="insp-title">{entry.name}</h2>
        <div className="insp-command mono">
          {entry.owner}/{entry.repo}
          {entry.path ? `/${entry.path}` : ''}
        </div>
        <dl className="insp-fields mfacts">
          <div className="insp-field"><dt>Commit</dt><dd className="mono" title={entry.commitSha}>{entry.commitSha.slice(0, 12)} (pinned)</dd></div>
          <div className="insp-field"><dt>License</dt><dd>{entry.license ?? 'Unknown'}{entry.licenseSource ? <span className="insp-note"> · from {entry.licenseSource === 'frontmatter' ? 'SKILL.md' : 'repository'}</span> : null}</dd></div>
          {state.catalog?.repositoryStats[`${entry.owner}/${entry.repo}`] && (
            <div className="insp-field">
              <dt>Repository stars</dt>
              <dd>
                {state.catalog.repositoryStats[`${entry.owner}/${entry.repo}`].stars.toLocaleString()}
                <span className="insp-note"> · whole repository, as of {date(state.catalog.repositoryStats[`${entry.owner}/${entry.repo}`].fetchedAt)}</span>
              </dd>
            </div>
          )}
          <div className="insp-field"><dt>Repository updated</dt><dd>{date(entry.updatedAt, true)}</dd></div>
          <div className="insp-field"><dt>Indexed</dt><dd>{date(entry.indexedAt, true)}</dd></div>
          <div className="insp-field"><dt>Category</dt><dd><CategoryDot category={entry.category} /> {entry.category}{entry.categorySource !== 'frontmatter' ? <span className="insp-note"> · auto</span> : null}</dd></div>
          <div className="insp-field"><dt>Status</dt><dd><StateBadge entry={entry} /></dd></div>
        </dl>
        <div className="insp-actions">
          <InstallButtons entry={entry} state={state} />
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => bridge.post({ type: 'openSource', id: entry.id })}>
            <i className="codicon codicon-github" aria-hidden /> View on GitHub
          </button>
          {(entry.installState === 'installed' || entry.installState === 'update-available') && (
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => bridge.post({ type: 'openInstalled', id: entry.id })}>
              <i className="codicon codicon-go-to-file" aria-hidden /> Open installed
            </button>
          )}
        </div>
        <p className="insp-desc">{entry.description}</p>

        {entry.warnings.length > 0 && (
          <section className="insp-section">
            <h3>Review before installing<span className="insp-count">{entry.warnings.length}</span></h3>
            <ul className="insp-issues">
              {entry.warnings.map((w, i) => (
                <li key={i}>
                  <i className="codicon codicon-warning issue-icon is-warning" aria-hidden />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="insp-section">
          <h3>Files<span className="insp-count">{entry.files.length} · {formatBytes(total)}</span></h3>
          <ul className="insp-files">
            {entry.files.map((f) => (
              <li key={f.path} className={f.kind === 'script' || f.kind === 'executable' ? 'is-script' : f.kind === 'symlink' || f.kind === 'submodule' ? 'is-excluded' : ''} title={f.path}>
                <i className={`codicon codicon-${f.kind === 'markdown' ? 'markdown' : f.kind === 'script' || f.kind === 'executable' ? 'terminal' : f.kind === 'symlink' ? 'file-symlink-file' : f.kind === 'submodule' ? 'repo' : 'file'}`} aria-hidden />{' '}
                <span className="mono">{f.path}</span>
                <span className="insp-note"> {f.kind === 'symlink' ? 'symlink · not installed' : f.kind === 'submodule' ? 'submodule · not installed' : formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="insp-section">
          <h3>SKILL.md at {entry.commitSha.slice(0, 7)}</h3>
          {!preview || preview.status === 'loading' ? (
            <div className="insp-note"><i className="codicon codicon-loading codicon-modifier-spin" aria-hidden /> Fetching SKILL.md from GitHub…</div>
          ) : preview.status === 'error' ? (
            <div className="insp-note is-error">{preview.error}</div>
          ) : (
            <>
              {parts?.frontmatter && <pre className="mfront mono">{parts.frontmatter}</pre>}
              {/* markdown-it with html:false: raw HTML in the skill is escaped, never injected. Links are disabled. */}
              <div className="markdown" onClick={blockLinks} dangerouslySetInnerHTML={{ __html: html }} />
            </>
          )}
        </section>
      </div>
    </aside>
  );
}

export function MarketplaceApp() {
  const [state, setState] = useState<MarketplaceState | null>(null);
  const [ui, setUi] = useState<UiState>(() => {
    const saved = loadState<UiState>();
    return {
      ...DEFAULT_MARKET_FILTER,
      selectedId: null,
      ...saved,
      category: isCategoryOrAll(saved?.category) ? saved!.category! : 'all',
    } as UiState;
  });
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => saveState(ui), [ui]);
  useEffect(() => {
    const off = bridge.onMessage((m) => {
      if (m.type === 'state') setState(m.state);
      else if (m.type === 'preview') setPreviews((p) => ({ ...p, [m.id]: { status: m.status, text: m.text, error: m.error } }));
      else if (m.type === 'focus') setUi((u) => ({ ...u, ...DEFAULT_MARKET_FILTER, selectedId: m.id }));
    });
    bridge.post({ type: 'ready' });
    const onResize = () => setNarrow(window.innerWidth < NARROW);
    window.addEventListener('resize', onResize);
    return () => {
      off();
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const entries = state?.entries ?? [];
  const repoOrder = state?.catalog?.repositories;
  const repoStats: Stats = state?.catalog?.repositoryStats ?? NO_STATS;
  const visible = useMemo(() => filterEntries(entries, ui, repoOrder ?? [], repoStats), [entries, ui, repoOrder, repoStats]);
  const repoCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) m.set(`${e.owner}/${e.repo}`, (m.get(`${e.owner}/${e.repo}`) ?? 0) + 1);
    return m;
  }, [entries]);
  const repos = useMemo(() => [...(repoOrder ?? []).filter((r) => repoCounts.has(r)), ...[...repoCounts.keys()].filter((r) => !(repoOrder ?? []).includes(r))], [repoOrder, repoCounts]);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [ui.query, ui.category, ui.install, ui.sort, ui.repo]);
  // Keep the selected entry rendered even when it is beyond the current page.
  const selectedIndex = ui.selectedId ? visible.findIndex((e) => e.id === ui.selectedId) : -1;
  const shown = visible.slice(0, Math.max(limit, selectedIndex + 1));
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((items) => {
      if (items.some((i) => i.isIntersecting)) setLimit((n) => n + PAGE);
    }, { root: listRef.current, rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [shown.length, visible.length]);
  const selected = entries.find((e) => e.id === ui.selectedId) ?? null;

  useEffect(() => {
    if (state) bridge.post({ type: 'rendered', count: visible.length });
  }, [state, visible.length]);

  useEffect(() => {
    if (!selected || previews[selected.id]) return;
    setPreviews((p) => ({ ...p, [selected.id]: { status: 'loading', text: '' } }));
    bridge.post({ type: 'preview', id: selected.id });
  }, [selected, previews]);

  useEffect(() => {
    if (!ui.selectedId) return;
    listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(ui.selectedId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [ui.selectedId]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && ui.selectedId) setUi((u) => ({ ...u, selectedId: null }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui.selectedId]);

  const categories = CATEGORIES.filter((c) => entries.some((e) => e.category === c));
  const filtered = ui.query.trim() !== '' || ui.category !== 'all' || ui.install !== 'all' || (!!ui.repo && ui.repo !== 'all');
  const forYou = (state?.forYou ?? [])
    .map((r) => ({ entry: entries.find((e) => e.id === r.id), reason: r.reason }))
    .filter((x): x is { entry: MarketplaceEntryView; reason: string } => !!x.entry && x.entry.installState === 'not-installed');
  const showForYou = !filtered && forYou.length > 0;

  let main;
  if (!state || (state.status === 'loading' && !state.catalog)) {
    main = (
      <div className="state-panel" role="status">
        <i className="codicon codicon-loading codicon-modifier-spin" aria-hidden />
        <span>Loading catalog…</span>
      </div>
    );
  } else if (!state.catalog) {
    main = (
      <div className="state-panel" role="status">
        <p className="state-title">Catalog unavailable</p>
        {state.error && <p className="is-error">{state.error}</p>}
        <button type="button" className="btn btn-primary" onClick={() => bridge.post({ type: 'refresh' })}>
          <i className="codicon codicon-refresh" aria-hidden /> Retry
        </button>
      </div>
    );
  } else if (visible.length === 0) {
    main = (
      <div className="state-panel" role="status">
        <p className="state-title">{entries.length === 0 ? 'The catalog has no skills yet' : 'No skills match the current filters'}</p>
        {entries.length > 0 && (
          <button type="button" className="btn btn-secondary" onClick={() => setUi((u) => ({ ...u, query: '', category: 'all', install: 'all', repo: 'all' }))}>
            Clear filters
          </button>
        )}
      </div>
    );
  } else {
    main = (
      <div className="mlist" role="list" aria-label="Catalog skills" ref={listRef}>
        {showForYou && (
          <>
            <div className="mgroup">
              <i className="codicon codicon-sparkle" aria-hidden /> For you <span className="muted">· based on the skills you use (recorded by SkillTree)</span>
            </div>
            {forYou.map((x) => (
              <Card key={`fy:${x.entry.id}`} entry={x.entry} state={state} reason={x.reason} selected={x.entry.id === ui.selectedId} onSelect={(id) => setUi((u) => ({ ...u, selectedId: id }))} />
            ))}
            <div className="mgroup">All skills</div>
          </>
        )}
        {shown.map((e) => (
          <Card key={e.id} entry={e} state={state} selected={e.id === ui.selectedId} onSelect={(id) => setUi((u) => ({ ...u, selectedId: id }))} />
        ))}
        {shown.length < visible.length && (
          <div className="mmore" ref={sentinelRef}>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => setLimit((n) => n + PAGE)}>
              Show more ({visible.length - shown.length} left)
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`app market ${narrow ? 'is-narrow' : ''}`}>
      <PageNav current="marketplace" onNavigate={(to) => bridge.post({ type: 'navigate', to })} />
      <header className="toolbar" role="toolbar" aria-label="Marketplace controls">
        <div className="search">
          <i className="codicon codicon-search" aria-hidden />
          <input
            type="search"
            placeholder="Search marketplace"
            aria-label="Search skills by name, repository or description"
            value={ui.query}
            onChange={(e) => setUi((u) => ({ ...u, query: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && ui.query) {
                e.preventDefault();
                setUi((u) => ({ ...u, query: '' }));
              }
            }}
          />
        </div>
        <select aria-label="Filter by category" value={ui.category} onChange={(e) => setUi((u) => ({ ...u, category: isCategoryOrAll(e.target.value) ? e.target.value : 'all' }))}>
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c} ({entries.filter((e) => e.category === c).length})
            </option>
          ))}
        </select>
        {repos.length > 1 && (
          <select aria-label="Filter by repository" className="mrepo-select" value={ui.repo ?? 'all'} onChange={(e) => setUi((u) => ({ ...u, repo: e.target.value }))}>
            <option value="all">All repositories ({repos.length})</option>
            {repos.map((r) => (
              <option key={r} value={r}>
                {r} · {repoCounts.get(r)} skills{repoStats[r] ? ` · ★ ${compact(repoStats[r].stars)}` : ''}
              </option>
            ))}
          </select>
        )}
        <select aria-label="Filter by install state" value={ui.install} onChange={(e) => setUi((u) => ({ ...u, install: e.target.value as UiState['install'] }))}>
          <option value="all">Any state</option>
          <option value="installed">Installed</option>
          <option value="not-installed">Not installed</option>
        </select>
        <select aria-label="Sort" value={ui.sort} onChange={(e) => setUi((u) => ({ ...u, sort: e.target.value as UiState['sort'] }))}>
          <option value="relevance">Sort: {ui.query.trim() ? 'relevance' : 'repository'}</option>
          <option value="updated">Sort: recently updated</option>
          <option value="name">Sort: name</option>
          {Object.keys(repoStats).length > 0 && <option value="stars">Sort: repository stars</option>}
        </select>
        <div className="toolbar-spacer" />
        <button type="button" className="icon-btn" aria-label="Refresh catalog" title="Refresh catalog" onClick={() => bridge.post({ type: 'refresh' })}>
          <i className={`codicon codicon-${state?.status === 'loading' ? 'loading codicon-modifier-spin' : 'refresh'}`} aria-hidden />
        </button>
      </header>
      {state && <Banner state={state} />}
      <div className="workspace">
        <main className="canvas mcanvas" aria-label="Marketplace">
          {main}
        </main>
        {selected && state && (
          <PreviewPane key={selected.id} entry={selected} state={state} preview={previews[selected.id]} narrow={narrow} onClose={() => setUi((u) => ({ ...u, selectedId: null }))} />
        )}
      </div>
      {state?.catalog && (
        <footer className="statusbar">
          <span>
            {filtered ? `${visible.length} of ${entries.length} skills` : `${entries.length} skills`}
            <span className="status-muted">
              {' '}
              · {entries.filter((e) => e.installState === 'installed' || e.installState === 'update-available').length} installed
              {(() => {
                const n = entries.filter((e) => e.kind !== 'skill').length;
                return n ? ` · ${n} plugin component${n === 1 ? '' : 's'} (not installable yet)` : '';
              })()}
            </span>
          </span>
          <span className="status-muted">Every entry is pinned to a commit</span>
        </footer>
      )}
    </div>
  );
}

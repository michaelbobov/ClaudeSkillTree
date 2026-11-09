import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CATEGORIES, SOURCE_LABELS, type Category, type SkillSource, type SkillTreeState } from '@shared/types';
import { coUsedSkills, filterSkills, type SkillFilter, type SkillOrder } from '@shared/graph';
import { loadUiState, onMessage, post, saveUiState, type PersistedUiState } from './vscodeBridge';
import { Toolbar } from './components/Toolbar';
import { GraphView, type GraphHandle } from './components/GraphView';
import { ListView } from './components/ListView';
import { Inspector, type BodyState } from './components/Inspector';
import { EmptyState, LoadingState, NoMatches } from './components/EmptyState';
import { StatusBar } from './components/StatusBar';
import { PageNav } from './components/PageNav';
import { LiveStrip, sessionKey } from './components/LiveStrip';
import { liveSessions } from '@shared/activity';

const SOURCES: SkillSource[] = ['project', 'nested', 'personal', 'synced', 'managed'];
const NARROW_WIDTH = 760;

const DEFAULT_UI: PersistedUiState = { query: '', source: 'all', category: 'all', view: 'graph', selectedId: null, order: 'name' };
const ORDERS: SkillOrder[] = ['name', 'recent', 'most'];

export function App() {
  const [state, setState] = useState<SkillTreeState | null>(null);
  const [ui, setUi] = useState<PersistedUiState>(() => ({ ...DEFAULT_UI, ...loadUiState() }));
  const [bodies, setBodies] = useState<Record<string, BodyState>>({});
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_WIDTH);
  const graphRef = useRef<GraphHandle>(null);
  // Clock for the Live strip: sessions drop off 10 minutes after their last recorded use.
  const [now, setNow] = useState(() => Date.now());
  const [liveFocus, setLiveFocus] = useState<string | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => saveUiState(ui), [ui]);

  useEffect(() => {
    const off = onMessage((msg) => {
      switch (msg.type) {
        case 'state':
          setState(msg.state);
          setNow(Date.now());
          // Invalidate cached bodies for skills whose file changed.
          setBodies((prev) => {
            const next: Record<string, BodyState> = {};
            for (const s of msg.state.skills) {
              const b = prev[s.id];
              if (b && b.modifiedAt === s.modifiedAt) next[s.id] = b;
            }
            return next;
          });
          break;
        case 'skillBody':
          setBodies((prev) => ({
            ...prev,
            [msg.id]: {
              status: msg.error ? 'error' : 'ready',
              markdown: msg.markdown,
              truncated: msg.truncated,
              error: msg.error,
              modifiedAt: prev[msg.id]?.modifiedAt,
            },
          }));
          break;
        case 'select':
          setUi((u) => ({ ...u, selectedId: msg.id, query: '', source: 'all', category: 'all' }));
          setTimeout(() => graphRef.current?.focusSkill(msg.id), 50);
          break;
      }
    });
    post({ type: 'ready' });
    return off;
  }, []);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < NARROW_WIDTH);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const skills = state?.skills ?? [];

  const filter: SkillFilter = useMemo(
    () => ({
      query: ui.query,
      sources: new Set(ui.source !== 'all' && (SOURCES as string[]).includes(ui.source) ? [ui.source as SkillSource] : []),
      categories: new Set(ui.category !== 'all' && (CATEGORIES as readonly string[]).includes(ui.category) ? [ui.category as Category] : []),
      includeShadowed: true,
    }),
    [ui.query, ui.source, ui.category],
  );

  const filtered = useMemo(() => filterSkills(skills, filter), [skills, filter]);
  const selected = useMemo(() => skills.find((s) => s.id === ui.selectedId) ?? null, [skills, ui.selectedId]);
  const isFiltered = ui.query.trim() !== '' || ui.source !== 'all' || ui.category !== 'all';
  const allActivity = state?.activity;
  const scope = ui.usageScope === 'here' && allActivity?.here ? 'here' : 'all';
  // "This project": the same summary limited to this workspace's folders. Live sessions stay global.
  const activity = useMemo(() => (allActivity && scope === 'here' && allActivity.here ? { ...allActivity, ...allActivity.here } : allActivity), [allActivity, scope]);
  const live = useMemo(() => (allActivity?.recent ? liveSessions(allActivity.recent, now, undefined, allActivity.ended) : []), [allActivity, now]);
  const focusSession = live.find((l) => sessionKey(l) === liveFocus) ?? null;
  const sessionKeys = useMemo(() => (focusSession ? new Set(focusSession.skills) : null), [focusSession]);
  const hasUsage = !!activity && Object.keys(activity.bySkill).length > 0;
  const order: SkillOrder = hasUsage && ORDERS.includes(ui.order as SkillOrder) ? (ui.order as SkillOrder) : 'name';
  const coUsed = useMemo(() => (selected ? coUsedSkills(selected, filtered, activity) : []), [selected, filtered, activity]);

  // Request the Markdown body when a skill is selected (or its file changed).
  useEffect(() => {
    if (!selected) return;
    const cached = bodies[selected.id];
    if (cached && cached.modifiedAt === selected.modifiedAt && cached.status !== 'loading') return;
    if (cached?.status === 'loading') return;
    setBodies((prev) => ({ ...prev, [selected.id]: { status: 'loading', markdown: '', truncated: false, modifiedAt: selected.modifiedAt } }));
    post({ type: 'getSkillBody', id: selected.id });
  }, [selected, bodies]);

  const select = useCallback((id: string | null) => setUi((u) => ({ ...u, selectedId: id })), []);
  const openSkill = useCallback((id: string) => post({ type: 'openSkill', id }), []);
  const clearFilters = useCallback(() => setUi((u) => ({ ...u, query: '', source: 'all', category: 'all' })), []);

  const sourceCounts = useMemo(() => {
    const counts = new Map<SkillSource, number>();
    for (const s of skills) counts.set(s.source, (counts.get(s.source) ?? 0) + 1);
    return counts;
  }, [skills]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<Category, number>();
    for (const s of skills) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    return counts;
  }, [skills]);

  const sourceOptions = SOURCES.filter((s) => (sourceCounts.get(s) ?? 0) > 0 || s === 'project' || s === 'personal').map((s) => ({
    value: s,
    label: `${SOURCE_LABELS[s]} (${sourceCounts.get(s) ?? 0})`,
  }));

  let main: ReactNode;
  if (!state || (state.status === 'loading' && state.scannedAt === null)) {
    main = <LoadingState />;
  } else if (state.status === 'error' && skills.length === 0) {
    main = <EmptyState state={state} error={state.error} />;
  } else if (skills.length === 0) {
    main = <EmptyState state={state} />;
  } else if (filtered.length === 0) {
    main = <NoMatches onClear={clearFilters} />;
  } else if (ui.view === 'list') {
    main = <ListView skills={filtered} selectedId={ui.selectedId} onSelect={select} onOpen={openSkill} activity={activity} order={order} sessionKeys={sessionKeys} />;
  } else {
    main = (
      <GraphView
        ref={graphRef}
        skills={filtered}
        workspaceName={state.workspaceName}
        totalCount={skills.length}
        locationCount={state.roots.filter((r) => r.skillCount > 0).length}
        positions={state.positions}
        collapsed={state.collapsed}
        selectedId={ui.selectedId}
        onSelect={select}
        onOpen={openSkill}
        layoutKey={`${ui.query}|${ui.source}|${ui.category}|${order}`}
        activity={activity}
        order={order}
        sessionKeys={sessionKeys}
      />
    );
  }

  const showInspector = !!selected;
  const hasContent = !!state && skills.length > 0;

  return (
    <div className={`app ${narrow ? 'is-narrow' : ''}`}>
      <PageNav current="tree" onNavigate={(to) => post({ type: 'navigate', to })} />
      <Toolbar
        query={ui.query}
        onQuery={(query) => setUi((u) => ({ ...u, query }))}
        source={ui.source}
        sourceOptions={sourceOptions}
        totalCount={skills.length}
        onSource={(source) => setUi((u) => ({ ...u, source }))}
        category={ui.category}
        categoryOptions={CATEGORIES.filter((c) => (categoryCounts.get(c) ?? 0) > 0).map((c) => ({ value: c, label: `${c} (${categoryCounts.get(c)})` }))}
        onCategory={(category) => setUi((u) => ({ ...u, category }))}
        view={ui.view}
        onView={(view) => setUi((u) => ({ ...u, view }))}
        order={order}
        orderEnabled={hasUsage}
        onOrder={(o) => setUi((u) => ({ ...u, order: o }))}
        graphControls={ui.view === 'graph' && hasContent && filtered.length > 0}
        onZoomIn={() => graphRef.current?.zoomIn()}
        onZoomOut={() => graphRef.current?.zoomOut()}
        onFit={() => graphRef.current?.fit()}
        onResetLayout={() => post({ type: 'resetLayout' })}
        onRescan={() => post({ type: 'rescan' })}
        scanning={state?.status === 'loading'}
        disabled={!hasContent}
      />
      {hasContent && live.length > 0 && <LiveStrip sessions={live} focus={focusSession ? liveFocus : null} onFocus={setLiveFocus} now={now} />}
      <div className="workspace">
        <main className="canvas" aria-label="Skill Tree">
          {main}
        </main>
        {showInspector && selected && (
          <Inspector
            key={selected.id}
            skill={selected}
            activity={activity}
            coUsed={coUsed}
            allSkills={skills}
            body={bodies[selected.id]}
            narrow={narrow}
            onClose={() => select(null)}
            onSelect={select}
          />
        )}
      </div>
      {state && (
        <StatusBar
          state={state}
          activity={activity}
          scope={allActivity?.here ? scope : null}
          onScope={(usageScope) => setUi((u) => ({ ...u, usageScope }))}
          shown={filtered.length}
          filtered={isFiltered}
          view={ui.view}
          showActivityLegend={ui.view === 'graph' && coUsed.length > 0}
        />
      )}
    </div>
  );
}

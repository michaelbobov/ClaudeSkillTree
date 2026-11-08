import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getNodesBounds,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import type { ActivitySummaryState, Category, NodePosition, OrganizedSkill } from '@shared/types';
import { LAYOUT, buildGraph, coUsedSkills, neighbourSkill, pathEdgeIds, skillCompare, skillNodeId, type GraphNode, type SkillOrder } from '@shared/graph';
import { usageFor, type SkillUsage } from '@shared/activity';
import { unusedDays } from '@shared/recommend';
import { post } from '../vscodeBridge';
import { CategoryDot, shortAgo, sourceIcon, sourceText, usageTitle } from './common';

export interface GraphHandle {
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  focusSkill(id: string): void;
}

interface GraphViewProps {
  skills: OrganizedSkill[];
  workspaceName: string | null;
  totalCount: number;
  locationCount: number;
  positions: Record<string, NodePosition>;
  collapsed: Category[];
  selectedId: string | null;
  onSelect(id: string | null): void;
  onOpen(id: string): void;
  /** Changes when filters change, to refit the view. */
  layoutKey: string;
  /** Recorded use (opt-in hooks only). */
  activity?: ActivitySummaryState;
  order: SkillOrder;
}

type RootData = { label: string; detail: string };
type CategoryData = { category: Category; count: number; collapsed: boolean; width: number; onToggle(c: Category): void };
type SkillData = { skill: OrganizedSkill; highlighted: boolean; related: boolean; usage?: SkillUsage; unused: number | null };
type OrgEdgeData = { shape: 'step' | 'elbow'; highlighted: boolean; trunkOffset?: number };
type ActEdgeData = { sessions: number; sameColumn: boolean };

type RootNodeT = Node<RootData, 'root'>;
type CategoryNodeT = Node<CategoryData, 'category'>;
type SkillNodeT = Node<SkillData, 'skill'>;
type FlowNode = RootNodeT | CategoryNodeT | SkillNodeT;
type OrgEdgeT = Edge<OrgEdgeData, 'org'>;
type ActEdgeT = Edge<ActEdgeData, 'activity'>;
type FlowEdge = OrgEdgeT | ActEdgeT;

// Honour both the OS setting and VS Code's own "Reduce Motion" setting (body.vscode-reduce-motion).
const reducedMotion = () =>
  document.body.classList.contains('vscode-reduce-motion') || (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
const duration = () => (reducedMotion() ? 0 : 100);

const hiddenHandle = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0, pointerEvents: 'none' as const };

const RootNode = memo(function RootNode({ data }: NodeProps<RootNodeT>) {
  return (
    <div className="gnode gnode-root" style={{ width: LAYOUT.nodeWidth }}>
      <i className="codicon codicon-root-folder" aria-hidden />
      <div className="gnode-text">
        <div className="gnode-title">{data.label}</div>
        <div className="gnode-sub">{data.detail}</div>
      </div>
      <Handle type="source" position={Position.Bottom} style={hiddenHandle} isConnectable={false} />
    </div>
  );
});

const CategoryNode = memo(function CategoryNode({ data }: NodeProps<CategoryNodeT>) {
  return (
    <div className="gnode gnode-category" style={{ width: data.width }}>
      <Handle type="target" position={Position.Top} style={hiddenHandle} isConnectable={false} />
      <button
        type="button"
        className="gnode-toggle nodrag"
        aria-label={`${data.collapsed ? 'Expand' : 'Collapse'} ${data.category}`}
        aria-expanded={!data.collapsed}
        onClick={(e) => {
          e.stopPropagation();
          data.onToggle(data.category);
        }}
      >
        <i className={`codicon codicon-chevron-${data.collapsed ? 'right' : 'down'}`} aria-hidden />
      </button>
      <CategoryDot category={data.category} />
      <span className="gnode-title">{data.category}</span>
      <span className="gnode-count">{data.count}</span>
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ ...hiddenHandle, left: LAYOUT.skillIndent / 2 }}
        isConnectable={false}
      />
    </div>
  );
});

const SkillNode = memo(function SkillNode({ data, selected }: NodeProps<SkillNodeT>) {
  const s = data.skill;
  const u = data.usage;
  const hasError = s.issues.some((i) => i.level === 'error');
  const hasWarning = !hasError && s.issues.some((i) => i.level === 'warning');
  const where = `${sourceText(s)}${s.shadowedBy ? ' · shadowed by a higher-precedence skill' : ''}`;
  return (
    <div
      className={`gnode gnode-skill ${selected ? 'is-selected' : ''} ${data.highlighted ? 'is-highlighted' : ''} ${data.related ? 'is-related' : ''} ${s.shadowedBy ? 'is-shadowed' : ''}`}
      style={{ width: LAYOUT.nodeWidth - LAYOUT.skillIndent }}
      title={`${s.command}\n${where}${s.description ? `\n\n${s.description.slice(0, 300)}${s.description.length > 300 ? '…' : ''}` : ''}`}
    >
      <Handle type="target" position={Position.Left} style={hiddenHandle} isConnectable={false} />
      {/* Activity (co-usage) edges attach left or right depending on where the other node is. */}
      <Handle id="out-r" type="source" position={Position.Right} style={hiddenHandle} isConnectable={false} />
      <Handle id="out-l" type="source" position={Position.Left} style={hiddenHandle} isConnectable={false} />
      <Handle id="in-r" type="target" position={Position.Right} style={hiddenHandle} isConnectable={false} />
      <Handle id="in-l" type="target" position={Position.Left} style={hiddenHandle} isConnectable={false} />
      <span className={`gnode-bar cat-${s.category.toLowerCase()}`} aria-hidden />
      <div className="gnode-text">
        <div className="gnode-line">
          <span className="gnode-title">{s.name}</span>
          {hasError && <i className="codicon codicon-error gnode-issue is-error" aria-label="Has errors" />}
          {hasWarning && <i className="codicon codicon-warning gnode-issue is-warning" aria-label="Has warnings" />}
          {u && (
            <span className="gnode-usage" title={usageTitle(u)}>
              {u.count}× · {shortAgo(u.lastTs)}
            </span>
          )}
          {!u && data.unused !== null && (
            <span className="gnode-unused" title={`No recorded use in ${data.unused} days of usage tracking`}>
              unused
            </span>
          )}
        </div>
        <div className="gnode-line">
          <span className="gnode-sub">{s.description || <em>No description</em>}</span>
          <i className={`codicon codicon-${sourceIcon(s)} gnode-src`} title={where} aria-hidden />
        </div>
      </div>
    </div>
  );
});

function OrgEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<OrgEdgeT>) {
  let d: string;
  if (data?.shape === 'elbow') {
    // File-explorer style: vertical trunk, then a short horizontal tick into the node. Wrapped
    // columns get their own trunk, starting under the (wider) category header.
    const x0 = sourceX + (data.trunkOffset ?? 0);
    const r = Math.min(4, Math.abs(targetY - sourceY), Math.abs(targetX - x0));
    const dir = targetX >= x0 ? 1 : -1;
    d = `M ${x0} ${sourceY} L ${x0} ${targetY - r} Q ${x0} ${targetY} ${x0 + dir * r} ${targetY} L ${targetX} ${targetY}`;
  } else {
    const midY = sourceY + Math.max(12, (targetY - sourceY) / 2);
    d = `M ${sourceX} ${sourceY} L ${sourceX} ${midY} L ${targetX} ${midY} L ${targetX} ${targetY}`;
  }
  return <path id={id} d={d} className={`gedge gedge-org ${data?.highlighted ? 'is-highlighted' : ''}`} fill="none" />;
}

/** Dashed: the two skills were recorded in the same Claude Code session(s). Not a dependency. */
function ActivityEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<ActEdgeT>) {
  let d: string;
  if (data?.sameColumn) {
    const bulge = 28 + Math.min(60, Math.abs(targetY - sourceY) / 6);
    d = `M ${sourceX} ${sourceY} C ${sourceX + bulge} ${sourceY}, ${targetX + bulge} ${targetY}, ${targetX} ${targetY}`;
  } else {
    const mx = (sourceX + targetX) / 2;
    d = `M ${sourceX} ${sourceY} C ${mx} ${sourceY}, ${mx} ${targetY}, ${targetX} ${targetY}`;
  }
  return <path id={id} d={d} className="gedge gedge-activity" fill="none" />;
}

const nodeTypes = { root: RootNode, category: CategoryNode, skill: SkillNode };
const edgeTypes = { org: OrgEdge, activity: ActivityEdge };

function toFlowNodes(
  graphNodes: GraphNode[],
  byId: Map<string, OrganizedSkill>,
  rootData: RootData,
  onToggle: (c: Category) => void,
  activity: ActivitySummaryState | undefined,
  showUnused: boolean,
): FlowNode[] {
  const out: FlowNode[] = [];
  for (const n of graphNodes) {
    if (n.kind === 'root') {
      out.push({ id: n.id, type: 'root', position: n.position, data: rootData, selectable: false, focusable: false, draggable: false, width: LAYOUT.nodeWidth, height: LAYOUT.rootHeight });
    } else if (n.kind === 'category' && n.category) {
      const width = (n.span ?? 1) * (LAYOUT.nodeWidth + LAYOUT.columnGap) - LAYOUT.columnGap;
      out.push({
        id: n.id,
        type: 'category',
        position: n.position,
        data: { category: n.category, count: n.count ?? 0, collapsed: !!n.collapsed, width, onToggle },
        selectable: false,
        focusable: false,
        width,
        height: LAYOUT.categoryHeight,
      });
    } else if (n.kind === 'skill' && n.skillId) {
      const skill = byId.get(n.skillId);
      if (!skill) continue;
      const usage = usageFor(activity, skill);
      const unused = showUnused ? unusedDays(skill, activity) : null;
      out.push({
        id: n.id,
        type: 'skill',
        position: n.position,
        data: { skill, highlighted: false, related: false, usage, unused },
        // Fixed dimensions make bounds exact before the DOM is measured (initial viewport).
        width: LAYOUT.nodeWidth - LAYOUT.skillIndent,
        height: LAYOUT.skillHeight,
        ariaLabel: `${skill.name}, ${skill.category}, ${sourceText(skill)}${usage ? `, ${usage.count} recorded uses` : ''}`,
      } as SkillNodeT);
    }
  }
  return out;
}

const GraphInner = forwardRef<GraphHandle, GraphViewProps>(function GraphInner(props, ref) {
  const { skills, workspaceName, totalCount, locationCount, positions, collapsed, selectedId, onSelect, onOpen, layoutKey, activity, order } = props;
  const flow = useReactFlow<FlowNode, FlowEdge>();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [localCollapsed, setLocalCollapsed] = useState<Set<Category>>(() => new Set(collapsed));
  const localPositions = useRef<Record<string, NodePosition>>({});

  useEffect(() => setLocalCollapsed(new Set(collapsed)), [collapsed]);
  useEffect(() => {
    // Host positions changed (e.g. reset layout): drop local drag overrides.
    localPositions.current = {};
  }, [positions]);

  const collapsedRef = useRef(localCollapsed);
  collapsedRef.current = localCollapsed;
  const onToggle = useCallback((c: Category) => {
    const next = new Set(collapsedRef.current);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    setLocalCollapsed(next);
    post({ type: 'setCollapsed', categories: [...next] });
  }, []);

  const compare = useMemo(() => skillCompare(order, activity), [order, activity]);
  const graph = useMemo(
    () => buildGraph(skills, { collapsed: localCollapsed, positions: { ...positions, ...localPositions.current }, compare }),
    [skills, localCollapsed, positions, compare],
  );
  const byId = useMemo(() => new Map(skills.map((s) => [s.id, s])), [skills]);
  const rootData = useMemo<RootData>(
    () => ({
      label: workspaceName ?? 'No folder open',
      detail: `${skills.length === totalCount ? totalCount : `${skills.length} of ${totalCount}`} skills · ${locationCount} location${locationCount === 1 ? '' : 's'}`,
    }),
    [workspaceName, skills.length, totalCount, locationCount],
  );

  // "unused" markers only when sorting by use, where usage is what you are looking at.
  const showUnused = order !== 'name';
  const [nodes, setNodes] = useState<FlowNode[]>(() => toFlowNodes(graph.nodes, byId, rootData, onToggle, activity, showUnused));
  useEffect(() => setNodes(toFlowNodes(graph.nodes, byId, rootData, onToggle, activity, showUnused)), [graph, byId, rootData, onToggle, activity, showUnused]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const selectedNodeId = selectedId ? skillNodeId(selectedId) : null;
  const highlightFrom = hoverId ?? selectedNodeId;
  const highlighted = useMemo(() => (highlightFrom ? pathEdgeIds(highlightFrom, graph.edges) : new Set<string>()), [highlightFrom, graph.edges]);

  // Recorded co-usage of the selected skill (dashed edges). Shown for the selection only, to keep the graph calm.
  const coUsed = useMemo(() => {
    const sel = selectedId ? byId.get(selectedId) : undefined;
    return sel ? coUsedSkills(sel, skills, activity) : [];
  }, [selectedId, byId, skills, activity]);
  const relatedIds = useMemo(() => new Set(coUsed.map((c) => skillNodeId(c.skill.id))), [coUsed]);

  const renderedNodes = useMemo(
    () =>
      nodes.map((n) => {
        if (n.type !== 'skill') return n;
        const isSel = n.id === selectedNodeId;
        const isHl = n.id === highlightFrom;
        const isRel = relatedIds.has(n.id);
        if (n.selected === isSel && n.data.highlighted === isHl && n.data.related === isRel) return n;
        return { ...n, selected: isSel, data: { ...n.data, highlighted: isHl, related: isRel } };
      }),
    [nodes, selectedNodeId, highlightFrom, relatedIds],
  );

  const edges = useMemo<FlowEdge[]>(() => {
    const org: FlowEdge[] = graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'org',
      selectable: false,
      focusable: false,
      data: { shape: e.shape, highlighted: highlighted.has(e.id), trunkOffset: e.trunkOffset },
    }));
    if (!selectedNodeId || coUsed.length === 0) return org;
    const pos = new Map(nodes.map((n) => [n.id, n.position]));
    const from = pos.get(selectedNodeId);
    if (!from) return org;
    const act: FlowEdge[] = [];
    for (const c of coUsed) {
      const target = skillNodeId(c.skill.id);
      const to = pos.get(target);
      if (!to) continue;
      const sameColumn = Math.abs(to.x - from.x) < LAYOUT.nodeWidth / 2;
      const right = sameColumn || to.x > from.x;
      act.push({
        id: `a:${selectedNodeId}->${target}`,
        source: selectedNodeId,
        target,
        sourceHandle: right ? 'out-r' : 'out-l',
        targetHandle: sameColumn || !right ? 'in-r' : 'in-l',
        type: 'activity',
        selectable: false,
        focusable: false,
        data: { sessions: c.sessions, sameColumn },
      });
    }
    return [...org, ...act];
  }, [graph.edges, highlighted, selectedNodeId, coUsed, nodes]);

  /**
   * Readable initial view: fit the whole graph when that keeps text legible; otherwise fit the
   * width (all categories visible) at a readable zoom and anchor to the top so long category
   * columns scroll instead of shrinking every label.
   */
  const showOverview = useCallback(
    (animate: boolean) => {
      const el = wrapperRef.current;
      const all = flow.getNodes();
      if (!el || all.length === 0 || el.clientWidth === 0 || el.clientHeight === 0) return false;
      const b = getNodesBounds(all);
      const pad = 32;
      const vw = el.clientWidth - pad * 2;
      const vh = el.clientHeight - pad * 2;
      const fitAll = Math.min(vw / b.width, vh / b.height, 1);
      const READABLE = 0.85;
      if (fitAll >= READABLE) {
        void flow.fitView({ padding: 0.12, maxZoom: 1, duration: animate ? duration() : 0 });
        return true;
      }
      const zoom = Math.max(Math.min(vw / b.width, READABLE), 0.3);
      const x = (el.clientWidth - b.width * zoom) / 2 - b.x * zoom;
      const y = pad - b.y * zoom;
      void flow.setViewport({ x, y, zoom }, { duration: animate ? duration() : 0 });
      return true;
    },
    [flow],
  );

  // Overview on first render and whenever filters change. The key is recorded only once the
  // overview succeeded, so a cancelled attempt (StrictMode remount, unmeasured nodes) retries.
  const doneKey = useRef<string | null>(null);
  useEffect(() => {
    if (doneKey.current === layoutKey) return;
    const first = doneKey.current === null;
    let tries = 0;
    let handle: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      if (showOverview(!first)) {
        doneKey.current = layoutKey;
        return;
      }
      if (++tries <= 40) handle = setTimeout(attempt, 25);
    };
    handle = setTimeout(attempt, 0);
    return () => clearTimeout(handle);
  }, [layoutKey, showOverview]);

  const ensureVisible = useCallback(
    (nodeId: string) => {
      const node = flow.getNode(nodeId);
      const el = wrapperRef.current;
      if (!node || !el) return;
      const { x, y, zoom } = flow.getViewport();
      const w = (node.measured?.width ?? LAYOUT.nodeWidth) * zoom;
      const h = (node.measured?.height ?? LAYOUT.skillHeight) * zoom;
      const sx = node.position.x * zoom + x;
      const sy = node.position.y * zoom + y;
      const margin = 24;
      if (sx < margin || sy < margin || sx + w > el.clientWidth - margin || sy + h > el.clientHeight - margin) {
        void flow.setCenter(node.position.x + w / zoom / 2, node.position.y + h / zoom / 2, { zoom, duration: duration() });
      }
    },
    [flow],
  );

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => void flow.zoomIn({ duration: duration() }),
      zoomOut: () => void flow.zoomOut({ duration: duration() }),
      fit: () => void flow.fitView({ padding: 0.12, maxZoom: 1, duration: duration() }),
      focusSkill: (id: string) => {
        const nodeId = skillNodeId(id);
        const node = flow.getNode(nodeId);
        if (node) void flow.setCenter(node.position.x + LAYOUT.nodeWidth / 2, node.position.y + LAYOUT.skillHeight / 2, { zoom: Math.max(flow.getZoom(), 0.9), duration: duration() });
      },
    }),
    [flow],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      // Selection is controlled by the app; apply only position/dimension changes here.
      const relevant = changes.filter((c) => c.type !== 'select');
      for (const c of changes) {
        if (c.type === 'select' && c.selected && c.id.startsWith('skill:')) onSelect(c.id.slice('skill:'.length));
      }
      // Dragging a category moves its skills with it, so a column stays together.
      const current = nodesRef.current;
      const extra: NodeChange<FlowNode>[] = [];
      for (const c of relevant) {
        if (c.type !== 'position' || !c.position || !c.id.startsWith('cat:')) continue;
        const prev = current.find((n) => n.id === c.id);
        if (!prev || prev.type !== 'category') continue;
        const dx = c.position.x - prev.position.x;
        const dy = c.position.y - prev.position.y;
        if (dx === 0 && dy === 0) continue;
        for (const child of current) {
          if (child.type === 'skill' && child.data.skill.category === prev.data.category) {
            extra.push({ type: 'position', id: child.id, position: { x: child.position.x + dx, y: child.position.y + dy }, dragging: c.dragging });
          }
        }
      }
      const all = extra.length ? [...relevant, ...extra] : relevant;
      if (all.length) setNodes((ns) => applyNodeChanges(all, ns));
    },
    [onSelect],
  );

  const onNodeDragStop = useCallback((_e: unknown, _node: FlowNode, dragged: FlowNode[]) => {
    const patch: Record<string, NodePosition> = {};
    const ids = new Set(dragged.map((n) => n.id));
    const draggedCats = new Set(dragged.filter((n) => n.type === 'category').map((n) => (n as CategoryNodeT).data.category));
    for (const n of nodesRef.current) {
      const moved = ids.has(n.id) || (n.type === 'skill' && draggedCats.has(n.data.skill.category));
      if (moved) patch[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    }
    localPositions.current = { ...localPositions.current, ...patch };
    post({ type: 'savePositions', positions: patch });
  }, []);

  const onKeyDownCapture = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, select, textarea, button')) return;
      const focusedId = target.closest<HTMLElement>('.react-flow__node')?.dataset.id;
      const focusedSkillNode = focusedId?.startsWith('skill:') ? focusedId : null;
      const dirs: Record<string, 'up' | 'down' | 'left' | 'right'> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
      const dir = dirs[e.key];
      if (dir) {
        // Prevent React Flow from moving the node with arrow keys; navigate instead.
        e.preventDefault();
        e.stopPropagation();
        const graphNodes = graph.nodes;
        const from = focusedSkillNode ?? selectedNodeId;
        const next = from ? neighbourSkill(graphNodes, from, dir) : graphNodes.find((n) => n.kind === 'skill')?.id ?? null;
        if (next) {
          onSelect(next.slice('skill:'.length));
          ensureVisible(next);
          const el = wrapperRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(next)}"]`);
          el?.focus({ preventScroll: true });
        }
        return;
      }
      if (e.key === 'Enter') {
        // Enter on a focused, unselected node selects it; Enter again opens SKILL.md.
        const id = focusedSkillNode ? focusedSkillNode.slice('skill:'.length) : selectedId;
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        if (id !== selectedId) onSelect(id);
        else onOpen(id);
      } else if (e.key === 'Escape' && selectedId) {
        e.preventDefault();
        onSelect(null);
      }
    },
    [graph.nodes, selectedNodeId, selectedId, onSelect, onOpen, ensureVisible],
  );

  return (
    <div className="graph" ref={wrapperRef} onKeyDownCapture={onKeyDownCapture}>
      <ReactFlow<FlowNode, FlowEdge>
        nodes={renderedNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_e, n) => {
          if (n.type === 'skill') onSelect(n.data.skill.id);
        }}
        onNodeDoubleClick={(_e, n) => {
          if (n.type === 'skill') onOpen(n.data.skill.id);
        }}
        onNodeMouseEnter={(_e, n) => setHoverId(n.type === 'skill' ? n.id : null)}
        onNodeMouseLeave={() => setHoverId(null)}
        onPaneClick={() => onSelect(null)}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable
        selectNodesOnDrag={false}
        multiSelectionKeyCode={null}
        deleteKeyCode={null}
        selectionKeyCode={null}
        minZoom={0.15}
        maxZoom={2}
        zoomOnDoubleClick={false}
        // Wheel/trackpad scrolls the canvas like an editor; Cmd/Ctrl+wheel or pinch zooms.
        panOnScroll
        zoomOnPinch
        zoomActivationKeyCode={['Meta', 'Control']}
        proOptions={{ hideAttribution: true }}
        aria-label="Skill graph: workspace, categories and skills"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} className="graph-bg" />
      </ReactFlow>
    </div>
  );
});

export const GraphView = forwardRef<GraphHandle, GraphViewProps>(function GraphView(props, ref) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} ref={ref} />
    </ReactFlowProvider>
  );
});

// Graph data (filtering + layout). Pure and framework-free: used by the webview and unit tests.
//
// Layout: Workspace (root) → Category → Skill, top-down. Category columns sit side by side; skills
// stack beneath their category like a file-explorer indent, wrapping into extra columns when a
// category is long. All edges built here are *organization* edges (derived from categories); they
// are not dependencies or usage. Recorded co-usage is exposed separately (coUsedSkills).

import { CATEGORIES, type Category, type NodePosition, type OrganizedSkill, type SkillSource } from './types';
import { usageFor, usageKeys, type UsageSummary } from './activity';

export interface SkillFilter {
  query: string;
  /** Empty set = all sources. */
  sources: ReadonlySet<SkillSource>;
  /** Empty set = all categories. */
  categories: ReadonlySet<Category>;
  /** Show skills that are shadowed by a higher-precedence skill of the same name. */
  includeShadowed: boolean;
}

export const EMPTY_FILTER: SkillFilter = {
  query: '',
  sources: new Set(),
  categories: new Set(),
  includeShadowed: true,
};

function haystack(s: OrganizedSkill): string {
  return [s.name, s.dirName, s.command, s.description, s.category, s.rootLabel, s.displayPath, s.source]
    .join('\n')
    .toLowerCase();
}

/** Whitespace-separated terms; every term must match (AND). */
export function matchesQuery(s: OrganizedSkill, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = haystack(s);
  return terms.every((t) => text.includes(t));
}

export function filterSkills(skills: readonly OrganizedSkill[], filter: SkillFilter): OrganizedSkill[] {
  return skills.filter(
    (s) =>
      (filter.sources.size === 0 || filter.sources.has(s.source)) &&
      (filter.categories.size === 0 || filter.categories.has(s.category)) &&
      (filter.includeShadowed || !s.shadowedBy) &&
      matchesQuery(s, filter.query),
  );
}

export type SkillCompare = (a: OrganizedSkill, b: OrganizedSkill) => number;

export const byName: SkillCompare = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

/** Groups skills by category in canonical category order; within a category, by `compare` (default: name). */
export function groupByCategory(skills: readonly OrganizedSkill[], compare: SkillCompare = byName): { category: Category; skills: OrganizedSkill[] }[] {
  const groups = new Map<Category, OrganizedSkill[]>();
  for (const s of skills) {
    const list = groups.get(s.category) ?? [];
    list.push(s);
    groups.set(s.category, list);
  }
  return CATEGORIES.filter((c) => groups.has(c)).map((category) => ({
    category,
    skills: (groups.get(category) ?? []).sort((a, b) => compare(a, b) || byName(a, b)),
  }));
}

/** Within-category order. Usage orders use recorded events only; skills without any keep name order after them. */
export type SkillOrder = 'name' | 'recent' | 'most';

export function skillCompare(order: SkillOrder, usage: Pick<UsageSummary, 'bySkill'> | undefined): SkillCompare {
  if (order === 'name' || !usage) return byName;
  return (a, b) => {
    const ua = usageFor(usage, a);
    const ub = usageFor(usage, b);
    if (!ua || !ub) return ua ? -1 : ub ? 1 : 0;
    return order === 'recent' ? ub.lastTs.localeCompare(ua.lastTs) || ub.count - ua.count : ub.count - ua.count || ub.lastTs.localeCompare(ua.lastTs);
  };
}

export type GraphNodeKind = 'root' | 'category' | 'skill';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  position: NodePosition;
  /** Present for skill nodes. */
  skillId?: string;
  category?: Category;
  /** Category nodes: number of skills (after filtering) and whether children are hidden. */
  count?: number;
  collapsed?: boolean;
  /** Category nodes: how many skill columns the category spans (long categories wrap). */
  span?: number;
  /** Column index for keyboard navigation (skills/categories). */
  column?: number;
  row?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** Organization edges (solid) come from categories. Activity edges (dashed) are added by the view for recorded co-usage. */
  relation: 'organization';
  /** Category → skill edges render as explorer-style elbows, root → category as orthogonal steps. */
  shape: 'step' | 'elbow';
  /** Elbow edges into a wrapped column: horizontal offset of that column's trunk from the category's. */
  trunkOffset?: number;
}

export const LAYOUT = {
  nodeWidth: 232,
  columnGap: 24,
  rootHeight: 44,
  categoryHeight: 32,
  skillHeight: 44,
  skillPitch: 52,
  rootToCategory: 72,
  categoryToFirstSkill: 18,
  skillIndent: 18,
};

export const ROOT_ID = 'root';
export const categoryNodeId = (c: Category) => `cat:${c}`;
export const skillNodeId = (skillId: string) => `skill:${skillId}`;

/** Rows per column before a category wraps into another column: grows slowly with the total. */
export function autoMaxRows(total: number): number {
  return Math.max(8, Math.ceil(Math.sqrt(total) * 1.5));
}

export function buildGraph(
  skills: readonly OrganizedSkill[],
  opts: { collapsed?: ReadonlySet<Category>; positions?: Record<string, NodePosition>; compare?: SkillCompare; maxRows?: number } = {},
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const collapsed = opts.collapsed ?? new Set<Category>();
  const positions = opts.positions ?? {};
  const groups = groupByCategory(skills, opts.compare);
  const maxRows = Math.max(1, opts.maxRows ?? autoMaxRows(skills.length));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const colWidth = LAYOUT.nodeWidth + LAYOUT.columnGap;

  // Long categories wrap into several balanced columns under one wider header.
  const spans = groups.map((g) => (collapsed.has(g.category) ? 1 : Math.max(1, Math.ceil(g.skills.length / maxRows))));
  const totalColumns = Math.max(1, spans.reduce((a, b) => a + b, 0));
  const totalWidth = totalColumns * colWidth - LAYOUT.columnGap;

  const place = (id: string, auto: NodePosition): NodePosition => positions[id] ?? auto;

  nodes.push({
    id: ROOT_ID,
    kind: 'root',
    position: place(ROOT_ID, { x: Math.round(totalWidth / 2 - LAYOUT.nodeWidth / 2), y: 0 }),
    count: skills.length,
  });

  const catY = LAYOUT.rootHeight + LAYOUT.rootToCategory;
  let firstColumn = 0;
  groups.forEach((group, i) => {
    const span = spans[i];
    const catId = categoryNodeId(group.category);
    const isCollapsed = collapsed.has(group.category);
    const x = firstColumn * colWidth;
    nodes.push({
      id: catId,
      kind: 'category',
      category: group.category,
      count: group.skills.length,
      collapsed: isCollapsed,
      span,
      position: place(catId, { x, y: catY }),
      column: firstColumn,
      row: -1,
    });
    edges.push({ id: `e:${ROOT_ID}->${catId}`, source: ROOT_ID, target: catId, relation: 'organization', shape: 'step' });
    if (!isCollapsed) {
      const rowsPerColumn = Math.ceil(group.skills.length / span);
      group.skills.forEach((skill, index) => {
        const sub = Math.floor(index / rowsPerColumn);
        const row = index % rowsPerColumn;
        const nodeId = skillNodeId(skill.id);
        nodes.push({
          id: nodeId,
          kind: 'skill',
          skillId: skill.id,
          category: group.category,
          position: place(nodeId, {
            x: x + sub * colWidth + LAYOUT.skillIndent,
            y: catY + LAYOUT.categoryHeight + LAYOUT.categoryToFirstSkill + row * LAYOUT.skillPitch,
          }),
          column: firstColumn + sub,
          row,
        });
        edges.push({
          id: `e:${catId}->${nodeId}`,
          source: catId,
          target: nodeId,
          relation: 'organization',
          shape: 'elbow',
          ...(sub > 0 ? { trunkOffset: sub * colWidth } : {}),
        });
      });
    }
    firstColumn += span;
  });

  return { nodes, edges };
}

/**
 * Skills recorded in the same Claude Code sessions as `skill`, among `visible` skills, most shared
 * sessions first. Recorded co-occurrence only: it does not mean one skill caused or needs the other.
 */
export function coUsedSkills(
  skill: OrganizedSkill,
  visible: readonly OrganizedSkill[],
  usage: Pick<UsageSummary, 'coUsage'> | undefined,
  max = 8,
): { skill: OrganizedSkill; sessions: number }[] {
  if (!usage || usage.coUsage.length === 0) return [];
  const mine = new Set(usageKeys(skill));
  const byKey = new Map<string, OrganizedSkill>();
  for (const s of visible) {
    if (s.id === skill.id) continue;
    for (const k of usageKeys(s)) if (!byKey.has(k)) byKey.set(k, s);
  }
  const out = new Map<string, { skill: OrganizedSkill; sessions: number }>();
  for (const p of usage.coUsage) {
    const other = mine.has(p.a) ? p.b : mine.has(p.b) ? p.a : null;
    const target = other ? byKey.get(other) : undefined;
    if (!target || mine.has(other!)) continue;
    const prev = out.get(target.id);
    if (!prev || p.sessions > prev.sessions) out.set(target.id, { skill: target, sessions: p.sessions });
  }
  return [...out.values()].sort((a, b) => b.sessions - a.sessions || byName(a.skill, b.skill)).slice(0, max);
}

/** Edge ids on the path root → category → skill, for hover/selection highlighting. */
export function pathEdgeIds(nodeId: string, edges: readonly GraphEdge[]): Set<string> {
  const ids = new Set<string>();
  let current: string | undefined = nodeId;
  const guard = new Set<string>();
  while (current && !guard.has(current)) {
    guard.add(current);
    const incoming = edges.find((e) => e.target === current);
    if (!incoming) break;
    ids.add(incoming.id);
    current = incoming.source;
  }
  return ids;
}

/**
 * Keyboard navigation between skill nodes. Up/down moves within a category column,
 * left/right moves to the nearest row of the neighbouring column.
 */
export function neighbourSkill(
  nodes: readonly GraphNode[],
  fromNodeId: string,
  dir: 'up' | 'down' | 'left' | 'right',
): string | null {
  const skills = nodes.filter((n) => n.kind === 'skill');
  const from = skills.find((n) => n.id === fromNodeId);
  if (!from || from.column === undefined || from.row === undefined) return skills[0]?.id ?? null;
  const col = from.column;
  const row = from.row;
  if (dir === 'up' || dir === 'down') {
    const target = skills.find((n) => n.column === col && n.row === row + (dir === 'down' ? 1 : -1));
    return target?.id ?? null;
  }
  const columns = [...new Set(skills.map((n) => n.column ?? 0))].sort((a, b) => a - b);
  const idx = columns.indexOf(col) + (dir === 'right' ? 1 : -1);
  if (idx < 0 || idx >= columns.length) return null;
  const inCol = skills.filter((n) => n.column === columns[idx]);
  const best = inCol.reduce<GraphNode | null>(
    (acc, n) => (!acc || Math.abs((n.row ?? 0) - row) < Math.abs((acc.row ?? 0) - row) ? n : acc),
    null,
  );
  return best?.id ?? null;
}

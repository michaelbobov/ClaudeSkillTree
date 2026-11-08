import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER, LAYOUT, buildGraph, coUsedSkills, filterSkills, groupByCategory, neighbourSkill, pathEdgeIds, skillCompare, skillNodeId } from '../../src/shared/graph';
import { summarizeUsage, type ActivityEvent } from '../../src/shared/activity';
import type { Category, OrganizedSkill, SkillSource } from '../../src/shared/types';

function mk(name: string, category: Category, source: SkillSource = 'personal', extra: Partial<OrganizedSkill> = {}): OrganizedSkill {
  return {
    id: `${source}/${name}`,
    name,
    dirName: name,
    command: `/${name}`,
    description: `${name} helps with things`,
    descriptionSource: 'frontmatter',
    source,
    readOnly: source === 'synced',
    rootLabel: source,
    dir: `/x/${name}`,
    file: `/x/${name}/SKILL.md`,
    displayPath: `~/.claude/skills/${name}/SKILL.md`,
    fields: [],
    issues: [],
    supportingFiles: [],
    supportingFilesTruncated: false,
    declaresHooks: false,
    modifiedAt: 0,
    sizeBytes: 10,
    sameNameAs: [],
    category,
    categorySource: 'user',
    ...extra,
  };
}

const skills = [
  mk('react-ui', 'Frontend', 'project', { description: 'Build React components with accessible markup' }),
  mk('write-tests', 'Testing', 'project'),
  mk('accessibility', 'Frontend', 'personal'),
  mk('pdf', 'Documentation', 'synced'),
  mk('deploy', 'Automation', 'project', { shadowedBy: 'personal/deploy' }),
];

describe('filterSkills', () => {
  it('returns everything for the empty filter', () => {
    expect(filterSkills(skills, EMPTY_FILTER)).toHaveLength(skills.length);
  });

  it('matches every whitespace-separated term, case-insensitively, across fields', () => {
    expect(filterSkills(skills, { ...EMPTY_FILTER, query: 'REACT accessible' }).map((s) => s.name)).toEqual(['react-ui']);
    expect(filterSkills(skills, { ...EMPTY_FILTER, query: 'frontend' }).map((s) => s.name)).toEqual(['react-ui', 'accessibility']);
    expect(filterSkills(skills, { ...EMPTY_FILTER, query: 'nothing-matches' })).toEqual([]);
  });

  it('filters by source and category', () => {
    expect(filterSkills(skills, { ...EMPTY_FILTER, sources: new Set(['project']) }).map((s) => s.name)).toEqual(['react-ui', 'write-tests', 'deploy']);
    expect(filterSkills(skills, { ...EMPTY_FILTER, sources: new Set(['project']), categories: new Set(['Frontend']) }).map((s) => s.name)).toEqual(['react-ui']);
  });

  it('can hide shadowed skills', () => {
    expect(filterSkills(skills, { ...EMPTY_FILTER, includeShadowed: false }).some((s) => s.name === 'deploy')).toBe(false);
  });
});

describe('groupByCategory', () => {
  it('uses canonical category order and sorts names', () => {
    const groups = groupByCategory([mk('b', 'Testing'), mk('a', 'Frontend'), mk('c', 'Frontend'), mk('z', 'Other')]);
    expect(groups.map((g) => g.category)).toEqual(['Frontend', 'Testing', 'Other']);
    expect(groups[0].skills.map((s) => s.name)).toEqual(['a', 'c']);
  });
});

describe('buildGraph', () => {
  it('creates root → category → skill organization edges', () => {
    const { nodes, edges } = buildGraph(skills);
    expect(nodes.filter((n) => n.kind === 'root')).toHaveLength(1);
    expect(nodes.filter((n) => n.kind === 'category').map((n) => n.category)).toEqual(['Frontend', 'Testing', 'Automation', 'Documentation']);
    expect(nodes.filter((n) => n.kind === 'skill')).toHaveLength(skills.length);
    expect(edges.every((e) => e.relation === 'organization')).toBe(true);
    expect(edges).toHaveLength(4 + skills.length);
    // No duplicate node ids.
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
  });

  it('hides skills of collapsed categories but keeps the count', () => {
    const { nodes } = buildGraph(skills, { collapsed: new Set<Category>(['Frontend']) });
    const cat = nodes.find((n) => n.id === 'cat:Frontend')!;
    expect(cat.collapsed).toBe(true);
    expect(cat.count).toBe(2);
    expect(nodes.some((n) => n.skillId === 'project/react-ui')).toBe(false);
  });

  it('applies saved positions over the automatic layout', () => {
    const id = skillNodeId('project/react-ui');
    const { nodes } = buildGraph(skills, { positions: { [id]: { x: 999, y: -5 } } });
    expect(nodes.find((n) => n.id === id)!.position).toEqual({ x: 999, y: -5 });
  });

  it('lays out columns without overlapping skill nodes', () => {
    const many = Array.from({ length: 30 }, (_, i) => mk(`s${String(i).padStart(2, '0')}`, (['Design', 'Frontend', 'Backend'] as const)[i % 3]));
    const { nodes } = buildGraph(many);
    const positions = nodes.filter((n) => n.kind === 'skill').map((n) => `${n.position.x},${n.position.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });
});

describe('graph navigation helpers', () => {
  const { nodes, edges } = buildGraph(skills);

  it('pathEdgeIds returns the edges from a skill back to the root', () => {
    expect([...pathEdgeIds(skillNodeId('project/react-ui'), edges)].sort()).toEqual(
      ['e:cat:Frontend->skill:project/react-ui', 'e:root->cat:Frontend'].sort(),
    );
  });

  it('neighbourSkill moves within and across columns', () => {
    const first = skillNodeId('personal/accessibility'); // Frontend column, row 0 (sorted)
    expect(neighbourSkill(nodes, first, 'down')).toBe(skillNodeId('project/react-ui'));
    expect(neighbourSkill(nodes, first, 'up')).toBeNull();
    expect(neighbourSkill(nodes, first, 'right')).toBe(skillNodeId('project/write-tests'));
    expect(neighbourSkill(nodes, first, 'left')).toBeNull();
  });
});

describe('long categories and usage order', () => {
  const design = Array.from({ length: 17 }, (_, i) => mk(`d${String(i).padStart(2, '0')}`, 'Design'));
  const docs = Array.from({ length: 4 }, (_, i) => mk(`doc${i}`, 'Documentation'));

  it('wraps a long category into balanced columns under one wider header', () => {
    const { nodes, edges } = buildGraph([...design, ...docs], { maxRows: 9 });
    const cat = nodes.find((n) => n.id === 'cat:Design')!;
    expect(cat.span).toBe(2);
    const cols = nodes.filter((n) => n.kind === 'skill' && n.category === 'Design').map((n) => n.column);
    expect(cols.filter((c) => c === 0).length).toBe(9);
    expect(cols.filter((c) => c === 1).length).toBe(8);
    const docCat = nodes.find((n) => n.id === 'cat:Documentation')!;
    expect(docCat.column).toBe(2);
    expect(docCat.position.x).toBe(2 * (LAYOUT.nodeWidth + LAYOUT.columnGap));
    expect(edges.find((e) => e.target === skillNodeId('personal/d09'))!.trunkOffset).toBe(LAYOUT.nodeWidth + LAYOUT.columnGap);
    expect(edges.find((e) => e.target === skillNodeId('personal/d00'))!.trunkOffset).toBeUndefined();
    const positions = nodes.filter((n) => n.kind === 'skill').map((n) => `${n.position.x},${n.position.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });

  const ev = (skill: string, sessionId: string, ts: string): ActivityEvent => ({ v: 1, ts, source: 'PreToolUse:Skill', skill, sessionId, cwd: null, projectDir: null, hadArgs: false });
  const usage = summarizeUsage([
    ev('doc2', 's1', '2026-01-01T00:00:00Z'),
    ev('doc2', 's2', '2026-01-02T00:00:00Z'),
    ev('doc0', 's2', '2026-01-03T00:00:00Z'),
    ev('d03', 's2', '2026-01-02T12:00:00Z'),
  ]);

  it('orders by recorded use when asked, keeping never-recorded skills by name after them', () => {
    const order = (o: 'name' | 'recent' | 'most') => groupByCategory(docs, skillCompare(o, usage))[0].skills.map((s) => s.name);
    expect(order('name')).toEqual(['doc0', 'doc1', 'doc2', 'doc3']);
    expect(order('recent')).toEqual(['doc0', 'doc2', 'doc1', 'doc3']);
    expect(order('most')).toEqual(['doc2', 'doc0', 'doc1', 'doc3']);
    expect(groupByCategory(docs, skillCompare('most', undefined))[0].skills.map((s) => s.name)).toEqual(['doc0', 'doc1', 'doc2', 'doc3']);
  });

  it('lists skills recorded in the same sessions among the visible ones', () => {
    const doc2 = docs[2];
    expect(coUsedSkills(doc2, [...design, ...docs], usage).map((c) => [c.skill.name, c.sessions])).toEqual([
      ['d03', 1],
      ['doc0', 1],
    ]);
    expect(coUsedSkills(doc2, docs, usage).map((c) => c.skill.name)).toEqual(['doc0']);
    expect(coUsedSkills(docs[1], docs, usage)).toEqual([]);
    expect(coUsedSkills(doc2, docs, undefined)).toEqual([]);
  });
});

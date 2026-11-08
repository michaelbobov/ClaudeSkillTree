import { describe, expect, it } from 'vitest';
import { matchOrigins, recommendFromUsage, unusedDays, type LocalSkillRef } from '../../src/shared/recommend';
import { summarizeUsage, type ActivityEvent } from '../../src/shared/activity';
import type { Catalog, CatalogEntry } from '../../src/shared/catalog';

const entry = (repo: string, name: string, category: CatalogEntry['category'], sha = `${name}`.padEnd(40, '0').slice(0, 40)): CatalogEntry =>
  ({ id: `${repo}:skills/${name}`, name, owner: repo.split('/')[0], repo: repo.split('/')[1], path: `skills/${name}`, category, kind: 'skill', files: [{ path: 'SKILL.md', size: 1, sha, kind: 'markdown' }] }) as unknown as CatalogEntry;

const catalog = {
  schemaVersion: 1,
  generatedAt: '2026-01-01T00:00:00Z',
  source: 'github-index',
  repositories: ['emil/skills', 'big/skills'],
  repositoryStats: { 'emil/skills': { stars: 50_000, fetchedAt: '2026-01-01T00:00:00Z' }, 'big/skills': { stars: 300_000, fetchedAt: '2026-01-01T00:00:00Z' } },
  entries: [
    entry('emil/skills', 'animate', 'Design', 'a'.repeat(40)),
    entry('emil/skills', 'review-animations', 'Design'),
    entry('emil/skills', 'break-ui', 'Frontend'),
    entry('emil/skills', 'write-swift', 'Other'),
    entry('big/skills', 'color-system', 'Design'),
    entry('big/skills', 'pdf', 'Documentation'),
  ],
} as unknown as Catalog;

const local = (name: string, category: LocalSkillRef['category']): LocalSkillRef => ({ id: `personal/${name}`, name, command: `/${name}`, dirName: name, category });
const locals = [local('animate', 'Design'), local('break-ui', 'Frontend'), local('humanizer', 'Documentation')];
const ev = (skill: string, ts: string): ActivityEvent => ({ v: 1, ts, source: 'PreToolUse:Skill', skill, sessionId: 's', cwd: null, projectDir: null, hadArgs: false });

describe('unusedDays', () => {
  const activity = (since: string | null, enabled = true) => ({ enabled, since, ...summarizeUsage([ev('animate', '2026-01-10T00:00:00Z')]) });
  const now = Date.parse('2026-01-20T12:00:00Z');

  it('needs a week of tracking and no recorded use', () => {
    expect(unusedDays(local('humanizer', 'Documentation'), activity('2026-01-01T00:00:00Z'), now)).toBe(19);
    expect(unusedDays(local('animate', 'Design'), activity('2026-01-01T00:00:00Z'), now)).toBeNull();
    expect(unusedDays(local('humanizer', 'Documentation'), activity('2026-01-16T00:00:00Z'), now)).toBeNull(); // only 4 days
    expect(unusedDays(local('humanizer', 'Documentation'), activity('2026-01-01T00:00:00Z', false), now)).toBeNull(); // tracking off
    expect(unusedDays(local('humanizer', 'Documentation'), undefined, now)).toBeNull();
  });
});

describe('matchOrigins', () => {
  it('prefers provenance, then an identical SKILL.md, then a unique name', () => {
    const o = matchOrigins(catalog, [
      { ...local('animate', 'Design'), skillMdSha: 'a'.repeat(40) },
      { ...local('my-pdf', 'Documentation'), installedFromId: 'big/skills:skills/pdf' },
      local('break-ui', 'Frontend'),
      local('humanizer', 'Documentation'),
    ]);
    expect(o.get('personal/animate')).toMatchObject({ how: 'identical', entry: { id: 'emil/skills:skills/animate' } });
    expect(o.get('personal/my-pdf')).toMatchObject({ how: 'installed', entry: { id: 'big/skills:skills/pdf' } });
    expect(o.get('personal/break-ui')).toMatchObject({ how: 'name' });
    expect(o.has('personal/humanizer')).toBe(false);
  });
});

describe('recommendFromUsage', () => {
  const origins = matchOrigins(catalog, locals);

  it('suggests other skills from the repository you use, then top-starred skills of your main category', () => {
    const usage = summarizeUsage([ev('animate', '2026-01-10T00:00:00Z'), ev('animate', '2026-01-11T00:00:00Z'), ev('break-ui', '2026-01-12T00:00:00Z')]);
    const recs = recommendFromUsage(catalog, locals, usage, origins);
    expect(recs).toEqual([
      // Design first: it is the category used most from emil/skills (animate, 2 uses)
      { id: 'emil/skills:skills/review-animations', reason: 'From emil/skills, like animate and break-ui (3 recorded uses)' },
      { id: 'emil/skills:skills/write-swift', reason: 'From emil/skills, like animate and break-ui (3 recorded uses)' },
      { id: 'big/skills:skills/color-system', reason: 'Design is the category you use most (2 recorded uses)' },
    ]);
    // With more same-repo candidates, category weight beats alphabetical order.
    const bigger = { ...catalog, entries: [...catalog.entries, entry('emil/skills', 'aaa-other-thing', 'Other'), entry('emil/skills', 'zz-motion', 'Design')] } as Catalog;
    const ids = recommendFromUsage(bigger, locals, usage, matchOrigins(bigger, locals), { perRepo: 2 }).map((r) => r.id);
    expect(ids.slice(0, 2)).toEqual(['emil/skills:skills/review-animations', 'emil/skills:skills/zz-motion']);
  });

  it('never suggests what you have, and nothing without recorded use', () => {
    expect(recommendFromUsage(catalog, locals, summarizeUsage([]), origins)).toEqual([]);
    expect(recommendFromUsage(catalog, locals, undefined, origins)).toEqual([]);
    const usage = summarizeUsage([ev('animate', '2026-01-10T00:00:00Z')]);
    const ids = recommendFromUsage(catalog, locals, usage, origins).map((r) => r.id);
    expect(ids).not.toContain('emil/skills:skills/animate');
    expect(ids).not.toContain('emil/skills:skills/break-ui');
  });
});

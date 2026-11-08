import { describe, expect, it } from 'vitest';
import { inferCategory, organizeSkills } from '../../src/core/organize';
import type { SkillRecord } from '../../src/shared/types';

describe('inferCategory', () => {
  it.each([
    ['write-tests', 'Generate unit tests with vitest', 'Testing'],
    ['web-typography', 'Select and pair typefaces for web projects', 'Design'],
    ['vercel-react-best-practices', 'React and Next.js performance optimization guidelines', 'Frontend'],
    ['db-migrate', 'Create SQL database migrations for the API server', 'Backend'],
    ['copywriting', 'Write marketing copy for landing pages', 'Documentation'],
    ['schedule', 'Create scheduled cron workflows', 'Automation'],
    ['mystery', 'Does something unusual', 'Other'],
  ])('%s → %s', (name, description, expected) => {
    expect(inferCategory(name, description)).toBe(expected);
  });
});

describe('organizeSkills', () => {
  const base = { id: 'personal/x', name: 'write-tests', description: 'Generate unit tests' } as SkillRecord;

  it('prefers the user choice, then frontmatter, then inference', () => {
    expect(organizeSkills([base], { 'personal/x': 'Design' })[0]).toMatchObject({ category: 'Design', categorySource: 'user' });
    expect(organizeSkills([{ ...base, frontmatterCategory: 'Backend' }], {})[0]).toMatchObject({ category: 'Backend', categorySource: 'frontmatter' });
    expect(organizeSkills([base], {})[0]).toMatchObject({ category: 'Testing', categorySource: 'inferred' });
    expect(organizeSkills([{ ...base, name: 'zzz', description: '' }], {})[0]).toMatchObject({ category: 'Other', categorySource: 'default' });
  });
});

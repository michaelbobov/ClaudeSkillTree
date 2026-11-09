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
    ['scanpy', 'Performs single-cell RNA-seq QC, normalization and clustering', 'Data'],
    ['statistical-power', 'Calculates sample sizes and statistical power for study planning', 'Data'],
    ['secrets-vault-manager', 'Set up HashiCorp Vault and rotate secrets', 'Security'],
    ['soc2-audit-prep', 'Prepare for a SOC 2 Type II observation period', 'Security'],
    ['prompt-engineering-patterns', 'Optimize a prompt and improve LLM output quality', 'Agents'],
    ['pricing-strategy', 'SaaS pricing tiers, packaging and a pricing page', 'Business'],
    ['memory-safety-patterns', 'Implement memory-safe programming with RAII and ownership', 'Other'],
    ['discernment-nudge', 'After a draft the user may act on, such as analysis or interpretation of data, invoke this', 'Other'],
    ['senior-data-scientist', 'Design experiments and analyze tabular data', 'Data'],
  ])('%s → %s', (name, description, expected) => {
    expect(inferCategory(name, description)).toBe(expected);
  });

  it('uses the folders above the skill and its repository when the text says little', () => {
    // Nothing in the name or description matches a category; the folder does.
    expect(inferCategory('board-prep', 'Drills you before the meeting where the numbers will be challenged.', {})).toBe('Business');
    expect(inferCategory('hard-call', 'Runs 10/10/10 on a decision where every option hurts.', {})).toBe('Other');
    expect(inferCategory('hard-call', 'Runs 10/10/10 on a decision where every option hurts.', { path: 'c-level-advisor/executive-mentor/skills/hard-call' })).toBe('Business');
    expect(inferCategory('gtars', 'Supports Gtars for interval models and set algebra.', { repository: 'K-Dense-AI/scientific-agent-skills' })).toBe('Data');
    expect(inferCategory('aso', 'Audit an App Store or Google Play listing.', { repository: 'coreyhaines31/marketingskills' })).toBe('Business');
  });

  it('ignores folders that only hold skills, such as .agents/skills or claude-skills', () => {
    expect(inferCategory('omomomo', 'Easter egg command.', { path: '.agents/skills/omomomo', repository: 'someone/agents' })).toBe('Other');
    expect(inferCategory('changelog', 'Shows the changelog.', { path: 'plugins/agent/skills/changelog', repository: 'someone/claude-skills' })).toBe('Other');
  });

  it('weighs the name over the folder and the folder over the description', () => {
    // Folder says marketing (2), description says test (1): the folder wins.
    expect(inferCategory('page-check', 'Run a quick test of the page.', { path: 'marketing/skills/page-check' })).toBe('Business');
    expect(inferCategory('page-check', 'Run a quick test of the page.')).toBe('Testing');
    // Name says test (3), folder says marketing (2): the name wins.
    expect(inferCategory('ab-test', 'Compare two variants.', { path: 'marketing/skills/ab-test' })).toBe('Testing');
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

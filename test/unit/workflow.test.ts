import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('index-skills workflow', () => {
  const wf = parse(fs.readFileSync('.github/workflows/index-skills.yml', 'utf8'));
  const steps: { run?: string; uses?: string }[] = wf.jobs.index.steps;

  it('runs daily and on demand', () => {
    expect(wf.on.schedule[0].cron).toMatch(/^\S+ \S+ \* \* \*$/);
    expect(wf.on).toHaveProperty('workflow_dispatch');
  });

  it('indexes, validates and publishes to Pages with least privilege', () => {
    expect(wf.permissions).toEqual({ contents: 'read', pages: 'write', 'id-token': 'write' });
    expect(steps.some((s) => s.run?.includes('npm run index:live'))).toBe(true);
    expect(steps.some((s) => s.run?.includes('validate-catalog.ts'))).toBe(true);
    expect(steps.some((s) => s.uses?.startsWith('actions/upload-pages-artifact'))).toBe(true);
    expect(wf.jobs.deploy.steps[0].uses).toMatch(/^actions\/deploy-pages@/);
  });

  it('does not run package install scripts', () => {
    expect(steps.find((s) => s.run?.startsWith('npm ci'))?.run).toContain('--ignore-scripts');
  });
});

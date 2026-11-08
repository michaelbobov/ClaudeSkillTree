import { describe, expect, it } from 'vitest';
import { hasForbiddenNameChars, parseSkillMarkdown, splitFrontmatter } from '../../src/core/frontmatter';

const levels = (r: ReturnType<typeof parseSkillMarkdown>) => r.issues.map((i) => i.level);

describe('parseSkillMarkdown', () => {
  it('parses valid frontmatter and keeps the body', () => {
    const r = parseSkillMarkdown(
      ['---', 'name: deploy', 'description: Deploy the app to staging', 'disable-model-invocation: true', 'allowed-tools: Read Grep', '---', '', '# Deploy', 'Steps…'].join('\n'),
      'deploy-dir',
    );
    expect(r.name).toBe('deploy');
    expect(r.description).toBe('Deploy the app to staging');
    expect(r.descriptionSource).toBe('frontmatter');
    expect(r.body).toBe('\n# Deploy\nSteps…');
    expect(r.fields.map((f) => f.key)).toEqual(['disable-model-invocation', 'allowed-tools']);
    expect(r.fields[0].value).toBe('true');
    expect(r.issues).toEqual([]);
  });

  it('falls back to the directory name and first body line without frontmatter', () => {
    const r = parseSkillMarkdown('\n\n# Review checklist\n\nCheck things.', 'review');
    expect(r.frontmatter).toBeNull();
    expect(r.name).toBe('review');
    expect(r.description).toBe('Review checklist');
    expect(r.descriptionSource).toBe('body');
    expect(levels(r)).toContain('info');
    expect(r.issues.some((i) => i.message.includes('No frontmatter'))).toBe(true);
  });

  it('skips fenced code when deriving a description from the body', () => {
    const r = parseSkillMarkdown('---\nname: x\n---\n```\ncode line\n```\nReal first line', 'x');
    expect(r.description).toBe('Real first line');
  });

  it('reports invalid YAML without throwing', () => {
    const r = parseSkillMarkdown('---\nname: [unclosed\ndescription: ok\n---\nBody', 'broken');
    expect(r.frontmatter).toBeNull();
    expect(r.name).toBe('broken');
    expect(levels(r)).toContain('error');
    expect(r.issues.find((i) => i.level === 'error')?.message).toMatch(/Invalid YAML/);
    expect(r.description).toBe('Body');
  });

  it('reports unterminated frontmatter', () => {
    const r = parseSkillMarkdown('---\nname: x\ndescription: never closed\n', 'x');
    expect(r.frontmatter).toBeNull();
    expect(r.issues[0]).toMatchObject({ level: 'error' });
    expect(r.issues[0].message).toMatch(/not closed/);
  });

  it('ignores frontmatter that does not start on the first line', () => {
    const r = parseSkillMarkdown('\n---\nname: late\n---\nBody', 'dir');
    expect(r.name).toBe('dir');
    expect(r.issues[0].message).toMatch(/first line/);
  });

  it('rejects non-mapping frontmatter', () => {
    const r = parseSkillMarkdown('---\n- a\n- b\n---\nBody', 'list');
    expect(r.frontmatter).toBeNull();
    expect(r.issues.some((i) => i.message.includes('mapping'))).toBe(true);
  });

  it('handles empty frontmatter and missing description', () => {
    const r = parseSkillMarkdown('---\n---\n', 'empty');
    expect(r.frontmatter).toEqual({});
    expect(r.name).toBe('empty');
    expect(r.descriptionSource).toBe('none');
    expect(levels(r)).toContain('warning');
  });

  it('handles CRLF line endings and a BOM', () => {
    const r = parseSkillMarkdown('﻿---\r\nname: crlf\r\ndescription: Windows file\r\n---\r\nBody\r\n', 'd');
    expect(r.name).toBe('crlf');
    expect(r.description).toBe('Windows file');
  });

  it('warns when name is not a string and flags forbidden characters', () => {
    expect(parseSkillMarkdown('---\nname: 42\n---\nx', 'num').name).toBe('num');
    const bad = parseSkillMarkdown('---\nname: "a<b>"\ndescription: d\n---\n', 'd');
    expect(bad.issues.some((i) => i.level === 'error' && i.message.includes('refuses'))).toBe(true);
  });

  it('detects hooks and a valid category hint', () => {
    const r = parseSkillMarkdown('---\nname: h\ndescription: d\nhooks:\n  PreToolUse: []\nmetadata:\n  category: testing\n---\n', 'h');
    expect(r.declaresHooks).toBe(true);
    expect(r.frontmatterCategory).toBe('Testing');
    const unknown = parseSkillMarkdown('---\ncategory: Gardening\ndescription: d\n---\n', 'g');
    expect(unknown.frontmatterCategory).toBeUndefined();
  });

  it('notes descriptions that Claude Code truncates in the listing', () => {
    const r = parseSkillMarkdown(`---\ndescription: ${'a'.repeat(1600)}\n---\n`, 'long');
    expect(r.issues.some((i) => i.message.includes('1536'))).toBe(true);
  });

  it('does not expand YAML aliases without bound', () => {
    const bomb = ['---', 'a: &a ["x","x","x","x","x","x","x","x","x","x"]', 'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]', 'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]', 'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]', 'e: [*d,*d,*d,*d,*d,*d,*d,*d,*d,*d]', '---', 'body'].join('\n');
    const r = parseSkillMarkdown(bomb, 'bomb');
    expect(r.name).toBe('bomb');
    expect(r.issues.some((i) => i.level === 'error')).toBe(true);
  });
});

describe('splitFrontmatter', () => {
  it('accepts a YAML document end marker', () => {
    expect(splitFrontmatter('---\na: 1\n...\nbody').raw).toBe('a: 1\n');
  });
});

describe('hasForbiddenNameChars', () => {
  it('accepts normal names and rejects invisible or angle-bracket characters', () => {
    expect(hasForbiddenNameChars('frontend-design')).toBe(false);
    expect(hasForbiddenNameChars('naïve-skill')).toBe(false);
    expect(hasForbiddenNameChars('zero​width')).toBe(true);
    expect(hasForbiddenNameChars('bidi‮evil')).toBe(true);
    expect(hasForbiddenNameChars('ctrl\u0007')).toBe(true);
    expect(hasForbiddenNameChars('<tag>')).toBe(true);
    expect(hasForbiddenNameChars('nbsp name')).toBe(true);
  });
});

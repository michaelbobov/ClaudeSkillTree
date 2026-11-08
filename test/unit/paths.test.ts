import { describe, expect, it } from 'vitest';
import { isContained } from '../../src/core/paths';

describe('isContained', () => {
  it('accepts the base and paths inside it', () => {
    expect(isContained('/a/skill', '/a/skill', 'linux')).toBe(true);
    expect(isContained('/a/skill', '/a/skill/reference.md', 'linux')).toBe(true);
    expect(isContained('/a/skill', '/a/skill/sub/../x.md', 'linux')).toBe(true);
    expect(isContained('/a/skill', '/a/skill/..hidden/x.md', 'linux')).toBe(true);
  });

  it('rejects traversal and sibling prefixes', () => {
    expect(isContained('/a/skill', '/a/skill/../other/x.md', 'linux')).toBe(false);
    expect(isContained('/a/skill', '/a/skill-evil/x.md', 'linux')).toBe(false);
    expect(isContained('/a/skill', '/etc/passwd', 'linux')).toBe(false);
  });

  it('is case-insensitive on Windows and handles drive letters', () => {
    expect(isContained('C:\\Users\\me\\skill', 'c:\\users\\ME\\skill\\a.md', 'win32')).toBe(true);
    expect(isContained('C:\\Users\\me\\skill', 'D:\\skill\\a.md', 'win32')).toBe(false);
  });
});

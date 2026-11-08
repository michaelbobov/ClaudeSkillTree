import { describe, expect, it } from 'vitest';
import { parseWebviewMessage } from '../../src/shared/protocol';

describe('parseWebviewMessage', () => {
  it('accepts well-formed messages', () => {
    expect(parseWebviewMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseWebviewMessage({ type: 'openSkill', id: 'personal/x' })).toEqual({ type: 'openSkill', id: 'personal/x' });
    expect(parseWebviewMessage({ type: 'setCategory', id: 'a', category: 'Testing' })).toEqual({ type: 'setCategory', id: 'a', category: 'Testing' });
    expect(parseWebviewMessage({ type: 'setCategory', id: 'a', category: null })).toEqual({ type: 'setCategory', id: 'a', category: null });
    expect(parseWebviewMessage({ type: 'savePositions', positions: { 'skill:a': { x: 1.6, y: 2 } } })).toEqual({
      type: 'savePositions',
      positions: { 'skill:a': { x: 2, y: 2 } },
    });
  });

  it('rejects malformed or unknown messages', () => {
    expect(parseWebviewMessage(null)).toBeNull();
    expect(parseWebviewMessage('ready')).toBeNull();
    expect(parseWebviewMessage({ type: 'runScript', cmd: 'rm -rf /' })).toBeNull();
    expect(parseWebviewMessage({ type: 'openSkill' })).toBeNull();
    expect(parseWebviewMessage({ type: 'openSkill', id: 42 })).toBeNull();
    expect(parseWebviewMessage({ type: 'openSkill', id: 'x'.repeat(5000) })).toBeNull();
    expect(parseWebviewMessage({ type: 'setCategory', id: 'a', category: 'Hacking' })).toBeNull();
    expect(parseWebviewMessage({ type: 'savePositions', positions: { a: { x: 'NaN', y: 0 } } })).toBeNull();
    expect(parseWebviewMessage({ type: 'savePositions', positions: { a: { x: Infinity, y: 0 } } })).toBeNull();
  });

  it('drops unknown categories from setCollapsed', () => {
    expect(parseWebviewMessage({ type: 'setCollapsed', categories: ['Testing', 'Bogus', 'Testing'] })).toEqual({ type: 'setCollapsed', categories: ['Testing'] });
  });
});

describe('section navigation messages', () => {
  it('accepts only the three SkillTree sections on every page', async () => {
    const { parseMarketplaceMessage } = await import('../../src/shared/marketplace');
    const { parseActivityMessage } = await import('../../src/shared/activity');
    const { parseWebviewMessage } = await import('../../src/shared/protocol');
    for (const parse of [parseWebviewMessage, parseMarketplaceMessage, parseActivityMessage] as ((m: unknown) => unknown)[]) {
      expect(parse({ type: 'navigate', to: 'marketplace' })).toEqual({ type: 'navigate', to: 'marketplace' });
      expect(parse({ type: 'navigate', to: 'tree' })).toEqual({ type: 'navigate', to: 'tree' });
      expect(parse({ type: 'navigate', to: 'workbench.action.terminal.new' })).toBeNull();
      expect(parse({ type: 'navigate' })).toBeNull();
    }
  });
});

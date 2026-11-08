import { describe, expect, it } from 'vitest';
import { DEFAULT_MARKET_FILTER, filterEntries, parseMarketplaceMessage, relevance, type MarketplaceEntryView } from '../../src/shared/marketplace';

const mk = (name: string, extra: Partial<MarketplaceEntryView> = {}): MarketplaceEntryView =>
  ({
    id: `o/r:skills/${name}`,
    name,
    description: `${name} description`,
    category: 'Other',
    owner: 'o',
    repo: 'r',
    path: `skills/${name}`,
    updatedAt: '2026-01-01T00:00:00Z',
    installState: 'not-installed',
    localIds: [],
    ...extra,
  }) as MarketplaceEntryView;

const entries = [
  mk('pdf', { description: 'Work with PDF files', category: 'Documentation', updatedAt: '2026-03-01T00:00:00Z' }),
  mk('docx', { description: 'Word documents and pdf export', category: 'Documentation', installState: 'installed' }),
  mk('webapp-testing', { description: 'Test web apps with Playwright', category: 'Testing', updatedAt: '2026-02-01T00:00:00Z' }),
];

describe('filterEntries', () => {
  it('ranks name matches above description matches', () => {
    expect(filterEntries(entries, { ...DEFAULT_MARKET_FILTER, query: 'pdf' }).map((e) => e.name)).toEqual(['pdf', 'docx']);
    expect(relevance(entries[0], ['nothing'])).toBe(0);
  });

  it('filters by category and install state, and sorts by update date', () => {
    expect(filterEntries(entries, { ...DEFAULT_MARKET_FILTER, category: 'Testing' }).map((e) => e.name)).toEqual(['webapp-testing']);
    expect(filterEntries(entries, { ...DEFAULT_MARKET_FILTER, install: 'installed' }).map((e) => e.name)).toEqual(['docx']);
    expect(filterEntries(entries, { ...DEFAULT_MARKET_FILTER, install: 'not-installed' }).map((e) => e.name)).toEqual(['pdf', 'webapp-testing']);
    expect(filterEntries(entries, { ...DEFAULT_MARKET_FILTER, sort: 'updated' }).map((e) => e.name)).toEqual(['pdf', 'webapp-testing', 'docx']);
  });

  it('filters by repository and, without a query, keeps the catalog repository order', () => {
    const mixed = [mk('zeta', { owner: 'b', repo: 'two' }), mk('alpha', { owner: 'c', repo: 'three' }), mk('beta', { owner: 'a', repo: 'one' }), mk('gamma', { owner: 'a', repo: 'one' })];
    const order = ['a/one', 'b/two', 'c/three'];
    expect(filterEntries(mixed, DEFAULT_MARKET_FILTER, order).map((e) => e.name)).toEqual(['beta', 'gamma', 'zeta', 'alpha']);
    expect(filterEntries(mixed, { ...DEFAULT_MARKET_FILTER, repo: 'B/Two' }, order).map((e) => e.name)).toEqual(['zeta']);
    expect(filterEntries(mixed, { ...DEFAULT_MARKET_FILTER, query: 'a' }, order).map((e) => e.name)).toEqual(['alpha', 'beta', 'gamma', 'zeta']);
  });
});

describe('parseMarketplaceMessage', () => {
  it('validates webview messages', () => {
    expect(parseMarketplaceMessage({ type: 'install', id: 'o/r:x', scope: 'project' })).toEqual({ type: 'install', id: 'o/r:x', scope: 'project' });
    expect(parseMarketplaceMessage({ type: 'install', id: 'o/r:x', scope: '/etc' })).toBeNull();
    expect(parseMarketplaceMessage({ type: 'openUrl', url: 'https://evil.example' })).toBeNull();
    expect(parseMarketplaceMessage({ type: 'rendered', count: -1 })).toBeNull();
  });
});

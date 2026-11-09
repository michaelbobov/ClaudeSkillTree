// Marketplace view model, message contract and filtering. Shared by host, webview and tests.

import { parseNavTarget, type NavTarget } from './nav';
import { CATEGORIES, type Category } from './types';
import type { CatalogEntry, InstallState } from './catalog';

export type CatalogOriginView = 'remote' | 'cache' | 'bundled' | 'none';

export interface MarketplaceEntryView extends CatalogEntry {
  installState: InstallState;
  /** Local skill ids matching this entry (installed copies or same-named folders). */
  localIds: string[];
}

export interface MarketplaceState {
  status: 'loading' | 'ready';
  origin: CatalogOriginView;
  /** When the shown catalog was fetched (remote or cache); null for the bundled snapshot. */
  fetchedAt: string | null;
  url: string | null;
  error?: string;
  catalog: {
    source: 'github-index' | 'sample';
    generatedAt: string;
    repositories: string[];
    skippedCount: number;
    /** GitHub stars per "owner/repo" (whole repository), snapshot at fetchedAt. */
    repositoryStats: Record<string, { stars: number; fetchedAt: string }>;
  } | null;
  entries: MarketplaceEntryView[];
  /** Reason project installs are unavailable (no folder, untrusted), or null when allowed. */
  projectInstallBlocked: string | null;
  /** Whether "Let Claude suggest skills" is on (shown in the header with a link to turn it on). */
  claudeSuggestions?: boolean;
  /** "For you": catalog skills suggested from recorded use, each with its reason (empty without tracking data). */
  forYou?: { id: string; reason: string }[];
  /**
   * "For this project": catalog skills that name a technology the open workspace uses, each with the
   * evidence, and a one-line summary of what was detected ("Next.js, Tailwind CSS and Playwright").
   */
  forProject?: { summary: string; items: { id: string; reason: string }[] };
  busyId: string | null;
}

export type MarketplaceHostMessage =
  | { type: 'state'; state: MarketplaceState }
  | { type: 'preview'; id: string; status: 'ready' | 'error'; text: string; error?: string }
  | { type: 'focus'; id: string };

export type MarketplaceWebviewMessage =
  | { type: 'navigate'; to: NavTarget }
  | { type: 'enableClaude' }
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'preview'; id: string }
  | { type: 'install'; id: string; scope: 'project' | 'global' }
  | { type: 'openSource'; id: string }
  | { type: 'openInstalled'; id: string }
  | { type: 'rendered'; count: number };

export function parseMarketplaceMessage(raw: unknown): MarketplaceWebviewMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 600 ? m.id : null;
  switch (m.type) {
    case 'ready':
    case 'refresh':
    case 'enableClaude':
      return { type: m.type };
    case 'navigate': {
      const to = parseNavTarget(m.to);
      return to ? { type: 'navigate', to } : null;
    }
    case 'preview':
    case 'openSource':
    case 'openInstalled':
      return id ? { type: m.type, id } : null;
    case 'install':
      return id && (m.scope === 'project' || m.scope === 'global') ? { type: 'install', id, scope: m.scope } : null;
    case 'rendered':
      return typeof m.count === 'number' && Number.isInteger(m.count) && m.count >= 0 ? { type: 'rendered', count: m.count } : null;
    default:
      return null;
  }
}

export type MarketplaceSort = 'relevance' | 'updated' | 'name' | 'stars';
export type InstallFilter = 'all' | 'installed' | 'not-installed';

export interface MarketplaceFilter {
  query: string;
  category: Category | 'all';
  install: InstallFilter;
  sort: MarketplaceSort;
  /** "owner/repo" or 'all'. */
  repo?: string;
}

export const DEFAULT_MARKET_FILTER: MarketplaceFilter = { query: '', category: 'all', install: 'all', sort: 'relevance', repo: 'all' };

/** Relevance: name matches beat path/repo matches beat description matches. 0 = no match. */
export function relevance(e: CatalogEntry, terms: string[]): number {
  if (terms.length === 0) return 1;
  let score = 0;
  const name = e.name.toLowerCase();
  const where = `${e.owner}/${e.repo}/${e.path}`.toLowerCase();
  const desc = e.description.toLowerCase();
  const cat = e.category.toLowerCase();
  for (const t of terms) {
    let s = 0;
    if (name === t) s = 100;
    else if (name.startsWith(t)) s = 60;
    else if (name.includes(t)) s = 40;
    else if (where.includes(t)) s = 20;
    else if (cat === t) s = 15;
    else if (desc.includes(t)) s = 10;
    if (s === 0) return 0; // every term must match somewhere
    score += s;
  }
  return score;
}

/**
 * Filters and sorts catalog entries. With no search terms, "relevance" keeps the catalog's repository
 * order (seed repositories first, then those found by GitHub search, most-starred first), then name.
 */
export function filterEntries<T extends MarketplaceEntryView>(
  entries: readonly T[],
  f: MarketplaceFilter,
  repoOrder: readonly string[] = [],
  repoStars: Readonly<Record<string, { stars: number }>> = {},
): T[] {
  const terms = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  const repoRank = new Map(repoOrder.map((r, i) => [r.toLowerCase(), i]));
  const rank = (e: T) => repoRank.get(`${e.owner}/${e.repo}`.toLowerCase()) ?? repoOrder.length;
  const scored = entries
    .filter((e) => !f.repo || f.repo === 'all' || `${e.owner}/${e.repo}`.toLowerCase() === f.repo.toLowerCase())
    .filter((e) => f.category === 'all' || e.category === f.category)
    .filter((e) =>
      f.install === 'all' ? true : f.install === 'installed' ? e.installState === 'installed' || e.installState === 'update-available' : e.installState === 'not-installed',
    )
    .map((e) => ({ e, score: relevance(e, terms) }))
    .filter((x) => x.score > 0);
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
  scored.sort((a, b) => {
    if (f.sort === 'updated') return (b.e.updatedAt ?? '').localeCompare(a.e.updatedAt ?? '') || byName(a.e, b.e);
    if (f.sort === 'name') return byName(a.e, b.e);
    if (f.sort === 'stars') return (repoStars[`${b.e.owner}/${b.e.repo}`]?.stars ?? -1) - (repoStars[`${a.e.owner}/${a.e.repo}`]?.stars ?? -1) || rank(a.e) - rank(b.e) || byName(a.e, b.e);
    if (terms.length === 0) return rank(a.e) - rank(b.e) || byName(a.e, b.e);
    return b.score - a.score || byName(a.e, b.e);
  });
  return scored.map((x) => x.e);
}

export function isCategoryOrAll(v: unknown): v is Category | 'all' {
  return v === 'all' || (CATEGORIES as readonly unknown[]).includes(v);
}

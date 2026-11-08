// Usage-driven recommendations (Phase 5). Pure: no VS Code API, no I/O.
//
// Everything here starts from *recorded* skill use (SkillTree's opt-in hooks). A skill is never
// called "unused" or "used" because it is merely installed, and every suggestion carries its reason.

import { installFolderName, type Catalog, type CatalogEntry } from './catalog';
import { usageFor, type UsageSummary } from './activity';
import type { Category } from './types';

/** Tracking must have run this long before a skill without recorded use is called unused. */
export const UNUSED_MIN_DAYS = 7;

/**
 * Whole days of tracking without any recorded use of `skill`, or null when tracking is off, too
 * recent to say, or the skill was used.
 */
export function unusedDays(
  skill: { name: string; command: string },
  activity: (Pick<UsageSummary, 'bySkill'> & { enabled: boolean; since: string | null }) | undefined,
  now = Date.now(),
): number | null {
  if (!activity?.enabled || !activity.since) return null;
  const since = Date.parse(activity.since);
  if (!Number.isFinite(since)) return null;
  const days = Math.floor((now - since) / 86_400_000);
  if (days < UNUSED_MIN_DAYS) return null;
  return usageFor(activity, skill) ? null : days;
}

export interface LocalSkillRef {
  id: string;
  name: string;
  command: string;
  dirName: string;
  category: Category;
}

/** How a local skill was tied to a catalog entry: SkillTree provenance, identical SKILL.md, or a unique name. */
export type OriginHow = 'installed' | 'identical' | 'name';

/**
 * Ties local skills to catalog entries, most certain first: SkillTree's install record, then an
 * identical SKILL.md (same git blob), then a name that exactly one catalog skill has.
 */
export function matchOrigins(
  catalog: Catalog,
  locals: readonly (LocalSkillRef & { installedFromId?: string; skillMdSha?: string })[],
): Map<string, { entry: CatalogEntry; how: OriginHow }> {
  const byId = new Map(catalog.entries.map((e) => [e.id, e]));
  const bySha = new Map<string, CatalogEntry>();
  const byName = new Map<string, CatalogEntry[]>();
  for (const e of catalog.entries) {
    const sha = e.files.find((f) => f.path === 'SKILL.md')?.sha;
    if (sha && !bySha.has(sha)) bySha.set(sha, e);
    const k = e.name.toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), e]);
  }
  const out = new Map<string, { entry: CatalogEntry; how: OriginHow }>();
  for (const s of locals) {
    const installed = s.installedFromId ? byId.get(s.installedFromId) : undefined;
    if (installed) {
      out.set(s.id, { entry: installed, how: 'installed' });
      continue;
    }
    const same = s.skillMdSha ? bySha.get(s.skillMdSha) : undefined;
    if (same) {
      out.set(s.id, { entry: same, how: 'identical' });
      continue;
    }
    const named = byName.get(s.name.toLowerCase());
    if (named?.length === 1) out.set(s.id, { entry: named[0], how: 'name' });
  }
  return out;
}

export interface Recommendation {
  id: string;
  reason: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Catalog skills you do not have, ranked from your recorded use:
 *  1. other skills from the repositories your used skills come from (weighted by those uses);
 *  2. the best-starred skills in the category you use most.
 * Returns [] without recorded use.
 */
export function recommendFromUsage(
  catalog: Catalog,
  locals: readonly LocalSkillRef[],
  usage: Pick<UsageSummary, 'bySkill'> | undefined,
  origins: ReadonlyMap<string, { entry: CatalogEntry; how: OriginHow }>,
  opts: { max?: number; perRepo?: number } = {},
): Recommendation[] {
  if (!usage) return [];
  const max = opts.max ?? 6;
  const used = locals
    .map((s) => ({ s, count: usageFor(usage, s)?.count ?? 0 }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count || a.s.name.localeCompare(b.s.name));
  if (used.length === 0) return [];

  const have = new Set(locals.flatMap((s) => [s.dirName.toLowerCase(), s.name.toLowerCase()]));
  const owned = new Set([...origins.values()].map((o) => o.entry.id));
  const available = (e: CatalogEntry) => e.kind === 'skill' && !owned.has(e.id) && !have.has(installFolderName(e).toLowerCase()) && !have.has(e.name.toLowerCase());
  const stars = (e: CatalogEntry) => catalog.repositoryStats?.[`${e.owner}/${e.repo}`]?.stars ?? 0;
  const picked = new Map<string, Recommendation>();

  // 1. Same repository as skills you use.
  const repos = new Map<string, { uses: number; names: string[]; categories: Map<Category, number> }>();
  for (const { s, count } of used) {
    const origin = origins.get(s.id);
    if (!origin) continue;
    const key = `${origin.entry.owner}/${origin.entry.repo}`;
    const r = repos.get(key) ?? { uses: 0, names: [], categories: new Map<Category, number>() };
    r.uses += count;
    r.names.push(s.name);
    r.categories.set(s.category, (r.categories.get(s.category) ?? 0) + count);
    repos.set(key, r);
  }
  const perRepo = opts.perRepo ?? 3;
  for (const [repo, r] of [...repos.entries()].sort((a, b) => b[1].uses - a[1].uses)) {
    const like = r.names.slice(0, 2).join(' and ');
    // Within the repository, favour the categories you use from it.
    const weight = (e: CatalogEntry) => r.categories.get(e.category) ?? 0;
    const candidates = catalog.entries.filter((e) => `${e.owner}/${e.repo}` === repo && available(e)).sort((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name));
    for (const e of candidates.slice(0, perRepo)) {
      if (picked.size >= max) break;
      picked.set(e.id, { id: e.id, reason: `From ${repo}, like ${like} (${plural(r.uses, 'recorded use')})` });
    }
  }

  // 2. Best-starred skills in the category you use most.
  const byCategory = new Map<Category, number>();
  for (const { s, count } of used) byCategory.set(s.category, (byCategory.get(s.category) ?? 0) + count);
  const [topCategory, catUses] = [...byCategory.entries()].filter(([c]) => c !== 'Other').sort((a, b) => b[1] - a[1])[0] ?? [];
  if (topCategory && picked.size < max) {
    const candidates = catalog.entries
      .filter((e) => e.category === topCategory && available(e) && !picked.has(e.id))
      .sort((a, b) => stars(b) - stars(a) || a.id.localeCompare(b.id));
    for (const e of candidates.slice(0, max - picked.size)) {
      picked.set(e.id, { id: e.id, reason: `${topCategory} is the category you use most (${plural(catUses!, 'recorded use')})` });
    }
  }
  return [...picked.values()];
}

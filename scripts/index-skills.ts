// GitHub skill catalog indexer.
//   npm run index        replay test/fixtures/github/routes.json (deterministic) → out/catalog.fixture.json
//   npm run index:live   query GitHub → data/catalog.json (set GITHUB_TOKEN for higher rate limits)
// Options: --out <file>  --seed <file>  --search  --max-search <n> (total repos added by search)  --sample <n> (also write data/catalog.sample.json)
//          --refresh-stats   only refresh repository star counts in the existing catalog (one request per repository)
//          --add o/r,o2/r2   index these repositories and merge them into the existing catalog
// Never executes downloaded content: it only reads metadata and SKILL.md text.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildCatalog, fetchHttpClient, fetchRepositoryStats, mergeCatalogs, RateLimitError, replayHttpClient, type SeedConfig } from '../src/core/githubIndex';
import { validateCatalog, type Catalog } from '../src/shared/catalog';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const live = process.argv.includes('--live');
  const root = process.cwd();
  const seedFile = arg('--seed') ?? (live ? 'data/seed-repos.json' : 'test/fixtures/github/seed.json');
  const out = arg('--out') ?? (live ? 'data/catalog.json' : 'out/catalog.fixture.json');
  const seed = JSON.parse(fs.readFileSync(path.resolve(root, seedFile), 'utf8')) as SeedConfig;
  if (arg('--max-search') !== undefined) seed.maxSearchRepositories = Number(arg('--max-search'));
  const http = live
    ? fetchHttpClient(process.env.GITHUB_TOKEN)
    : replayHttpClient(JSON.parse(fs.readFileSync(path.resolve(root, 'test/fixtures/github/routes.json'), 'utf8')));
  const fixedNow = live ? undefined : () => new Date('2026-01-01T00:00:00Z');

  if (process.argv.includes('--refresh-stats')) {
    const current = JSON.parse(fs.readFileSync(path.resolve(root, out), 'utf8')) as Catalog;
    try {
      current.repositoryStats = { ...current.repositoryStats, ...(await fetchRepositoryStats(current.repositories, http, fixedNow)) };
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.log(`INDEX RATE-LIMITED ${err.message}`);
        process.exit(2);
      }
      throw err;
    }
    const v = validateCatalog(current);
    if (!v.ok) {
      console.log(`INDEX FAIL catalog invalid after stats refresh:\n  ${v.errors.join('\n  ')}`);
      process.exit(1);
    }
    fs.writeFileSync(path.resolve(root, out), JSON.stringify(current, null, 2) + '\n');
    const stats = current.repositoryStats ?? {};
    console.log(`STATS OK ${Object.keys(stats).length}/${current.repositories.length} repositories → ${out}`);
    for (const r of current.repositories) console.log(`  ${r}: ${stats[r] ? `${stats[r].stars} stars` : 'no data'}`);
    return;
  }

  const add = arg('--add');
  if (add) {
    const repos = add.split(',').map((r) => r.trim()).filter(Boolean);
    let addition: Catalog;
    try {
      addition = await buildCatalog({ repositories: repos }, http, { log: (m) => console.log(`  ${m}`), now: fixedNow });
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.log(`INDEX RATE-LIMITED ${err.message}`);
        process.exit(2);
      }
      throw err;
    }
    const base = JSON.parse(fs.readFileSync(path.resolve(root, out), 'utf8')) as Catalog;
    const merged = mergeCatalogs(base, addition);
    const v = validateCatalog(merged);
    if (!v.ok) {
      console.log(`INDEX FAIL merged catalog is invalid:\n  ${v.errors.join('\n  ')}`);
      process.exit(1);
    }
    fs.writeFileSync(path.resolve(root, out), JSON.stringify(merged, null, 2) + '\n');
    for (const r of repos) console.log(`  ${r}: ${addition.entries.filter((e) => `${e.owner}/${e.repo}`.toLowerCase() === r.toLowerCase()).length} skills, ${addition.repositoryStats?.[r]?.stars ?? '?'} stars`);
    for (const k of (addition.skipped ?? []).slice(0, 10)) console.log(`  skipped ${k.repo}:${k.path || '(repo)'}: ${k.reason}`);
    console.log(`ADD OK ${base.entries.length} → ${merged.entries.length} entries, ${merged.repositories.length} repositories → ${out}`);
    return;
  }

  let catalog: Catalog;
  try {
    catalog = await buildCatalog(seed, http, { search: process.argv.includes('--search'), log: (m) => console.log(`  ${m}`), now: fixedNow });
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.log(`INDEX RATE-LIMITED ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  const check = validateCatalog(catalog);
  if (!check.ok) {
    console.log(`INDEX FAIL generated catalog is invalid:\n  ${check.errors.join('\n  ')}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(path.resolve(root, out)), { recursive: true });
  fs.writeFileSync(path.resolve(root, out), JSON.stringify(catalog, null, 2) + '\n');

  const sampleN = Number(arg('--sample') ?? 0);
  if (sampleN > 0) {
    const sample: Catalog = { ...catalog, source: 'sample', entries: catalog.entries.slice(0, sampleN), skipped: [] };
    sample.repositories = [...new Set(sample.entries.map((e) => `${e.owner}/${e.repo}`))];
    fs.writeFileSync(path.resolve(root, 'data/catalog.sample.json'), JSON.stringify(sample, null, 2) + '\n');
    console.log(`  wrote data/catalog.sample.json (${sample.entries.length} entries, source "sample")`);
  }

  const remaining = 'remaining' in http ? (http as { remaining(): string | undefined }).remaining() : undefined;
  console.log(`INDEX OK ${live ? 'live' : 'replay'}: ${catalog.entries.length} entries from ${catalog.repositories.length} repositories, ${catalog.skipped?.length ?? 0} skipped → ${out}${remaining !== undefined ? ` (GitHub API requests remaining: ${remaining})` : ''}`);
  for (const s of catalog.skipped ?? []) console.log(`  skipped ${s.repo}:${s.path || '(root)'}: ${s.reason}`);
  const sampleEntry = catalog.entries.find((e) => e.kind === 'skill') ?? catalog.entries[0];
  if (sampleEntry) {
    const { files, ...rest } = sampleEntry;
    console.log('  example entry:');
    console.log(JSON.stringify({ ...rest, files: `${files.length} files (${files.map((f) => f.path).slice(0, 6).join(', ')}${files.length > 6 ? ', …' : ''})` }, null, 2).replace(/^/gm, '  '));
  }
}

void main();

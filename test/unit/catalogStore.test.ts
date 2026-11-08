import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCatalog, readCache } from '../../src/core/catalogStore';
import { catalogOf, makeEntry } from './helpers/catalogFixtures';

let tmp: string;
let cacheFile: string;
let bundled: string;
let remoteJson: string;
const url = 'https://example.invalid/catalog.json';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skilltree-cat-'));
  cacheFile = path.join(tmp, 'cache', 'catalog.json');
  bundled = path.join(tmp, 'bundled.json');
  const e = await makeEntry(path.join(tmp, 'mirror'), { 'SKILL.md': 'x' });
  await fs.writeFile(bundled, JSON.stringify(catalogOf([e], 'sample')));
  remoteJson = JSON.stringify(catalogOf([{ ...e, name: 'remote-version' }]));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('loadCatalog', () => {
  it('uses the bundled catalog when no URL is configured (no network)', async () => {
    const r = await loadCatalog({ url: '', cacheFile, bundledFiles: [bundled], fetchText: async () => { throw new Error('must not fetch'); } });
    expect(r.origin).toBe('bundled');
    expect(r.error).toBeUndefined();
    expect(r.catalog?.source).toBe('sample');
  });

  it('fetches, validates and caches the remote catalog', async () => {
    const r = await loadCatalog({ url, cacheFile, bundledFiles: [bundled], fetchText: async () => remoteJson, now: () => new Date('2026-02-01T00:00:00Z') });
    expect(r.origin).toBe('remote');
    expect(r.catalog?.entries[0].name).toBe('remote-version');
    expect((await readCache(cacheFile))?.fetchedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('falls back to the cache when offline, with the age and the error', async () => {
    await loadCatalog({ url, cacheFile, bundledFiles: [bundled], fetchText: async () => remoteJson, now: () => new Date('2026-02-01T00:00:00Z') });
    const r = await loadCatalog({ url, cacheFile, bundledFiles: [bundled], fetchText: async () => { throw new Error('ENOTFOUND'); } });
    expect(r.origin).toBe('cache');
    expect(r.fetchedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(r.error).toMatch(/ENOTFOUND/);
    expect(r.catalog?.entries[0].name).toBe('remote-version');
  });

  it('rejects invalid remote JSON or schema and keeps the cache untouched', async () => {
    await loadCatalog({ url, cacheFile, bundledFiles: [bundled], fetchText: async () => remoteJson });
    const bad = await loadCatalog({ url, cacheFile, bundledFiles: [bundled], fetchText: async () => '{not json' });
    expect(bad.origin).toBe('cache');
    expect(bad.error).toMatch(/not valid JSON/);
    const wrong = await loadCatalog({ url, cacheFile, bundledFiles: [bundled], fetchText: async () => JSON.stringify({ schemaVersion: 99 }) });
    expect(wrong.origin).toBe('cache');
    expect(wrong.error).toMatch(/validation/);
  });

  it('does not use a cache from a different URL; falls back to bundled', async () => {
    await loadCatalog({ url, cacheFile, bundledFiles: [bundled], fetchText: async () => remoteJson });
    const r = await loadCatalog({ url: 'https://other.invalid/c.json', cacheFile, bundledFiles: [bundled], fetchText: async () => { throw new Error('offline'); } });
    expect(r.origin).toBe('bundled');
    expect(r.error).toMatch(/offline/);
  });

  it('reports none when nothing is available', async () => {
    const r = await loadCatalog({ url, cacheFile, bundledFiles: [path.join(tmp, 'missing.json')], fetchText: async () => { throw new Error('offline'); } });
    expect(r.origin).toBe('none');
    expect(r.catalog).toBeNull();
  });
});

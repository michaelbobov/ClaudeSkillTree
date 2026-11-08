// Catalog loading: remote URL (optional) → last good cached copy → catalog bundled with the
// extension. Pure Node; the extension passes paths and the fetch function.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CATALOG_LIMITS, validateCatalog, type Catalog } from '../shared/catalog';

export type CatalogOrigin = 'remote' | 'cache' | 'bundled' | 'none';

export interface CatalogLoadResult {
  catalog: Catalog | null;
  origin: CatalogOrigin;
  /** When the shown catalog was fetched (remote/cache), or null for the bundled copy. */
  fetchedAt: string | null;
  url: string | null;
  /** Why the preferred source was not used, e.g. a network error. */
  error?: string;
}

interface CacheFile {
  url: string;
  fetchedAt: string;
  catalog: unknown;
}

export type FetchText = (url: string, timeoutMs: number) => Promise<string>;

export const defaultFetchText: FetchText = async (url, timeoutMs) => {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'))) {
    throw new Error('Catalog URL must use https.');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'skilltree' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > CATALOG_LIMITS.maxCatalogBytes) throw new Error('catalog is too large');
    const text = await res.text();
    if (text.length > CATALOG_LIMITS.maxCatalogBytes) throw new Error('catalog is too large');
    return text;
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error(`timed out after ${timeoutMs} ms`);
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(cause?.code ?? cause?.message ?? (err as Error).message);
  } finally {
    clearTimeout(timer);
  }
};

async function readJson(file: string): Promise<unknown> {
  const st = await fs.stat(file);
  if (st.size > CATALOG_LIMITS.maxCatalogBytes) throw new Error('file too large');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function readCache(cacheFile: string): Promise<{ url: string; fetchedAt: string; catalog: Catalog } | null> {
  try {
    const raw = (await readJson(cacheFile)) as CacheFile;
    const v = validateCatalog(raw?.catalog);
    if (!v.ok || typeof raw.url !== 'string' || typeof raw.fetchedAt !== 'string') return null;
    return { url: raw.url, fetchedAt: raw.fetchedAt, catalog: v.catalog };
  } catch {
    return null;
  }
}

export async function writeCache(cacheFile: string, url: string, catalog: Catalog, fetchedAt: string): Promise<void> {
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  const tmp = `${cacheFile}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ url, fetchedAt, catalog } satisfies CacheFile));
  await fs.rename(tmp, cacheFile);
}

export async function loadBundled(bundledFiles: string[]): Promise<{ catalog: Catalog; file: string } | { error: string }> {
  const problems: string[] = [];
  for (const file of bundledFiles) {
    try {
      const v = validateCatalog(await readJson(file));
      if (v.ok) return { catalog: v.catalog, file };
      problems.push(`${path.basename(file)}: ${v.errors[0]}`);
    } catch (err) {
      problems.push(`${path.basename(file)}: ${(err as Error).message}`);
    }
  }
  return { error: problems.join('; ') || 'no bundled catalog' };
}

export async function loadCatalog(opts: {
  url?: string | null;
  cacheFile: string;
  bundledFiles: string[];
  fetchText?: FetchText;
  timeoutMs?: number;
  now?: () => Date;
}): Promise<CatalogLoadResult> {
  const url = opts.url?.trim() || null;
  const now = opts.now ?? (() => new Date());
  let error: string | undefined;

  if (url) {
    try {
      const text = await (opts.fetchText ?? defaultFetchText)(url, opts.timeoutMs ?? 10000);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('response is not valid JSON');
      }
      const v = validateCatalog(json);
      if (!v.ok) throw new Error(`catalog failed validation: ${v.errors[0]}`);
      const fetchedAt = now().toISOString();
      await writeCache(opts.cacheFile, url, v.catalog, fetchedAt).catch(() => undefined);
      return { catalog: v.catalog, origin: 'remote', fetchedAt, url };
    } catch (err) {
      error = `Could not load ${url}: ${(err as Error).message}`;
    }
    const cached = await readCache(opts.cacheFile);
    if (cached && cached.url === url) return { catalog: cached.catalog, origin: 'cache', fetchedAt: cached.fetchedAt, url, error };
  }

  const bundled = await loadBundled(opts.bundledFiles);
  if ('catalog' in bundled) return { catalog: bundled.catalog, origin: 'bundled', fetchedAt: null, url, error };
  return { catalog: null, origin: 'none', fetchedAt: null, url, error: [error, bundled.error].filter(Boolean).join('; ') };
}

// Path containment helpers. Used to keep link-opening (and later, installs) inside an allowed folder.

import * as path from 'node:path';

/**
 * True when `target` is `base` or inside it, after resolving `..` segments.
 * Comparison is case-insensitive on Windows and macOS (default case-insensitive filesystems).
 */
export function isContained(base: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (s: string) => {
    const r = p.resolve(s);
    return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r;
  };
  const b = norm(base);
  const t = norm(target);
  if (t === b) return true;
  const rel = p.relative(b, t);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + p.sep) && !p.isAbsolute(rel);
}

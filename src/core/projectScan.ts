// Gathers ProjectFacts for "For this project" from a workspace folder: a bounded walk for file paths,
// and dependency names from a few manifest formats. Reads nothing but manifests, writes nothing,
// follows no symlinks, and stops at fixed limits so a huge repository cannot stall the host.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProjectFacts } from '../shared/projectFit';

export interface ScanLimits {
  maxFiles: number;
  maxDepth: number;
  maxManifestBytes: number;
  maxManifests: number;
}

export const SCAN_LIMITS: Readonly<ScanLimits> = { maxFiles: 5000, maxDepth: 5, maxManifestBytes: 512 * 1024, maxManifests: 40 };

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', 'Pods', 'DerivedData',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.venv', 'venv', 'env', '__pycache__', '.tox', '.mypy_cache',
  '.pytest_cache', '.gradle', '.idea', '.vscode-test', 'bower_components', 'site-packages',
]);
/** Dot-folders worth looking into; every other one is skipped. */
const DOT_DIRS = new Set(['.github', '.claude']);

const MANIFESTS = new Set(['package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'Cargo.toml', 'go.mod', 'Gemfile', 'composer.json', 'pubspec.yaml']);

export async function scanProject(root: string, limits: Readonly<ScanLimits> = SCAN_LIMITS): Promise<ProjectFacts> {
  const files: string[] = [];
  const manifests: string[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (files.length >= limits.maxFiles) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const subdirs: string[] = [];
    for (const d of entries) {
      if (files.length >= limits.maxFiles) return;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isFile()) {
        files.push(r);
        if ((MANIFESTS.has(d.name) || /^requirements[\w.-]*\.txt$/.test(d.name)) && manifests.length < limits.maxManifests) manifests.push(r);
      } else if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name) || (d.name.startsWith('.') && !DOT_DIRS.has(d.name))) continue;
        // Folder markers such as "k8s/" or "*.xcodeproj/" are facts too.
        files.push(`${r}/`);
        if (depth < limits.maxDepth && !d.name.endsWith('.xcodeproj')) subdirs.push(d.name);
      }
      // Symlinks are neither followed nor listed.
    }
    for (const name of subdirs) await walk(path.join(dir, name), rel ? `${rel}/${name}` : name, depth + 1);
  };
  await walk(root, '', 0);

  const deps: ProjectFacts['deps'] = [];
  for (const rel of manifests) {
    try {
      const file = path.join(root, ...rel.split('/'));
      const st = await fs.stat(file);
      if (!st.isFile() || st.size > limits.maxManifestBytes) continue;
      const names = manifestDeps(path.basename(rel), await fs.readFile(file, 'utf8'));
      if (names.length) deps.push({ manifest: rel, names });
    } catch {
      /* unreadable manifest: skip */
    }
  }
  return { files, deps };
}

/** Dependency names declared in one manifest. Tolerant: malformed files give what can be read, or []. */
export function manifestDeps(basename: string, text: string): string[] {
  const out = new Set<string>();
  const add = (n: string | undefined) => {
    const v = n?.trim().toLowerCase();
    if (v && v.length <= 214 && /^[@a-z0-9][\w.@/-]*$/i.test(v)) out.add(v);
  };
  try {
    if (basename === 'package.json' || basename === 'composer.json') {
      const j = JSON.parse(text) as Record<string, unknown>;
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'require', 'require-dev']) {
        const block = j[key];
        if (block && typeof block === 'object' && !Array.isArray(block)) Object.keys(block).forEach(add);
      }
      const engines = j.engines as Record<string, unknown> | undefined;
      if (basename === 'package.json' && engines && typeof engines === 'object' && typeof engines.vscode === 'string') out.add('engines:vscode');
    } else if (/^requirements[\w.-]*\.txt$/.test(basename)) {
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*([A-Za-z0-9][\w.-]*)/.exec(line.replace(/#.*/, ''));
        if (m && !line.trimStart().startsWith('-')) add(m[1]);
      }
    } else if (basename === 'pyproject.toml' || basename === 'Pipfile') {
      // PEP 621 `dependencies = ["x>=1", ...]` arrays and [tool.poetry.dependencies]/[packages] tables.
      for (const arr of text.matchAll(/^\s*(?:dependencies|requires)\s*=\s*\[([\s\S]*?)\]/gm)) {
        for (const s of arr[1].matchAll(/["']\s*([A-Za-z0-9][\w.-]*)/g)) add(s[1]);
      }
      tableKeys(text, /^\[(tool\.poetry\.(dev-)?dependencies|tool\.poetry\.group\.[\w-]+\.dependencies|packages|dev-packages)\]\s*$/).forEach(add);
      out.delete('python');
    } else if (basename === 'Cargo.toml') {
      tableKeys(text, /^\[(dev-|build-)?dependencies\]\s*$/).forEach(add);
    } else if (basename === 'go.mod') {
      for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[\w./-]+)\s+v\d/gm)) add(m[1]);
    } else if (basename === 'Gemfile') {
      for (const m of text.matchAll(/^\s*gem\s+["']([\w.-]+)["']/gm)) add(m[1]);
    } else if (basename === 'pubspec.yaml') {
      let inDeps = false;
      for (const line of text.split(/\r?\n/)) {
        if (/^(dev_)?dependencies:\s*$/.test(line)) inDeps = true;
        else if (/^\S/.test(line)) inDeps = false;
        else if (inDeps) add(/^ {2}([\w-]+):/.exec(line)?.[1]);
      }
    }
  } catch {
    /* malformed: keep what was read */
  }
  return [...out];
}

function tableKeys(text: string, header: RegExp): string[] {
  const keys: string[] = [];
  let inTable = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inTable = header.test(line.trim());
    else if (inTable) {
      const m = /^\s*([A-Za-z0-9][\w.-]*)\s*=/.exec(line);
      if (m) keys.push(m[1]);
    }
  }
  return keys;
}

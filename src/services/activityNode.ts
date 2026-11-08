// Locates executables on PATH without a shell or running anything. No VS Code dependency.
import { existsSync } from 'node:fs';
import * as path from 'node:path';

export function findNode(envPath = process.env.PATH ?? '', name = 'node'): string | null {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (existsSync(p)) return p;
    }
  }
  if (name === 'node') for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) if (existsSync(p)) return p;
  return null;
}

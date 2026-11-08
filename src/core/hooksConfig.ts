// Installs/removes SkillTree's activity hooks in a Claude Code settings file. Pure Node.
//
// - Refuses to touch a settings file that is not valid JSON.
// - Backs the file up first and writes atomically (temp file + rename).
// - Adds exactly two handlers, identified by the recorder path in `args[0]`:
//     PreToolUse (matcher "Skill") and UserPromptExpansion (all prompt-type commands).
// - Disable restores the backup byte-for-byte when the file is unchanged since enabling;
//   otherwise it removes only SkillTree's handlers and leaves everything else alone.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface TrackingInstall {
  settingsFile: string;
  /** null when the settings file did not exist before enabling. */
  backupFile: string | null;
  /** sha256 of the file content SkillTree wrote. */
  writtenHash: string;
  recorderPath: string;
  logFile: string;
  installedAt: string;
}

type Handler = { type?: string; command?: string; args?: unknown[]; timeout?: number; async?: boolean; [k: string]: unknown };
type Group = { matcher?: string; hooks?: Handler[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, Group[] | unknown>; [k: string]: unknown };

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export class HooksConfigError extends Error {}

async function readSettings(file: string): Promise<{ text: string | null; json: Settings }> {
  let text: string | null = null;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new HooksConfigError(`Cannot read ${file}: ${(err as Error).message}`);
  }
  if (text === null || text.trim() === '') return { text, json: {} };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new HooksConfigError(`${file} is not valid JSON. SkillTree will not modify it.`);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new HooksConfigError(`${file} does not contain a JSON object.`);
  const hooks = (json as Settings).hooks;
  if (hooks !== undefined && (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks))) throw new HooksConfigError(`"hooks" in ${file} is not an object.`);
  return { text, json: json as Settings };
}

async function atomicWrite(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.skilltree-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.rename(tmp, file);
}

export function isSkillTreeHandler(h: unknown, recorderPath: string): boolean {
  return typeof h === 'object' && h !== null && Array.isArray((h as Handler).args) && (h as Handler).args![0] === recorderPath;
}

export function skillTreeHandlers(nodePath: string, recorderPath: string, logFile: string): Record<'PreToolUse' | 'UserPromptExpansion', Group> {
  // Synchronous on purpose: the recorder finishes in ~15 ms, and Claude Code ends `-p` sessions by
  // killing async hooks still running, which can lose the event of a short session.
  const handler = (): Handler => ({ type: 'command', command: nodePath, args: [recorderPath, logFile], timeout: 5 });
  return {
    PreToolUse: { matcher: 'Skill', hooks: [handler()] },
    UserPromptExpansion: { hooks: [handler()] },
  };
}

/** True when the settings JSON already contains SkillTree's handlers for both events. */
export function hasTracking(json: Settings, recorderPath: string): boolean {
  const events = ['PreToolUse', 'UserPromptExpansion'];
  return events.every((ev) => {
    const groups = json.hooks?.[ev];
    return Array.isArray(groups) && groups.some((g: Group) => g?.hooks?.some((h) => isSkillTreeHandler(h, recorderPath)));
  });
}

export async function enableTracking(opts: {
  settingsFile: string;
  nodePath: string;
  recorderPath: string;
  logFile: string;
  now?: () => Date;
  /** Handler groups to add instead of the activity recorder's (identified by args[0] === recorderPath). */
  groups?: Record<string, Group>;
}): Promise<TrackingInstall> {
  const now = (opts.now ?? (() => new Date()))();
  const { text, json } = await readSettings(opts.settingsFile);
  const installedAt = now.toISOString();
  let backupFile: string | null = null;
  if (text !== null) {
    backupFile = `${opts.settingsFile}.skilltree-backup-${installedAt.replace(/[:.]/g, '-')}`;
    await fs.writeFile(backupFile, text, { flag: 'wx', mode: 0o600 });
  }
  const next: Settings = structuredClone(json);
  next.hooks = (next.hooks as Record<string, Group[]>) ?? {};
  const add: Record<string, Group> = opts.groups ?? skillTreeHandlers(opts.nodePath, opts.recorderPath, opts.logFile);
  for (const [event, group] of Object.entries(add)) {
    const existing = next.hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) throw new HooksConfigError(`hooks.${event} in ${opts.settingsFile} is not an array.`);
    // Drop any older SkillTree handler first (idempotent re-enable).
    // Only groups emptied by removing SkillTree's own handler are dropped; the user's groups stay as they are.
    const groups: Group[] = [];
    for (const g of (existing as Group[] | undefined) ?? []) {
      const had = (g.hooks ?? []).some((h) => isSkillTreeHandler(h, opts.recorderPath));
      if (!had) {
        groups.push(g);
        continue;
      }
      const hooks = (g.hooks ?? []).filter((h) => !isSkillTreeHandler(h, opts.recorderPath));
      if (hooks.length) groups.push({ ...g, hooks });
    }
    groups.push(group);
    next.hooks[event] = groups;
  }
  const written = JSON.stringify(next, null, 2) + '\n';
  await atomicWrite(opts.settingsFile, written);
  return { settingsFile: opts.settingsFile, backupFile, writtenHash: sha256(written), recorderPath: opts.recorderPath, logFile: opts.logFile, installedAt };
}

export interface DisableResult {
  /** "restored": file put back exactly as before; "removed": only SkillTree handlers removed; "absent": nothing to do. */
  mode: 'restored' | 'removed' | 'absent';
  removedHandlers: number;
}

export async function disableTracking(install: Pick<TrackingInstall, 'settingsFile' | 'backupFile' | 'writtenHash' | 'recorderPath'>): Promise<DisableResult> {
  let current: string | null = null;
  try {
    current = await fs.readFile(install.settingsFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (current === null) return { mode: 'absent', removedHandlers: 0 };

  if (sha256(current) === install.writtenHash) {
    if (install.backupFile) {
      const original = await fs.readFile(install.backupFile, 'utf8');
      await atomicWrite(install.settingsFile, original);
      await fs.rm(install.backupFile, { force: true });
    } else {
      await fs.rm(install.settingsFile, { force: true });
    }
    return { mode: 'restored', removedHandlers: 2 };
  }

  // The file changed since enabling: surgically remove only SkillTree's handlers.
  const { json } = await readSettings(install.settingsFile);
  let removed = 0;
  for (const [event, groups] of Object.entries(json.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g: Group) => {
        const hooks = (g.hooks ?? []).filter((h) => {
          const mine = isSkillTreeHandler(h, install.recorderPath);
          if (mine) removed++;
          return !mine;
        });
        return { ...g, hooks };
      })
      .filter((g: Group, i: number) => (g.hooks?.length ?? 0) > 0 || (groups[i] as Group).hooks?.length === 0);
    if (kept.length) json.hooks![event] = kept;
    else delete json.hooks![event];
  }
  if (json.hooks && Object.keys(json.hooks).length === 0) delete json.hooks;
  if (removed === 0) return { mode: 'absent', removedHandlers: 0 };
  await atomicWrite(install.settingsFile, JSON.stringify(json, null, 2) + '\n');
  return { mode: 'removed', removedHandlers: removed };
}

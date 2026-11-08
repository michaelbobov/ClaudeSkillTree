// File-based bridge between SkillTree's MCP server (spawned by Claude Code) and the SkillTree
// extension (running in VS Code). No sockets or network: plain files under
// <home>/.claude/skilltree/bridge/, each written atomically (temp file + rename).
//
//   windows/<pid>.json     heartbeat of each VS Code window running SkillTree (folders it has open)
//   requests/<id>.json     an install Claude asked for; a window claims it by renaming it
//   responses/<id>.json    the outcome, written by the window that handled the request
//   catalog.json           the catalog the extension last loaded and validated (read by the MCP server)
//   suggestions/<id>.json  skills SkillTree's prompt hook matched; the window shows them as a notification
//
// Installs always go through the extension's confirmation dialog; the MCP server cannot install.

import * as path from 'node:path';

export const BRIDGE_VERSION = 1;
/** A window counts as running if its heartbeat is younger than this. */
export const HEARTBEAT_STALE_MS = 30_000;
export const HEARTBEAT_EVERY_MS = 10_000;
/** How long Claude waits for the user to answer the install dialog. */
export const REQUEST_TIMEOUT_MS = 5 * 60_000;

export function bridgePaths(baseDir: string) {
  const root = path.join(baseDir, 'bridge');
  return {
    root,
    windows: path.join(root, 'windows'),
    requests: path.join(root, 'requests'),
    responses: path.join(root, 'responses'),
    catalog: path.join(root, 'catalog.json'),
    suggestions: path.join(root, 'suggestions'),
  };
}

export interface WindowHeartbeat {
  v: 1;
  pid: number;
  folders: string[];
  updatedAt: string;
}

export interface InstallRequest {
  v: 1;
  id: string;
  skillId: string;
  scope: 'project' | 'global';
  /** Claude's one-line reason, shown to the user in the confirmation dialog. */
  reason: string;
  /** The Claude Code session's project directory. */
  projectDir: string | null;
  createdAt: string;
}

/** Written by the UserPromptSubmit hook. Holds catalog ids only, never prompt text. */
export interface SkillSuggestion {
  v: 1;
  id: string;
  skillIds: string[];
  projectDir: string | null;
  sessionId: string | null;
  createdAt: string;
}

export function parseSkillSuggestion(raw: unknown): SkillSuggestion | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !isRequestId(r.id)) return null;
  if (!Array.isArray(r.skillIds) || r.skillIds.length === 0 || r.skillIds.length > 5 || !r.skillIds.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 400)) return null;
  if (r.projectDir !== null && (typeof r.projectDir !== 'string' || !path.isAbsolute(r.projectDir))) return null;
  if (r.sessionId !== null && typeof r.sessionId !== 'string') return null;
  if (typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt))) return null;
  return { v: 1, id: r.id, skillIds: r.skillIds as string[], projectDir: r.projectDir as string | null, sessionId: (r.sessionId as string | null) ?? null, createdAt: r.createdAt };
}

export interface InstallResponse {
  v: 1;
  id: string;
  status: 'installed' | 'cancelled' | 'failed';
  message: string;
  /** Installed skill folder and the slash command it is available as. */
  destDir?: string;
  command?: string;
}

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export function isRequestId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}

/** Validates a request read from disk (written by another process). */
export function parseInstallRequest(raw: unknown): InstallRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !isRequestId(r.id)) return null;
  if (typeof r.skillId !== 'string' || r.skillId.length === 0 || r.skillId.length > 400) return null;
  if (r.scope !== 'project' && r.scope !== 'global') return null;
  if (typeof r.reason !== 'string') return null;
  if (r.projectDir !== null && (typeof r.projectDir !== 'string' || !path.isAbsolute(r.projectDir))) return null;
  if (typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt))) return null;
  return { v: 1, id: r.id, skillId: r.skillId, scope: r.scope, reason: r.reason.slice(0, 300), projectDir: r.projectDir as string | null, createdAt: r.createdAt };
}

export function parseInstallResponse(raw: unknown): InstallResponse | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !isRequestId(r.id)) return null;
  if (r.status !== 'installed' && r.status !== 'cancelled' && r.status !== 'failed') return null;
  if (typeof r.message !== 'string') return null;
  return {
    v: 1,
    id: r.id,
    status: r.status,
    message: r.message.slice(0, 1000),
    ...(typeof r.destDir === 'string' ? { destDir: r.destDir } : {}),
    ...(typeof r.command === 'string' ? { command: r.command } : {}),
  };
}

export function parseHeartbeat(raw: unknown): WindowHeartbeat | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !Number.isInteger(r.pid) || !Array.isArray(r.folders) || !r.folders.every((f) => typeof f === 'string')) return null;
  if (typeof r.updatedAt !== 'string' || Number.isNaN(Date.parse(r.updatedAt))) return null;
  return { v: 1, pid: r.pid as number, folders: r.folders as string[], updatedAt: r.updatedAt };
}

/** True when `dir` is `folder` or inside it (paths already resolved). */
export function isWithin(folder: string, dir: string): boolean {
  const rel = path.relative(folder, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

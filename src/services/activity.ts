// Opt-in activity tracking: installs SkillTree's recorder hook into a Claude Code settings file
// after explicit consent, reads the local activity log, and removes everything on disable.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { realpathSync } from 'node:fs';
import * as vscode from 'vscode';
import { groupBySession, parseActivityLog, summarizeUsage, workspaceUsage, type ActivityEvent, type UsageSummary } from '../shared/activity';
import { disableTracking, enableTracking, HooksConfigError, type TrackingInstall } from '../core/hooksConfig';
import type { SkillStore } from './skillStore';
import { findNode } from './activityNode';
export { findNode };

export type TrackingScope = 'user' | 'project';

const POLL_MS = 2000;

const realDirs = new Map<string, string>();
/**
 * A folder as the file system sees it: symlinks resolved (macOS reports /private/var/… for /var/…),
 * lower-cased where file names ignore case. Unknown or missing folders are compared as given.
 */
export function normalizeDir(dir: string): string {
  let real = realDirs.get(dir);
  if (real === undefined) {
    try {
      real = realpathSync.native(dir);
    } catch {
      real = dir;
    }
    if (realDirs.size > 500) realDirs.clear();
    realDirs.set(dir, real);
  }
  return process.platform === 'darwin' || process.platform === 'win32' ? real.toLowerCase() : real;
}

export interface ActivityState {
  enabled: boolean;
  scope: TrackingScope | null;
  settingsFile: string | null;
  logFile: string;
  installedAt: string | null;
  events: ActivityEvent[];
  skippedLines: number;
  /** Session id → when Claude Code reported it ended (SessionEnd hook). */
  ended: Record<string, string>;
  error?: string;
}

export type TrackingConsent = (details: { userSettings: string; projectSettings: string | null; logFile: string }) => Promise<TrackingScope | undefined>;

const KEY = 'skilltree.tracking.v1';
const MAX_LOG_READ = 5 * 1024 * 1024;

type StoredInstall = TrackingInstall & { scope: TrackingScope };

export class ActivityService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ActivityState>();
  readonly onDidChange = this.emitter.event;
  private state: ActivityState;
  private watcher: vscode.FileSystemWatcher | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;
  private readonly focusListener: vscode.Disposable;
  private readonly pollTimer: NodeJS.Timeout;
  private lastLogStat = '';

  /** Test-only: answers the consent prompt. */
  testConsent: TrackingConsent | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SkillStore,
    private readonly log: vscode.LogOutputChannel,
  ) {
    const inst = this.install;
    this.state = { enabled: !!inst, scope: inst?.scope ?? null, settingsFile: inst?.settingsFile ?? null, logFile: this.logFile, installedAt: inst?.installedAt ?? null, events: [], skippedLines: 0, ended: {} };
    void vscode.commands.executeCommand('setContext', 'skilltree.trackingEnabled', !!inst);
    this.watch();
    // Claude Code usually runs in another window; re-read the log when this one regains focus, in case
    // a file event was missed (e.g. the log folder did not exist yet when the watcher started).
    this.focusListener = vscode.window.onDidChangeWindowState((s) => {
      if (s.focused && this.install) this.scheduleReload();
    });
    // The file watcher does not always report changes to a log outside the workspace (seen with
    // macOS temp folders reached through a symlink). While tracking is on, also compare the log's
    // size and modification time every 2 s, so new uses show up without refocusing the window.
    this.pollTimer = setInterval(() => void this.pollLog(), POLL_MS);
    void this.reload();
  }

  private async pollLog(): Promise<void> {
    if (!this.install) return;
    let key = '';
    try {
      const st = await fs.stat(this.logFile);
      key = `${st.size}:${st.mtimeMs}`;
    } catch {
      key = 'missing';
    }
    if (key !== this.lastLogStat) {
      this.lastLogStat = key;
      this.scheduleReload();
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), 200);
  }

  get snapshot(): ActivityState {
    return this.state;
  }

  get baseDir(): string {
    return path.join(this.store.homeDir, '.claude', 'skilltree');
  }
  get logFile(): string {
    return path.join(this.baseDir, 'activity.jsonl');
  }
  get recorderPath(): string {
    return path.join(this.baseDir, 'record-skill-event.mjs');
  }
  private get install(): StoredInstall | undefined {
    return this.context.globalState.get<StoredInstall>(KEY);
  }

  private watch(): void {
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(this.baseDir), 'activity.jsonl*'));
    const onChange = () => this.scheduleReload();
    this.watcher.onDidCreate(onChange);
    this.watcher.onDidChange(onChange);
    this.watcher.onDidDelete(onChange);
  }

  async reload(): Promise<ActivityState> {
    const inst = this.install;
    let events: ActivityEvent[] = [];
    let skipped = 0;
    let ended: Record<string, string> = {};
    let error: string | undefined;
    try {
      const fh = await fs.open(this.logFile, 'r');
      try {
        const st = await fh.stat();
        const start = Math.max(0, st.size - MAX_LOG_READ);
        const buf = Buffer.alloc(st.size - start);
        await fh.read(buf, 0, buf.length, start);
        let text = buf.toString('utf8');
        if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop a partial first line
        ({ events, skipped, ended } = parseActivityLog(text, 2000));
      } finally {
        await fh.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') error = `Could not read ${this.logFile}: ${(err as Error).message}`;
    }
    this.state = { enabled: !!inst, scope: inst?.scope ?? null, settingsFile: inst?.settingsFile ?? null, logFile: this.logFile, installedAt: inst?.installedAt ?? null, events, skippedLines: skipped, ended, error };
    this.emitter.fire(this.state);
    return this.state;
  }

  /** Recorded use per skill and same-session pairs, for the Skill Tree (cached per log reload). */
  usage(): UsageSummary {
    if (this.usageCache?.events !== this.state.events) this.usageCache = { events: this.state.events, summary: summarizeUsage(this.state.events) };
    return this.usageCache.summary;
  }
  private usageCache: { events: ActivityEvent[]; summary: UsageSummary } | undefined;

  /** Usage split for one window's workspace (see workspaceUsage). Cached per log reload and inputs. */
  workspaceUsage(dirs: string[], projectOnly: Set<string>): { all: UsageSummary; here?: UsageSummary } {
    const key = `${dirs.join('\u0000')}\u0001${[...projectOnly].sort().join('\u0000')}`;
    if (this.splitCache?.events !== this.state.events || this.splitCache.key !== key) {
      const split = dirs.length ? workspaceUsage(this.state.events, { workspaceDirs: dirs, projectOnlyKeys: projectOnly, normalize: normalizeDir }) : { all: this.usage() };
      this.splitCache = { events: this.state.events, key, value: split };
    }
    return this.splitCache.value;
  }
  private splitCache: { events: ActivityEvent[]; key: string; value: { all: UsageSummary; here?: UsageSummary } } | undefined;

  sessions() {
    return groupBySession(this.state.events);
  }

  private projectSettingsFile(): string | null {
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file');
    return folder && vscode.workspace.isTrusted ? path.join(folder.uri.fsPath, '.claude', 'settings.local.json') : null;
  }

  private async askConsent(userSettings: string, projectSettings: string | null): Promise<TrackingScope | undefined> {
    if (this.testConsent) return this.testConsent({ userSettings, projectSettings, logFile: this.logFile });
    const detail = [
      'SkillTree will add three hooks to a Claude Code settings file:',
      '  • PreToolUse with matcher "Skill" (Claude or a subagent invokes a skill)',
      '  • UserPromptExpansion (you type a /skill or /command)',
      '  • SessionEnd (a session ended, so it leaves the Live list)',
      '',
      `Each runs a small local recorder (${this.recorderPath}) that appends one line to`,
      `${this.logFile}: time, skill name, capture source, session id, working directory and,`,
      'for a subagent, its type and id. A session end records only the session id and time.',
      '',
      'Prompt text and command arguments are not recorded. Nothing leaves your machine.',
      'Each hook finishes in about 15 ms and always succeeds; it never blocks or changes what Claude does.',
      'A backup of the settings file is saved first. Run "SkillTree: Disable Activity Tracking" to undo.',
      'Takes effect in Claude Code sessions after the settings file is reloaded.',
    ].join('\n');
    const all = 'Enable for all projects';
    const one = 'Enable for this project';
    const buttons = projectSettings ? [all, one] : [all];
    const choice = await vscode.window.showInformationMessage('Enable local Claude Code skill activity tracking?', { modal: true, detail }, ...buttons);
    return choice === all ? 'user' : choice === one ? 'project' : undefined;
  }

  async enable(): Promise<{ status: 'enabled' | 'cancelled' | 'failed'; message: string; settingsFile?: string }> {
    if (this.install) return { status: 'enabled', message: `Tracking is already enabled in ${this.install.settingsFile}.`, settingsFile: this.install.settingsFile };
    const userSettings = path.join(this.store.homeDir, '.claude', 'settings.json');
    const projectSettings = this.projectSettingsFile();
    const scope = await this.askConsent(userSettings, projectSettings);
    if (!scope) return { status: 'cancelled', message: 'Activity tracking was not enabled.' };
    const settingsFile = scope === 'user' ? userSettings : projectSettings;
    if (!settingsFile) return { status: 'failed', message: 'Project tracking needs a trusted workspace folder.' };
    const nodePath = findNode();
    if (!nodePath) return { status: 'failed', message: 'Node.js was not found on PATH. The activity recorder hook needs Node.js to run.' };
    try {
      await fs.mkdir(this.baseDir, { recursive: true });
      this.watch(); // the folder exists now, so the log watcher can attach to it
      await fs.copyFile(path.join(this.context.extensionPath, 'dist', 'recorder', 'record-skill-event.mjs'), this.recorderPath);
      const inst = await enableTracking({ settingsFile, nodePath, recorderPath: this.recorderPath, logFile: this.logFile });
      await this.context.globalState.update(KEY, { ...inst, scope } satisfies StoredInstall);
      await vscode.commands.executeCommand('setContext', 'skilltree.trackingEnabled', true);
      this.log.info(`Activity tracking enabled in ${settingsFile} (backup: ${inst.backupFile ?? 'none, file was new'})`);
      await this.reload();
      return { status: 'enabled', message: `Activity tracking enabled in ${settingsFile}.`, settingsFile };
    } catch (err) {
      const message = err instanceof HooksConfigError ? err.message : `Could not enable tracking: ${(err as Error).message}`;
      return { status: 'failed', message };
    }
  }

  async disable(): Promise<{ status: 'disabled' | 'absent' | 'failed'; message: string }> {
    const inst = this.install;
    if (!inst) return { status: 'absent', message: 'Activity tracking is not enabled.' };
    try {
      const r = await disableTracking(inst);
      await this.context.globalState.update(KEY, undefined);
      await vscode.commands.executeCommand('setContext', 'skilltree.trackingEnabled', false);
      await fs.rm(this.recorderPath, { force: true });
      this.log.info(`Activity tracking disabled (${r.mode}, ${r.removedHandlers} handlers) in ${inst.settingsFile}`);
      await this.reload();
      const how = r.mode === 'restored' ? 'restored the original settings file' : r.mode === 'removed' ? 'removed SkillTree’s hooks (other changes kept)' : 'no SkillTree hooks were present';
      return { status: 'disabled', message: `Activity tracking disabled: ${how}. The activity log stays at ${this.logFile}.` };
    } catch (err) {
      return { status: 'failed', message: `Could not disable tracking: ${(err as Error).message}` };
    }
  }

  async clearLog(): Promise<void> {
    await fs.rm(this.logFile, { force: true });
    await fs.rm(`${this.logFile}.1`, { force: true });
    await this.reload();
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    clearInterval(this.pollTimer);
    this.focusListener.dispose();
    this.watcher?.dispose();
    this.emitter.dispose();
  }
}

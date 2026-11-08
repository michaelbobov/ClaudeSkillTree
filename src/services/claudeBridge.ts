// "Let Claude recommend skills": registers SkillTree's MCP server with Claude Code (via `claude mcp
// add`, after consent) and serves install requests from it. Each request is shown to the user in
// SkillTree's normal install confirmation, with Claude's reason; nothing installs without approval.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  HEARTBEAT_EVERY_MS,
  HEARTBEAT_STALE_MS,
  bridgePaths,
  isWithin,
  parseHeartbeat,
  parseInstallRequest,
  parseSkillSuggestion,
  type SkillSuggestion,
  type InstallRequest,
  type InstallResponse,
  type WindowHeartbeat,
} from '../shared/bridge';
import { installFolderName } from '../shared/catalog';
import type { MarketplaceService } from './marketplace';
import type { SkillStore } from './skillStore';
import { claudeCliRunner, findClaudeBinary, type CliRunner } from './claudeCli';
import { findNode } from './activityNode';
import { disableTracking, enableTracking, type TrackingInstall } from '../core/hooksConfig';

const KEY = 'skilltree.claudeRecommendations.v1';
export const MCP_SERVER_NAME = 'skilltree';

type Stored = { registeredAt: string; serverPath: string; via: 'cli' | 'manual'; hook?: TrackingInstall };

function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

async function writeAtomic(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
  await fsp.rename(tmp, file);
}

export class ClaudeBridge implements vscode.Disposable {
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly subs: vscode.Disposable[] = [];
  private handling = new Set<string>();
  private running = false;

  /** Test-only: replaces the Claude Code CLI. */
  testCli: CliRunner | undefined;
  /** Test-only: answers a suggestion notification. */
  testSuggestionChoice: ((s: { name: string; repo: string }) => Promise<'project' | 'global' | 'details' | undefined>) | undefined;
  /** Test-only: answers the consent dialog. */
  testConsent: (() => Promise<boolean>) | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly market: MarketplaceService,
    private readonly store: SkillStore,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.subs.push(market.onDidChange(() => void this.writeCatalog()));
    void vscode.commands.executeCommand('setContext', 'skilltree.claudeRecommendations', this.enabled);
    if (this.enabled) this.start();
  }

  get baseDir(): string {
    return path.join(this.store.homeDir, '.claude', 'skilltree');
  }
  get paths() {
    return bridgePaths(this.baseDir);
  }
  get serverPath(): string {
    return path.join(this.baseDir, 'skilltree-mcp.mjs');
  }
  get suggestPath(): string {
    return path.join(this.baseDir, 'suggest-skills.mjs');
  }
  get userSettings(): string {
    return path.join(this.store.homeDir, '.claude', 'settings.json');
  }
  get enabled(): boolean {
    return !!this.context.globalState.get<Stored>(KEY);
  }

  /** Serve requests (heartbeat + request polling). */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.writeCatalog();
    void this.heartbeat();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_EVERY_MS);
    this.pollTimer = setInterval(() => void this.poll(), 500);
  }

  stop(): void {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    fs.rmSync(path.join(this.paths.windows, `${process.pid}.json`), { force: true });
  }

  private folders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => real(f.uri.fsPath));
  }

  private async heartbeat(): Promise<void> {
    const hb: WindowHeartbeat = { v: 1, pid: process.pid, folders: this.folders(), updatedAt: new Date().toISOString() };
    try {
      await writeAtomic(path.join(this.paths.windows, `${process.pid}.json`), hb);
    } catch (err) {
      this.log.warn(`Claude bridge heartbeat failed: ${(err as Error).message}`);
    }
  }

  /** The MCP server reads the same validated catalog this window uses. */
  private async writeCatalog(): Promise<void> {
    const catalog = this.market.currentCatalog;
    if (!this.running || !catalog) return;
    try {
      await writeAtomic(this.paths.catalog, catalog);
    } catch (err) {
      this.log.warn(`Could not write the catalog for Claude: ${(err as Error).message}`);
    }
  }

  /** Another live window has `dir` open (it should handle that project's requests). */
  private otherWindowHas(dir: string): boolean {
    try {
      for (const n of fs.readdirSync(this.paths.windows)) {
        if (n === `${process.pid}.json` || !n.endsWith('.json')) continue;
        const hb = parseHeartbeat(JSON.parse(fs.readFileSync(path.join(this.paths.windows, n), 'utf8')));
        if (hb && Date.now() - Date.parse(hb.updatedAt) < HEARTBEAT_STALE_MS && hb.folders.some((f) => isWithin(f, dir))) return true;
      }
    } catch {
      /* no other windows */
    }
    return false;
  }

  private async poll(): Promise<void> {
    await this.pollSuggestions();
    let names: string[];
    try {
      names = (await fsp.readdir(this.paths.requests)).filter((n) => n.endsWith('.json'));
    } catch {
      return;
    }
    for (const n of names) {
      const file = path.join(this.paths.requests, n);
      if (this.handling.has(file)) continue;
      let req: InstallRequest | null = null;
      try {
        req = parseInstallRequest(JSON.parse(await fsp.readFile(file, 'utf8')));
      } catch {
        continue; // being written, or garbage
      }
      if (!req) {
        await fsp.rm(file, { force: true });
        continue;
      }
      const project = req.projectDir ? real(req.projectDir) : null;
      const mine = project !== null && this.folders().some((f) => isWithin(f, project));
      // Project installs belong to the window that has the project open; global ones to whoever is
      // free, preferring the project's own window for a short moment.
      if (!mine) {
        if (req.scope === 'project') continue;
        if (project && this.otherWindowHas(project) && Date.now() - Date.parse(req.createdAt) < 3000) continue;
      }
      const claimed = `${file}.claimed-${process.pid}`;
      try {
        await fsp.rename(file, claimed); // atomic: exactly one window wins
      } catch {
        continue;
      }
      this.handling.add(file);
      void this.serve(req, claimed).finally(() => this.handling.delete(file));
    }
  }

  private async pollSuggestions(): Promise<void> {
    let names: string[];
    try {
      names = (await fsp.readdir(this.paths.suggestions)).filter((n) => n.endsWith('.json'));
    } catch {
      return;
    }
    for (const n of names) {
      const file = path.join(this.paths.suggestions, n);
      if (this.handling.has(file)) continue;
      let s: SkillSuggestion | null = null;
      try {
        s = parseSkillSuggestion(JSON.parse(await fsp.readFile(file, 'utf8')));
      } catch {
        continue;
      }
      if (!s || Date.now() - Date.parse(s.createdAt) > 10 * 60_000) {
        await fsp.rm(file, { force: true });
        continue;
      }
      const project = s.projectDir ? real(s.projectDir) : null;
      const mine = project !== null && this.folders().some((f) => isWithin(f, project));
      if (!mine && project && this.otherWindowHas(project)) continue;
      try {
        await fsp.rm(file); // claim: one window shows it
      } catch {
        continue;
      }
      this.handling.add(file);
      void this.suggest(s, mine).finally(() => this.handling.delete(file));
    }
  }

  /** A non-blocking notification for the best match; installing still goes through the confirmation dialog. */
  private async suggest(s: SkillSuggestion, projectOpen: boolean): Promise<void> {
    const entry = s.skillIds.map((id) => this.market.snapshot.entries.find((e) => e.id === id)).find((e) => e && e.installState === 'not-installed');
    if (!entry) return;
    const stats = this.market.snapshot.catalog?.repositoryStats[`${entry.owner}/${entry.repo}`];
    const stars = stats ? ` ★${stats.stars >= 1000 ? `${Math.round(stats.stars / 1000)}k` : stats.stars}` : '';
    let choice: 'project' | 'global' | 'details' | undefined;
    if (this.testSuggestionChoice) choice = await this.testSuggestionChoice({ name: entry.name, repo: `${entry.owner}/${entry.repo}` });
    else {
      const buttons = [...(projectOpen ? ['Install to Project'] : []), 'Install Globally', 'Details'];
      const picked = await vscode.window.showInformationMessage(`SkillTree: "${entry.name}" (${entry.owner}/${entry.repo}${stars}) may help with your Claude Code request.`, ...buttons);
      choice = picked === 'Install to Project' ? 'project' : picked === 'Install Globally' ? 'global' : picked === 'Details' ? 'details' : undefined;
    }
    if (!choice) return;
    if (choice === 'details') {
      await vscode.commands.executeCommand('skilltree.openMarketplace', entry.id);
      return;
    }
    const r = await this.market.install(entry.id, choice, {
      requestedBy: { by: 'suggestion', reason: 'SkillTree matched it to your Claude Code request.' },
      projectDir: choice === 'project' && s.projectDir ? s.projectDir : undefined,
    });
    this.log.info(`Suggestion ${entry.id}: ${r.status}`);
    if (r.status === 'installed') void vscode.window.showInformationMessage(`Installed "${entry.name}". Claude Code picks it up in the running session as /${installFolderName(entry)}.`);
    else if (r.status === 'failed') void vscode.window.showErrorMessage(`SkillTree: ${r.message}`);
  }

  private async serve(req: InstallRequest, claimedFile: string): Promise<void> {
    this.log.info(`Claude asked to install ${req.skillId} (${req.scope}): ${req.reason}`);
    let res: InstallResponse;
    try {
      const entry = this.market.find(req.skillId);
      const r = await this.market.install(req.skillId, req.scope, {
        requestedBy: { by: 'claude', reason: req.reason || 'No reason given.' },
        projectDir: req.scope === 'project' && req.projectDir ? req.projectDir : undefined,
      });
      res =
        r.status === 'installed'
          ? { v: 1, id: req.id, status: 'installed', message: 'Installed.', destDir: r.destDir, command: entry ? `/${installFolderName(entry)}` : undefined }
          : { v: 1, id: req.id, status: r.status, message: r.message };
    } catch (err) {
      res = { v: 1, id: req.id, status: 'failed', message: (err as Error).message };
    }
    await writeAtomic(path.join(this.paths.responses, `${req.id}.json`), res);
    await fsp.rm(claimedFile, { force: true });
    this.log.info(`Install request ${req.id}: ${res.status}`);
  }

  // ---- Opt-in / opt-out --------------------------------------------------------------------------

  private cli(): CliRunner | null {
    if (this.testCli) return this.testCli;
    const bin = findClaudeBinary();
    return bin ? claudeCliRunner(bin) : null;
  }

  private async consent(): Promise<boolean> {
    if (this.testConsent) return this.testConsent();
    const detail = [
      'SkillTree will register a local MCP server named "skilltree" with Claude Code (user scope, using `claude mcp add`). It gives Claude two tools:',
      '  • search_skills: search the SkillTree catalog (public GitHub skills, pinned commits)',
      '  • install_skill: ask to install one, with a one-line reason',
      '',
      `It also adds a UserPromptSubmit hook to ${this.userSettings} (backed up first). It matches the keywords of each prompt against the catalog on this machine and, when a skill you do not have clearly fits, shows you a small notification here and tells Claude. Prompt text is never stored or sent anywhere.`,
      '',
      'Every install still opens this window\'s confirmation dialog with the files, source commit, warnings and Claude\'s reason. Nothing is installed unless you click Install. Skill files are never executed by SkillTree.',
      '',
      'The server runs only when Claude Code starts it, reads the catalog from disk, and talks to this extension through files in ~/.claude/skilltree/bridge/. No network service is started.',
      'Undo any time: "SkillTree: Stop Claude Skill Recommendations".',
    ].join('\n');
    const choice = await vscode.window.showInformationMessage('Let Claude find and suggest skills while you work?', { modal: true, detail }, 'Enable');
    return choice === 'Enable';
  }

  async enable(): Promise<{ status: 'enabled' | 'cancelled' | 'manual' | 'failed'; message: string; command?: string[] }> {
    if (this.enabled) {
      this.start();
      return { status: 'enabled', message: 'Claude skill recommendations are already enabled.' };
    }
    if (!(await this.consent())) return { status: 'cancelled', message: 'Not enabled.' };
    const node = findNode();
    if (!node) return { status: 'failed', message: 'Node.js was not found on PATH; the SkillTree MCP server needs it.' };
    await fsp.mkdir(this.baseDir, { recursive: true });
    await fsp.copyFile(path.join(this.context.extensionPath, 'dist', 'mcp', 'skilltree-mcp.mjs'), this.serverPath);
    await fsp.copyFile(path.join(this.context.extensionPath, 'dist', 'recorder', 'suggest-skills.mjs'), this.suggestPath);
    const args = ['mcp', 'add', '--scope', 'user', MCP_SERVER_NAME, '--', node, this.serverPath, this.baseDir];
    const cli = this.cli();
    let via: Stored['via'] = 'cli';
    if (cli) {
      const r = await cli(args);
      if (r.code !== 0 && !/already exists/i.test(r.out)) return { status: 'failed', message: `claude mcp add failed: ${r.out.slice(0, 400)}` };
    } else {
      via = 'manual';
    }
    // Suggestions in the prompt: a synchronous UserPromptSubmit hook (its stdout becomes context for Claude).
    let hook: TrackingInstall;
    try {
      hook = await enableTracking({
        settingsFile: this.userSettings,
        nodePath: node,
        recorderPath: this.suggestPath,
        logFile: this.baseDir,
        groups: { UserPromptSubmit: { hooks: [{ type: 'command', command: node, args: [this.suggestPath, this.baseDir], timeout: 5 }] } },
      });
    } catch (err) {
      if (cli && via === 'cli') await cli(['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]);
      return { status: 'failed', message: `Could not add the suggestion hook: ${(err as Error).message}` };
    }
    await this.context.globalState.update(KEY, { registeredAt: new Date().toISOString(), serverPath: this.serverPath, via, hook } satisfies Stored);
    await vscode.commands.executeCommand('setContext', 'skilltree.claudeRecommendations', true);
    this.start();
    if (via === 'manual') {
      return { status: 'manual', message: 'Claude Code CLI not found. Run this once in a terminal to finish:', command: ['claude', ...args.slice(0, 5), '--', node, this.serverPath, this.baseDir] };
    }
    return { status: 'enabled', message: 'Claude can now search the SkillTree catalog and ask to install skills. New Claude Code sessions pick it up.', command: ['claude', ...args] };
  }

  async disable(): Promise<{ status: 'disabled' | 'absent' | 'failed'; message: string }> {
    const stored = this.context.globalState.get<Stored>(KEY);
    if (!stored) return { status: 'absent', message: 'Claude skill recommendations are not enabled.' };
    const cli = this.cli();
    if (cli) {
      const r = await cli(['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]);
      if (r.code !== 0 && !/not found|no .*server/i.test(r.out)) return { status: 'failed', message: `claude mcp remove failed: ${r.out.slice(0, 400)}` };
    }
    if (stored.hook) {
      try {
        await disableTracking(stored.hook);
      } catch (err) {
        return { status: 'failed', message: `Could not remove the suggestion hook from ${stored.hook.settingsFile}: ${(err as Error).message}` };
      }
    }
    this.stop();
    await fsp.rm(this.serverPath, { force: true });
    await fsp.rm(this.suggestPath, { force: true });
    await this.context.globalState.update(KEY, undefined);
    await vscode.commands.executeCommand('setContext', 'skilltree.claudeRecommendations', false);
    return { status: 'disabled', message: cli ? 'Removed the "skilltree" MCP server from Claude Code.' : 'Stopped. If you registered the server by hand, run: claude mcp remove --scope user skilltree' };
  }

  dispose(): void {
    this.stop();
    for (const s of this.subs) s.dispose();
  }
}

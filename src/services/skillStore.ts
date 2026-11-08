// Owns the current scan result and organization preferences. The only place that touches the
// filesystem for discovery; views subscribe to `onDidChange`.

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { managedSettingsDir, scanAll, standardRoots, type ScanRoot } from '../core/scanner';
import { organizeSkills } from '../core/organize';
import { isCategory, type Category, type NodePosition, type OrganizedSkill, type SkillTreeState } from '../shared/types';

const KEY_GLOBAL_CATEGORIES = 'skilltree.categories.v1';
const KEY_WORKSPACE_CATEGORIES = 'skilltree.categories.v1';
const KEY_POSITIONS = 'skilltree.positions.v1';
const KEY_COLLAPSED = 'skilltree.collapsed.v1';

/** Skills whose organization is project-specific are stored per workspace. */
function isWorkspaceScoped(id: string): boolean {
  return id.startsWith('project/') || id.startsWith('nested/');
}

export class SkillStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<SkillTreeState>();
  readonly onDidChange = this.emitter.event;

  private state: SkillTreeState;
  private scanSeq = 0;
  private latestScan: Promise<SkillTreeState> | undefined;
  private rescanTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private watchers: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.state = {
      status: 'loading',
      workspaceName: vscode.workspace.name ?? null,
      workspaceTrusted: vscode.workspace.isTrusted,
      skills: [],
      roots: [],
      scannedAt: null,
      positions: this.positions(),
      collapsed: this.collapsed(),
    };
    this.disposables.push(
      this.emitter,
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.setupWatchers();
        this.scheduleRescan();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.update({ workspaceTrusted: true })),
    );
    this.setupWatchers();
  }

  /** Home directory. SKILLTREE_HOME overrides it for integration tests only. */
  get homeDir(): string {
    return process.env.SKILLTREE_HOME || os.homedir();
  }

  get snapshot(): SkillTreeState {
    return this.state;
  }

  get skills(): OrganizedSkill[] {
    return this.state.skills;
  }

  find(id: string): OrganizedSkill | undefined {
    return this.state.skills.find((s) => s.id === id);
  }

  private update(patch: Partial<SkillTreeState>): void {
    this.state = { ...this.state, ...patch };
    this.emitter.fire(this.state);
  }

  // ---- Scanning -----------------------------------------------------------------------------

  private async nestedSkillDirs(): Promise<{ folderName: string; folderPath: string; skillsDir: string }[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return [];
    const result: { folderName: string; folderPath: string; skillsDir: string }[] = [];
    const seen = new Set<string>();
    for (const folder of folders) {
      if (folder.uri.scheme !== 'file') continue;
      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/.claude/skills/*/SKILL.md'),
        '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.vscode-test/**}',
        500,
      );
      for (const uri of found) {
        const skillsDir = path.dirname(path.dirname(uri.fsPath));
        const topLevel = path.join(folder.uri.fsPath, '.claude', 'skills');
        if (skillsDir === topLevel || seen.has(skillsDir)) continue;
        seen.add(skillsDir);
        result.push({ folderName: folder.name, folderPath: folder.uri.fsPath, skillsDir });
      }
    }
    return result;
  }

  private async roots(): Promise<ScanRoot[]> {
    const workspaceFolders = (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === 'file')
      .map((f) => ({ name: f.name, path: f.uri.fsPath }));
    let nested: Awaited<ReturnType<SkillStore['nestedSkillDirs']>> = [];
    try {
      nested = await this.nestedSkillDirs();
    } catch (err) {
      this.log.warn(`Nested skill discovery failed: ${(err as Error).message}`);
    }
    return standardRoots({
      homeDir: this.homeDir,
      workspaceFolders,
      nestedSkillDirs: nested,
      managedDir: process.env.SKILLTREE_HOME ? null : managedSettingsDir(),
    });
  }

  /** Resolves with the state produced by the newest scan, even if a later scan supersedes this one. */
  rescan(): Promise<SkillTreeState> {
    const scan = this.scan(++this.scanSeq);
    this.latestScan = scan;
    return scan;
  }

  private async scan(seq: number): Promise<SkillTreeState> {
    if (this.state.status !== 'ready') this.update({ status: 'loading' });
    const started = Date.now();
    try {
      const roots = await this.roots();
      const result = await scanAll(roots, { homeDir: this.homeDir });
      // A newer scan started meanwhile: drop these (possibly stale) results and wait for it instead,
      // so callers such as the Refresh command never see a state older than their request.
      if (seq !== this.scanSeq) return this.latestScan ?? this.state;
      const skills = organizeSkills(result.skills, this.categoryPrefs());
      this.log.info(
        `Scanned ${roots.length} locations in ${Date.now() - started} ms: ${skills.length} skills (` +
          result.roots.map((r) => `${r.displayPath}: ${r.exists ? r.skillCount : 'missing'}`).join(', ') +
          ')',
      );
      this.update({
        status: 'ready',
        error: undefined,
        workspaceName: vscode.workspace.name ?? null,
        workspaceTrusted: vscode.workspace.isTrusted,
        skills,
        roots: result.roots,
        scannedAt: Date.now(),
        positions: this.positions(),
        collapsed: this.collapsed(),
      });
    } catch (err) {
      if (seq !== this.scanSeq) return this.latestScan ?? this.state;
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Scan failed: ${message}`);
      this.update({ status: 'error', error: message });
    }
    return this.state;
  }

  scheduleRescan(delayMs = 300): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined;
      void this.rescan();
    }, delayMs);
  }

  private setupWatchers(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    const onChange = () => this.scheduleRescan();
    const add = (pattern: vscode.GlobPattern) => {
      const w = vscode.workspace.createFileSystemWatcher(pattern);
      w.onDidCreate(onChange);
      w.onDidChange(onChange);
      w.onDidDelete(onChange);
      this.watchers.push(w);
    };
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      add(new vscode.RelativePattern(folder, '**/.claude/skills/**'));
    }
    try {
      // '**' (not '**/SKILL.md') so deleting or renaming a whole skill folder also triggers a rescan.
      add(new vscode.RelativePattern(vscode.Uri.file(path.join(this.homeDir, '.claude', 'skills')), '**'));
    } catch (err) {
      this.log.warn(`Could not watch personal skills: ${(err as Error).message}`);
    }
  }

  // ---- Organization preferences (never written into SKILL.md) ------------------------------

  private categoryPrefs(): Record<string, Category> {
    const merged: Record<string, Category> = {};
    const sources = [
      this.context.globalState.get<Record<string, unknown>>(KEY_GLOBAL_CATEGORIES, {}),
      this.context.workspaceState.get<Record<string, unknown>>(KEY_WORKSPACE_CATEGORIES, {}),
    ];
    for (const src of sources) {
      for (const [k, v] of Object.entries(src ?? {})) if (isCategory(v)) merged[k] = v;
    }
    return merged;
  }

  async setCategory(id: string, category: Category | null): Promise<void> {
    const memento = isWorkspaceScoped(id) ? this.context.workspaceState : this.context.globalState;
    const key = isWorkspaceScoped(id) ? KEY_WORKSPACE_CATEGORIES : KEY_GLOBAL_CATEGORIES;
    const current = { ...memento.get<Record<string, Category>>(key, {}) };
    if (category) current[id] = category;
    else delete current[id];
    await memento.update(key, current);
    // Re-organize in place without a rescan.
    const raw = this.state.skills.map(({ category: _c, categorySource: _s, ...rest }) => rest);
    this.update({ skills: organizeSkills(raw, this.categoryPrefs()) });
  }

  private positions(): Record<string, NodePosition> {
    return this.context.workspaceState.get<Record<string, NodePosition>>(KEY_POSITIONS, {}) ?? {};
  }

  async savePositions(patch: Record<string, NodePosition>): Promise<void> {
    const next = { ...this.positions(), ...patch };
    await this.context.workspaceState.update(KEY_POSITIONS, next);
    this.state = { ...this.state, positions: next }; // no broadcast: the webview already has them
  }

  async resetLayout(): Promise<void> {
    await this.context.workspaceState.update(KEY_POSITIONS, {});
    this.update({ positions: {} });
  }

  private collapsed(): Category[] {
    return (this.context.workspaceState.get<unknown[]>(KEY_COLLAPSED, []) ?? []).filter(isCategory);
  }

  async setCollapsed(categories: Category[]): Promise<void> {
    await this.context.workspaceState.update(KEY_COLLAPSED, categories);
    this.state = { ...this.state, collapsed: categories };
  }

  dispose(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    for (const w of this.watchers) w.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

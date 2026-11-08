// Marketplace: loads the catalog (remote → cache → bundled), derives install state from local
// provenance, previews skills at their pinned commit and runs the confirmed, safe installer.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isWithin } from '../shared/bridge';
import * as vscode from 'vscode';
import { loadCatalog, type CatalogLoadResult } from '../core/catalogStore';
import { executeInstall, githubRawProvider, directoryProvider, gitBlobSha, InstallError, planInstall, type InstallPlan, type InstallScope, type SourceProvider } from '../core/installer';
import { CATALOG_LIMITS, installStateFor, type Catalog, type CatalogEntry } from '../shared/catalog';
import type { MarketplaceEntryView, MarketplaceState } from '../shared/marketplace';
import type { SkillStore } from './skillStore';

/** Set when Claude asked for the install (through SkillTree's MCP server); shown in the dialog. */
export type InstallRequester = { by: 'claude' | 'suggestion'; reason: string };
export type ConfirmRequest = { kind: 'install'; plan: InstallPlan; requestedBy?: InstallRequester; notes?: string[] } | { kind: 'replace'; plan: InstallPlan; requestedBy?: InstallRequester };
export type Confirmer = (req: ConfirmRequest) => Promise<boolean>;
export type InstallResult = { status: 'installed'; destDir: string; backupDir?: string } | { status: 'cancelled' | 'failed'; message: string };

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function describePlan(plan: InstallPlan, destLabel: string): string {
  const e = plan.entry;
  const lines = [
    `Source: ${e.owner}/${e.repo}/${e.path} at commit ${e.commitSha.slice(0, 12)}`,
    `Destination: ${destLabel}`,
    `License: ${e.license ?? 'unknown'}`,
    '',
    ...(plan.files.length > CATALOG_LIMITS.largeSkillFiles || plan.totalBytes > CATALOG_LIMITS.largeSkillBytes ? [`Large skill: this downloads ${plan.files.length} files (${fmtSize(plan.totalBytes)}) into your skills folder.`, ''] : []),
    `${plan.files.length} file${plan.files.length === 1 ? '' : 's'} (${fmtSize(plan.totalBytes)}):`,
    ...plan.files.slice(0, 20).map((f) => `  ${f.path}  ${fmtSize(f.size)}${f.kind === 'script' || f.kind === 'executable' ? '  [script]' : ''}`),
    ...(plan.files.length > 20 ? [`  … and ${plan.files.length - 20} more`] : []),
  ];
  if (plan.excluded.length) lines.push('', 'Not installed:', ...plan.excluded.map((x) => `  ${x.path} (${x.reason})`));
  if (e.warnings.length) lines.push('', 'Review:', ...e.warnings.map((w) => `  • ${w}`));
  lines.push('', 'SkillTree does not run any of these files. Indexed skills are not reviewed for security or quality.');
  return lines.join('\n');
}

export class MarketplaceService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<MarketplaceState>();
  readonly onDidChange = this.emitter.event;
  private loaded: CatalogLoadResult | null = null;
  private loading = false;
  private busyId: string | null = null;
  private readonly subs: vscode.Disposable[] = [];
  private state: MarketplaceState;

  /** Test-only overrides (set through the extension API in ExtensionMode.Test). */
  testCatalog: Catalog | undefined;
  testSourceDir: string | undefined;
  testConfirm: Confirmer | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SkillStore,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.state = this.compute();
    this.subs.push(
      this.emitter,
      store.onDidChange(() => this.publish()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('skilltree.catalogUrl')) void this.refresh();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.publish()),
    );
  }

  /** The validated catalog currently loaded (for SkillTree's MCP bridge). */
  get currentCatalog(): Catalog | null {
    return this.loaded?.catalog ?? null;
  }

  get snapshot(): MarketplaceState {
    return this.state;
  }

  get cacheFile(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'catalog-cache.json');
  }

  private get bundledFiles(): string[] {
    return [path.join(this.context.extensionPath, 'dist', 'catalog.json'), path.join(this.context.extensionPath, 'dist', 'catalog.sample.json')];
  }

  private provider(): SourceProvider {
    return this.testSourceDir ? directoryProvider(this.testSourceDir) : githubRawProvider();
  }

  private projectBlocked(): string | null {
    if (!vscode.workspace.workspaceFolders?.some((f) => f.uri.scheme === 'file')) return 'Open a folder to install skills into a project.';
    if (!vscode.workspace.isTrusted) return 'This workspace is not trusted. Trust it to install project skills.';
    return null;
  }

  private compute(): MarketplaceState {
    const loaded = this.loaded;
    const catalog = loaded?.catalog ?? null;
    const local = this.store.skills.map((s) => ({ id: s.id, source: s.source, dirName: s.dirName, name: s.name, installedFrom: s.installedFrom }));
    const entries: MarketplaceEntryView[] = (catalog?.entries ?? []).map((e) => {
      const info = installStateFor(e, local);
      return { ...e, installState: info.state, localIds: info.localIds };
    });
    return {
      status: loaded || !this.loading ? 'ready' : 'loading',
      origin: loaded?.origin ?? 'none',
      fetchedAt: loaded?.fetchedAt ?? null,
      url: loaded?.url ?? null,
      error: loaded?.error,
      catalog: catalog
        ? { source: catalog.source, generatedAt: catalog.generatedAt, repositories: catalog.repositories, skippedCount: catalog.skipped?.length ?? 0, repositoryStats: catalog.repositoryStats ?? {} }
        : null,
      entries,
      projectInstallBlocked: this.projectBlocked(),
      claudeSuggestions: this.claudeSuggestions(),
      forYou: this.recommendations(),
      busyId: this.busyId,
    };
  }

  /** Set by the extension: whether Claude skill suggestions are on. */
  claudeSuggestions: () => boolean = () => false;
  /** Set by the extension: usage-driven suggestions (Phase 5). */
  recommendations: () => { id: string; reason: string }[] = () => [];

  /** Re-sends state (e.g. after Claude suggestions were switched on or off). */
  notify(): void {
    this.publish();
  }

  private publish(): void {
    this.state = this.compute();
    this.emitter.fire(this.state);
  }

  async refresh(): Promise<MarketplaceState> {
    this.loading = true;
    this.publish();
    try {
      if (this.testCatalog) {
        this.loaded = { catalog: this.testCatalog, origin: 'bundled', fetchedAt: null, url: null };
      } else {
        const url = vscode.workspace.getConfiguration('skilltree').get<string>('catalogUrl', '');
        this.loaded = await loadCatalog({ url, cacheFile: this.cacheFile, bundledFiles: this.bundledFiles, timeoutMs: 10000 });
      }
      this.log.info(`Catalog: ${this.loaded.origin}, ${this.loaded.catalog?.entries.length ?? 0} entries${this.loaded.error ? ` (${this.loaded.error})` : ''}`);
    } finally {
      this.loading = false;
      this.publish();
    }
    return this.state;
  }

  find(id: string): CatalogEntry | undefined {
    return this.loaded?.catalog?.entries.find((e) => e.id === id);
  }

  /** Reads the complete SKILL.md at the pinned commit and checks it against the catalog hash. */
  async previewText(id: string): Promise<string> {
    const entry = this.find(id);
    if (!entry) throw new Error('Entry not found in the current catalog.');
    const file = entry.files.find((f) => f.path === 'SKILL.md');
    if (!file) throw new Error('Entry has no SKILL.md.');
    const buf = await this.provider().readFile(entry, 'SKILL.md', file.size);
    if (gitBlobSha(buf) !== file.sha) throw new Error('SKILL.md does not match the pinned commit.');
    return buf.toString('utf8');
  }

  private async confirm(req: ConfirmRequest, destLabel: string): Promise<boolean> {
    if (this.testConfirm) return this.testConfirm(req);
    const e = req.plan.entry;
    if (req.kind === 'install') {
      const scope = req.plan.scope === 'project' ? 'this project' : 'your personal skills (all projects)';
      const title = req.requestedBy?.by === 'claude' ? `Claude wants to install the skill "${e.name}" to ${scope}` : `Install "${e.name}" to ${scope}?`;
      const why = req.requestedBy ? `${req.requestedBy.by === 'claude' ? "Claude's reason" : 'Why'}: ${req.requestedBy.reason}\n\n` : '';
      const notes = req.notes?.length ? `${req.notes.join('\n')}\n\n` : '';
      const choice = await vscode.window.showWarningMessage(title, { modal: true, detail: why + notes + describePlan(req.plan, destLabel) }, 'Install');
      return choice === 'Install';
    }
    const choice = await vscode.window.showWarningMessage(
      `A skill folder named "${req.plan.folderName}" already exists.`,
      { modal: true, detail: `${destLabel} already exists. Replace it with ${e.owner}/${e.repo}/${e.path} at ${e.commitSha.slice(0, 12)}?\n\nThe current folder will be moved to a hidden backup (.skilltree-backup-…) in the same skills folder, not deleted.` },
      'Replace',
    );
    return choice === 'Replace';
  }

  private async skillsRoot(scope: InstallScope, projectDir?: string): Promise<{ root: string; label: string } | { error: string }> {
    if (scope === 'global') {
      return { root: path.join(this.store.homeDir, '.claude', 'skills'), label: '~/.claude/skills' };
    }
    const blocked = this.projectBlocked();
    if (blocked) return { error: blocked };
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    // A request from Claude names its project: use the open folder that contains it.
    const real = (p: string) => {
      try {
        return fs.realpathSync.native(p);
      } catch {
        return path.resolve(p);
      }
    };
    const matching = projectDir ? folders.filter((f) => isWithin(real(f.uri.fsPath), real(projectDir))).sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0] : undefined;
    if (projectDir && !matching) return { error: `${projectDir} is not open in this VS Code window.` };
    const folder = matching ?? (folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Install the skill into which folder?' }));
    if (!folder) return { error: 'cancelled' };
    return { root: path.join(folder.uri.fsPath, '.claude', 'skills'), label: `${folders.length > 1 ? folder.name + '/' : ''}.claude/skills` };
  }

  async install(id: string, scope: InstallScope, opts: { requestedBy?: InstallRequester; projectDir?: string } = {}): Promise<InstallResult> {
    const entry = this.find(id);
    if (!entry) return { status: 'failed', message: 'Entry not found in the current catalog.' };
    if (this.busyId) return { status: 'failed', message: 'Another installation is in progress.' };
    const target = await this.skillsRoot(scope, opts.projectDir);
    if ('error' in target) return target.error === 'cancelled' ? { status: 'cancelled', message: 'Cancelled.' } : { status: 'failed', message: target.error };

    let plan: InstallPlan;
    try {
      plan = await planInstall(entry, target.root, scope);
    } catch (err) {
      return { status: 'failed', message: (err as Error).message };
    }
    const destLabel = `${target.label}/${plan.folderName}/`;
    // Same name already installed some other way: say so, and which copy Claude Code would use.
    const sameName = this.store.skills.filter((s) => s.name.toLowerCase() === entry.name.toLowerCase() && s.installedFrom?.id !== entry.id);
    const notes = sameName.map(
      (s) => `You already have a skill named "${s.name}" at ${s.displayPath} (${s.source}). Claude Code uses one skill per name (managed, then personal, then project), so only one of the two copies will be used.`,
    );
    if (!(await this.confirm({ kind: 'install', plan, requestedBy: opts.requestedBy, notes }, destLabel))) return { status: 'cancelled', message: 'Installation cancelled. Nothing was changed.' };
    let replace = false;
    if (plan.exists) {
      replace = await this.confirm({ kind: 'replace', plan, requestedBy: opts.requestedBy }, destLabel);
      if (!replace) return { status: 'cancelled', message: `"${plan.folderName}" already exists; nothing was changed.` };
    }

    this.busyId = id;
    this.publish();
    try {
      const outcome = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Installing ${entry.name}`, cancellable: true },
        async (progress, token) => {
          const ctrl = new AbortController();
          token.onCancellationRequested(() => ctrl.abort());
          return executeInstall(plan, this.provider(), {
            replaceExisting: replace,
            signal: ctrl.signal,
            onProgress: (done, total, file) => progress.report({ message: `${done}/${total} ${file}`, increment: 100 / total }),
          });
        },
      );
      this.log.info(`Installed ${entry.id}@${entry.commitSha} → ${outcome.destDir}${outcome.backupDir ? ` (backup ${outcome.backupDir})` : ''}`);
      await this.store.rescan();
      return { status: 'installed', destDir: outcome.destDir, backupDir: outcome.backupDir };
    } catch (err) {
      const message = err instanceof InstallError ? err.message : `Installation failed: ${(err as Error).message}`;
      this.log.warn(`Install of ${entry.id} did not complete: ${message}`);
      return { status: err instanceof InstallError && err.code === 'cancelled' ? 'cancelled' : 'failed', message };
    } finally {
      this.busyId = null;
      this.publish();
    }
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }
}

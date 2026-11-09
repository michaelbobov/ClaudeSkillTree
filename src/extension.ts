import * as vscode from 'vscode';
import { SkillStore } from './services/skillStore';
import { SkillActions } from './services/skillActions';
import { SkillsTreeProvider, type SidebarNode } from './views/skillsTreeProvider';
import { GRAPH_VIEW_TYPE, SkillGraphPanel } from './views/skillGraphPanel';
import { MarketplaceService, type Confirmer, type InstallResult } from './services/marketplace';
import { HomeTreeProvider } from './views/homeTreeProvider';
import { MARKETPLACE_VIEW_TYPE, MarketplacePanel } from './views/marketplacePanel';
import type { SkillTreeState } from './shared/types';
import type { Catalog } from './shared/catalog';
import type { MarketplaceState } from './shared/marketplace';
import { ActivityService, type ActivityState, type TrackingConsent } from './services/activity';
import { ActivityTreeProvider } from './views/activityTreeProvider';
import { ActivityIndicators } from './views/activityIndicators';
import { ClaudeBridge } from './services/claudeBridge';
import { availableFor, matchOrigins, recommendFromUsage, type Recommendation } from './shared/recommend';
import { profileProject, profileSummary, recommendForProject, type ProjectFacts, type ProjectProfile } from './shared/projectFit';
import { scanProject } from './core/projectScan';
import { gitBlobSha } from './core/installer';
import * as fs from 'node:fs';
import type { CliRunner } from './services/claudeCli';
import { ACTIVITY_VIEW_TYPE, ActivityPanel } from './views/activityPanel';
import { usageKeys } from './shared/activity';
import type { OrganizedSkill } from './shared/types';

/** How far back the Skill Tree's Live strip looks (it shows sessions active in the last 10 minutes). */
const RECENT_MS = 15 * 60 * 1000;

function workspaceDirs(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
}

/**
 * Names that, on this machine, belong only to a project skill of this workspace. Uses of such a name
 * in other projects are another project's skill and are not counted here. A personal, synced or
 * managed skill with the same name takes precedence in Claude Code, so it is counted everywhere.
 */
function projectOnlyKeys(skills: readonly OrganizedSkill[]): Set<string> {
  const project = new Set<string>();
  const elsewhere = new Set<string>();
  for (const s of skills) for (const k of usageKeys(s)) (s.source === 'project' || s.source === 'nested' ? project : elsewhere).add(k);
  return new Set([...project].filter((k) => !elsewhere.has(k)));
}

/** Test-only hooks, available only when VS Code runs the extension in test mode. */
export interface SkillTreeTestHooks {
  setCatalog(catalog: Catalog | undefined): void;
  setSourceDir(dir: string | undefined): void;
  setConfirm(confirm: Confirmer | undefined): void;
  catalogCacheFile(): string;
  setTrackingConsent(consent: TrackingConsent | undefined): void;
  /** Rows of the "Recent Activity" sidebar section, as VS Code renders them. */
  recentActivityItems(): { label: string; description: string }[];
  /** The state the Skill Tree editor (graph + inspector) receives, including observed activity. */
  graphState(): SkillTreeState;
  /** Status bar text (null when hidden) and the Activity Bar badge count. */
  indicators(): { statusText: string | null; badge: number };
  setClaudeCli(cli: CliRunner | undefined): void;
  setClaudeConsent(consent: (() => Promise<boolean>) | undefined): void;
  /** Top-level rows of the SkillTree sidebar. */
  sidebarRows(): { label: string; description: string }[];
  setSuggestionChoice(choice: ((s: { name: string; repo: string }) => Promise<'project' | 'global' | 'details' | undefined>) | undefined): void;
  /** Serve MCP install requests without registering the server (live tests pass --mcp-config). */
  startClaudeBridge(): void;
  claudeBridgeDir(): string;
}

/** Public API (used by integration tests). */
export interface SkillTreeApi {
  rescan(): Promise<SkillTreeState>;
  snapshot(): SkillTreeState;
  isGraphOpen(): boolean;
  isGraphReady(): boolean;
  marketplace(): MarketplaceState;
  refreshCatalog(): Promise<MarketplaceState>;
  isMarketplaceReady(): boolean;
  marketplaceRenderedCount(): number;
  activity(): ActivityState;
  refreshActivity(): Promise<ActivityState>;
  isActivityReady(): boolean;
  activityRenderedCount(): number;
  test?: SkillTreeTestHooks;
}

/** Commands may receive a skill id (from the webview/commands) or a tree node (from sidebar menus). */
function skillIdFrom(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  const node = arg as SidebarNode | undefined;
  if (node && node.kind === 'skill') return node.skill.id;
  return undefined;
}

export function activate(context: vscode.ExtensionContext): SkillTreeApi {
  const log = vscode.window.createOutputChannel('SkillTree', { log: true });
  const store = new SkillStore(context, log);
  const actions = new SkillActions(store, log);
  const market = new MarketplaceService(context, store, log);
  const bridge = new ClaudeBridge(context, market, store, log);
  market.claudeSuggestions = () => bridge.enabled;

  const activity = new ActivityService(context, store, log);
  const activityTree = new ActivityTreeProvider(activity);

  // "For you": catalog skills suggested from recorded use (Phase 5). Recomputed when skills, the
  // catalog or recorded activity change; the Marketplace is only notified when the list changes.
  const shaCache = new Map<string, { modifiedAt: number; sha: string | undefined }>();
  const skillMdSha = (file: string, modifiedAt: number): string | undefined => {
    const hit = shaCache.get(file);
    if (hit && hit.modifiedAt === modifiedAt) return hit.sha;
    let sha: string | undefined;
    try {
      sha = gitBlobSha(fs.readFileSync(file));
    } catch {
      sha = undefined;
    }
    shaCache.set(file, { modifiedAt, sha });
    return sha;
  };
  let forYou: Recommendation[] = [];
  const refreshForYou = () => {
    const catalog = market.currentCatalog;
    let next: Recommendation[] = [];
    if (catalog && activity.snapshot.events.length) {
      const locals = store.snapshot.skills.map((s) => ({ id: s.id, name: s.name, command: s.command, dirName: s.dirName, category: s.category, installedFromId: s.installedFrom?.id, skillMdSha: skillMdSha(s.file, s.modifiedAt) }));
      next = recommendFromUsage(catalog, locals, activity.usage(), matchOrigins(catalog, locals));
    }
    if (JSON.stringify(next) !== JSON.stringify(forYou)) {
      forYou = next;
      market.notify();
    }
  };
  market.recommendations = () => forYou;
  context.subscriptions.push(store.onDidChange(refreshForYou), activity.onDidChange(refreshForYou), market.onDidChange(refreshForYou));

  // "For this project": skills that name a technology the open folder uses. The folder is scanned
  // (file names + dependency manifests, read-only) on start, when folders change and when a manifest
  // changes; matching is re-run when skills or the catalog change.
  let profile: ProjectProfile = { techs: [] };
  let forProject: MarketplaceState['forProject'];
  const projectEnabled = () => vscode.workspace.getConfiguration('skilltree').get<boolean>('projectSuggestions', true);
  const refreshForProject = () => {
    const catalog = market.currentCatalog;
    let next: MarketplaceState['forProject'];
    if (catalog && projectEnabled() && profile.techs.length) {
      const locals = store.snapshot.skills.map((s) => ({ id: s.id, name: s.name, command: s.command, dirName: s.dirName, category: s.category, installedFromId: s.installedFrom?.id, skillMdSha: skillMdSha(s.file, s.modifiedAt) }));
      const items = recommendForProject(catalog, profile, availableFor(locals, matchOrigins(catalog, locals))).map(({ id, reason }) => ({ id, reason }));
      if (items.length) next = { summary: profileSummary(profile), items };
    }
    if (JSON.stringify(next) !== JSON.stringify(forProject)) {
      forProject = next;
      market.notify();
    }
  };
  let scanSeq = 0;
  const rescanProject = async () => {
    const seq = ++scanSeq;
    const roots = workspaceDirs();
    let facts: ProjectFacts = { files: [], deps: [] };
    if (projectEnabled()) {
      for (const root of roots) {
        const f = await scanProject(root);
        // In a multi-root workspace, keep evidence readable by naming the folder.
        const prefix = roots.length > 1 ? `${root.split(/[\\/]/).pop()}/` : '';
        facts = { files: [...facts.files, ...f.files.map((p) => prefix + p)], deps: [...facts.deps, ...f.deps.map((d) => ({ ...d, manifest: prefix + d.manifest }))] };
      }
    }
    if (seq !== scanSeq) return; // a newer scan started
    profile = profileProject(facts);
    log.appendLine(`[project] ${profile.techs.length ? profile.techs.map((t) => `${t.label} (${t.evidence})`).join(', ') : 'no known technologies detected'}`);
    refreshForProject();
  };
  let rescanTimer: NodeJS.Timeout | undefined;
  const scheduleRescan = () => {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => void rescanProject(), 1500);
  };
  const manifestWatcher = vscode.workspace.createFileSystemWatcher('**/{package.json,requirements*.txt,pyproject.toml,Pipfile,Cargo.toml,go.mod,Gemfile,composer.json,pubspec.yaml}');
  market.projectRecommendations = () => forProject;
  context.subscriptions.push(
    manifestWatcher,
    manifestWatcher.onDidCreate(scheduleRescan),
    manifestWatcher.onDidChange(scheduleRescan),
    manifestWatcher.onDidDelete(scheduleRescan),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleRescan),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('skilltree.projectSuggestions') && scheduleRescan()),
    store.onDidChange(refreshForProject),
    market.onDidChange(refreshForProject),
    { dispose: () => clearTimeout(rescanTimer) },
  );
  void rescanProject();
  SkillGraphPanel.activity = () => {
    const s = activity.snapshot;
    if (!s.enabled && !s.events.length) return undefined;
    const usage = activity.workspaceUsage(workspaceDirs(), projectOnlyKeys(store.snapshot.skills));
    const from = Date.now() - RECENT_MS;
    const recent = s.events.filter((e) => Date.parse(e.ts) >= from).slice(0, 200);
    const ended = Object.fromEntries(Object.entries(s.ended).filter(([, ts]) => Date.parse(ts) >= from));
    return { enabled: s.enabled, since: s.installedAt, ...usage.all, ...(usage.here ? { here: usage.here } : {}), recent, ended };
  };
  activity.onDidChange(() => SkillGraphPanel.refresh());
  const tree = new SkillsTreeProvider(store);
  // One sidebar view: entry points and switches on top, then installed skills and recent use.
  const home = new HomeTreeProvider(store, market, activity, tree, activityTree);
  const treeView = vscode.window.createTreeView('skilltree.skills', { treeDataProvider: home, showCollapseAll: true });
  const indicators = new ActivityIndicators(context, activity, treeView as vscode.TreeView<unknown>, store);
  const discover = { refresh: () => market.notify() }; // Claude suggestions switched on or off

  const withSkill = (fn: (id: string) => Promise<unknown>) => async (arg?: unknown) => {
    let id = skillIdFrom(arg);
    if (!id) {
      const picked = await vscode.window.showQuickPick(
        store.skills.map((s) => ({ label: s.name, description: s.displayPath, id: s.id })),
        { placeHolder: 'Choose a skill' },
      );
      id = picked?.id;
    }
    if (!id) return;
    try {
      await fn(id);
    } catch (err) {
      void vscode.window.showErrorMessage(`SkillTree: ${(err as Error).message}`);
    }
  };

  context.subscriptions.push(
    log,
    store,
    market,
    home,
    activity,
    activityTree,
    indicators,
    bridge,
    vscode.commands.registerCommand('skilltree.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#getStarted`, false),
    ),
    // The SkillTree menu (status bar item): every entry point and switch in one place.
    vscode.commands.registerCommand('skilltree.menu', async () => {
      const n = store.snapshot.skills.length;
      const a = activity.snapshot;
      const m = market.snapshot;
      type Pick = vscode.QuickPickItem & { run?: string };
      const items: Pick[] = [
        { label: '$(type-hierarchy) Skill Tree', description: `${n} skill${n === 1 ? '' : 's'}`, run: 'skilltree.openGraph' },
        { label: '$(extensions) Marketplace', description: m.catalog ? `${m.entries.length.toLocaleString()} skills` : undefined, run: 'skilltree.openMarketplace' },
        { label: '$(pulse) Activity', description: a.enabled ? `${a.events.length} recorded uses` : 'tracking off', run: 'skilltree.openActivity' },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        a.enabled
          ? { label: '$(record) Turn off usage tracking', description: 'restores your Claude Code settings file', run: 'skilltree.disableTracking' }
          : { label: '$(record) Turn on usage tracking…', description: 'see which skills Claude Code actually uses', run: 'skilltree.enableTracking' },
        bridge.enabled
          ? { label: '$(sparkle) Stop Claude skill suggestions', run: 'skilltree.disableClaudeRecommendations' }
          : { label: '$(sparkle) Let Claude suggest skills…', description: 'you approve every install', run: 'skilltree.enableClaudeRecommendations' },
        { label: '$(refresh) Rescan skill folders', run: 'skilltree.refresh' },
        { label: '$(book) Get started with SkillTree', run: 'skilltree.openWalkthrough' },
      ];
      const picked = await vscode.window.showQuickPick(items, { title: 'SkillTree', placeHolder: 'Open a SkillTree view or change a setting' });
      if (picked?.run) await vscode.commands.executeCommand(picked.run);
    }),
    vscode.commands.registerCommand('skilltree.enableClaudeRecommendations', async () => {
      const r = await bridge.enable();
      discover.refresh();
      if (r.status === 'enabled') void vscode.window.showInformationMessage(r.message);
      else if (r.status === 'manual' && r.command) {
        const cmd = r.command.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
        void vscode.window.showWarningMessage(`${r.message} ${cmd}`, 'Copy command').then((c) => c && vscode.env.clipboard.writeText(cmd));
      } else if (r.status === 'failed') void vscode.window.showErrorMessage(`SkillTree: ${r.message}`);
      return r;
    }),
    vscode.commands.registerCommand('skilltree.disableClaudeRecommendations', async () => {
      const r = await bridge.disable();
      discover.refresh();
      if (r.status === 'failed') void vscode.window.showErrorMessage(`SkillTree: ${r.message}`);
      else void vscode.window.showInformationMessage(r.message);
      return r;
    }),
    vscode.commands.registerCommand('skilltree.openActivity', () => ActivityPanel.show(context, activity)),
    vscode.commands.registerCommand('skilltree.enableTracking', async () => {
      const r = await activity.enable();
      if (r.status === 'enabled') void vscode.window.showInformationMessage(`${r.message} New and reloaded Claude Code sessions will record skill use.`);
      else if (r.status === 'failed') void vscode.window.showErrorMessage(`SkillTree: ${r.message}`);
      return r;
    }),
    vscode.commands.registerCommand('skilltree.disableTracking', async () => {
      const r = await activity.disable();
      if (r.status === 'failed') void vscode.window.showErrorMessage(`SkillTree: ${r.message}`);
      else void vscode.window.showInformationMessage(r.message);
      return r;
    }),
    vscode.window.registerWebviewPanelSerializer(ACTIVITY_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => ActivityPanel.revive(panel, context, activity),
    }),
    tree,
    treeView,
    vscode.commands.registerCommand('skilltree.openMarketplace', (focusId?: unknown) => {
      MarketplacePanel.show(context, market, store, typeof focusId === 'string' ? focusId : undefined);
    }),
    vscode.commands.registerCommand('skilltree.refreshCatalog', () => market.refresh()),
    vscode.commands.registerCommand('skilltree.installEntry', async (id: unknown, scope: unknown): Promise<InstallResult> => {
      if (typeof id !== 'string' || (scope !== 'project' && scope !== 'global')) return { status: 'failed', message: 'Invalid arguments.' };
      const result = await market.install(id, scope);
      if (result.status === 'installed') {
        void vscode.window
          .showInformationMessage(
            `Installed to ${result.destDir}. Claude Code picks up skill changes in running sessions; if the skills folder is new, run /reload-skills or start a new session.`,
            'Open SKILL.md',
          )
          .then((choice) => {
            if (choice) void vscode.window.showTextDocument(vscode.Uri.file(`${result.destDir}/SKILL.md`));
          });
      } else if (result.status === 'failed') {
        void vscode.window.showErrorMessage(`SkillTree: ${result.message}`);
      } else {
        vscode.window.setStatusBarMessage(result.message, 4000);
      }
      return result;
    }),
    vscode.window.registerWebviewPanelSerializer(MARKETPLACE_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => MarketplacePanel.revive(panel, context, market, store),
    }),
    vscode.commands.registerCommand('skilltree.openGraph', () => {
      SkillGraphPanel.show(context, store, actions);
    }),
    vscode.commands.registerCommand('skilltree.refresh', () => store.rescan()),
    vscode.commands.registerCommand('skilltree.createProjectSkill', () => actions.createProjectSkill()),
    vscode.commands.registerCommand('skilltree.openSkillFile', withSkill((id) => actions.openSkillFile(id))),
    vscode.commands.registerCommand('skilltree.revealInOS', withSkill((id) => actions.revealInOS(id))),
    vscode.commands.registerCommand('skilltree.copyPath', withSkill((id) => actions.copyPath(id))),
    vscode.commands.registerCommand('skilltree.setCategory', withSkill((id) => actions.pickCategory(id))),
    vscode.commands.registerCommand(
      'skilltree.showInGraph',
      withSkill(async (id) => {
        SkillGraphPanel.show(context, store, actions, id);
      }),
    ),
    vscode.window.registerWebviewPanelSerializer(GRAPH_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => SkillGraphPanel.revive(panel, context, store, actions),
    }),
  );

  void store.rescan().then(() => market.refresh());

  const api: SkillTreeApi = {
    rescan: () => store.rescan(),
    snapshot: () => store.snapshot,
    isGraphOpen: () => SkillGraphPanel.isOpen,
    isGraphReady: () => SkillGraphPanel.isReady,
    marketplace: () => market.snapshot,
    refreshCatalog: () => market.refresh(),
    isMarketplaceReady: () => MarketplacePanel.isReady,
    marketplaceRenderedCount: () => MarketplacePanel.renderedCount,
    activity: () => activity.snapshot,
    refreshActivity: () => activity.reload(),
    isActivityReady: () => ActivityPanel.isReady,
    activityRenderedCount: () => ActivityPanel.renderedCount,
  };
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    api.test = {
      setCatalog: (c) => (market.testCatalog = c),
      setSourceDir: (d) => (market.testSourceDir = d),
      setConfirm: (c) => (market.testConfirm = c),
      catalogCacheFile: () => market.cacheFile,
      setTrackingConsent: (c) => (activity.testConsent = c),
      recentActivityItems: () =>
        activityTree.getChildren().map((e) => {
          const item = activityTree.getTreeItem(e);
          return { label: String(typeof item.label === 'string' ? item.label : item.label?.label ?? ''), description: String(item.description ?? '') };
        }),
      graphState: () => ({ ...store.snapshot, activity: SkillGraphPanel.activity?.() }),
      indicators: () => indicators.view,
      setClaudeCli: (cli) => (bridge.testCli = cli),
      setClaudeConsent: (c) => (bridge.testConsent = c),
      setSuggestionChoice: (c) => (bridge.testSuggestionChoice = c),
      sidebarRows: () => home.topRows(),
      startClaudeBridge: () => bridge.start(),
      claudeBridgeDir: () => bridge.paths.root,
    };
  }
  return api;
}

export function deactivate(): void {
  // Disposables are cleaned up through context.subscriptions.
}

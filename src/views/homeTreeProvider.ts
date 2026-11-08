// The SkillTree sidebar: one native tree of data, following VS Code's view guidelines (no tree rows
// used as buttons). Installed skills grouped by where they live, plus recent use while tracking is on.
// Opening the editors and switching features lives in the view's title actions and "…" menu, the
// status bar item's menu, the Get Started walkthrough and the editors' section tabs.

import * as vscode from 'vscode';
import type { ActivityEvent } from '../shared/activity';
import type { ActivityService } from '../services/activity';
import type { MarketplaceService } from '../services/marketplace';
import type { SkillStore } from '../services/skillStore';
import type { ActivityTreeProvider } from './activityTreeProvider';
import type { SidebarNode, SkillsTreeProvider } from './skillsTreeProvider';

type SectionNode = { kind: 'section'; section: 'installed' | 'recent' };
type EventNode = { kind: 'event'; event: ActivityEvent };
export type HomeNode = SectionNode | EventNode | SidebarNode;

const INSTALLED: SectionNode = { kind: 'section', section: 'installed' };
const RECENT: SectionNode = { kind: 'section', section: 'recent' };


export class HomeTreeProvider implements vscode.TreeDataProvider<HomeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<HomeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subs: vscode.Disposable[];

  constructor(
    private readonly store: SkillStore,
    market: MarketplaceService,
    private readonly activity: ActivityService,
    private readonly skills: SkillsTreeProvider,
    private readonly events: ActivityTreeProvider,
  ) {
    const fire = () => this.emitter.fire(undefined);
    this.subs = [store.onDidChange(fire), market.onDidChange(fire), activity.onDidChange(fire)];
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: HomeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'section': {
        const installed = node.section === 'installed';
        const item = new vscode.TreeItem(installed ? 'Installed skills' : 'Recent activity', vscode.TreeItemCollapsibleState.Expanded);
        item.id = `section:${node.section}`;
        item.description = installed ? String(this.store.snapshot.skills.length) : undefined;
        item.contextValue = `section.${node.section}`;
        return item;
      }
      case 'event':
        return this.events.getTreeItem(node.event);
      default:
        return this.skills.getTreeItem(node);
    }
  }

  getChildren(node?: HomeNode): HomeNode[] {
    if (!node) {
      const groups = this.skills.getChildren();
      const top: HomeNode[] = groups.length ? groups : this.getChildren(INSTALLED);
      return [...top, ...(this.activity.snapshot.enabled ? [RECENT] : [])];
    }
    if (node.kind === 'section' && node.section === 'installed') {
      const groups = this.skills.getChildren();
      if (groups.length) return groups;
      return [{ kind: 'message', label: 'No skills found', description: 'install one from the Marketplace', tooltip: 'SkillTree looks in each workspace folder\'s .claude/skills/ and in ~/.claude/skills/.' }];
    }
    if (node.kind === 'section' && node.section === 'recent') {
      const events = this.events.getChildren();
      return events.length ? events.map((event) => ({ kind: 'event', event })) : [{ kind: 'message', label: 'No skill use recorded yet', description: 'new Claude Code sessions record it' }];
    }
    if (node.kind === 'group' || node.kind === 'skill' || node.kind === 'message') return this.skills.getChildren(node);
    return [];
  }

  getParent(node: HomeNode): HomeNode | undefined {
    if (node.kind === 'skill') return this.skills.getParent(node);
    if (node.kind === 'group') return undefined;
    if (node.kind === 'event') return RECENT;
    return undefined;
  }

  /** Test hook: the rows a user sees at the top level, as label + description. */
  topRows(): { label: string; description: string }[] {
    return this.getChildren().map((n) => {
      const t = this.getTreeItem(n);
      return { label: String(typeof t.label === 'string' ? t.label : t.label?.label ?? ''), description: String(t.description ?? '') };
    });
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.emitter.dispose();
  }
}

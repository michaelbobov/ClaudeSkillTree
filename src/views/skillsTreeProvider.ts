// Compact native sidebar: skills grouped by where they are installed, with true counts.

import * as vscode from 'vscode';
import type { SkillStore } from '../services/skillStore';
import type { OrganizedSkill, ScanRootStatus, SkillSource } from '../shared/types';

type GroupNode = { kind: 'group'; key: string; label: string; description: string; source: SkillSource; skills: OrganizedSkill[]; root?: ScanRootStatus };
type SkillNode = { kind: 'skill'; skill: OrganizedSkill };
type MessageNode = { kind: 'message'; label: string; description?: string; tooltip?: string };
export type SidebarNode = GroupNode | SkillNode | MessageNode;

const GROUP_ORDER: SkillSource[] = ['project', 'nested', 'personal', 'synced', 'managed'];

function groupLabel(source: SkillSource, rootLabel: string, multiRoot: boolean): string {
  switch (source) {
    case 'project':
      return multiRoot ? `Project · ${rootLabel}` : 'This project';
    case 'nested':
      return `Nested · ${rootLabel}`;
    case 'personal':
      return 'Personal (global)';
    case 'synced':
      return 'Synced from claude.ai';
    case 'managed':
      return 'Managed';
  }
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

export class SkillsTreeProvider implements vscode.TreeDataProvider<SidebarNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<SidebarNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly store: SkillStore) {
    this.sub = store.onDidChange(() => this.emitter.fire(undefined));
  }

  getTreeItem(node: SidebarNode): vscode.TreeItem {
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.description = node.description;
      item.tooltip = node.tooltip;
      return item;
    }
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(
        node.label,
        node.skills.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = `group:${node.key}`;
      item.description = node.description;
      item.contextValue = 'group';
      item.tooltip = node.root ? `${node.root.displayPath}${node.root.exists ? '' : ' (folder not found)'}` : undefined;
      item.iconPath = new vscode.ThemeIcon(node.source === 'personal' ? 'account' : node.source === 'synced' ? 'cloud' : node.source === 'managed' ? 'lock' : 'folder');
      return item;
    }
    const s = node.skill;
    const item = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.None);
    item.id = `skill:${s.id}`;
    const parts = [s.category === 'Other' && s.categorySource === 'default' ? '' : s.category];
    if (s.shadowedBy) parts.push('shadowed');
    item.description = parts.filter(Boolean).join(' · ');
    const hasError = s.issues.some((i) => i.level === 'error');
    const hasWarning = s.issues.some((i) => i.level === 'warning');
    item.iconPath = hasError
      ? new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'))
      : hasWarning
        ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
        : new vscode.ThemeIcon(s.readOnly ? 'lock-small' : 'note');
    const md = new vscode.MarkdownString(undefined, false);
    md.isTrusted = false;
    md.supportHtml = false;
    md.appendMarkdown(`**${escapeMd(s.name)}** \`${s.command.replace(/`/g, '')}\`\n\n`);
    if (s.description) md.appendMarkdown(`${escapeMd(s.description.slice(0, 400))}${s.description.length > 400 ? '…' : ''}\n\n`);
    md.appendMarkdown(`${escapeMd(s.displayPath)}`);
    for (const issue of s.issues.filter((i) => i.level !== 'info')) md.appendMarkdown(`\n\n$(warning) ${escapeMd(issue.message)}`);
    md.supportThemeIcons = true;
    item.tooltip = md;
    item.contextValue = s.readOnly ? 'skill.readonly' : 'skill';
    item.resourceUri = vscode.Uri.file(s.file);
    item.command = { command: 'skilltree.openSkillFile', title: 'Open SKILL.md', arguments: [s.id] };
    return item;
  }

  getChildren(node?: SidebarNode): SidebarNode[] {
    const state = this.store.snapshot;
    if (!node) {
      if (state.status === 'loading' && state.scannedAt === null) return [{ kind: 'message', label: 'Scanning skill folders…' }];
      if (state.status === 'error') return [{ kind: 'message', label: 'Scan failed', description: state.error, tooltip: state.error }];
      if (state.skills.length === 0) return []; // shows the viewsWelcome empty state
      return this.groups();
    }
    if (node.kind === 'group') {
      if (node.skills.length === 0) {
        return [{ kind: 'message', label: node.root?.exists ? 'No skills in this folder' : 'Folder not found', description: node.root?.displayPath }];
      }
      return node.skills.map((skill) => ({ kind: 'skill', skill }));
    }
    return [];
  }

  private groups(): GroupNode[] {
    const state = this.store.snapshot;
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const groups = new Map<string, GroupNode>();
    // Always show the workspace project group(s) and the personal group, even when empty.
    for (const root of state.roots) {
      if (root.source === 'synced' || root.source === 'managed' || root.source === 'nested') {
        if (root.skillCount === 0) continue;
      }
      const key = `${root.source}:${root.label}`;
      if (!groups.has(key)) {
        groups.set(key, { kind: 'group', key, source: root.source, label: groupLabel(root.source, root.label, multiRoot), description: '', skills: [], root });
      }
    }
    for (const s of state.skills) {
      const key = `${s.source}:${s.rootLabel}`;
      let g = groups.get(key);
      if (!g) {
        g = { kind: 'group', key, source: s.source, label: groupLabel(s.source, s.rootLabel, multiRoot), description: '', skills: [] };
        groups.set(key, g);
      }
      g.skills.push(s);
    }
    const list = [...groups.values()];
    for (const g of list) {
      g.skills.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      g.description = `${g.skills.length}${g.source === 'synced' || g.source === 'managed' ? ' · read-only' : ''}`;
    }
    return list.sort((a, b) => GROUP_ORDER.indexOf(a.source) - GROUP_ORDER.indexOf(b.source));
  }

  /** Locate the tree element for a skill id (used by reveal). */
  findSkillNode(id: string): SkillNode | undefined {
    const s = this.store.find(id);
    return s ? { kind: 'skill', skill: s } : undefined;
  }

  getParent(node: SidebarNode): SidebarNode | undefined {
    if (node.kind !== 'skill') return undefined;
    return this.groups().find((g) => g.skills.some((s) => s.id === node.skill.id));
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}

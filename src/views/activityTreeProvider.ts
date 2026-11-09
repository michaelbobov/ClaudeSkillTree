// "Recent activity" sidebar section: only events actually recorded by SkillTree's hooks.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CAPTURE_LABELS, type ActivityEvent, folderName, projectOf } from '../shared/activity';
import type { ActivityService } from '../services/activity';

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export class ActivityTreeProvider implements vscode.TreeDataProvider<ActivityEvent>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly service: ActivityService) {
    this.sub = service.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(e: ActivityEvent): vscode.TreeItem {
    const item = new vscode.TreeItem(e.skill ?? '(unknown skill)', vscode.TreeItemCollapsibleState.None);
    // With several agents at work, who and where matter: "Claude (Explore subagent) · my-app · 2m ago".
    const who = e.source === 'UserPromptExpansion' ? 'typed' : e.agentType ? `Claude (${e.agentType} subagent)` : 'Claude';
    const project = folderName(projectOf(e));
    item.description = `${who}${project ? ` · ${project}` : ''} · ${ago(e.ts)}`;
    item.iconPath = new vscode.ThemeIcon(e.source === 'UserPromptExpansion' ? 'terminal' : 'symbol-event');
    item.tooltip = `${CAPTURE_LABELS[e.source]}${e.agentType ? ` inside a ${e.agentType} subagent` : ''}\n${new Date(e.ts).toLocaleString()}\nSession ${e.sessionId ?? 'unknown'}\n${e.projectDir ?? e.cwd ?? ''}`;
    item.command = { command: 'skilltree.openActivity', title: 'Open Activity' };
    return item;
  }

  getChildren(): ActivityEvent[] {
    const s = this.service.snapshot;
    if (!s.enabled && s.events.length === 0) return []; // viewsWelcome explains how to opt in
    return s.events.slice(0, 15);
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}

export const projectName = (p: string | null) => (p ? path.basename(p) : 'unknown project');

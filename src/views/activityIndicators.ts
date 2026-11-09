// SkillTree outside its own views: a status bar item that is always there (skill count, or the most
// recently recorded skill while tracking is on) and opens the SkillTree menu, plus a badge on the
// SkillTree Activity Bar icon counting uses recorded since you last looked. Recorded events only.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CAPTURE_LABELS, folderName, liveSessions, multiSessionStatus, sessionWho, type ActivityEvent, type LiveSession } from '../shared/activity';
import type { ActivityService } from '../services/activity';
import type { SkillStore } from '../services/skillStore';

const SEEN_KEY = 'skilltree.activity.seenUntil';

export function relativeTime(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function line(e: ActivityEvent): string {
  const how = e.source === 'UserPromptExpansion' ? 'typed' : e.agentType ? `by a ${e.agentType} subagent` : 'by Claude';
  const project = e.projectDir ?? e.cwd;
  return `**${e.skill ?? '(unknown skill)'}** · ${how} · ${relativeTime(e.ts)}${project ? ` · ${path.basename(project)}` : ''}`;
}

function sessionLine(l: LiveSession): string {
  const who = sessionWho(l);
  const more = l.skills.length > 1 ? ` (+${l.skills.length - 1})` : '';
  return `**${folderName(l.project) ?? 'unknown project'}** · ${who} · ${l.lastSkill ?? '(unknown skill)'}${more} · ${relativeTime(l.lastTs)}`;
}

export class ActivityIndicators implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('skilltree.lastSkill', vscode.StatusBarAlignment.Left, 10);
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: ActivityService,
    private readonly treeView: vscode.TreeView<unknown>,
    private readonly store: SkillStore,
  ) {
    this.item.name = 'SkillTree';
    this.item.command = 'skilltree.menu';
    this.disposables.push(
      service.onDidChange(() => this.update()),
      store.onDidChange(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('skilltree.statusBar')) this.update();
      }),
      treeView.onDidChangeVisibility((e) => {
        if (e.visible) void this.markSeen();
      }),
    );
    // Keep the relative time ("3m ago") current.
    this.timer = setInterval(() => this.update(), 60_000);
    this.update();
  }

  /** Clears the badge: everything recorded so far has been seen. */
  async markSeen(): Promise<void> {
    const newest = this.service.snapshot.events[0]?.ts;
    if (newest && newest !== this.context.globalState.get<string>(SEEN_KEY)) await this.context.globalState.update(SEEN_KEY, newest);
    this.update();
  }

  /** Test hook: what the status bar and badge currently show. */
  get view(): { statusText: string | null; badge: number } {
    return { statusText: this.visible ? this.item.text : null, badge: this.treeView.badge?.value ?? 0 };
  }

  private visible = false;

  private update(): void {
    const s = this.service.snapshot;
    const show = vscode.workspace.getConfiguration('skilltree').get<boolean>('statusBar', true);
    const last = s.enabled ? s.events[0] : undefined;
    if (!s.enabled) {
      const n = this.store.snapshot.skills.length;
      this.item.text = `$(type-hierarchy) ${n} skill${n === 1 ? '' : 's'}`;
      this.item.tooltip = 'SkillTree: click for the Skill Tree, Marketplace, Activity and settings.';
    } else if (!last) {
      this.item.text = '$(pulse) No skill use yet';
      this.item.tooltip = 'SkillTree is recording skill use. Nothing recorded yet; new Claude Code sessions pick up the hooks. Click for the SkillTree menu.';
    } else {
      // Several Claude Code sessions (any project) using skills in the last 10 minutes: say so.
      const live = liveSessions(s.events.slice(0, 200), Date.now(), undefined, s.ended);
      const many = multiSessionStatus(live);
      this.item.text = many ? `$(pulse) ${many}` : `$(pulse) ${last.skill ?? 'unknown skill'} · ${relativeTime(last.ts)}`;
      const sessions = many ? [`**${live.length} Claude Code sessions** used skills in the last 10 minutes`, '', ...live.slice(0, 6).map((l) => `- ${sessionLine(l)}`), ''] : [];
      const md = new vscode.MarkdownString(
        [...sessions, '**Recently used skills** (recorded by SkillTree)', '', ...s.events.slice(0, 6).map((e) => `- ${line(e)}`), '', `${CAPTURE_LABELS[last.source]} · click for the SkillTree menu`].join('\n'),
      );
      this.item.tooltip = md;
    }
    if (show) this.item.show();
    else this.item.hide();
    this.visible = show;
    if (!s.enabled) {
      this.treeView.badge = undefined;
      return;
    }

    // Before the first look, count only what was recorded since tracking was enabled.
    const seen = this.context.globalState.get<string>(SEEN_KEY) ?? s.installedAt ?? undefined;
    const unseen = this.treeView.visible ? 0 : s.events.filter((e) => !seen || e.ts > seen).length;
    this.treeView.badge = unseen > 0 ? { value: unseen, tooltip: `${unseen} skill use${unseen === 1 ? '' : 's'} recorded since you last looked` } : undefined;
    if (this.treeView.visible && s.events[0] && s.events[0].ts !== seen) void this.markSeen();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.item.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

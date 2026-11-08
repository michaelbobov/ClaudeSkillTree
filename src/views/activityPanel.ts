// Activity timeline editor tab. Shows only events recorded by SkillTree's opt-in hooks.
import { NAV_COMMANDS } from '../shared/nav';
import * as vscode from 'vscode';
import { parseActivityMessage, type ActivityHostMessage, type ActivityViewState, type ActivityWebviewMessage } from '../shared/activity';
import type { ActivityService, ActivityState } from '../services/activity';
import { webviewHtml, webviewOptions } from './webviewHtml';

export const ACTIVITY_VIEW_TYPE = 'skilltree.activity';

export function toViewState(s: ActivityState, service: ActivityService): ActivityViewState {
  return {
    enabled: s.enabled,
    scope: s.scope,
    settingsFile: s.settingsFile,
    logFile: s.logFile,
    installedAt: s.installedAt,
    error: s.error,
    skippedLines: s.skippedLines,
    sessions: service.sessions(),
    total: s.events.length,
  };
}

export class ActivityPanel implements vscode.Disposable {
  private static current: ActivityPanel | undefined;
  private ready = false;
  private rendered = -1;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, service: ActivityService): ActivityPanel {
    if (ActivityPanel.current) ActivityPanel.current.panel.reveal(undefined, false);
    else ActivityPanel.current = new ActivityPanel(vscode.window.createWebviewPanel(ACTIVITY_VIEW_TYPE, 'Skill Activity', vscode.ViewColumn.Active, webviewOptions(context.extensionUri)), context, service);
    return ActivityPanel.current;
  }

  static revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, service: ActivityService): void {
    panel.webview.options = webviewOptions(context.extensionUri);
    ActivityPanel.current?.dispose();
    ActivityPanel.current = new ActivityPanel(panel, context, service);
  }

  static get isReady(): boolean {
    return !!ActivityPanel.current?.ready;
  }
  static get renderedCount(): number {
    return ActivityPanel.current?.rendered ?? -1;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly service: ActivityService,
  ) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'skilltree.svg');
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, 'activity', 'Skill Activity');
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((raw) => void this.onMessage(raw)),
      panel.onDidChangeViewState(() => {
        if (!panel.visible) this.ready = false;
      }),
      service.onDidChange((s) => this.post({ type: 'state', state: toViewState(s, service) })),
    );
  }

  private post(m: ActivityHostMessage): void {
    if (this.ready) void this.panel.webview.postMessage(m);
  }

  private async onMessage(raw: unknown): Promise<void> {
    const msg = parseActivityMessage(raw);
    if (!msg) return;
    await this.handle(msg);
  }

  private async handle(msg: ActivityWebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'navigate':
        await vscode.commands.executeCommand(NAV_COMMANDS[msg.to]);
        return;
      case 'ready':
        this.ready = true;
        this.post({ type: 'state', state: toViewState(this.service.snapshot, this.service) });
        return;
      case 'refresh':
        await this.service.reload();
        return;
      case 'rendered':
        this.rendered = msg.count;
        return;
      case 'enable':
        await vscode.commands.executeCommand('skilltree.enableTracking');
        return;
      case 'disable':
        await vscode.commands.executeCommand('skilltree.disableTracking');
        return;
      case 'clearLog': {
        const ok = await vscode.window.showWarningMessage('Delete the local activity log?', { modal: true, detail: this.service.logFile }, 'Delete');
        if (ok) await this.service.clearLog();
        return;
      }
      case 'openSettings':
        if (this.service.snapshot.settingsFile) await vscode.window.showTextDocument(vscode.Uri.file(this.service.snapshot.settingsFile), { preview: true });
        return;
    }
  }

  dispose(): void {
    if (ActivityPanel.current === this) ActivityPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}

// Marketplace editor tab. The webview gets no network or filesystem access; previews, installs
// and links go through the host, keyed by catalog entry id.

import { NAV_COMMANDS } from '../shared/nav';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseMarketplaceMessage, type MarketplaceHostMessage, type MarketplaceWebviewMessage } from '../shared/marketplace';
import type { MarketplaceService } from '../services/marketplace';
import type { SkillStore } from '../services/skillStore';
import { webviewHtml, webviewOptions } from './webviewHtml';

export const MARKETPLACE_VIEW_TYPE = 'skilltree.marketplace';

export class MarketplacePanel implements vscode.Disposable {
  private static current: MarketplacePanel | undefined;
  private ready = false;
  private renderedCount = -1;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, service: MarketplaceService, store: SkillStore, focusId?: string): MarketplacePanel {
    if (MarketplacePanel.current) {
      MarketplacePanel.current.panel.reveal(undefined, false);
    } else {
      const panel = vscode.window.createWebviewPanel(MARKETPLACE_VIEW_TYPE, 'Skill Marketplace', vscode.ViewColumn.Active, webviewOptions(context.extensionUri));
      MarketplacePanel.current = new MarketplacePanel(panel, context, service, store);
    }
    if (focusId) MarketplacePanel.current.post({ type: 'focus', id: focusId });
    return MarketplacePanel.current;
  }

  static revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, service: MarketplaceService, store: SkillStore): void {
    panel.webview.options = webviewOptions(context.extensionUri);
    MarketplacePanel.current?.dispose();
    MarketplacePanel.current = new MarketplacePanel(panel, context, service, store);
  }

  static get isReady(): boolean {
    return !!MarketplacePanel.current?.ready;
  }

  /** Number of entries the webview reported rendering (-1 before the first render). */
  static get renderedCount(): number {
    return MarketplacePanel.current?.renderedCount ?? -1;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly service: MarketplaceService,
    private readonly store: SkillStore,
  ) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'skilltree.svg');
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, 'marketplace', 'Skill Marketplace');
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((raw) => void this.onMessage(raw)),
      panel.onDidChangeViewState(() => {
        if (!panel.visible) this.ready = false;
      }),
      service.onDidChange((state) => this.post({ type: 'state', state })),
    );
  }

  private post(message: MarketplaceHostMessage): void {
    if (this.ready) void this.panel.webview.postMessage(message);
  }

  private async onMessage(raw: unknown): Promise<void> {
    const msg = parseMarketplaceMessage(raw);
    if (!msg) return;
    try {
      await this.handle(msg);
    } catch (err) {
      void vscode.window.showErrorMessage(`SkillTree: ${(err as Error).message}`);
    }
  }

  private async handle(msg: MarketplaceWebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'navigate':
        await vscode.commands.executeCommand(NAV_COMMANDS[msg.to]);
        return;
      case 'enableClaude':
        await vscode.commands.executeCommand('skilltree.enableClaudeRecommendations');
        return;
      case 'ready':
        this.ready = true;
        this.post({ type: 'state', state: this.service.snapshot });
        if (this.service.snapshot.catalog === null) void this.service.refresh();
        return;
      case 'refresh':
        await this.service.refresh();
        return;
      case 'rendered':
        this.renderedCount = msg.count;
        return;
      case 'preview':
        try {
          this.post({ type: 'preview', id: msg.id, status: 'ready', text: await this.service.previewText(msg.id) });
        } catch (err) {
          this.post({ type: 'preview', id: msg.id, status: 'error', text: '', error: (err as Error).message });
        }
        return;
      case 'install': {
        await vscode.commands.executeCommand('skilltree.installEntry', msg.id, msg.scope);
        return;
      }
      case 'openSource': {
        const entry = this.service.find(msg.id);
        // Only the catalog's pinned github.com URL is opened, never a URL supplied by the webview.
        if (entry && entry.sourceUrl.startsWith('https://github.com/')) await vscode.env.openExternal(vscode.Uri.parse(entry.sourceUrl));
        return;
      }
      case 'openInstalled': {
        const entry = this.service.find(msg.id);
        const view = this.service.snapshot.entries.find((e) => e.id === msg.id);
        const local = view?.localIds.map((id) => this.store.find(id)).find(Boolean);
        if (entry && local) await vscode.window.showTextDocument(vscode.Uri.file(path.join(local.dir, 'SKILL.md')), { preview: true });
        return;
      }
    }
  }

  dispose(): void {
    if (MarketplacePanel.current === this) MarketplacePanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}

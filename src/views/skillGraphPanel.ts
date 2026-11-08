// Full Skill Tree editor tab (webview). The webview gets no filesystem access: it can only ask the
// host to act on skills by id, and every message is validated in parseWebviewMessage.

import { NAV_COMMANDS } from '../shared/nav';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseWebviewMessage, type HostToWebview, type WebviewToHost } from '../shared/protocol';
import { splitFrontmatter } from '../core/frontmatter';
import type { SkillStore } from '../services/skillStore';
import type { SkillActions } from '../services/skillActions';
import { webviewHtml, webviewOptions } from './webviewHtml';
import type { SkillTreeState } from '../shared/types';

export const GRAPH_VIEW_TYPE = 'skilltree.graph';
const MAX_BODY_BYTES = 256 * 1024;

export class SkillGraphPanel implements vscode.Disposable {
  private static current: SkillGraphPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private pendingSelect: string | undefined;

  static show(context: vscode.ExtensionContext, store: SkillStore, actions: SkillActions, selectId?: string): SkillGraphPanel {
    if (SkillGraphPanel.current) {
      SkillGraphPanel.current.panel.reveal(undefined, false);
      if (selectId) SkillGraphPanel.current.select(selectId);
      return SkillGraphPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(GRAPH_VIEW_TYPE, 'Skill Tree', vscode.ViewColumn.Active, SkillGraphPanel.options(context));
    SkillGraphPanel.current = new SkillGraphPanel(panel, context, store, actions);
    if (selectId) SkillGraphPanel.current.select(selectId);
    return SkillGraphPanel.current;
  }

  static revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, store: SkillStore, actions: SkillActions): void {
    panel.webview.options = SkillGraphPanel.options(context);
    SkillGraphPanel.current?.dispose();
    SkillGraphPanel.current = new SkillGraphPanel(panel, context, store, actions);
  }

  /** Supplies observed activity for the inspector (set by extension.ts). */
  static activity: (() => SkillTreeState['activity']) | undefined;

  /** Re-sends state to the open panel (e.g. after new activity was recorded). */
  static refresh(): void {
    SkillGraphPanel.current?.postState();
  }

  private postState(): void {
    this.post({ type: 'state', state: { ...this.store.snapshot, activity: SkillGraphPanel.activity?.() } });
  }

  static get isOpen(): boolean {
    return !!SkillGraphPanel.current;
  }

  /** True once the webview script has loaded and said hello (proves the bundle runs under the CSP). */
  static get isReady(): boolean {
    return !!SkillGraphPanel.current?.ready;
  }

  private static options(context: vscode.ExtensionContext): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return webviewOptions(context.extensionUri);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly store: SkillStore,
    private readonly actions: SkillActions,
  ) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'skilltree.svg');
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((raw) => void this.onMessage(raw)),
      panel.onDidChangeViewState(() => {
        // retainContextWhenHidden is off; the webview re-sends `ready` when it is shown again.
        if (!panel.visible) this.ready = false;
      }),
      store.onDidChange(() => this.postState()),
    );
  }

  select(id: string): void {
    if (this.ready) this.post({ type: 'select', id });
    else this.pendingSelect = id;
  }

  private post(message: HostToWebview): void {
    if (!this.ready) return;
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(raw: unknown): Promise<void> {
    const msg = parseWebviewMessage(raw);
    if (!msg) return;
    try {
      await this.handle(msg);
    } catch (err) {
      void vscode.window.showErrorMessage(`SkillTree: ${(err as Error).message}`);
    }
  }

  private async handle(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.postState();
        if (this.pendingSelect) {
          this.post({ type: 'select', id: this.pendingSelect });
          this.pendingSelect = undefined;
        }
        if (this.store.snapshot.scannedAt === null) void this.store.rescan();
        return;
      case 'rescan':
        await this.store.rescan();
        return;
      case 'openSkill':
        await this.actions.openSkillFile(msg.id);
        return;
      case 'revealSkill':
        await this.actions.revealInOS(msg.id);
        return;
      case 'copyPath':
        await this.actions.copyPath(msg.id);
        return;
      case 'getSkillBody':
        this.post(await this.readBody(msg.id));
        return;
      case 'setCategory':
        if (this.store.find(msg.id)) await this.store.setCategory(msg.id, msg.category);
        return;
      case 'savePositions':
        await this.store.savePositions(msg.positions);
        return;
      case 'resetLayout':
        await this.store.resetLayout();
        return;
      case 'setCollapsed':
        await this.store.setCollapsed(msg.categories);
        return;
      case 'openLink':
        await this.actions.openLink(msg.id, msg.href);
        return;
      case 'createSkill':
        await vscode.commands.executeCommand('skilltree.createProjectSkill');
        return;
      case 'enableTracking':
        await vscode.commands.executeCommand('skilltree.enableTracking');
        return;
      case 'openActivity':
        await vscode.commands.executeCommand('skilltree.openActivity');
        return;
      case 'navigate':
        await vscode.commands.executeCommand(NAV_COMMANDS[msg.to]);
        return;
    }
  }

  private async readBody(id: string): Promise<HostToWebview> {
    const skill = this.store.find(id);
    if (!skill) return { type: 'skillBody', id, markdown: '', truncated: false, error: 'Skill not found. Try rescanning.' };
    try {
      const handle = await fs.open(skill.file, 'r');
      try {
        const buf = Buffer.alloc(MAX_BODY_BYTES);
        const { bytesRead } = await handle.read(buf, 0, MAX_BODY_BYTES, 0);
        const st = await handle.stat();
        const text = buf.subarray(0, bytesRead).toString('utf8');
        return { type: 'skillBody', id, markdown: splitFrontmatter(text).body, truncated: st.size > MAX_BODY_BYTES };
      } finally {
        await handle.close();
      }
    } catch (err) {
      return { type: 'skillBody', id, markdown: '', truncated: false, error: `Could not read ${path.basename(skill.file)}: ${(err as Error).message}` };
    }
  }

  private html(): string {
    return webviewHtml(this.panel.webview, this.context.extensionUri, 'graph', 'Skill Tree');
  }

  dispose(): void {
    if (SkillGraphPanel.current === this) SkillGraphPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}

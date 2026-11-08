// User-facing actions on skills, shared by the sidebar, commands and the graph webview.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CATEGORIES, type Category } from '../shared/types';
import { hasForbiddenNameChars } from '../core/frontmatter';
import { isContained } from '../core/paths';
import type { SkillStore } from './skillStore';

export class SkillActions {
  constructor(
    private readonly store: SkillStore,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  private require(id: string) {
    const skill = this.store.find(id);
    if (!skill) throw new Error('That skill is no longer on disk. Rescan to refresh the list.');
    return skill;
  }

  async openSkillFile(id: string): Promise<void> {
    const skill = this.require(id);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(skill.file));
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active });
  }

  async revealInOS(id: string): Promise<void> {
    const skill = this.require(id);
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(skill.file));
  }

  async copyPath(id: string): Promise<void> {
    const skill = this.require(id);
    await vscode.env.clipboard.writeText(skill.file);
    vscode.window.setStatusBarMessage(`Copied ${skill.displayPath}`, 2500);
  }

  async pickCategory(id: string): Promise<void> {
    const skill = this.require(id);
    type Item = vscode.QuickPickItem & { value: Category | null };
    const items: Item[] = CATEGORIES.map((c) => ({
      label: c,
      value: c,
      description: c === skill.category ? (skill.categorySource === 'user' ? 'current' : `current · ${skill.categorySource}`) : undefined,
    }));
    if (skill.categorySource === 'user') {
      items.push({ label: 'Reset to automatic', value: null, kind: vscode.QuickPickItemKind.Default, description: 'Use frontmatter or keyword suggestion' });
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: `Category for ${skill.name}`,
      placeHolder: 'Stored by SkillTree. SKILL.md is not modified.',
    });
    if (pick) await this.store.setCategory(id, pick.value);
  }

  /** Opens a link found in a skill's Markdown. Relative links must stay inside the skill folder. */
  async openLink(id: string, href: string): Promise<void> {
    const skill = this.require(id);
    let url: URL | null = null;
    try {
      url = new URL(href);
    } catch {
      url = null;
    }
    if (url) {
      if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') {
        await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
      } else {
        void vscode.window.showWarningMessage(`SkillTree does not open "${url.protocol}" links from skill files.`);
      }
      return;
    }
    if (href.startsWith('#')) return;
    const clean = decodeURIComponent(href.split('#')[0].split('?')[0]);
    const target = path.resolve(skill.dir, clean);
    if (!isContained(skill.dir, target)) {
      void vscode.window.showWarningMessage('That link points outside the skill folder and was not opened.');
      return;
    }
    try {
      const st = await fs.stat(target);
      if (st.isDirectory()) {
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(target));
        return;
      }
      await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: true });
    } catch {
      void vscode.window.showWarningMessage(`File not found in skill folder: ${clean}`);
    }
  }

  /** Creates <workspace>/.claude/skills/<name>/SKILL.md. Never overwrites an existing folder. */
  async createProjectSkill(): Promise<string | undefined> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('SkillTree does not create files in an untrusted workspace.');
      return;
    }
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    if (folders.length === 0) {
      void vscode.window.showWarningMessage('Open a folder to create a project skill.');
      return;
    }
    const folder =
      folders.length === 1
        ? folders[0]
        : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Workspace folder for the new skill' });
    if (!folder) return;

    const skillsDir = path.join(folder.uri.fsPath, '.claude', 'skills');
    const name = await vscode.window.showInputBox({
      title: 'New project skill',
      prompt: `Folder name in ${path.join(folder.name, '.claude', 'skills')}/ (also the /command name)`,
      placeHolder: 'example-skill',
      validateInput: async (value) => {
        const v = value.trim();
        if (!v) return 'Enter a name';
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(v)) return 'Use letters, numbers, ".", "-" or "_" (max 64), starting with a letter or number';
        if (v === 'synced' || v.toLowerCase().startsWith('anthropic-skills')) return 'That name is reserved by Claude Code';
        if (hasForbiddenNameChars(v)) return 'Name contains characters Claude Code refuses';
        try {
          await fs.stat(path.join(skillsDir, v));
          return `${v} already exists. SkillTree will not overwrite it.`;
        } catch {
          return undefined;
        }
      },
    });
    if (!name) return;
    const dir = path.join(skillsDir, name.trim());
    if (!isContained(skillsDir, dir)) return;
    const file = path.join(dir, 'SKILL.md');
    const template = [
      '---',
      `name: ${name.trim()}`,
      'description: Describe what this skill does and when Claude should use it.',
      '---',
      '',
      `# ${name.trim()}`,
      '',
      'Write the instructions Claude should follow when this skill is used.',
      '',
    ].join('\n');
    try {
      await fs.mkdir(dir, { recursive: false }).catch(async (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          await fs.mkdir(skillsDir, { recursive: true });
          await fs.mkdir(dir);
        } else throw err;
      });
      // 'wx' fails if the file exists: never overwrite.
      await fs.writeFile(file, template, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      void vscode.window.showErrorMessage(
        code === 'EEXIST' ? `${name} already exists; nothing was changed.` : `Could not create skill: ${(err as Error).message}`,
      );
      return;
    }
    this.log.info(`Created project skill ${path.relative(folder.uri.fsPath, file)}`);
    await this.store.rescan();
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    void vscode.window.showInformationMessage(
      `Created ${name}. If .claude/skills/ did not exist when your Claude Code session started, run /reload-skills there.`,
    );
    return file;
  }
}

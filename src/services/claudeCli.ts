// Locating and running the Claude Code CLI (no shell). Used to register SkillTree's MCP server with
// Claude Code's own `claude mcp add/remove`, so SkillTree never edits Claude Code's config files.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findNode } from './activityNode';

/** CLAUDE_BIN, else the newest binary bundled with the VS Code Claude Code extension, else `claude` on PATH. */
export function findClaudeBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLAUDE_BIN && fs.existsSync(env.CLAUDE_BIN)) return env.CLAUDE_BIN;
  const extDir = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    const versions = fs
      .readdirSync(extDir)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .map((d) => path.join(extDir, d, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude'))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (versions.length) return versions[versions.length - 1];
  } catch {
    /* no VS Code extensions dir */
  }
  return findNode(env.PATH ?? '', 'claude');
}

export type CliRunner = (args: string[]) => Promise<{ code: number | null; out: string }>;

export function claudeCliRunner(bin: string): CliRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(bin, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const raw: unknown = err ? (err as unknown as { code?: unknown }).code : 0;
        resolve({ code: typeof raw === 'number' ? raw : 1, out: `${stdout}${stderr}`.trim() });
      });
    });
}

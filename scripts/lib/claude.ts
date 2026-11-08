// Helpers for live checks that run a real Claude Code session (scripts/e2e-live.ts, test/live).
// Never used by the extension itself.
import { spawn } from 'node:child_process';

export { findClaudeBinary } from '../../src/services/claudeCli';

export const NOT_LOGGED_IN = /not logged in|please run \/login|invalid api key|authentication/i;

/**
 * One short, non-persistent, budget-capped `claude -p` run. `settingSources` limits which settings
 * files Claude Code loads (default: the project's own .claude/settings.json only).
 */
export function runClaude(
  bin: string,
  cwd: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
  opts: { settingSources?: string; timeoutMs?: number; allowedTools?: string; extraArgs?: string[]; budgetUsd?: string } = {},
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--setting-sources', opts.settingSources ?? 'project', '--no-session-persistence', '--max-budget-usd', opts.budgetUsd ?? '0.25', '--model', 'haiku', '--allowedTools', opts.allowedTools ?? 'Skill', ...(opts.extraArgs ?? [])];
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 120000);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, out: `spawn failed: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

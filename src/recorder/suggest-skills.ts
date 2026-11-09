// SkillTree skill suggestions: a Claude Code UserPromptSubmit hook (bundled to a standalone .mjs).
//   node suggest-skills.mjs <skilltree-base-dir>
// Reads the hook payload from stdin, matches the prompt's keywords against the local catalog copy,
// and when a not-yet-installed skill fits, prints a short note that Claude Code adds as context.
// The prompt is never written anywhere. Always exits 0 and stays quiet on any problem.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { validateCatalog } from '../shared/catalog';
import { HEARTBEAT_STALE_MS, bridgePaths, parseHeartbeat } from '../shared/bridge';
import { isGeneratedPrompt, suggestForPrompt, suggestionContext } from '../mcp/suggest';

const MAX_INPUT = 1024 * 1024;
const MAX_SESSIONS = 50;

function folders(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name.toLowerCase());
  } catch {
    return [];
  }
}

function main(): void {
  const base = process.argv[2];
  if (!base || !path.isAbsolute(base)) return;
  const payload = JSON.parse(fs.readFileSync(0, 'utf8').slice(0, MAX_INPUT)) as Record<string, unknown>;
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  if (!prompt.trim() || prompt.trimStart().startsWith('/')) return; // slash commands already name what to run
  if (isGeneratedPrompt(prompt)) return; // a subagent reporting back, not something the user asked
  const cwd = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : null;
  const session = typeof payload.session_id === 'string' ? payload.session_id.slice(0, 100) : '';

  const p = bridgePaths(base);
  const v = validateCatalog(JSON.parse(fs.readFileSync(p.catalog, 'utf8')));
  if (!v.ok) return;
  const home = process.env.SKILLTREE_HOME ?? os.homedir();
  const installed = new Set([...folders(path.join(home, '.claude', 'skills')), ...(cwd ? folders(path.join(cwd, '.claude', 'skills')) : [])]);

  // Suggest each skill at most once per session.
  const stateFile = path.join(p.root, 'suggested.json');
  let state: Record<string, string[]> = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, string[]>;
  } catch {
    /* first suggestion */
  }
  const already = new Set(session ? state[session] ?? [] : []);
  const picks = suggestForPrompt(v.catalog, prompt, { installedFolders: installed, exclude: already });
  if (picks.length === 0) return;

  // Show it to the user in VS Code right away (non-blocking notification), when SkillTree is running.
  let shown = false;
  try {
    const live = fs.readdirSync(p.windows).some((n) => {
      try {
        const hb = parseHeartbeat(JSON.parse(fs.readFileSync(path.join(p.windows, n), 'utf8')));
        return !!hb && Date.now() - Date.parse(hb.updatedAt) < HEARTBEAT_STALE_MS;
      } catch {
        return false;
      }
    });
    if (live) {
      const id = crypto.randomUUID();
      fs.mkdirSync(p.suggestions, { recursive: true });
      const file = path.join(p.suggestions, `${id}.json`);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ v: 1, id, skillIds: picks.map((x) => x.entry.id), projectDir: cwd, sessionId: session || null, createdAt: new Date().toISOString() }), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
      shown = true;
    }
  } catch {
    /* no SkillTree window */
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: suggestionContext(picks, shown) } }));
  if (session) {
    state[session] = [...already, ...picks.map((x) => x.entry.id)];
    const keys = Object.keys(state);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete state[k];
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  }
}

try {
  main();
} catch {
  /* never fail the prompt */
}
process.exit(0);

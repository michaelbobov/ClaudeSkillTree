// Live end-to-end check (network): uses only temp directories, never your real ~/.claude.
//   Phase 2: preview a real catalog entry at its pinned commit, install it into a temp sandbox
//            project with the real installer (confirmation auto-accepted), rescan, show Installed.
//   Phase 3: see runActivityE2E() — a real Claude Code session in a sandbox, when available.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeInstall, githubRawProvider, gitBlobSha, planInstall } from '../src/core/installer';
import { scanAll, standardRoots } from '../src/core/scanner';
import { installStateFor, validateCatalog, type CatalogEntry } from '../src/shared/catalog';
import { parseActivityLog } from '../src/shared/activity';
import { enableTracking } from '../src/core/hooksConfig';
import { findNode } from '../src/services/activityNode';
import { findClaudeBinary, NOT_LOGGED_IN, runClaude } from './lib/claude';

const log = (s = '') => console.log(s);

async function phase2(): Promise<boolean> {
  log('== Phase 2: preview → install → detect (live GitHub) ==');
  const v = validateCatalog(JSON.parse(fs.readFileSync('data/catalog.json', 'utf8')));
  if (!v.ok) throw new Error(`data/catalog.json invalid: ${v.errors[0]}`);
  const size = (e: CatalogEntry) => e.files.reduce((n, f) => n + f.size, 0);
  const entry = v.catalog.entries.filter((e) => e.kind === 'skill' && e.files.length >= 2).sort((a, b) => size(a) - size(b))[0];
  if (!entry) throw new Error('no installable entry in data/catalog.json');
  log(`entry:     ${entry.id}`);
  log(`commit:    ${entry.commitSha}`);
  log(`sourceUrl: ${entry.sourceUrl}`);
  log(`license:   ${entry.license ?? 'unknown'}`);

  // Preview
  const provider = githubRawProvider();
  const md = entry.files.find((f) => f.path === 'SKILL.md')!;
  const text = await provider.readFile(entry, 'SKILL.md', md.size);
  const hashOk = gitBlobSha(text) === md.sha;
  log(`PREVIEW files (${entry.files.length}): ${entry.files.map((f) => `${f.path} [${f.kind}, ${f.size} B]`).join(', ')}`);
  log(`PREVIEW warnings: ${entry.warnings.length ? entry.warnings.join(' | ') : 'none'}`);
  log(`PREVIEW SKILL.md ${text.length} bytes, blob hash ${hashOk ? 'matches' : 'DOES NOT MATCH'} pinned commit; first line: ${text.toString('utf8').split('\n')[0]}`);
  if (!hashOk) return false;

  // Install into a temp sandbox project
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltree-e2e-'));
  const project = path.join(sandbox, 'sandbox-project');
  const home = path.join(sandbox, 'home'); // empty fake home: keeps the real ~/.claude out of the scan
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  try {
    const plan = await planInstall(entry, path.join(project, '.claude', 'skills'), 'project');
    log(`INSTALL plan: ${plan.files.length} files, ${plan.totalBytes} bytes → ${plan.destDir} (confirmation auto-accepted for this test)`);
    const out = await executeInstall(plan, provider);
    log(`INSTALL wrote ${out.filesWritten} files at pinned commit ${out.record.commitSha.slice(0, 12)}; provenance ${path.join(out.destDir, '.skilltree-source.json')}`);

    const { skills } = await scanAll(standardRoots({ homeDir: home, workspaceFolders: [{ name: 'sandbox-project', path: project }] }), { homeDir: home });
    const detected = skills.find((s) => s.installedFrom?.id === entry.id);
    const state = installStateFor(entry, skills);
    log(`RESCAN found ${skills.length} skill(s): ${skills.map((s) => `${s.id} (${s.command})`).join(', ')}`);
    log(`STATE ${entry.id} → ${state.state}${detected ? ` (local ${detected.id}, commit ${detected.installedFrom?.commitSha.slice(0, 12)})` : ''}`);
    return !!detected && state.state === 'installed';
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
    log(`cleanup: removed ${sandbox}`);
  }
}

/**
 * Phase 3: a real Claude Code session in a temp sandbox project whose own .claude/settings.json
 * carries SkillTree's hooks. Claude Code runs with --setting-sources project and, by default, a
 * temporary CLAUDE_CONFIG_DIR so nothing under your real ~/.claude is read or written. A temporary
 * config directory has no login, so the session is skipped unless you opt in with
 * SKILLTREE_E2E_REAL_CLAUDE=1 (uses your normal Claude Code login/config; still no transcript saved).
 */
async function phase3(): Promise<'recorded' | 'skipped' | 'failed'> {
  log('== Phase 3: real Claude Code session → hook → Activity event ==');
  const bin = findClaudeBinary();
  if (!bin) {
    log('SKIPPED: no Claude Code binary found (PATH, CLAUDE_BIN, or the VS Code Claude Code extension).');
    return 'skipped';
  }
  const node = findNode();
  if (!node) {
    log('SKIPPED: Node.js not found on PATH; the recorder hook needs it.');
    return 'skipped';
  }
  const recorder = path.resolve('dist/recorder/record-skill-event.mjs');
  if (!fs.existsSync(recorder)) throw new Error('dist/recorder/record-skill-event.mjs missing; run npm run build');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltree-e2e-claude-'));
  const project = path.join(sandbox, 'project');
  const logFile = path.join(sandbox, 'activity.jsonl');
  try {
    fs.mkdirSync(path.join(project, '.claude', 'skills', 'sandbox-echo'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.claude', 'skills', 'sandbox-echo', 'SKILL.md'),
      '---\nname: sandbox-echo\ndescription: Test skill for SkillTree. Use when asked to run the sandbox echo check.\n---\n\nReply with exactly SANDBOX-ECHO-OK and nothing else.\n',
    );
    await enableTracking({ settingsFile: path.join(project, '.claude', 'settings.json'), nodePath: node, recorderPath: recorder, logFile });
    log(`binary:   ${bin}`);
    log(`sandbox:  ${project} (hooks in its .claude/settings.json → ${logFile})`);

    const useReal = process.env.SKILLTREE_E2E_REAL_CLAUDE === '1';
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (!useReal) env.CLAUDE_CONFIG_DIR = path.join(sandbox, 'claude-config');

    const typed = await runClaude(bin, project, '/sandbox-echo', env);
    if (NOT_LOGGED_IN.test(typed.out)) {
      log(`SKIPPED: Claude Code is not authenticated in the isolated config dir ("${typed.out.trim().split('\n')[0]}").`);
      log('         SkillTree does not touch your real ~/.claude or handle credentials. To run this check with your');
      log('         normal Claude Code login: SKILLTREE_E2E_REAL_CLAUDE=1 npm run e2e:live');
      return 'skipped';
    }
    log(`typed /sandbox-echo → exit ${typed.code}: ${typed.out.trim().slice(0, 120)}`);
    const invoked = await runClaude(bin, project, 'Run the sandbox echo check using the sandbox-echo skill.', env);
    log(`model-invoked prompt → exit ${invoked.code}: ${invoked.out.trim().slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, 1500)); // async hooks finish appending
    const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const { events } = parseActivityLog(text);
    for (const e of events) log(`EVENT ${JSON.stringify(e)}`);
    if (!events.length) {
      log('FAILED: no activity events were recorded.');
      return 'failed';
    }
    return 'recorded';
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
    log(`cleanup: removed ${sandbox}`);
  }
}

async function main() {
  const results: string[] = [];
  let ok = true;
  const p2 = await phase2().catch((err) => {
    log(`Phase 2 error: ${(err as Error).message}`);
    return false;
  });
  results.push(`phase2=${p2 ? 'installed' : 'FAILED'}`);
  ok &&= p2;
  log('');
  const p3 = await phase3().catch((err) => {
    log(`Phase 3 error: ${(err as Error).message}`);
    return 'failed' as const;
  });
  results.push(`phase3=${p3}`);
  ok &&= p3 !== 'failed';
  log('');
  log(`${ok ? 'E2E LIVE PASS' : 'E2E LIVE FAIL'} ${results.join('  ')}`);
  process.exit(ok ? 0 : 1);
}

void main();

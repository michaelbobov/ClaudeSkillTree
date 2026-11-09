// SkillTree activity recorder: a Claude Code command hook (bundled to a standalone .mjs).
//   node record-skill-event.mjs <log-file>
// Reads the hook payload from stdin, appends at most one JSON line to <log-file>, prints nothing and
// always exits 0, so it can never block or alter Claude Code. No prompt text or arguments are stored.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseHookInput, parseSessionEnd } from '../shared/activity';

const MAX_INPUT = 1024 * 1024;
const MAX_LOG = 10 * 1024 * 1024;

function main(): void {
  const logFile = process.argv[2];
  if (!logFile || !path.isAbsolute(logFile)) return;
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8').slice(0, MAX_INPUT);
  } catch {
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch {
    return;
  }
  // A skill use, or a session ending (so the Skill Tree's Live strip can drop it).
  const event = parseHookInput(payload, { projectDir: process.env.CLAUDE_PROJECT_DIR }) ?? parseSessionEnd(payload);
  if (!event) return;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  try {
    if (fs.statSync(logFile).size > MAX_LOG) fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    /* no log yet */
  }
  fs.appendFileSync(logFile, JSON.stringify(event) + '\n', { mode: 0o600 });
}

try {
  main();
} catch {
  /* never fail the hook */
}
process.exit(0);

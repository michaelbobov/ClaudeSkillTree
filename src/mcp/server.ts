// SkillTree MCP server (stdio, newline-delimited JSON-RPC 2.0). Bundled to dist/mcp/skilltree-mcp.mjs.
//   node skilltree-mcp.mjs <skilltree-base-dir>
// Claude Code starts it in the session's project directory. stdout carries protocol messages only;
// diagnostics go to stderr. It never executes skill content and cannot install on its own.

import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { SERVER_INSTRUCTIONS, TOOLS, installSkill, searchSkills, type ToolContext } from './tools';

const VERSION = '0.1.0';
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

type Req = { jsonrpc: '2.0'; id?: number | string | null; method: string; params?: Record<string, unknown> };

const baseArg = process.argv[2];
const ctx: ToolContext = {
  baseDir: baseArg && path.isAbsolute(baseArg) ? baseArg : path.join(process.env.SKILLTREE_HOME ?? os.homedir(), '.claude', 'skilltree'),
  homeDir: process.env.SKILLTREE_HOME ?? os.homedir(),
  projectDir: process.env.CLAUDE_PROJECT_DIR && path.isAbsolute(process.env.CLAUDE_PROJECT_DIR) ? process.env.CLAUDE_PROJECT_DIR : process.cwd(),
};

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(req: Req): Promise<unknown> {
  switch (req.method) {
    case 'initialize': {
      const asked = typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : '';
      return {
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'skilltree', version: VERSION },
        instructions: SERVER_INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const name = req.params?.name;
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      const r = name === 'search_skills' ? searchSkills(args, ctx) : name === 'install_skill' ? await installSkill(args, ctx) : { text: `Unknown tool ${String(name)}`, isError: true };
      return { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) };
    }
    default:
      throw Object.assign(new Error(`Method not found: ${req.method}`), { code: -32601 });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req: Req;
  try {
    req = JSON.parse(line) as Req;
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const isNotification = req.id === undefined;
  handle(req).then(
    (result) => {
      if (!isNotification) send({ jsonrpc: '2.0', id: req.id, result });
    },
    (err: Error & { code?: number }) => {
      if (isNotification) return; // e.g. notifications/initialized needs no answer
      send({ jsonrpc: '2.0', id: req.id, error: { code: err.code ?? -32603, message: err.message } });
    },
  );
});
rl.on('close', () => process.exit(0));
process.on('uncaughtException', (err) => process.stderr.write(`skilltree-mcp: ${err.message}\n`));

// Bundles the extension host code (and, with --tests, the integration tests) using esbuild.
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const tests = args.has('--tests');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

const configs = tests
  ? [
      {
        ...common,
        entryPoints: ['test/integration/extension.test.ts', 'test/integration/marketplace.test.ts', 'test/integration/activity.test.ts', 'test/integration/claude.test.ts', 'test/integration/projectFit.test.ts'],
        outdir: 'out/integration',
        external: ['vscode', 'mocha'],
      },
      {
        // Opt-in live suite (real Claude Code session), run by npm run e2e:vscode only.
        ...common,
        entryPoints: ['test/live/activity-live.test.ts'],
        outdir: 'out/live',
        external: ['vscode', 'mocha'],
      },
    ]
  : [
      {
        ...common,
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.js',
        minify: !watch,
      },
      {
        // UserPromptSubmit hook that suggests catalog skills (no dependencies, no VS Code API).
        ...common,
        entryPoints: ['src/recorder/suggest-skills.ts'],
        outfile: 'dist/recorder/suggest-skills.mjs',
        format: 'esm',
        external: [],
        sourcemap: false,
      },
      {
        // SkillTree MCP server for Claude Code (no dependencies, no VS Code API).
        ...common,
        entryPoints: ['src/mcp/server.ts'],
        outfile: 'dist/mcp/skilltree-mcp.mjs',
        format: 'esm',
        external: [],
        sourcemap: false,
      },
      {
        // Standalone Claude Code hook (no dependencies, no VS Code API).
        ...common,
        entryPoints: ['src/recorder/record-skill-event.ts'],
        outfile: 'dist/recorder/record-skill-event.mjs',
        format: 'esm',
        external: [],
        sourcemap: false,
      },
    ];

// Bundle the catalog snapshot(s) so the Marketplace works offline out of the box.
if (!tests) {
  fs.mkdirSync('dist', { recursive: true });
  for (const name of ['catalog.json', 'catalog.sample.json']) {
    if (fs.existsSync(`data/${name}`)) fs.copyFileSync(`data/${name}`, `dist/${name}`);
  }
}

if (watch) {
  for (const cfg of configs) {
    const ctx = await esbuild.context(cfg);
    await ctx.watch();
  }
} else {
  await Promise.all(configs.map((cfg) => esbuild.build(cfg)));
}

// Builds a SkillTreeState snapshot for the preview harness using the real scanner.
// Usage (bundled by preview.mjs): node dump-state.cjs <homeDir> <workspaceDir|-> <out.json>
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanAll, standardRoots } from '../../src/core/scanner';
import { organizeSkills } from '../../src/core/organize';
import { availableFor, matchOrigins, recommendFromUsage } from '../../src/shared/recommend';
import { profileProject, profileSummary, recommendForProject } from '../../src/shared/projectFit';
import { scanProject } from '../../src/core/projectScan';
import { splitFrontmatter } from '../../src/core/frontmatter';
import { githubRawProvider, gitBlobSha } from '../../src/core/installer';
import { installStateFor, validateCatalog } from '../../src/shared/catalog';
import type { MarketplaceState } from '../../src/shared/marketplace';
import { groupBySession, parseActivityLog, parseHookInput, summarizeUsage, workspaceUsage, type ActivityEvent, type ActivityViewState } from '../../src/shared/activity';

async function main() {
  const [homeDir, workspaceDir, outFile] = process.argv.slice(2);
  const folders = workspaceDir && workspaceDir !== '-' ? [{ name: path.basename(workspaceDir), path: workspaceDir }] : [];
  const roots = standardRoots({ homeDir, workspaceFolders: folders });
  const result = await scanAll(roots, { homeDir });
  const skills = organizeSkills(result.skills, {});
  const bodies: Record<string, string> = {};
  for (const s of skills) {
    try {
      bodies[s.id] = splitFrontmatter(fs.readFileSync(s.file, 'utf8')).body.slice(0, 256 * 1024);
    } catch {
      bodies[s.id] = '';
    }
  }
  const state = {
    status: 'ready',
    workspaceName: folders[0]?.name ?? null,
    workspaceTrusted: true,
    skills,
    roots: result.roots,
    scannedAt: Date.now(),
    positions: {},
    collapsed: [],
  };
  // Marketplace view model from the real bundled catalog and real local provenance.
  const catalogFile = fs.existsSync('data/catalog.json') ? 'data/catalog.json' : 'data/catalog.sample.json';
  const v = validateCatalog(JSON.parse(fs.readFileSync(catalogFile, 'utf8')));
  if (!v.ok) throw new Error(`invalid catalog: ${v.errors[0]}`);
  const local = skills.map((x) => ({ id: x.id, source: x.source, dirName: x.dirName, name: x.name, installedFrom: x.installedFrom }));
  const market: MarketplaceState = {
    status: 'ready',
    origin: 'bundled',
    fetchedAt: null,
    url: null,
    catalog: { source: v.catalog.source, generatedAt: v.catalog.generatedAt, repositories: v.catalog.repositories, skippedCount: v.catalog.skipped?.length ?? 0, repositoryStats: v.catalog.repositoryStats ?? {} },
    entries: v.catalog.entries.map((e) => ({ ...e, ...(({ state, localIds }) => ({ installState: state, localIds }))(installStateFor(e, local)) })),
    projectInstallBlocked: folders.length ? null : 'Open a folder to install skills into a project.',
    claudeSuggestions: false,
    busyId: null,
  };
  // One real SKILL.md for the preview pane, fetched at the pinned commit and hash-checked.
  const previews: Record<string, string> = {};
  const previewEntry = market.entries.find((e) => e.kind === 'skill' && e.warnings.length > 0) ?? market.entries[0];
  if (previewEntry && process.env.SKILLTREE_PREVIEW_OFFLINE !== '1') {
    try {
      const f = previewEntry.files.find((x) => x.path === 'SKILL.md')!;
      const buf = await githubRawProvider(15000).readFile(previewEntry, 'SKILL.md', f.size);
      if (gitBlobSha(buf) === f.sha) previews[previewEntry.id] = buf.toString('utf8');
    } catch (err) {
      console.log(`  (preview text unavailable: ${(err as Error).message})`);
    }
  }
  // Activity: the real local state (normally "off"), plus a QA-only timeline made by running the
  // documented hook payload fixtures through the real parser. The fixture view is never shipped.
  const realLog = path.join(homeDir, '.claude', 'skilltree', 'activity.jsonl');
  const realEvents = fs.existsSync(realLog) ? parseActivityLog(fs.readFileSync(realLog, 'utf8')).events : [];
  const activityReal: ActivityViewState = { enabled: false, scope: null, settingsFile: null, logFile: realLog, installedAt: null, skippedLines: 0, sessions: groupBySession(realEvents), total: realEvents.length };
  const fx = (name: string) => JSON.parse(fs.readFileSync(`test/fixtures/hooks/${name}.json`, 'utf8'));
  const at = (iso: string) => () => new Date(iso);
  const fixtureEvents = [
    parseHookInput(fx('user-prompt-expansion'), { projectDir: '/Users/dev/Projects/example' }, at('2026-11-07T18:02:11Z')),
    parseHookInput(fx('pre-tool-use-skill'), { projectDir: '/Users/dev/Projects/example' }, at('2026-11-07T18:05:40Z')),
    parseHookInput({ ...fx('pre-tool-use-skill'), session_id: 'def456', tool_input: { skill: 'webapp-testing' } }, { projectDir: '/Users/dev/Projects/other' }, at('2026-11-07T19:10:03Z')),
    parseHookInput(fx('pre-tool-use-skill-unknown-shape'), {}, at('2026-11-07T19:12:00Z')),
  ].filter((e): e is ActivityEvent => !!e);
  const activityFixture: ActivityViewState = { enabled: true, scope: 'user', settingsFile: '/Users/dev/.claude/settings.json', logFile: '/Users/dev/.claude/skilltree/activity.jsonl', installedAt: '2026-11-07T17:58:00Z', skippedLines: 0, sessions: groupBySession(fixtureEvents), total: fixtureEvents.length };
  // QA-only Skill Tree usage: hook payloads for a few of the *local* skills, run through the real
  // parser and summarizer, timed relative to now so relative times render. Never shipped.
  const byName = new Map(skills.map((s) => [s.name, s]));
  const plan: [string, string, number][] = [
    ['frontend-design', 'qa-1', 26 * 60], ['emil-design-eng', 'qa-1', 25 * 60], ['impeccable', 'qa-1', 24 * 60],
    ['frontend-design', 'qa-2', 5 * 60], ['emil-design-eng', 'qa-2', 4 * 60 + 50],
    ['pdf', 'qa-3', 3 * 60], ['docx', 'qa-3', 2 * 60 + 55],
    ['frontend-design', 'qa-4', 38], ['animate', 'qa-4', 35], ['frontend-design', 'qa-4', 12],
  ];
  const usageEvents = plan
    .filter(([name]) => byName.has(name))
    .map(([name, session, minsAgo], i) => {
      const skill = byName.get(name)!;
      const typed = i % 4 === 3;
      const payload = typed
        ? { ...fx('user-prompt-expansion'), session_id: session, command_name: skill.command.slice(1) }
        : { ...fx('pre-tool-use-skill'), session_id: session, tool_input: { skill: skill.command.slice(1) } };
      return parseHookInput(payload, { projectDir: '/Users/dev/Projects/example' }, at(new Date(Date.now() - minsAgo * 60000).toISOString()));
    })
    .filter((e): e is ActivityEvent => !!e);
  let usageFixture = { enabled: true, since: new Date(Date.now() - 12 * 86400000).toISOString(), ...summarizeUsage(usageEvents) };
  // QA-only "several agents at once": three sessions in different projects active in the last
  // minutes, one skill used inside a subagent (payload shape from a real run). Never shipped.
  const livePlan: [string, string, string, number, string | null][] = [
    ['frontend-design', 'qa-live-1', '/Users/dev/Projects/example', 6, null],
    ['emil-design-eng', 'qa-live-1', '/Users/dev/Projects/example', 2, 'general-purpose'],
    ['pdf', 'qa-live-2', '/Users/dev/Projects/api-server', 4, null],
    ['docx', 'qa-live-2', '/Users/dev/Projects/api-server', 1, null],
    ['web-typography', 'qa-live-3', '/Users/dev/Projects/docs-site', 3, 'Explore'],
  ];
  const liveEvents = livePlan
    .filter(([name]) => byName.has(name))
    .map(([name, session, project, minsAgo, agentType]) => {
      const skill = byName.get(name)!;
      const base = agentType ? { ...fx('pre-tool-use-skill-subagent'), agent_type: agentType, agent_id: `qa-${agentType}` } : fx('pre-tool-use-skill');
      return parseHookInput({ ...base, session_id: session, cwd: project, tool_input: { skill: skill.command.slice(1) } }, { projectDir: project }, at(new Date(Date.now() - minsAgo * 60000).toISOString()));
    })
    .filter((e): e is ActivityEvent => !!e)
    .sort((a, b) => b.ts.localeCompare(a.ts));
  const liveAll = [...liveEvents, ...usageEvents];
  const liveSplit = workspaceUsage(liveAll, { workspaceDirs: ['/Users/dev/Projects/example'], projectOnlyKeys: new Set() });
  let liveFixture: Record<string, unknown> = { enabled: true, since: new Date(Date.now() - 12 * 86400000).toISOString(), ...liveSplit.all, here: liveSplit.here, recent: liveEvents };
  // SKILLTREE_LIVE_LOG: draw the Live strip from a REAL recorded log (e.g. a snapshot taken while sessions ran).
  if (process.env.SKILLTREE_LIVE_LOG) {
    const real = parseActivityLog(fs.readFileSync(process.env.SKILLTREE_LIVE_LOG, 'utf8'));
    const split = workspaceUsage(real.events, { workspaceDirs: folders.map((f) => f.path), projectOnlyKeys: new Set() });
    const first = real.events.map((e) => e.ts).sort()[0] ?? new Date().toISOString();
    liveFixture = { enabled: true, since: new Date(Date.parse(first) - 60_000).toISOString(), ...split.all, here: split.here, recent: real.events, ended: real.ended };
    console.log(`live: ${real.events.length} real events, ${Object.keys(real.ended).length} ended sessions from ${process.env.SKILLTREE_LIVE_LOG}`);
  }
  // SKILLTREE_USAGE_LOG: use a REAL recorded activity log instead of the QA fixture (marketing shots).
  const realUsageLog = process.env.SKILLTREE_USAGE_LOG;
  let realUsage: ActivityEvent[] | null = null;
  if (realUsageLog) {
    realUsage = parseActivityLog(fs.readFileSync(realUsageLog, 'utf8')).events;
    const first = realUsage.map((e) => e.ts).sort()[0];
    usageFixture = { enabled: true, since: new Date(Date.parse(first) - 60_000).toISOString(), ...summarizeUsage(realUsage) };
    console.log(`usage: ${realUsage.length} real events from ${realUsageLog}`);
  }
  // QA-only "For you": the real recommender on the real catalog and local skills, with the fixture usage above.
  const locals = skills.map((s) => {
    let skillMdSha: string | undefined;
    try {
      skillMdSha = gitBlobSha(fs.readFileSync(s.file));
    } catch {
      /* unreadable */
    }
    return { id: s.id, name: s.name, command: s.command, dirName: s.dirName, category: s.category, installedFromId: s.installedFrom?.id, skillMdSha };
  });
  const marketForYou = v.ok ? recommendFromUsage(v.catalog, locals, usageFixture, matchOrigins(v.catalog, locals)) : [];
  // "For this project": the real scanner and matcher on a real folder (this repository unless SKILLTREE_PROJECT_DIR is set).
  const projectDir = process.env.SKILLTREE_PROJECT_DIR ?? process.cwd();
  const profile = profileProject(await scanProject(projectDir));
  const projectItems = v.ok ? recommendForProject(v.catalog, profile, availableFor(locals, matchOrigins(v.catalog, locals))).map(({ id, reason }) => ({ id, reason })) : [];
  const marketForProject = projectItems.length ? { summary: profileSummary(profile), items: projectItems } : undefined;
  console.log(`for this project (${path.basename(projectDir)}): ${profileSummary(profile) || '(nothing detected)'} → ${projectItems.map((r) => r.id).join(', ') || '(none)'}`);
  const usageSelect = byName.get("frontend-design")?.id ?? null;
  const activityShown = realUsage ? { ...activityFixture, settingsFile: 'project/.claude/settings.json', logFile: '~/.claude/skilltree/activity.jsonl', installedAt: usageFixture.since, sessions: groupBySession(realUsage), total: realUsage.length } : activityFixture;
  fs.writeFileSync(outFile, JSON.stringify({ state, bodies, market, previews, previewId: previewEntry?.id ?? null, activityReal, activityFixture: activityShown, usageFixture, liveFixture, usageSelect, marketForYou, marketForProject }));
  console.log(`for you (fixture usage): ${marketForYou.map((r) => `${r.id} — ${r.reason}`).join(' | ') || '(none)'}`);
  console.log(`state: ${skills.length} skills from ${result.roots.filter((r) => r.exists).length} existing locations; catalog: ${market.entries.length} entries`);
}

void main();

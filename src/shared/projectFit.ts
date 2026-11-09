// "For this project": catalog skills that fit the open workspace, from what the workspace contains.
// Pure: no VS Code API, no I/O. The host gathers ProjectFacts (file paths and dependency names only,
// never file contents beyond manifests) and passes them in.
//
// A skill is suggested only when its own name, description or folder names a technology the
// workspace demonstrably uses, and every suggestion carries that evidence as its reason.

import type { Catalog, CatalogEntry } from './catalog';

export interface ProjectFacts {
  /** Workspace-relative paths (forward slashes) from a bounded walk. */
  files: string[];
  /** Dependency names declared by each manifest found (`manifest` is workspace-relative). */
  deps: { manifest: string; names: string[] }[];
}

export interface TechRule {
  id: string;
  label: string;
  /** Dependency names (exact) or patterns that show the workspace uses it. */
  deps?: (string | RegExp)[];
  /** Workspace-relative paths that show it (config files, manifests). One match is enough. */
  files?: RegExp[];
  /** File extensions that show it, counted only when at least `minFiles` files have one. */
  ext?: string[];
  minFiles?: number;
  /**
   * A whole language rather than a framework or tool. Many skills mention languages in passing, so a
   * language counts only when it is in the skill's name or folder, and weighs less than a framework.
   * A language known only from file extensions is dropped when it is a small minority of the code
   * (helper scripts in another language's project).
   */
  broad?: boolean;
  /** What a skill's name, description or folder must say to be about this technology. */
  mentions: RegExp;
}

// Mentions use word boundaries so "trust" is not Rust, "export" is not Expo, "rectangular" is not Angular.
export const TECH_RULES: readonly TechRule[] = [
  { id: 'typescript', broad: true, label: 'TypeScript', deps: ['typescript'], files: [/(^|\/)tsconfig(\.[\w-]+)?\.json$/], ext: ['.ts', '.tsx'], mentions: /\btypescript\b/i },
  { id: 'react', label: 'React', deps: ['react', 'react-dom'], mentions: /\breact\b(?![- ]native)/i },
  { id: 'react-native', label: 'React Native', deps: ['react-native'], mentions: /\breact[- ]native\b/i },
  { id: 'expo', label: 'Expo', deps: ['expo'], mentions: /\bexpo\b/i },
  { id: 'nextjs', label: 'Next.js', deps: ['next'], files: [/(^|\/)next\.config\.(js|mjs|cjs|ts)$/], mentions: /\bnext\.?js\b/i },
  { id: 'vue', label: 'Vue', deps: ['vue', 'nuxt'], mentions: /\bvue(\.js)?\b|\bnuxt\b/i },
  { id: 'svelte', label: 'Svelte', deps: ['svelte', '@sveltejs/kit'], mentions: /\bsvelte(kit)?\b/i },
  { id: 'angular', label: 'Angular', deps: ['@angular/core'], mentions: /\bangular\b/i },
  { id: 'tailwind', label: 'Tailwind CSS', deps: ['tailwindcss'], files: [/(^|\/)tailwind\.config\.(js|mjs|cjs|ts)$/], mentions: /\btailwind\b/i },
  { id: 'vite', label: 'Vite', deps: ['vite'], files: [/(^|\/)vite\.config\.(js|mjs|cjs|ts|mts)$/], mentions: /\bvite\b/i },
  { id: 'threejs', label: 'Three.js', deps: ['three', '@react-three/fiber'], mentions: /\bthree\.?js\b|\breact[- ]three[- ]fiber\b|\br3f\b/i },
  { id: 'framer-motion', label: 'Motion', deps: ['framer-motion', 'motion'], mentions: /\bframer[- ]motion\b|\bmotion\/react\b/i },
  { id: 'remotion', label: 'Remotion', deps: ['remotion', '@remotion/cli'], mentions: /\bremotion\b/i },
  { id: 'playwright', label: 'Playwright', deps: ['@playwright/test', 'playwright', 'pytest-playwright'], files: [/(^|\/)playwright\.config\.(js|ts|mjs)$/], mentions: /\bplaywright\b/i },
  { id: 'jest', label: 'Jest', deps: ['jest'], files: [/(^|\/)jest\.config\.(js|ts|mjs|cjs)$/], mentions: /\bjest\b/i },
  { id: 'vitest', label: 'Vitest', deps: ['vitest'], mentions: /\bvitest\b/i },
  { id: 'storybook', label: 'Storybook', deps: [/^@storybook\//, 'storybook'], mentions: /\bstorybook\b/i },
  { id: 'vscode-extension', label: 'VS Code extension', deps: ['@types/vscode', 'engines:vscode'], mentions: /\b(vs ?code|visual studio code) extensions?\b/i },
  { id: 'electron', label: 'Electron', deps: ['electron'], mentions: /\belectron\b/i },
  { id: 'python', broad: true, label: 'Python', files: [/(^|\/)(pyproject\.toml|setup\.py|Pipfile|requirements[\w.-]*\.txt)$/], ext: ['.py'], minFiles: 3, mentions: /\bpython\b/i },
  { id: 'django', label: 'Django', deps: ['django'], mentions: /\bdjango\b/i },
  { id: 'fastapi', label: 'FastAPI', deps: ['fastapi'], mentions: /\bfastapi\b/i },
  { id: 'flask', label: 'Flask', deps: ['flask'], mentions: /\bflask\b/i },
  { id: 'pandas', label: 'pandas', deps: ['pandas', 'polars'], mentions: /\bpandas\b|\bpolars\b/i },
  { id: 'pytorch', label: 'PyTorch', deps: ['torch'], mentions: /\bpytorch\b/i },
  { id: 'jupyter', label: 'Jupyter', ext: ['.ipynb'], minFiles: 1, mentions: /\bjupyter\b|\.ipynb\b/i },
  { id: 'rust', broad: true, label: 'Rust', files: [/(^|\/)Cargo\.toml$/], mentions: /\brust\b/i },
  { id: 'go', broad: true, label: 'Go', files: [/(^|\/)go\.mod$/], mentions: /\bgolang\b|\bgo (code|modules?|services?|programs?|projects?)\b/i },
  { id: 'swift', broad: true, label: 'Swift', files: [/(^|\/)Package\.swift$/, /\.xcodeproj\//], ext: ['.swift'], minFiles: 1, mentions: /\bswift(ui)?\b/i },
  { id: 'kotlin', broad: true, label: 'Kotlin', ext: ['.kt', '.kts'], minFiles: 1, mentions: /\bkotlin\b|\bjetpack compose\b/i },
  { id: 'flutter', label: 'Flutter', files: [/(^|\/)pubspec\.yaml$/], mentions: /\bflutter\b|\bdart\b/i },
  { id: 'rails', label: 'Ruby on Rails', deps: ['rails'], mentions: /\brails\b/i },
  { id: 'laravel', label: 'Laravel', deps: ['laravel/framework'], mentions: /\blaravel\b/i },
  { id: 'docker', label: 'Docker', files: [/(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/], mentions: /\bdocker(file)?\b/i },
  { id: 'kubernetes', label: 'Kubernetes', files: [/(^|\/)Chart\.yaml$/, /(^|\/)(k8s|kubernetes)\//], mentions: /\bkubernetes\b|\bk8s\b|\bhelm\b/i },
  { id: 'terraform', label: 'Terraform', ext: ['.tf'], minFiles: 1, mentions: /\bterraform\b/i },
  { id: 'github-actions', label: 'GitHub Actions', files: [/^\.github\/workflows\/[^/]+\.ya?ml$/], mentions: /\bgithub actions?\b/i },
  { id: 'supabase', label: 'Supabase', deps: ['@supabase/supabase-js', 'supabase'], files: [/(^|\/)supabase\/config\.toml$/], mentions: /\bsupabase\b/i },
  { id: 'prisma', label: 'Prisma', deps: ['prisma', '@prisma/client'], files: [/(^|\/)schema\.prisma$/], mentions: /\bprisma\b/i },
  { id: 'postgres', label: 'PostgreSQL', deps: ['pg', 'postgres', 'psycopg', 'psycopg2', 'psycopg2-binary', 'asyncpg'], mentions: /\bpostgres(ql)?\b/i },
  { id: 'stripe', label: 'Stripe', deps: ['stripe', /^@stripe\//], mentions: /\bstripe\b/i },
  { id: 'vercel', label: 'Vercel', deps: [/^@vercel\//, 'vercel'], files: [/(^|\/)vercel\.json$/], mentions: /\bvercel\b/i },
  { id: 'cloudflare', label: 'Cloudflare', deps: ['wrangler', /^@cloudflare\//], files: [/(^|\/)wrangler\.(toml|jsonc?)$/], mentions: /\bcloudflare\b/i },
  { id: 'aws', label: 'AWS', deps: [/^@aws-sdk\//, 'aws-sdk', 'boto3', 'aws-cdk-lib'], files: [/(^|\/)cdk\.json$/, /(^|\/)serverless\.ya?ml$/], mentions: /\baws\b|\bamazon web services\b/i },
  { id: 'firebase', label: 'Firebase', deps: ['firebase', 'firebase-admin'], files: [/(^|\/)firebase\.json$/], mentions: /\bfirebase\b/i },
  { id: 'mcp', label: 'MCP', deps: ['@modelcontextprotocol/sdk', 'mcp', 'fastmcp'], mentions: /\bmcp (server|client)s?\b|\bmodel context protocol\b/i },
  { id: 'claude-api', label: 'Claude API', deps: ['@anthropic-ai/sdk', 'anthropic', '@anthropic-ai/claude-agent-sdk', 'claude-agent-sdk'], mentions: /\bclaude api\b|\banthropic (sdk|api)\b|\bclaude agent sdk\b/i },
  { id: 'latex', label: 'LaTeX', ext: ['.tex'], minFiles: 1, mentions: /\blatex\b/i },
];

export interface ProjectTech {
  id: string;
  label: string;
  /** Why we think the workspace uses it, e.g. "package.json: next" or "14 .py files". */
  evidence: string;
}

export interface ProjectProfile {
  techs: ProjectTech[];
}

/** A language seen only in files is ignored below this share of the most common language's files. */
const MINORITY_SHARE = 0.2;

const depMatches =(want: string | RegExp, name: string) => (typeof want === 'string' ? want === name.toLowerCase() : want.test(name));

/** Technologies the workspace demonstrably uses, each with one piece of evidence. */
export function profileProject(facts: ProjectFacts, rules: readonly TechRule[] = TECH_RULES): ProjectProfile {
  const techs: ProjectTech[] = [];
  const extCount = (rule: TechRule) => (rule.ext ? facts.files.filter((f) => rule.ext!.some((x) => f.toLowerCase().endsWith(x))).length : 0);
  const topLanguage = Math.max(0, ...rules.filter((r) => r.broad).map(extCount));
  for (const rule of rules) {
    let evidence: string | null = null;
    for (const m of facts.deps) {
      const hit = rule.deps && m.names.find((n) => rule.deps!.some((d) => depMatches(d, n)));
      if (hit) {
        evidence = `${m.manifest}: ${hit.replace(/^engines:/, 'engines.')}`;
        break;
      }
    }
    if (!evidence && rule.files) {
      const hit = facts.files.find((f) => rule.files!.some((re) => re.test(f)));
      if (hit) evidence = hit.replace(/\/$/, '');
    }
    if (!evidence && rule.ext) {
      const n = extCount(rule);
      const minority = rule.broad && n < topLanguage * MINORITY_SHARE;
      if (n >= (rule.minFiles ?? 3) && !minority) evidence = `${n} ${rule.ext.join('/')} file${n === 1 ? '' : 's'}`;
    }
    if (evidence) techs.push({ id: rule.id, label: rule.label, evidence });
  }
  return { techs };
}

export interface ProjectRecommendation {
  id: string;
  reason: string;
  /** Technology ids the skill names (for tests and grouping). */
  techs: string[];
}

/**
 * Catalog skills that name a technology this workspace uses.
 *  - In the skill's name or folder: a framework or tool counts 3, a language 2.
 *  - In its description: a framework or tool counts 1, at most 2 in total (a description that lists
 *    every stack is a generic skill, not a better fit); languages there do not count.
 *  - A skill needs at least 2: one name match, or two technologies in its description.
 * Ties go to the more-starred repository. At most `perRepo` from one repository so a single large
 * collection does not fill the list.
 */
export function recommendForProject(
  catalog: Catalog,
  profile: ProjectProfile,
  isAvailable: (e: CatalogEntry) => boolean,
  opts: { max?: number; perRepo?: number; rules?: readonly TechRule[] } = {},
): ProjectRecommendation[] {
  if (profile.techs.length === 0) return [];
  const rules = new Map((opts.rules ?? TECH_RULES).map((r) => [r.id, r]));
  const stars = (e: CatalogEntry) => catalog.repositoryStats?.[`${e.owner}/${e.repo}`]?.stars ?? 0;
  const scored: { e: CatalogEntry; score: number; strong: ProjectTech[]; weak: ProjectTech[] }[] = [];
  for (const e of catalog.entries) {
    if (e.kind !== 'skill' || !isAvailable(e)) continue;
    const title = `${e.name} ${e.path}`.replace(/[-_/]/g, ' ');
    const strong: ProjectTech[] = [];
    const weak: ProjectTech[] = [];
    let score = 0;
    for (const t of profile.techs) {
      const rule = rules.get(t.id);
      if (!rule) continue;
      if (rule.mentions.test(title)) {
        strong.push(t);
        score += rule.broad ? 2 : 3;
      } else if (!rule.broad && rule.mentions.test(e.description)) weak.push(t);
    }
    score += Math.min(weak.length, 2);
    // One passing mention in a description is not enough to suggest a skill.
    if (score >= 2) scored.push({ e, score, strong, weak });
  }
  scored.sort((a, b) => b.score - a.score || stars(b.e) - stars(a.e) || a.e.id.localeCompare(b.e.id));

  const max = opts.max ?? 6;
  const perRepo = opts.perRepo ?? 2;
  const fromRepo = new Map<string, number>();
  const out: ProjectRecommendation[] = [];
  for (const { e, strong, weak } of scored) {
    if (out.length >= max) break;
    const repo = `${e.owner}/${e.repo}`;
    if ((fromRepo.get(repo) ?? 0) >= perRepo) continue;
    fromRepo.set(repo, (fromRepo.get(repo) ?? 0) + 1);
    const all = [...strong, ...weak];
    const where = strong.length ? 'About' : 'Mentions';
    out.push({ id: e.id, reason: `${where} ${listLabels(all)} (${evidenceLine(all)})`, techs: all.map((t) => t.id) });
  }
  return out;
}

/** "package.json: next, react · 10 .swift files", grouping dependencies by manifest. */
function evidenceLine(techs: readonly ProjectTech[]): string {
  const groups = new Map<string, string[]>();
  for (const t of techs) {
    const m = /^(.+?): (.+)$/.exec(t.evidence);
    const key = m ? m[1] : t.evidence;
    if (!groups.has(key)) groups.set(key, []);
    if (m && !groups.get(key)!.includes(m[2])) groups.get(key)!.push(m[2]);
  }
  return [...groups.entries()].map(([k, v]) => (v.length ? `${k}: ${v.join(', ')}` : k)).join(' · ');
}

function listLabels(techs: readonly ProjectTech[]): string {
  const l = techs.map((t) => t.label);
  return l.length <= 1 ? (l[0] ?? '') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`;
}

/** One line for the group header: "Next.js, Tailwind CSS and Playwright". */
export function profileSummary(profile: ProjectProfile, max = 5): string {
  const l = profile.techs.map((t) => t.label);
  if (l.length <= max) return listLabels(profile.techs);
  return `${l.slice(0, max).join(', ')} and ${l.length - max} more`;
}

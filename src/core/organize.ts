// Organization metadata (categories) is stored separately from SKILL.md and never written into it.
// When the user has not chosen a category, a keyword heuristic suggests one. The UI labels such
// categories as "auto" so a guess is never presented as the skill author's intent.

import type { Category, CategorySource, OrganizedSkill, SkillRecord } from '../shared/types';

type Rule = { category: Exclude<Category, 'Other'>; words: string[] };

// Order matters for ties: earlier rules win.
const RULES: Rule[] = [
  {
    category: 'Testing',
    words: ['test', 'tests', 'testing', 'unit test', 'e2e', 'jest', 'vitest', 'mocha', 'pytest', 'playwright test', 'coverage', 'qa', 'stress-test', 'edge cases'],
  },
  {
    category: 'Debugging',
    words: ['debug', 'debugging', 'bug', 'bugs', 'crash', 'stack trace', 'traceback', 'diagnose', 'troubleshoot', 'janky', 'drops frames', 'stutter', 'profiling', 'regression'],
  },
  {
    category: 'Security',
    words: ['security', 'secure', 'vulnerability', 'vulnerabilities', 'cve', 'pentest', 'penetration', 'red team', 'threat', 'threats', 'exploit', 'owasp', 'xss', 'csrf', 'sql injection', 'secrets', 'vault', 'encryption', 'mtls', 'tls', 'zero-trust', 'compliance', 'soc 2', 'soc2', 'gdpr', 'hipaa', 'iso 27001', 'privacy', 'ciso', 'malware', 'cmmc', 'iso 42001'],
  },
  {
    category: 'Design',
    words: ['design', 'designer', 'typography', 'typeface', 'font', 'fonts', 'color', 'colors', 'palette', 'visual', 'aesthetic', 'figma', 'brand', 'polish', 'look', 'motion', 'animation', 'animations', 'animate', 'easing', 'spacing', 'hierarchy', 'mockup', 'prototype', 'ux'],
  },
  {
    category: 'Frontend',
    words: ['frontend', 'front-end', 'react', 'next.js', 'nextjs', 'vue', 'svelte', 'angular', 'css', 'html', 'tailwind', 'component', 'components', 'browser', 'dom', 'web page', 'website', 'landing page', 'ui', 'jsx', 'tsx', 'framer motion', 'webview'],
  },
  {
    category: 'Backend',
    words: ['backend', 'back-end', 'api', 'apis', 'server', 'database', 'sql', 'postgres', 'mysql', 'sqlite', 'redis', 'endpoint', 'graphql', 'rest', 'auth', 'migration', 'microservice', 'microservices', 'queue', 'lambda', 'cloud', 'aws', 'azure', 'gcp', 'kubernetes', 'k8s', 'terraform', 'infrastructure', 'istio', 'service mesh', 'serverless', 'cqrs', 'event sourcing', 'kafka'],
  },
  {
    category: 'Data',
    words: ['data analysis', 'data science', 'data scientist', 'data quality', 'data engineering', 'data pipeline', 'data pipelines', 'tabular data', 'analyze data', 'dataset', 'datasets', 'analytics', 'csv', 'parquet', 'pandas', 'polars', 'duckdb', 'numpy', 'scipy', 'jupyter', 'notebook', 'notebooks', 'statistics', 'statistical', 'bayesian', 'machine learning', 'ml', 'deep learning', 'neural', 'pytorch', 'tensorflow', 'jax', 'model training', 'fine-tuning', 'embeddings', 'scientific', 'science', 'scientist', 'bioinformatics', 'genomics', 'genomic', 'gene', 'genes', 'protein', 'proteins', 'molecular', 'molecule', 'molecules', 'chemistry', 'chemical', 'cheminformatics', 'single-cell', 'rna', 'sequencing', 'quantum', 'simulation', 'simulations', 'physics', 'neuroscience', 'clinical', 'matplotlib', 'plot', 'plots', 'chart', 'charts', 'visualization', 'etl', 'warehouse', 'dbt', 'geospatial', 'gis', 'papers', 'arxiv', 'pubmed', 'computer vision'],
  },
  {
    category: 'Automation',
    words: ['automate', 'automation', 'automated', 'workflow', 'pipeline', 'ci', 'cron', 'schedule', 'scheduled', 'recurring', 'deploy', 'deployment', 'release', 'script', 'scripts', 'computer use', 'desktop app'],
  },
  {
    category: 'Agents',
    words: ['agent', 'agents', 'subagent', 'subagents', 'sub-agent', 'multi-agent', 'claude code', 'claude.md', 'agents.md', 'mcp', 'llm', 'llms', 'prompt', 'prompts', 'prompting', 'system prompt', 'context window', 'harness', 'opencode', 'codex', 'agent memory', 'persistent memory', 'knowledge base', 'wiki', 'second brain', 'obsidian', 'orchestrate', 'orchestration', 'autonomous'],
  },
  {
    category: 'Documentation',
    words: ['documentation', 'docs', 'document', 'documents', 'readme', 'copy', 'copywriting', 'writing', 'write', 'prose', 'proofread', 'edit', 'editing', 'report', 'pdf', 'docx', 'word', 'markdown', 'spreadsheet', 'xlsx', 'slides', 'pptx', 'presentation', 'memo', 'glossary', 'notes'],
  },
  {
    category: 'Business',
    words: ['business', 'marketing', 'market', 'seo', 'aso', 'sales', 'pricing', 'customer', 'customers', 'churn', 'growth', 'revenue', 'startup', 'founder', 'founders', 'ceo', 'cfo', 'cmo', 'c-suite', 'c-level', 'board', 'investor', 'investors', 'fundraising', 'finance', 'financial', 'budget', 'accounting', 'okr', 'okrs', 'kpi', 'kpis', 'product manager', 'product management', 'roadmap', 'go-to-market', 'gtm', 'launch', 'campaign', 'campaigns', 'social media', 'linkedin', 'twitter', 'instagram', 'tiktok', 'youtube', 'newsletter', 'conversion', 'cro', 'legal', 'contract', 'contracts', 'hiring', 'recruiting', 'stakeholder', 'stakeholders', 'strategy', 'competitor', 'competitors', 'saas', 'b2b', 'ecommerce', 'e-commerce', 'invoice', 'invoices', 'stock', 'valuation', 'rfp', 'procurement', 'regulatory', 'fda', 'sprint', 'scrum', 'jira', 'confluence', 'project management', 'meeting', 'meetings', 'email', 'inbox', 'productivity', 'career', 'executive', 'advisor', 'mentor', 'coach', 'advertising', 'ads', 'deal', 'deals', 'medical device', 'qms'],
  },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COMPILED = RULES.map((r) => ({
  category: r.category,
  patterns: r.words.map((w) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(w)}($|[^a-z0-9])`, 'i')),
}));

/** Folder and repository words that only say "skills live here" (".agents/skills", "claude-skills"). */
const CONTAINER_WORDS = new Set(['skills', 'skill', 'plugins', 'plugin', 'packages', 'package', 'src', 'examples', 'example', 'catalog', 'bundled', 'optional', 'shared', 'container', 'claude', 'agents', 'agent', 'ai', 'awesome', 'misc', 'team']);

/** Folder or repository names as matchable text, hyphenated and spaced ("c-level-advisor c level advisor"). */
function placeText(segments: string[]): string {
  return segments
    .map((p) => p.replace(/^\./, '').toLowerCase().replace(/(?<=[a-z])(skills?|agents?)$/, ''))
    .map((p) => p.split(/[-_ ]+/).filter((w) => w && !CONTAINER_WORDS.has(w)))
    .filter((words) => words.length > 0)
    .map((words) => `${words.join('-')} ${words.join(' ')}`)
    .join(' / ');
}

export interface CategoryContext {
  /** The skill's folder inside its repository, e.g. "marketing-skill/skills/seo-audit". */
  path?: string;
  /** "owner/repo". */
  repository?: string;
}

/**
 * Suggests a category from the skill's name and description and, for catalog skills, the folders
 * and repository it lives in (e.g. "marketing-skill/skills/…" or "scientific-agent-skills").
 * Weights: name 3, folders 2, description 1, repository 1. Returns "Other" when nothing matches.
 */
export function inferCategory(name: string, description: string, context: CategoryContext = {}): Category {
  const nameText = name.replace(/[-_]/g, ' ').toLowerCase();
  // Only the first ~300 characters: long descriptions mention many unrelated things.
  const descText = description.slice(0, 300).toLowerCase();
  // The folders above the skill's own folder (its own folder usually repeats the name).
  const folders = (context.path ?? '').split('/').filter(Boolean).slice(0, -1);
  const folderText = placeText(folders);
  const repoText = placeText((context.repository ?? '').split('/').slice(1));
  let best: { category: Category; score: number } = { category: 'Other', score: 0 };
  for (const rule of COMPILED) {
    let score = 0;
    for (const re of rule.patterns) {
      if (re.test(nameText)) score += 3;
      if (folderText && re.test(folderText)) score += 2;
      if (re.test(descText)) score += 1;
      if (repoText && re.test(repoText)) score += 1;
    }
    if (score > best.score) best = { category: rule.category, score };
  }
  return best.category;
}

export function organizeSkills(skills: SkillRecord[], userCategories: Record<string, Category>): OrganizedSkill[] {
  return skills.map((s) => {
    let category: Category;
    let categorySource: CategorySource;
    const chosen = userCategories[s.id];
    if (chosen) {
      category = chosen;
      categorySource = 'user';
    } else if (s.frontmatterCategory) {
      category = s.frontmatterCategory;
      categorySource = 'frontmatter';
    } else {
      category = inferCategory(s.name, s.description);
      categorySource = category === 'Other' ? 'default' : 'inferred';
    }
    return { ...s, category, categorySource };
  });
}

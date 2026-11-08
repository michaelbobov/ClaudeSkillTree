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
    category: 'Design',
    words: ['design', 'designer', 'typography', 'typeface', 'font', 'fonts', 'color', 'colors', 'palette', 'visual', 'aesthetic', 'figma', 'brand', 'polish', 'look', 'motion', 'animation', 'animations', 'animate', 'easing', 'spacing', 'hierarchy', 'mockup', 'prototype', 'ux'],
  },
  {
    category: 'Frontend',
    words: ['frontend', 'front-end', 'react', 'next.js', 'nextjs', 'vue', 'svelte', 'angular', 'css', 'html', 'tailwind', 'component', 'components', 'browser', 'dom', 'web page', 'website', 'landing page', 'ui', 'jsx', 'tsx', 'framer motion', 'webview'],
  },
  {
    category: 'Backend',
    words: ['backend', 'back-end', 'api', 'apis', 'server', 'database', 'sql', 'postgres', 'mysql', 'sqlite', 'redis', 'endpoint', 'graphql', 'rest', 'auth', 'migration', 'microservice', 'queue', 'lambda'],
  },
  {
    category: 'Automation',
    words: ['automate', 'automation', 'automated', 'workflow', 'pipeline', 'ci', 'cron', 'schedule', 'scheduled', 'recurring', 'deploy', 'deployment', 'release', 'script', 'scripts', 'computer use', 'desktop app'],
  },
  {
    category: 'Documentation',
    words: ['documentation', 'docs', 'document', 'documents', 'readme', 'copy', 'copywriting', 'writing', 'write', 'prose', 'proofread', 'edit', 'editing', 'report', 'pdf', 'docx', 'word', 'markdown', 'spreadsheet', 'xlsx', 'slides', 'pptx', 'presentation', 'memo', 'glossary', 'notes'],
  },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COMPILED = RULES.map((r) => ({
  category: r.category,
  patterns: r.words.map((w) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(w)}($|[^a-z0-9])`, 'i')),
}));

/** Suggests a category from the skill's name and description. Returns "Other" when nothing matches. */
export function inferCategory(name: string, description: string): Category {
  const nameText = name.replace(/[-_]/g, ' ').toLowerCase();
  // Only the first ~300 characters: long descriptions mention many unrelated things.
  const descText = description.slice(0, 300).toLowerCase();
  let best: { category: Category; score: number } = { category: 'Other', score: 0 };
  for (const rule of COMPILED) {
    let score = 0;
    for (const re of rule.patterns) {
      if (re.test(nameText)) score += 3;
      if (re.test(descText)) score += 1;
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

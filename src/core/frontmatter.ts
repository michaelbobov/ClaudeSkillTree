// Safe SKILL.md parsing. Pure: no filesystem or VS Code access, so it is unit-testable.
//
// Rules follow https://code.claude.com/docs/en/skills:
// - The opening `---` must be the file's first line.
// - All fields are optional; `name` defaults to the directory name.
// - If `description` is omitted, the first non-empty line of the body is used.
// - Unrecognized fields are ignored.
// - Names containing control, zero-width, bidi, private-use characters or `<`/`>` are refused by Claude Code.

import { parseDocument } from 'yaml';
import { CATEGORIES, isCategory, type Category, type FrontmatterField, type SkillIssue } from '../shared/types';

export interface ParsedSkill {
  /** Parsed frontmatter mapping, or null when absent/invalid. */
  frontmatter: Record<string, unknown> | null;
  /** Markdown body (everything after the frontmatter, or the whole file). */
  body: string;
  name: string;
  description: string;
  descriptionSource: 'frontmatter' | 'body' | 'none';
  fields: FrontmatterField[];
  issues: SkillIssue[];
  declaresHooks: boolean;
  frontmatterCategory?: Category;
}

/** Combined description + when_to_use is truncated at this length in Claude Code's skill listing. */
export const LISTING_DESCRIPTION_LIMIT = 1536;

// Characters Claude Code refuses in skill names (code point ranges, inclusive).
const FORBIDDEN_RANGES: [number, number][] = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL + C1 controls
  [0x00a0, 0x00a0], // no-break space
  [0x1680, 0x1680], // ogham space
  [0x2000, 0x200f], // unusual spaces, zero-width, LRM/RLM
  [0x2028, 0x202f], // line/paragraph separators, bidi embedding, narrow nbsp
  [0x205f, 0x206f], // math space, word joiner, invisible operators, bidi isolates
  [0x3000, 0x3000], // ideographic space
  [0xe000, 0xf8ff], // private use area
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
  [0xf0000, 0x10ffff], // supplementary private use areas
];

/** Keys shown first in the inspector, in this order. Others follow alphabetically. */
const KNOWN_FIELD_ORDER = [
  'name',
  'description',
  'when_to_use',
  'argument-hint',
  'arguments',
  'disable-model-invocation',
  'user-invocable',
  'allowed-tools',
  'disallowed-tools',
  'model',
  'effort',
  'context',
  'agent',
  'background',
  'paths',
  'shell',
  'hooks',
  'license',
  'compatibility',
  'metadata',
];

export function hasForbiddenNameChars(name: string): boolean {
  for (const ch of name) {
    if (ch === '<' || ch === '>') return true;
    const cp = ch.codePointAt(0) ?? 0;
    if (FORBIDDEN_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) return true;
  }
  return false;
}

/** Splits a SKILL.md into raw frontmatter text and body. */
export function splitFrontmatter(text: string): {
  raw: string | null;
  body: string;
  issue?: SkillIssue;
} {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLineEnd = src.indexOf('\n');
  const firstLine = (firstLineEnd === -1 ? src : src.slice(0, firstLineEnd)).replace(/\r$/, '');

  if (firstLine.trimEnd() !== '---') {
    // Detect frontmatter that does not start on line 1 so we can explain why it is ignored.
    const leading = src.match(/^(?:[ \t]*\r?\n)+---[ \t]*\r?\n/);
    if (leading) {
      return {
        raw: null,
        body: src,
        issue: {
          level: 'warning',
          message: 'Frontmatter is ignored because the opening "---" is not on the first line.',
        },
      };
    }
    return { raw: null, body: src };
  }

  const rest = firstLineEnd === -1 ? '' : src.slice(firstLineEnd + 1);
  // Closing delimiter: a line that is exactly `---` (or YAML's `...`).
  const closing = /^(?:---|\.\.\.)[ \t]*\r?$/m.exec(rest);
  if (!closing) {
    return {
      raw: null,
      body: src,
      issue: { level: 'error', message: 'Frontmatter is not closed: no terminating "---" line was found.' },
    };
  }
  const raw = rest.slice(0, closing.index);
  let bodyStart = closing.index + closing[0].length;
  if (rest[bodyStart] === '\n') bodyStart += 1;
  return { raw, body: rest.slice(bodyStart) };
}

function firstBodyLine(body: string): string | null {
  let inFence = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line === '') continue;
    // Use the line as text; strip Markdown heading/quote/list markers for display.
    const cleaned = line.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+)/, '').trim();
    if (cleaned) return cleaned;
  }
  return null;
}

function displayValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== 'object' || x === null)) return v.map((x) => String(x)).join(', ');
  } else if (typeof v === 'object') {
    // Flat mappings (e.g. metadata: {author, version}) read better as "key: value" pairs.
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length > 0 && entries.every(([, x]) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) {
      const text = entries.map(([k, x]) => `${k}: ${String(x)}`).join(', ');
      return text.length > 400 ? `${text.slice(0, 400)}…` : text;
    }
  }
  try {
    const json = JSON.stringify(v);
    return json.length > 400 ? `${json.slice(0, 400)}…` : json;
  } catch {
    return '[unrepresentable value]';
  }
}

/**
 * Parses SKILL.md text. Never throws for malformed input; problems are reported as issues.
 * @param dirName the skill's directory name (default name).
 */
export function parseSkillMarkdown(text: string, dirName: string): ParsedSkill {
  const issues: SkillIssue[] = [];
  const split = splitFrontmatter(text);
  if (split.issue) issues.push(split.issue);

  let frontmatter: Record<string, unknown> | null = null;
  if (split.raw !== null) {
    if (split.raw.trim() === '') {
      frontmatter = {};
    } else {
      try {
        // `yaml` never executes code. Limit alias expansion to avoid "billion laughs" style input.
        const doc = parseDocument(split.raw, { prettyErrors: true, uniqueKeys: false, strict: false });
        if (doc.errors.length > 0) {
          const first = doc.errors[0];
          issues.push({
            level: 'error',
            message: `Invalid YAML frontmatter: ${first.message.split('\n')[0]}`,
          });
        } else {
          const value = doc.toJS({ maxAliasCount: 100 }) as unknown;
          if (value === null || value === undefined) {
            frontmatter = {};
          } else if (typeof value === 'object' && !Array.isArray(value)) {
            frontmatter = value as Record<string, unknown>;
          } else {
            issues.push({ level: 'error', message: 'Frontmatter must be a YAML mapping of key: value pairs.' });
          }
        }
      } catch (err) {
        issues.push({
          level: 'error',
          message: `Invalid YAML frontmatter: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
        });
      }
    }
  } else if (!split.issue) {
    issues.push({ level: 'info', message: 'No frontmatter. Name comes from the folder name.' });
  }

  const fm = frontmatter ?? {};
  const body = split.body;

  // Name
  let name = dirName;
  const rawName = fm.name;
  if (rawName !== undefined && rawName !== null) {
    if (typeof rawName === 'string' && rawName.trim() !== '') {
      name = rawName.trim();
    } else {
      issues.push({ level: 'warning', message: '"name" is not a non-empty string; using the folder name.' });
    }
  }
  if (hasForbiddenNameChars(name)) {
    issues.push({
      level: 'error',
      message: 'Name contains characters Claude Code refuses (control, zero-width, bidi, private-use, or < >).',
    });
  }

  // Description
  let description = '';
  let descriptionSource: ParsedSkill['descriptionSource'] = 'none';
  if (typeof fm.description === 'string' && fm.description.trim() !== '') {
    description = fm.description.trim();
    descriptionSource = 'frontmatter';
  } else {
    if (fm.description !== undefined && fm.description !== null && typeof fm.description !== 'string') {
      issues.push({ level: 'warning', message: '"description" is not a string.' });
    }
    const line = firstBodyLine(body);
    if (line) {
      description = line;
      descriptionSource = 'body';
      issues.push({
        level: 'info',
        message: 'No description in frontmatter; Claude Code uses the first line of the body.',
      });
    } else {
      issues.push({
        level: 'warning',
        message: 'No description. Claude has nothing to decide when to use this skill.',
      });
    }
  }

  const whenToUse = typeof fm.when_to_use === 'string' ? fm.when_to_use : '';
  if (description.length + whenToUse.length > LISTING_DESCRIPTION_LIMIT) {
    issues.push({
      level: 'info',
      message: `Description + when_to_use exceed ${LISTING_DESCRIPTION_LIMIT} characters and are truncated in Claude Code's skill listing.`,
    });
  }

  // Category hint (non-standard, but honoured if present and valid).
  let frontmatterCategory: Category | undefined;
  const meta = fm.metadata;
  const catCandidate =
    fm.category ??
    (meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>).category : undefined);
  if (typeof catCandidate === 'string') {
    const normalized = catCandidate.trim().toLowerCase();
    const match = CATEGORIES.find((c) => c.toLowerCase() === normalized);
    if (isCategory(match)) frontmatterCategory = match;
  }

  const declaresHooks = fm.hooks !== undefined && fm.hooks !== null && fm.hooks !== false;

  // Fields for display. Skip description (shown separately) and name.
  const keys = Object.keys(fm).filter((k) => k !== 'description' && k !== 'name');
  keys.sort((a, b) => {
    const ia = KNOWN_FIELD_ORDER.indexOf(a);
    const ib = KNOWN_FIELD_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return a.localeCompare(b);
  });
  const fields = keys.slice(0, 40).map((key) => ({ key, value: displayValue(fm[key]) }));

  return {
    frontmatter,
    body,
    name,
    description,
    descriptionSource,
    fields,
    issues,
    declaresHooks,
    frontmatterCategory,
  };
}

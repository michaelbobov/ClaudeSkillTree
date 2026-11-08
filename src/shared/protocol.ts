// Typed message contract between the extension host and the Skill Tree webview.
// The webview never touches the filesystem; it asks the host by skill id.

import { parseNavTarget, type NavTarget } from './nav';
import { CATEGORIES, type Category, type NodePosition, type SkillTreeState } from './types';

export type HostToWebview =
  | { type: 'state'; state: SkillTreeState }
  | { type: 'skillBody'; id: string; markdown: string; truncated: boolean; error?: string }
  | { type: 'select'; id: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'rescan' }
  | { type: 'openSkill'; id: string }
  | { type: 'revealSkill'; id: string }
  | { type: 'copyPath'; id: string }
  | { type: 'getSkillBody'; id: string }
  | { type: 'setCategory'; id: string; category: Category | null }
  | { type: 'savePositions'; positions: Record<string, NodePosition> }
  | { type: 'resetLayout' }
  | { type: 'setCollapsed'; categories: Category[] }
  | { type: 'openLink'; id: string; href: string }
  | { type: 'createSkill' }
  /** Runs the consent flow (the host shows the explanation and asks); the webview never edits settings. */
  | { type: 'enableTracking' }
  | { type: 'openActivity' }
  | { type: 'navigate'; to: NavTarget };

const MAX_ID = 1024;
const MAX_HREF = 2048;
const MAX_POSITIONS = 2000;

function isStr(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function isPosition(v: unknown): v is NodePosition {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.x === 'number' &&
    typeof p.y === 'number' &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    Math.abs(p.x) < 1e6 &&
    Math.abs(p.y) < 1e6
  );
}

/**
 * Validates an untrusted message coming from the webview.
 * Returns null for anything malformed so the host can ignore it.
 */
export function parseWebviewMessage(raw: unknown): WebviewToHost | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
    case 'rescan':
    case 'resetLayout':
    case 'createSkill':
    case 'enableTracking':
    case 'openActivity':
      return { type: m.type };
    case 'navigate': {
      const to = parseNavTarget(m.to);
      return to ? { type: 'navigate', to } : null;
    }
    case 'openSkill':
    case 'revealSkill':
    case 'copyPath':
    case 'getSkillBody':
      return isStr(m.id, MAX_ID) ? { type: m.type, id: m.id } : null;
    case 'setCategory':
      if (!isStr(m.id, MAX_ID)) return null;
      if (m.category === null) return { type: 'setCategory', id: m.id, category: null };
      return (CATEGORIES as readonly unknown[]).includes(m.category)
        ? { type: 'setCategory', id: m.id, category: m.category as Category }
        : null;
    case 'savePositions': {
      if (typeof m.positions !== 'object' || m.positions === null) return null;
      const entries = Object.entries(m.positions as Record<string, unknown>);
      if (entries.length > MAX_POSITIONS) return null;
      const positions: Record<string, NodePosition> = {};
      for (const [k, v] of entries) {
        if (!isStr(k, MAX_ID) || !isPosition(v)) return null;
        positions[k] = { x: Math.round(v.x), y: Math.round(v.y) };
      }
      return { type: 'savePositions', positions };
    }
    case 'setCollapsed': {
      if (!Array.isArray(m.categories)) return null;
      const cats = m.categories.filter((c): c is Category => (CATEGORIES as readonly unknown[]).includes(c));
      return { type: 'setCollapsed', categories: [...new Set(cats)] };
    }
    case 'openLink':
      return isStr(m.id, MAX_ID) && isStr(m.href, MAX_HREF) ? { type: 'openLink', id: m.id, href: m.href } : null;
    default:
      return null;
  }
}

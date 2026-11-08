// The three SkillTree editors behave like sections of one app: each page header links to the others.

export type NavTarget = 'tree' | 'marketplace' | 'activity';

export const NAV_COMMANDS: Record<NavTarget, string> = {
  tree: 'skilltree.openGraph',
  marketplace: 'skilltree.openMarketplace',
  activity: 'skilltree.openActivity',
};

export function parseNavTarget(v: unknown): NavTarget | null {
  return v === 'tree' || v === 'marketplace' || v === 'activity' ? v : null;
}

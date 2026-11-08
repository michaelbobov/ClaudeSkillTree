// Splits raw SKILL.md text into its frontmatter block (shown verbatim) and Markdown body.
export function splitFrontmatterText(text: string): { frontmatter: string | null; body: string } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { frontmatter: null, body: src };
  return { frontmatter: m[1], body: src.slice(m[0].length) };
}

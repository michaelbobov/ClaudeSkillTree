// Safe Markdown rendering for SKILL.md previews.
// - Raw HTML in the source is escaped (html: false), so skill files cannot inject markup or scripts.
// - Images are not loaded (CSP would block remote ones anyway); they render as a text placeholder.
// - Links are intercepted by the caller and routed through the extension host.
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });

md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx];
  const alt = md.utils.escapeHtml(String(token.content || token.attrGet('alt') || 'image'));
  return `<span class="md-image" title="Images are not loaded in the preview">[image: ${alt}]</span>`;
};

const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('data-skill-link', '1');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}

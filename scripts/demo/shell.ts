/// <reference lib="dom" />
// SkillTree's web demo: the parent page around three tabs of the real interface. It plays the
// extension host's part (answers each tab's messages) and replays recorded skill use, so counts tick
// up in the Skill Tree and rows appear in Activity as each recorded use is played back.
// Data comes from scripts/demo/build-demo.mjs: the author's scanned skills, the bundled catalog and
// the events SkillTree's hooks recorded in real Claude Code sessions (times shifted to "now").
import { groupBySession, summarizeUsage, type ActivityEvent } from '../../src/shared/activity';

type Tab = 'tree' | 'marketplace' | 'activity';
type Entry = { id: string; owner: string; repo: string; path: string; commitSha: string; sourceUrl: string; name: string };
type Demo = { state: Record<string, unknown>; market: { entries: Entry[] } & Record<string, unknown>; events: ActivityEvent[] };

const D = (window as unknown as { __DEMO__: Demo }).__DEMO__;
const frames: Record<Tab, HTMLIFrameElement> = {
  tree: document.getElementById('f-tree') as HTMLIFrameElement,
  marketplace: document.getElementById('f-marketplace') as HTMLIFrameElement,
  activity: document.getElementById('f-activity') as HTMLIFrameElement,
};
const pageTab: Record<string, Tab> = { graph: 'tree', marketplace: 'marketplace', activity: 'activity' };
const caption = document.getElementById('now') as HTMLElement;

let played: ActivityEvent[] = [];
let since = new Date().toISOString();
let captionText = 'Starting the replay…';
let toastTimer: number | undefined;

const treeState = () => ({ ...D.state, activity: { enabled: true, since, ...summarizeUsage(played) } });
const activityState = () => ({
  enabled: true,
  scope: 'project',
  settingsFile: '.claude/settings.local.json',
  logFile: '~/.claude/skilltree/activity.jsonl',
  installedAt: since,
  skippedLines: 0,
  sessions: groupBySession(played),
  total: played.length,
});
const send = (tab: Tab, msg: unknown) => frames[tab].contentWindow?.postMessage(msg, '*');
const push = () => {
  send('tree', { type: 'state', state: treeState() });
  send('activity', { type: 'state', state: activityState() });
};

/** Shows one tab. Marketplace and Activity load on first visit; each asks for its state when ready. */
function show(tab: Tab): void {
  const f = frames[tab];
  if (!f.getAttribute('src') && f.dataset.src) f.setAttribute('src', f.dataset.src);
  for (const [t, x] of Object.entries(frames)) x.hidden = t !== tab;
  // The page around the demo (if any) keeps its own tab buttons in step.
  if (window.parent !== window) window.parent.postMessage({ demo: 'tab', tab }, '*');
}

function setCaption(text: string): void {
  captionText = text;
  if (!toastTimer) caption.textContent = text;
}

/** A short note for things that only work inside VS Code; then the replay caption returns. */
function toast(text: string): void {
  caption.textContent = text;
  caption.classList.add('is-note');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastTimer = undefined;
    caption.classList.remove('is-note');
    caption.textContent = captionText;
  }, 3200);
}

const IN_VS_CODE = 'This works inside VS Code. Download SkillTree to try it on your own skills.';

async function preview(id: string): Promise<void> {
  const e = D.market.entries.find((x) => x.id === id);
  if (!e) return;
  const url = `https://raw.githubusercontent.com/${e.owner}/${e.repo}/${e.commitSha}/${e.path ? `${e.path}/` : ''}SKILL.md`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    send('marketplace', { type: 'preview', id, status: 'ready', text: await r.text() });
  } catch {
    send('marketplace', { type: 'preview', id, status: 'error', text: '', error: 'The preview could not be loaded from GitHub just now.' });
  }
}

window.addEventListener('message', (ev: MessageEvent) => {
  // From the page around the demo: switch tabs.
  if (ev.source === window.parent && window.parent !== window) {
    const go = ev.data as { demo?: string; tab?: string };
    if (go?.demo === 'go' && go.tab && go.tab in frames) show(go.tab as Tab);
    return;
  }
  // From one of the three tabs: the webview's own messages, answered as the extension host would.
  const d = ev.data as { demo?: string; page?: string; m?: { type: string; [k: string]: unknown } };
  if (!d || d.demo !== 'msg' || !d.m || !d.page) return;
  const tab = pageTab[d.page];
  if (!tab || ev.source !== frames[tab].contentWindow) return;
  const m = d.m;
  if (m.type === 'navigate') return show(m.to === 'tree' ? 'tree' : (m.to as Tab));
  if (tab === 'tree') {
    if (m.type === 'demoWheel') {
      if (window.parent !== window) window.parent.postMessage({ demo: 'wheel', dy: Number(m.dy) || 0 }, '*');
      return;
    }
    if (m.type === 'ready' || m.type === 'rescan') return send('tree', { type: 'state', state: treeState() });
    if (m.type === 'getSkillBody') return send('tree', { type: 'skillBody', id: m.id, markdown: '_The SKILL.md preview opens inside VS Code._', truncated: false });
    if (m.type === 'openActivity') return show('activity');
    if (['openSkill', 'revealSkill', 'copyPath', 'createSkill', 'openLink', 'enableTracking'].includes(m.type)) return toast(IN_VS_CODE);
    return;
  }
  if (tab === 'marketplace') {
    if (m.type === 'ready' || m.type === 'refresh') return send('marketplace', { type: 'state', state: D.market });
    if (m.type === 'preview') return void preview(String(m.id));
    if (m.type === 'openSource') {
      const e = D.market.entries.find((x) => x.id === m.id);
      if (e) window.open(e.sourceUrl, '_blank', 'noopener');
      return;
    }
    if (['install', 'openInstalled', 'enableClaude'].includes(m.type)) return toast(IN_VS_CODE);
    return;
  }
  if (tab === 'activity') {
    if (m.type === 'ready' || m.type === 'refresh') return send('activity', { type: 'state', state: activityState() });
    if (['enable', 'disable', 'clearLog', 'openSettings'].includes(m.type)) return toast(IN_VS_CODE);
  }
});

// index.html#marketplace or #activity opens on that tab.
const first = location.hash.slice(1);
show(first in frames ? (first as Tab) : 'tree');

// The replay: one recorded use every few seconds, in the order they happened, then a pause and again.
const ordered = [...D.events].sort((a, b) => a.ts.localeCompare(b.ts));
const sessions = new Set(ordered.map((e) => e.sessionId)).size;
let next = 0;
function step(): void {
  if (next === 0) {
    played = [];
    since = new Date().toISOString();
  }
  const e = ordered[next];
  const ts = new Date().toISOString();
  played = [{ ...e, ts }, ...played];
  push();
  const what = e.source === 'UserPromptExpansion' ? `/${e.skill} typed` : `Claude used ${e.skill}`;
  setCaption(`Replaying ${sessions} recorded Claude Code sessions · ${new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}  ${what}`);
  next = (next + 1) % ordered.length;
  window.setTimeout(step, next === 0 ? 9000 : 2400);
}
window.setTimeout(step, 1800);

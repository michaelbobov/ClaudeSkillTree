// Preview harness bootstrap: stands in for the VS Code webview host.
// Scenario options come from the URL query: theme=dark|light|hc, view=graph|list, sel=<id> (saved
// selection), select=<id> (host "select" message), q=<query>, empty=1, usage=1 (QA usage fixture), live=1 (QA: several sessions active now, one subagent), order=name|recent|most.
// Later phases: add handlers to HANDLERS for new message types (catalog, install, activity…), and
// put their data in window.__DATA__ (written by preview.mjs).
(function () {
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme') || 'dark';
  const cls = theme === 'light' ? 'vscode-light' : theme === 'hc' ? 'vscode-high-contrast' : 'vscode-dark';
  // VS Code puts theme variables on <html> and the theme class on <body>.
  document.documentElement.className = cls;
  document.body.className = cls;
  const d = window.__DATA__;
  if (params.get('empty')) {
    d.state.skills = [];
    d.state.roots.forEach((r) => (r.skillCount = 0));
  }
  const reply = (m) => window.postMessage(m, '*');
  const page = params.get('page') || 'graph';
  document.getElementById('root').dataset.page = page;
  const MARKET_HANDLERS = {
    ready() {
      let state = params.get('foryou') ? { ...d.market, forYou: d.marketForYou } : d.market;
      if (params.get('project')) state = { ...state, forProject: d.marketForProject };
      reply({ type: 'state', state });
    },
    preview(m) {
      const text = d.previews[m.id];
      reply(text ? { type: 'preview', id: m.id, status: 'ready', text } : { type: 'preview', id: m.id, status: 'error', text: '', error: 'Preview text not captured by the harness.' });
    },
  };
  const GRAPH_HANDLERS = {
    ready() {
      reply({ type: 'state', state: params.get('live') ? { ...d.state, activity: d.liveFixture } : params.get('usage') ? { ...d.state, activity: d.usageFixture } : d.state });
      if (params.get('select')) setTimeout(() => reply({ type: 'select', id: params.get('select') }), 100);
    },
    getSkillBody(m) {
      reply({ type: 'skillBody', id: m.id, markdown: d.bodies[m.id] ?? '', truncated: false });
    },
  };
  const ACTIVITY_HANDLERS = {
    ready() {
      reply({ type: 'state', state: params.get('fixture') ? d.activityFixture : d.activityReal });
    },
  };
  const HANDLERS = page === 'marketplace' ? MARKET_HANDLERS : page === 'activity' ? ACTIVITY_HANDLERS : GRAPH_HANDLERS;
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => HANDLERS[m.type] && HANDLERS[m.type](m),
    getState: () =>
      params.get('view') || params.get('sel') || params.get('q') || params.get('order')
        ? { query: params.get('q') || '', source: 'all', category: 'all', view: params.get('view') || 'graph', selectedId: params.get('sel'), order: params.get('order') || 'name' }
        : undefined,
    setState: () => {},
  });
})();

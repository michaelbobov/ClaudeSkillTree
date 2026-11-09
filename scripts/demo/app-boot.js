// Runs inside each demo tab (an iframe showing the real SkillTree webview). It stands in for VS Code's
// webview API: every message the interface sends goes to the demo shell (the parent page), and the
// shell answers by posting messages back into this frame, exactly as the extension host would.
(function () {
  const page = location.hash.slice(1) || 'graph';
  document.documentElement.className = 'vscode-dark';
  document.body.className = 'vscode-dark';
  document.getElementById('root').dataset.page = page;
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => parent.postMessage({ demo: 'msg', page, m }, '*'),
    getState: () => (page === 'graph' ? { query: '', source: 'all', category: 'all', view: 'graph', selectedId: null, order: 'name' } : undefined),
    setState: () => {},
  });
  // On a web page the mouse wheel should scroll the page, not pan the map (VS Code pans on scroll).
  // Plain wheel events over the graph are passed up to the page; dragging still moves the map and
  // pinch or Ctrl+wheel still zooms it. Lists and the details panel scroll as usual.
  if (page === 'graph') {
    window.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || !(e.target instanceof Element) || !e.target.closest('.react-flow')) return;
        e.stopPropagation();
        e.preventDefault();
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * window.innerHeight : e.deltaY;
        parent.postMessage({ demo: 'msg', page, m: { type: 'demoWheel', dy } }, '*');
      },
      { capture: true, passive: false },
    );
  }
})();

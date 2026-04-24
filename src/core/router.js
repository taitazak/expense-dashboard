/*
 * src/core/router.js — hash-based router for file:// compatibility.
 *
 * Routes:
 *   #/           -> landing
 *   #/import     -> import flow
 *   #/manage     -> manage screen (Merchants now lives as a tab here)
 *   #/stats      -> dashboard
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};

  const routes = {};
  let current = null;
  let container = null;

  function register(path, view) { routes[path] = view; }
  function navigate(path) {
    if (location.hash !== '#' + path) {
      location.hash = '#' + path;
    } else {
      render();
    }
  }

  function parseHash() {
    let h = location.hash || '#/';
    if (!h.startsWith('#')) h = '#' + h;
    let p = h.slice(1);
    if (!p || p === '/') return '/';
    // Strip trailing slash except root.
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  }

  async function render() {
    const path = parseHash();
    const view = routes[path] || routes['/'];
    if (current && current.unmount) {
      try { current.unmount(); } catch (e) { console.error(e); }
    }
    container.innerHTML = '';
    current = view;
    try {
      await view.mount(container);
    } catch (e) {
      console.error('Route render failed:', e);
      container.innerHTML =
        '<div class="view-error">Error rendering view: ' +
        App.util.escapeHtml(String(e && e.message ? e.message : e)) +
        '</div>';
    }
    document.body.setAttribute('data-route', path.replace(/^\//, '') || 'landing');
  }

  function init() {
    container = document.getElementById('view');
    if (!container) throw new Error('Router: #view container not found');
    window.addEventListener('hashchange', render);
    render();
  }

  App.router = { register, navigate, init, current: () => parseHash() };
})();

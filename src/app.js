/*
 * src/app.js — bootstrap. Runs after every other script, wires the
 * theme toggle, opens the DB, and registers all routes.
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};
  const { emit } = App.util;

  function initTheme() {
    const saved = localStorage.getItem('theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const useDark = saved === 'dark' || (!saved && prefersDark);
    const btn = document.getElementById('themeToggle');
    if (useDark) {
      document.documentElement.setAttribute('data-theme', 'dark');
      if (btn) btn.textContent = '☀️';
    } else {
      document.documentElement.removeAttribute('data-theme');
      if (btn) btn.textContent = '🌙';
    }
    if (btn) {
      btn.addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme');
        const next = cur === 'dark' ? 'light' : 'dark';
        if (next === 'dark') {
          document.documentElement.setAttribute('data-theme', 'dark');
          btn.textContent = '☀️';
        } else {
          document.documentElement.removeAttribute('data-theme');
          btn.textContent = '🌙';
        }
        localStorage.setItem('theme', next);
        emit('themechange', { theme: next });
      });
    }
  }

  // Race a promise against a timeout. Used to keep boot moving forward when
  // an IDB call hangs — without this, a single stuck await silently parks
  // the entire boot promise and the user sees the header with empty body.
  function withTimeout(p, ms, label) {
    return new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => {
        if (done) return; done = true;
        reject(new Error((label || 'operation') + ' timed out after ' + ms + 'ms'));
      }, ms);
      Promise.resolve(p).then(
        (v) => { if (done) return; done = true; clearTimeout(t); resolve(v); },
        (e) => { if (done) return; done = true; clearTimeout(t); reject(e); },
      );
    });
  }

  async function boot() {
    initTheme();

    // Open the DB. open() now has its own internal timeout so it can't sit
    // pending forever, but we double-belt with one here too. If storage is
    // unreachable, we still continue past this — the router will render the
    // landing view with a "Local database is unavailable" status strip, and
    // the recovery UI in the catch handler offers a "reset" path.
    let storageReady = false;
    try {
      await withTimeout(App.storage.open(), 6000, 'IndexedDB open');
      storageReady = true;
    } catch (e) {
      console.warn('IndexedDB unavailable:', e && e.message);
    }

    // One-shot data hygiene migrations. Each is gated behind `storageReady`
    // and additionally raced against a per-step timeout so a slow / corrupt
    // record can't keep us from registering routes.
    if (storageReady) {
      try {
        if (App.processing && App.processing.dates && App.processing.dates.runMigrationIfNeeded) {
          await withTimeout(App.processing.dates.runMigrationIfNeeded(), 4000, 'date migration');
        }
      } catch (e) {
        console.warn('Date migration skipped:', e && e.message);
      }

      try {
        const N = App.processing && App.processing.normalize;
        if (N && N.seedBrandCollapsesIfNeeded) await withTimeout(N.seedBrandCollapsesIfNeeded(), 4000, 'brand-rule seed');
        // Move legacy per-merchant overrides from the `merchants` store into
        // the regex-based normalize_rules store as anchored exact-match
        // patterns. Runs once per browser profile; safe to re-run.
        if (N && N.migrateMerchantsToRulesIfNeeded) {
          const r = await withTimeout(N.migrateMerchantsToRulesIfNeeded(), 6000, 'merchants→rules migration');
          if (r && r.migrated) console.info('Kalkala: migrated', r.migrated, 'per-merchant override(s) into display-name rules.');
        }
        if (N && N.loadBrandCollapses)        await withTimeout(N.loadBrandCollapses(),        4000, 'brand-rule load');
      } catch (e) {
        console.warn('Brand-collapse rules unavailable:', e && e.message);
      }
    }

    if (!App.router || !App.views) {
      throw new Error('App scripts failed to load in the expected order.');
    }
    App.router.register('/',        App.views.landing);
    App.router.register('/import',  App.views.import);
    App.router.register('/manage',  App.views.manage);
    App.router.register('/stats',   App.views.stats);
    App.router.init();
  }

  // Build the recovery UI shown when boot fails. Offers "Reset local data
  // and reload" as a one-click escape hatch when the IndexedDB itself is
  // corrupt or otherwise unreachable. Confirmation is intentional — wiping
  // the DB is destructive.
  function renderBootError(view, err) {
    view.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'view-error';
    const h = document.createElement('h2');
    h.textContent = 'The dashboard could not start.';
    const p = document.createElement('p');
    p.textContent = (err && err.message) ? err.message : String(err);
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent =
      'This usually means the local IndexedDB for this app is unreachable or corrupted. ' +
      'Closing every other tab of this app and reloading may help. If it does not, you can ' +
      'wipe the local database below — this deletes ALL imported transactions, accounts, ' +
      'rules, and merchants stored in this browser, with no way to undo.';

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.marginTop = '14px';

    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'btn';
    reload.textContent = 'Reload page';
    reload.addEventListener('click', () => location.reload());

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn btn--danger';
    reset.textContent = '⚠ Reset local data and reload';
    reset.addEventListener('click', async () => {
      const ok = window.confirm(
        'This will permanently delete every transaction, account, category, ' +
        'rule, and merchant stored in this browser for this app. There is no undo.\n\n' +
        'Continue?');
      if (!ok) return;
      reset.disabled = true; reset.textContent = 'Resetting…';
      try {
        if (App.storage && App.storage.deleteDB) {
          await App.storage.deleteDB();
        } else if ('indexedDB' in window) {
          // Fallback if the storage layer never finished loading.
          await new Promise((res, rej) => {
            const r = indexedDB.deleteDatabase('kalkala-expense-dashboard');
            r.onsuccess = () => res();
            r.onerror   = () => rej(r.error);
            r.onblocked = () => rej(new Error('Reset blocked — close every other tab of this app and try again.'));
          });
        }
        try { localStorage.removeItem('kalkala.future_dates_migrated.v1'); } catch (_) { /* ignore */ }
        location.reload();
      } catch (e) {
        reset.disabled = false; reset.textContent = '⚠ Reset local data and reload';
        window.alert('Reset failed: ' + (e && e.message ? e.message : String(e)));
      }
    });

    row.appendChild(reload);
    row.appendChild(reset);

    wrap.appendChild(h);
    wrap.appendChild(p);
    wrap.appendChild(hint);
    wrap.appendChild(row);
    view.appendChild(wrap);
  }

  // If boot throws — including via a withTimeout rejection — render a
  // visible error with a recovery button. The header lives outside #view,
  // so without this a half-booted app looks like "header and nothing else"
  // with no clue what happened and no way to recover.
  function bootSafely() {
    Promise.resolve().then(boot).catch((e) => {
      console.error('Boot failed:', e);
      const v = document.getElementById('view');
      if (v) renderBootError(v, e);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootSafely);
  } else {
    bootSafely();
  }
})();

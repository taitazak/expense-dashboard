/*
 * src/features/landing/landing.js — the hub with three entry cards.
 *
 * On mount, we count the records in IndexedDB so the user can see whether
 * the dashboard already has anything in it and jump straight to the view
 * that makes sense for their state.
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};
  const { el, escapeHtml, formatCurrency, formatNumber, downloadJSON } = App.util;

  const CARDS = [
    {
      id: 'import', route: '/import',
      icon: '📥', title: 'Import data',
      blurb: 'Pick PDF bank statements and turn them into rows in your local table.',
      action: 'Start import',
    },
    {
      id: 'manage', route: '/manage',
      icon: '🛠️', title: 'Manage data',
      blurb: 'Accounts, categorisation rules, merchant display names, import history, and JSON backup / restore.',
      action: 'Open manager',
    },
    {
      id: 'stats', route: '/stats',
      icon: '📊', title: 'See stats',
      blurb: 'The original dashboard — charts, filters, monthly totals.',
      action: 'View dashboard',
    },
  ];

  async function loadSummary() {
    try {
      await App.storage.open();
      const [transactions, accounts, imports, categories] = await Promise.all([
        App.storage.transactions.all(),
        App.storage.accounts.all(),
        App.storage.imports.all(),
        App.storage.categories.all().catch(() => []),
      ]);
      const excluded = new Set(
        (categories || []).filter(c => c && c.excluded && c.name).map(c => c.name)
      );
      // Only sum *expenses* into the spend totals on the landing strip —
      // the user cares about "how much did I spend", not mixed in+out.
      // Transfers and categories the user flagged as excluded are dropped too.
      const byCurrency = {};
      for (const t of transactions) {
        if (t.kind !== 'expense' && t.kind != null) continue;
        if (excluded.has(t.category || '')) continue;
        const c = t.currency || 'EUR';
        byCurrency[c] = (byCurrency[c] || 0) + Math.abs(Number(t.amount) || 0);
      }
      return {
        transactionCount: transactions.length,
        accountCount: accounts.length,
        importCount: imports.length,
        byCurrency,
      };
    } catch (e) {
      console.error('Landing summary failed:', e);
      return null;
    }
  }

  // ---- Recovery actions, shown in the muted status strip when storage
  // ---- is unreachable. The chain is "salvage first, repair second,
  // ---- reset only as a last resort".

  // Read the existing on-disk DB at its current version (skipping the
  // broken upgrade) and trigger a JSON download. Throws on failure so
  // callers can chain (e.g. repair aborts if the safety backup fails).
  async function _doExport() {
    if (!App.storage || !App.storage.legacyExport) {
      throw new Error('Storage layer unavailable.');
    }
    const dump = await App.storage.legacyExport();
    // Bundle localStorage settings too (theme, migration flag) so the
    // export is a complete profile snapshot.
    const settings = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if ((k && k.startsWith('kalkala.')) || k === 'theme') {
          settings[k] = localStorage.getItem(k);
        }
      }
    } catch (_) { /* ignore */ }
    dump.localStorage = settings;
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    downloadJSON(dump, 'kalkala-backup-' + ts + '.json');
    return dump;
  }

  // UI wrapper around _doExport — manages button state and surfaces
  // failures via window.alert. Errors are not rethrown.
  async function exportLocalData(btn) {
    const original = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }
    try {
      await _doExport();
    } catch (e) {
      window.alert('Export failed: ' + (e && e.message ? e.message : String(e)) +
        '\n\nThe local database is unreachable even at its current version. ' +
        'Try closing every other tab of this app and reloading first.');
    } finally {
      if (btn) { btn.disabled = false; if (original) btn.textContent = original; }
    }
  }

  // Auto-export, then call repair() which dumps → deletes → re-creates →
  // restores. Reloads on success so the page boots normally.
  async function repairLocalData(btn) {
    const ok = window.confirm(
      'Repair will:\n' +
      '  1. Save a JSON backup of everything readable from your local database\n' +
      '  2. Delete the corrupt database\n' +
      '  3. Re-create it at the current schema version\n' +
      '  4. Write your data back into the fresh database\n\n' +
      'If step 1 fails the repair is aborted and nothing is deleted.\n\n' +
      'Continue?');
    if (!ok) return;
    const original = btn && btn.textContent;
    try {
      if (!App.storage) throw new Error('Storage layer unavailable.');
      // Step 1: safety backup. We do this even though repair() itself
      // dumps — having a separate file on disk means the user can recover
      // by hand if step 4 fails halfway. _doExport throws on failure so
      // we abort cleanly without touching the broken DB.
      if (btn) { btn.disabled = true; btn.textContent = 'Backing up…'; }
      await _doExport();
      // Step 2-4: do the dance.
      if (btn) btn.textContent = 'Repairing…';
      const result = await App.storage.repair();
      const total = Object.values(result.restored || {}).reduce((s, n) => s + n, 0);
      window.alert('Repair complete. Restored ' + total + ' rows across ' +
        Object.keys(result.restored || {}).length + ' stores. Reloading.');
      location.reload();
    } catch (e) {
      if (btn) { btn.disabled = false; if (original) btn.textContent = original; }
      window.alert('Repair failed: ' + (e && e.message ? e.message : String(e)) +
        '\n\nA safety backup may already have downloaded. ' +
        'You can keep that file and try "Reset local data and reload" as a last resort.');
    }
  }

  // Wipe the local IndexedDB and reload. Confirmation up front because
  // this deletes every imported transaction, account, rule, and merchant
  // stored in this browser with no undo.
  async function resetLocalData(btn) {
    const ok = window.confirm(
      'This will permanently delete every transaction, account, category, ' +
      'rule, and merchant stored in this browser for this app. There is no undo.\n\n' +
      'Did you export a backup first? Continue?');
    if (!ok) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Resetting…'; }
    try {
      if (App.storage && App.storage.deleteDB) {
        await App.storage.deleteDB();
      } else if ('indexedDB' in window) {
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
      if (btn) { btn.disabled = false; btn.textContent = '⚠ Reset local data and reload'; }
      window.alert('Reset failed: ' + (e && e.message ? e.message : String(e)));
    }
  }

  // Render a "manual recovery" block that lives below the JS-driven
  // buttons. When the IDB subsystem is wedged (every JS call to it
  // times out), DevTools and the browser's "clear site data" menu
  // still work because they use a different code path.
  function renderManualRecoveryBlock() {
    const ua = (navigator.userAgent || '').toLowerCase();
    const isFirefox = ua.includes('firefox');
    const isSafari  = ua.includes('safari') && !ua.includes('chrome') && !ua.includes('chromium');
    // Default: Chromium-flavoured (Chrome / Edge / Brave / Arc / Opera).
    let devtoolsPath = 'DevTools → Application → Storage → IndexedDB → ' +
                       'kalkala-expense-dashboard → right-click → Delete database';
    let clearPath = 'Click the lock icon to the left of the URL → Site settings → ' +
                    'Clear data, or visit chrome://settings/content/all and search for this site.';
    if (isFirefox) {
      devtoolsPath = 'DevTools (F12) → Storage tab → Indexed DB → ' +
                     'kalkala-expense-dashboard → right-click → Delete database';
      clearPath = 'Click the lock icon to the left of the URL → Clear cookies and site data.';
    } else if (isSafari) {
      devtoolsPath = 'Develop menu → Show Web Inspector → Storage → ' +
                     'Indexed Databases → kalkala-expense-dashboard → ' +
                     'right-click → Delete Database. ' +
                     '(Enable the Develop menu first in Safari → Settings → Advanced.)';
      clearPath = 'Safari → Settings → Privacy → Manage Website Data → ' +
                  'search for this site → Remove.';
    }

    const showDiagBtn = el('button', {
      type: 'button',
      class: 'btn btn--small',
      onclick: async (e) => {
        const btn = e.currentTarget;
        const out = btn.parentElement.querySelector('[data-diagnose-output]');
        if (!out) return;
        btn.disabled = true; const original = btn.textContent;
        btn.textContent = 'Checking…';
        try {
          const d = App.storage && App.storage.diagnose
            ? await App.storage.diagnose()
            : { available: false, reason: 'diagnose() unavailable' };
          if (d.available) {
            const lines = (d.databases || []).map(
              (x) => '  • ' + (x.name || '?') + ' (v' + (x.version || '?') + ')'
            ).join('\n') || '  (none)';
            out.textContent = 'IndexedDB databases this browser knows about ' +
                              'for this origin:\n' + lines;
          } else {
            out.textContent = 'IndexedDB diagnostic failed: ' + (d.reason || 'unknown');
          }
        } catch (err) {
          out.textContent = 'Diagnostic failed: ' + (err && err.message ? err.message : String(err));
        } finally {
          btn.disabled = false; btn.textContent = original;
        }
      },
    }, '🔎 Show diagnostics');

    return el('details', {
      class: 'manual-recovery',
      style: { marginTop: '14px' },
    },
      el('summary', { style: { cursor: 'pointer', fontWeight: '600' } },
        'Buttons above timing out? Manual recovery'),
      el('div', { style: { marginTop: '10px' } },
        el('p', { class: 'muted', style: { margin: '0 0 10px' } },
          'When every button above fails with "timed out", the browser\'s ' +
          'IndexedDB subsystem itself is unresponsive. JavaScript can\'t ' +
          'reach it from this page — but DevTools and the browser\'s ' +
          'site-data settings can, because they use a different code path.'),
        el('p', { style: { margin: '0 0 6px' } },
          el('strong', null, 'First, try a hard reload: '),
          'Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows / Linux). ' +
          'This bypasses the cache and may pick up fixes that didn\'t ' +
          'load on a soft reload.'),
        el('p', { style: { margin: '0 0 6px' } },
          el('strong', null, 'Then close every other tab of this app '),
          '— including any private/incognito windows. A blocked upgrade ' +
          'in one tab can wedge IDB everywhere.'),
        el('p', { style: { margin: '0 0 6px' } },
          el('strong', null, 'Delete the database from DevTools: '),
          devtoolsPath, '. Then reload this page — the app will rebuild a ' +
          'fresh database on first boot.'),
        el('p', { style: { margin: '0 0 6px' } },
          el('strong', null, 'Or clear all site data for this URL: '),
          clearPath, ' This wipes everything for the origin (including theme ' +
          'preference) and the next reload starts from zero.'),
        el('div', { style: { marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          showDiagBtn,
        ),
        el('pre', {
          'data-diagnose-output': '',
          style: {
            margin: '8px 0 0',
            padding: '8px 10px',
            fontSize: '12px',
            background: 'var(--surface-2, #f3f3f3)',
            border: '1px solid var(--border, #ddd)',
            borderRadius: '4px',
            whiteSpace: 'pre-wrap',
            minHeight: '1.5em',
          },
        }, ''),
      ),
    );
  }

  function renderStatusStrip(summary) {
    if (!summary) {
      // Storage is unreachable — surface a tiered recovery path right
      // here, since the user can't get to Manage > Danger zone if the DB
      // is broken (Manage also needs storage to render its tabs).
      // Order is "least destructive first".
      const exportBtn = el('button', {
        type: 'button',
        class: 'btn btn--small',
        onclick: (e) => exportLocalData(e.currentTarget),
      }, '⬇ Export local data');
      const repairBtn = el('button', {
        type: 'button',
        class: 'btn btn--small btn--primary',
        onclick: (e) => repairLocalData(e.currentTarget),
      }, '🔧 Try to repair');
      const resetBtn = el('button', {
        type: 'button',
        class: 'btn btn--small btn--danger',
        onclick: (e) => resetLocalData(e.currentTarget),
      }, '⚠ Reset local data and reload');
      const actions = el('div', {
        class: 'recovery-actions',
        style: { display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' },
      }, exportBtn, repairBtn, resetBtn);
      return el('div', { class: 'status-strip status-strip--muted' },
        el('div', null,
          el('strong', null, '⚠️ Local database is unavailable.'),
          ' ',
          el('span', null, 'The app cannot read or write data on this profile.'),
        ),
        el('p', { class: 'muted', style: { margin: '8px 0 0' } },
          'Try, in order: (1) export a backup so nothing is lost, (2) attempt a repair — ' +
          'this dumps the readable data, recreates the database, and writes the data back, ' +
          '(3) as a last resort, reset everything. If all three time out, the browser\'s ' +
          'IndexedDB subsystem is wedged — see the manual recovery section below.'),
        actions,
        renderManualRecoveryBlock(),
      );
    }
    if (summary.transactionCount === 0) {
      return el('div', { class: 'status-strip status-strip--empty' },
        el('strong', null, 'No data yet.'),
        ' ',
        el('span', null, 'Import a PDF statement to populate the dashboard.'));
    }
    const totals = Object.entries(summary.byCurrency)
      .map(([cur, amt]) => formatCurrency(amt, cur)).join('  •  ');
    return el('div', { class: 'status-strip status-strip--ready' },
      el('strong', null, formatNumber(summary.transactionCount).replace(/\.00$/, '') + ' transactions'),
      ' across ',
      el('strong', null, String(summary.accountCount) + ' account' + (summary.accountCount === 1 ? '' : 's')),
      summary.importCount
        ? el('span', null, ', ' + summary.importCount + ' import batch' + (summary.importCount === 1 ? '' : 'es'))
        : null,
      totals ? el('span', { class: 'status-strip__totals' }, ' — ' + totals) : null
    );
  }

  function renderCards() {
    const grid = el('div', { class: 'landing-grid' });
    for (const c of CARDS) {
      const card = el('button', {
        class: 'landing-card',
        type: 'button',
        onclick: () => App.router.navigate(c.route),
      },
        el('div', { class: 'landing-card__icon' }, c.icon),
        el('h2', { class: 'landing-card__title' }, c.title),
        el('p',  { class: 'landing-card__blurb' }, c.blurb),
        el('span', { class: 'landing-card__cta' }, c.action + ' →'),
      );
      grid.appendChild(card);
    }
    return grid;
  }

  async function mount(container) {
    container.innerHTML = '';
    const wrap = el('div', { class: 'view view--landing' });
    wrap.appendChild(el('div', { class: 'landing-intro' },
      el('h1', null, 'What would you like to do?'),
      el('p',  { class: 'muted' },
        'Everything stays on your machine. Imports run locally in the browser — no servers, no uploads.'),
    ));
    const strip = el('div', { class: 'landing-status' }, 'Loading…');
    wrap.appendChild(strip);
    wrap.appendChild(renderCards());
    container.appendChild(wrap);

    const summary = await loadSummary();
    strip.innerHTML = '';
    strip.appendChild(renderStatusStrip(summary));
  }

  App.views = App.views || {};
  App.views.landing = { mount };
})();

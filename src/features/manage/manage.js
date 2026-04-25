/*
 * src/features/manage/manage.js — manager for accounts, categorisation rules,
 * categories, duplicates, transactions, import history, backup, and the
 * danger zone. All edits hit IndexedDB directly.
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};
  const { el, escapeHtml, toast, downloadJSON, confirmAction, promptSelect, formatCurrency, monthName } = App.util;

  const TABS = [
    { id: 'accounts',     label: 'Accounts' },
    { id: 'rules',        label: 'Rules' },
    { id: 'categories',   label: 'Categories' },
    { id: 'duplicates',   label: 'Duplicates' },
    { id: 'transactions', label: 'Transactions' },
    { id: 'history',      label: 'Import history' },
    { id: 'backup',       label: 'Backup / restore' },
    { id: 'danger',       label: 'Danger zone' },
  ];

  let rootEl = null;
  let activeTab = 'accounts';
  // Transactions tab: remembered filter state so re-render doesn't wipe it.
  let txSearch = '';
  let txCategory = '';   // '' = any, '__uncat' = Uncategorized, else literal name
  let txAccount = '';    // '' = any, else stringified account id, '__none' = unassigned
  let txType = '';       // '' = any, else canonical vocabulary name
  let txLimit = 100;
  // Click-to-sort state. `key` is null when the user hasn't clicked a
  // header yet (in which case the table keeps its natural default order).
  // `dir` cycles asc → desc on re-click of the same column.
  let rulesSortKey = null;  let rulesSortDir = 'asc';
  let txSortKey    = null;  let txSortDir    = 'asc';

  // Build a <th> that toggles sort state on click. `getState` returns the
  // current {key, dir} for this table; `onSort` is invoked with the new
  // state (and should persist + re-render). The arrow indicator renders
  // inline so we don't need per-table CSS pseudo-elements.
  function sortableTh(label, key, getState, onSort) {
    const s = getState() || {};
    const active = s.key === key;
    const arrow = active ? (s.dir === 'asc' ? '▲' : '▼') : '↕';
    const th = el('th', {
      class: 'sortable-th' + (active ? ' is-active' : ''),
      role: 'button',
      tabindex: 0,
      title: 'Sort by ' + label,
      onclick: () => {
        const cur = getState() || {};
        if (cur.key === key) onSort({ key, dir: cur.dir === 'asc' ? 'desc' : 'asc' });
        else                 onSort({ key, dir: 'asc' });
      },
    }, label, ' ', el('span', { class: 'sort-arrow' }, arrow));
    return th;
  }

  // Resolve a transaction's source filename. Used by Manage > Transactions
  // and Manage > Duplicates. The resolution chain:
  //   1) `t.source_file` (set during commit on every new import) — exact
  //   2) batch.files[] has exactly one entry — unambiguous, use its name
  //   3) batch.files[] has multiple entries but only one whose `bank`
  //      matches the row's account.bank — unambiguous, use that one
  //   4) batch.source string (legacy / hand-rolled imports like the
  //      sample backup, where files[] never existed) — best-effort label
  //   5) '' — caller should render '—'
  // Never returns the multi-file " · "-joined string the older helper
  // produced; that was misleading because each row only came from ONE
  // file in the batch, not all of them.
  function resolveSourceFile(t, importsByBatch, accountById) {
    if (!t) return '';
    if (t.source_file) return t.source_file;
    const batch = importsByBatch.get(t.import_batch_id);
    if (!batch) return '';
    const files = Array.isArray(batch.files) ? batch.files.filter(f => f && f.name) : [];
    if (files.length === 1) return files[0].name;
    if (files.length > 1) {
      const acct = accountById && t.account_id != null ? accountById.get(t.account_id) : null;
      const acctBank = acct && acct.bank ? String(acct.bank).toLowerCase() : '';
      if (acctBank) {
        const matches = files.filter(f => (f.bank || '').toLowerCase() === acctBank);
        if (matches.length === 1) return matches[0].name;
      }
      // Multiple files in the batch and we can't disambiguate — return ''
      // rather than dishonestly listing every filename.
      return '';
    }
    // No files[] at all — fall back to the batch's `source` label
    // (legacy hand-rolled imports + the sample backup use this shape).
    if (batch.source) return batch.source;
    return '';
  }

  // Case-insensitive compare of two values with stable null/undefined handling.
  // Numbers are compared numerically; anything else is stringified and lowered.
  function cmpBy(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const sa = String(a).toLowerCase();
    const sb = String(b).toLowerCase();
    return sa < sb ? -1 : (sa > sb ? 1 : 0);
  }

  async function mount(container) {
    rootEl = container;
    await App.storage.open();
    await render();
  }

  // render() is called from many places: tab switches, rule edits, add/delete
  // callbacks, etc. Rule-editing callbacks pass { preserveScroll: true } so
  // the viewport stays put instead of jumping back to the top of the page.
  // Tab switches (and the initial mount) call render() with no argument, so
  // the viewport resets — which is what the user expects when navigating.
  async function render(opts) {
    const preserveScroll = !!(opts && opts.preserveScroll);
    const prevScrollY = preserveScroll ? window.scrollY : 0;

    rootEl.innerHTML = '';
    const wrap = el('div', { class: 'view view--manage' });
    // Breadcrumb removed — the persistent top nav indicates the active
    // section.
    wrap.appendChild(el('h1', null, 'Manage data'));

    const tabs = el('nav', { class: 'tabs' });
    TABS.forEach(t => {
      tabs.appendChild(el('button', {
        type: 'button',
        class: 'tabs__btn' + (t.id === activeTab ? ' tabs__btn--active' : ''),
        onclick: () => { activeTab = t.id; render(); },
      }, t.label));
    });
    wrap.appendChild(tabs);

    const panel = el('div', { class: 'tab-panel' });
    wrap.appendChild(panel);
    rootEl.appendChild(wrap);

    try {
      if (activeTab === 'accounts')          await renderAccounts(panel);
      else if (activeTab === 'rules')        await renderRules(panel);
      else if (activeTab === 'categories')   await renderCategories(panel);
      else if (activeTab === 'duplicates')   await renderDuplicates(panel);
      else if (activeTab === 'transactions') await renderTransactions(panel);
      else if (activeTab === 'history')      await renderHistory(panel);
      else if (activeTab === 'backup')       await renderBackup(panel);
      else if (activeTab === 'danger')       await renderDanger(panel);
    } catch (e) {
      console.error(e);
      panel.innerHTML = '';
      panel.appendChild(el('div', { class: 'view-error' }, 'Failed to load tab: ' + e.message));
    }

    if (preserveScroll) {
      // Restore on the next frame so the DOM has committed the new height.
      // Using rAF + fallback to a microtask handles both live browsers and
      // the odd headless env that skips rAF.
      const restore = () => window.scrollTo(0, prevScrollY);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
      else restore();
    }
  }

  // ---------- Accounts ----------
  async function renderAccounts(panel) {
    const [accounts, txs] = await Promise.all([
      App.storage.accounts.all(),
      App.storage.transactions.all(),
    ]);
    // Count transactions per account in one pass — used to show the scope
    // of each row so the user knows what they'd be touching on delete.
    const txCountByAccount = new Map();
    txs.forEach(t => {
      const k = (t.account_id == null) ? '__none' : t.account_id;
      txCountByAccount.set(k, (txCountByAccount.get(k) || 0) + 1);
    });
    panel.appendChild(el('p', { class: 'muted' },
      'Accounts are created automatically when you import a statement, but you can rename, mark own/other, or remove them here. ' +
      'The Transactions column shows how many imported rows are tied to each account.'));
    if (!accounts.length) {
      panel.appendChild(el('div', { class: 'empty-state' },
        el('h3', null, 'No accounts yet'),
        el('p', null, 'Import a PDF statement to create your first account.')));
      return;
    }
    const tbl = el('table', { class: 'manage-table' });
    tbl.appendChild(el('thead', null, el('tr', null,
      el('th', null, 'Name'),
      el('th', null, 'Bank'),
      el('th', null, 'Currency'),
      el('th', null, 'IBAN / Identifier'),
      el('th', null, 'Own?'),
      el('th', { class: 'num' }, 'Transactions'),
      el('th', null, ''),
    )));
    const tbody = el('tbody');
    accounts.forEach(a => {
      const count = txCountByAccount.get(a.id) || 0;
      const tr = el('tr', null,
        el('td', null, el('input', {
          type: 'text', value: a.name || '',
          onchange: async (e) => { a.name = e.target.value; await App.storage.accounts.put(a); toast('Saved.', 'success'); },
        })),
        el('td', null, a.bank || ''),
        el('td', null, a.currency || ''),
        // IBAN / identifier is editable — some banks' PDFs emit a weird or
        // partial identifier that the user wants to clean up.
        el('td', null, el('input', {
          type: 'text', value: a.iban || a.account_number || '',
          onchange: async (e) => {
            const v = (e.target.value || '').trim();
            a.iban = v || null;
            await App.storage.accounts.put(a);
            toast('Saved.', 'success');
          },
        })),
        el('td', null, el('input', {
          type: 'checkbox', checked: a.is_own ? '' : null,
          onchange: async (e) => { a.is_own = e.target.checked; await App.storage.accounts.put(a); },
        })),
        el('td', { class: 'num' }, String(count)),
        el('td', null, el('button', {
          type: 'button', class: 'btn btn--ghost btn--small',
          onclick: () => deleteAccountWithReassign(a, accounts),
        }, 'Delete'))
      );
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    panel.appendChild(tbl);

    const unassigned = txCountByAccount.get('__none') || 0;
    if (unassigned) {
      panel.appendChild(el('p', { class: 'muted' },
        unassigned + ' transaction' + (unassigned === 1 ? '' : 's') +
        ' are not tied to any account.'));
    }
  }

  // Delete an account *and* decide what to do with its transactions. The
  // user picks a destination account (or "leave unassigned") in a modal;
  // we then rewrite every matching transaction before removing the account
  // record itself.
  //
  // Special-cases:
  //  - When there are no affected transactions AND nothing meaningful to pick
  //    from, skip the destination popup entirely — just confirm and delete.
  //  - Destination labels include id + IBAN + tx count so duplicates of the
  //    same account name can actually be told apart in the dropdown.
  async function deleteAccountWithReassign(account, allAccounts) {
    if (account == null || account.id == null) {
      toast('Cannot delete: this account row has no id (try reloading).', 'error');
      return;
    }
    const txs = await App.storage.transactions.all();
    const affected = txs.filter(t => t.account_id === account.id);
    const others = allAccounts.filter(a => a.id !== account.id);
    // Per-account tx count — used to disambiguate duplicated names.
    const txCountByAccount = new Map();
    txs.forEach(t => {
      if (t.account_id == null) return;
      txCountByAccount.set(t.account_id, (txCountByAccount.get(t.account_id) || 0) + 1);
    });
    const labelFor = (a) => {
      const parts = [a.name || '(unnamed)'];
      if (a.currency) parts.push('(' + a.currency + ')');
      const ident = a.iban || a.account_number;
      if (ident) parts.push('· ' + String(ident).slice(-6));
      const c = txCountByAccount.get(a.id) || 0;
      parts.push('· ' + c + ' tx');
      parts.push('· #' + a.id);
      return parts.join(' ');
    };

    // Fast-path: nothing to reassign AND no other accounts to choose from.
    // The destination popup would be a useless single-option dropdown — just
    // confirm and delete.
    if (!affected.length) {
      const ok = await confirmAction(
        'Delete account "' + (account.name || 'account') + '"' +
        (others.length ? '' : ' (no other accounts exist)') +
        '? No transactions are attached, so nothing else changes.');
      if (!ok) return;
      try {
        await App.storage.accounts.delete(account.id);
        toast('Deleted account.', 'success');
        render();
      } catch (e) {
        console.error('account delete failed:', e);
        toast('Delete failed: ' + (e && e.message ? e.message : String(e)), 'error');
      }
      return;
    }

    const options = [
      { value: '', label: '— Leave unassigned —' },
      ...others.map(a => ({ value: String(a.id), label: labelFor(a) })),
    ];
    const msg = affected.length + ' transaction' + (affected.length === 1 ? '' : 's') +
      ' are tied to this account. Where should they go?' +
      (others.length > 1 ? ' (Duplicates of the same name show their IBAN suffix and id so you can tell them apart.)' : '');
    const picked = await promptSelect({
      title: 'Delete "' + (account.name || 'account') + '" #' + account.id,
      message: msg,
      options,
      confirmLabel: 'Delete & move',
      danger: true,
    });
    if (picked === null) return; // cancelled
    const targetId = picked === '' ? null : parseInt(picked, 10);
    if (targetId === account.id) {
      // Defensive — `others` already excludes this account, so this should
      // never happen, but bail loudly if it does instead of silently looping.
      toast('Cannot move transactions to the account you are deleting.', 'error');
      return;
    }
    try {
      for (const t of affected) {
        const next = Object.assign({}, t, { account_id: targetId });
        // Keep the legacy `card` field in sync with the new account's IBAN
        // tail when we have one, otherwise wipe it.
        if (targetId != null) {
          const tgt = others.find(a => a.id === targetId);
          next.card = tgt && tgt.iban ? tgt.iban.replace(/\s+/g, '').slice(-4) : (next.card || '—');
        } else {
          next.card = '—';
        }
        await App.storage.transactions.put(next);
      }
      await App.storage.accounts.delete(account.id);
      toast('Moved ' + affected.length + ' transaction' +
        (affected.length === 1 ? '' : 's') + ' and deleted account.', 'success');
      render();
    } catch (e) {
      console.error('account delete failed:', e);
      toast('Delete failed: ' + (e && e.message ? e.message : String(e)), 'error');
    }
  }

  // ---------- Rules (unified page) ----------
  //
  // ONE table covering both rule kinds:
  //
  //   - Category rules  (store: `category_rules`) — a substring or regex
  //     match against the merchant display name + description, picking a
  //     category for matching transactions during import.
  //   - Display rules   (store: `normalize_rules`) — a regex applied to the
  //     raw merchant string, rewriting it to a friendly display name.
  //     Per-merchant exact-match overrides live here too as anchored
  //     `^escapeRegex(original)$` patterns (migrated on boot from the old
  //     merchants store), and we surface those rows with a friendlier
  //     "exact" badge.
  //
  // Rows are tagged with a synthetic `__action` ("category" | "display") so
  // the unified UI can dispatch saves to the right store. The two stores
  // remain separate on disk — the table is a join, not a schema change.
  //
  // Bulk actions:
  //   - Combine selected → regex: union all selected rules' patterns into
  //     one alternation. Refuses mixed Action selections so the user knows
  //     they have to combine within a single category-of-rule. Optional
  //     "delete originals" checkbox.
  //   - Delete selected: removes the selected rules across both stores.
  //
  // Apply-now buttons re-run categorisation across all stored transactions
  // (category rules) or refresh the display-name cache and report how many
  // distinct merchants resolve to a different display (display rules).
  //
  // Import / export of rules is in the Backup / restore tab.
  // -------------------- Rules --------------------
  // ONE table for everything that shapes how transactions are categorised
  // and how merchant names are normalised. Each row is keyed by (pattern,
  // match) and may carry a Display name, a Category, both, or — transiently —
  // neither. The two underlying stores stay split:
  //
  //   • category_rules  — keyword + is_regex + flags + category
  //   • normalize_rules — pattern + flags + display + match_hint
  //
  // ...but the UI joins them by their *user-facing* (pattern, match) pair so
  // a single edit can influence both. Match has three modes:
  //   • substring — case-insensitive plain-text substring match
  //   • regex     — pattern is a regex source, compiled with `i`
  //   • exact     — match the full transaction string verbatim
  //
  // Encoding details (so the same logical pattern lines up across stores):
  //   • category_rules.substring → keyword=P,            is_regex=false
  //   • category_rules.regex     → keyword=P,            is_regex=true
  //   • category_rules.exact     → keyword=^esc(P)$,     is_regex=true
  //   • normalize_rules.substring→ pattern=esc(P),       match_hint='substring'
  //   • normalize_rules.regex    → pattern=P,            match_hint='regex'
  //   • normalize_rules.exact    → pattern=^esc(P)$,     match_hint='exact'
  //
  // The match_hint field lets us recover the user's original intent for
  // display rules (esc(P) vs raw P would otherwise be ambiguous on read-back).
  // Older rows without a hint fall back to a heuristic: anchored escapes →
  // exact; everything else → regex.
  //
  // Source ranking (for the Source column):
  //   manual > auto/learned > default
  // When both halves are present we show the higher-ranked source.
  async function renderRules(panel) {
    const N = (App.processing && App.processing.normalize) || {};
    if (!App.storage || !App.storage.normalizeRules) {
      panel.appendChild(el('div', { class: 'empty-state' },
        el('p', null, 'Display-name rule storage is not available — refresh the page after the upgrade lands.')));
      return;
    }

    panel.appendChild(el('p', { class: 'muted' },
      'One rule, one row. Pick a Match mode, then fill Display name, Category, or both — ' +
      'each rule fixes both columns for any transaction it matches. Edits take effect on ' +
      'the next import, or immediately via the "Apply rules now" buttons. Import / export ' +
      'of rules lives in the Backup / restore tab.'));

    // --- Apply-now bar ---
    // Two explicit buttons: re-categorise every stored row against the
    // current rule set, and reload display-name rules so the resolver uses
    // the latest patterns. The second action doesn't mutate rows (display is
    // computed on the fly) but we count how many distinct raw merchants
    // resolve to a different display now, so the user gets concrete feedback.
    const applyBar = el('div', { class: 'rules-toolbar' });
    applyBar.appendChild(el('button', {
      type: 'button', class: 'btn btn--secondary btn--small',
      onclick: async () => {
        const ok = await confirmAction(
          'Re-apply every category rule against every transaction in your local DB?\n\n' +
          'Matching rows will be overwritten with the rule\'s category. Rows ' +
          'without a rule match keep their current category.');
        if (!ok) return;
        try {
          const result = await App.processing.categorize.applyRulesToAll();
          toast('Category rules applied: updated ' + result.changed + ' of ' + result.total + ' transactions.', 'success');
        } catch (e) {
          console.error(e); toast('Apply failed: ' + e.message, 'error');
        }
      },
    }, 'Apply category rules now'));
    applyBar.appendChild(el('button', {
      type: 'button', class: 'btn btn--secondary btn--small',
      onclick: async () => {
        try {
          if (N.loadBrandCollapses) await N.loadBrandCollapses();
          const txs = await App.storage.transactions.all();
          const resolver = N.buildMerchantResolver ? N.buildMerchantResolver([]) : null;
          const seen = new Set();
          let affected = 0;
          for (const t of txs) {
            const raw = (t.merchant || '').trim();
            if (!raw || seen.has(raw)) continue;
            seen.add(raw);
            let pretty = raw;
            try { pretty = (resolver && resolver(raw)) || (N.beautifyMerchant ? N.beautifyMerchant(raw) : raw) || raw; }
            catch (_) { /* ignore */ }
            if (pretty !== raw) affected++;
          }
          toast('Display name rules applied: ' + affected + ' unique merchant'
            + (affected === 1 ? '' : 's') + ' now resolve to a custom name.', 'success');
          render({ preserveScroll: true });
        } catch (e) {
          console.error(e); toast('Apply failed: ' + e.message, 'error');
        }
      },
    }, 'Apply display name rules now'));
    panel.appendChild(applyBar);

    // --- Load both stores + categories list (for the dropdown) ---
    const [catRules, dispRules, storedCats, txs] = await Promise.all([
      App.storage.rules.all(),
      App.storage.normalizeRules.all(),
      App.storage.categories.all(),
      App.storage.transactions.all(),
    ]);

    // Build the union of category names from stored categories, rule
    // targets, and transaction usage — same recipe as the Categories tab.
    const catSet = new Set();
    storedCats.forEach(c => { if (c && c.name) catSet.add(c.name); });
    catRules.forEach(r => { if (r && r.category) catSet.add(r.category); });
    txs.forEach(t => { if (t && t.category) catSet.add(t.category); });
    catSet.delete('Uncategorized');
    const distinctCats = Array.from(catSet).sort((a, b) => a.localeCompare(b));

    // --- Pattern detection / encoding helpers ---
    function escRegex(s) {
      if (N.escapeRegex) return N.escapeRegex(s);
      return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    // Detect anchored exact-match patterns produced by saveExactDisplayOverride
    // and the exact-match encoder below. After stripping anchors and any
    // escaped meta-chars, no live regex operator should remain. Conservative
    // by design: false-negatives complex anchored regexes (we just show them
    // as "regex" instead of "exact").
    function isExactPattern(pat) {
      if (!pat) return false;
      if (!/^\^.*\$$/.test(pat)) return false;
      const inner = pat.slice(1, -1).replace(/\\./g, '');
      return !/[|()?*+\[\]{}^$.]/.test(inner);
    }
    function unescapeExact(pat) {
      if (!isExactPattern(pat)) return pat;
      return pat.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    function unescapeLiteral(pat) {
      return String(pat || '').replace(/\\(.)/g, '$1');
    }

    // Project stored rows to user-facing {pattern, match}.
    function catFacing(r) {
      const pat = r.keyword || '';
      if (!r.is_regex) return { pattern: pat, match: 'substring' };
      if (isExactPattern(pat)) return { pattern: unescapeExact(pat), match: 'exact' };
      return { pattern: pat, match: 'regex' };
    }
    function dispFacing(r) {
      const pat = r.pattern || '';
      const hint = r.match_hint;
      if (hint === 'substring') return { pattern: unescapeLiteral(pat), match: 'substring' };
      if (hint === 'regex')     return { pattern: pat,                  match: 'regex' };
      if (hint === 'exact')     return { pattern: unescapeExact(pat),   match: 'exact' };
      // Legacy: no hint → infer. Conservative: anchored escapes → exact;
      // anything else → regex (misclassifying a substring-meant rule as
      // regex still works at runtime; the inverse would silently break
      // patterns containing \b, \w, \s, etc.).
      if (isExactPattern(pat)) return { pattern: unescapeExact(pat), match: 'exact' };
      return { pattern: pat, match: 'regex' };
    }

    // Encoders for the inverse direction.
    function encodeCatKeyword(pattern, match) {
      if (match === 'exact') return '^' + escRegex(pattern) + '$';
      return pattern; // substring + regex are stored verbatim; is_regex flag does the rest
    }
    function encodeDispPattern(pattern, match) {
      if (match === 'substring') return escRegex(pattern);  // matches P literally anywhere
      if (match === 'exact')     return '^' + escRegex(pattern) + '$';
      return pattern;                                        // regex source verbatim
    }

    // Merge key — pattern equality is case-insensitive for substring/exact
    // (since they compile with `i` anyway), case-sensitive for regex (where
    // the pattern body is its own identity).
    function rowKey(pattern, match) {
      return match + '\x00' + (match === 'regex' ? pattern : pattern.toLowerCase());
    }

    // --- Source ranking ---
    function sourceRank(s) {
      if (s === 'manual') return 3;
      if (s === 'auto')   return 2;
      if (s === 'learned')return 2;
      return 1; // 'default' or missing
    }
    function pickSource(a, b) {
      if (!a) return b || 'default';
      if (!b) return a;
      return sourceRank(a) >= sourceRank(b) ? a : b;
    }
    function sourceLabel(s) {
      if (s === 'manual')  return 'manual';
      if (s === 'auto' || s === 'learned') return 'learned';
      return 'default';
    }

    // --- Build merged rows ---
    const rowsByKey = new Map();
    function getOrCreate(pattern, match) {
      const k = rowKey(pattern, match);
      let row = rowsByKey.get(k);
      if (!row) {
        row = { pattern, match, catRef: null, dispRef: null };
        rowsByKey.set(k, row);
      }
      return row;
    }
    catRules.forEach(r => {
      const f = catFacing(r);
      const row = getOrCreate(f.pattern, f.match);
      row.catRef = r;
    });
    dispRules.forEach(r => {
      const f = dispFacing(r);
      const row = getOrCreate(f.pattern, f.match);
      row.dispRef = r;
    });
    const rows = Array.from(rowsByKey.values());

    // Stable selection id derived from refs + key. Surviving renders even
    // when an id changes is not critical — selection state is per-render.
    rows.forEach(r => {
      r.__id = (r.catRef ? 'c' + r.catRef.id : '') + '|' + (r.dispRef ? 'd' + r.dispRef.id : '') +
               '|' + rowKey(r.pattern, r.match);
    });

    // Sort: user-chosen column when rulesSortKey is set, otherwise fall back
    // to the natural default — edited rules (any side manual) first, then
    // rules with both halves filled (richer first), then by pattern alpha.
    if (rulesSortKey) {
      const ruleSortValue = (r, key) => {
        if (key === 'pattern')  return r.pattern || '';
        if (key === 'match')    return r.match || '';
        if (key === 'display')  return (r.dispRef && r.dispRef.display) || '';
        if (key === 'category') return (r.catRef && r.catRef.category) || '';
        if (key === 'source')   return sourceLabel(pickSource(
          r.catRef  && r.catRef.source,
          r.dispRef && r.dispRef.source,
        ));
        return '';
      };
      const dir = rulesSortDir === 'desc' ? -1 : 1;
      rows.sort((a, b) => {
        const primary = cmpBy(ruleSortValue(a, rulesSortKey), ruleSortValue(b, rulesSortKey)) * dir;
        if (primary) return primary;
        // Tie-breaker: pattern alpha keeps the order deterministic.
        return (a.pattern || '').localeCompare(b.pattern || '');
      });
    } else {
      rows.sort((a, b) => {
        const aEdited = ((a.catRef && a.catRef.source === 'manual') ||
                         (a.dispRef && a.dispRef.source === 'manual')) ? 0 : 1;
        const bEdited = ((b.catRef && b.catRef.source === 'manual') ||
                         (b.dispRef && b.dispRef.source === 'manual')) ? 0 : 1;
        if (aEdited !== bEdited) return aEdited - bEdited;
        const aBoth = (a.catRef && a.dispRef) ? 0 : 1;
        const bBoth = (b.catRef && b.dispRef) ? 0 : 1;
        if (aBoth !== bBoth) return aBoth - bBoth;
        return (a.pattern || '').localeCompare(b.pattern || '');
      });
    }

    // --- Half-setters: write/update/delete one side of a row ---
    // Empty value means "clear this half" (delete the backing ref). Pattern
    // changes are handled by the row-level pattern editor, which calls
    // setCategoryHalf + setDisplayHalf in sequence to re-encode both refs.
    async function setCategoryHalf(row, pattern, match, category, source) {
      const now = new Date().toISOString();
      const keyword = encodeCatKeyword(pattern, match);
      if (!category || !category.trim()) {
        if (row.catRef) {
          await App.storage.rules.delete(row.catRef.id);
          row.catRef = null;
        }
        return;
      }
      if (row.catRef) {
        row.catRef.keyword = keyword;
        row.catRef.is_regex = match !== 'substring';
        row.catRef.flags = match === 'substring' ? undefined : 'i';
        row.catRef.category = category.trim();
        row.catRef.source = source;
        row.catRef.updated_at = now;
        await App.storage.rules.put(row.catRef);
      } else {
        const id = await App.storage.rules.put({
          keyword,
          is_regex: match !== 'substring',
          flags: match === 'substring' ? undefined : 'i',
          category: category.trim(),
          source, updated_at: now,
        });
        row.catRef = {
          id, keyword,
          is_regex: match !== 'substring',
          flags: match === 'substring' ? undefined : 'i',
          category: category.trim(),
          source, updated_at: now,
        };
      }
    }
    async function setDisplayHalf(row, pattern, match, display, source) {
      const now = new Date().toISOString();
      const patEnc = encodeDispPattern(pattern, match);
      if (!display || !display.trim()) {
        if (row.dispRef) {
          await App.storage.normalizeRules.delete(row.dispRef.id);
          row.dispRef = null;
          if (N.loadBrandCollapses) await N.loadBrandCollapses();
        }
        return;
      }
      if (N.validateBrandPattern) {
        const err = N.validateBrandPattern(patEnc, 'i');
        if (err) throw new Error(err);
      }
      if (row.dispRef) {
        row.dispRef.pattern = patEnc;
        row.dispRef.flags = 'i';
        row.dispRef.match_hint = match;
        row.dispRef.display = display.trim();
        row.dispRef.source = source;
        row.dispRef.updated_at = now;
        await App.storage.normalizeRules.put(row.dispRef);
      } else {
        // Compute a fresh `order` so the new rule sorts after existing ones
        // (matches saveDisplayRule's behaviour for parity with the resolver).
        const existing = await App.storage.normalizeRules.all();
        const order = existing.reduce((m, r) => Math.max(m, r.order || 0), 0) + 1;
        const newRow = {
          pattern: patEnc, flags: 'i',
          display: display.trim(),
          match_hint: match,
          source, order, updated_at: now,
        };
        const id = await App.storage.normalizeRules.put(newRow);
        newRow.id = id;
        row.dispRef = newRow;
      }
      if (N.loadBrandCollapses) await N.loadBrandCollapses();
    }

    // --- Adder form ---
    // Pattern + Match + Display + Category + Save. At least one of
    // Display/Category must be filled; Match defaults to substring.
    function buildCategorySelect(name, value) {
      const sel = el('select', { name, class: 'cat-rule-cat-select' },
        el('option', { value: '' }, '— No category —'));
      distinctCats.forEach(c => {
        const o = el('option', { value: c }, c);
        if (c === value) o.setAttribute('selected', '');
        sel.appendChild(o);
      });
      // Sticky option for legacy values not in the known list.
      if (value && value !== 'Uncategorized' && !distinctCats.includes(value)) {
        const o = el('option', { value }, value + ' (current)');
        o.setAttribute('selected', '');
        sel.appendChild(o);
      }
      sel.appendChild(el('option', { value: '__new' }, '+ New category…'));
      return sel;
    }

    const adder = el('form', {
      class: 'rule-adder',
      onsubmit: async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const pattern = (fd.get('pattern') || '').toString().trim();
        const match   = (fd.get('match')   || 'substring').toString();
        const display = (fd.get('display') || '').toString().trim();
        let category  = (fd.get('category')|| '').toString().trim();
        if (category === '__new') {
          const typed = (fd.get('category_new') || '').toString().trim();
          category = typed;
        }
        if (!pattern) { toast('Pattern is required.', 'warn'); return; }
        if (!display && !category) {
          toast('Set at least one of Display name or Category.', 'warn');
          return;
        }
        if (match === 'regex') {
          try { new RegExp(pattern, 'i'); }
          catch (e2) { toast('Invalid regex: ' + e2.message, 'error'); return; }
        }
        try {
          // Find or create the row by (pattern, match).
          const k = rowKey(pattern, match);
          let row = rowsByKey.get(k);
          if (!row) { row = { pattern, match, catRef: null, dispRef: null }; rowsByKey.set(k, row); }
          if (category) await setCategoryHalf(row, pattern, match, category, 'manual');
          if (display)  await setDisplayHalf(row, pattern, match, display, 'manual');
          toast('Saved rule.', 'success');
          render({ preserveScroll: true });
        } catch (e2) {
          console.error(e2); toast('Save failed: ' + e2.message, 'error');
        }
      },
    });
    const adderMatch = el('select', { name: 'match', class: 'cat-rule-kind-select' },
      el('option', { value: 'substring' }, 'Substring'),
      el('option', { value: 'regex' }, 'Regex'),
      el('option', { value: 'exact' }, 'Exact'),
    );
    adder.appendChild(el('input', { name: 'pattern', type: 'text',
      placeholder: 'Pattern (e.g. LIDL or \\bSPOTIFY\\b)', class: 'mono' }));
    adder.appendChild(adderMatch);
    adder.appendChild(el('input', { name: 'display', type: 'text',
      placeholder: 'Display name (optional)' }));
    // Category select with "+ New…" sentinel, swap-to-input on change.
    const adderCatHolder = el('span', { class: 'rule-adder-cat-holder' });
    function renderAdderCatSelect(initial) {
      adderCatHolder.innerHTML = '';
      const sel = buildCategorySelect('category', initial || '');
      sel.addEventListener('change', (e) => {
        if (e.target.value === '__new') renderAdderCatInput('');
      });
      adderCatHolder.appendChild(sel);
    }
    function renderAdderCatInput(initial) {
      adderCatHolder.innerHTML = '';
      const inp = el('input', { name: 'category_new', type: 'text',
        placeholder: 'New category…', value: initial || '' });
      // Hidden field so the form picks up the sentinel.
      const hidden = el('input', { name: 'category', type: 'hidden', value: '__new' });
      const back = el('button', {
        type: 'button', class: 'btn btn--ghost btn--small',
        onclick: () => renderAdderCatSelect(''),
      }, '⟲');
      adderCatHolder.appendChild(inp);
      adderCatHolder.appendChild(hidden);
      adderCatHolder.appendChild(back);
      inp.focus();
    }
    renderAdderCatSelect('');
    adder.appendChild(adderCatHolder);
    adder.appendChild(el('button', { type: 'submit', class: 'btn btn--primary btn--small' }, 'Add rule'));
    panel.appendChild(adder);

    if (!rows.length) {
      panel.appendChild(el('div', { class: 'empty-state' }, el('p', null, 'No rules yet — add one above.')));
      return;
    }

    // --- Bulk toolbar ---
    const selected = new Set();
    const indexById = new Map(rows.map(u => [u.__id, u]));
    const toolbar = el('div', { class: 'rules-toolbar' });
    const combineBtn = el('button', {
      type: 'button', class: 'btn btn--secondary btn--small', disabled: 'disabled',
      onclick: () => openCombineForm(),
    }, 'Combine selected → regex rule');
    const deleteSelBtn = el('button', {
      type: 'button', class: 'btn btn--ghost btn--small', disabled: 'disabled',
      onclick: async () => {
        if (!selected.size) return;
        const picked = Array.from(selected).map(id => indexById.get(id)).filter(Boolean);
        const preview = picked.slice(0, 5).map(u =>
          '  • ' + u.pattern + (u.dispRef ? ' → ' + (u.dispRef.display || '') : '') +
          (u.catRef ? ' (' + (u.catRef.category || '') + ')' : '')).join('\n');
        const ok = await confirmAction(
          'Delete ' + picked.length + ' rule' + (picked.length === 1 ? '' : 's') + '?\n\n' +
          preview + (picked.length > 5 ? '\n  …' : ''));
        if (!ok) return;
        let touchedDisplay = false;
        for (const u of picked) {
          if (u.catRef)  await App.storage.rules.delete(u.catRef.id);
          if (u.dispRef) { await App.storage.normalizeRules.delete(u.dispRef.id); touchedDisplay = true; }
        }
        if (touchedDisplay && N.loadBrandCollapses) await N.loadBrandCollapses();
        toast('Deleted ' + picked.length + ' rule' + (picked.length === 1 ? '' : 's') + '.', 'success');
        render({ preserveScroll: true });
      },
    }, 'Delete selected');
    const selCount = el('span', { class: 'muted' }, '0 selected');
    toolbar.appendChild(combineBtn);
    toolbar.appendChild(deleteSelBtn);
    toolbar.appendChild(selCount);
    panel.appendChild(toolbar);

    function refreshSelState() {
      selCount.textContent = selected.size + ' selected';
      if (selected.size >= 1) deleteSelBtn.removeAttribute('disabled');
      else deleteSelBtn.setAttribute('disabled', 'disabled');
      if (selected.size >= 2) combineBtn.removeAttribute('disabled');
      else combineBtn.setAttribute('disabled', 'disabled');
    }

    // Combine form. Unions all selected rows' patterns into one regex rule.
    // For each branch we use the encoded-for-regex form so the union works
    // regardless of the original Match mode (substring branches get escaped,
    // regex branches get spliced in verbatim, exact branches keep anchors).
    // Display/Category pre-fill from majority — same display + same category
    // among picked rows means we offer them as defaults.
    function openCombineForm() {
      const existing = panel.querySelector('.combine-form');
      if (existing) existing.remove();
      const picked = Array.from(selected).map(id => indexById.get(id)).filter(Boolean);
      if (picked.length < 2) return;

      const parts = picked.map(u => {
        if (u.match === 'substring') return escRegex(u.pattern);
        if (u.match === 'exact')     return '(?:^' + escRegex(u.pattern) + '$)';
        return '(?:' + u.pattern + ')';
      }).filter(Boolean);
      const suggestedPattern = parts.length === 1 ? parts[0] : '(?:' + parts.join('|') + ')';

      const displays = picked.map(u => u.dispRef && u.dispRef.display).filter(Boolean);
      const cats     = picked.map(u => u.catRef  && u.catRef.category).filter(Boolean);
      const distinctD = Array.from(new Set(displays));
      const distinctC = Array.from(new Set(cats));
      const sugD = distinctD.length === 1 ? distinctD[0] : '';
      const sugC = distinctC.length === 1 ? distinctC[0] : '';

      const form = el('form', {
        class: 'combine-form rule-adder',
        onsubmit: async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const pat = (fd.get('pattern')  || '').toString();
          const dis = (fd.get('display')  || '').toString().trim();
          const cat = (fd.get('category') || '').toString().trim();
          const wipe = !!fd.get('delete_originals');
          if (!pat) { toast('Pattern is required.', 'warn'); return; }
          if (!dis && !cat) { toast('Set at least one of Display name or Category.', 'warn'); return; }
          try { new RegExp(pat, 'i'); }
          catch (e2) { toast('Invalid regex: ' + e2.message, 'error'); return; }
          try {
            const k = rowKey(pat, 'regex');
            let row = rowsByKey.get(k);
            if (!row) { row = { pattern: pat, match: 'regex', catRef: null, dispRef: null }; rowsByKey.set(k, row); }
            if (cat) await setCategoryHalf(row, pat, 'regex', cat, 'manual');
            if (dis) await setDisplayHalf(row, pat, 'regex', dis, 'manual');
            if (wipe) {
              let touchedDisplay = false;
              for (const u of picked) {
                if (u === row) continue;
                if (u.catRef)  await App.storage.rules.delete(u.catRef.id);
                if (u.dispRef) { await App.storage.normalizeRules.delete(u.dispRef.id); touchedDisplay = true; }
              }
              if (touchedDisplay && N.loadBrandCollapses) await N.loadBrandCollapses();
            }
            toast('Combined ' + picked.length + ' rules into one.' + (wipe ? '' : ' (originals kept)'), 'success');
            render({ preserveScroll: true });
          } catch (e2) {
            console.error(e2); toast('Combine failed: ' + e2.message, 'error');
          }
        },
      },
        el('div', { class: 'combine-form__head muted' },
          'Combining ' + picked.length + ' rules into a single regex rule.'),
        el('input', { name: 'pattern', type: 'text', value: suggestedPattern,
          placeholder: 'Regex pattern', class: 'mono' }),
        el('input', { name: 'display', type: 'text', value: sugD,
          placeholder: 'Display name (optional)' }),
        el('input', { name: 'category', type: 'text', value: sugC,
          placeholder: 'Category (optional)' }),
        el('label', { class: 'inline-label muted' },
          el('input', { type: 'checkbox', name: 'delete_originals', checked: '' }),
          ' Delete the originals after combining',
        ),
        el('button', { type: 'submit', class: 'btn btn--primary btn--small' }, 'Save combined rule'),
        el('button', {
          type: 'button', class: 'btn btn--ghost btn--small',
          onclick: () => form.remove(),
        }, 'Cancel'),
      );
      toolbar.insertAdjacentElement('afterend', form);
    }

    // --- Table ---
    const tbl = el('table', { class: 'manage-table' });
    const getRulesSort = () => ({ key: rulesSortKey, dir: rulesSortDir });
    const setRulesSort = (s) => {
      rulesSortKey = s.key; rulesSortDir = s.dir;
      render({ preserveScroll: true });
    };
    tbl.appendChild(el('thead', null, el('tr', null,
      el('th', null, ''),
      sortableTh('Pattern',      'pattern',  getRulesSort, setRulesSort),
      sortableTh('Match',        'match',    getRulesSort, setRulesSort),
      sortableTh('Display name', 'display',  getRulesSort, setRulesSort),
      sortableTh('Category',     'category', getRulesSort, setRulesSort),
      sortableTh('Source',       'source',   getRulesSort, setRulesSort),
      el('th', null, ''),
    )));
    const tbody = el('tbody');

    rows.forEach(u => {
      const chk = el('input', {
        type: 'checkbox',
        onchange: (e) => {
          if (e.target.checked) selected.add(u.__id); else selected.delete(u.__id);
          refreshSelState();
        },
      });

      // Pattern editor — re-encodes BOTH halves when the pattern text
      // changes, since pattern is part of the merge key. Validates regex
      // input. Updates the row's effective pattern in-place; render() will
      // pick up the new encoding from storage on the next pass.
      const patternInput = el('input', {
        type: 'text', value: u.pattern,
        class: u.match === 'substring' ? '' : 'mono',
        onchange: async (e) => {
          const v = (e.target.value || '').trim();
          if (!v) {
            toast('Pattern cannot be empty.', 'warn');
            e.target.value = u.pattern; return;
          }
          if (u.match === 'regex') {
            try { new RegExp(v, 'i'); }
            catch (e2) { toast('Invalid regex: ' + e2.message, 'error'); e.target.value = u.pattern; return; }
          }
          try {
            const dis = u.dispRef ? u.dispRef.display : '';
            const cat = u.catRef  ? u.catRef.category  : '';
            const dispSrc = u.dispRef ? u.dispRef.source : 'manual';
            const catSrc  = u.catRef  ? u.catRef.source  : 'manual';
            // Re-encode each half against the new pattern. We treat this as
            // a manual edit by default unless the existing source was
            // already "manual" — preserves "learned"/"default" lineage when
            // the user is just polishing typo without redefining the rule.
            if (cat) await setCategoryHalf(u, v, u.match, cat, catSrc === 'manual' ? 'manual' : catSrc);
            if (dis) await setDisplayHalf(u, v, u.match, dis, dispSrc === 'manual' ? 'manual' : dispSrc);
            u.pattern = v;
            toast('Saved.', 'success');
            render({ preserveScroll: true });
          } catch (e2) {
            console.error(e2); toast('Save failed: ' + e2.message, 'error');
            e.target.value = u.pattern;
          }
        },
      });

      // Match select — same three options for every row. Switching mode
      // re-encodes both halves so storage stays consistent with the new
      // mode (otherwise an exact rule downgraded to regex would still be
      // stored as `^…$` and re-detected as exact on next render).
      const rowMatch = el('select', {
        class: 'cat-rule-kind-select',
        onchange: async (e) => {
          const want = e.target.value;
          if (want === u.match) return;
          if (want === 'regex') {
            try { new RegExp(u.pattern, 'i'); }
            catch (e2) { toast('Pattern is not a valid regex: ' + e2.message, 'error');
              e.target.value = u.match; return; }
          }
          try {
            const dis = u.dispRef ? u.dispRef.display : '';
            const cat = u.catRef  ? u.catRef.category  : '';
            const dispSrc = u.dispRef ? u.dispRef.source : 'manual';
            const catSrc  = u.catRef  ? u.catRef.source  : 'manual';
            if (cat) await setCategoryHalf(u, u.pattern, want, cat, catSrc);
            if (dis) await setDisplayHalf(u, u.pattern, want, dis, dispSrc);
            u.match = want;
            toast('Saved.', 'success');
            render({ preserveScroll: true });
          } catch (e2) {
            console.error(e2); toast('Save failed: ' + e2.message, 'error');
            e.target.value = u.match;
          }
        },
      },
        el('option', { value: 'substring' }, 'Substring'),
        el('option', { value: 'regex' }, 'Regex'),
        el('option', { value: 'exact' }, 'Exact'),
      );
      rowMatch.value = u.match;

      // Display name editor — empty value clears the display half (deletes
      // the dispRef). Saving re-validates the pattern as a brand pattern.
      const displayInput = el('input', {
        type: 'text',
        value: u.dispRef ? (u.dispRef.display || '') : '',
        placeholder: '—',
        onchange: async (e) => {
          const v = (e.target.value || '').trim();
          try {
            await setDisplayHalf(u, u.pattern, u.match, v, 'manual');
            toast(v ? 'Saved.' : 'Cleared display name.', 'success');
            render({ preserveScroll: true });
          } catch (e2) {
            console.error(e2); toast('Save failed: ' + e2.message, 'error');
            e.target.value = u.dispRef ? (u.dispRef.display || '') : '';
          }
        },
      });

      // Category cell — dropdown with "+ New…" sentinel that swaps in a
      // free-text input. Empty value clears the category half (deletes the
      // catRef). Mirrors the Manage > Transactions per-row pattern.
      const categoryCell = el('td', { class: 'rule-row-category-cell' });
      const cur = u.catRef ? (u.catRef.category || '') : '';
      function renderCatSelect() {
        categoryCell.innerHTML = '';
        const sel = document.createElement('select');
        sel.className = 'cat-rule-cat-select';
        const optEmpty = document.createElement('option');
        optEmpty.value = ''; optEmpty.textContent = '— No category —';
        sel.appendChild(optEmpty);
        distinctCats.forEach(c => {
          const o = document.createElement('option');
          o.value = c; o.textContent = c;
          sel.appendChild(o);
        });
        const liveCur = u.catRef ? (u.catRef.category || '') : '';
        if (liveCur && !distinctCats.includes(liveCur)) {
          const o = document.createElement('option');
          o.value = liveCur; o.textContent = liveCur + ' (current)';
          sel.appendChild(o);
        }
        const optNew = document.createElement('option');
        optNew.value = '__new'; optNew.textContent = '+ New category…';
        sel.appendChild(optNew);
        sel.value = liveCur;
        sel.addEventListener('change', async (e) => {
          const v = e.target.value;
          if (v === '__new') { renderCatInput(''); return; }
          await commitCategory(v);
        });
        categoryCell.appendChild(sel);
      }
      function renderCatInput(initial) {
        categoryCell.innerHTML = '';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'cat-rule-cat-select';
        input.placeholder = 'New category…';
        input.value = initial != null ? initial : (u.catRef ? (u.catRef.category || '') : '');
        const back = document.createElement('button');
        back.type = 'button'; back.className = 'btn btn--ghost btn--small';
        back.textContent = '⟲'; back.title = 'Back to dropdown';
        back.addEventListener('click', renderCatSelect);
        const commit = async () => {
          const v = (input.value || '').trim();
          if (v && !distinctCats.includes(v)) { distinctCats.push(v); distinctCats.sort(); }
          await commitCategory(v);
        };
        input.addEventListener('change', commit);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter')  { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); renderCatSelect(); }
        });
        categoryCell.appendChild(input);
        categoryCell.appendChild(back);
        input.focus(); input.select();
      }
      async function commitCategory(value) {
        try {
          await setCategoryHalf(u, u.pattern, u.match, value, 'manual');
          toast(value ? 'Saved.' : 'Cleared category.', 'success');
          render({ preserveScroll: true });
        } catch (e2) {
          console.error(e2); toast('Save failed: ' + e2.message, 'error');
          renderCatSelect();
        }
      }
      renderCatSelect();
      // Initial cell = `cur` is captured but not used; renderCatSelect reads
      // u.catRef directly so it always reflects the latest state.
      void cur;

      // Source badge — picks the higher-ranked source between the two halves.
      const effSource = pickSource(
        u.catRef && u.catRef.source,
        u.dispRef && u.dispRef.source,
      );
      const lbl = sourceLabel(effSource);
      const sourceBadge = el('span', {
        class: 'rule-source-badge rule-source-badge--' +
          (lbl === 'default' ? 'auto' : 'manual'),
        title: lbl === 'default' ? 'Built-in default'
              : (lbl === 'learned' ? 'Auto-learned from a manual edit' : 'Edited by you'),
      }, lbl);

      const delBtn = el('button', {
        type: 'button', class: 'btn btn--ghost btn--small',
        onclick: async () => {
          const desc = (u.dispRef ? '→ ' + (u.dispRef.display || '') : '') +
                       (u.catRef ? ' (' + (u.catRef.category || '') + ')' : '');
          const ok = await confirmAction('Delete this rule (' + u.pattern + (desc ? ' ' + desc : '') + ')?');
          if (!ok) return;
          try {
            if (u.catRef)  await App.storage.rules.delete(u.catRef.id);
            if (u.dispRef) {
              await App.storage.normalizeRules.delete(u.dispRef.id);
              if (N.loadBrandCollapses) await N.loadBrandCollapses();
            }
            toast('Deleted.', 'success');
            render({ preserveScroll: true });
          } catch (e2) {
            console.error(e2); toast('Delete failed: ' + e2.message, 'error');
          }
        },
      }, 'Delete');

      tbody.appendChild(el('tr', null,
        el('td', null, chk),
        el('td', null, patternInput),
        el('td', null, rowMatch),
        el('td', null, displayInput),
        categoryCell,
        el('td', null, sourceBadge),
        el('td', null, delBtn),
      ));
    });

    tbl.appendChild(tbody);
    panel.appendChild(tbl);

    // --- Reset display defaults ---
    // Re-seeds the brand collapse defaults. Only affects display rules;
    // category rules have no equivalent "reset to defaults" since there are
    // no built-in defaults to restore.
    panel.appendChild(el('div', { class: 'rules-footer' },
      el('button', {
        type: 'button', class: 'btn btn--ghost btn--small',
        onclick: async () => {
          const ok = await confirmAction(
            'Reset display-name rules to the built-in defaults?\n\n' +
            'Your manual display-name edits and additions (including migrated per-merchant overrides) will be lost. ' +
            'Category rules are not affected.');
          if (!ok) return;
          try {
            for (const r of dispRules) await App.storage.normalizeRules.delete(r.id);
            if (N.seedBrandCollapsesIfNeeded) await N.seedBrandCollapsesIfNeeded();
            if (N.loadBrandCollapses)        await N.loadBrandCollapses();
            toast('Restored display-name defaults.', 'success');
            render({ preserveScroll: true });
          } catch (e) {
            console.error(e); toast('Reset failed: ' + e.message, 'error');
          }
        },
      }, 'Reset display-name defaults to built-in')
    ));
  }



  // ---------- Categories ----------
  // Categories are the union of:
  //  - names actively used in `transactions`
  //  - names referenced by `category_rules`
  //  - rows in the `categories` store (which carry metadata like
  //    { name, excluded, notes })
  // Editing a category here persists a row in the categories store keyed by
  // its (case-insensitive) name. Excluded categories are hidden from stats.
  async function renderCategories(panel) {
    const [stored, txs, rules] = await Promise.all([
      App.storage.categories.all(),
      App.storage.transactions.all(),
      App.storage.rules.all(),
    ]);

    const usage = new Map(); // name -> { count, totalByCur: {cur: sum} }
    txs.forEach(t => {
      const name = t.category || 'Uncategorized';
      const u = usage.get(name) || { count: 0, totalByCur: {} };
      u.count++;
      const cur = t.currency || 'EUR';
      u.totalByCur[cur] = (u.totalByCur[cur] || 0) + Math.abs(Number(t.amount) || 0);
      usage.set(name, u);
    });
    rules.forEach(r => {
      if (r.category && !usage.has(r.category)) usage.set(r.category, { count: 0, totalByCur: {} });
    });
    const storedByName = new Map();
    stored.forEach(c => { if (c && c.name) storedByName.set(c.name.toLowerCase(), c); });
    stored.forEach(c => { if (c && c.name && !usage.has(c.name)) usage.set(c.name, { count: 0, totalByCur: {} }); });

    panel.appendChild(el('p', { class: 'muted' },
      'Categories below are aggregated from your imported transactions and rules. ' +
      'Toggle “Exclude from stats” on things like internal transfers, loan repayments, or other flows ' +
      'you don\'t want counted in spending totals. ' +
      'Flag a category as “Income” to control it with the Stats > Include income toggle — ' +
      'refunds in other categories stay visible either way.'));

    // Lazy migration: if no category has been flagged as income yet, auto-
    // flag the one literally named "Income" (case-insensitive) if present.
    // Preserves prior behaviour for users who never opened this tab before.
    if (stored.length && !stored.some(c => c && c.is_income)) {
      const income = stored.find(c => (c.name || '').toLowerCase() === 'income');
      if (income) {
        income.is_income = true;
        await App.storage.categories.put(income);
      }
    }

    // New-category adder.
    const adder = el('form', {
      class: 'rule-adder',
      onsubmit: async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const name = (fd.get('name') || '').toString().trim();
        if (!name) { toast('Category name required.', 'warn'); return; }
        await upsertCategory({ name, excluded: false });
        toast('Category saved.', 'success');
        render();
      },
    },
      el('input', { name: 'name', type: 'text', placeholder: 'New category name' }),
      el('button', { type: 'submit', class: 'btn btn--primary btn--small' }, 'Add category'),
    );
    panel.appendChild(adder);

    if (!usage.size) {
      panel.appendChild(el('div', { class: 'empty-state' }, el('p', null, 'No categories yet.')));
      return;
    }

    const tbl = el('table', { class: 'manage-table' });
    tbl.appendChild(el('thead', null, el('tr', null,
      el('th', null, 'Name'),
      el('th', null, 'Uses'),
      el('th', null, 'Total'),
      el('th', null, 'Income'),
      el('th', null, 'Excluded'),
      el('th', null, ''),
    )));
    const tbody = el('tbody');
    const sorted = Array.from(usage.entries()).sort((a, b) => b[1].count - a[1].count);
    for (const [name, u] of sorted) {
      const storedRow = storedByName.get(name.toLowerCase());
      const excluded = storedRow ? !!storedRow.excluded : false;
      const isIncome = storedRow ? !!storedRow.is_income : false;
      const totalStr = Object.entries(u.totalByCur)
        .map(([cur, v]) => formatCurrency(v, cur))
        .join(', ') || '—';

      const nameInput = el('input', {
        type: 'text', value: name, class: 'category-name-input',
        onchange: async (e) => {
          const newName = e.target.value.trim();
          if (!newName || newName === name) { e.target.value = name; return; }
          await renameCategory(name, newName);
          toast('Renamed.', 'success');
          render();
        },
      });

      const incomeChk = el('input', {
        type: 'checkbox', checked: isIncome ? '' : null,
        title: 'Hide rows in this category when "Include income categories" is off in Stats',
        onchange: async (e) => {
          await upsertCategory({ name, is_income: e.target.checked });
          toast(e.target.checked ? 'Flagged as income.' : 'Unflagged.', 'success');
        },
      });

      const excludedChk = el('input', {
        type: 'checkbox', checked: excluded ? '' : null,
        onchange: async (e) => {
          await upsertCategory({ name, excluded: e.target.checked });
          toast(e.target.checked ? 'Excluded from stats.' : 'Included in stats.', 'success');
        },
      });

      tbody.appendChild(el('tr', null,
        el('td', null, nameInput),
        el('td', null, String(u.count)),
        el('td', null, totalStr),
        el('td', null, incomeChk),
        el('td', null, excludedChk),
        el('td', null, el('button', {
          type: 'button', class: 'btn btn--ghost btn--small',
          onclick: () => deleteCategoryWithReassign(name, u.count, usage),
        }, 'Delete')),
      ));
    }
    tbl.appendChild(tbody);
    panel.appendChild(tbl);
  }

  // Partial merge: only overwrites the fields that were explicitly passed.
  // The Income and Excluded checkboxes share this helper, so blindly writing
  // both every time would clobber whichever one was NOT being edited.
  async function upsertCategory({ name, excluded, is_income }) {
    const all = await App.storage.categories.all();
    const match = all.find(c => (c.name || '').toLowerCase() === name.toLowerCase());
    const patch = {};
    if (excluded  !== undefined) patch.excluded  = !!excluded;
    if (is_income !== undefined) patch.is_income = !!is_income;
    if (match) {
      match.name = name;
      Object.assign(match, patch);
      return App.storage.categories.put(match);
    }
    return App.storage.categories.put(Object.assign({ name }, patch));
  }

  async function renameCategory(oldName, newName) {
    // Update any category store row.
    const all = await App.storage.categories.all();
    const match = all.find(c => (c.name || '').toLowerCase() === oldName.toLowerCase());
    if (match) { match.name = newName; await App.storage.categories.put(match); }
    else await App.storage.categories.put({ name: newName, excluded: false });
    // Rewrite transactions with matching category.
    const txs = await App.storage.transactions.all();
    for (const t of txs) {
      if (t.category === oldName) {
        t.category = newName;
        await App.storage.transactions.update(t);
      }
    }
    // Rewrite rules that point at the old name.
    const rules = await App.storage.rules.all();
    for (const r of rules) {
      if (r.category === oldName) {
        r.category = newName;
        await App.storage.rules.put(r);
      }
    }
  }

  // Ask the user where to move transactions when deleting a category, then
  // rewrite them before dropping the category row itself.
  async function deleteCategoryWithReassign(name, count, usage) {
    const others = Array.from(usage.keys()).filter(n => n !== name).sort();
    const options = [
      { value: '__uncat', label: 'Uncategorized' },
      ...others.map(n => ({ value: n, label: n })),
    ];
    const msg = count
      ? count + ' transaction' + (count === 1 ? '' : 's') + ' use this category. Move them to…'
      : 'This category has no transactions, but we\'ll still remove the entry.';
    const picked = await promptSelect({
      title: 'Delete category "' + name + '"',
      message: msg,
      options,
      confirmLabel: 'Delete & move',
      danger: true,
    });
    if (picked === null) return;
    const target = picked === '__uncat' ? 'Uncategorized' : picked;
    try {
      await deleteCategoryAndReassign(name, target);
      toast('Moved ' + count + ' transaction' + (count === 1 ? '' : 's') +
        ' to "' + target + '".', 'success');
      render();
    } catch (e) {
      console.error(e);
      toast('Delete failed: ' + e.message, 'error');
    }
  }

  async function deleteCategoryAndReassign(name, target) {
    target = target || 'Uncategorized';
    const all = await App.storage.categories.all();
    const match = all.find(c => (c.name || '').toLowerCase() === name.toLowerCase());
    if (match) await App.storage.categories.delete(match.id);
    const txs = await App.storage.transactions.all();
    for (const t of txs) {
      if (t.category === name) {
        t.category = target;
        await App.storage.transactions.update(t);
      }
    }
  }

  // ---------- Duplicates ----------
  // Stable signature for a group of rows — sorted transaction ids joined.
  // Dismissing a group stores this signature in the duplicate_ignores store
  // so the group won't be flagged again as long as the same rows still exist.
  function duplicateSignature(group) {
    const ids = (group.rows || []).map(r => r.id).filter(x => x != null).slice().sort((a, b) => a - b);
    return ids.join('-');
  }

  async function renderDuplicates(panel) {
    const [txs, accounts, ignores, imports] = await Promise.all([
      App.storage.transactions.all(),
      App.storage.accounts.all(),
      App.storage.duplicateIgnores.all(),
      App.storage.imports.all().catch(() => []),
    ]);
    const ignoredSet = new Set((ignores || []).map(i => i.signature).filter(Boolean));
    const accName = (id) => {
      const a = accounts.find(x => x.id === id);
      return a ? a.name : (id == null ? '—' : '#' + id);
    };
    // Mirrors the helper in renderTransactions — see the long comment
    // there for the resolution chain. Short version: per-row source_file
    // wins; otherwise fall back through the batch's files[] (single file
    // → unambiguous; multi-file → match by bank against the row's
    // account); otherwise fall back to the batch's `source` label.
    const importsByBatch = new Map();
    (imports || []).forEach(b => { if (b && b.batch_id) importsByBatch.set(b.batch_id, b); });
    const accountById = new Map();
    (accounts || []).forEach(a => { if (a && a.id != null) accountById.set(a.id, a); });
    function fileFor(t) {
      return resolveSourceFile(t, importsByBatch, accountById);
    }
    const allGroups = App.processing.duplicate.findDuplicatesWithin(txs);
    const groups = allGroups.filter(g => !ignoredSet.has(duplicateSignature(g)));
    const dismissedCount = allGroups.length - groups.length;

    panel.appendChild(el('p', { class: 'muted' },
      'Groups of transactions that look like duplicates (same account + amount, same or adjacent date, overlapping merchant). ' +
      'Review each group and remove the copies you don\'t want, or click "This is OK" to dismiss.'));

    if (dismissedCount) {
      panel.appendChild(el('div', { class: 'duplicate-dismissed-note' },
        el('span', { class: 'muted' },
          dismissedCount + ' group' + (dismissedCount === 1 ? ' was' : 's were') + ' previously marked OK.'),
        ' ',
        el('button', {
          type: 'button', class: 'linklike',
          onclick: async () => {
            for (const ig of ignores) await App.storage.duplicateIgnores.delete(ig.id);
            toast('Cleared dismissed duplicates.', 'success');
            render();
          },
        }, 'Show them again'),
      ));
    }

    if (!groups.length) {
      panel.appendChild(el('div', { class: 'empty-state' },
        el('h3', null, 'No duplicates to review'),
        el('p', null, dismissedCount
          ? 'The remaining groups are all marked OK.'
          : 'Nothing in your DB looks duplicated right now.')));
      return;
    }
    panel.appendChild(el('p', { class: 'muted' }, groups.length + ' duplicate group' + (groups.length === 1 ? '' : 's') + ':'));

    groups.forEach((g, gi) => {
      const card = el('div', { class: 'duplicate-group duplicate-group--' + g.severity });
      const sig = duplicateSignature(g);
      card.appendChild(el('div', { class: 'duplicate-group__head' },
        el('span', { class: 'pill pill--' + g.severity },
          g.severity === 'hard' ? 'Duplicate' : 'Possible duplicate'),
        ' ',
        el('span', { class: 'muted' }, g.rows.length + ' rows'),
        el('span', { class: 'spacer' }, ''),
        el('button', {
          type: 'button', class: 'btn btn--ghost btn--small duplicate-ok-btn',
          onclick: async () => {
            if (!sig) {
              toast('Cannot dismiss a group without stored ids.', 'warn');
              return;
            }
            await App.storage.duplicateIgnores.put({
              signature: sig,
              created_at: new Date().toISOString(),
            });
            toast('Marked OK.', 'success');
            render();
          },
        }, 'This is OK'),
      ));
      const tbl = el('table', { class: 'manage-table duplicate-table' });
      tbl.appendChild(el('thead', null, el('tr', null,
        el('th', null, 'Date'),
        el('th', null, 'Merchant'),
        el('th', null, 'Category'),
        el('th', null, 'Account'),
        el('th', { class: 'num' }, 'Amount'),
        // Source filename column — surfaces which import each row came
        // from so it's easy to see whether a "duplicate" pair is one
        // statement loaded twice or two genuinely overlapping batches.
        el('th', null, 'File'),
        el('th', null, ''),
      )));
      const tbody = el('tbody');
      g.rows.forEach((r) => {
        const sourceFile = fileFor(r);
        tbody.appendChild(el('tr', null,
          el('td', null, r.date || ''),
          el('td', null, r.merchant || ''),
          el('td', null, r.category || ''),
          el('td', null, accName(r.account_id)),
          el('td', { class: 'num' },
            (r.kind === 'expense' ? '−' : '+') + formatCurrency(r.amount, r.currency)),
          el('td', { class: 'tx-file-cell muted', title: sourceFile || '' },
            sourceFile || '—'),
          el('td', null, el('button', {
            type: 'button', class: 'btn btn--ghost btn--small',
            onclick: async () => {
              const ok = await confirmAction('Delete this transaction? (' + (r.merchant || 'no merchant') + ', ' + r.date + ')');
              if (!ok) return;
              await App.storage.transactions.delete(r.id);
              toast('Deleted.', 'success');
              render();
            },
          }, 'Delete')),
        ));
      });
      tbl.appendChild(tbody);
      card.appendChild(tbl);
      panel.appendChild(card);
    });
  }

  // ---------- Transactions ----------
  async function renderTransactions(panel) {
    const [txs, accounts, merchantRows, imports] = await Promise.all([
      App.storage.transactions.all(),
      App.storage.accounts.all(),
      App.storage.merchants.all(),
      App.storage.imports.all().catch(() => []),
    ]);
    const accName = (id) => {
      const a = accounts.find(x => x.id === id);
      return a ? a.name : (id == null ? '—' : '#' + id);
    };
    // Resolve a transaction's source filename — see resolveSourceFile()
    // for the resolution chain.
    const importsByBatch = new Map();
    (imports || []).forEach(b => { if (b && b.batch_id) importsByBatch.set(b.batch_id, b); });
    const accountById = new Map();
    (accounts || []).forEach(a => { if (a && a.id != null) accountById.set(a.id, a); });
    function fileFor(t) {
      return resolveSourceFile(t, importsByBatch, accountById);
    }
    // Datalist feed for the bulk-category input.
    const knownCats = Array.from(new Set(txs
      .map(t => t.category)
      .filter(c => c && c !== 'Uncategorized'))).sort();

    // Canonical transaction-type vocabulary and per-row resolver. Falls
    // back to normalizing the template's raw.transaction_type so legacy
    // rows without a top-level `type` still show something useful.
    const N = (App.processing && App.processing.normalize) || {};
    const TX_TYPES = N.TX_TYPE_VOCAB || ['Card', 'Transfer', 'MB Way', 'ATM', 'Direct Debit', 'Fee', 'Other'];
    function typeOf(t) {
      if (t && t.type) return t.type;
      const raw = t && t.raw && t.raw.transaction_type;
      if (N.normalizeTxType) return N.normalizeTxType(raw);
      return 'Other';
    }

    // Merchant display-name plumbing. Overrides keyed by the raw original
    // string mean a single edit naturally propagates to every transaction
    // sharing that original — the display column below is effectively
    // editing the group, not just one row.
    const { beautifyMerchant } = N;
    const mByOriginal = new Map();   // original -> merchants row
    (merchantRows || []).forEach(m => {
      if (m && m.original) mByOriginal.set(m.original, m);
    });
    const siblingCount = new Map();  // original -> # of transactions sharing it
    txs.forEach(t => {
      const raw = (t.merchant || '').trim();
      if (!raw) return;
      siblingCount.set(raw, (siblingCount.get(raw) || 0) + 1);
    });
    function displayFor(original) {
      if (!original) return '';
      const row = mByOriginal.get(original);
      if (row && row.display && row.display.trim()) return row.display;
      const pretty = beautifyMerchant ? beautifyMerchant(original) : original;
      return pretty || original;
    }
    function suggestionFor(original) {
      if (!original) return '';
      return (beautifyMerchant ? beautifyMerchant(original) : original) || original;
    }

    // Selection state lives in a Set of transaction ids scoped to this
    // render call — navigating away and back resets it (by design).
    const selected = new Set();

    panel.appendChild(el('p', { class: 'muted' },
      'Search hits every column — merchant, category, account, type, date, amount, notes, and source filename. ' +
      'Use the filters below to narrow by category, account, or transaction type. ' +
      'Date, display name, category, account, and type are editable inline on every row. ' +
      'Select rows to bulk-edit; one Apply button writes every field you set, fields left blank are skipped. ' +
      'The lock column pins a row so future rule sweeps and re-imports leave its category and display name alone — manual edits auto-lock the row.'));

    const searchRow = el('div', { class: 'tx-search-row' },
      el('input', {
        type: 'text', value: txSearch,
        placeholder: 'Search merchant, category, account, date, amount, notes, file…',
        class: 'tx-search',
        oninput: (e) => { txSearch = e.target.value; refreshTxList(); },
      }),
      el('span', { class: 'muted tx-count' }, ''),
    );
    panel.appendChild(searchRow);

    // Dedicated filter row: scoped pickers that the unified search can't
    // express ergonomically (we don't want "Lidl" the merchant matching
    // category "Groceries" by accident — these stay structured). The old
    // free-text "Merchant contains…" input was retired now that the top
    // search hits every field including the merchant.
    const distinctCats = Array.from(new Set(
      txs.map(t => t.category || 'Uncategorized').filter(Boolean)
    )).sort();
    const categorySelect = el('select', {
      class: 'tx-filter-input',
      onchange: (e) => { txCategory = e.target.value; refreshTxList(); },
    },
      el('option', { value: '' }, 'All categories'),
      ...distinctCats.map(c => el('option', {
        value: c === 'Uncategorized' ? '__uncat' : c,
        selected: (txCategory === (c === 'Uncategorized' ? '__uncat' : c)) ? '' : null,
      }, c)),
    );
    const accountSelect = el('select', {
      class: 'tx-filter-input',
      onchange: (e) => { txAccount = e.target.value; refreshTxList(); },
    },
      el('option', { value: '' }, 'All accounts'),
      el('option', {
        value: '__none',
        selected: txAccount === '__none' ? '' : null,
      }, '— Unassigned —'),
      ...accounts.map(a => el('option', {
        value: String(a.id),
        selected: txAccount === String(a.id) ? '' : null,
      }, a.name + (a.currency ? ' (' + a.currency + ')' : ''))),
    );
    const typeSelect = el('select', {
      class: 'tx-filter-input',
      onchange: (e) => { txType = e.target.value; refreshTxList(); },
    },
      el('option', { value: '' }, 'All types'),
      ...TX_TYPES.map(t => el('option', {
        value: t,
        selected: txType === t ? '' : null,
      }, t)),
    );
    const filterRow = el('div', { class: 'tx-filter-row' },
      categorySelect,
      accountSelect,
      typeSelect,
      el('button', {
        type: 'button', class: 'btn btn--ghost btn--small',
        onclick: () => {
          txCategory = ''; txAccount = ''; txSearch = ''; txType = '';
          categorySelect.value = ''; accountSelect.value = '';
          typeSelect.value = '';
          const srch = searchRow.querySelector('.tx-search');
          if (srch) srch.value = '';
          refreshTxList();
        },
      }, 'Clear filters'),
    );
    panel.appendChild(filterRow);

    // ----- Bulk toolbar -----
    //
    // Five field inputs + ONE Apply button. The user fills in whichever
    // fields they want to set; on Apply, we build a patch from non-empty
    // values and write it to every selected row in a single pass. Empty
    // fields are skipped so a "set just the category" workflow only
    // touches `category`. The display-name input is special: it doesn't
    // patch the transaction directly, it upserts a merchant-display rule
    // for each affected `merchant` original — handled inside the same
    // Apply click.
    const bulkDateInput = el('input', {
      type: 'date',
      class: 'tx-bulk-input',
      title: 'Set date for every selected row (blank = leave dates alone)',
    });
    const bulkCategorySelect = el('select', { class: 'tx-bulk-input' },
      el('option', { value: '' }, 'Set category…'),
      ...knownCats.map(c => el('option', { value: c }, c)),
      el('option', { value: '__new' }, '+ New category…'),
    );
    const bulkCategoryInput = el('input', {
      type: 'text', placeholder: 'New category name…',
      list: 'tx-bulk-categories', class: 'tx-bulk-input hidden',
    });
    const bulkCategoriesDatalist = el('datalist', { id: 'tx-bulk-categories' },
      ...knownCats.map(c => el('option', { value: c })));
    panel.appendChild(bulkCategoriesDatalist);
    bulkCategorySelect.addEventListener('change', () => {
      const isNew = bulkCategorySelect.value === '__new';
      bulkCategoryInput.classList.toggle('hidden', !isNew);
      if (isNew) { bulkCategoryInput.value = ''; bulkCategoryInput.focus(); }
    });
    function readBulkCategory() {
      const v = bulkCategorySelect.value;
      if (v === '__new') return (bulkCategoryInput.value || '').trim() || null;
      return v ? v : null;
    }
    const bulkAccountSelect = el('select', { class: 'tx-bulk-input' },
      el('option', { value: '' }, 'Set account…'),
      ...accounts.map(a => el('option', { value: String(a.id) },
        a.name + (a.currency ? ' (' + a.currency + ')' : ''))),
    );
    const bulkDisplayInput = el('input', {
      type: 'text', class: 'tx-bulk-input',
      placeholder: 'Set display name… (blank = no change)',
      title: 'Saved as a merchant-display rule keyed by each row\'s original. Blank means "no change" — to revert a merchant to the auto-suggestion, edit the row inline and clear the field.',
    });
    const bulkTypeSelect = el('select', { class: 'tx-bulk-input' },
      el('option', { value: '' }, 'Set transaction type…'),
      ...TX_TYPES.map(t => el('option', { value: t }, t)),
    );

    const bulkCountSpan = el('span', { class: 'muted tx-bulk-count' }, '0 selected');

    // The single Apply button. Builds a patch from every input that has a
    // value, applies it to every selected row in one pass, and (if a
    // display name was set) upserts a merchant rule per distinct original
    // among the selection. If nothing was set, we toast and bail.
    const applyBulkBtn = el('button', {
      type: 'button', class: 'btn btn--primary btn--small',
      onclick: async () => {
        const patch = {};
        const cat = readBulkCategory();
        if (cat) patch.category = cat;
        if (bulkAccountSelect.value) {
          const id = parseInt(bulkAccountSelect.value, 10);
          patch.account_id = id;
          const acct = accounts.find(a => a.id === id);
          if (acct && acct.iban) patch.card = acct.iban.replace(/\s+/g, '').slice(-4);
        }
        if (bulkTypeSelect.value) patch.type = bulkTypeSelect.value;
        if (bulkDateInput.value) {
          const d = bulkDateInput.value; // YYYY-MM-DD per <input type="date">
          patch.date = d;
          const m = /^(\d{4})-(\d{2})/.exec(d);
          if (m) {
            patch.year  = parseInt(m[1], 10);
            patch.month = monthName(parseInt(m[2], 10));
          }
        }
        const newDisplay = (bulkDisplayInput.value || '').trim();
        const hasAnyPatch = Object.keys(patch).length > 0;
        const hasDisplay  = newDisplay.length > 0;
        if (!hasAnyPatch && !hasDisplay) {
          toast('Fill at least one field before applying.', 'warn');
          return;
        }
        if (hasAnyPatch) await applyBulk(patch);
        if (hasDisplay)  await applyBulkDisplay(newDisplay);
        // Reset every input so the user doesn't re-apply by accident on
        // the next click.
        bulkDateInput.value = '';
        bulkCategorySelect.value = '';
        bulkCategoryInput.value = '';
        bulkCategoryInput.classList.add('hidden');
        bulkAccountSelect.value = '';
        bulkTypeSelect.value = '';
        bulkDisplayInput.value = '';
      },
    }, 'Apply');

    const bulkBar = el('div', { class: 'tx-bulk-bar hidden' },
      bulkCountSpan,
      el('span', { class: 'spacer' }, ''),
      bulkDateInput,
      bulkCategorySelect,
      bulkCategoryInput,
      bulkAccountSelect,
      bulkTypeSelect,
      bulkDisplayInput,
      applyBulkBtn,
      el('button', {
        type: 'button', class: 'btn btn--ghost btn--small',
        onclick: () => { selected.clear(); refreshTxList(); },
      }, 'Clear selection'),
    );
    panel.appendChild(bulkBar);

    const tblWrap = el('div', { class: 'tx-table-wrap' });
    panel.appendChild(tblWrap);

    const footer = el('div', { class: 'tx-footer' });
    panel.appendChild(footer);

    // Upsert a display-name override keyed by the raw original string.
    // Delegates to the normalize_rules store via
    // `saveExactDisplayOverride` — legacy merchants-store writes were
    // migrated into regex-anchored rules so both auto-generated brand
    // collapses and manual per-merchant overrides share one source of
    // truth. Empty display wipes the rule so the beautifier takes over.
    async function saveMerchantOverride(original, display) {
      const N = (App.processing && App.processing.normalize) || {};
      const clean = (display || '').trim();
      // Keep the local cache in sync so the table re-renders correctly
      // without a round trip. The `mByOriginal` Map is now only a render
      // cache — the authoritative store is normalize_rules.
      if (!clean) {
        if (mByOriginal.has(original)) mByOriginal.delete(original);
        if (N.saveExactDisplayOverride) await N.saveExactDisplayOverride(original, '');
        return null;
      }
      if (N.saveExactDisplayOverride) await N.saveExactDisplayOverride(original, clean);
      const row = { original, display: clean, updated_at: new Date().toISOString() };
      mByOriginal.set(original, row);
      return row;
    }

    // Save a patch to every selected row. The user asked for bulk edit to
    // commit without an extra confirmation popup — Apply is the commit.
    async function applyBulk(patch) {
      const ids = Array.from(selected);
      if (!ids.length) { toast('No rows selected.', 'warn'); return; }
      if (!Object.keys(patch).some(k => patch[k] != null)) {
        toast('Nothing to apply.', 'warn'); return;
      }
      try {
        // Collect display names touched by a category patch so we can
        // auto-learn one rule per *merchant* (not per transaction) after
        // the writes commit. Keyed by lowercase-trimmed display so two
        // capitalisation variants of the same brand dedupe into one rule.
        const learnKeys = new Map();
        // Bulk category edit auto-locks the affected rows for the same
        // reason a single-row edit does — the user explicitly chose this
        // category, and rules shouldn't walk it back. We don't auto-lock
        // for type / account-only patches; those aren't the rules engine's
        // territory.
        const shouldLock = patch.category != null;
        for (const id of ids) {
          const cur = await App.storage.transactions.get(id);
          if (!cur) continue;
          const merged = Object.assign({}, cur, patch);
          if (shouldLock) merged.locked = true;
          await App.storage.transactions.put(merged);
          // Keep local copy in sync so the list re-renders correctly.
          const local = txs.find(t => t.id === id);
          if (local) {
            Object.assign(local, patch);
            if (shouldLock) local.locked = true;
          }
          if (patch.category && patch.category !== 'Uncategorized') {
            const key = displayFor((cur.merchant || '').trim()) || (cur.merchant || '').trim();
            if (key) learnKeys.set(key.toLowerCase(), key);
          }
        }
        // Fire-and-forget: auto-learning shouldn't block the toast.
        if (patch.category && learnKeys.size) {
          Promise.all(Array.from(learnKeys.values()).map(k =>
            App.processing.categorize.learnCategoryRule(k, patch.category)
          )).catch(() => { /* non-fatal */ });
        }
        toast('Updated ' + ids.length + ' row' + (ids.length === 1 ? '' : 's') + '.', 'success');
        selected.clear();
        if (patch.category) {
          // Teach the dropdown about any brand-new category right away so
          // a follow-up bulk-apply can pick it without a page reload.
          if (!knownCats.includes(patch.category)) {
            knownCats.push(patch.category); knownCats.sort();
            const before = bulkCategorySelect.querySelector('option[value="__new"]');
            const opt = el('option', { value: patch.category }, patch.category);
            if (before) bulkCategorySelect.insertBefore(opt, before);
            else bulkCategorySelect.appendChild(opt);
            bulkCategoriesDatalist.appendChild(el('option', { value: patch.category }));
          }
          bulkCategorySelect.value = '';
          bulkCategoryInput.value = '';
          bulkCategoryInput.classList.add('hidden');
        }
        if (patch.account_id != null) bulkAccountSelect.value = '';
        if (patch.type) bulkTypeSelect.value = '';
        refreshTxList();
      } catch (e) {
        console.error(e);
        toast('Bulk update failed: ' + e.message, 'error');
      }
    }

    // Display-name bulk edit. Overrides live in the merchants store keyed by
    // the *original* string, so a bulk edit touches one row per distinct
    // original among the selection — not one per transaction — and every
    // sibling picks the new display automatically. Empty value = revert all
    // affected originals to the beautifier.
    async function applyBulkDisplay(value) {
      const ids = Array.from(selected);
      if (!ids.length) { toast('No rows selected.', 'warn'); return; }
      const clean = (value || '').trim();
      // Group selected rows by original merchant. Rows without a merchant
      // are skipped — there's nothing to key an override on.
      const originals = new Set();
      ids.forEach(id => {
        const local = txs.find(t => t.id === id);
        if (local && local.merchant) originals.add(local.merchant.trim());
      });
      if (!originals.size) { toast('Selected rows have no merchant to rename.', 'warn'); return; }
      try {
        let touched = 0;
        for (const original of originals) {
          await saveMerchantOverride(original, clean);
          touched++;
        }
        toast(clean
          ? 'Applied display name to ' + touched + ' merchant group' + (touched === 1 ? '' : 's') + '.'
          : 'Reverted ' + touched + ' merchant group' + (touched === 1 ? '' : 's') + ' to auto-suggestion.',
          'success');
        bulkDisplayInput.value = '';
        selected.clear();
        refreshTxList();
      } catch (e) {
        console.error(e);
        toast('Bulk display update failed: ' + e.message, 'error');
      }
    }

    function refreshTxList() {
      const q = (txSearch || '').toLowerCase().trim();
      const catFilter = txCategory || '';
      const acctFilter = txAccount || '';
      const typeFilter = txType || '';
      const matches = txs.filter(t => {
        if (q) {
          // Unified search: hit every column the user can see plus the
          // raw merchant + notes/description + source filename. Cheap
          // string match — case-insensitive substring across the lot.
          const merchantOriginal = (t.merchant || '');
          const merchantDisplay  = displayFor(merchantOriginal.trim()) || merchantOriginal;
          const haystack = [
            merchantDisplay,
            merchantOriginal,
            t.category || 'Uncategorized',
            accName(t.account_id),
            typeOf(t),
            t.date || '',
            String(t.amount || ''),
            t.description || '',
            fileFor(t),
          ].join('  ').toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        if (typeFilter && typeOf(t) !== typeFilter) return false;
        if (catFilter) {
          const catName = t.category || 'Uncategorized';
          if (catFilter === '__uncat') {
            if (catName !== 'Uncategorized') return false;
          } else if (catName !== catFilter) {
            return false;
          }
        }
        if (acctFilter) {
          if (acctFilter === '__none') {
            if (t.account_id != null) return false;
          } else if (String(t.account_id) !== acctFilter) {
            return false;
          }
        }
        return true;
      });
      // Sort: user-chosen column when txSortKey is set, otherwise newest-first
      // by date (the natural default). Amount is compared by absolute value so
      // "biggest first" and "smallest first" behave intuitively regardless of
      // sign (refunds and charges).
      if (txSortKey) {
        const txSortValue = (t, key) => {
          if (key === 'date')     return t.date || '';
          if (key === 'merchant') return displayFor((t.merchant || '').trim()) || '';
          if (key === 'category') return t.category || 'Uncategorized';
          if (key === 'account')  return accName(t.account_id);
          if (key === 'type')     return typeOf(t) || '';
          if (key === 'amount')   return Math.abs(Number(t.amount) || 0);
          if (key === 'file')     return fileFor(t) || '';
          return '';
        };
        const dir = txSortDir === 'desc' ? -1 : 1;
        matches.sort((a, b) => {
          const primary = cmpBy(txSortValue(a, txSortKey), txSortValue(b, txSortKey)) * dir;
          if (primary) return primary;
          // Tie-breaker: id keeps the order stable between renders.
          return (a.id || 0) - (b.id || 0);
        });
      } else {
        matches.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      }
      const shown = matches.slice(0, txLimit);

      // Prune selections that fell out of the visible window so the count
      // stays meaningful when the user searches.
      const visibleIds = new Set(shown.map(r => r.id));
      Array.from(selected).forEach(id => { if (!visibleIds.has(id)) selected.delete(id); });

      searchRow.querySelector('.tx-count').textContent =
        matches.length + ' match' + (matches.length === 1 ? '' : 'es') +
        (matches.length > shown.length ? ' — showing first ' + shown.length : '');

      updateBulkBar();

      tblWrap.innerHTML = '';
      if (!shown.length) {
        tblWrap.appendChild(el('div', { class: 'empty-state' },
          el('p', null, q ? 'No transactions match your search.' : 'No transactions stored yet.')));
        footer.innerHTML = '';
        return;
      }

      const tbl = el('table', { class: 'manage-table tx-table' });
      const headerCheckbox = el('input', {
        type: 'checkbox',
        onchange: (e) => {
          if (e.target.checked) shown.forEach(r => { if (r.id != null) selected.add(r.id); });
          else selected.clear();
          refreshTxList();
        },
      });
      if (shown.length && shown.every(r => r.id != null && selected.has(r.id))) {
        headerCheckbox.checked = true;
      }
      const getTxSort = () => ({ key: txSortKey, dir: txSortDir });
      const setTxSort = (s) => {
        txSortKey = s.key; txSortDir = s.dir;
        refreshTxList();
      };
      // Amount header wears `num` so the label right-aligns with the column,
      // but we still want it clickable — tack the sortable-th class on top
      // via the class string.
      const amountTh = sortableTh('Amount', 'amount', getTxSort, setTxSort);
      amountTh.className = (amountTh.className || '') + ' num';
      tbl.appendChild(el('thead', null, el('tr', null,
        el('th', { class: 'tx-checkbox-col' }, headerCheckbox),
        sortableTh('Date',     'date',     getTxSort, setTxSort),
        // Single merchant column: display name on top (editable), original
        // below in muted small text. Sorts on the display name.
        sortableTh('Merchant', 'merchant', getTxSort, setTxSort),
        sortableTh('Category', 'category', getTxSort, setTxSort),
        sortableTh('Account',  'account',  getTxSort, setTxSort),
        sortableTh('Type',     'type',     getTxSort, setTxSort),
        amountTh,
        // Source filename — shown in muted small text. Sortable so the
        // user can group rows by which import they came from.
        sortableTh('File',     'file',     getTxSort, setTxSort),
        // Lock column: shows whether this row is pinned and ignored by
        // category / display-name rules. Clicking toggles. Locks are auto-
        // set when the user manually edits a row's category or display.
        el('th', { class: 'tx-lock-col', title: 'Locked rows are not touched by category rules or merchant brand-collapses.' }, '🔒'),
        el('th', null, ''),
      )));
      const tbody = el('tbody');
      shown.forEach(r => {
        const checked = r.id != null && selected.has(r.id);
        const original = (r.merchant || '').trim();
        const suggested = suggestionFor(original);
        const override = mByOriginal.get(original);
        const currentDisplay = (override && override.display) ? override.display : '';
        const siblings = siblingCount.get(original) || 0;

        // Display-name input: placeholder = beautifier suggestion so leaving
        // it empty means "use the auto-suggestion". Saving fires the
        // sibling-count confirmation when more than one transaction shares
        // this original — the override is keyed by the original string so
        // all siblings update together.
        const displayInput = el('input', {
          type: 'text',
          class: 'tx-display-input',
          value: currentDisplay,
          placeholder: suggested,
          disabled: original ? null : '',
          title: original
            ? (siblings > 1
              ? 'Edits apply to all ' + siblings + ' transactions with this original name.'
              : 'Edits apply only to this transaction (no others share this original).')
            : 'No merchant on this row.',
          onchange: async (e) => {
            const newVal = (e.target.value || '').trim();
            const prev = currentDisplay;
            if (newVal === prev) return;
            if (!original) return;
            if (siblings > 1) {
              const msg = newVal
                ? 'Apply "' + newVal + '" as the display name for all ' + siblings +
                  ' transactions with original "' + original + '"? ' +
                  'This overrides any existing display name.'
                : 'Clear the custom display name for all ' + siblings +
                  ' transactions with original "' + original + '" and revert to the auto-suggestion?';
              const ok = await confirmAction(msg);
              if (!ok) { e.target.value = prev; return; }
            }
            try {
              await saveMerchantOverride(original, newVal);
              // Auto-lock this specific row so future rule sweeps don't
              // walk back the manual choice. Siblings sharing the same
              // original still pick up the new display via the merchant
              // rule above; only this transaction is pinned.
              if (r.id != null && !r.locked) {
                try {
                  const cur = await App.storage.transactions.get(r.id);
                  if (cur) {
                    const next = Object.assign({}, cur, { locked: true });
                    await App.storage.transactions.put(next);
                    r.locked = true;
                  }
                } catch (e) { /* non-fatal */ }
              }
              toast(newVal ? 'Display name saved (row locked).' : 'Reverted to auto-suggestion.', 'success');
              refreshTxList();
            } catch (err) {
              console.error(err);
              toast('Save failed: ' + err.message, 'error');
              e.target.value = prev;
            }
          },
        });
        const displayHint = (!currentDisplay && suggested && original && suggested !== original)
          ? el('span', { class: 'muted tx-display-hint' }, 'auto')
          : (siblings > 1
              ? el('span', { class: 'muted tx-display-hint' }, '×' + siblings)
              : null);
        // Merged merchant cell: display-name input on top, original string
        // below in muted text so the two stay visually tied without eating
        // an extra column. The input keeps the same id/behaviour as before.
        const displayCell = el('td', { class: 'tx-merchant-cell' });
        const displayRow = el('div', { class: 'tx-merchant-cell__display' }, displayInput);
        if (displayHint) displayRow.appendChild(displayHint);
        displayCell.appendChild(displayRow);
        if (original) {
          displayCell.appendChild(el('div', {
            class: 'tx-merchant-cell__original muted',
            title: original,
          }, original));
        }

        // Per-row type <select>: the user can override the auto-derived
        // value inline. Saving writes the canonical string to the row's
        // top-level `type` field (defaulting derived rows to 'Other' only
        // on user commit — we don't persist a synthetic value just because
        // the row was rendered).
        const currentType = typeOf(r);
        const typeSelectRow = el('select', {
          class: 'tx-type-input',
          disabled: r.id == null ? '' : null,
          onchange: async (e) => {
            const v = e.target.value;
            try {
              const cur = await App.storage.transactions.get(r.id);
              if (!cur) return;
              const next = Object.assign({}, cur, { type: v });
              await App.storage.transactions.put(next);
              r.type = v;
              toast('Type saved.', 'success');
            } catch (err) {
              console.error(err);
              toast('Save failed: ' + err.message, 'error');
              e.target.value = currentType;
            }
          },
        },
          ...TX_TYPES.map(t => el('option', {
            value: t, selected: t === currentType ? '' : null,
          }, t)),
        );

        // Per-row category <select>: dropdown over distinctCats with a
        // sentinel "+ New category…" that swaps the cell for a free-text
        // input (same UX as bulk edit). On save we update the row in IDB
        // and teach the table about the new name so future rows see it
        // without a reload.
        const categoryCell = el('td', { class: 'tx-row-category-cell' });
        function renderCategorySelect() {
          categoryCell.innerHTML = '';
          const sel = document.createElement('select');
          sel.className = 'tx-category-input';
          if (r.id == null) sel.disabled = true;
          const optEmpty = document.createElement('option');
          optEmpty.value = ''; optEmpty.textContent = '— Uncategorized —';
          sel.appendChild(optEmpty);
          // distinctCats already includes "Uncategorized"; filter it so the
          // empty option is the canonical choice.
          distinctCats.forEach(c => {
            if (c === 'Uncategorized') return;
            const o = document.createElement('option');
            o.value = c; o.textContent = c;
            sel.appendChild(o);
          });
          // If the row's value isn't in the known list (e.g. legacy data),
          // surface it as a sticky option so the user doesn't lose it.
          const cur = r.category || '';
          if (cur && cur !== 'Uncategorized' && !distinctCats.includes(cur)) {
            const o = document.createElement('option');
            o.value = cur; o.textContent = cur + ' (current)';
            sel.appendChild(o);
          }
          const optNew = document.createElement('option');
          optNew.value = '__new'; optNew.textContent = '+ New category…';
          sel.appendChild(optNew);
          sel.value = (!cur || cur === 'Uncategorized') ? '' : cur;
          sel.addEventListener('change', async (e) => {
            const v = e.target.value;
            if (v === '__new') { renderCategoryInput(''); return; }
            await saveRowCategory(v || null);
          });
          categoryCell.appendChild(sel);
        }
        function renderCategoryInput(initial) {
          categoryCell.innerHTML = '';
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'tx-category-input';
          input.placeholder = 'New category…';
          input.value = initial != null ? initial : (r.category || '');
          const back = document.createElement('button');
          back.type = 'button';
          back.className = 'btn btn--ghost btn--small';
          back.textContent = '⟲';
          back.title = 'Back to dropdown';
          back.addEventListener('click', renderCategorySelect);
          const commit = async () => {
            const v = (input.value || '').trim();
            if (v && !distinctCats.includes(v)) {
              distinctCats.push(v); distinctCats.sort();
            }
            await saveRowCategory(v || null);
            renderCategorySelect();
          };
          input.addEventListener('change', commit);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); renderCategorySelect(); }
          });
          categoryCell.appendChild(input);
          categoryCell.appendChild(back);
          input.focus(); input.select();
        }
        async function saveRowCategory(value) {
          if (r.id == null) return;
          const prev = r.category;
          try {
            const cur = await App.storage.transactions.get(r.id);
            if (!cur) return;
            // Manual edit auto-locks the row: the user just told us "this
            // is the right category for this specific transaction", so
            // future rule passes shouldn't yank it back. The user can
            // un-lock from the lock column to opt back into rule-based
            // categorisation.
            const next = Object.assign({}, cur, { category: value || null, locked: true });
            await App.storage.transactions.put(next);
            r.category = value || null;
            r.locked = true;
            // Auto-learn a rule keyed by the merchant's *display name* so
            // future imports of the same merchant pick up this categorisation
            // automatically. Silent on failure — it's a learning nicety, not
            // a hard requirement.
            try {
              const learnKey = displayFor(original) || original;
              if (learnKey && value && value !== 'Uncategorized') {
                await App.processing.categorize.learnCategoryRule(learnKey, value);
              }
            } catch (e) { /* non-fatal */ }
            toast('Category saved (row locked).', 'success');
            // Re-render so the lock cell flips to the locked state.
            refreshTxList();
          } catch (err) {
            console.error(err);
            toast('Save failed: ' + err.message, 'error');
            r.category = prev;
            renderCategorySelect();
          }
        }
        renderCategorySelect();

        // Per-row account <select>: choose any account or unassigned. We
        // also keep the legacy `card` field in sync with the new account's
        // IBAN tail, mirroring deleteAccountWithReassign's behaviour.
        const currentAccountId = (r.account_id == null) ? '' : String(r.account_id);
        const accountSelectRow = el('select', {
          class: 'tx-account-input',
          disabled: r.id == null ? '' : null,
          onchange: async (e) => {
            const v = e.target.value;
            const newId = v === '' ? null : parseInt(v, 10);
            const prev = { account_id: r.account_id, card: r.card };
            try {
              const cur = await App.storage.transactions.get(r.id);
              if (!cur) return;
              const next = Object.assign({}, cur, { account_id: newId });
              if (newId != null) {
                const tgt = accounts.find(a => a.id === newId);
                next.card = tgt && tgt.iban ? tgt.iban.replace(/\s+/g, '').slice(-4) : (cur.card || '—');
              } else {
                next.card = '—';
              }
              await App.storage.transactions.put(next);
              r.account_id = newId;
              r.card = next.card;
              toast('Account saved.', 'success');
            } catch (err) {
              console.error(err);
              toast('Save failed: ' + err.message, 'error');
              e.target.value = currentAccountId;
              r.account_id = prev.account_id;
              r.card = prev.card;
            }
          },
        },
          el('option', { value: '', selected: currentAccountId === '' ? '' : null }, '— Unassigned —'),
          ...accounts.map(a => el('option', {
            value: String(a.id),
            selected: currentAccountId === String(a.id) ? '' : null,
          }, a.name + (a.currency ? ' (' + a.currency + ')' : ''))),
        );

        // Per-row date input. Saves on `change` (i.e. blur or Enter), not
        // on every keystroke, so the user can edit freely without
        // half-finished YYYY-MM-DD strings hitting storage. Also recomputes
        // the row's `year` / `month` so the Stats year-picker stays
        // consistent without a reload.
        const dateInput = el('input', {
          type: 'date',
          class: 'tx-date-input',
          value: r.date || '',
          disabled: r.id == null ? '' : null,
          onchange: async (e) => {
            const next = (e.target.value || '').trim();
            if (!next || next === r.date) return;
            const prev = r.date;
            try {
              const cur = await App.storage.transactions.get(r.id);
              if (!cur) return;
              const patch = { date: next };
              const m = /^(\d{4})-(\d{2})/.exec(next);
              if (m) {
                patch.year  = parseInt(m[1], 10);
                patch.month = monthName(parseInt(m[2], 10));
              }
              await App.storage.transactions.put(Object.assign({}, cur, patch));
              Object.assign(r, patch);
              toast('Date saved.', 'success');
            } catch (err) {
              console.error(err);
              toast('Save failed: ' + err.message, 'error');
              e.target.value = prev || '';
            }
          },
        });

        // Source filename cell — shown in muted small text. Click-to-copy
        // would be nice but it's a lot of plumbing; for now, hover shows
        // the full name as a tooltip.
        const sourceFile = fileFor(r);
        const fileTd = el('td', { class: 'tx-file-cell muted', title: sourceFile || '' },
          sourceFile || '—');

        tbody.appendChild(el('tr', { class: checked ? 'tx-row--selected' : '' },
          el('td', { class: 'tx-checkbox-col' }, el('input', {
            type: 'checkbox',
            checked: checked ? '' : null,
            disabled: r.id == null ? '' : null,
            onchange: (e) => {
              if (r.id == null) return;
              if (e.target.checked) selected.add(r.id);
              else selected.delete(r.id);
              updateBulkBar();
              e.target.closest('tr').classList.toggle('tx-row--selected', e.target.checked);
            },
          })),
          el('td', { class: 'tx-date-cell' }, dateInput),
          displayCell,
          categoryCell,
          el('td', null, accountSelectRow),
          el('td', null, typeSelectRow),
          el('td', { class: 'num' },
            (r.kind === 'expense' ? '−' : '+') + formatCurrency(r.amount, r.currency)),
          fileTd,
          el('td', { class: 'tx-lock-col' }, el('button', {
            type: 'button',
            class: 'lock-btn ' + (r.locked ? 'lock-btn--on' : 'lock-btn--off'),
            disabled: r.id == null ? '' : null,
            title: r.locked
              ? 'Locked — rules will not change this row\'s category or display name. Click to unlock.'
              : 'Unlocked — click to pin this row\'s current category and display name so rules leave it alone.',
            onclick: async (e) => {
              if (r.id == null) return;
              const next = !r.locked;
              try {
                const cur = await App.storage.transactions.get(r.id);
                if (!cur) return;
                const patch = Object.assign({}, cur, { locked: next });
                await App.storage.transactions.put(patch);
                r.locked = next;
                e.target.classList.toggle('lock-btn--on',  next);
                e.target.classList.toggle('lock-btn--off', !next);
                e.target.textContent = next ? '🔒' : '🔓';
                e.target.title = next
                  ? 'Locked — rules will not change this row\'s category or display name. Click to unlock.'
                  : 'Unlocked — click to pin this row\'s current category and display name so rules leave it alone.';
                toast(next ? 'Row locked.' : 'Row unlocked.', 'success');
              } catch (err) {
                console.error(err);
                toast('Lock toggle failed: ' + err.message, 'error');
              }
            },
          }, r.locked ? '🔒' : '🔓')),
          el('td', null, el('button', {
            type: 'button', class: 'btn btn--ghost btn--small',
            onclick: async () => {
              const ok = await confirmAction('Delete "' + (r.merchant || '') + '" (' + r.date + ')?');
              if (!ok) return;
              await App.storage.transactions.delete(r.id);
              const idx = txs.findIndex(x => x.id === r.id);
              if (idx !== -1) txs.splice(idx, 1);
              selected.delete(r.id);
              refreshTxList();
              toast('Deleted.', 'success');
            },
          }, 'Delete')),
        ));
      });
      tbl.appendChild(tbody);
      tblWrap.appendChild(tbl);

      footer.innerHTML = '';
      if (matches.length > shown.length) {
        footer.appendChild(el('button', {
          type: 'button', class: 'btn btn--ghost btn--small',
          onclick: () => { txLimit += 100; refreshTxList(); },
        }, 'Show more (+100)'));
      }
    }

    function updateBulkBar() {
      const n = selected.size;
      bulkCountSpan.textContent = n + ' selected';
      bulkBar.classList.toggle('hidden', n === 0);
    }

    refreshTxList();
  }

  // ---------- History ----------
  async function renderHistory(panel) {
    const imports = await App.storage.imports.all();
    if (!imports.length) {
      panel.appendChild(el('div', { class: 'empty-state' },
        el('h3', null, 'No imports yet'),
        el('p', null, 'Run an import and the batches will appear here.')));
      return;
    }
    imports.sort((a, b) => (b.imported_at || '').localeCompare(a.imported_at || ''));
    const tbl = el('table', { class: 'manage-table' });
    tbl.appendChild(el('thead', null, el('tr', null,
      el('th', null, 'Imported at'),
      el('th', null, 'Files'),
      el('th', null, 'Rows'),
      el('th', null, ''),
    )));
    const tbody = el('tbody');
    imports.forEach(b => {
      tbody.appendChild(el('tr', null,
        el('td', null, new Date(b.imported_at).toLocaleString()),
        el('td', null, (b.files || []).map(f => f.name + ' (' + f.bank + ', ' + f.rows + ')').join(', ') || '—'),
        el('td', null, String(b.row_count || 0)),
        el('td', null, el('button', {
          type: 'button', class: 'btn btn--ghost btn--small',
          onclick: async () => {
            const ok = await confirmAction(
              'Roll back this batch? ' + (b.row_count || 0) + ' transactions will be removed. This cannot be undone.');
            if (!ok) return;
            const n = await App.storage.transactions.deleteByBatch(b.batch_id);
            await App.storage.imports.delete(b.id);
            toast('Removed ' + n + ' transactions.', 'success');
            render();
          },
        }, 'Roll back')),
      ));
    });
    tbl.appendChild(tbody);
    panel.appendChild(tbl);
  }

  // ---------- Backup ----------
  async function renderBackup(panel) {
    panel.appendChild(el('p', { class: 'muted' },
      'Everything is stored in your browser only. Export and re-import full backups, transactions only, or just rules and settings.'));

    // Tiny helpers so each section reads as "title + description + body"
    // rather than thirty lines of DOM plumbing per section. Both compose
    // the .section-card / .file-picker primitives from styles.css.
    function sectionCard({ title, desc, body, danger }) {
      const card = el('div', { class: 'section-card' + (danger ? ' section-card--danger' : '') });
      if (title) card.appendChild(el('h3', { class: 'section-card__title' }, title));
      if (desc)  card.appendChild(el('p',  { class: 'section-card__desc'  }, desc));
      const bodyEl = el('div', { class: 'section-card__body' });
      (Array.isArray(body) ? body : [body]).forEach(c => { if (c) bodyEl.appendChild(c); });
      card.appendChild(bodyEl);
      return card;
    }
    // Build a styled file picker. `inputId` is required so the visible
    // <label> can associate with the hidden input. `replaceCheckbox` is
    // optional — pass an actual <input type="checkbox"> + a label string
    // if you want a "Replace existing X" toggle next to the picker.
    function filePicker({ inputId, label, accept, onchange, replaceCheckbox, replaceLabel, hint }) {
      const input = el('input', {
        type: 'file', accept, id: inputId,
        class: 'file-picker__input',
        onchange,
      });
      const labelEl = el('label', {
        class: 'file-picker__label', for: inputId,
      }, label || 'Choose file…');
      const wrap = el('div', { class: 'file-picker' }, input, labelEl);
      if (replaceCheckbox) {
        wrap.appendChild(el('label', { class: 'file-picker__opt' },
          replaceCheckbox, ' ' + (replaceLabel || 'Replace existing')));
      }
      if (hint) wrap.appendChild(el('span', { class: 'file-picker__hint' }, hint));
      // Expose the raw <input> on the wrapper so handlers can clear it
      // after a successful import.
      wrap.__input = input;
      return wrap;
    }

    // ===== Export =====
    const exportActions = el('div', { class: 'section-card__actions' });
    exportActions.appendChild(el('button', {
      type: 'button', class: 'btn btn--primary',
      onclick: async () => {
        try {
          const dump = await App.storage.exportAll();
          const ts = new Date().toISOString().slice(0, 10);
          downloadJSON(dump, 'kalkala-backup-' + ts + '.json');
          toast('Exported full backup.', 'success');
        } catch (e) { toast('Export failed: ' + e.message, 'error'); }
      },
    }, 'Export everything'));
    exportActions.appendChild(el('button', {
      type: 'button', class: 'btn btn--secondary',
      onclick: async () => {
        try {
          const txs = await App.storage.transactions.all();
          const dump = {
            schema: { name: 'kalkala-expense-dashboard', subset: 'transactions' },
            exported_at: new Date().toISOString(),
            data: { transactions: txs },
          };
          const ts = new Date().toISOString().slice(0, 10);
          downloadJSON(dump, 'kalkala-transactions-' + ts + '.json');
          toast('Exported ' + txs.length + ' transaction' + (txs.length === 1 ? '' : 's') + '.', 'success');
        } catch (e) { toast('Export failed: ' + e.message, 'error'); }
      },
    }, 'Export transactions only'));
    exportActions.appendChild(el('button', {
      type: 'button', class: 'btn btn--secondary',
      onclick: async () => {
        try {
          const [acc, cat, rul, brand, mer] = await Promise.all([
            App.storage.accounts.all(),
            App.storage.categories.all(),
            App.storage.rules.all(),
            App.storage.normalizeRules.all().catch(() => []),
            App.storage.merchants.all().catch(() => []),
          ]);
          const dump = {
            schema: { name: 'kalkala-expense-dashboard', subset: 'settings' },
            exported_at: new Date().toISOString(),
            data: {
              accounts: acc, categories: cat,
              category_rules: rul, normalize_rules: brand,
              merchants: mer,
            },
          };
          const ts = new Date().toISOString().slice(0, 10);
          downloadJSON(dump, 'kalkala-settings-' + ts + '.json');
          toast('Exported settings.', 'success');
        } catch (e) { toast('Export failed: ' + e.message, 'error'); }
      },
    }, 'Export settings only'));
    exportActions.appendChild(el('button', {
      type: 'button', class: 'btn btn--ghost',
      onclick: async () => {
        try {
          const [cat, brand, mer] = await Promise.all([
            App.storage.rules.all(),
            App.storage.normalizeRules.all().catch(() => []),
            App.storage.merchants.all().catch(() => []),
          ]);
          const dump = {
            schema: 'kalkala-rules',
            exported_at: new Date().toISOString(),
            category_rules: cat,
            brand_collapses: brand,
            merchant_overrides: mer,
          };
          const ts = new Date().toISOString().slice(0, 10);
          downloadJSON(dump, 'kalkala-rules-' + ts + '.json');
          toast('Exported rules.', 'success');
        } catch (e) { toast('Export failed: ' + e.message, 'error'); }
      },
    }, 'Export rules only'));
    panel.appendChild(sectionCard({
      title: 'Export',
      desc: 'Download a JSON snapshot of your data. Full backups round-trip everything; the smaller exports let you share or migrate just one slice.',
      body: exportActions,
    }));

    // ===== Import everything (full backup) =====
    // Listed first because it's the most common reason to land on this tab.
    // Accepts the full exportAll() shape and writes every store. "Replace
    // existing data" wipes the whole DB first — including transactions.
    const replaceChk = el('input', { type: 'checkbox' });
    let everythingPicker;
    everythingPicker = filePicker({
      inputId: 'backup-import-all',
      label: 'Choose backup file…',
      accept: '.json,application/json',
      replaceCheckbox: replaceChk,
      replaceLabel: 'Replace existing data',
      onchange: async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try {
          const text = await f.text();
          const json = JSON.parse(text);
          if (replaceChk.checked) {
            const ok = await confirmAction('Really wipe the current DB and restore from this backup?');
            if (!ok) return;
          }
          const counts = await App.storage.importAll(json, { replace: replaceChk.checked });
          toast('Restored: ' + counts.transactions + ' transactions, ' + counts.accounts + ' accounts.', 'success');
          render();
        } catch (err) { toast('Restore failed: ' + err.message, 'error'); }
      },
    });
    panel.appendChild(sectionCard({
      title: 'Import everything',
      desc: 'Load a full-backup JSON file. By default rows are appended; tick "Replace existing data" to wipe every store first (transactions and settings both).',
      body: everythingPicker,
    }));

    // ===== Import transactions only =====
    // Accepts either the `subset: 'transactions'` shape from "Export
    // transactions only", OR a full backup whose `data.transactions` array
    // we cherry-pick from. Append-only by default; the toggle wipes only the
    // transactions store, leaving accounts / categories / rules alone.
    const replaceTxChk = el('input', { type: 'checkbox' });
    const txPicker = filePicker({
      inputId: 'backup-import-tx',
      label: 'Choose transactions file…',
      accept: '.json,application/json',
      replaceCheckbox: replaceTxChk,
      replaceLabel: 'Replace existing transactions',
      onchange: async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try {
          const text = await f.text();
          const json = JSON.parse(text);
          const txs =
            (json && json.data && Array.isArray(json.data.transactions) && json.data.transactions) ||
            (json && Array.isArray(json.transactions) && json.transactions) ||
            [];
          if (!txs.length) { toast('No transactions found in that file.', 'warn'); return; }
          if (replaceTxChk.checked) {
            const existing = await App.storage.transactions.all();
            const ok = await confirmAction(
              'Wipe ALL ' + existing.length + ' existing transaction' +
              (existing.length === 1 ? '' : 's') + ' before importing ' +
              txs.length + ' new one' + (txs.length === 1 ? '' : 's') + '?\n\n' +
              'This cannot be undone. Accounts, categories, and rules are not affected.');
            if (!ok) return;
            await App.storage.transactions.clear();
          }
          const stripId = (r) => { const c = Object.assign({}, r); delete c.id; return c; };
          for (const t of txs) {
            await App.storage.transactions.put(replaceTxChk.checked ? t : stripId(t));
          }
          toast('Imported ' + txs.length + ' transaction' + (txs.length === 1 ? '' : 's') + '.', 'success');
          txPicker.__input.value = '';
          render();
        } catch (err) { toast('Import failed: ' + err.message, 'error'); }
      },
    });
    panel.appendChild(sectionCard({
      title: 'Import transactions only',
      desc: 'Load transactions from a Kalkala JSON file. Accepts a transactions-only export or a full backup (only the transactions are imported either way). Tick the toggle to wipe the transactions store first; your accounts, categories, and rules are left alone.',
      body: txPicker,
    }));

    // ===== Import settings only =====
    // Counterpart to "Export settings only". Pulls accounts, categories,
    // both rule kinds, and merchants from a settings-subset export OR a full
    // backup. Transactions are never touched by this path.
    const replaceSettingsChk = el('input', { type: 'checkbox' });
    const settingsPicker = filePicker({
      inputId: 'backup-import-settings',
      label: 'Choose settings file…',
      accept: '.json,application/json',
      replaceCheckbox: replaceSettingsChk,
      replaceLabel: 'Replace existing settings',
      onchange: async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try {
          const text = await f.text();
          const json = JSON.parse(text);
          const src = (json && json.data) || {};
          const acc   = Array.isArray(src.accounts)        ? src.accounts        : [];
          const cat   = Array.isArray(src.categories)      ? src.categories      : [];
          const rul   = Array.isArray(src.category_rules)  ? src.category_rules  : [];
          const brand = Array.isArray(src.normalize_rules) ? src.normalize_rules : [];
          const mer   = Array.isArray(src.merchants)       ? src.merchants       : [];
          if (!acc.length && !cat.length && !rul.length && !brand.length && !mer.length) {
            toast('No settings found in that file.', 'warn');
            return;
          }
          if (replaceSettingsChk.checked) {
            const ok = await confirmAction(
              'Wipe ALL existing accounts, categories, category rules, and display-name rules before importing?\n\n' +
              'This cannot be undone. Your transactions are not affected.');
            if (!ok) return;
            const [eacc, ecat, erul, ebrand, emer] = await Promise.all([
              App.storage.accounts.all(),
              App.storage.categories.all(),
              App.storage.rules.all(),
              App.storage.normalizeRules.all().catch(() => []),
              App.storage.merchants.all().catch(() => []),
            ]);
            for (const r of eacc)   await App.storage.accounts.delete(r.id);
            for (const r of ecat)   await App.storage.categories.delete(r.id);
            for (const r of erul)   await App.storage.rules.delete(r.id);
            for (const r of ebrand) await App.storage.normalizeRules.delete(r.id);
            for (const r of emer)   await App.storage.merchants.delete(r.id);
          }
          const stripId = (r) => { const c = Object.assign({}, r); delete c.id; return c; };
          for (const r of acc)   await App.storage.accounts.put(stripId(r));
          for (const r of cat)   await App.storage.categories.put(stripId(r));
          for (const r of rul)   await App.storage.rules.put(stripId(r));
          for (const r of brand) await App.storage.normalizeRules.put(stripId(r));
          for (const r of mer)   await App.storage.merchants.put(stripId(r));
          const N = (App.processing && App.processing.normalize) || {};
          if (N.loadBrandCollapses) await N.loadBrandCollapses();
          if (N.migrateMerchantsToRulesIfNeeded) await N.migrateMerchantsToRulesIfNeeded();
          const total = acc.length + cat.length + rul.length + brand.length + mer.length;
          toast('Imported ' + total + ' settings row' + (total === 1 ? '' : 's') +
                ' (' + acc.length + ' account' + (acc.length === 1 ? '' : 's') +
                ', '  + cat.length + ' categor' + (cat.length === 1 ? 'y' : 'ies') +
                ', '  + rul.length + ' category rule' + (rul.length === 1 ? '' : 's') +
                ', '  + brand.length + ' display rule' + (brand.length === 1 ? '' : 's') +
                (mer.length ? ', ' + mer.length + ' legacy override' + (mer.length === 1 ? '' : 's') : '') +
                ').', 'success');
          settingsPicker.__input.value = '';
          render();
        } catch (err) { toast('Import failed: ' + err.message, 'error'); }
      },
    });
    panel.appendChild(sectionCard({
      title: 'Import settings only',
      desc: 'Load accounts, categories, and all rules from a Kalkala settings export (or a full backup — only the settings are imported). Tick the toggle to wipe the settings stores first; your transactions are left alone.',
      body: settingsPicker,
    }));

    // ===== Import rules only =====
    // Accepts the `kalkala-rules` shape from "Export rules only", OR a full
    // backup whose `data` block carries category_rules / normalize_rules /
    // merchants. Append-only by default; toggle wipes the rule stores first.
    const replaceRulesChk = el('input', { type: 'checkbox' });
    const rulesPicker = filePicker({
      inputId: 'backup-import-rules',
      label: 'Choose rules file…',
      accept: '.json,application/json',
      replaceCheckbox: replaceRulesChk,
      replaceLabel: 'Replace existing rules',
      onchange: async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try {
          const text = await f.text();
          const json = JSON.parse(text);
          const cat   = (json && (json.category_rules     || (json.data && json.data.category_rules)))   || [];
          const brand = (json && (json.brand_collapses    || (json.data && json.data.normalize_rules)))  || [];
          const mer   = (json && (json.merchant_overrides || (json.data && json.data.merchants)))        || [];
          if (!cat.length && !brand.length && !mer.length) {
            toast('No rules found in that file.', 'warn');
            return;
          }
          if (replaceRulesChk.checked) {
            const ok = await confirmAction(
              'Wipe ALL existing category rules and display-name rules before importing?\n\n' +
              'This cannot be undone.');
            if (!ok) return;
            const existingCat   = await App.storage.rules.all();
            const existingBrand = await App.storage.normalizeRules.all().catch(() => []);
            const existingMer   = await App.storage.merchants.all().catch(() => []);
            for (const r of existingCat)   await App.storage.rules.delete(r.id);
            for (const r of existingBrand) await App.storage.normalizeRules.delete(r.id);
            for (const r of existingMer)   await App.storage.merchants.delete(r.id);
          }
          const stripId = (r) => { const c = Object.assign({}, r); delete c.id; return c; };
          for (const r of cat)   await App.storage.rules.put(stripId(r));
          for (const r of brand) await App.storage.normalizeRules.put(stripId(r));
          for (const r of mer)   await App.storage.merchants.put(stripId(r));
          const N = (App.processing && App.processing.normalize) || {};
          if (N.loadBrandCollapses) await N.loadBrandCollapses();
          if (N.migrateMerchantsToRulesIfNeeded) await N.migrateMerchantsToRulesIfNeeded();
          toast('Imported ' + cat.length + ' category rule' + (cat.length === 1 ? '' : 's') +
                ', ' + brand.length + ' display rule' + (brand.length === 1 ? '' : 's') +
                (mer.length ? ' and ' + mer.length + ' legacy merchant override' + (mer.length === 1 ? '' : 's') : '') +
                '.', 'success');
          rulesPicker.__input.value = '';
          render();
        } catch (err) { toast('Import failed: ' + err.message, 'error'); }
      },
    });
    panel.appendChild(sectionCard({
      title: 'Import rules only',
      desc: 'Load a rules JSON exported from another Kalkala instance. Tick the toggle to wipe category and display rules first.',
      body: rulesPicker,
    }));
  }

  // ---------- Danger zone ----------
  async function renderDanger(panel) {
    panel.appendChild(el('p', { class: 'muted' },
      'Irreversible actions. None of this touches the network, but it cannot be undone either. ' +
      'Each operation is wrapped in a confirmation dialog — but the result is permanent. ' +
      'If in doubt, export a backup first from the Backup / restore tab.'));

    function dangerCard({ title, desc, action, label }) {
      const btn = el('button', { type: 'button', class: 'btn btn--danger', onclick: action }, label);
      const card = el('div', { class: 'section-card section-card--danger' },
        el('h3', { class: 'section-card__title' }, title),
        el('p',  { class: 'section-card__desc'  }, desc),
        el('div', { class: 'section-card__actions' }, btn),
      );
      return card;
    }

    panel.appendChild(dangerCard({
      title: 'Delete all transactions',
      desc: 'Removes every imported transaction. Accounts, categories, rules, merchant display-name rules, and import history are kept.',
      label: 'Delete all transactions',
      action: async () => {
        const tr = await App.storage.transactions.all();
        const ok = await confirmAction('Really delete all ' + tr.length + ' transactions? Accounts and rules will be kept.');
        if (!ok) return;
        await App.storage.transactions.clear();
        toast('All transactions cleared.', 'success');
      },
    }));

    panel.appendChild(dangerCard({
      title: 'Wipe entire database',
      desc: 'Removes everything: transactions, accounts, categories, both rule kinds, merchants, import history, duplicate dismissals, and saved CSV templates. The browser tab returns to the empty-state landing page.',
      label: 'Wipe entire database',
      action: async () => {
        const ok = await confirmAction('This wipes transactions, accounts, rules, categories, and import history. Continue?');
        if (!ok) return;
        await App.storage.clearAll();
        toast('Database wiped.', 'success');
        App.router.navigate('/');
      },
    }));
  }

  App.views = App.views || {};
  App.views.manage = { mount };
})();

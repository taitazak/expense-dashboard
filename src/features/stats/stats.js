/*
 * src/features/stats/stats.js — the original dashboard, refactored.
 *
 * Data source: IndexedDB only. If the user has no imports yet they get an
 * empty state — the landing view already prompts them to import a PDF,
 * and the "demo expense.json" fallback that shipped with the pre-refactor
 * dashboard was retired with the move to IndexedDB.
 *
 * Charts, summary cards, filters, and transaction list are faithful ports
 * of the pre-refactor logic with three changes:
 *   - Theme-aware colors are re-read on toggle.
 *   - Amounts are formatted in each row's currency (was hardcoded ILS).
 *   - Transfers (kind === 'transfer') are excluded from spend totals.
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};
  const { el, escapeHtml, monthName, monthIndex, formatCurrency } = App.util;

  // Module state (per-mount).
  let allExpenses = [];
  let filteredExpenses = [];
  let charts = {};
  let rootEl = null;
  let knownAccounts = [];      // [{id, name}] for the editable <select> column
  let knownCategories = [];    // user-facing category strings (datalist)
  // Resolver (raw merchant) -> display name. Built from the merchants
  // store at load time. Used so charts group noisy variants together.
  let resolveMerchant = (s) => s;
  // Snapshot of the merchants store keyed by original — used by the
  // editable display-name column in Recent Transactions to upsert
  // overrides without re-reading the whole store on every keystroke.
  let merchantOverridesByOriginal = new Map();
  // Categories the user has flagged as Income in Manage > Categories.
  // No longer gated by a separate toggle — the multi-select picker now
  // owns include/exclude, and income categories are seeded as unchecked
  // by default (same as ones flagged Excluded). The user can re-include
  // them per-session by ticking them in the picker.
  let incomeCategoryNames = new Set();
  // Per-category include/exclude filter — distinct from the back-end
  // "excluded" flag in Manage > Categories. Manage's flag seeds the default
  // (categories flagged excluded start unchecked); the picker then lets the
  // user toggle individual categories in or out for the current session.
  // Resets on each mount; not persisted.
  //   includedCategories === null  → "All categories" (the default before
  //                                  the user touches the picker)
  //   includedCategories === Set   → only show rows whose category is in
  //                                  the set (Uncategorized maps to '')
  let includedCategories = null;       // null until populateFilters() seeds it
  let allCategoryChoices = [];         // [{name, excludedByDefault}]
  // Recent Transactions: null key = default (newest-first by date). Once
  // the user clicks a header we track their chosen column + direction.
  let recentSortKey = null;
  let recentSortDir = 'asc';

  // Build a sortable <th> that toggles this table's sort state on click.
  // Arrow indicator is inline so it styles with the surrounding table.
  function sortableTh(label, key, getState, onSort) {
    const s = getState() || {};
    const active = s.key === key;
    const arrow = active ? (s.dir === 'asc' ? '▲' : '▼') : '↕';
    const th = document.createElement('th');
    th.className = 'sortable-th' + (active ? ' is-active' : '');
    th.setAttribute('role', 'button');
    th.tabIndex = 0;
    th.title = 'Sort by ' + label;
    th.textContent = label + ' ';
    const arrowSpan = document.createElement('span');
    arrowSpan.className = 'sort-arrow';
    arrowSpan.textContent = arrow;
    th.appendChild(arrowSpan);
    th.addEventListener('click', () => {
      const cur = getState() || {};
      if (cur.key === key) onSort({ key, dir: cur.dir === 'asc' ? 'desc' : 'asc' });
      else                 onSort({ key, dir: 'asc' });
    });
    return th;
  }
  function cmpBy(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const sa = String(a).toLowerCase();
    const sb = String(b).toLowerCase();
    return sa < sb ? -1 : (sa > sb ? 1 : 0);
  }

  const CHART_COLORS = [
    '#667eea', '#764ba2', '#f093fb', '#f5576c',
    '#4facfe', '#00f2fe', '#43e97b', '#38f9d7',
    '#ffecd2', '#fcb69f', '#a8edea', '#fed6e3',
  ];

  function getThemeColors() {
    const computed = getComputedStyle(document.documentElement);
    return {
      textColor: (computed.getPropertyValue('--text-primary') || '#2c3e50').trim(),
      gridColor: (computed.getPropertyValue('--border-color') || '#f0f0f0').trim(),
    };
  }

  // Dominant currency of current filter, used to label single-currency totals.
  function dominantCurrency(list) {
    const count = {};
    for (const e of list) count[e.currency || 'EUR'] = (count[e.currency || 'EUR'] || 0) + 1;
    let best = 'EUR', bestN = -1;
    for (const [c, n] of Object.entries(count)) if (n > bestN) { best = c; bestN = n; }
    return best;
  }

  // ---------- Load ----------
  async function loadData() {
    await App.storage.open();
    // Load accounts so the Recent Transactions table can show account names
    // alongside the legacy "card" label, and so its account <select> column
    // knows which options to offer.
    try {
      knownAccounts = await App.storage.accounts.all();
    } catch (e) { knownAccounts = []; }
    // Build known categories (history + stored catalog) for the datalist.
    knownCategories = await collectKnownCategories();
    // Build the merchant resolver: user-picked overrides first, then a
    // best-effort beautifier, then fall back to the raw string.
    try {
      const merchantRows = await App.storage.merchants.all();
      merchantOverridesByOriginal = new Map();
      (merchantRows || []).forEach(m => {
        if (m && m.original) merchantOverridesByOriginal.set(m.original, m);
      });
      resolveMerchant = App.processing.normalize.buildMerchantResolver(merchantRows);
    } catch (e) {
      // Older DB or missing module — keep resolveMerchant as identity so
      // the dashboard still works on fresh installs.
      merchantOverridesByOriginal = new Map();
      resolveMerchant = (s) => s || '';
    }

    const stored = await App.storage.transactions.all();
    if (!stored.length) return [];
    // Build a set of categories the user has flagged as excluded (e.g.
    // internal transfers between their own accounts) and the set flagged
    // as income. Both seed the Stats category-picker / income-toggle
    // defaults — they no longer drop rows on the way in, so the user can
    // re-include a category for the current session without touching
    // Manage.
    const excludedByDefault = new Set();
    incomeCategoryNames = new Set();
    try {
      const cats = await App.storage.categories.all();
      cats.forEach(c => {
        if (!c || !c.name) return;
        if (c.excluded)  excludedByDefault.add(c.name);
        if (c.is_income) incomeCategoryNames.add(c.name);
      });
    } catch (e) { /* non-fatal */ }
    // Back-compat: if nothing has been flagged as income yet, keep the
    // legacy behaviour of hiding the literal "Income" category when the
    // toggle is off. Users who migrate through Manage > Categories will
    // replace this with an explicit flag.
    if (!incomeCategoryNames.size) incomeCategoryNames.add('Income');
    // Stash the excluded set on the module so populateFilters() can use it
    // to seed the per-category picker.
    _excludedByDefault = excludedByDefault;
    // Normalize to the legacy expense shape the dashboard expects. Note:
    // we no longer pre-filter by `excluded` here — the per-category
    // picker handles that downstream so the user can flip it on a whim.
    return stored
      .filter(t => t.kind !== 'transfer')
      .map(normalizeForDashboard);
  }
  // Module-scoped so populateFilters() can read it without re-querying
  // IDB. Reset on every loadData() call.
  let _excludedByDefault = new Set();

  async function collectKnownCategories() {
    const set = new Set();
    try {
      const all = await App.storage.transactions.all();
      (all || []).forEach(t => { if (t.category && t.category !== 'Uncategorized') set.add(t.category); });
    } catch (e) { /* noop */ }
    try {
      const stored = await App.storage.categories.all();
      (stored || []).forEach(c => { if (c && c.name) set.add(c.name); });
    } catch (e) { /* noop */ }
    return Array.from(set).sort();
  }

  // Resolve a readable account label for a transaction. Prefers a real
  // account record (looked up by id) and falls back to the legacy `card`
  // string for demo / seed data.
  function accountLabel(t) {
    if (typeof t.account_id === 'number') {
      const a = knownAccounts.find(x => x.id === t.account_id);
      if (a) return a.name;
    }
    return t.card || '—';
  }

  function normalizeForDashboard(t) {
    // Older files don't have currency/kind; default to legacy values.
    const currency = t.currency || 'ILS';
    const rawMerchant = t.merchant || '';
    return {
      id: t.id,                       // preserve for in-place edits
      account_id: t.account_id || null,
      date: t.date,
      year: t.year,
      month: t.month || (t.date ? monthName(+t.date.slice(5, 7)) : null),
      // `merchant` is the *display* name — what all downstream code
      // (charts, filters, grouping, "Top Merchants") treats as the
      // identity. The raw statement string is preserved separately for
      // the Recent Transactions table to show as a secondary line.
      merchant: resolveMerchant(rawMerchant) || rawMerchant,
      merchant_original: rawMerchant,
      amount: Math.abs(Number(t.amount) || 0),
      category: t.category || 'Uncategorized',
      card: t.card || '—',
      currency,
      kind: t.kind || 'expense',
      // Carry the canonical transaction type through to the dashboard so
      // the Recent Transactions table can show it without re-normalizing.
      type: t.type || null,
      // Carry through so the Recent Transactions edit handlers can know
      // up-front whether the row is already locked.
      locked: !!t.locked,
      raw: t.raw || null,
      // Pre-resolved human-readable account label for display / filtering.
      account: (function () {
        if (typeof t.account_id === 'number') {
          const a = (knownAccounts || []).find(x => x.id === t.account_id);
          if (a) return a.name;
        }
        return t.card || '—';
      })(),
    };
  }

  // ---------- Filters ----------
  function sortMonthsChronologically(months) {
    return months.slice().sort((a, b) => monthIndex(a) - monthIndex(b));
  }

  function getSelectedYears() {
    const container = document.getElementById('yearFilter');
    if (!container) return 'all';
    const allBtn = container.querySelector('.year-btn-all');
    if (allBtn && allBtn.classList.contains('active')) return 'all';
    const selected = [];
    container.querySelectorAll('.year-btn:not(.year-btn-all).active')
      .forEach(b => selected.push(parseInt(b.dataset.year, 10)));
    return selected;
  }

  function applyFilters() {
    const years = getSelectedYears();
    const month = document.getElementById('monthFilter').value;
    const account = document.getElementById('accountFilter').value;
    const q = document.getElementById('searchMerchant').value.toLowerCase();
    // The category filter is a Set populated by the multi-select picker.
    // null/undefined means "show all" (the picker hasn't been initialised
    // yet — happens during the very first render before populateFilters).
    // Income categories are seeded as unchecked in the picker by default,
    // so income gating now lives entirely inside that one Set.
    const cats = includedCategories;
    filteredExpenses = allExpenses.filter(e => {
      const yMatch = years === 'all' || years.includes(e.year);
      const mMatch = month === 'all' || e.month === month;
      const cMatch = !cats || cats.has(e.category);
      const kMatch = account === 'all' || e.account === account;
      // Unified search: hits every column the user sees plus the raw
      // bank merchant string, so "lufthansa" finds rows whether the
      // display name was renamed or not.
      let sMatch = true;
      if (q) {
        const haystack = [
          e.merchant || '',
          e.merchant_original || '',
          e.category || '',
          e.account || '',
          e.type || '',
          e.date || '',
          String(e.amount || ''),
        ].join('  ').toLowerCase();
        sMatch = haystack.includes(q);
      }
      return yMatch && mMatch && cMatch && kMatch && sMatch;
    });
    updateDashboard();
  }

  // ---------- Render ----------
  async function mount(container) {
    rootEl = container;
    rootEl.innerHTML = '';
    rootEl.appendChild(buildShell());

    // Per-mount reset so stale category sets from a previous session don't
    // bleed into a fresh import. populateCategoryPicker() seeds it from
    // the categories store + visible expenses immediately after.
    includedCategories = null;
    allExpenses = await loadData();
    filteredExpenses = allExpenses.slice();
    if (!allExpenses.length) {
      document.getElementById('stats-empty').classList.remove('hidden');
      document.getElementById('stats-content').classList.add('hidden');
      return;
    }
    document.getElementById('stats-empty').classList.add('hidden');
    document.getElementById('stats-content').classList.remove('hidden');
    populateFilters();
    wireControls();
    // Run through applyFilters() — not updateDashboard() directly — so the
    // very first render honours the picker's seeded include/exclude state
    // (excluded + income categories start unchecked). Without this, the
    // initial doughnut shows every category for one frame even though the
    // checkboxes claim otherwise.
    applyFilters();

    // Re-render when the user toggles the theme (app.js emits this).
    App.util.on('themechange', updateDashboard);
  }

  function unmount() {
    App.util.off('themechange', updateDashboard);
    Object.values(charts).forEach(c => { try { c.destroy(); } catch (e) {} });
    charts = {};
  }

  function buildShell() {
    const wrap = el('div', { class: 'view view--stats' });
    // Breadcrumb removed — the persistent top nav indicates the active
    // section. Section title goes straight into the view body.

    wrap.insertAdjacentHTML('beforeend', `
      <div id="stats-empty" class="empty-state hidden">
        <h3>No transactions to plot yet</h3>
        <p>Import a PDF statement or restore a backup, then come back.</p>
        <button class="btn btn--primary" onclick="location.hash='#/import'">Go to import →</button>
      </div>
      <div id="stats-content" class="hidden">
        <div class="monthly-chart-container">
          <div class="chart-container">
            <h3>Monthly Spending Trend</h3>
            <div class="chart"><canvas id="monthlyChart"></canvas></div>
          </div>
        </div>
        <div class="charts-grid">
          <div class="chart-container"><h3>Spending by Category</h3><div class="chart"><canvas id="categoryChart"></canvas></div></div>
          <div class="chart-container"><h3>Top Merchants</h3><div class="chart"><canvas id="merchantChart"></canvas></div></div>
          <div class="chart-container"><h3>Spending by Account</h3><div class="chart"><canvas id="accountChart"></canvas></div></div>
        </div>
        <div class="summary-cards" id="summaryCards"></div>
        <div class="controls">
          <div class="control-group"><label>Filter by Year:</label><div id="yearFilter" class="year-picker"></div></div>
          <div class="control-group"><label for="monthFilter">Filter by Month:</label><select id="monthFilter"><option value="all">All Months</option></select></div>
          <div class="control-group control-group--cats">
            <label for="categoryFilterBtn">Filter by Category:</label>
            <div class="cat-multi" id="categoryFilter">
              <button type="button" id="categoryFilterBtn" class="cat-multi__btn"
                      aria-haspopup="true" aria-expanded="false">All Categories</button>
              <div id="categoryFilterPop" class="cat-multi__pop hidden"
                   role="dialog" aria-label="Filter by category">
                <div class="cat-multi__head">
                  <button type="button" id="categoryFilterAll"  class="linklike">Select all</button>
                  <span class="muted"> · </span>
                  <button type="button" id="categoryFilterNone" class="linklike">Clear</button>
                  <span class="muted"> · </span>
                  <button type="button" id="categoryFilterReset" class="linklike"
                          title="Reset to the include/exclude defaults from Manage > Categories">Reset</button>
                </div>
                <div id="categoryFilterList" class="cat-multi__list"></div>
              </div>
            </div>
          </div>
          <div class="control-group"><label for="accountFilter">Filter by Account:</label><select id="accountFilter"><option value="all">All Accounts</option></select></div>
          <div class="control-group"><label for="searchMerchant">Search:</label><input type="text" id="searchMerchant" placeholder="Search merchant, category, account, type, date, amount..."></div>
        </div>
        <div class="transactions-section">
          <h3>Recent Transactions</h3>
          <datalist id="stats-known-categories"></datalist>
          <div id="transactionsList"></div>
        </div>
      </div>
    `);
    return wrap;
  }

  function populateFilters() {
    const years = Array.from(new Set(allExpenses.map(e => e.year))).sort((a, b) => a - b);
    const months = Array.from(new Set(allExpenses.map(e => e.month)));
    const categories = Array.from(new Set(allExpenses.map(e => e.category))).sort();
    const accounts = Array.from(new Set(allExpenses.map(e => e.account))).sort();
    populateYearPicker(years);
    populateDropdown('monthFilter', sortMonthsChronologically(months));
    populateCategoryPicker(categories);
    populateDropdown('accountFilter', accounts);

    // Refresh the shared datalist for category autocomplete.
    const dl = document.getElementById('stats-known-categories');
    if (dl) {
      dl.innerHTML = '';
      const merged = Array.from(new Set([...knownCategories, ...categories])).sort();
      merged.forEach(c => {
        const o = document.createElement('option');
        o.value = c; dl.appendChild(o);
      });
    }
  }

  // Build the per-category include/exclude picker. The default selection
  // mirrors Manage > Categories: every category is checked except the ones
  // the user has flagged as excluded. The user can toggle individual rows
  // for the current session — we don't write back to the categories store
  // (that's still the job of Manage > Categories).
  function populateCategoryPicker(categoryNames) {
    allCategoryChoices = categoryNames.map(name => ({
      name,
      excludedByDefault: _excludedByDefault.has(name),
      isIncomeByDefault: incomeCategoryNames.has(name),
    }));
    // Seed includedCategories from defaults on first populate, or when the
    // visible category list changes underneath us (e.g. a fresh import
    // introduced a new category — surface it as included by default).
    // Categories flagged Excluded *or* Income in Manage > Categories are
    // unchecked by default; the user can tick them on per-session.
    function uncheckedByDefault(c) {
      return c.excludedByDefault || c.isIncomeByDefault;
    }
    if (!includedCategories) {
      includedCategories = new Set(
        allCategoryChoices.filter(c => !uncheckedByDefault(c)).map(c => c.name)
      );
    } else {
      allCategoryChoices.forEach(c => {
        if (!uncheckedByDefault(c) && !includedCategories.has(c.name)) {
          includedCategories.add(c.name);
        }
      });
    }
    renderCategoryPicker();
    wireCategoryPicker();
  }

  function renderCategoryPicker() {
    const list = document.getElementById('categoryFilterList');
    const btn  = document.getElementById('categoryFilterBtn');
    if (!list || !btn) return;
    list.innerHTML = '';
    allCategoryChoices.forEach(c => {
      const id = 'cat-pick-' + cssSafe(c.name);
      const row = el('label', { class: 'cat-multi__row', for: id });
      const cb = el('input', {
        type: 'checkbox', id,
        checked: includedCategories.has(c.name) ? '' : null,
        onchange: (e) => {
          if (e.target.checked) includedCategories.add(c.name);
          else includedCategories.delete(c.name);
          updateCategoryButtonLabel();
          applyFilters();
        },
      });
      row.appendChild(cb);
      row.appendChild(el('span', { class: 'cat-multi__name' }, c.name));
      if (c.isIncomeByDefault) {
        row.appendChild(el('span', {
          class: 'cat-multi__hint muted',
          title: 'Flagged as Income in Manage > Categories. Unchecked here by default — tick to include income in totals.',
        }, ' income'));
      } else if (c.excludedByDefault) {
        row.appendChild(el('span', {
          class: 'cat-multi__hint muted',
          title: 'Marked Excluded in Manage > Categories. Unchecked here by default.',
        }, ' excluded by default'));
      }
      list.appendChild(row);
    });
    updateCategoryButtonLabel();
  }
  function cssSafe(s) { return String(s || '').replace(/[^a-zA-Z0-9_-]+/g, '_'); }

  function updateCategoryButtonLabel() {
    const btn = document.getElementById('categoryFilterBtn');
    if (!btn) return;
    const total = allCategoryChoices.length;
    const sel = includedCategories ? includedCategories.size : total;
    if (!total) { btn.textContent = 'All Categories'; return; }
    if (sel === total) btn.textContent = 'All Categories (' + total + ')';
    else if (sel === 0) btn.textContent = 'No categories (0 / ' + total + ')';
    else if (sel === 1) {
      const only = Array.from(includedCategories)[0];
      btn.textContent = only;
    }
    else btn.textContent = sel + ' of ' + total + ' categories';
  }

  function wireCategoryPicker() {
    const btn  = document.getElementById('categoryFilterBtn');
    const pop  = document.getElementById('categoryFilterPop');
    const all  = document.getElementById('categoryFilterAll');
    const none = document.getElementById('categoryFilterNone');
    const rst  = document.getElementById('categoryFilterReset');
    if (!btn || !pop) return;
    // Toggle popover. Closes on outside click via the document listener
    // attached on first open, removed on close to keep the listener stack
    // tidy across mount/unmount cycles.
    let outsideListener = null;
    function open() {
      pop.classList.remove('hidden');
      btn.setAttribute('aria-expanded', 'true');
      outsideListener = (e) => {
        if (!pop.contains(e.target) && e.target !== btn) close();
      };
      // Defer so the click that opened us doesn't immediately close.
      setTimeout(() => document.addEventListener('click', outsideListener), 0);
    }
    function close() {
      pop.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
      if (outsideListener) {
        document.removeEventListener('click', outsideListener);
        outsideListener = null;
      }
    }
    btn.addEventListener('click', () => {
      if (pop.classList.contains('hidden')) open(); else close();
    });
    if (all) all.addEventListener('click', () => {
      includedCategories = new Set(allCategoryChoices.map(c => c.name));
      renderCategoryPicker(); applyFilters();
    });
    if (none) none.addEventListener('click', () => {
      includedCategories = new Set();
      renderCategoryPicker(); applyFilters();
    });
    if (rst) rst.addEventListener('click', () => {
      includedCategories = new Set(
        allCategoryChoices
          .filter(c => !(c.excludedByDefault || c.isIncomeByDefault))
          .map(c => c.name)
      );
      renderCategoryPicker(); applyFilters();
    });
  }

  function populateYearPicker(years) {
    const container = document.getElementById('yearFilter');
    container.innerHTML = '';
    const allBtn = el('button', {
      type: 'button', class: 'year-btn year-btn-all active', dataset: { year: 'all' },
      onclick: () => {
        container.querySelectorAll('.year-btn').forEach(b => b.classList.remove('active'));
        allBtn.classList.add('active'); applyFilters();
      },
    }, 'All');
    container.appendChild(allBtn);
    years.forEach(y => {
      const b = el('button', {
        type: 'button', class: 'year-btn', dataset: { year: String(y) },
        onclick: () => {
          allBtn.classList.remove('active');
          b.classList.toggle('active');
          const any = container.querySelectorAll('.year-btn:not(.year-btn-all).active').length > 0;
          if (!any) allBtn.classList.add('active');
          applyFilters();
        },
      }, String(y));
      container.appendChild(b);
    });
  }

  function populateDropdown(id, options) {
    const sel = document.getElementById(id);
    options.forEach(opt => {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      sel.appendChild(o);
    });
  }

  function wireControls() {
    document.getElementById('monthFilter').addEventListener('change', applyFilters);
    document.getElementById('accountFilter').addEventListener('change', applyFilters);
    // categoryFilter is a multi-select popover wired up in
    // populateCategoryPicker() — no change-listener needed here. The
    // legacy "Include income categories" toggle was removed; income
    // categories are seeded as unchecked in the picker, and the user can
    // re-include them per-session by ticking them.
    document.getElementById('searchMerchant').addEventListener('input', applyFilters);
    const incToggle = document.getElementById('includeIncomeToggle');
    if (incToggle) {
      incToggle.checked = includeIncome;
      incToggle.addEventListener('change', () => {
        includeIncome = !!incToggle.checked;
        applyFilters();
      });
    }
  }

  function updateDashboard() {
    if (!rootEl || !document.getElementById('summaryCards')) return;
    updateSummaryCards();
    updateMonthlyChart();
    updateCategoryChart();
    updateMerchantChart();
    updateAccountChart();
    updateTransactionsList();
  }

  // Splitting income and expense consistently: the parser tags each row
  // with `kind` (expense | income | transfer) based on the amount's sign.
  // Stats only care about expense vs income — transfers are already dropped
  // upstream in loadData().
  function isExpense(e) { return (e.kind || 'expense') === 'expense'; }
  function isIncome(e)  { return e.kind === 'income'; }

  function updateSummaryCards() {
    const cur = dominantCurrency(filteredExpenses);
    const expenses = filteredExpenses.filter(isExpense);
    const incomes  = filteredExpenses.filter(isIncome);
    const totalExp = expenses.reduce((s, e) => s + e.amount, 0);
    const totalInc = incomes.reduce((s, e) => s + e.amount, 0);
    const count    = filteredExpenses.length;
    const expCount = expenses.length;
    const avg = expCount ? totalExp / expCount : 0;

    const monthTotals = {};
    expenses.forEach(e => {
      const k = e.year + '-' + e.month;
      monthTotals[k] = (monthTotals[k] || 0) + e.amount;
    });
    const activeMonths = Object.values(monthTotals).filter(v => v > 0).length;
    const monthlyAvg = activeMonths ? totalExp / activeMonths : 0;

    const cards = document.getElementById('summaryCards');
    cards.innerHTML = '';
    // The Income / Net cards are conditional on the picker actually
    // including any income-flagged categories — otherwise they'd just
    // sit there at 0, which is noisier than skipping them.
    const showIncome = !!incomeCategoryNames.size && (function () {
      if (!includedCategories) return true;
      for (const n of incomeCategoryNames) if (includedCategories.has(n)) return true;
      return false;
    })();
    const pairs = showIncome
      ? [
          ['Total Spent',     formatCurrency(totalExp, cur)],
          ['Total Income',    formatCurrency(totalInc, cur)],
          ['Net',             formatCurrency(totalInc - totalExp, cur)],
          ['Transactions',    String(count)],
          ['Avg per Expense', formatCurrency(avg, cur)],
          ['Active Months',   String(activeMonths)],
          ['Monthly Average', formatCurrency(monthlyAvg, cur)],
        ]
      : [
          ['Total Spent',     formatCurrency(totalExp, cur)],
          ['Transactions',    String(count)],
          ['Avg per Expense', formatCurrency(avg, cur)],
          ['Active Months',   String(activeMonths)],
          ['Monthly Average', formatCurrency(monthlyAvg, cur)],
        ];
    pairs.forEach(([title, amount]) => {
      cards.appendChild(el('div', { class: 'card' },
        el('h3', null, title),
        el('div', { class: 'amount' }, amount),
      ));
    });
  }

  function needChart(id) {
    const lib = window.Chart;
    if (!lib) { console.warn('Chart.js not loaded'); return null; }
    const ctx = document.getElementById(id);
    if (!ctx) return null;
    if (charts[id]) { try { charts[id].destroy(); } catch (e) {} }
    return ctx;
  }

  function updateMonthlyChart() {
    // Spending trend = expense only. Income is surfaced in the Total Income
    // summary card; mixing it into the line chart would misrepresent trends.
    const expOnly = filteredExpenses.filter(isExpense);
    const cur = dominantCurrency(expOnly);
    const years = Array.from(new Set(expOnly.map(e => e.year))).sort();
    const data = {};
    years.forEach(y => data[y] = {});
    expOnly.forEach(e => { data[e.year][e.month] = (data[e.year][e.month] || 0) + e.amount; });
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const datasets = years.map((y, i) => ({
      label: String(y),
      data: MONTHS.map(m => data[y][m] || 0),
      borderColor: CHART_COLORS[i % CHART_COLORS.length],
      backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + '20',
      borderWidth: 3, fill: false, tension: 0.4,
    }));
    const ctx = needChart('monthlyChart'); if (!ctx) return;
    const theme = getThemeColors();
    charts.monthlyChart = new Chart(ctx, {
      type: 'line',
      data: { labels: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, position: 'top', labels: { color: theme.textColor } },
          tooltip: { callbacks: { label: (c) => c.dataset.label + ': ' + formatCurrency(c.raw, cur) } },
        },
        scales: {
          x: { ticks: { color: theme.textColor }, grid: { color: theme.gridColor } },
          y: { beginAtZero: true, ticks: { color: theme.textColor, callback: (v) => formatCurrency(v, cur) },
               grid: { color: theme.gridColor } },
        },
      },
    });
  }

  function updateCategoryChart() {
    const expOnly = filteredExpenses.filter(isExpense);
    const cur = dominantCurrency(expOnly);
    const totals = {};
    expOnly.forEach(e => { totals[e.category] = (totals[e.category] || 0) + e.amount; });
    // Sort big-to-small so the "Others" lump (when it kicks in) collects
    // the long tail rather than the headline categories.
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    // Show up to MAX_SHOWN categories individually. When there are more,
    // collapse the smallest into "Others" so the legend stays readable.
    // The tooltip on the "Others" slice spells out what got rolled up.
    const MAX_SHOWN = 9;
    let labels, amounts, otherBreakdown = null;
    if (sorted.length <= MAX_SHOWN + 1) {
      labels  = sorted.map(([k]) => k);
      amounts = sorted.map(([, v]) => v);
    } else {
      const head = sorted.slice(0, MAX_SHOWN);
      const tail = sorted.slice(MAX_SHOWN);
      const otherTotal = tail.reduce((s, [, v]) => s + v, 0);
      labels  = [...head.map(([k]) => k), 'Others (' + tail.length + ')'];
      amounts = [...head.map(([, v]) => v), otherTotal];
      otherBreakdown = tail; // [[name, amount], ...]
    }
    const ctx = needChart('categoryChart'); if (!ctx) return;
    const theme = getThemeColors();
    charts.categoryChart = new Chart(ctx, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: amounts, backgroundColor: CHART_COLORS }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { color: theme.textColor } },
          tooltip: {
            callbacks: {
              label: (c) => c.label + ': ' + formatCurrency(c.raw, cur),
              // For the Others slice, expand the rolled-up categories
              // underneath so the user can still see what's in there.
              afterLabel: (c) => {
                if (!otherBreakdown) return '';
                if (c.dataIndex !== labels.length - 1) return '';
                return otherBreakdown
                  .map(([name, amt]) => '  • ' + name + ': ' + formatCurrency(amt, cur))
                  .join('\n');
              },
            },
          },
        },
      },
    });
  }

  function updateMerchantChart() {
    const expOnly = filteredExpenses.filter(isExpense);
    const cur = dominantCurrency(expOnly);
    const data = {};
    expOnly.forEach(e => { data[e.merchant] = (data[e.merchant] || 0) + e.amount; });
    const sorted = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const ctx = needChart('merchantChart'); if (!ctx) return;
    const theme = getThemeColors();
    charts.merchantChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: sorted.map(([m]) => m),
        datasets: [{
          label: 'Total Spent', data: sorted.map(([, v]) => v),
          backgroundColor: 'rgba(102, 126, 234, 0.8)', borderColor: '#667eea', borderWidth: 1,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: theme.textColor, maxRotation: 45, minRotation: 45 },
               grid: { color: theme.gridColor } },
          y: { beginAtZero: true, ticks: { color: theme.textColor, callback: (v) => formatCurrency(v, cur) },
               grid: { color: theme.gridColor } },
        },
      },
    });
  }

  function updateAccountChart() {
    const expOnly = filteredExpenses.filter(isExpense);
    const cur = dominantCurrency(expOnly);
    const data = {};
    expOnly.forEach(e => { data[e.account] = (data[e.account] || 0) + e.amount; });
    const labels = Object.keys(data), amounts = Object.values(data);
    const ctx = needChart('accountChart'); if (!ctx) return;
    charts.accountChart = new Chart(ctx, {
      type: 'pie',
      data: { labels, datasets: [{ data: amounts, backgroundColor: CHART_COLORS }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom' },
          tooltip: { callbacks: { label: (c) => c.label + ': ' + formatCurrency(c.raw, cur) } },
        },
      },
    });
  }

  function updateTransactionsList() {
    const list = document.getElementById('transactionsList');
    if (!filteredExpenses.length) {
      list.innerHTML = '<div class="empty-state"><h3>No transactions found</h3><p>Try adjusting your filters.</p></div>';
      return;
    }
    // Sort: user-chosen column when recentSortKey is set, otherwise newest-
    // first by date (the original default). Amount sorts on magnitude so
    // "biggest first" orders refunds and charges the same way.
    const sortedAll = filteredExpenses.slice();
    if (recentSortKey) {
      const valueOf = (t, key) => {
        if (key === 'date')     return t.date || '';
        if (key === 'merchant') return t.merchant || '';
        if (key === 'category') return t.category || 'Uncategorized';
        if (key === 'account')  return t.account || '—';
        if (key === 'type')     return t.type || '';
        if (key === 'amount')   return Math.abs(Number(t.amount) || 0);
        return '';
      };
      const dir = recentSortDir === 'desc' ? -1 : 1;
      sortedAll.sort((a, b) => {
        const primary = cmpBy(valueOf(a, recentSortKey), valueOf(b, recentSortKey)) * dir;
        if (primary) return primary;
        return (a.id || 0) - (b.id || 0);
      });
    } else {
      sortedAll.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    }
    const sorted = sortedAll.slice(0, 50);

    // Build DOM imperatively so we can wire change handlers to each cell
    // without re-escaping the whole table on every keystroke.
    list.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'transactions-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const getSort = () => ({ key: recentSortKey, dir: recentSortDir });
    const setSort = (s) => { recentSortKey = s.key; recentSortDir = s.dir; updateTransactionsList(); };
    headRow.appendChild(sortableTh('Date',        'date',     getSort, setSort));
    headRow.appendChild(sortableTh('Vendor Name', 'merchant', getSort, setSort));
    headRow.appendChild(sortableTh('Category',    'category', getSort, setSort));
    headRow.appendChild(sortableTh('Account',     'account',  getSort, setSort));
    headRow.appendChild(sortableTh('Type',        'type',     getSort, setSort));
    headRow.appendChild(sortableTh('Amount',      'amount',   getSort, setSort));
    // Lock column mirrors Manage > Transactions: pin a row so future rule
    // sweeps don't override its category or display name. Click to toggle.
    const lockTh = document.createElement('th');
    lockTh.className = 'tx-lock-col';
    lockTh.title = 'Locked rows are not touched by category rules or merchant brand-collapses.';
    lockTh.textContent = 'Lock';
    headRow.appendChild(lockTh);
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    sorted.forEach(t => tbody.appendChild(buildTransactionRow(t)));
    table.appendChild(tbody);
    list.appendChild(table);
  }

  // The category cell prefers a clickable <select> over every known
  // category with a "+ New…" sentinel that swaps to a text input — the
  // user strongly prefers dropdowns over typing an autocomplete.
  function buildEditableCategoryCell(td, t) {
    const known = knownCategories.slice();

    async function commitCategory(next) {
      const val = (next || '').trim() || 'Uncategorized';
      // Manual edit auto-locks the row so future rule sweeps don't yank
      // it back. Same contract as Manage > Transactions.
      await persistTransactionEdit(t, { category: val, locked: true });
      t.category = val;
      t.locked = true;
      if (val !== 'Uncategorized' && !knownCategories.includes(val)) {
        knownCategories.push(val); knownCategories.sort();
        // Keep the page-level datalist in sync for anyone else who cares.
        const dl = document.getElementById('stats-known-categories');
        if (dl && !dl.querySelector('option[value="' + val.replace(/"/g, '\\"') + '"]')) {
          const opt = document.createElement('option'); opt.value = val; dl.appendChild(opt);
        }
      }
      // Auto-learn a rule keyed by the merchant's display name so the same
      // categorisation sticks for future imports. Silent on failure — it's
      // a nicety, not a hard requirement.
      try {
        const learnKey = t.merchant || t.merchant_original;
        if (learnKey && val && val !== 'Uncategorized' &&
            App.processing && App.processing.categorize &&
            App.processing.categorize.learnCategoryRule) {
          await App.processing.categorize.learnCategoryRule(learnKey, val);
        }
      } catch (e) { /* non-fatal */ }
      updateDashboard();
    }

    function renderSelect() {
      td.innerHTML = '';
      const sel = document.createElement('select');
      sel.className = 'editable-category editable-category--select';
      const optBlank = document.createElement('option');
      optBlank.value = ''; optBlank.textContent = '— Uncategorized —';
      sel.appendChild(optBlank);
      known.forEach(c => {
        const o = document.createElement('option');
        o.value = c; o.textContent = c;
        sel.appendChild(o);
      });
      // Preserve a category that's on the row but not in `known` so we
      // don't silently clobber it on change.
      if (t.category && t.category !== 'Uncategorized' && !known.includes(t.category)) {
        const o = document.createElement('option');
        o.value = t.category; o.textContent = t.category + ' (current)';
        sel.appendChild(o);
      }
      const optNew = document.createElement('option');
      optNew.value = '__new'; optNew.textContent = '+ New category…';
      sel.appendChild(optNew);

      sel.value = (!t.category || t.category === 'Uncategorized') ? '' : t.category;
      sel.addEventListener('change', async () => {
        if (sel.value === '__new') { renderInput(''); return; }
        await commitCategory(sel.value);
      });
      td.appendChild(sel);
    }

    function renderInput(initial) {
      td.innerHTML = '';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'editable-category';
      input.setAttribute('list', 'stats-known-categories');
      input.value = initial != null ? initial : (t.category || '');
      input.placeholder = 'Type a new category…';
      const finish = async () => {
        await commitCategory(input.value);
        renderSelect();
      };
      input.addEventListener('change', finish);
      input.addEventListener('blur', finish);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(); }
        if (e.key === 'Escape') { e.preventDefault(); renderSelect(); }
      });
      const back = document.createElement('button');
      back.type = 'button'; back.className = 'btn btn--ghost btn--small';
      back.textContent = '⟲'; back.title = 'Back to dropdown';
      back.addEventListener('click', () => renderSelect());
      td.appendChild(input);
      td.appendChild(back);
      input.focus(); input.select();
    }

    renderSelect();
  }

  // Render one row with editable category (<select> with "+ New…"
  // escape hatch) and account (<select> over known accounts). Rows
  // without an `id` are seed / fallback data and stay read-only.
  function buildTransactionRow(t) {
    const tr = document.createElement('tr');
    tr.appendChild(td(t.date));
    // Merchant cell shows the display name. Click to edit — the override
    // is saved to the merchants store and reapplied across every row that
    // shares the same original (and, via the cross-bank lookup, every row
    // that beautifies to the same name).
    const merchTd = document.createElement('td');
    if (typeof t.id === 'number' && (t.merchant_original || t.merchant)) {
      buildEditableMerchantCell(merchTd, t);
    } else {
      merchTd.className = 'merchant-cell';
      const main = document.createElement('div');
      main.className = 'merchant-cell__main';
      main.textContent = t.merchant || '';
      if (t.merchant_original && t.merchant_original !== t.merchant) {
        merchTd.title = t.merchant_original;
      }
      merchTd.appendChild(main);
    }
    tr.appendChild(merchTd);

    const catTd = document.createElement('td');
    if (typeof t.id === 'number') {
      buildEditableCategoryCell(catTd, t);
    } else {
      catTd.textContent = t.category || '';
      catTd.className = 'category-cell';
    }
    tr.appendChild(catTd);

    const acctTd = document.createElement('td');
    if (typeof t.id === 'number' && knownAccounts.length) {
      const sel = document.createElement('select');
      sel.className = 'editable-account';
      // "—" keeps the current legacy card label when no account matches.
      if (typeof t.account_id !== 'number') {
        const opt = document.createElement('option');
        opt.value = ''; opt.textContent = t.account || '—'; opt.selected = true;
        sel.appendChild(opt);
      }
      knownAccounts.forEach(a => {
        const opt = document.createElement('option');
        opt.value = String(a.id);
        opt.textContent = a.name + (a.currency ? ' (' + a.currency + ')' : '');
        if (t.account_id === a.id) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', async () => {
        const val = sel.value;
        const nextId = val ? parseInt(val, 10) : null;
        const patch = { account_id: nextId };
        // Keep the legacy `card` field in sync with the chosen account's
        // last IBAN digits so the rest of the app (and the fallback display
        // field) keep working.
        if (nextId) {
          const acct = knownAccounts.find(a => a.id === nextId);
          if (acct && acct.iban) patch.card = acct.iban.replace(/\s+/g, '').slice(-4);
        }
        await persistTransactionEdit(t, patch);
        t.account_id = nextId;
        Object.assign(t, patch);
        t.account = accountLabel(t);
        updateDashboard();
      });
      acctTd.appendChild(sel);
    } else {
      acctTd.textContent = t.account || ('*' + (t.card || '—'));
      acctTd.className = 'account-cell';
    }
    tr.appendChild(acctTd);

    // Transaction type (Card / Transfer / MB Way / ATM / Direct Debit /
    // Fee / Other). Read-only here — the Manage > Transactions tab is the
    // edit surface — but we show it so the user can spot miscategorised
    // rows at a glance.
    const typeTd = document.createElement('td');
    typeTd.className = 'type-cell';
    const N = (App.processing && App.processing.normalize) || {};
    const resolvedType = t.type
      || (N.normalizeTxType
          ? N.normalizeTxType(t.raw && t.raw.transaction_type)
          : '');
    typeTd.textContent = resolvedType || '';
    tr.appendChild(typeTd);

    const amtTd = document.createElement('td');
    const isInc = t.kind === 'income';
    amtTd.className = 'amount-cell' + (isInc ? ' amount-cell--income' : '');
    amtTd.textContent = (isInc ? '+' : '−') + formatCurrency(t.amount, t.currency);
    tr.appendChild(amtTd);

    // Lock cell — mirrors the toggle in Manage > Transactions. Stats rows
    // already auto-lock on inline category / display-name edits, so this
    // column is mostly a way to inspect or release that lock without
    // jumping over to Manage.
    const lockTd = document.createElement('td');
    lockTd.className = 'tx-lock-col';
    if (typeof t.id === 'number') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lock-btn ' + (t.locked ? 'lock-btn--on' : 'lock-btn--off');
      btn.textContent = t.locked ? '🔒' : '🔓';
      btn.title = t.locked
        ? 'Locked — rules will not change this row\'s category or display name. Click to unlock.'
        : 'Unlocked — click to pin this row\'s current category and display name so rules leave it alone.';
      btn.addEventListener('click', async () => {
        const next = !t.locked;
        try {
          await persistTransactionEdit(t, { locked: next });
          t.locked = next;
          btn.classList.toggle('lock-btn--on',  next);
          btn.classList.toggle('lock-btn--off', !next);
          btn.textContent = next ? '🔒' : '🔓';
          btn.title = next
            ? 'Locked — rules will not change this row\'s category or display name. Click to unlock.'
            : 'Unlocked — click to pin this row\'s current category and display name so rules leave it alone.';
          App.util.toast(next ? 'Row locked.' : 'Row unlocked.', 'success');
        } catch (err) {
          console.error(err);
          App.util.toast('Lock toggle failed: ' + (err && err.message || err), 'error');
        }
      });
      lockTd.appendChild(btn);
    }
    tr.appendChild(lockTd);
    return tr;
  }

  function td(text) {
    const e = document.createElement('td');
    e.textContent = text == null ? '' : String(text);
    return e;
  }

  // Persist an edit to IndexedDB, merging onto the current record so we
  // don't lose raw / description / import metadata.
  async function persistTransactionEdit(rowInMemory, patch) {
    try {
      const current = await App.storage.transactions.get(rowInMemory.id);
      if (!current) return;
      const next = Object.assign({}, current, patch);
      await App.storage.transactions.put(next);
    } catch (e) {
      console.error(e);
      App.util.toast('Could not save change: ' + e.message, 'error');
    }
  }

  // Upsert a merchant display override. Delegates to normalize.js, which
  // writes an anchored exact-match regex rule into the normalize_rules
  // store (legacy merchants-store writes have been retired — every
  // display-name rule now lives in one place). Empty display deletes the
  // rule so the beautifier takes back over.
  async function saveMerchantOverride(original, display) {
    if (!original) return null;
    const N = (App.processing && App.processing.normalize) || {};
    try {
      if (!display || !display.trim()) {
        if (N.deleteDisplayRuleByPattern) {
          const pattern = '^' + (N.escapeRegex ? N.escapeRegex(original) : String(original)) + '$';
          await N.deleteDisplayRuleByPattern(pattern, 'i');
        }
        return null;
      }
      if (N.saveExactDisplayOverride) {
        return await N.saveExactDisplayOverride(original, display);
      }
      return null;
    } catch (e) {
      console.error(e);
      App.util.toast('Could not save display name: ' + e.message, 'error');
      return null;
    }
  }

  // Rebuild the resolver from the current overrides snapshot so newly-saved
  // names reflow into every row that shares the same original (and, via the
  // cross-bank lookup, every row that beautifies to the same name).
  function rebuildResolver() {
    try {
      const rows = Array.from(merchantOverridesByOriginal.values());
      resolveMerchant = App.processing.normalize.buildMerchantResolver(rows);
    } catch (e) {
      resolveMerchant = (s) => s || '';
    }
    // Re-apply the resolver to every in-memory row so the next render shows
    // the updated display name everywhere, not just on the edited row.
    allExpenses.forEach(e => {
      e.merchant = resolveMerchant(e.merchant_original) || e.merchant_original || e.merchant;
    });
  }

  // Inline display-name editor for Recent Transactions. Click the name to
  // edit, Enter or blur to save, Escape to cancel. Saving upserts to the
  // merchants store so the override is shared with every other view.
  function buildEditableMerchantCell(td, t) {
    td.innerHTML = '';
    td.className = 'merchant-cell';

    function renderView() {
      td.innerHTML = '';
      const main = document.createElement('div');
      main.className = 'merchant-cell__main editable-merchant';
      main.tabIndex = 0;
      main.title = (t.merchant_original && t.merchant_original !== t.merchant)
        ? 'Original: ' + t.merchant_original + ' — click to edit display name'
        : 'Click to edit display name';
      main.textContent = t.merchant || t.merchant_original || '';
      const open = (e) => { if (e) e.preventDefault(); renderEdit(); };
      main.addEventListener('click', open);
      main.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') open(e);
      });
      td.appendChild(main);
    }

    function renderEdit() {
      td.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'merchant-cell__edit';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'editable-merchant-input';
      input.value = t.merchant || '';
      input.placeholder = t.merchant_original || 'Display name';
      let committed = false;
      const finish = async (save) => {
        if (committed) return;
        committed = true;
        if (!save) { renderView(); return; }
        const next = (input.value || '').trim();
        await saveMerchantOverride(t.merchant_original || t.merchant || '', next);
        // Auto-lock this specific row — siblings still update via the
        // merchant rule, but this row is now pinned against future
        // rule-driven changes.
        if (typeof t.id === 'number' && !t.locked) {
          try {
            await persistTransactionEdit(t, { locked: true });
            t.locked = true;
          } catch (e) { /* non-fatal */ }
        }
        rebuildResolver();
        // Refresh every visible row, not just this one — the override may
        // ripple across other rows that share the same original / brand.
        updateDashboard();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
      wrap.appendChild(input);
      td.appendChild(wrap);
      // Defer focus so the click handler that triggered edit doesn't
      // immediately blur the new input.
      setTimeout(() => { input.focus(); input.select(); }, 0);
    }

    renderView();
  }

  App.views = App.views || {};
  App.views.stats = { mount, unmount };
})();

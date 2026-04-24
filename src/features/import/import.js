/*
 * src/features/import/import.js — PDF import flow.
 *
 * Steps:
 *   1) Pick one or more PDF files.
 *   2) For each file: extract pages with PDF.js, try every template's
 *      detect() fn, use the winner, fall back to a manual dropdown.
 *   3) Present a single review table of candidate rows — user can edit
 *      category / account, spot duplicates, and uncheck rows.
 *   4) Commit to IndexedDB in a single batch, record an `imports` entry,
 *      and offer to jump to the dashboard.
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};
  const { el, escapeHtml, formatCurrency, toast, uuid, promptSelect } = App.util;

  // Per-document year prompt — used when a template can't deduce the year
  // from the PDF headers (no Data de Emissão, no PERÍODO DE, etc.). Returns
  // the picked year as a Number, or null if the user cancelled.
  // Range covers a sensible window: this year + 1 (in case of pre-dated
  // statements) down to 25 years ago. Default selection is the current year.
  async function promptYearForDocument(entry) {
    const now = new Date();
    const cur = now.getFullYear();
    const options = [];
    for (let y = cur + 1; y >= cur - 25; y--) {
      options.push({ value: String(y), label: String(y) });
    }
    const picked = await promptSelect({
      title: 'Pick a year for this statement',
      message: 'No issue date or period header was found in "' + (entry.file && entry.file.name) +
        '". Select the year these transactions belong to so dates resolve correctly.',
      options,
      defaultValue: String(cur),
      confirmLabel: 'Use this year',
    });
    if (picked == null) return null;
    const n = Number(picked);
    return isFinite(n) ? n : null;
  }

  // Session state kept on the view instance so navigating back/forward
  // doesn't silently drop an in-progress import.
  let state = null;
  function resetState() {
    state = {
      stage: 'pick',            // 'pick' | 'parsing' | 'review' | 'committed'
      files: [],                // [{file, parsed, template, rows, error}]
      candidates: [],           // flat list of candidate rows with index metadata
      warnings: [],             // duplicate warnings
      existingTransactions: [],
      accounts: [],
      rules: [],
    };
  }
  resetState();

  // ---------- Step 1: picker ----------
  function renderPicker(root) {
    const drop = el('label', { class: 'dropzone', for: 'pdf-input' },
      el('div', { class: 'dropzone__icon' }, '📄'),
      el('div', { class: 'dropzone__title' }, 'Drop PDF statements here, or click to choose'),
      el('div', { class: 'dropzone__sub' }, 'Multiple files are fine — each one is matched to a template automatically.'),
      el('input', { id: 'pdf-input', type: 'file', multiple: '', accept: '.pdf,application/pdf', style: 'display:none' })
    );
    root.appendChild(drop);

    const templates = App.templates.all();
    const tplList = el('div', { class: 'template-list' },
      el('h3', null, 'Supported banks'),
      el('ul', { class: 'template-list__ul' },
        templates.map(t => el('li', null,
          el('strong', null, t.bank),
          el('span', { class: 'muted' }, ' — ' + t.country + ' · ' + t.currency)
        ))
      ),
      el('p', { class: 'muted template-list__note' },
        'Other banks are not yet supported. If detection fails, you can pick a template manually on the review screen.')
    );
    root.appendChild(tplList);

    const input = drop.querySelector('input');
    input.addEventListener('change', (e) => handleFiles(e.target.files));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dropzone--over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dropzone--over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); drop.classList.remove('dropzone--over');
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!files.length) {
      toast('No PDF files detected in the selection.', 'warn'); return;
    }
    state.files = files.map(f => ({ file: f, status: 'pending' }));
    state.stage = 'parsing';
    await render(); // switches to parsing view
    await parseAll();
  }

  // ---------- Step 2: parse ----------
  async function parseAll() {
    try {
      await App.pdf.ready();
    } catch (e) {
      toast('Could not load PDF.js: ' + e.message, 'error');
      for (const f of state.files) { f.status = 'error'; f.error = 'PDF.js unavailable (' + e.message + ')'; }
      await toReview();
      return;
    }

    const list = document.getElementById('parsing-list');
    for (let i = 0; i < state.files.length; i++) {
      const entry = state.files[i];
      updateParsingRow(list, i, entry, 'Extracting text…');
      try {
        const parsed = await App.pdf.extractPages(entry.file);
        entry.parsed = parsed;
        const match = App.templates.detect(parsed);
        entry.template = match ? match.template : null;
        entry.confidence = match ? match.confidence : 0;
        if (entry.template) {
          updateParsingRow(list, i, entry, 'Detected: ' + entry.template.bank + ' (' + (entry.confidence * 100 | 0) + '%)');
          try {
            let result = entry.template.parse(parsed);
            // Year-anchor prompt: a template that can't determine the year
            // from its own headers (Santander PT today, possibly others
            // tomorrow) returns `meta.needs_year_input: true` and an empty
            // row list. We pause here, ask the user to pick a year for
            // *this specific document*, and re-parse with `opts.userYear`.
            // The prompt is per-document so a batch with mixed years can
            // resolve each one correctly.
            if (result && result.meta && result.meta.needs_year_input) {
              updateParsingRow(list, i, entry, 'Needs year — waiting for input…');
              const picked = await promptYearForDocument(entry);
              if (picked == null) {
                entry.status = 'error';
                entry.error = 'Skipped — no year was supplied.';
                updateParsingRow(list, i, entry, entry.error, true);
                continue;
              }
              result = entry.template.parse(parsed, { userYear: String(picked) });
            }
            entry.rows = result.rows || [];
            entry.meta = result.meta || {};
            entry.status = 'parsed';
            updateParsingRow(list, i, entry, entry.rows.length + ' transactions parsed' +
              (entry.meta.year_anchor_source === 'user' ? ' (year supplied manually)' : ''));
          } catch (e) {
            console.error(e);
            entry.status = 'error';
            entry.error = 'Parser crashed: ' + e.message;
            updateParsingRow(list, i, entry, entry.error, true);
          }
        } else {
          entry.status = 'unmatched';
          entry.error = 'No template matched this PDF.';
          updateParsingRow(list, i, entry, entry.error, true);
        }
      } catch (e) {
        console.error(e);
        entry.status = 'error';
        entry.error = 'Could not read PDF: ' + e.message;
        updateParsingRow(list, i, entry, entry.error, true);
      }
    }
    await toReview();
  }

  function updateParsingRow(list, index, entry, msg, err) {
    if (!list) return;
    let row = list.querySelector('[data-parsing-index="' + index + '"]');
    if (!row) {
      row = el('li', { class: 'parsing-row', dataset: { parsingIndex: String(index) } });
      list.appendChild(row);
    }
    row.innerHTML = '';
    row.appendChild(el('span', { class: 'parsing-row__name' }, entry.file.name));
    row.appendChild(el('span', {
      class: 'parsing-row__status ' + (err ? 'parsing-row__status--error' : ''),
    }, msg));
  }

  function renderParsing(root) {
    root.appendChild(el('h2', null, 'Parsing…'));
    root.appendChild(el('p', { class: 'muted' }, 'Running PDF extraction locally. Large files can take a few seconds.'));
    const list = el('ul', { id: 'parsing-list', class: 'parsing-list' });
    root.appendChild(list);
    state.files.forEach((f, i) => updateParsingRow(list, i, f, 'Queued'));
  }

  // ---------- Step 3: review ----------
  async function toReview() {
    state.stage = 'review';
    state.accounts = await App.storage.accounts.all();
    state.rules = await App.storage.rules.all();
    // Load existing transactions once so we can both duplicate-check and
    // use them as a history source for categorization.
    state.existingTransactions = await App.storage.transactions.all();
    // Load merchant overrides so the review table shows the *same* display
    // name the rest of the app will end up using — and so the user's edits
    // can feed right back into that store when they commit.
    try { state.merchants = await App.storage.merchants.all(); }
    catch (e) { state.merchants = []; }
    const N = (App.processing && App.processing.normalize) || {};
    state.resolver = N.buildMerchantResolver
      ? N.buildMerchantResolver(state.merchants)
      : (original) => original;
    // In-memory overrides typed during this review. Keyed by the row's
    // *original* merchant string, so editing one row auto-updates every
    // sibling and we can write one merchants-store row per key on commit.
    state.displayOverrides = state.displayOverrides || new Map();
    // Categories the user has used before (plus any stored in the categories
    // store) — drive the datalist in the review table.
    state.knownCategories = await collectKnownCategories(state.existingTransactions);

    // Normalize the transaction-type from each template's raw field into the
    // canonical vocabulary before handing rows to the review table. We also
    // compute a display name up-front so later steps (duplicate detection,
    // category rules) can lean on it.
    const allRows = state.files.flatMap(f => f.rows || []);
    allRows.forEach(r => {
      if (!r.type) {
        const raw = (r.raw && r.raw.transaction_type) || null;
        r.type = N.normalizeTxType ? N.normalizeTxType(raw) : 'Other';
      }
    });

    await App.processing.categorize.categorizeRows(
      allRows,
      state.existingTransactions,
      state.resolver,
    );
    // Flatten into candidate rows with source file index.
    state.candidates = [];
    state.files.forEach((f, fi) => {
      (f.rows || []).forEach((r, ri) => {
        state.candidates.push({
          __fileIndex: fi, __rowIndex: ri, __selected: true,
          ...r,
        });
      });
    });
    // Duplicate check against existing storage.
    state.warnings = App.processing.duplicate.findDuplicates(state.candidates, state.existingTransactions);
    await render();
  }

  async function collectKnownCategories(existingTransactions) {
    const set = new Set();
    (existingTransactions || []).forEach(t => {
      if (t.category && t.category !== 'Uncategorized') set.add(t.category);
    });
    // Categories store may hold user-curated ones too.
    try {
      const stored = await App.storage.categories.all();
      (stored || []).forEach(c => { if (c.name) set.add(c.name); });
    } catch (e) { /* non-fatal */ }
    // Rules store implicitly defines categories as well.
    (state.rules || []).forEach(r => { if (r.category) set.add(r.category); });
    return Array.from(set).sort();
  }

  function renderReview(root) {
    const parsedOk = state.files.filter(f => f.status === 'parsed').length;
    const failed   = state.files.filter(f => f.status !== 'parsed');
    root.appendChild(el('h2', null, 'Review'));

    // File summary header
    const summary = el('div', { class: 'review-summary' });
    summary.appendChild(el('span', null, parsedOk + ' of ' + state.files.length + ' files parsed'));
    summary.appendChild(el('span', null, ' · ' + state.candidates.length + ' candidate transactions'));
    if (state.warnings.length) {
      summary.appendChild(el('span', { class: 'pill pill--warn' }, state.warnings.length + ' possible duplicate' + (state.warnings.length === 1 ? '' : 's')));
    }
    root.appendChild(summary);

    if (failed.length) {
      const fBox = el('div', { class: 'review-failed' },
        el('h3', null, 'Could not parse:'),
        el('ul', null, failed.map(f => el('li', null,
          el('strong', null, f.file.name),
          ' — ',
          el('span', null, f.error || 'Unknown error'),
          ' ',
          templatePicker(f),
        )))
      );
      root.appendChild(fBox);
    }

    // Per-file account assignment
    const accBlock = el('div', { class: 'review-accounts' });
    accBlock.appendChild(el('h3', null, 'Assign accounts'));
    accBlock.appendChild(el('p', { class: 'muted' },
      'Each statement maps to an account. Pick an existing account or let us create one from the detected metadata.'));
    state.files.forEach((f, fi) => {
      if (f.status !== 'parsed') return;
      accBlock.appendChild(renderAccountRow(f, fi));
    });
    root.appendChild(accBlock);

    // Candidates table
    if (state.candidates.length) {
      root.appendChild(renderCandidateTable());
    } else {
      root.appendChild(el('div', { class: 'empty-state' },
        el('h3', null, 'Nothing to import'),
        el('p', null, 'None of the selected PDFs produced transaction rows.')));
    }

    // Footer actions
    const footer = el('div', { class: 'review-footer' },
      el('button', { type: 'button', class: 'btn btn--ghost',
        onclick: () => { resetState(); render(); } }, 'Start over'),
      el('span', { class: 'spacer' }, ''),
      el('button', {
        type: 'button', class: 'btn btn--primary',
        disabled: state.candidates.some(c => c.__selected) ? null : '',
        onclick: commit,
      }, 'Commit ' + state.candidates.filter(c => c.__selected).length + ' transactions'),
    );
    root.appendChild(footer);
  }

  function templatePicker(entry) {
    const sel = el('select', {
      onchange: async (e) => {
        const id = e.target.value;
        if (!id) return;
        const tpl = App.templates.byId(id);
        if (!tpl || !entry.parsed) return;
        try {
          let result = tpl.parse(entry.parsed);
          // Same year-prompt path as the auto-detect flow — the manual
          // template-picker can hit a doc with no year anchor too.
          if (result && result.meta && result.meta.needs_year_input) {
            const picked = await promptYearForDocument(entry);
            if (picked == null) {
              toast('Skipped — no year was supplied.', 'warn');
              return;
            }
            result = tpl.parse(entry.parsed, { userYear: String(picked) });
          }
          entry.template = tpl; entry.rows = result.rows || [];
          entry.meta = result.meta || {}; entry.status = 'parsed';
          entry.error = null;
          await toReview();
        } catch (e) {
          toast('Parser failed: ' + e.message, 'error');
        }
      },
    },
      el('option', { value: '' }, 'Pick a template manually…'),
      ...App.templates.all().map(t => el('option', { value: t.id }, t.bank))
    );
    return sel;
  }

  // Each file may produce one or more sub-accounts (e.g. N26 Main + Spaces).
  // We represent them as an ordered array of { key, meta, __accountChoice,
  // __pendingAccount } on `entry.__accountGroups`. The grouping key is the
  // row's `_accountKey` field, or 'default' if the parser didn't tag rows.
  function ensureAccountGroups(entry) {
    if (entry.__accountGroups) return entry.__accountGroups;
    const groups = [];
    const byKey = new Map();

    const metaAccounts = entry.meta && Array.isArray(entry.meta.accounts) ? entry.meta.accounts : null;
    if (metaAccounts && metaAccounts.length) {
      metaAccounts.forEach(a => {
        const g = { key: a.key, meta: Object.assign({}, a) };
        byKey.set(a.key, g); groups.push(g);
      });
    } else {
      // Default single group: inherit the file-level meta.
      const g = {
        key: 'default',
        meta: {
          name: (entry.meta && entry.meta.iban
            ? (entry.template.bank + ' ' + entry.meta.iban.slice(-4))
            : (entry.meta && entry.meta.account_identifier
               ? (entry.template.bank + ' ' + entry.meta.account_identifier)
               : entry.template.bank)),
          iban: (entry.meta && entry.meta.iban) || null,
          bank: entry.template.bank,
          currency: entry.template.currency,
          rowCount: (entry.rows || []).length,
        },
      };
      byKey.set('default', g); groups.push(g);
    }

    // Make sure every row has an _accountKey that points to a known group.
    (entry.rows || []).forEach(r => {
      if (!r._accountKey || !byKey.has(r._accountKey)) r._accountKey = groups[0].key;
    });
    // Backfill rowCount from the actual rows (guard against mismatches).
    groups.forEach(g => {
      g.meta.rowCount = (entry.rows || []).filter(r => r._accountKey === g.key).length;
    });
    entry.__accountGroups = groups;
    return groups;
  }

  // Apply an account assignment to one sub-group within a file. Updates both
  // the parsed rows and any matching candidate snapshots.
  function assignAccount(fileIndex, accountKey, accountId) {
    const entry = state.files[fileIndex];
    if (!entry) return;
    (entry.rows || []).forEach(r => {
      if ((r._accountKey || 'default') === accountKey) r.account_id = accountId;
    });
    state.candidates.forEach(c => {
      if (c.__fileIndex === fileIndex && (c._accountKey || 'default') === accountKey) {
        c.account_id = accountId;
      }
    });
  }

  function renderAccountRow(entry, fileIndex) {
    const groups = ensureAccountGroups(entry);
    const container = el('div', { class: 'account-file-block' });
    container.appendChild(el('div', { class: 'account-file-block__head' },
      el('span', { class: 'account-row__file' }, entry.file.name),
      el('span', { class: 'muted' },
        entry.template.bank + ' · ' + (entry.rows || []).length + ' rows' +
        (groups.length > 1 ? ' · ' + groups.length + ' sub-accounts' : '')),
    ));
    groups.forEach(g => container.appendChild(renderAccountGroupRow(entry, fileIndex, g)));
    return container;
  }

  function renderAccountGroupRow(entry, fileIndex, group) {
    const suggestedLabel = group.meta.name || entry.template.bank;

    // Initialize account selection on first render only. `__accountChoice`
    // tracks the <select> value explicitly so the user's choice survives
    // re-renders.
    if (!group.__initialized) {
      group.__initialized = true;
      // Auto-match against existing accounts. Try in order:
      //   1) IBAN (exact, whitespace-insensitive) — strongest signal.
      //   2) account_identifier fuzzy match. Multi-account PDFs (e.g. N26
      //      Spaces) often don't expose a separate IBAN per sub-account, so
      //      we also compare the raw identifier against the existing
      //      accounts' iban / account_number / name.
      //   3) Bank + name match — a last-resort so re-importing the same
      //      statement doesn't create a duplicate account.
      // Without this the user saw every sub-account default to "Create new"
      // on every import, silently accumulating duplicate accounts.
      let prematch = null;
      const normalize = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
      const ibanClean = group.meta.iban ? normalize(group.meta.iban) : '';
      const identClean = group.meta.account_identifier ? normalize(group.meta.account_identifier) : '';
      if (ibanClean) {
        prematch = state.accounts.find(a => normalize(a.iban) === ibanClean);
      }
      if (!prematch && identClean) {
        prematch = state.accounts.find(a =>
          normalize(a.iban).endsWith(identClean) ||
          normalize(a.account_number) === identClean ||
          normalize(a.name).includes(identClean)
        );
      }
      if (!prematch) {
        // Same bank + same suggested name already on file? Treat as match.
        const bank = group.meta.bank || entry.template.bank;
        const want = normalize(suggestedLabel);
        prematch = state.accounts.find(a =>
          (a.bank || '').toLowerCase() === (bank || '').toLowerCase() &&
          normalize(a.name) === want
        );
      }
      if (prematch) {
        group.__accountChoice = String(prematch.id);
        group.__pendingAccount = null;
        assignAccount(fileIndex, group.key, prematch.id);
      } else {
        group.__accountChoice = '__new';
        group.__pendingAccount = {
          name: suggestedLabel,
          bank: group.meta.bank || entry.template.bank,
          currency: group.meta.currency || entry.template.currency,
          iban: group.meta.iban || null,
          is_own: true,
        };
        assignAccount(fileIndex, group.key, '__pending_' + fileIndex + '_' + group.key);
      }
    }

    const select = el('select', {
      dataset: { fileIndex: String(fileIndex), accountKey: group.key },
      onchange: (e) => {
        const val = e.target.value;
        group.__accountChoice = val;
        if (val === '__new') {
          group.__pendingAccount = {
            name: suggestedLabel,
            bank: group.meta.bank || entry.template.bank,
            currency: group.meta.currency || entry.template.currency,
            iban: group.meta.iban || null,
            is_own: true,
          };
          assignAccount(fileIndex, group.key, '__pending_' + fileIndex + '_' + group.key);
        } else if (val) {
          group.__pendingAccount = null;
          assignAccount(fileIndex, group.key, parseInt(val, 10));
        } else {
          group.__pendingAccount = null;
          assignAccount(fileIndex, group.key, null);
        }
        state.warnings = App.processing.duplicate.findDuplicates(state.candidates, state.existingTransactions);
        render();
      },
    },
      el('option', { value: '' }, 'Choose account…'),
      el('option', { value: '__new' }, 'Create new: ' + suggestedLabel),
      ...state.accounts.map(a => el('option', { value: String(a.id) }, a.name + ' (' + (a.currency || 'EUR') + ')'))
    );
    select.value = group.__accountChoice || '';

    const label = group.key === 'default'
      ? ''
      : group.key + ' (' + (group.meta.rowCount || 0) + ')';

    return el('div', { class: 'account-row account-row--group' },
      label ? el('span', { class: 'account-row__group' }, label) : null,
      el('span', { class: 'spacer' }, ''),
      select,
    );
  }

  function renderCandidateTable() {
    // Wrap the table so we can keep the datalist as a sibling (a <datalist>
    // inside <table> is invalid HTML and was silently dropped by the parser).
    // We also use a real <select> for the category cell — a bare datalist
    // requires typing to reveal options, which the user read as "broken".
    const wrap = el('div', { class: 'candidates-wrap' });
    const datalistId = 'known-categories';
    const datalist = el('datalist', { id: datalistId },
      ...(state.knownCategories || []).map(c => el('option', { value: c }))
    );
    wrap.appendChild(datalist);
    const table = el('table', { class: 'candidates' });
    wrap.appendChild(table);

    // Build the category cell: a <select> over known categories + a "+ New…"
    // option that swaps the cell for a free-text input. The cell flips back
    // to the select once the user commits a new name (so the name is
    // immediately available across the table without a re-render).
    function renderCategoryCell(row) {
      const td = el('td', null);
      const known = state.knownCategories || [];

      function renderSelect() {
        td.innerHTML = '';
        const sel = document.createElement('select');
        sel.className = 'category-select';
        // Empty option = Uncategorized.
        const optEmpty = document.createElement('option');
        optEmpty.value = ''; optEmpty.textContent = '— Uncategorized —';
        sel.appendChild(optEmpty);
        known.forEach(c => {
          const o = document.createElement('option');
          o.value = c; o.textContent = c;
          sel.appendChild(o);
        });
        // If the row's current category isn't in `known`, surface it as
        // a sticky option so the user doesn't silently lose the value.
        if (row.category && !known.includes(row.category) && row.category !== 'Uncategorized') {
          const o = document.createElement('option');
          o.value = row.category; o.textContent = row.category + ' (current)';
          sel.appendChild(o);
        }
        const optNew = document.createElement('option');
        optNew.value = '__new'; optNew.textContent = '+ New category…';
        sel.appendChild(optNew);

        sel.value = (!row.category || row.category === 'Uncategorized') ? '' : row.category;
        sel.addEventListener('change', (e) => {
          if (e.target.value === '__new') {
            renderInput('');
          } else {
            row.category = e.target.value || null;
          }
        });
        td.appendChild(sel);
      }

      function renderInput(initial) {
        td.innerHTML = '';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = initial != null ? initial : (row.category || '');
        input.setAttribute('list', datalistId);
        input.placeholder = 'Type a new category…';
        input.className = 'category-input';
        const commit = () => {
          const v = (input.value || '').trim();
          row.category = v || null;
          // Teach the table about this new category so sibling rows can
          // pick it from their dropdown too.
          if (v && !state.knownCategories.includes(v)) {
            state.knownCategories.push(v);
            state.knownCategories.sort();
            datalist.appendChild(el('option', { value: v }));
          }
          renderSelect();
        };
        input.addEventListener('change', commit);
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); renderSelect(); }
        });
        const back = document.createElement('button');
        back.type = 'button'; back.className = 'btn btn--ghost btn--small';
        back.textContent = '⟲';
        back.title = 'Back to dropdown';
        back.addEventListener('click', () => renderSelect());
        td.appendChild(input);
        td.appendChild(back);
        input.focus();
        input.select();
      }

      renderSelect();
      return td;
    }

    table.appendChild(el('thead', null,
      el('tr', null,
        el('th', null, ''),
        el('th', null, 'Date'),
        el('th', null, 'Merchant (original)'),
        el('th', null, 'Display name'),
        el('th', null, 'Category'),
        el('th', null, 'Type'),
        el('th', null, 'Account'),
        el('th', { class: 'num' }, 'Amount'),
        el('th', null, 'Notes'),
      )
    ));
    const warnByIndex = new Map();
    state.warnings.forEach(w => warnByIndex.set(w.index, w));
    const N = (App.processing && App.processing.normalize) || {};
    const TX_TYPES = N.TX_TYPE_VOCAB || ['Card', 'Transfer', 'MB Way', 'ATM', 'Direct Debit', 'Fee', 'Other'];
    // Current display for a row: an in-session override > merchants store >
    // beautifier. Resolving here keeps the table in sync with what will
    // actually land in storage on commit.
    function displayFor(original) {
      if (!original) return '';
      const raw = original.trim();
      if (state.displayOverrides.has(raw)) return state.displayOverrides.get(raw);
      const resolved = state.resolver ? state.resolver(raw) : null;
      return (resolved && resolved.trim()) || raw;
    }

    const tbody = el('tbody');
    state.candidates.forEach((row, i) => {
      const warn = warnByIndex.get(i);
      const tr = el('tr', { class: 'candidate-row' +
        (warn ? ' candidate-row--warn-' + warn.severity : '') +
        (row.__selected ? '' : ' candidate-row--off') });

      tr.appendChild(el('td', null, el('input', {
        type: 'checkbox',
        checked: row.__selected ? '' : null,
        onchange: (e) => {
          row.__selected = e.target.checked;
          tr.classList.toggle('candidate-row--off', !row.__selected);
          updateCommitCount();
        },
      })));
      tr.appendChild(el('td', null, row.date));
      tr.appendChild(el('td', { class: 'tx-original-cell', title: row.merchant || '' }, row.merchant || ''));

      // Display-name cell. Edits write to the in-session override map and
      // propagate to every other candidate sharing the same original on the
      // next render. Blank reverts to the beautifier suggestion. The value
      // is persisted to the merchants store at commit time.
      const original = (row.merchant || '').trim();
      const displayTd = el('td', { class: 'tx-display-cell' });
      const displayInput = el('input', {
        type: 'text',
        class: 'tx-display-input',
        value: displayFor(original),
        placeholder: displayFor(original),
        disabled: original ? null : '',
        title: original
          ? 'Applies to every imported row with merchant "' + original + '". Saved to the merchants store on commit.'
          : 'No merchant on this row.',
        onchange: (e) => {
          if (!original) return;
          const v = (e.target.value || '').trim();
          if (v) state.displayOverrides.set(original, v);
          else state.displayOverrides.delete(original);
          // Refresh sibling rows that share the same original so they pick
          // up the new display immediately.
          const rows = tbody.querySelectorAll('tr');
          state.candidates.forEach((r2, j) => {
            if ((r2.merchant || '').trim() !== original) return;
            const inp = rows[j] && rows[j].querySelector('.tx-display-input');
            if (inp && inp !== e.target) inp.value = displayFor(original);
          });
        },
      });
      displayTd.appendChild(displayInput);
      tr.appendChild(displayTd);

      tr.appendChild(renderCategoryCell(row));

      // Transaction-type cell: a <select> over the canonical vocabulary.
      // Row already has `type` set by toReview() (normalized from the
      // template's raw.transaction_type); this lets the user override before
      // commit.
      const typeTd = el('td', null);
      const typeSel = el('select', {
        class: 'tx-type-input',
        onchange: (e) => { row.type = e.target.value; },
      },
        ...TX_TYPES.map(t => el('option', {
          value: t, selected: t === row.type ? '' : null,
        }, t)),
      );
      typeTd.appendChild(typeSel);
      tr.appendChild(typeTd);

      const srcFile = state.files[row.__fileIndex];
      const srcGroup = srcFile && (srcFile.__accountGroups || []).find(
        g => g.key === (row._accountKey || 'default'));
      const accountLabel = srcGroup && srcGroup.__pendingAccount
        ? '(new) ' + srcGroup.__pendingAccount.name
        : (typeof row.account_id === 'number'
            ? (state.accounts.find(a => a.id === row.account_id) || {}).name || String(row.account_id)
            : '—');
      tr.appendChild(el('td', null, accountLabel));
      tr.appendChild(el('td', { class: 'num' },
        (row.kind === 'expense' ? '−' : '+') + formatCurrency(row.amount, row.currency)));

      if (warn) {
        tr.appendChild(el('td', null,
          el('span', { class: 'pill pill--' + warn.severity },
            warn.severity === 'hard' ? 'Duplicate' : 'Possible duplicate'),
          ' ', el('small', { class: 'muted' },
            'matches ' + warn.existing.merchant + ' on ' + warn.existing.date)));
      } else {
        tr.appendChild(el('td', null, ''));
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    function updateCommitCount() {
      const btn = document.querySelector('.review-footer .btn--primary');
      if (!btn) return;
      const n = state.candidates.filter(c => c.__selected).length;
      btn.textContent = 'Commit ' + n + ' transactions';
      btn.disabled = n === 0;
    }

    return wrap;
  }

  // ---------- Step 4: commit ----------
  async function commit() {
    const selected = state.candidates.filter(c => c.__selected);
    if (!selected.length) { toast('Nothing selected to commit.', 'warn'); return; }

    // Create any pending accounts first. Each file may have multiple sub-
    // account groups (e.g. N26 Main + Spaces), so iterate every group.
    const accountMap = {}; // placeholder id -> real id
    for (let i = 0; i < state.files.length; i++) {
      const f = state.files[i];
      const groups = f.__accountGroups || [];
      for (const g of groups) {
        if (!g.__pendingAccount) continue;
        const newAcct = Object.assign({ created_at: new Date().toISOString() }, g.__pendingAccount);
        delete newAcct.id;
        const newId = await App.storage.accounts.put(newAcct);
        accountMap['__pending_' + i + '_' + g.key] = newId;
      }
    }

    const batchId = uuid();
    const now = new Date().toISOString();
    // Belt-and-braces date clamp: even if a template misbehaves and emits a
    // future date, we walk it back here so no future-dated row hits storage.
    // Track how many we touched so we can surface a warning toast.
    const D = (App.processing && App.processing.dates) || null;
    let clampedDates = 0;
    const rowsToInsert = selected.map((r) => {
      const account_id = (typeof r.account_id === 'string' && accountMap[r.account_id])
        ? accountMap[r.account_id] : r.account_id;
      // Drop view-only fields.
      const out = Object.assign({}, r);
      delete out.__selected; delete out.__fileIndex; delete out.__rowIndex;
      delete out._accountKey;
      out.account_id = account_id;
      out.import_batch_id = batchId;
      out.imported_at = now;
      if (D && D.isFutureDate && D.clampFutureDate && out.date && D.isFutureDate(out.date)) {
        const adjusted = D.clampFutureDate(out.date);
        if (adjusted !== out.date) {
          out.date = adjusted;
          // Recompute the year so the Stats year-picker stays consistent.
          const m = /^(\d{4})/.exec(adjusted);
          if (m) out.year = parseInt(m[1], 10);
          clampedDates++;
        }
      }
      // Belt-and-braces: toReview() already seeds `type`, but guard here in
      // case a template path skipped the normalization step.
      if (!out.type) {
        const raw = (out.raw && out.raw.transaction_type) || null;
        const N = (App.processing && App.processing.normalize) || {};
        out.type = N.normalizeTxType ? N.normalizeTxType(raw) : 'Other';
      }
      return out;
    });

    // Persist display-name overrides the user typed during review. These
    // go into the regex-based normalize_rules store as anchored exact-match
    // patterns (^escapeRegex(original)$, flag 'i') so they share a single
    // source of truth with the auto-generated brand collapses. We do this
    // before writing transactions so a fresh import batch that references
    // the override already sees it on the next re-read.
    try {
      if (state.displayOverrides && state.displayOverrides.size) {
        const N = (App.processing && App.processing.normalize) || {};
        for (const [original, display] of state.displayOverrides.entries()) {
          if (N.saveExactDisplayOverride) {
            await N.saveExactDisplayOverride(original, display);
          }
        }
      }
    } catch (e) {
      // Don't block the import if the rules store misbehaves — we'll log
      // and keep going. The user can always re-edit in Manage.
      console.warn('Merchant override save failed:', e);
    }

    try {
      await App.storage.transactions.putMany(rowsToInsert);
      // NOTE: do NOT set id: undefined here — some IndexedDB implementations
      // interpret an own-property `id=undefined` as an invalid explicit key and
      // refuse to fall through to the autoIncrement path. Omitting the field
      // lets the store assign a fresh id.
      await App.storage.imports.put({
        batch_id: batchId,
        imported_at: now,
        files: state.files.filter(f => f.status === 'parsed').map(f => ({
          name: f.file.name, bank: f.template && f.template.bank, rows: (f.rows || []).length,
        })),
        row_count: rowsToInsert.length,
      });
      state.stage = 'committed';
      state.committedCount = rowsToInsert.length;
      state.committedBatchId = batchId;
      toast('Imported ' + rowsToInsert.length + ' transactions.', 'success');
      if (clampedDates) {
        toast('Adjusted ' + clampedDates + ' future-dated row' +
          (clampedDates === 1 ? '' : 's') + ' back to past dates.', 'warn');
      }
      render();
    } catch (e) {
      console.error(e);
      toast('Commit failed: ' + e.message, 'error');
    }
  }

  function renderCommitted(root) {
    root.appendChild(el('h2', null, '✅ Import complete'));
    root.appendChild(el('p', null,
      'Stored ' + state.committedCount + ' transactions in your local database.'));
    root.appendChild(el('div', { class: 'review-footer' },
      el('button', { type: 'button', class: 'btn btn--ghost',
        onclick: () => { resetState(); render(); } }, 'Import more'),
      el('span', { class: 'spacer' }, ''),
      el('button', { type: 'button', class: 'btn btn--primary',
        onclick: () => App.router.navigate('/stats') }, 'Open dashboard →'),
    ));
  }

  // ---------- Router / render ----------
  let rootEl = null;
  async function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    const wrap = el('div', { class: 'view view--import' });
    wrap.appendChild(el('div', { class: 'view-breadcrumb' },
      el('button', { class: 'linklike', onclick: () => App.router.navigate('/') }, '← Home'),
      el('span', null, '  /  Import'),
    ));
    if (state.stage === 'pick') renderPicker(wrap);
    else if (state.stage === 'parsing') renderParsing(wrap);
    else if (state.stage === 'review') renderReview(wrap);
    else if (state.stage === 'committed') renderCommitted(wrap);
    rootEl.appendChild(wrap);
  }

  async function mount(container) {
    rootEl = container;
    await App.storage.open();
    // If we're re-entering with a committed state, start fresh.
    if (state.stage === 'committed') resetState();
    await render();
  }
  function unmount() {
    // Preserve state while user navigates around briefly; landing reset is fine.
  }

  App.views = App.views || {};
  App.views.import = { mount, unmount };
})();

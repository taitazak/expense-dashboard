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
  const { el, escapeHtml, formatCurrency, toast, uuid } = App.util;

  // (The old per-document year popup was retired in favour of an inline
  // Year dropdown rendered in renderAccountRow when a parsed file's
  // template raised needs_year_input. See `entry.needs_year_input`.)

  // Session state kept on the view instance so navigating back/forward
  // doesn't silently drop an in-progress import.
  //
  // Stages:
  //   'pick'      → file chooser
  //   'parsing'   → PDF extraction in progress (CSVs skip this stage)
  //   'csvMap'    → user mapping CSV columns to canonical fields
  //   'review'    → unified review table over PDF + CSV rows
  //   'committed' → done
  let state = null;
  function resetState() {
    state = {
      stage: 'pick',
      files: [],                // [{file, parsed, template, rows, error}]
      csvFiles: [],             // [{file, text, rows, mapping, templateId, error}]
      candidates: [],           // flat list of candidate rows with index metadata
      warnings: [],
      existingTransactions: [],
      accounts: [],
      rules: [],
      csvTemplates: [],         // saved mappings from the csv_templates store
    };
  }
  resetState();

  // ---------- Step 1: picker ----------
  function renderPicker(root) {
    const drop = el('label', { class: 'dropzone', for: 'pdf-input' },
      el('div', { class: 'dropzone__icon' }, '📄'),
      el('div', { class: 'dropzone__title' }, 'Drop PDF statements or CSV exports here, or click to choose'),
      el('div', { class: 'dropzone__sub' }, 'PDFs auto-detect a bank template. CSVs ask you to map columns the first time, then save the mapping for next time.'),
      el('input', { id: 'pdf-input', type: 'file', multiple: '',
        accept: '.pdf,application/pdf,.csv,text/csv,.tsv,text/tab-separated-values',
        style: 'display:none' })
    );
    root.appendChild(drop);

    const templates = App.templates.all();
    const tplList = el('div', { class: 'template-list' },
      el('h3', null, 'Supported banks (PDF)'),
      el('ul', { class: 'template-list__ul' },
        templates.map(t => el('li', null,
          el('strong', null, t.bank),
          el('span', { class: 'muted' }, ' — ' + t.country + ' · ' + t.currency)
        ))
      ),
      el('p', { class: 'muted template-list__note' },
        'Other banks are not yet supported as PDFs. ' +
        'For unsupported banks, export to CSV from your bank or finance app and drop it here — the CSV mapper handles arbitrary column layouts.')
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

  function isCsvFile(f) {
    if (!f) return false;
    if (/\.(csv|tsv)$/i.test(f.name)) return true;
    if (f.type === 'text/csv' || f.type === 'text/tab-separated-values') return true;
    return false;
  }
  function isPdfFile(f) {
    if (!f) return false;
    if (/\.pdf$/i.test(f.name)) return true;
    return f.type === 'application/pdf';
  }

  // Build a Set of filenames the user has imported before, sourced from
  // both the imports store (batch.files[*].name) and individual
  // transactions (source_file, set during commit on new imports). The
  // Set is keyed by lowercased filename so cap differences don't slip a
  // re-import past the dedup check.
  async function collectKnownFilenames() {
    const known = new Set();
    try {
      const imports = await App.storage.imports.all();
      (imports || []).forEach(b => {
        (b.files || []).forEach(f => {
          if (f && f.name) known.add(String(f.name).toLowerCase());
        });
      });
    } catch (_) { /* ignore */ }
    try {
      const txs = await App.storage.transactions.all();
      txs.forEach(t => {
        if (t && t.source_file) known.add(String(t.source_file).toLowerCase());
      });
    } catch (_) { /* ignore */ }
    return known;
  }

  // Confirmation dialog for an attempted re-import. Listing-style modal
  // with two buttons. Returns true on "Import anyway", false on cancel.
  // Built ad-hoc on top of the existing .modal-overlay primitive so it
  // matches every other modal in the app.
  function confirmReimport(duplicateFiles) {
    return new Promise((resolve) => {
      const overlay = el('div', { class: 'modal-overlay' });
      const list = el('ul', { class: 'reimport-list' },
        ...duplicateFiles.map(f => el('li', null, f.name)),
      );
      let settled = false;
      const settle = (val) => {
        if (settled) return; settled = true;
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(val);
      };
      function onKey(e) {
        if (e.key === 'Escape') settle(false);
        if (e.key === 'Enter')  settle(true);
      }
      overlay.addEventListener('click', (e) => { if (e.target === overlay) settle(false); });
      document.addEventListener('keydown', onKey);
      const box = el('div', { class: 'modal' },
        el('h3', null, duplicateFiles.length === 1
          ? 'This file was already imported'
          : 'These files were already imported'),
        el('p', { class: 'muted' },
          duplicateFiles.length === 1
            ? 'A file with this exact name has been imported before. Re-importing will likely create duplicate transactions — the duplicates tab can help you clean them up afterwards. Continue?'
            : 'Files with these exact names have been imported before. Re-importing will likely create duplicate transactions. Continue?'),
        list,
        el('div', { class: 'modal-actions' },
          el('button', {
            type: 'button', class: 'btn btn--ghost',
            onclick: () => settle(false),
          }, 'Skip these files'),
          el('button', {
            type: 'button', class: 'btn btn--danger',
            onclick: () => settle(true),
          }, 'Import anyway'),
        ),
      );
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    });
  }

  async function handleFiles(fileList) {
    const all = Array.from(fileList || []);
    const pdfs = all.filter(isPdfFile);
    const csvs = all.filter(f => !isPdfFile(f) && isCsvFile(f));
    if (!pdfs.length && !csvs.length) {
      toast('No PDF or CSV files detected in the selection.', 'warn'); return;
    }

    // Dedup pass — partition each candidate file into "fresh" vs "already
    // imported before". For duplicates we ask the user to explicitly
    // confirm; cancelling drops just those files from this batch (the
    // fresh ones still proceed).
    const known = await collectKnownFilenames();
    const dupes = [...pdfs, ...csvs].filter(f =>
      f && f.name && known.has(String(f.name).toLowerCase()));
    let allowDupes = false;
    if (dupes.length) {
      allowDupes = await confirmReimport(dupes);
    }
    const keep = (f) => allowDupes || !dupes.includes(f);
    const finalPdfs = pdfs.filter(keep);
    const finalCsvs = csvs.filter(keep);
    if (!finalPdfs.length && !finalCsvs.length) {
      toast('No new files to import.', 'info');
      return;
    }
    state.files    = finalPdfs.map(f => ({ file: f, status: 'pending' }));
    state.csvFiles = finalCsvs.map(f => ({ file: f, status: 'pending' }));
    if (csvs.length && !pdfs.length) {
      // CSV-only path: skip the PDF parsing stage and head straight to
      // mapping (single file) or a queue of mappings (multiple files).
      await loadCsvTemplates();
      await readAllCsvs();
      state.stage = 'csvMap';
      await render();
      return;
    }
    state.stage = 'parsing';
    await render(); // switches to parsing view
    await parseAll();
    // PDFs done. If CSVs were also dropped, run them through the mapping
    // flow before going to review.
    if (state.csvFiles.length) {
      await loadCsvTemplates();
      await readAllCsvs();
      state.stage = 'csvMap';
      await render();
      return;
    }
    // No CSVs — the PDF path already moved us to review.
  }

  async function loadCsvTemplates() {
    try {
      state.csvTemplates = await App.storage.csvTemplates.all();
    } catch (e) { state.csvTemplates = []; }
  }

  async function readAllCsvs() {
    const C = (App.processing && App.processing.csv) || null;
    if (!C) {
      state.csvFiles.forEach(f => { f.status = 'error'; f.error = 'CSV processor unavailable'; });
      return;
    }
    for (const entry of state.csvFiles) {
      try {
        const text = await C.readFileAsText(entry.file);
        const delimiter = C.detectDelimiter(text);
        const rows = C.parseCsv(text, delimiter);
        entry.text = text;
        entry.rows = rows;
        // Pre-fill the mapping. If a saved template's name matches the
        // file name (case-insensitive substring), use it as the seed —
        // otherwise build a heuristic mapping from the data shape.
        const savedHit = (state.csvTemplates || []).find(t => {
          if (!t || !t.name) return false;
          const n = t.name.toLowerCase();
          const fname = (entry.file.name || '').toLowerCase();
          return fname.includes(n) || n.includes(fname.replace(/\.[^.]+$/, ''));
        });
        if (savedHit) {
          entry.mapping = JSON.parse(JSON.stringify(savedHit));
          entry.mapping.delimiter = entry.mapping.delimiter || delimiter;
          entry.templateId = savedHit.id;
          entry.matchedTemplate = true;
        } else {
          entry.mapping = C.suggestMapping(rows);
          entry.mapping.delimiter = delimiter;
          entry.templateId = null;
          entry.matchedTemplate = false;
        }
        entry.status = 'mapped-pending';
      } catch (e) {
        console.error(e);
        entry.status = 'error';
        entry.error = 'Could not read CSV: ' + e.message;
      }
    }
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
            // Year-anchor handling: a template that can't determine the
            // year from its own headers (Santander PT today, possibly
            // others tomorrow) returns `meta.needs_year_input: true`. We
            // used to block parsing on a popup; now we default to the
            // current year so the row count + preview show up immediately,
            // and surface a Year dropdown next to the bank/account block
            // in the review screen so the user can change it without
            // leaving the flow.
            if (result && result.meta && result.meta.needs_year_input) {
              const fallbackYear = new Date().getFullYear();
              entry.needs_year_input = true;
              entry.user_year = fallbackYear;
              result = entry.template.parse(parsed, { userYear: String(fallbackYear) });
            }
            entry.rows = result.rows || [];
            entry.meta = result.meta || {};
            entry.status = 'parsed';
            const yearMsg = entry.needs_year_input
              ? ' (year defaulted to ' + entry.user_year + ' — adjust on the review screen)'
              : (entry.meta.year_anchor_source === 'user' ? ' (year supplied manually)' : '');
            updateParsingRow(list, i, entry, entry.rows.length + ' transactions parsed' + yearMsg);
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

  // ---------- Step 2.5: CSV mapping ----------
  //
  // One screen per CSV file. The user picks the column for each canonical
  // field (Date / Amount / Merchant / Category / Account / Notes), date
  // format, sign convention, and whether the first row is a header. A
  // live-updated preview table shows the first ~10 parsed rows so they
  // can spot mistakes before committing.
  //
  // "Save mapping as…" lives next to Continue; saving names the mapping
  // and writes a row to the csv_templates store so re-imports skip the
  // mapping step (the picker stage matches by file name first).
  function renderCsvMap(root) {
    const idx = state.csvFiles.findIndex(f =>
      f.status === 'mapped-pending' || f.status === 'mapped-error');
    if (idx < 0) {
      // Should not happen — defensive fallback, kick to review.
      toast('All CSV files mapped — proceeding to review.', 'info');
      toReview();
      return;
    }
    const entry = state.csvFiles[idx];
    const remaining = state.csvFiles.length - idx - 1;
    root.appendChild(el('h2', null, 'Map CSV columns'));
    root.appendChild(el('p', { class: 'muted' },
      'Tell us which column is which for ',
      el('strong', null, entry.file.name),
      remaining > 0 ? ' — ' + remaining + ' more CSV file' + (remaining === 1 ? '' : 's') + ' after this one.' : '.'));

    if (entry.matchedTemplate) {
      root.appendChild(el('div', { class: 'csv-template-hint' },
        'Using a saved template — review the columns below and continue, or pick a different template.'));
    }

    const C = (App.processing && App.processing.csv) || null;
    if (!C) {
      root.appendChild(el('div', { class: 'view-error' }, 'CSV processor unavailable. Refresh and try again.'));
      return;
    }

    // Saved templates dropdown.
    const tplRow = el('div', { class: 'csv-map-row' });
    tplRow.appendChild(el('label', null, 'Saved templates'));
    const tplSelect = el('select', { class: 'csv-map-input' },
      el('option', { value: '' }, '— None (custom mapping) —'),
      ...(state.csvTemplates || []).map(t => el('option', {
        value: String(t.id),
        selected: entry.templateId === t.id ? '' : null,
      }, t.name)),
    );
    tplSelect.addEventListener('change', () => {
      const v = tplSelect.value;
      if (!v) { entry.templateId = null; entry.matchedTemplate = false; return; }
      const tpl = (state.csvTemplates || []).find(t => String(t.id) === v);
      if (!tpl) return;
      entry.mapping = JSON.parse(JSON.stringify(tpl));
      // Keep the auto-detected delimiter so a template authored against
      // a comma-CSV can still be used on a semi-colon-CSV that happens to
      // have the same column order.
      entry.mapping.delimiter = entry.mapping.delimiter || C.detectDelimiter(entry.text);
      entry.templateId = tpl.id;
      entry.matchedTemplate = true;
      // Re-parse with the template's delimiter in case it differs.
      entry.rows = C.parseCsv(entry.text, entry.mapping.delimiter);
      render();
    });
    tplRow.appendChild(tplSelect);
    root.appendChild(tplRow);

    // Map fields → column index. We expose every FIELD_DEF; the UI hides
    // amount_credit / amount_debit when sign_convention is 'signed', and
    // hides the single Amount field when one of the split conventions is
    // chosen.
    const map = entry.mapping;
    const headers = (map.has_header && entry.rows.length) ? (entry.rows[0] || []) : [];
    const ncols = entry.rows.reduce((m, r) => Math.max(m, r.length), 0);

    function colSelect(fieldKey) {
      const sel = el('select', {
        class: 'csv-map-input',
        onchange: (e) => {
          const v = e.target.value;
          map.columns[fieldKey] = v === '' ? null : parseInt(v, 10);
          updatePreview();
        },
      },
        el('option', { value: '' }, '— Not in CSV —'),
        ...Array.from({ length: ncols }, (_, i) => {
          const label = headers[i] != null && String(headers[i]).trim()
            ? (headers[i] + ' (col ' + (i + 1) + ')')
            : ('Column ' + (i + 1));
          return el('option', {
            value: String(i),
            selected: map.columns[fieldKey] === i ? '' : null,
          }, label);
        }),
      );
      return sel;
    }

    // Settings: delimiter / has_header / date_format / sign / decimal.
    const settingsBlock = el('div', { class: 'csv-map-settings' });
    settingsBlock.appendChild(buildSettingRow('Delimiter', el('select', {
      class: 'csv-map-input',
      onchange: (e) => {
        map.delimiter = e.target.value || ',';
        // Re-parse with the new delimiter so the preview reflects it.
        entry.rows = C.parseCsv(entry.text, map.delimiter);
        render();
      },
    },
      [[',', 'Comma  ,'], [';', 'Semicolon  ;'], ['\t', 'Tab'], ['|', 'Pipe  |']]
        .map(([v, l]) => el('option', { value: v, selected: map.delimiter === v ? '' : null }, l)),
    )));
    settingsBlock.appendChild(buildSettingRow('Header row', el('label', { class: 'cb-inline' },
      el('input', {
        type: 'checkbox',
        checked: map.has_header ? '' : null,
        onchange: (e) => { map.has_header = !!e.target.checked; render(); },
      }),
      ' First row contains column names',
    )));
    settingsBlock.appendChild(buildSettingRow('Date format', el('select', {
      class: 'csv-map-input',
      onchange: (e) => { map.date_format = e.target.value; updatePreview(); },
    },
      [
        ['auto', 'Auto-detect (prefers DMY for ambiguous values)'],
        ['iso',  'ISO  (YYYY-MM-DD)'],
        ['dmy',  'DMY  (DD/MM/YYYY — Europe)'],
        ['mdy',  'MDY  (MM/DD/YYYY — US)'],
      ].map(([v, l]) => el('option', { value: v, selected: map.date_format === v ? '' : null }, l)),
    )));
    settingsBlock.appendChild(buildSettingRow('Sign convention', el('select', {
      class: 'csv-map-input',
      onchange: (e) => { map.sign_convention = e.target.value; render(); },
    },
      [
        ['signed',           'Single Amount column (negative = expense)'],
        ['credit_positive',  'Two columns: Credit (income) / Debit (expense)'],
        ['debit_positive',   'Two columns: Debit (positive) / Credit (negative) — rare'],
      ].map(([v, l]) => el('option', { value: v, selected: map.sign_convention === v ? '' : null }, l)),
    )));
    settingsBlock.appendChild(buildSettingRow('Decimal separator', el('select', {
      class: 'csv-map-input',
      onchange: (e) => { map.amount_decimal = e.target.value; updatePreview(); },
    },
      [
        ['auto', 'Auto-detect'],
        ['.',    'Period  (1234.56)'],
        [',',    'Comma   (1234,56)'],
      ].map(([v, l]) => el('option', { value: v, selected: map.amount_decimal === v ? '' : null }, l)),
    )));
    root.appendChild(settingsBlock);

    // Column mapping table.
    const mapTable = el('table', { class: 'csv-map-table' });
    mapTable.appendChild(el('thead', null, el('tr', null,
      el('th', null, 'Canonical field'),
      el('th', null, 'CSV column'),
      el('th', null, ''),
    )));
    const mapBody = el('tbody');
    function fieldVisible(key) {
      if (key === 'amount')        return map.sign_convention === 'signed';
      if (key === 'amount_credit') return map.sign_convention !== 'signed';
      if (key === 'amount_debit')  return map.sign_convention !== 'signed';
      return true;
    }
    C.FIELD_DEFS.forEach(f => {
      if (!fieldVisible(f.key)) return;
      mapBody.appendChild(el('tr', null,
        el('td', null, f.label + (f.required ? ' *' : '')),
        el('td', null, colSelect(f.key)),
        el('td', { class: 'muted' }, f.required ? 'required' : 'optional'),
      ));
    });
    mapTable.appendChild(mapBody);
    root.appendChild(mapTable);

    // Preview table — the first ~10 mapped rows. Re-rendered on every
    // edit so the user sees the parsed values land in the right slots.
    const previewWrap = el('div', { class: 'csv-preview-wrap' });
    root.appendChild(previewWrap);

    function updatePreview() {
      previewWrap.innerHTML = '';
      const startIndex = map.has_header ? 1 : 0;
      const sample = entry.rows.slice(startIndex, startIndex + 10);
      const sampleResult = C.applyMapping([...(map.has_header ? [entry.rows[0]] : []), ...sample], map);
      const ok = sampleResult.rows.length;
      const errs = sampleResult.errors.length;
      previewWrap.appendChild(el('div', { class: 'csv-preview-meta muted' },
        'Preview (first ' + sample.length + ' data rows): ' +
        ok + ' parseable, ' + errs + ' problem' + (errs === 1 ? '' : 's') + '.'));
      if (!ok && !errs) return;
      const tbl = el('table', { class: 'csv-preview-table' });
      tbl.appendChild(el('thead', null, el('tr', null,
        el('th', null, 'Date'),
        el('th', null, 'Amount'),
        el('th', null, 'Merchant'),
        el('th', null, 'Category'),
        el('th', null, 'Account'),
        el('th', null, 'Notes'),
      )));
      const body = el('tbody');
      sampleResult.rows.forEach(r => {
        body.appendChild(el('tr', null,
          el('td', null, r.date),
          el('td', { class: 'num' }, formatCurrency(r.amount, r.currency)),
          el('td', null, r.merchant || ''),
          el('td', null, r.category || ''),
          el('td', null, (r.raw && r.raw.csv_account) || ''),
          el('td', null, r.description || ''),
        ));
      });
      sampleResult.errors.forEach(e => {
        body.appendChild(el('tr', { class: 'csv-preview-error' },
          el('td', { colspan: '6' },
            'Row ' + (e.index + 1) + ': ' + e.reason)));
      });
      tbl.appendChild(body);
      previewWrap.appendChild(tbl);
    }
    updatePreview();

    // Footer: save-template + continue.
    const saveNameInput = el('input', {
      type: 'text', class: 'csv-map-input',
      placeholder: 'Optional: name to save this mapping…',
      value: entry.matchedTemplate && entry.templateId
        ? ((state.csvTemplates.find(t => t.id === entry.templateId) || {}).name || '')
        : '',
    });
    const footer = el('div', { class: 'csv-map-footer' },
      saveNameInput,
      el('button', {
        type: 'button', class: 'btn btn--ghost',
        onclick: async () => {
          const name = (saveNameInput.value || '').trim();
          if (!name) { toast('Type a name first.', 'warn'); return; }
          const row = {
            name,
            delimiter: map.delimiter,
            has_header: map.has_header,
            date_format: map.date_format,
            sign_convention: map.sign_convention,
            amount_decimal: map.amount_decimal,
            columns: Object.assign({}, map.columns),
            updated_at: new Date().toISOString(),
          };
          // Update existing template if the name matches; otherwise create.
          const existing = (state.csvTemplates || []).find(t => t.name === name);
          if (existing) row.id = existing.id;
          const id = await App.storage.csvTemplates.put(row);
          row.id = row.id || id;
          // Refresh local cache so the dropdown shows it immediately.
          await loadCsvTemplates();
          entry.templateId = row.id;
          entry.matchedTemplate = true;
          toast('Saved mapping "' + name + '".', 'success');
          render();
        },
      }, 'Save mapping'),
      el('span', { class: 'spacer' }, ''),
      el('button', {
        type: 'button', class: 'btn btn--ghost',
        onclick: () => { resetState(); render(); },
      }, 'Start over'),
      el('button', {
        type: 'button', class: 'btn btn--primary',
        onclick: () => commitCsvMapping(entry),
      }, remaining > 0 ? 'Continue → next CSV' : 'Continue → review'),
    );
    root.appendChild(footer);
  }

  function buildSettingRow(label, control) {
    return el('div', { class: 'csv-map-row' },
      el('label', null, label),
      control,
    );
  }

  // Apply the current mapping to the file's parsed rows, validate that
  // required fields are mapped, and either advance to the next CSV file
  // or to the review stage.
  function commitCsvMapping(entry) {
    const C = (App.processing && App.processing.csv) || null;
    if (!C) { toast('CSV processor unavailable.', 'error'); return; }
    const map = entry.mapping;
    const requiredOk =
      map.columns.date != null &&
      map.columns.merchant != null &&
      (map.sign_convention === 'signed'
        ? map.columns.amount != null
        : (map.columns.amount_credit != null || map.columns.amount_debit != null));
    if (!requiredOk) {
      toast('Map at least Date, Merchant, and Amount before continuing.', 'warn');
      return;
    }
    const result = C.applyMapping(entry.rows, map);
    if (!result.rows.length) {
      toast('No rows produced — check the mapping.', 'warn');
      return;
    }
    entry.parsedRows = result.rows;
    entry.parseErrors = result.errors;
    entry.status = 'mapped';
    // Move on. Any other CSV with status 'mapped-pending' goes through
    // its own mapping screen on the next render.
    const next = state.csvFiles.find(f =>
      f.status === 'mapped-pending' || f.status === 'mapped-error');
    if (next) { render(); return; }
    toReview();
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
    //
    // CSV-derived rows (`state.csvFiles[*].parsedRows`) merge in alongside
    // PDF-derived rows so they share the same review/dedupe/commit pipeline.
    const allRows = [
      ...state.files.flatMap(f => f.rows || []),
      ...state.csvFiles.flatMap(f => f.parsedRows || []),
    ];
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
    // Flatten into candidate rows with source file index. CSV files are
    // appended after PDF files; their fileIndex is offset by the PDF count
    // so the source-lookup in the review table can disambiguate. The
    // `__source` tag is purely diagnostic — pipelines downstream don't
    // care, but the account-assignment block uses it to skip CSV rows
    // (CSV imports get a single batch-level account picker further down).
    state.candidates = [];
    state.files.forEach((f, fi) => {
      const fname = f.file && f.file.name ? f.file.name : null;
      (f.rows || []).forEach((r, ri) => {
        state.candidates.push({
          __fileIndex: fi, __rowIndex: ri, __source: 'pdf', __selected: true,
          source_file: fname,
          ...r,
        });
      });
    });
    state.csvFiles.forEach((f, ci) => {
      const fname = f.file && f.file.name ? f.file.name : null;
      (f.parsedRows || []).forEach((r, ri) => {
        state.candidates.push({
          __fileIndex: state.files.length + ci, __rowIndex: ri,
          __source: 'csv', __csvIndex: ci, __selected: true,
          source_file: fname,
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
    state.csvFiles.forEach((f, ci) => {
      if (f.status !== 'mapped') return;
      accBlock.appendChild(renderCsvAccountRow(f, ci));
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
          // Manual template-pick: same year-fallback path as auto-detect.
          // Default to current year and let the user adjust on the review
          // screen via the per-file Year dropdown.
          if (result && result.meta && result.meta.needs_year_input) {
            const fallbackYear = new Date().getFullYear();
            entry.needs_year_input = true;
            entry.user_year = fallbackYear;
            result = tpl.parse(entry.parsed, { userYear: String(fallbackYear) });
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
    const head = el('div', { class: 'account-file-block__head' },
      el('span', { class: 'account-row__file' }, entry.file.name),
      el('span', { class: 'muted' },
        entry.template.bank + ' · ' + (entry.rows || []).length + ' rows' +
        (groups.length > 1 ? ' · ' + groups.length + ' sub-accounts' : '')),
    );
    // Year dropdown — only rendered when the template told us it couldn't
    // determine the year from the document headers. Sits inline with the
    // bank/file name so it reads as another piece of import metadata
    // alongside the per-account picker below. Changing the year triggers
    // a re-parse with the new userYear, refreshes candidates, and re-runs
    // the duplicate check.
    if (entry.needs_year_input) {
      head.appendChild(buildYearPickerForEntry(entry, fileIndex));
    }
    container.appendChild(head);
    groups.forEach(g => container.appendChild(renderAccountGroupRow(entry, fileIndex, g)));
    return container;
  }

  function buildYearPickerForEntry(entry, fileIndex) {
    const cur = new Date().getFullYear();
    const current = entry.user_year != null ? entry.user_year : cur;
    const opts = [];
    // Sensible window — same range the old modal exposed.
    for (let y = cur + 1; y >= cur - 25; y--) {
      opts.push(el('option', {
        value: String(y),
        selected: y === current ? '' : null,
      }, String(y)));
    }
    const sel = el('select', {
      class: 'tx-filter-input year-picker-inline',
      title: 'This statement does not embed an issue date — pick the year so dates resolve correctly.',
      onchange: async (e) => {
        const next = parseInt(e.target.value, 10);
        if (!isFinite(next) || next === entry.user_year) return;
        entry.user_year = next;
        try {
          const result = entry.template.parse(entry.parsed, { userYear: String(next) });
          entry.rows = result.rows || [];
          entry.meta = result.meta || {};
          // Per-account row counts are derived from entry.rows — drop the
          // cached groups so the next render rebuilds them with fresh
          // counts and re-applies any user account assignments.
          //
          // Sub-account assignments themselves are preserved because the
          // entry's __accountGroups carry __accountChoice / __pendingAccount
          // — but if the row count under each key changed (it usually
          // won't, since reparsing keeps row identity stable for the
          // happy path), the meta.rowCount will be recomputed.
          if (entry.__accountGroups) {
            entry.__accountGroups.forEach(g => {
              g.meta.rowCount = (entry.rows || [])
                .filter(r => (r._accountKey || 'default') === g.key).length;
            });
          }
          // Now we need new candidates because `state.candidates` froze
          // the old parse output. The cleanest path is to just rebuild
          // toReview's candidate list: it re-runs categorize, regroups,
          // and reruns dedupe — exactly what we want.
          await toReview();
          toast('Re-parsed with year ' + next + '.', 'success');
        } catch (err) {
          console.error(err);
          toast('Re-parse failed: ' + err.message, 'error');
        }
      },
    }, ...opts);
    return el('label', { class: 'inline-label muted' },
      'Year: ', sel,
    );
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

  // CSV files don't carry IBAN / bank / currency metadata the way PDFs do,
  // so the user fills those in by hand here. The shape mirrors the PDF
  // pending-account fields exactly, so when commit() walks accountMap it
  // doesn't care whether the source was a PDF or a CSV. The user can pick
  // an existing account instead, in which case the inputs collapse.
  //
  // Currency is best-effort propagated to every CSV-derived row that
  // doesn't already carry one (CSVs from Mint et al. do not always have
  // a currency column), so totals on the dashboard format correctly.
  function renderCsvAccountRow(entry, csvIndex) {
    const fileIndex = state.files.length + csvIndex;
    const suggestedLabel = (entry.file.name || 'CSV').replace(/\.[^.]+$/, '');
    const placeholder = '__pending_csv_' + csvIndex;
    if (!entry.__accountInit) {
      entry.__accountInit = true;
      entry.__accountChoice = '__new';
      entry.__pendingAccount = {
        name: suggestedLabel,
        bank: '',
        currency: 'EUR',
        iban: null,
        account_number: null,
        is_own: true,
      };
      // Stamp every CSV-derived candidate with a pending placeholder id
      // so the commit step swaps it for a real id (mirrors the PDF path).
      state.candidates.forEach(c => {
        if (c.__source === 'csv' && c.__csvIndex === csvIndex) c.account_id = placeholder;
      });
    }
    // Push the current pending account's currency (or the picked
    // existing account's currency) onto every CSV row from this file
    // that hasn't been assigned one. The CSV parser defaults to EUR
    // when the file has no currency column; this lets the user override
    // that without re-typing per row.
    function applyCurrencyToRows(currency) {
      if (!currency) return;
      state.candidates.forEach(c => {
        if (c.__source !== 'csv' || c.__csvIndex !== csvIndex) return;
        // Only overwrite when the row is still on the CSV-default. If the
        // CSV had its own currency column, leave the per-row value alone.
        if (!c.__csvCurrencyLocked) c.currency = currency;
      });
    }

    const select = el('select', {
      onchange: (e) => {
        const val = e.target.value;
        entry.__accountChoice = val;
        if (val === '__new') {
          // Re-seed the pending account with the user's most recent typed
          // values so toggling away and back doesn't wipe what they typed.
          entry.__pendingAccount = entry.__pendingAccount || {
            name: suggestedLabel, bank: '', currency: 'EUR',
            iban: null, account_number: null, is_own: true,
          };
          state.candidates.forEach(c => {
            if (c.__source === 'csv' && c.__csvIndex === csvIndex) c.account_id = placeholder;
          });
          applyCurrencyToRows(entry.__pendingAccount.currency);
        } else if (val) {
          entry.__pendingAccount = null;
          const id = parseInt(val, 10);
          const acct = state.accounts.find(a => a.id === id);
          state.candidates.forEach(c => {
            if (c.__source === 'csv' && c.__csvIndex === csvIndex) c.account_id = id;
          });
          if (acct && acct.currency) applyCurrencyToRows(acct.currency);
        } else {
          entry.__pendingAccount = null;
          state.candidates.forEach(c => {
            if (c.__source === 'csv' && c.__csvIndex === csvIndex) c.account_id = null;
          });
        }
        state.warnings = App.processing.duplicate.findDuplicates(state.candidates, state.existingTransactions);
        render();
      },
    },
      el('option', { value: '' }, 'Choose account…'),
      el('option', { value: '__new' }, 'Create new (fill in below)'),
      ...state.accounts.map(a => el('option', { value: String(a.id) }, a.name + ' (' + (a.currency || 'EUR') + ')'))
    );
    select.value = entry.__accountChoice || '';

    const head = el('div', { class: 'account-file-block__head' },
      el('span', { class: 'account-row__file' }, entry.file.name),
      el('span', { class: 'muted' }, 'CSV · ' + (entry.parsedRows || []).length + ' rows'),
    );
    const body = el('div', { class: 'account-file-block__body' });
    body.appendChild(el('div', { class: 'account-row account-row--group' },
      el('span', { class: 'spacer' }, ''),
      select,
    ));

    // Pending-account form. Visible only when the user is creating a
    // new account; collapses when they pick an existing one. Mirrors the
    // editable IBAN / bank / currency surface that PDF imports get from
    // the bank template.
    if (entry.__accountChoice === '__new' && entry.__pendingAccount) {
      const p = entry.__pendingAccount;
      // Currency defaults derived from the PDF templates so the dropdown
      // covers the common cases. The text input below is the escape hatch
      // for currencies we don't pre-list.
      const COMMON_CURRENCIES = ['EUR', 'USD', 'GBP', 'ILS', 'PLN', 'CHF', 'SEK', 'NOK', 'DKK', 'CZK', 'HUF', 'JPY'];
      const form = el('div', { class: 'csv-account-form' },
        el('div', { class: 'csv-account-form__row' },
          el('label', null, 'Account name'),
          el('input', {
            type: 'text', class: 'csv-map-input',
            value: p.name || '',
            placeholder: suggestedLabel,
            oninput: (e) => { p.name = e.target.value; },
          }),
        ),
        el('div', { class: 'csv-account-form__row' },
          el('label', null, 'Bank'),
          el('input', {
            type: 'text', class: 'csv-map-input',
            value: p.bank || '',
            placeholder: 'e.g. Bank of America, Revolut, …',
            oninput: (e) => { p.bank = e.target.value; },
          }),
        ),
        el('div', { class: 'csv-account-form__row' },
          el('label', null, 'Currency'),
          el('select', {
            class: 'csv-map-input',
            onchange: (e) => {
              p.currency = e.target.value || 'EUR';
              applyCurrencyToRows(p.currency);
              render();
            },
          },
            ...COMMON_CURRENCIES.map(c => el('option', {
              value: c, selected: p.currency === c ? '' : null,
            }, c)),
            // Sticky option for non-listed currencies the user may
            // already have on the pending account.
            ...(p.currency && !COMMON_CURRENCIES.includes(p.currency)
                ? [el('option', { value: p.currency, selected: '' }, p.currency)]
                : []),
          ),
        ),
        el('div', { class: 'csv-account-form__row' },
          el('label', null, 'IBAN / Identifier'),
          el('input', {
            type: 'text', class: 'csv-map-input',
            value: p.iban || '',
            placeholder: 'Optional — used for matching on re-import',
            oninput: (e) => { p.iban = (e.target.value || '').trim() || null; },
          }),
        ),
        el('div', { class: 'csv-account-form__row csv-account-form__row--check' },
          el('label', { class: 'cb-inline' },
            el('input', {
              type: 'checkbox',
              checked: p.is_own ? '' : null,
              onchange: (e) => { p.is_own = !!e.target.checked; },
            }),
            ' This is my own account (vs. someone I send to)',
          ),
        ),
      );
      body.appendChild(form);
    }

    return el('div', { class: 'account-file-block' }, head, body);
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
    // CSV pending accounts — one per CSV file.
    for (let i = 0; i < state.csvFiles.length; i++) {
      const f = state.csvFiles[i];
      if (!f.__pendingAccount) continue;
      const newAcct = Object.assign({ created_at: new Date().toISOString() }, f.__pendingAccount);
      delete newAcct.id;
      const newId = await App.storage.accounts.put(newAcct);
      accountMap['__pending_csv_' + i] = newId;
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
      delete out.__source;   delete out.__csvIndex;
      delete out.__csvCurrencyLocked;
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
        files: [
          ...state.files.filter(f => f.status === 'parsed').map(f => ({
            name: f.file.name, bank: f.template && f.template.bank, rows: (f.rows || []).length, kind: 'pdf',
          })),
          ...state.csvFiles.filter(f => f.status === 'mapped').map(f => ({
            name: f.file.name, bank: 'CSV', rows: (f.parsedRows || []).length, kind: 'csv',
          })),
        ],
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
    root.appendChild(el('h2', null, 'Import complete'));
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
    // Breadcrumb removed — the persistent top nav indicates the active
    // section.
    if (state.stage === 'pick') renderPicker(wrap);
    else if (state.stage === 'parsing') renderParsing(wrap);
    else if (state.stage === 'csvMap') renderCsvMap(wrap);
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

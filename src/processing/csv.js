/*
 * src/processing/csv.js — generic CSV parser + mapping → row pipeline.
 *
 * The PDF importer auto-detects a bank template and produces canonical row
 * objects. CSV exports vary too much for that to work — every bank, every
 * personal-finance app, every spreadsheet uses different column names,
 * orderings, date formats, and sign conventions. So instead of templating
 * each one, we ship:
 *
 *   1) A small, dependency-free CSV reader that handles quoted fields,
 *      escaped quotes ("" inside a quoted field), and \r\n / \n / \r line
 *      endings. Auto-detects the delimiter from a small set (',', ';', '\t',
 *      '|') by counting candidates in the first non-empty line.
 *   2) A "mapping" object the user fills out in the UI:
 *        { delimiter, has_header, date_format, sign_convention,
 *          amount_decimal, columns: { date, amount, merchant, category,
 *          account, notes } }
 *      `columns.*` are zero-based indices into the parsed row, or null when
 *      the CSV doesn't carry that field.
 *   3) `applyMapping(rows, mapping)` → canonical { rows, errors } shape that
 *      slots into the existing review/commit pipeline.
 *
 * Date and amount handling are the two failure modes worth being explicit
 * about:
 *   - Dates: we accept ISO (YYYY-MM-DD), DMY ("17/08/2024"), MDY
 *     ("08/17/2024"), and "auto" (try ISO first, then DMY — DMY wins ties
 *     because most European banks emit DMY).
 *   - Amounts: a single "Amount" column with native sign is the common
 *     case ('signed'). Some exports split into Debit / Credit columns, in
 *     which case the user can pick "credit_positive" or "debit_positive"
 *     and we read both columns (mapping.columns.amount_credit, .amount_debit).
 *     Decimal separator is selectable: '.' (US), ',' (EU), or 'auto' (infer
 *     from the first non-empty value).
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};
  App.processing = App.processing || {};

  const CANDIDATE_DELIMS = [',', ';', '\t', '|'];

  // Standard fields a mapping can populate. The label is what the UI shows
  // in the column dropdown; the key is what we read out into the canonical
  // row object.
  const FIELD_DEFS = [
    { key: 'date',           label: 'Date',          required: true },
    { key: 'amount',         label: 'Amount',        required: true },
    { key: 'amount_credit',  label: 'Amount (credit / income)', required: false },
    { key: 'amount_debit',   label: 'Amount (debit / expense)', required: false },
    { key: 'merchant',       label: 'Merchant / Description',   required: true },
    { key: 'category',       label: 'Category',      required: false },
    { key: 'account',        label: 'Account',       required: false },
    { key: 'notes',          label: 'Notes',         required: false },
    { key: 'currency',       label: 'Currency',      required: false },
  ];

  // ---------- Reader ----------

  // Detect the delimiter by counting occurrences of each candidate in the
  // first non-empty, non-comment line. Falls back to ',' when nothing wins.
  function detectDelimiter(text) {
    const lines = text.split(/\r?\n/);
    const sample = lines.find(l => l && l.trim()) || '';
    let best = ',', bestCount = 0;
    for (const d of CANDIDATE_DELIMS) {
      const count = sample.split(d).length - 1;
      if (count > bestCount) { best = d; bestCount = count; }
    }
    return best;
  }

  // Parse a CSV string into a 2-D array of strings. Honours quoted fields
  // (including embedded delimiters and "" escapes) and CRLF/LF line endings.
  // No streaming — the import flow only handles single-statement files, so
  // a few MB max.
  function parseCsv(text, delimiter) {
    const out = [];
    if (!text) return out;
    const delim = delimiter || detectDelimiter(text);
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          // A quote starts a quoted field only at the start of the field.
          // Otherwise treat it as a literal so weird files like ABC"DEF
          // don't blow up.
          if (field.length === 0) inQuotes = true;
          else field += ch;
        } else if (ch === delim) {
          row.push(field); field = '';
        } else if (ch === '\r') {
          // Swallow CR; the LF (or end-of-input) closes the row.
          if (text[i + 1] !== '\n') {
            // bare CR line ending
            row.push(field); field = '';
            out.push(row); row = [];
          }
        } else if (ch === '\n') {
          row.push(field); field = '';
          out.push(row); row = [];
        } else {
          field += ch;
        }
      }
    }
    // Trailing field / row.
    if (field.length || row.length) {
      row.push(field);
      out.push(row);
    }
    // Drop trailing empty row if the file ends with a newline.
    while (out.length && out[out.length - 1].length === 1 && out[out.length - 1][0] === '') {
      out.pop();
    }
    return out;
  }

  // Read a File / Blob as text, autodetecting UTF-8 BOM. Returns a Promise.
  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Could not read file'));
      reader.onload = () => {
        let txt = String(reader.result || '');
        // Strip BOM.
        if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
        resolve(txt);
      };
      reader.readAsText(file);
    });
  }

  // ---------- Mapping helpers ----------

  // Suggest a default mapping for a parsed CSV. Tries to match common
  // header names; falls back to "first column = date, second = amount,
  // last = merchant" guesses when there's no header.
  function suggestMapping(rows) {
    const mapping = {
      delimiter: ',',
      has_header: false,
      date_format: 'auto',          // 'auto' | 'iso' | 'dmy' | 'mdy'
      sign_convention: 'signed',    // 'signed' | 'credit_positive' | 'debit_positive'
      amount_decimal: 'auto',       // 'auto' | '.' | ','
      columns: {
        date: null, amount: null,
        amount_credit: null, amount_debit: null,
        merchant: null, category: null,
        account: null, notes: null, currency: null,
      },
    };
    if (!rows || !rows.length) return mapping;
    const first = rows[0] || [];
    // A header row is a row of *labels*: every non-empty cell starts with a
    // letter (Unicode-aware, so "Descrição"/"Conto"/"Saldo" all qualify) and
    // none look like a date (NN/NN/NNNN) or a parenthesised amount. Cells
    // that look like a number (e.g. "1234.56", "(-3.45)") immediately rule
    // out header status.
    const STARTS_WITH_LETTER = /^[A-Za-zÀ-ſ֐-׿]/;
    const LOOKS_DATA = /^[\d(\-]/;  // date / amount / parens-amount
    const looksLikeHeader = first.length > 0 && first.every(raw => {
      const c = String(raw || '').trim();
      if (!c) return true;          // empty cells are OK in a header
      if (LOOKS_DATA.test(c))      return false;
      if (!STARTS_WITH_LETTER.test(c)) return false;
      return true;
    });
    mapping.has_header = looksLikeHeader;
    const lower = first.map(c => String(c || '').toLowerCase().trim());
    function findHeader(...needles) {
      for (let i = 0; i < lower.length; i++) {
        for (const n of needles) {
          if (lower[i] === n || lower[i].includes(n)) return i;
        }
      }
      return null;
    }
    if (looksLikeHeader) {
      mapping.columns.date     = findHeader('date', 'fecha', 'data', 'datum', 'תאריך');
      mapping.columns.amount   = findHeader('amount', 'value', 'importo', 'betrag', 'monto', 'valor', 'סכום');
      mapping.columns.merchant = findHeader('merchant', 'description', 'descrição', 'descripcion', 'beschreibung', 'name', 'payee', 'concepto', 'concept', 'תיאור');
      mapping.columns.category = findHeader('category', 'categoria', 'categoría', 'kategorie', 'קטגוריה');
      mapping.columns.account  = findHeader('account', 'conta', 'cuenta', 'konto', 'iban', 'חשבון');
      mapping.columns.notes    = findHeader('notes', 'note', 'memo', 'observ', 'הערה');
      mapping.columns.currency = findHeader('currency', 'moeda', 'moneda', 'währung', 'מטבע');
      mapping.columns.amount_credit = findHeader('credit', 'haber', 'haben', 'income', 'inflow', 'gutschrift');
      mapping.columns.amount_debit  = findHeader('debit', 'debe', 'soll', 'outflow', 'expense', 'lastschrift');
      // Auto-flip sign convention if we found split credit/debit columns
      // but no single amount column.
      if (mapping.columns.amount == null &&
          (mapping.columns.amount_credit != null || mapping.columns.amount_debit != null)) {
        mapping.sign_convention = 'credit_positive';
      }
    } else {
      // Heuristic guesses on a header-less file.
      const ncols = first.length;
      if (ncols >= 1) mapping.columns.date     = 0;
      if (ncols >= 2) mapping.columns.amount   = ncols - 1;
      if (ncols >= 3) mapping.columns.merchant = 1;
    }
    return mapping;
  }

  // ---------- Date / amount parsing ----------

  function parseDate(raw, fmt) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    // ISO short-circuit — a leading 4-digit year is unambiguous.
    let m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(s);
    if (m) return iso(m[1], m[2], m[3]);
    // DMY / MDY both look like NN/NN/NNNN — pick by mapping fmt.
    m = /^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})/.exec(s);
    if (m) {
      const year = expandYear(m[3]);
      if (fmt === 'mdy') return iso(year, m[1], m[2]);
      // 'auto' or 'dmy': prefer DMY (most European banks).
      // If the first number is > 12 it can't be a month, force DMY.
      if (parseInt(m[1], 10) > 12) return iso(year, m[2], m[1]);
      // If the second is > 12 it must be DMY.
      if (parseInt(m[2], 10) > 12) return iso(year, m[1], m[2]);
      // Both ≤ 12 and fmt is 'auto' → DMY (the European default).
      return iso(year, m[2], m[1]);
    }
    // 8-digit YYYYMMDD or DDMMYYYY.
    m = /^(\d{8})$/.exec(s);
    if (m) {
      const d = m[1];
      if (fmt === 'mdy') return iso(d.slice(4, 8), d.slice(0, 2), d.slice(2, 4));
      if (fmt === 'iso') return iso(d.slice(0, 4), d.slice(4, 6), d.slice(6, 8));
      // auto / dmy
      if (parseInt(d.slice(0, 2), 10) > 31) return iso(d.slice(0, 4), d.slice(4, 6), d.slice(6, 8));
      return iso(d.slice(4, 8), d.slice(2, 4), d.slice(0, 2));
    }
    return null;
  }
  function expandYear(y) {
    const s = String(y);
    if (s.length === 4) return s;
    const n = parseInt(s, 10);
    // Same window the rest of the app uses: 00-69 → 2000s, 70-99 → 1900s.
    return String(n < 70 ? 2000 + n : 1900 + n);
  }
  function iso(y, m, d) {
    return String(y).padStart(4, '0') + '-' +
      String(m).padStart(2, '0') + '-' +
      String(d).padStart(2, '0');
  }

  function parseAmount(raw, decimal) {
    if (raw == null) return null;
    let s = String(raw).trim();
    if (!s) return null;
    // Strip currency symbols and spaces; keep digits, comma, dot, minus, parens.
    s = s.replace(/[^\d.,\-()]/g, '');
    // Parens → negative.
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
    if (!s) return null;
    let dec;
    if (decimal === 'auto') {
      const lastDot   = s.lastIndexOf('.');
      const lastComma = s.lastIndexOf(',');
      // Whichever appears last is the decimal separator. Falls back to '.'
      // when neither shows up.
      dec = lastComma > lastDot ? ',' : (lastDot > -1 ? '.' : '.');
    } else {
      dec = decimal === ',' ? ',' : '.';
    }
    if (dec === ',') {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
    const n = parseFloat(s);
    if (!isFinite(n)) return null;
    return neg ? -n : n;
  }

  // ---------- Row builder ----------

  // Apply a mapping to the raw rows array. Returns:
  //   { rows: [canonical row objects], errors: [{index, reason, raw}] }
  //
  // Canonical row shape mirrors what bank templates produce:
  //   { date: 'YYYY-MM-DD', amount: <signed Number>, currency: <string>,
  //     merchant: <string>, category: <string|null>, kind: 'expense'|'income',
  //     account_id: null, type: null,
  //     raw: { source: 'csv', csv_row: [...] }, description: <notes|''> }
  //
  // The `account_id` is left null — the Import flow's account-assignment
  // step lets the user pick one for the whole batch (or re-uses an existing
  // account if the CSV has an account column with consistent values; that
  // promotion happens in the UI layer, not here).
  function applyMapping(rawRows, mapping, opts) {
    opts = opts || {};
    const startIndex = mapping.has_header ? 1 : 0;
    const cols = mapping.columns || {};
    const errors = [];
    const out = [];
    for (let i = startIndex; i < rawRows.length; i++) {
      const r = rawRows[i] || [];
      // Skip blank rows so trailing newlines don't poison the count.
      if (r.every(c => !String(c || '').trim())) continue;

      const dateRaw = pickCol(r, cols.date);
      const date = parseDate(dateRaw, mapping.date_format || 'auto');
      if (!date) {
        errors.push({ index: i, reason: 'Unparseable date "' + (dateRaw || '') + '"', raw: r });
        continue;
      }
      let amount = null;
      if (mapping.sign_convention === 'signed') {
        amount = parseAmount(pickCol(r, cols.amount), mapping.amount_decimal || 'auto');
      } else {
        const credit = parseAmount(pickCol(r, cols.amount_credit), mapping.amount_decimal || 'auto');
        const debit  = parseAmount(pickCol(r, cols.amount_debit),  mapping.amount_decimal || 'auto');
        if (credit && credit !== 0) {
          amount = mapping.sign_convention === 'credit_positive' ? Math.abs(credit) : -Math.abs(credit);
        } else if (debit && debit !== 0) {
          amount = mapping.sign_convention === 'credit_positive' ? -Math.abs(debit) : Math.abs(debit);
        } else {
          // Both empty / zero — skip with an error.
          errors.push({ index: i, reason: 'Both credit and debit columns empty', raw: r });
          continue;
        }
      }
      if (amount == null || !isFinite(amount)) {
        errors.push({ index: i, reason: 'Unparseable amount', raw: r });
        continue;
      }
      const merchant = String(pickCol(r, cols.merchant) || '').trim();
      const catRaw = String(pickCol(r, cols.category) || '').trim();
      // Translate non-English category labels (German / Portuguese /
      // Hebrew / French / Spanish / Italian → English) so categories from
      // a German banking CSV merge with categories from PDFs and other
      // sources rather than living in their own silo. Unknown strings
      // pass through untouched.
      const T = (window.App && window.App.processing && window.App.processing.translate) || null;
      const cat = (T && T.translateCategory) ? T.translateCategory(catRaw) : catRaw;
      const acct  = String(pickCol(r, cols.account)  || '').trim();
      const notes = String(pickCol(r, cols.notes)    || '').trim();
      const curRaw = String(pickCol(r, cols.currency) || '').trim();
      const cur    = curRaw || (opts.defaultCurrency || 'EUR');
      const curLocked = !!curRaw;       // true when the CSV explicitly provided a currency
      const kind  = amount >= 0 ? 'income' : 'expense';
      const year  = parseInt(date.slice(0, 4), 10);
      const month = parseInt(date.slice(5, 7), 10);
      out.push({
        date,
        year,
        month: monthName(month),
        amount,
        currency: cur,
        // Set when the CSV had its own currency column — the import UI
        // uses this so the per-account currency override doesn't clobber
        // legitimate per-row currencies (e.g. multi-currency cards).
        __csvCurrencyLocked: curLocked,
        merchant,
        category: cat || null,
        kind,
        account_id: null,         // Import flow assigns this from the picker
        card: null,
        type: null,                // normalizeTxType runs in the review step
        description: notes,
        raw: {
          source: 'csv',
          csv_row: r,
          csv_account: acct || null,
          // Translated value goes on the row's top-level category; the
          // raw value is preserved here so the audit trail still shows
          // what the source CSV said verbatim.
          csv_category: cat || null,
          csv_category_raw: catRaw || null,
        },
      });
    }
    return { rows: out, errors };
  }

  function pickCol(row, idx) {
    if (idx == null) return '';
    if (idx < 0 || idx >= row.length) return '';
    return row[idx];
  }

  // Local copy — util.monthName is friendlier to bring over than depending
  // on App.util being initialised when this module is exercised in
  // isolation (e.g. unit tests).
  function monthName(n) {
    const NAMES = ['January','February','March','April','May','June',
                   'July','August','September','October','November','December'];
    return NAMES[n - 1] || 'Unknown';
  }

  App.processing.csv = {
    FIELD_DEFS,
    detectDelimiter,
    parseCsv,
    readFileAsText,
    suggestMapping,
    parseDate,
    parseAmount,
    applyMapping,
  };
})();

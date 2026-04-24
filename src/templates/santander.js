/*
 * src/templates/santander.js — Santander Portugal checking-account.
 *
 * Each transaction line in the "Detalhe de Movimentos da Conta à Ordem"
 * section looks like:
 *    DD-MM  DD-MM  <description ...>  -1.234,56  1.234,56
 * The last two tokens are the signed amount (negative = debit) and the
 * running balance.
 *
 * Year resolution is anchored on the "Data de Emissão YYYY-MM-DD" header
 * (the statement's issue date). Transactions in a statement are always at
 * or before that date, so for each DD-MM we return the emission year when
 * the month-day sits on or before the emission's month-day, and emission
 * year − 1 otherwise. This replaced the older PERÍODO-based logic, which
 * drifted on cross-year statements.
 *
 * Line-stitching: we glue adjacent lines together when PDF.js has split a
 * single visual row into multiple items (long descriptions, multi-line
 * footers). Section markers are compared NFC-normalised so accented
 * characters match regardless of how the PDF encoded them.
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};
  const util = App.util;

  const EMISSION_RE  = /Data\s+de\s+Emiss[ãa]o\s+(\d{4})-(\d{2})-(\d{2})/i;
  // PERÍODO DE: secondary anchor. Format on Santander PT statements is
  //   "PERÍODO DE  DD-MM-YYYY  A  DD-MM-YYYY"
  // We use the *end* of the period as the year anchor — same semantics as
  // emission date (statements never list rows past the period end).
  const PERIODO_RE   = /PER[ÍI]ODO\s+DE\s+\d{2}-\d{2}-\d{4}\s+A\s+(\d{2})-(\d{2})-(\d{4})/i;
  const IBAN_RE      = /IBAN:\s*([A-Z]{2}\d[\dA-Z]*)/;
  const TX_RE        = /^(\d{2}-\d{2})\s+(\d{2}-\d{2})\s+(.+?)\s+(-?[\d.]*\d,\d{2})\s+(-?[\d.]*\d,\d{2})\s*$/;
  // A line that is *starting* a transaction but missing the trailing amount
  // and/or balance (amount landed on a following line).
  const TX_STARTER   = /^(\d{2}-\d{2})\s+(\d{2}-\d{2})\s+(.+?)\s*$/;
  const AMT_BAL_RE   = /^(-?[\d.]*\d,\d{2})\s+(-?[\d.]*\d,\d{2})\s*$/;

  // Accept either composition of accented characters by normalizing both
  // sides to NFC before comparing (pdf-loader already NFC's the text).
  const START_MARKER = 'Detalhe de Movimentos da Conta à Ordem'.normalize('NFC');
  const STOP_MARKERS = [
    'Saldo Contabilístico Final',
    'Saldo Disponível Final',
    'Conta Empréstimo',
    'Agenda da Conta',
  ].map(s => s.normalize('NFC'));

  const SKIP_LINES = new Set([
    'Data',
    'Mov Valor Descritivo do Movimento Moeda Valor Saldo',
    'Continua', 'Continuação', 'Moeda: EUR',
  ].map(s => s.normalize('NFC')));
  const SKIP_PREFIXES = ['EXTRATO Nº', 'Saldo Inicial'].map(s => s.normalize('NFC'));

  const TX_TYPE_RULES = [
    [/^DÉBITO DIRETO/i, 'DIRECT_DEBIT'],
    [/^COB\.REC\./i, 'DIRECT_DEBIT_COLLECTION'],
    [/^TRF CRED SEPA\+\s*P\//i, 'SEPA_TRANSFER_OUT'],
    [/^TRF CRED SEPA\+\s*DE/i, 'SEPA_TRANSFER_IN'],
    [/^TRF\.CRÉD\.N\.SEPA\+\s*RECEBIDA/i, 'NON_SEPA_TRANSFER_IN'],
    [/^TRF\.CRÉD\.N\.SEPA\+\s*\(DESP/i, 'NON_SEPA_TRANSFER_FEE'],
    [/^TRF MBWAY\s*P\//i, 'MBWAY_OUT'],
    [/^TRF MBWAY\s*DE/i, 'MBWAY_IN'],
    [/^TRF MBWAY-/i, 'MBWAY_OUT'],
    [/^TRF\.IMED\.\s*P\//i, 'INSTANT_TRANSFER_OUT'],
    [/^TRF\.IMED\.\s*DE/i, 'INSTANT_TRANSFER_IN'],
    [/^TRF\. COBR DUC/i, 'DUC_COLLECTION'],
    [/^TRANSFERENCIA SPGT/i, 'SPGT_TRANSFER'],
    [/^COMPRA ESTRANG/i, 'CARD_PURCHASE_FOREIGN'],
    [/^COMPRA\s*\*/i, 'CARD_PURCHASE'],
    [/^PAG SERVICOS/i, 'SERVICE_PAYMENT'],
    [/^PAG ESTADO/i, 'GOVERNMENT_PAYMENT'],
    [/^MANUTENCAO DE CONTA/i, 'ACCOUNT_MAINTENANCE'],
    [/^IMPOSTO DO SELO/i, 'STAMP_TAX'],
    [/^IMPOSTO SELO DE VERBA/i, 'STAMP_TAX_VERBA'],
    [/^IMPOSTO SELO/i, 'STAMP_TAX'],
    [/^IMP\.DE SELO/i, 'STAMP_TAX'],
    [/^IRS\s*\/\s*IRC/i, 'INCOME_TAX'],
    [/^EMI\.CHQ\.BANC/i, 'BANK_CHECK_ISSUE'],
    [/^COM\.CHQ\.BANC/i, 'BANK_CHECK_COMMISSION'],
    [/^I\.S\.CHQ\.BANC/i, 'BANK_CHECK_STAMP_TAX'],
    [/^ESTORNO\s+/i, 'REVERSAL'],
    [/^EST\./i, 'REVERSAL'],
  ];

  function parsePtAmount(s) {
    return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  }
  function deriveType(desc) {
    for (const [re, label] of TX_TYPE_RULES) if (re.test(desc)) return label;
    return 'OTHER';
  }

  // Year resolution is anchored on the "Data de Emissão" header — the
  // statement's issue date. A statement only ever lists transactions up to
  // the moment it was issued, so for each booking's DD-MM we return:
  //   - emission.year          if (month, day) <= (emission.month, emission.day)
  //   - emission.year - 1      otherwise   (it must be from the prior year)
  // This is strictly simpler than the old PERÍODO-based resolver and fixes
  // the cross-year edge case where a December row on a January-issued
  // statement was getting stamped with the wrong year.
  function resolveYearFromEmission(dayMonth, emission) {
    const [ddStr, mmStr] = dayMonth.split('-');
    const day = parseInt(ddStr, 10);
    const month = parseInt(mmStr, 10);
    if (month < emission.month) return emission.year;
    if (month > emission.month) return emission.year - 1;
    // Same month — compare days.
    return day <= emission.day ? emission.year : emission.year - 1;
  }

  function parseEmission(parsed) {
    const m = EMISSION_RE.exec(parsed.textAll);
    if (!m) return null;
    const iso = m[1] + '-' + m[2] + '-' + m[3];
    return {
      year:  +m[1],
      month: +m[2],
      day:   +m[3],
      date:  util.parseISODate(iso),
      iso,
      source: 'emission',
    };
  }

  // Fallback anchor when the emission header is absent / unreadable. Reads
  // the PERÍODO DE end-date — Santander prints this prominently at the top
  // of every statement, so it's a reliable second source of the year. Same
  // shape as parseEmission so resolveYearFromEmission works against either.
  function parsePeriodEnd(parsed) {
    const m = PERIODO_RE.exec(parsed.textAll);
    if (!m) return null;
    const day   = +m[1];
    const month = +m[2];
    const year  = +m[3];
    const iso   = year.toString().padStart(4, '0') + '-' +
                  month.toString().padStart(2, '0') + '-' +
                  day.toString().padStart(2, '0');
    return {
      year, month, day,
      date: util.parseISODate(iso),
      iso,
      source: 'periodo',
    };
  }

  function detect(parsed) {
    const t = (parsed.textAll || '');
    let score = 0;
    if (/SANTANDER/i.test(t)) score += 0.4;
    if (EMISSION_RE.test(t)) score += 0.2;
    if (t.indexOf(START_MARKER) !== -1) score += 0.4;
    // fallback cues
    if (/Movimentos da Conta/i.test(t) || /Saldo Dispon[ií]vel/i.test(t)) score += 0.2;
    return Math.min(score, 1);
  }

  // Stitch transaction lines where PDF.js split the description from the
  // numeric columns into separate y-rows.
  function stitchLines(lines) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const cur = (lines[i] || '').trim();
      if (!cur) { out.push(cur); continue; }
      if (TX_RE.test(cur)) { out.push(cur); continue; }
      const starter = TX_STARTER.exec(cur);
      if (starter) {
        // Look ahead up to 2 lines for an amount+balance pair.
        for (let j = 1; j <= 2 && i + j < lines.length; j++) {
          const peek = (lines[i + j] || '').trim();
          if (!peek) continue;
          if (AMT_BAL_RE.test(peek)) {
            out.push(cur + ' ' + peek);
            i += j;
            break;
          }
          break;
        }
        if (out[out.length - 1] !== cur + ' ' + ((lines[i] || '').trim())) {
          if (out[out.length - 1] !== cur) out.push(cur);
        }
        continue;
      }
      out.push(cur);
    }
    return out;
  }

  function parse(parsed, opts) {
    opts = opts || {};
    const rows = [];
    const emission = parseEmission(parsed);
    const periodEnd = parsePeriodEnd(parsed);
    const ibanMatch = IBAN_RE.exec(parsed.textAll);
    const iban = ibanMatch ? ibanMatch[1] : '';

    // Year-anchor chain (in priority order):
    //   1. Data de Emissão YYYY-MM-DD          (most authoritative)
    //   2. PERÍODO DE … A DD-MM-YYYY end date  (always present on Santander PT)
    //   3. opts.userYear                       (caller-supplied via prompt)
    //   4. (no anchor)                         → return needs_year_input flag
    //
    // The caller (import.js) is expected to handle the third step: when our
    // first parse pass returns `meta.needs_year_input`, the import flow
    // prompts the user for a year per document and re-parses with
    // `opts.userYear` set. We deliberately *don't* silently fall back to
    // "today" any more — quietly accepting today's year was the source of
    // the cross-year drift the user hit on archived PDFs.
    let yearAnchor = emission || periodEnd || null;
    let yearSource = yearAnchor && yearAnchor.source ? yearAnchor.source : null;
    if (!yearAnchor && opts.userYear) {
      // Build a synthetic Dec-31 anchor from the supplied year so every
      // booking month resolves to that year. Statements span at most ~12
      // months, so a year-end anchor is safe even if the period spans
      // November–February.
      yearAnchor = {
        year:  +opts.userYear,
        month: 12,
        day:   31,
        date:  util.parseISODate(opts.userYear + '-12-31'),
        iso:   opts.userYear + '-12-31',
        source: 'user',
      };
      yearSource = 'user';
    }
    if (!yearAnchor) {
      return {
        rows: [],
        meta: {
          bank: 'Santander PT', currency: 'EUR', iban,
          needs_year_input: true,
          year_anchor_source: null,
          unmatched_lines: 0,
          period_iso: null,
        },
      };
    }

    let inSection = false;
    let stopped = false;
    const diagnostics = {
      emission_inferred: !emission,
      year_anchor_source: yearSource,
      unmatched: 0,
    };

    for (const page of parsed.pages) {
      if (stopped) break;
      const lines = stitchLines(page.lines);
      for (const raw of lines) {
        const line = (raw || '').trim();
        if (!line) continue;
        if (!inSection) {
          if (line.indexOf(START_MARKER) !== -1) inSection = true;
          else if (/Movimentos da Conta/i.test(line)) inSection = true;
          continue;
        }
        if (STOP_MARKERS.some(s => line.indexOf(s) !== -1)) { stopped = true; break; }
        if (SKIP_LINES.has(line)) continue;
        if (SKIP_PREFIXES.some(p => line.startsWith(p))) continue;

        const m = TX_RE.exec(line);
        if (!m) { diagnostics.unmatched++; continue; }

        let bookingYear = resolveYearFromEmission(m[1], yearAnchor);
        const valueYear = resolveYearFromEmission(m[2], yearAnchor);
        const [bd, bm]  = m[1].split('-');
        const description = m[3].trim();
        const amount      = parsePtAmount(m[4]);
        // Defensive: if for any reason the resolved date lands in the future,
        // walk it back a year. Prevents user-visible "January 2027" etc.
        const todayCap = new Date(); todayCap.setHours(23, 59, 59, 999);
        let candidate = util.parseISODate(`${bookingYear.toString().padStart(4,'0')}-${bm}-${bd}`);
        while (candidate > todayCap && bookingYear > 1900) {
          bookingYear -= 1;
          candidate = util.parseISODate(`${bookingYear.toString().padStart(4,'0')}-${bm}-${bd}`);
        }
        const iso = `${bookingYear.toString().padStart(4,'0')}-${bm}-${bd}`;
        const d   = candidate;

        rows.push({
          date: iso,
          year: d.getFullYear(),
          month: util.monthName(d.getMonth() + 1),
          merchant: description,
          amount: Math.abs(amount),
          category: null,
          card: iban ? iban.slice(-4) : 'SAN',
          currency: 'EUR',
          kind: amount < 0 ? 'expense' : 'income',
          description: null,
          raw: {
            account_iban: iban,
            transaction_type: deriveType(description),
            value_date_year: valueYear,
            balance: m[5],
            // Persist the emission header on every row so future tooling can
            // re-anchor years without re-parsing the source PDF.
            statement_emission_date:     yearAnchor.iso,
            statement_emission_inferred: !emission,
            year_anchor_source:          yearSource,
          },
        });
      }
    }
    return {
      rows,
      meta: {
        bank: 'Santander PT', currency: 'EUR', iban,
        emission_inferred: diagnostics.emission_inferred,
        year_anchor_source: yearSource,
        unmatched_lines: diagnostics.unmatched,
      },
    };
  }

  App.templates.register({
    id: 'santander-pt',
    bank: 'Santander PT',
    country: 'PT',
    currency: 'EUR',
    description: 'Santander Portugal checking-account statement.',
    detect,
    parse,
  });
})();

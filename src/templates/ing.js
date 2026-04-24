/*
 * src/templates/ing.js — ING-DiBa (Germany) Kontoauszug parser.
 * Ported from ing_pdf_to_csv.py. Each statement covers one month; all
 * transactions live on page 1 of the PDF.
 *
 * Implementation notes:
 *   - PDF.js occasionally splits what pdfplumber sees as one line into
 *     multiple y-slices. We tolerate that by pre-joining broken transaction
 *     lines before running TX_START_RE (so lines that are missing an amount
 *     pick up the continuation line that carries one).
 *   - German amount format: 1.234,56 — dot thousand sep, comma decimal.
 *     ING sometimes appends a footnote digit (e.g. "-934,641"); the trailing
 *     `\d?` in TX_START_RE absorbs that.
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};
  const util = App.util;

  // IBAN DE03 5001 0517 5414 5805 90 (spaces preserved in PDF text).
  const IBAN_RE = /IBAN[ \t]+([A-Z]{2}\d{2}(?:[ \t]*[A-Z0-9]{1,4}){3,8})/;

  const TX_START_RE    = /^(\d{2}\.\d{2}\.\d{4})\s+(\S+)(?:\s+(.*?))?\s+(-?\d[\d.]*,\d{2})\d?\s*$/;
  const TX_START_NOAMT = /^(\d{2}\.\d{2}\.\d{4})\s+(\S+)(?:\s+(.+?))?\s*$/; // fallback: amount on next line
  const AMOUNT_ONLY_RE = /^(-?\d[\d.]*,\d{2})\d?\s*$/;
  const VALUE_DATE_RE  = /^(\d{2}\.\d{2}\.\d{4})(?:\s+(.*))?$/;
  const HEADER_RE      = /^Buchung\s+Buchung\s*\/\s*Verwendungszweck\s+Betrag/;
  const NEW_BAL        = /^Neuer Saldo\s+(-?\d[\d.]*,\d{2})(?:\s|$)/;

  const SKIP_LINES = new Set([
    'Kunden-Information',
    'Buchung / Verwendungszweck Betrag (EUR)',
    'Valuta',
  ]);

  const TYPE_KEYWORDS = new Set([
    'Lastschrift', 'Gutschrift', 'Gutschrift/Dauerauftrag',
    'Ueberweisung', 'Überweisung', 'Entgelt', 'Dauerauftrag',
    'Wertpapierkauf', 'Wertpapierverkauf', 'Wertpapiergutschrift',
    'Wertpapierbelastung', 'Zins/Dividende', 'Gehalt/Rente',
    'Rueckueberweisung', 'Rücküberweisung', 'Storno', 'Zinsen',
    'Abschluss', 'Barauszahlung', 'Bareinzahlung',
  ]);

  const TX_TYPE_MAP = {
    'Lastschrift': 'DIRECT_DEBIT',
    'Gutschrift': 'CREDIT',
    'Gutschrift/Dauerauftrag': 'STANDING_ORDER_CREDIT',
    'Ueberweisung': 'TRANSFER_OUT', 'Überweisung': 'TRANSFER_OUT',
    'Entgelt': 'FEE', 'Dauerauftrag': 'STANDING_ORDER',
    'Wertpapierkauf': 'SECURITIES_PURCHASE',
    'Wertpapierverkauf': 'SECURITIES_SALE',
    'Wertpapiergutschrift': 'SECURITIES_CREDIT',
    'Wertpapierbelastung': 'SECURITIES_DEBIT',
    'Zins/Dividende': 'INTEREST_DIVIDEND',
    'Gehalt/Rente': 'SALARY',
    'Rueckueberweisung': 'RETURN_TRANSFER',
    'Rücküberweisung': 'RETURN_TRANSFER',
    'Storno': 'REVERSAL', 'Zinsen': 'INTEREST',
    'Abschluss': 'ACCOUNT_CLOSING',
    'Barauszahlung': 'CASH_WITHDRAWAL',
    'Bareinzahlung': 'CASH_DEPOSIT',
  };

  function parseDeAmount(s) {
    return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  }
  function parseDeDate(s) {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }

  function extractIban(text) {
    const m = IBAN_RE.exec(text);
    if (!m) return '';
    return m[1].replace(/\s+/g, '');
  }

  function detect(parsed) {
    const t = parsed.textAll || '';
    let score = 0;
    if (/ING[\s-]?DiBa/i.test(t)) score += 0.5;
    if (/Kontoauszug/i.test(t)) score += 0.2;
    if (/Alter Saldo|Neuer Saldo/i.test(t)) score += 0.3;
    if (/Verwendungszweck/i.test(t)) score += 0.1;
    return Math.min(score, 1);
  }

  function deriveType(typeWord, desc) {
    const base = TX_TYPE_MAP[typeWord] || 'OTHER';
    if (base === 'DIRECT_DEBIT' && /^VISA /.test(desc)) return 'CARD_PURCHASE';
    if (base === 'FEE' && /^VISA /.test(desc)) return 'CARD_FEE';
    return base;
  }

  // Pre-pass over page lines: if a transaction-start line lacks the amount
  // (split across lines by PDF.js), absorb the next amount-only line.
  function stitchLines(lines) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const cur = lines[i].trim();
      if (!cur) { out.push(cur); continue; }
      if (TX_START_RE.test(cur)) { out.push(cur); continue; }
      const noAmt = TX_START_NOAMT.exec(cur);
      if (noAmt && TYPE_KEYWORDS.has(noAmt[2])) {
        // Look ahead up to 2 lines for an amount-only line.
        for (let j = 1; j <= 2 && i + j < lines.length; j++) {
          const peek = (lines[i + j] || '').trim();
          if (AMOUNT_ONLY_RE.test(peek)) {
            out.push(cur + ' ' + peek);
            i += j; // skip absorbed lines
            break;
          }
          if (!peek) continue;
          // any other meaningful line → give up stitching; fall through
          break;
        }
        if (out[out.length - 1] === cur) out.push(cur);
        continue;
      }
      out.push(cur);
    }
    return out;
  }

  function parse(parsed) {
    const rows = [];
    const iban = extractIban(parsed.textAll);
    const page1 = parsed.pages[0];
    if (!page1) return { rows, meta: { bank: 'ING', iban } };

    let inBlock = false;
    let current = null;

    function flush() {
      if (!current) return;
      const desc = current.description.trim();
      const txType = deriveType(current.typeWord, desc);
      const iso = parseDeDate(current.booking);
      if (!iso) { current = null; return; }
      const d = util.parseISODate(iso);
      const amtSigned = current.amount;
      rows.push({
        date: iso,
        year: d.getFullYear(),
        month: util.monthName(d.getMonth() + 1),
        merchant: desc,
        amount: Math.abs(amtSigned),
        category: null,
        card: iban ? iban.slice(-4) : 'ING',
        currency: 'EUR',
        kind: amtSigned < 0 ? 'expense' : 'income',
        description: null,
        raw: {
          account_iban: iban,
          transaction_type: txType,
          value_date: current.value ? parseDeDate(current.value) : null,
        },
      });
      current = null;
    }

    const lines = stitchLines(page1.lines);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (!inBlock) { if (HEADER_RE.test(line)) inBlock = true; continue; }

      const bm = NEW_BAL.exec(line);
      if (bm) { flush(); break; }
      if (SKIP_LINES.has(line)) continue;

      const mt = TX_START_RE.exec(line);
      if (mt && TYPE_KEYWORDS.has(mt[2])) {
        flush();
        current = {
          booking: mt[1],
          typeWord: mt[2],
          description: (mt[2] + ' ' + (mt[3] || '')).trim(),
          amount: parseDeAmount(mt[4]),
          value: null,
        };
        continue;
      }
      if (!current) continue;
      if (!current.value) {
        const vm = VALUE_DATE_RE.exec(line);
        if (vm) {
          current.value = vm[1];
          if (vm[2]) current.description += ' ' + vm[2].trim();
          continue;
        }
      }
      current.description += ' ' + line;
    }
    flush();
    return { rows, meta: { bank: 'ING-DiBa', currency: 'EUR', iban } };
  }

  App.templates.register({
    id: 'ing-de',
    bank: 'ING-DiBa',
    country: 'DE',
    currency: 'EUR',
    description: 'ING-DiBa Germany Kontoauszug.',
    detect,
    parse,
  });
})();

/*
 * src/templates/n26.js — N26 bank statement parser.
 * Ported from the Kalkala Python n26_pdf_to_json.py parser.
 *
 * Transaction line on page ~= "<name> DD.MM.YYYY +/-amount€". Sub-lines
 * carry the value date, transaction type, IBAN/BIC, and free-form
 * description ("Verwendungszweck").
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};
  const util = App.util;

  const MAIN_LINE_RE  = /^(.+?)\s+(\d{2}\.\d{2}\.\d{4})\s+([+\-]?[\d.,]+)€\s*$/;
  const VALUE_DATE_RE = /^(?:Value Date|Wertstellung)\s+(\d{2}\.\d{2}\.\d{4})\s*$/;
  const IBAN_RE       = /IBAN:\s*([A-Z0-9]+)/;
  const BIC_RE        = /BIC:\s*([A-Z0-9]+)/;
  const ORIGINAL_RE   = /(?:Original amount|Ursprungsbetrag)\s+([\d.,]+)\s+([A-Z]{3})\s*\|\s*(?:Exchange rate|Wechselkurs)\s+([\d.,]+)/;
  const FOOTER_IBAN   = /^(?:Space\s+)?IBAN:\s+\S+\s+•\s+BIC:\s+\S+\s+Nr\.\s+\d{2}\/\d{4}\s*$/;
  const PAGE_NUMBER   = /^\d+\s*\/\s*\d+\s*$/;
  const DATE_RANGE    = /^\d{2}\.\d{2}\.\d{4}\s+(?:until|bis)\s+\d{2}\.\d{2}\.\d{4}\s*$/;
  const FOOTER_NAME   = /^.+\s+(?:Issued on|Erstellt am)\s*$/;
  const SPACE_NAME_RE = /^Space:\s*(.+?)\s*$/;

  const HEADER_SKIP_PREFIXES = [
    'Bank Statement', 'Space Statement', 'Spaces Overview', 'Overview Nr.',
    'Description', 'Remark', 'Quarterly', 'Space:', 'Date opened:', 'Date closed:',
    'Kontoauszug', 'Spaces-Auszug', 'Space-Auszug', 'Spaces Übersicht',
    'Übersicht Nr.', 'Beschreibung', 'Anmerkung', 'Vierteljähr',
    'Space geöffnet:', 'Space geschlossen:',
  ];

  const KNOWN_TX_TYPES = new Set([
    'Business Mastercard', 'Mastercard',
    'Outgoing Transfers', 'Incoming Transfers', 'Direct Debits',
    'Income', 'NUMBER26 Referral', 'N26 Business Metal Membership',
    'MoneyBeam', 'Credit Transfer',
    'Gutschriften', 'Belastungen', 'Lastschriften',
    'NUMBER26 Empfehlung', 'N26 Business Metal Mitgliedschaft',
    'Überweisung', 'Eingehende Überweisungen', 'Ausgehende Überweisungen',
  ]);

  function parseDeAmount(s) {
    return parseFloat(s.trim().replace(/\./g, '').replace(',', '.'));
  }
  function parseDeDate(s) {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }

  function detectFooter(parsed) {
    if (!parsed.pages.length) return { ownIban: null, footerAddress: null };
    const lines = parsed.pages[0].lines;
    const pat = /^IBAN:\s+(\S+)\s+•\s+BIC:\s+\S+\s+Nr\.\s+\d{2}\/\d{4}\s*$/;
    for (let i = 0; i < lines.length; i++) {
      const m = pat.exec(lines[i]);
      if (m) return { ownIban: m[1], footerAddress: i > 0 ? lines[i - 1].trimEnd() : null };
    }
    return { ownIban: null, footerAddress: null };
  }

  function isSkippable(line, ownIban, footerAddress) {
    if (!line) return true;
    if (PAGE_NUMBER.test(line)) return true;
    if (DATE_RANGE.test(line)) return true;
    if (FOOTER_IBAN.test(line)) return true;
    if (FOOTER_NAME.test(line)) return true;
    if (footerAddress && line === footerAddress) return true;
    for (const prefix of HEADER_SKIP_PREFIXES) {
      if (line.startsWith(prefix)) return true;
    }
    if (ownIban && line.includes(ownIban) && line.includes('BIC:')) return true;
    return false;
  }

  function assignSubLine(txn, line, descBuf) {
    let m = VALUE_DATE_RE.exec(line);
    if (m) { txn._valueDate = parseDeDate(m[1]); return; }

    m = ORIGINAL_RE.exec(line);
    if (m) {
      txn.raw = txn.raw || {};
      txn.raw.original_amount = `${m[1]} ${m[2]}`;
      txn.raw.exchange_rate = parseFloat(m[3].replace(',', '.'));
      return;
    }

    const iM = IBAN_RE.exec(line);
    const bM = BIC_RE.exec(line);
    if (iM || bM) {
      txn.raw = txn.raw || {};
      if (iM) txn.raw.iban = iM[1];
      if (bM) txn.raw.bic = bM[1];
      let leftover = line;
      if (iM) leftover = leftover.replace(iM[0], '');
      if (bM) leftover = leftover.replace(bM[0], '');
      leftover = leftover.replace(/•/g, '').replace(/^[\s\-\t]+|[\s\-\t]+$/g, '');
      if (leftover) descBuf.push(leftover);
      return;
    }

    if (line.indexOf('•') !== -1) {
      const parts = line.split('•');
      const ttype = parts[0].trim();
      const cat   = parts.slice(1).join('•').trim();
      if (!txn._transactionType) {
        txn._transactionType = ttype;
        if (cat) txn._bankCategory = cat;
        return;
      }
      descBuf.push(line); return;
    }

    const stripped = line.trim();
    if (!txn._transactionType && (KNOWN_TX_TYPES.has(stripped) ||
        Array.from(KNOWN_TX_TYPES).some(t => stripped.startsWith(t)))) {
      txn._transactionType = stripped; return;
    }
    if (!txn._transactionType) { txn._transactionType = stripped; return; }
    descBuf.push(line);
  }

  function detect(parsed) {
    const t = parsed.textAll || '';
    let score = 0;
    if (/N26 Bank/i.test(t) || /NUMBER26/i.test(t)) score += 0.4;
    if (/IBAN:\s+DE\d{2}/.test(t)) score += 0.2;
    if (/Kontoauszug|Bank Statement/.test(t)) score += 0.2;
    if (/Wertstellung|Value Date/.test(t)) score += 0.2;
    return Math.min(score, 1);
  }

  function parse(parsed) {
    const rows = [];
    const { ownIban, footerAddress } = detectFooter(parsed);
    // N26 PDFs can bundle multiple accounts (Main + one-or-more Spaces).
    // We track which sub-account we're currently inside and tag every row.
    let currentAccount = 'Main';
    const subAccounts = new Map(); // key -> { key, name, rowCount }
    function touchAccount(key) {
      if (!subAccounts.has(key)) {
        subAccounts.set(key, { key, name: key, rowCount: 0 });
      }
      return subAccounts.get(key);
    }
    touchAccount(currentAccount);
    let current = null;
    let descBuf = [];

    function finalize() {
      if (!current) return;
      current.description = descBuf.map(s => s.trim()).filter(Boolean).join(' ') || null;
      // N26 puts a per-transaction category on the same line as the
      // transaction type, separated by "•". Surface it as the row's category
      // (rules / user edits still win later in the review screen).
      if (current._bankCategory && !current.category) {
        current.category = current._bankCategory;
      }
      if (current._transactionType) {
        current.raw = current.raw || {};
        current.raw.transaction_type = current._transactionType;
      }
      if (current._bankCategory) {
        current.raw = current.raw || {};
        current.raw.bank_category = current._bankCategory;
      }
      // Strip scratch fields the storage layer doesn't need.
      delete current._transactionType;
      delete current._bankCategory;
      delete current._valueDate;
      // Multi-account support: tag every row with its sub-account key so the
      // import flow can ask the user which real account each group belongs to.
      current._accountKey = currentAccount;
      const sub = touchAccount(currentAccount);
      sub.rowCount++;
      rows.push(current);
      current = null;
      descBuf = [];
    }

    for (const page of parsed.pages) {
      const stripped = page.lines.map(l => l.trim()).filter(Boolean);
      if (!stripped.length) continue;
      const first = stripped[0];
      if (first.startsWith('Overview Nr.') || first.startsWith('Spaces Overview') ||
          first.startsWith('Quarterly')   || first.startsWith('Übersicht Nr.') ||
          first.startsWith('Spaces Übersicht') || first.startsWith('Zusammenfassung') ||
          first.startsWith('Vierteljähr')) {
        finalize(); continue;
      }
      if (first.startsWith('Space Statement') || first.startsWith('Space-Auszug') ||
          first.startsWith('Spaces-Auszug')) {
        finalize(); currentAccount = 'Space';
        for (const ln of stripped.slice(0, 6)) {
          const m = SPACE_NAME_RE.exec(ln);
          if (m) { currentAccount = m[1].trim(); break; }
        }
      } else if (first.startsWith('Bank Statement Nr.') || first.startsWith('Kontoauszug Nr.')) {
        currentAccount = 'Main';
      }

      for (const raw of page.lines) {
        const line = raw.trim();
        if (isSkippable(line, ownIban, footerAddress)) continue;

        const m = MAIN_LINE_RE.exec(line);
        if (m) {
          finalize();
          const name = m[1].trim();
          const iso = parseDeDate(m[2]);
          const amount = parseDeAmount(m[3]);
          if (!iso) continue;
          const d = util.parseISODate(iso);
          current = {
            date: iso,
            year: d.getFullYear(),
            month: util.monthName(d.getMonth() + 1),
            merchant: name,
            amount: -amount, // N26 convention: negative = outgoing. We store outgoing as positive "expense".
            category: null,
            card: currentAccount,
            currency: 'EUR',
            kind: amount < 0 ? 'expense' : 'income',
            description: null,
            raw: {},
          };
          // Normalize: amount in dashboard is positive for expenses. Re-flip:
          current.amount = amount < 0 ? Math.abs(amount) : amount;
          current.kind   = amount < 0 ? 'expense' : 'income';
          descBuf = [];
          continue;
        }
        if (current) assignSubLine(current, line, descBuf);
      }
    }
    finalize();
    // Surface every sub-account we encountered so the import review can
    // render a separate account-assignment row per key. If only one was
    // seen, the import UI degrades to a single account row.
    const accounts = Array.from(subAccounts.values())
      .filter(a => a.rowCount > 0)
      .map(a => ({
        key: a.key,
        name: a.key === 'Main' ? 'N26 Main' : 'N26 ' + a.key,
        // All Spaces share the main IBAN on N26; we only know the main one.
        iban: a.key === 'Main' ? (ownIban || null) : null,
        bank: 'N26', currency: 'EUR',
        rowCount: a.rowCount,
      }));
    return {
      rows,
      meta: {
        bank: 'N26', currency: 'EUR', iban: ownIban || null,
        accounts,
      },
    };
  }

  App.templates.register({
    id: 'n26',
    bank: 'N26',
    country: 'DE',
    currency: 'EUR',
    description: 'N26 Bank Statement / Kontoauszug.',
    detect,
    parse,
  });
})();

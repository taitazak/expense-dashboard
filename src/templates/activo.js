/*
 * src/templates/activo.js — ActivoBank (Portugal) EXTRATO COMBINADO parser.
 * Ported from activo_pdf_to_csv.py.
 *
 * Activo statements use a three-column money layout (DEBITO / CREDITO / SALDO).
 * PDF.js text extraction does not preserve the column, so the single amount
 * token's sign is inferred from the running balance: new_saldo - prev_saldo
 * should equal either +amt (credit) or -amt (debit).
 *
 * Numbers use space-separated thousands and dot decimal: "1 968.41".
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};
  const util = App.util;

  const PERIOD_RE  = /EXTRATO DE\s+(\d{4}\/\d{2}\/\d{2})\s+A\s+(\d{4}\/\d{2}\/\d{2})/;
  const ACCOUNT_RE = /CONTA SIMPLES N\.\s+(\d+)\s+MOEDA:\s*(\w+)/;

  // Amount: "1 968.41" or "246.70".  NB: a literal space separates thousands.
  const NUMBER_PAT = '\\d{1,3}(?:\\s\\d{3})*\\.\\d{2}';
  const SALDO_INICIAL_RE = new RegExp(`^SALDO INICIAL\\s+(${NUMBER_PAT})\\s*$`);
  const SALDO_FINAL_RE   = new RegExp(`^SALDO FINAL\\s+(${NUMBER_PAT})\\s*$`);
  const ROW_RE = new RegExp(
    '^(\\d{1,2}\\.\\d{2})\\s+' +        // lanc
    '(\\d{1,2}\\.\\d{2})\\s+' +         // valor
    '(.+?)\\s+' +                       // desc
    `(${NUMBER_PAT})\\s+` +             // amt
    `(${NUMBER_PAT})\\s*$`              // bal
  );

  const TX_TYPE_RULES = [
    [/^DD\s+/i, 'DIRECT_DEBIT'],
    [/^TRF MB WAY\s+P\//i, 'MBWAY_OUT'],
    [/^TRF MB WAY\s+DE/i, 'MBWAY_IN'],
    [/^TRF\. P\/O/i, 'TRANSFER_OUT'],
    [/^TRF\s*P\/\s/i, 'TRANSFER_OUT'],
    [/^TRF\.IMED\./i, 'INSTANT_TRANSFER'],
    [/^COMPRA\s+\d+/i, 'CARD_PURCHASE'],
    [/^CRED\.\s+\d+/i, 'CARD_REFUND'],
    [/^PAG SERV\b/i, 'SERVICE_PAYMENT'],
    [/-PAG SERVICOS/i, 'SERVICE_PAYMENT'],
    [/^Ordem Pagamento s\/Estrangeiro/i, 'FOREIGN_PAYMENT'],
    [/^COB\.REC/i, 'DIRECT_DEBIT_COLLECTION'],
    [/^MANUTENCAO/i, 'ACCOUNT_MAINTENANCE'],
    [/^IMPOSTO SELO/i, 'STAMP_TAX'],
    [/^IMPOSTO DO SELO/i, 'STAMP_TAX'],
    [/^IMP\.\s*SELO/i, 'STAMP_TAX'],
    [/^LEVANT\b/i, 'CASH_WITHDRAWAL'],
    [/^DEP\.\s+NUMERARIO/i, 'CASH_DEPOSIT'],
  ];

  function parsePtNumber(s) {
    // "1 968.41" -> 1968.41
    return parseFloat(s.replace(/\s+/g, ''));
  }

  function deriveType(description, amountSigned) {
    for (const [re, label] of TX_TYPE_RULES) {
      if (re.test(description)) return label;
    }
    return amountSigned > 0 ? 'INCOMING_TRANSFER' : 'OTHER';
  }

  function parsePeriod(text) {
    const m = PERIOD_RE.exec(text);
    if (!m) return null;
    const toIso = (slash) => slash.replace(/\//g, '-');
    const startIso = toIso(m[1]);
    const endIso = toIso(m[2]);
    return {
      start: { iso: startIso, year: +startIso.slice(0, 4), date: util.parseISODate(startIso) },
      end:   { iso: endIso,   year: +endIso.slice(0, 4),   date: util.parseISODate(endIso)   },
    };
  }

  function resolveYear(month, day, period) {
    const years = Array.from(new Set([period.start.year, period.end.year])).sort();
    for (const y of years) {
      const d = new Date(y, month - 1, day);
      if (d >= period.start.date && d <= period.end.date) return y;
    }
    return period.end.year;
  }

  function detect(parsed) {
    const t = parsed.textAll || '';
    let score = 0;
    if (/ACTIVOBANK|Activo\s?Bank/i.test(t)) score += 0.4;
    if (/EXTRATO DE\s+\d{4}\/\d{2}\/\d{2}/.test(t)) score += 0.3;
    if (/SALDO INICIAL/.test(t) && /SALDO FINAL/.test(t)) score += 0.3;
    if (/CONTA SIMPLES N\./.test(t)) score += 0.2;
    return Math.min(score, 1);
  }

  function parse(parsed) {
    const rows = [];
    const text = parsed.textAll || '';

    const period = parsePeriod(text);
    if (!period) {
      return { rows, meta: { bank: 'ActivoBank', error: 'Period header not found' } };
    }

    const acctM = ACCOUNT_RE.exec(text);
    const account  = acctM ? acctM[1] : '';
    const currency = acctM ? acctM[2] : 'EUR';

    let inBlock = false;
    let running = null; // last balance we saw

    for (const page of parsed.pages) {
      for (const raw of page.lines) {
        const line = raw.trim();
        if (!line) continue;

        if (!inBlock) {
          const mi = SALDO_INICIAL_RE.exec(line);
          if (mi) { running = parsePtNumber(mi[1]); inBlock = true; }
          continue;
        }

        if (SALDO_FINAL_RE.test(line) || line.startsWith('SALDO DISPONIVEL')) {
          return finish();
        }

        const mr = ROW_RE.exec(line);
        if (!mr) continue;

        const amt = parsePtNumber(mr[4]);
        const newBal = parsePtNumber(mr[5]);

        let sign;
        if (running === null) {
          sign = 1;
        } else {
          const delta = +(newBal - running).toFixed(2);
          if (Math.abs(delta - amt) < 0.005)       sign =  1;
          else if (Math.abs(delta + amt) < 0.005)  sign = -1;
          else sign = delta >= 0 ? 1 : -1; // parse mismatch fallback
        }
        const amountSigned = sign * amt;
        running = newBal;

        const [lm, ld] = mr[1].split('.').map(n => parseInt(n, 10));
        const [vm, vd] = mr[2].split('.').map(n => parseInt(n, 10));
        const bookingYear = resolveYear(lm, ld, period);
        const valueYear   = resolveYear(vm, vd, period);
        const bookingIso = `${String(bookingYear).padStart(4,'0')}-${String(lm).padStart(2,'0')}-${String(ld).padStart(2,'0')}`;
        const valueIso   = `${String(valueYear).padStart(4,'0')}-${String(vm).padStart(2,'0')}-${String(vd).padStart(2,'0')}`;

        const description = mr[3].trim();
        const txType = deriveType(description, amountSigned);
        const d = util.parseISODate(bookingIso);

        rows.push({
          date: bookingIso,
          year: d.getFullYear(),
          month: util.monthName(d.getMonth() + 1),
          merchant: description,
          amount: Math.abs(amountSigned),
          category: null,
          card: account ? account.slice(-4) : 'ACT',
          currency,
          kind: amountSigned < 0 ? 'expense' : 'income',
          description: null,
          raw: {
            account_number: account,
            transaction_type: txType,
            value_date: valueIso,
            balance: newBal,
          },
        });
      }
    }
    return finish();

    function finish() {
      return { rows, meta: { bank: 'ActivoBank', currency, account_number: account } };
    }
  }

  App.templates.register({
    id: 'activo',
    bank: 'ActivoBank',
    country: 'PT',
    currency: 'EUR',
    description: 'ActivoBank Portugal EXTRATO COMBINADO statement.',
    detect,
    parse,
  });
})();

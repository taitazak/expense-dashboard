/*
 * src/templates/leumi.js — Bank Leumi (Israel) credit card statement.
 * Hebrew text is stored reversed in the PDF; reverse character-by-character
 * per line to recover reading order.
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};
  const util = App.util;

  function fixHebrew(text) {
    if (!text) return text;
    const has = /[\u0590-\u05FF]/.test(text);
    if (!has) return text;
    return text.split('').reverse().join('');
  }

  // Patterns mirror the Python version; PDF.js text extraction places numbers
  // on the same line as merchant+date, which is what these regexes expect.
  const REGULAR = new RegExp(
    '(-?[\\d,]+\\.?\\d*)\\s+' +
    '(?:הליגר הקסע|ל"וח לקייס|הקסע רגילה|ל"חו לקייס)\\s+' +
    '([\\d,]+\\.?\\d*)\\s+' +
    '(.+?)\\s+' +
    '(\\d{2}/\\d{2}/\\d{2})'
  );
  const INSTALLMENT = new RegExp(
    '(-?[\\d,]+\\.?\\d*)\\s+' +
    '(?:םימולשתב הקסע|הליגר םימולשת תקסע)\\s+' +
    '(?:םימולשתב הקסע|הליגר םימולשת תקסע)\\s+' +
    '([\\d,]+\\.?\\d*)\\s+' +
    '(.+?)\\s+' +
    '(\\d{2}/\\d{2}/\\d{2})'
  );

  function parseDateDMY(dmy) {
    // "DD/MM/YY" -> "YYYY-MM-DD"
    const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(dmy);
    if (!m) return null;
    const yy = parseInt(m[3], 10);
    const year = yy >= 80 ? 1900 + yy : 2000 + yy;
    return `${year}-${m[2]}-${m[1]}`;
  }

  function extractCard(textAll) {
    // Two printed forms: "9334 דראקרטסמ" and "9334 הזיו" (visa)
    const m = /(\d{4})\s+דראקרטסמ|(\d{4})\s+הזיו/.exec(textAll);
    if (!m) return '0000';
    return m[1] || m[2] || '0000';
  }

  function detect(parsed) {
    const t = parsed.textAll || '';
    let score = 0;
    if (/דראקרטסמ/.test(t) || /הזיו/.test(t)) score += 0.4;
    if (/ימואל קנב/.test(t) || /בנק לאומי/.test(t)) score += 0.4;
    if (/הליגר הקסע|םימולשתב הקסע/.test(t)) score += 0.4;
    return Math.min(score, 1);
  }

  function parse(parsed) {
    const rows = [];
    const card = extractCard(parsed.textAll);

    for (const page of parsed.pages) {
      for (const line of page.lines) {
        if (!line) continue;
        if (line.indexOf('בויח םוכס') !== -1) continue;   // totals
        if (line.indexOf('כ"הס') !== -1) continue;         // "Total"

        let m = REGULAR.exec(line);
        if (!m) m = INSTALLMENT.exec(line);
        if (!m) continue;

        const chargeRaw = m[1].replace(/,/g, '');
        const merchantRaw = m[3].trim();
        const dateStr = m[4];
        const amount = parseFloat(chargeRaw);
        if (!isFinite(amount) || amount <= 0) continue; // skip zero & refunds for parity

        const iso = parseDateDMY(dateStr);
        if (!iso) continue;
        const d = util.parseISODate(iso);
        const merchant = fixHebrew(merchantRaw);

        rows.push({
          date: iso,
          year: d.getFullYear(),
          month: util.monthName(d.getMonth() + 1),
          merchant,
          amount,
          category: null,
          card,
          currency: 'ILS',
          kind: 'expense',
          description: null,
          raw: { original_amount: m[2].replace(/,/g, '') },
        });
      }
    }

    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return {
      rows,
      meta: {
        bank: 'Bank Leumi',
        currency: 'ILS',
        account_identifier: card,
      },
    };
  }

  App.templates.register({
    id: 'leumi',
    bank: 'Bank Leumi',
    country: 'IL',
    currency: 'ILS',
    description: 'Bank Leumi credit card statement (Hebrew).',
    detect,
    parse,
  });
})();

/*
 * src/templates/registry.js — template registry for bank parsers.
 *
 * A template is a plain object:
 *   {
 *     id:            'leumi',            // short, unique
 *     bank:          'Bank Leumi',       // display name
 *     country:       'IL',
 *     currency:      'ILS',              // default currency for parsed rows
 *     description:   '...',
 *     detect(parsed) -> number (0..1)    // confidence this template fits
 *     parse(parsed)  -> { rows, meta }   // run the parser
 *   }
 *
 * `parsed` is the output of App.pdf.extractPages(file):
 *   { pages: [{ number, lines, text }], textAll, meta: { fileName } }
 *
 * Each `row` the parser returns should look like:
 *   {
 *     date:        'YYYY-MM-DD',
 *     year:        number,
 *     month:       'January' | ... | 'December',
 *     merchant:    string,              // the "name" / counterparty
 *     amount:      number,              // positive = expense, negative = refund/income
 *     category:    string | null,
 *     card:        string,              // last-4 or account identifier
 *     currency:    string,              // ISO 4217
 *     kind:        'expense'|'income'|'transfer',
 *     description: string | null,
 *     raw:         object (optional; parser-specific extras)
 *   }
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};

  const _list = [];

  function register(tpl) {
    if (!tpl || !tpl.id) throw new Error('Template must have an id');
    if (_list.find(t => t.id === tpl.id)) {
      console.warn('Template already registered: ' + tpl.id);
      return;
    }
    _list.push(tpl);
  }

  function all() { return _list.slice(); }
  function byId(id) { return _list.find(t => t.id === id) || null; }

  function detect(parsed) {
    let best = null;
    for (const t of _list) {
      let conf = 0;
      try { conf = t.detect ? Number(t.detect(parsed)) || 0 : 0; }
      catch (e) { console.warn('detect() failed for ' + t.id, e); conf = 0; }
      if (conf > 0 && (!best || conf > best.confidence)) {
        best = { template: t, confidence: conf };
      }
    }
    return best;
  }

  App.templates = { register, all, byId, detect };
})();

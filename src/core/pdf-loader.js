/*
 * src/core/pdf-loader.js — PDF.js integration.
 *
 * Loads PDF.js from cdnjs on demand and exposes a small wrapper:
 *   App.pdf.ready()                 -> Promise (pdf.js ready to use)
 *   App.pdf.extractPages(file)      -> Promise<{ pages: [{ lines:[] }], textAll, meta }>
 *
 * Lines are reconstructed from PDF.js text items by y-coordinate so each
 * "line" roughly matches what a user sees. This lets the bank-specific
 * parsers work with text the same way their Python counterparts
 * (pdfplumber.extract_text()) saw it.
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};

  const PDFJS_VERSION = '3.11.174';
  const PDFJS_URL        = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`;
  const PDFJS_WORKER_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;

  let _readyPromise = null;

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + url));
      document.head.appendChild(s);
    });
  }

  function ready() {
    if (_readyPromise) return _readyPromise;
    _readyPromise = loadScript(PDFJS_URL).then(() => {
      const lib = window['pdfjsLib'] || window['pdfjs-dist/build/pdf'];
      if (!lib) throw new Error('PDF.js loaded but global not found');
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      App._pdfjs = lib;
      return lib;
    }).catch((err) => {
      _readyPromise = null;
      throw err;
    });
    return _readyPromise;
  }

  /**
   * Group PDF.js text items into visual lines by rounded y-coordinate.
   * Items on the same y (within a small tolerance) are sorted by x and
   * joined with a single space.
   */
  function itemsToLines(items) {
    if (!items.length) return [];
    // Each item has .str and .transform (6-number matrix). transform[5] is y.
    const rows = [];
    // y-tolerance in PDF points. Slightly wider than 2 so that right-aligned
    // amount glyphs (which sometimes have a tiny y-offset vs. description
    // text in the same visual row) don't get split into two lines.
    const tol = 3;
    for (const it of items) {
      if (!it.str && it.str !== '') continue;
      const y = it.transform ? it.transform[5] : 0;
      const x = it.transform ? it.transform[4] : 0;
      let row = rows.find(r => Math.abs(r.y - y) <= tol);
      if (!row) { row = { y, items: [] }; rows.push(row); }
      row.items.push({ x, str: it.str });
    }
    // Higher y is typically upper on the page in PDF; sort descending to
    // produce top-to-bottom lines.
    rows.sort((a, b) => b.y - a.y);
    return rows.map((row) => {
      row.items.sort((a, b) => a.x - b.x);
      // Join items, but insert a space if there's a meaningful x-gap between
      // neighbouring items. PDF.js sometimes emits adjacent words without
      // their own whitespace items, which would otherwise glue "IBANDE03…".
      let out = '';
      for (let i = 0; i < row.items.length; i++) {
        const cur = row.items[i];
        if (i > 0) {
          const prev = row.items[i - 1];
          const needsSpace = cur.x - (prev.x + approxWidth(prev.str)) > 1;
          if (needsSpace && !/\s$/.test(out) && !/^\s/.test(cur.str)) out += ' ';
        }
        out += cur.str;
      }
      // Normalize: collapse whitespace, then NFC-normalize so regexes that
      // use precomposed characters (e.g. "PERÍODO") match decomposed text
      // produced by some PDF encoders.
      out = out.replace(/\s+/g, ' ').trim();
      try { out = out.normalize('NFC'); } catch (e) { /* some older envs */ }
      return out;
    }).filter(Boolean);
  }

  // Very rough width estimate (1 unit per char). Good enough to decide if a
  // space is needed between adjacent items — we only care about "is there a
  // big gap" not exact widths.
  function approxWidth(s) {
    if (!s) return 0;
    return s.length * 2.5;
  }

  function fileToArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(file);
    });
  }

  async function extractPages(file) {
    const lib = await ready();
    const buf = await fileToArrayBuffer(file);
    const doc = await lib.getDocument({ data: buf }).promise;
    const pages = [];
    const allTexts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const lines = itemsToLines(content.items);
      pages.push({ number: i, lines, text: lines.join('\n') });
      allTexts.push(lines.join('\n'));
    }
    let textAll = allTexts.join('\n');
    try { textAll = textAll.normalize('NFC'); } catch (e) { /* noop */ }
    return {
      pages,
      textAll,
      meta: { numPages: doc.numPages, fileName: file.name },
    };
  }

  App.pdf = { ready, extractPages };
})();

/*
 * src/processing/categorize.js — keyword-based category rules engine plus
 * a "learn from history" fallback.
 *
 * Rules and history are matched against the merchant's *display name*
 * (beautified / override'd by the merchants store), not the raw bank
 * string. That way a rule for "LinkedIn" catches "PAYPAL *LINKEDIN", and
 * history learned for "Edeka" fires on "COMPRA EDEKA SUPERMARKT BERLIN".
 *
 * Category precedence during import:
 *   1) a matching rule (longest keyword wins, case-insensitive substring)
 *   2) the most-common category of past transactions with the same
 *      normalized display name (kind-aware, so a refund's "Amazon" doesn't
 *      inherit the "Shopping" assigned to expenses)
 *   3) row.category already set by the template (bank-provided)
 *   4) "Uncategorized"
 *
 * The bank's category (when present) is also preserved verbatim on
 * `row.raw.bank_category` so the user can always see what the PDF said,
 * even when the system has overridden it with a rule or history match.
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};

  async function loadRules() {
    return App.storage.rules.all();
  }

  // Compile rules into a predicate chain. Supports two kinds:
  //  - substring (default): case-insensitive `keyword` substring match
  //  - regex (`is_regex: true`): `keyword` is a regex source, compiled with
  //    flags from `flags` (defaults to 'i'). Malformed patterns are skipped
  //    with a console warning so a single bad rule doesn't block the rest.
  // Ordering heuristic: manual rules first, then by keyword length desc, so
  // "STARBUCKS COFFEE" (specific) beats "COFFEE" (generic).
  function compile(rules) {
    return rules
      .slice()
      .sort((a, b) => {
        const aManual = (a.source || 'manual') === 'manual' ? 0 : 1;
        const bManual = (b.source || 'manual') === 'manual' ? 0 : 1;
        if (aManual !== bManual) return aManual - bManual;
        return (b.keyword || '').length - (a.keyword || '').length;
      })
      .map(r => {
        if (r.is_regex) {
          try {
            const re = new RegExp(r.keyword, r.flags || 'i');
            return { kind: 'regex', re, category: r.category };
          } catch (e) {
            console.warn('Skipping invalid category regex rule', r.keyword, e.message);
            return null;
          }
        }
        return { kind: 'substring', needle: (r.keyword || '').toLowerCase(), category: r.category };
      })
      .filter(Boolean);
  }

  function categorize(text, compiled) {
    if (!text) return null;
    const hay = String(text);
    const hayLower = hay.toLowerCase();
    for (const r of compiled) {
      if (r.kind === 'regex') { if (r.re.test(hay)) return r.category; }
      else if (hayLower.includes(r.needle)) return r.category;
    }
    return null;
  }

  // Normalize merchant strings so 'AMZN Mktp' and 'amzn mktp' collapse.
  function normMerchant(s) {
    return (s || '').toString().toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\sáéíóúâêôãõçäöüñ\u0590-\u05FF]/g, '')
      .trim();
  }

  // Resolve a row's display name. Prefers a stored override from the
  // merchants store, then the beautifier, then the raw merchant string.
  // Never throws — on failure it falls back to the raw merchant.
  function resolveDisplay(row, resolver) {
    const raw = (row && row.merchant) ? String(row.merchant) : '';
    if (resolver) {
      try { return resolver(raw) || raw; } catch (e) { /* fall through */ }
    }
    const N = window.App && window.App.processing && window.App.processing.normalize;
    if (N && N.beautifyMerchant) {
      try { return N.beautifyMerchant(raw) || raw; } catch (e) { /* fall through */ }
    }
    return raw;
  }

  // Build a { "<kind>|<norm display>": "<best category>" } map from history.
  // "Uncategorized" contributes but never beats a real category.
  function buildHistoryIndex(existing, resolver) {
    const counts = new Map(); // key -> Map(category -> count)
    for (const t of existing || []) {
      const cat = t && t.category;
      if (!cat) continue;
      const display = resolveDisplay(t, resolver);
      const merch = normMerchant(display);
      if (!merch) continue;
      const key = (t.kind || 'expense') + '|' + merch;
      const bucket = counts.get(key) || new Map();
      bucket.set(cat, (bucket.get(cat) || 0) + 1);
      counts.set(key, bucket);
    }
    const best = new Map();
    counts.forEach((bucket, key) => {
      let winner = null, winnerCount = -1;
      bucket.forEach((n, cat) => {
        const isUnc = cat === 'Uncategorized';
        // Prefer any real category over Uncategorized, then by count.
        if (
          winner === null ||
          (winner === 'Uncategorized' && !isUnc) ||
          (!isUnc && cat !== 'Uncategorized' && n > winnerCount)
        ) {
          winner = cat; winnerCount = n;
        }
      });
      if (winner) best.set(key, winner);
    });
    return best;
  }

  function categorizeFromHistory(row, historyIndex, resolver) {
    if (!row || !historyIndex) return null;
    const display = resolveDisplay(row, resolver);
    const merch = normMerchant(display);
    if (!merch) return null;
    const key = (row.kind || 'expense') + '|' + merch;
    return historyIndex.get(key) || null;
  }

  // Pull the merchants store and return a resolver function. Callers can
  // pass their own to avoid the extra read; otherwise we build one.
  async function loadResolver() {
    const N = window.App && window.App.processing && window.App.processing.normalize;
    if (!N || !N.buildMerchantResolver) return null;
    let rows = [];
    try { rows = await App.storage.merchants.all(); } catch (e) { /* merchants store may not exist yet */ }
    return N.buildMerchantResolver(rows || []);
  }

  async function categorizeRow(row, resolver) {
    const rules = compile(await loadRules());
    const r = resolver || await loadResolver();
    const display = resolveDisplay(row, r);
    const hit = categorize(display + ' ' + (row.description || ''), rules);
    if (hit) row.category = hit;
    else if (!row.category) row.category = 'Uncategorized';
    return row;
  }

  // Apply the rules→history→bank→Uncategorized precedence across a set.
  // `existingTransactions` is optional; omit to skip history matching.
  // `resolver` is optional; we load one from the merchants store if absent
  // so rule and history matching line up with the display name.
  //
  // Whatever the template put into `row.category` (the bank-provided value)
  // is preserved on `row.raw.bank_category` before we override it, so the
  // PDF's original categorisation stays accessible even when the system
  // chooses something different.
  //
  // Rows with `locked: true` are skipped entirely — they're rows the user
  // has explicitly pinned, and the contract is that rules/history won't
  // ever override them. (The lock can be cleared in Manage > Transactions
  // to opt back into rule-based categorisation.)
  async function categorizeRows(rows, existingTransactions, resolver) {
    const rules = compile(await loadRules());
    const r = resolver || await loadResolver();
    const history = existingTransactions ? buildHistoryIndex(existingTransactions, r) : null;
    // Pull the translator once; if the module isn't loaded (older bundles
    // or unit tests) we fall through with a no-op so categorisation still
    // works against whatever the template / CSV produced.
    const T = (App.processing && App.processing.translate) || null;
    const xlate = T ? T.translateCategory : (s) => s;
    rows.forEach(row => {
      if (row && row.locked) return;
      // Snapshot the bank-provided category before we touch it, so the raw
      // value is always recoverable. We only set it when not already set —
      // some templates (like N26) populate raw.bank_category themselves.
      // The snapshot is always the *raw* (potentially non-English) value,
      // so the user can audit what the bank originally said.
      const bankCatRaw = (row.category && row.category !== 'Uncategorized') ? row.category : null;
      if (bankCatRaw) {
        row.raw = row.raw || {};
        if (!row.raw.bank_category) row.raw.bank_category = bankCatRaw;
      }
      // Translated fallback — what we'll store on the row if no rule /
      // history hit. Existing English categories pass through unchanged.
      const bankCat = bankCatRaw ? xlate(bankCatRaw) : null;
      const display = resolveDisplay(row, r);
      const ruleHit = categorize(display + ' ' + (row.description || ''), rules);
      if (ruleHit) { row.category = ruleHit; return; }
      const histHit = history ? categorizeFromHistory(row, history, r) : null;
      if (histHit) { row.category = histHit; return; }
      if (bankCat) { row.category = bankCat; return; }
      if (!row.category || row.category === 'Uncategorized') row.category = 'Uncategorized';
    });
    return rows;
  }

  async function addRule(keyword, category) {
    if (!keyword || !category) throw new Error('keyword and category are required');
    const existing = await App.storage.rules.all();
    const match = existing.find(r => r.keyword.toLowerCase() === keyword.toLowerCase());
    const now = new Date().toISOString();
    if (match) {
      match.category = category;
      match.source = 'manual';
      match.updated_at = now;
      return App.storage.rules.put(match);
    }
    return App.storage.rules.put({
      keyword, category,
      source: 'manual',
      updated_at: now,
    });
  }

  // Auto-learn a rule from a manual category edit. The keyword is the
  // merchant's display name (that's what categorizeRows matches against),
  // and we tag the rule with `source: 'auto'` so the Manage > Categorisation
  // tab can show a "learned" badge and the user can audit/revise them.
  //
  // Behaviour:
  //   - No-op when category is falsy or "Uncategorized" — we don't want to
  //     pollute the rules table when the user *unset* a category.
  //   - No-op when the keyword is falsy.
  //   - An existing *manual* rule is preserved as-is (manual wins; we only
  //     refresh the timestamp so audits show the latest confirmation).
  //   - An existing *auto* rule has its category overwritten and gets a new
  //     timestamp so "last learned at" stays current.
  async function learnCategoryRule(keyword, category) {
    const kw = (keyword || '').trim();
    const cat = (category || '').trim();
    if (!kw || !cat || cat === 'Uncategorized') return null;
    const existing = await App.storage.rules.all();
    const match = existing.find(r =>
      (r.keyword || '').toLowerCase() === kw.toLowerCase());
    const now = new Date().toISOString();
    if (match) {
      if (match.source === 'manual') {
        // Don't overwrite a manual rule on auto-learn. Just refresh the
        // timestamp so we know it's still live.
        match.updated_at = now;
        return App.storage.rules.put(match);
      }
      match.category = cat;
      match.source = 'auto';
      match.updated_at = now;
      return App.storage.rules.put(match);
    }
    return App.storage.rules.put({
      keyword: kw, category: cat,
      source: 'auto',
      updated_at: now,
    });
  }

  // Re-run categorisation against ALL stored transactions. Returns the number
  // of rows whose category changed. Used by the "Apply rules to all" button
  // in the Manage / Categorisation tab. Locked rows are skipped — the lock
  // is the user's promise that rules will leave them alone.
  async function applyRulesToAll() {
    const rules = compile(await loadRules());
    const resolver = await loadResolver();
    const all = await App.storage.transactions.all();
    let changed = 0;
    let skippedLocked = 0;
    const toSave = [];
    for (const row of all) {
      if (row && row.locked) { skippedLocked++; continue; }
      const display = resolveDisplay(row, resolver);
      const hit = categorize(display + ' ' + (row.description || ''), rules);
      // If a rule matches, set the category; otherwise leave whatever was there.
      if (hit && row.category !== hit) {
        row.category = hit;
        toSave.push(row);
        changed++;
      }
    }
    if (toSave.length) {
      // Sequential puts — putMany assigns new ids, update keeps them.
      for (const row of toSave) await App.storage.transactions.update(row);
    }
    return { changed, total: all.length, skippedLocked };
  }

  App.processing = App.processing || {};
  App.processing.categorize = {
    loadRules, categorize, categorizeRow, categorizeRows, addRule,
    buildHistoryIndex, categorizeFromHistory, applyRulesToAll,
    learnCategoryRule,
  };
})();

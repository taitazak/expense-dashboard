/*
 * src/processing/transfer.js — transfer-pair matcher (lightweight).
 *
 * This is an intentionally conservative first pass. Given the current
 * transaction set, it returns candidate pairs where:
 *   - both sides touch accounts marked `is_own` (so we're confident
 *     it's between the user's own accounts),
 *   - amounts match to 2 decimals (same currency only, for now),
 *   - dates are within ±3 days of each other,
 *   - signs are opposite (one outgoing, one incoming).
 *
 * Cross-currency matching is deferred: it needs FX tolerance bands
 * that are worth tuning against real data rather than guessing.
 *
 * Returned pair shape:
 *   { out: transaction, in: transaction, confidence: 0..1 }
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};

  function findPairs(transactions, ownAccountIds) {
    const own = new Set(ownAccountIds || []);
    const outs = [];
    const ins  = [];
    for (const t of transactions) {
      if (!own.has(t.account_id)) continue;
      if (t.kind === 'transfer' && t.transfer_group_id) continue; // already paired
      const amt = Number(t.amount);
      if (isNaN(amt) || amt === 0) continue;
      if (amt > 0) outs.push(t); else ins.push(t);
    }
    const pairs = [];
    const usedIn = new Set();
    for (const o of outs) {
      let best = null;
      for (const i of ins) {
        if (usedIn.has(i.id)) continue;
        if (o.account_id === i.account_id) continue;
        if ((o.currency || 'EUR') !== (i.currency || 'EUR')) continue;
        if (Math.abs(o.amount) !== Math.abs(i.amount)) continue;
        const dDiff = Math.abs(
          (App.util.parseISODate(o.date) - App.util.parseISODate(i.date)) / 86400000
        );
        if (dDiff > 3) continue;
        const conf = 0.6 + Math.max(0, 3 - dDiff) * 0.1;
        if (!best || conf > best.confidence) best = { out: o, in: i, confidence: conf };
      }
      if (best) {
        pairs.push(best);
        usedIn.add(best.in.id);
      }
    }
    return pairs;
  }

  App.processing = App.processing || {};
  App.processing.transfer = { findPairs };
})();

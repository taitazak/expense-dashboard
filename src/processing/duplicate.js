/*
 * src/processing/duplicate.js — duplicate detection for incoming imports.
 *
 * Strategy:
 *   - "Hard duplicate": same date, same signed amount, same account, and
 *     merchant-string matches after light normalization.
 *   - "Soft duplicate": same amount + same account within a ±1-day window,
 *     with merchant prefix/substring overlap. These are surfaced as warnings
 *     for the user to confirm.
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};

  function norm(s) {
    return (s || '').toString().toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\sáéíóúâêôãõçäöüñ\u0590-\u05FF]/g, '')
      .trim();
  }

  function dateDiffDays(a, b) {
    const da = App.util.parseISODate(a);
    const db = App.util.parseISODate(b);
    if (!da || !db) return Infinity;
    return Math.abs(Math.round((da - db) / 86400000));
  }

  function indexExisting(existing) {
    // Map by `account_id|date` for cheap lookup.
    const byKey = new Map();
    for (const r of existing) {
      const key = (r.account_id || '-') + '|' + (r.date || '');
      (byKey.get(key) || byKey.set(key, []).get(key)).push(r);
    }
    return byKey;
  }

  function findDuplicates(incoming, existing) {
    const warnings = [];
    const byKey = indexExisting(existing);
    incoming.forEach((row, i) => {
      const existingCandidates = [];
      // ±1 day window
      const d = App.util.parseISODate(row.date);
      if (!d) return;
      for (let off = -1; off <= 1; off++) {
        const d2 = new Date(d);
        d2.setDate(d.getDate() + off);
        const iso = d2.toISOString().slice(0, 10);
        const key = (row.account_id || '-') + '|' + iso;
        const bucket = byKey.get(key) || [];
        for (const e of bucket) existingCandidates.push(e);
      }
      if (!existingCandidates.length) return;

      const rowMerch = norm(row.merchant);
      for (const e of existingCandidates) {
        const sameAmount = Number(e.amount).toFixed(2) === Number(row.amount).toFixed(2);
        if (!sameAmount) continue;
        const eMerch = norm(e.merchant);
        const hard = e.date === row.date && (
          eMerch === rowMerch ||
          (eMerch.length > 4 && rowMerch.length > 4 &&
            (eMerch.includes(rowMerch) || rowMerch.includes(eMerch)))
        );
        const soft = !hard && dateDiffDays(e.date, row.date) <= 1 && (
          eMerch === rowMerch ||
          (eMerch.length > 3 && rowMerch.length > 3 &&
            (eMerch.slice(0, 6) === rowMerch.slice(0, 6) ||
             eMerch.includes(rowMerch) || rowMerch.includes(eMerch)))
        );
        if (hard || soft) {
          warnings.push({
            index: i,
            row,
            existing: e,
            severity: hard ? 'hard' : 'soft',
          });
          break; // one warning per incoming row is enough
        }
      }
    });
    return warnings;
  }

  // Group existing transactions into duplicate clusters so the user can
  // review and delete one side. Two rows are duplicates when they share
  // account, date, signed amount, and a normalized merchant that matches
  // (equal, or one contains the other with both >4 chars).
  //
  // Returns: [{ severity: 'hard'|'soft', rows: [t, t, ...] }, ...]
  // Each transaction appears in at most one group.
  function findDuplicatesWithin(transactions) {
    const rows = (transactions || []).filter(t => t && t.id != null);
    // Bucket by account|date|amount to keep candidate comparison cheap.
    const buckets = new Map();
    rows.forEach(r => {
      const key = (r.account_id || '-') + '|' + (r.date || '') + '|' +
                  Number(r.amount || 0).toFixed(2) + '|' + (r.kind || '');
      (buckets.get(key) || buckets.set(key, []).get(key)).push(r);
    });

    const seen = new Set();
    const groups = [];
    // Hard duplicates: identical bucket with merchant overlap.
    buckets.forEach(bucket => {
      if (bucket.length < 2) return;
      // Union-find within the bucket by normalized merchant match.
      const clusters = [];
      bucket.forEach(r => {
        const rM = norm(r.merchant);
        let home = null;
        for (const c of clusters) {
          if (c.some(x => {
            const xM = norm(x.merchant);
            return xM === rM ||
              (rM.length > 4 && xM.length > 4 && (xM.includes(rM) || rM.includes(xM)));
          })) { home = c; break; }
        }
        if (home) home.push(r);
        else clusters.push([r]);
      });
      clusters.forEach(c => {
        if (c.length < 2) return;
        c.forEach(r => seen.add(r.id));
        groups.push({ severity: 'hard', rows: c });
      });
    });

    // Soft duplicates: ±1 day, same amount, merchant prefix/substring
    // overlap. Only consider rows not already in a hard group.
    const byDateKey = new Map();
    rows.forEach(r => {
      if (seen.has(r.id)) return;
      const key = (r.account_id || '-') + '|' + Number(r.amount || 0).toFixed(2) + '|' + (r.kind || '');
      (byDateKey.get(key) || byDateKey.set(key, []).get(key)).push(r);
    });
    byDateKey.forEach(list => {
      if (list.length < 2) return;
      // Sort by date so we scan a sliding window.
      list.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      for (let i = 0; i < list.length; i++) {
        if (seen.has(list[i].id)) continue;
        const group = [list[i]];
        for (let j = i + 1; j < list.length; j++) {
          if (seen.has(list[j].id)) continue;
          if (dateDiffDays(list[i].date, list[j].date) > 1) break;
          const a = norm(list[i].merchant), b = norm(list[j].merchant);
          const merchMatch = a === b ||
            (a.length > 3 && b.length > 3 &&
              (a.slice(0, 6) === b.slice(0, 6) || a.includes(b) || b.includes(a)));
          if (merchMatch) group.push(list[j]);
        }
        if (group.length >= 2) {
          group.forEach(r => seen.add(r.id));
          groups.push({ severity: 'soft', rows: group });
        }
      }
    });
    return groups;
  }

  App.processing = App.processing || {};
  App.processing.duplicate = { findDuplicates, findDuplicatesWithin };
})();

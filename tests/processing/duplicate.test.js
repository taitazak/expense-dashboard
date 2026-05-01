'use strict';
/* tests/processing/duplicate.test.js — duplicate detection. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProcessing } = require('../helpers/load.js');

function D() {
  const App = loadProcessing();
  return App.processing.duplicate;
}

const tx = (over) => Object.assign({
  id: null, account_id: 1, date: '2026-04-01', amount: -10.00,
  merchant: 'Lidl', kind: 'expense',
}, over);

// ----- findDuplicates(incoming, existing) -------------------------------

test('findDuplicates: hard match (same date + amount + same merchant)', () => {
  const d = D();
  const existing = [tx({ id: 1, merchant: 'Lidl' })];
  const incoming = [tx({ merchant: 'Lidl' })];
  const w = d.findDuplicates(incoming, existing);
  assert.equal(w.length, 1);
  assert.equal(w[0].severity, 'hard');
  assert.equal(w[0].existing.id, 1);
  assert.equal(w[0].index, 0);
});

test('findDuplicates: substring match (Lidl Berlin vs Lidl) → hard', () => {
  const d = D();
  const existing = [tx({ id: 1, merchant: 'Lidl Berlin Mitte' })];
  const incoming = [tx({ merchant: 'Lidl Berlin' })];
  const w = d.findDuplicates(incoming, existing);
  assert.equal(w.length, 1);
  assert.equal(w[0].severity, 'hard');
});

test('findDuplicates: ±1 day window with same merchant → soft', () => {
  const d = D();
  const existing = [tx({ id: 1, date: '2026-04-01', merchant: 'Lidl' })];
  const incoming = [tx({ date: '2026-04-02', merchant: 'Lidl' })];
  const w = d.findDuplicates(incoming, existing);
  assert.equal(w.length, 1);
  assert.equal(w[0].severity, 'soft');
});

test('findDuplicates: different account_id → no match', () => {
  const d = D();
  const existing = [tx({ id: 1, account_id: 1 })];
  const incoming = [tx({ account_id: 2 })];   // different account
  const w = d.findDuplicates(incoming, existing);
  assert.equal(w.length, 0);
});

test('findDuplicates: different amount → no match', () => {
  const d = D();
  const existing = [tx({ id: 1, amount: -10 })];
  const incoming = [tx({ amount: -11 })];
  const w = d.findDuplicates(incoming, existing);
  assert.equal(w.length, 0);
});

test('findDuplicates: 2+ days apart → no match (window is ±1)', () => {
  const d = D();
  const existing = [tx({ id: 1, date: '2026-04-01' })];
  const incoming = [tx({ date: '2026-04-04' })];
  const w = d.findDuplicates(incoming, existing);
  assert.equal(w.length, 0);
});

test('findDuplicates: amount tolerance is to-the-cent', () => {
  const d = D();
  // 10.005 rounds to 10.01 — different from 10.00.
  const existing = [tx({ id: 1, amount: -10.00 })];
  const incoming = [tx({ amount: -10.01 })];
  assert.equal(d.findDuplicates(incoming, existing).length, 0);
  // Floating-point neighbour 10.0000001 rounds same → hit.
  assert.equal(d.findDuplicates([tx({ amount: -10.0000001 })], existing).length, 1);
});

test('findDuplicates: empty arrays are safe', () => {
  const d = D();
  assert.deepEqual(d.findDuplicates([], []), []);
  assert.deepEqual(d.findDuplicates([tx()], []), []);
  assert.deepEqual(d.findDuplicates([], [tx({id:1})]), []);
});

test('findDuplicates: row without date is skipped silently', () => {
  const d = D();
  const w = d.findDuplicates([tx({ date: '' })], [tx({ id: 1 })]);
  assert.equal(w.length, 0);
});

// ----- findDuplicatesWithin (storage-side dedup) ------------------------

test('findDuplicatesWithin: 2 identical rows → one hard group', () => {
  const d = D();
  const groups = d.findDuplicatesWithin([
    tx({ id: 1, date: '2026-04-01', amount: -10, merchant: 'Lidl' }),
    tx({ id: 2, date: '2026-04-01', amount: -10, merchant: 'Lidl' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].severity, 'hard');
  assert.equal(groups[0].rows.length, 2);
});

test('findDuplicatesWithin: 3 identical rows cluster as one group', () => {
  const d = D();
  const groups = d.findDuplicatesWithin([
    tx({ id: 1, merchant: 'Lidl Mitte 234' }),
    tx({ id: 2, merchant: 'Lidl Mitte 234' }),
    tx({ id: 3, merchant: 'Lidl Mitte 234' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rows.length, 3);
});

test('findDuplicatesWithin: rows without an id are skipped', () => {
  const d = D();
  const groups = d.findDuplicatesWithin([
    tx({ id: null }), tx({ id: null }),  // both unsaved
  ]);
  assert.equal(groups.length, 0);
});

test('findDuplicatesWithin: rows on different accounts do NOT cluster', () => {
  const d = D();
  const groups = d.findDuplicatesWithin([
    tx({ id: 1, account_id: 1, merchant: 'Lidl' }),
    tx({ id: 2, account_id: 2, merchant: 'Lidl' }),
  ]);
  assert.equal(groups.length, 0);
});

test('findDuplicatesWithin: each row appears in at most one group', () => {
  const d = D();
  const groups = d.findDuplicatesWithin([
    tx({ id: 1 }), tx({ id: 2 }), tx({ id: 3 }),
  ]);
  // All three identical → one group of 3, NOT three pair-groups.
  assert.equal(groups.length, 1);
  const ids = new Set(groups[0].rows.map(r => r.id));
  assert.equal(ids.size, 3);
});

test('findDuplicatesWithin: empty / null safe', () => {
  const d = D();
  assert.deepEqual(d.findDuplicatesWithin([]),    []);
  assert.deepEqual(d.findDuplicatesWithin(null),  []);
  assert.deepEqual(d.findDuplicatesWithin(undefined), []);
});

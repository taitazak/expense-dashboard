'use strict';
/* tests/processing/transfer.test.js — transfer-pair heuristic. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProcessing } = require('../helpers/load.js');

function T() {
  const App = loadProcessing();
  return App.processing.transfer;
}

const tx = (over) => Object.assign({
  id: 0, account_id: 1, date: '2026-04-01', amount: -100.00,
  currency: 'EUR', kind: 'expense', merchant: 'Self transfer',
}, over);

test('findPairs: clean opposite-sign pair on different own accounts', () => {
  const t = T();
  const pairs = t.findPairs([
    tx({ id: 1, account_id: 1, amount:  100.00 }),  // outflow from acct 1
    tx({ id: 2, account_id: 2, amount: -100.00 }),  // inflow to acct 2 (signs flipped here)
  ], [1, 2]);
  // Note: outs are amt > 0 in this code (positive = outgoing); ins are amt < 0.
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].out.id, 1);
  assert.equal(pairs[0].in.id, 2);
  assert.ok(pairs[0].confidence >= 0.6);
});

test('findPairs: same-account pair is skipped', () => {
  const t = T();
  const pairs = t.findPairs([
    tx({ id: 1, account_id: 1, amount:  100.00 }),
    tx({ id: 2, account_id: 1, amount: -100.00 }),
  ], [1]);
  assert.equal(pairs.length, 0);
});

test('findPairs: cross-currency is skipped (FX deferred)', () => {
  const t = T();
  const pairs = t.findPairs([
    tx({ id: 1, account_id: 1, amount:  100.00, currency: 'EUR' }),
    tx({ id: 2, account_id: 2, amount: -120.00, currency: 'USD' }),
  ], [1, 2]);
  assert.equal(pairs.length, 0);
});

test('findPairs: amount mismatch breaks the pair', () => {
  const t = T();
  const pairs = t.findPairs([
    tx({ id: 1, account_id: 1, amount:  100.00 }),
    tx({ id: 2, account_id: 2, amount: -101.00 }),
  ], [1, 2]);
  assert.equal(pairs.length, 0);
});

test('findPairs: ±3 day window', () => {
  const t = T();
  // 2 days apart → pair
  let pairs = t.findPairs([
    tx({ id: 1, account_id: 1, amount: 100, date: '2026-04-01' }),
    tx({ id: 2, account_id: 2, amount: -100, date: '2026-04-03' }),
  ], [1, 2]);
  assert.equal(pairs.length, 1);
  // 5 days apart → no pair
  pairs = t.findPairs([
    tx({ id: 1, account_id: 1, amount: 100, date: '2026-04-01' }),
    tx({ id: 2, account_id: 2, amount: -100, date: '2026-04-06' }),
  ], [1, 2]);
  assert.equal(pairs.length, 0);
});

test('findPairs: confidence highest for same-day match', () => {
  const t = T();
  const pairs = t.findPairs([
    tx({ id: 1, account_id: 1, amount: 100, date: '2026-04-01' }),
    tx({ id: 2, account_id: 2, amount: -100, date: '2026-04-01' }),
  ], [1, 2]);
  assert.equal(pairs.length, 1);
  // Same-day → bonus is full 0.3 added to base 0.6 = 0.9.
  assert.ok(pairs[0].confidence >= 0.85);
});

test('findPairs: each in-side row used only once', () => {
  const t = T();
  // Two outs both want the same in.
  const pairs = t.findPairs([
    tx({ id: 1, account_id: 1, amount: 100 }),
    tx({ id: 3, account_id: 1, amount: 100 }),
    tx({ id: 2, account_id: 2, amount: -100 }),
  ], [1, 2]);
  assert.equal(pairs.length, 1);
  // Whichever pair won, the other out doesn't get the same in.
  assert.equal(pairs[0].in.id, 2);
});

test('findPairs: rows on accounts not in ownAccountIds are skipped', () => {
  const t = T();
  const pairs = t.findPairs([
    tx({ id: 1, account_id: 1, amount: 100 }),
    tx({ id: 2, account_id: 2, amount: -100 }),
  ], [1]);   // only account 1 is "own"
  assert.equal(pairs.length, 0);
});

test('findPairs: empty / null safe', () => {
  const t = T();
  assert.deepEqual(t.findPairs([], [1, 2]), []);
  assert.deepEqual(t.findPairs([tx()], null), []);
});

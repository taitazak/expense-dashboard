'use strict';
/* tests/processing/dates.test.js — future-date clamp + isFutureDate.
 * fixFutureDatesInStore + runMigrationIfNeeded touch IndexedDB and live
 * in tests/processing/storage.test.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProcessing } = require('../helpers/load.js');

function D() {
  const App = loadProcessing();
  return App.processing.dates;
}

const today = new Date();
const isoToday = today.toISOString().slice(0, 10);
const next3y = new Date(today.getFullYear() + 3, today.getMonth(), today.getDate())
  .toISOString().slice(0, 10);
const next1y = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate())
  .toISOString().slice(0, 10);
const past1y = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate())
  .toISOString().slice(0, 10);

test('isFutureDate: today is NOT in the future', () => {
  const d = D();
  assert.equal(d.isFutureDate(isoToday), false);
});

test('isFutureDate: 1 year ahead IS in the future', () => {
  const d = D();
  assert.equal(d.isFutureDate(next1y), true);
});

test('isFutureDate: 1 year ago is NOT in the future', () => {
  const d = D();
  assert.equal(d.isFutureDate(past1y), false);
});

test('isFutureDate: malformed string → false (no throw)', () => {
  const d = D();
  assert.equal(d.isFutureDate(''), false);
  assert.equal(d.isFutureDate('not a date'), false);
  assert.equal(d.isFutureDate(null), false);
});

test('clampFutureDate: 1 year ahead → 1 year later than past1y (today)', () => {
  const d = D();
  // next1y → today ≈ next1y minus exactly 1y
  const out = d.clampFutureDate(next1y);
  // The output should be a valid ISO string in the past or today.
  const parsedOut = new Date(out + 'T00:00:00');
  assert.ok(parsedOut <= new Date(isoToday + 'T23:59:59'),
    `expected ${out} to be on or before today ${isoToday}`);
});

test('clampFutureDate: 3 years ahead clamps to past', () => {
  const d = D();
  const out = d.clampFutureDate(next3y);
  const parsedOut = new Date(out + 'T00:00:00');
  assert.ok(parsedOut <= new Date(isoToday + 'T23:59:59'));
});

test('clampFutureDate: past dates are no-op', () => {
  const d = D();
  assert.equal(d.clampFutureDate(past1y), past1y);
  assert.equal(d.clampFutureDate('2020-01-15'), '2020-01-15');
});

test('clampFutureDate: today is a no-op', () => {
  const d = D();
  assert.equal(d.clampFutureDate(isoToday), isoToday);
});

test('clampFutureDate: malformed → original passed through', () => {
  const d = D();
  assert.equal(d.clampFutureDate(''),       '');
  assert.equal(d.clampFutureDate('xxx'),    'xxx');
});

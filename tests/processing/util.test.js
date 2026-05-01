'use strict';
/* tests/processing/util.test.js — pure-function coverage of src/core/util.js.
 * Skips DOM-touching helpers (el, modal, toast, downloadJSON) — those are
 * exercised indirectly by the integration/template suites where applicable. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadUtil } = require('../helpers/load.js');

test('escapeHtml: handles every HTML metachar', () => {
  const u = loadUtil();
  assert.equal(u.escapeHtml('<a href="x">&\'</a>'),
    '&lt;a href=&quot;x&quot;&gt;&amp;&#039;&lt;/a&gt;');
});

test('escapeHtml: null/undefined → empty string (no throw)', () => {
  const u = loadUtil();
  assert.equal(u.escapeHtml(null), '');
  assert.equal(u.escapeHtml(undefined), '');
  assert.equal(u.escapeHtml(0), '0');
});

test('monthName: 1..12 → English names; 0/13 → Unknown', () => {
  const u = loadUtil();
  assert.equal(u.monthName(1),  'January');
  assert.equal(u.monthName(4),  'April');
  assert.equal(u.monthName(12), 'December');
  assert.equal(u.monthName(0),  'Unknown');
  assert.equal(u.monthName(13), 'Unknown');
});

test('monthIndex: round-trips with monthName', () => {
  const u = loadUtil();
  for (let m = 1; m <= 12; m++) {
    assert.equal(u.monthIndex(u.monthName(m)), m - 1);
  }
});

test('parseISODate: returns Date at local midnight; null for malformed', () => {
  const u = loadUtil();
  const d = u.parseISODate('2026-04-30');
  assert.ok(d instanceof Date);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 3);   // 0-based
  assert.equal(d.getDate(), 30);
  assert.equal(u.parseISODate(''), null);
  assert.equal(u.parseISODate('not a date'), null);
});

test('parseISODate: extra suffix is tolerated (ISO timestamps)', () => {
  const u = loadUtil();
  // Only the YYYY-MM-DD prefix is consumed.
  const d = u.parseISODate('2026-04-30T12:34:56Z');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getDate(), 30);
});

test('formatCurrency: EUR formatting, default fallback to EUR', () => {
  const u = loadUtil();
  // Locale formatting varies — assert that the symbol and amount are
  // present rather than an exact string.
  const eur = u.formatCurrency(1234.5, 'EUR');
  assert.match(eur, /1.234[.,]50/);   // 1,234.50 (en-US) or 1.234,50 (de)
  assert.match(eur, /€/);
  // Default currency.
  const fb = u.formatCurrency(10);
  assert.match(fb, /€/);
});

test('formatCurrency: cache reuses the same Intl.NumberFormat per currency', () => {
  const u = loadUtil();
  // Two calls with the same currency should not throw, should produce
  // identical output for identical inputs.
  assert.equal(u.formatCurrency(7.5, 'USD'), u.formatCurrency(7.5, 'USD'));
});

test('formatNumber: 2-decimal default with thousands separator', () => {
  const u = loadUtil();
  // Locale-tolerant: just check both digits and a separator.
  assert.match(u.formatNumber(1234.5),  /1.234[.,]50/);
  assert.match(u.formatNumber(0),       /0[.,]00/);
});

test('uuid: returns a non-empty unique string with a separator', () => {
  const u = loadUtil();
  const a = u.uuid();
  const b = u.uuid();
  assert.notEqual(a, b);
  assert.ok(a.length > 5);
  // Either UUIDv4 (hyphens) or the fallback (single dash).
  assert.match(a, /[-]/);
});

test('on/off/emit: subscribe + unsubscribe is symmetric', () => {
  const u = loadUtil();
  let count = 0;
  const inc = () => { count++; };
  u.on('themechange', inc);
  u.emit('themechange', { theme: 'dark' });
  u.emit('themechange', { theme: 'light' });
  assert.equal(count, 2);
  u.off('themechange', inc);
  u.emit('themechange', { theme: 'dark' });
  assert.equal(count, 2);   // off worked
});

test('on/emit: a listener that throws does not break siblings', () => {
  const u = loadUtil();
  let saw = 0;
  // The emit() impl swallows errors and console.errors them. Suppress
  // the noise so the test output stays clean.
  const origErr = console.error;
  console.error = () => {};
  try {
    u.on('boom', () => { throw new Error('first listener angry'); });
    u.on('boom', () => { saw++; });
    u.emit('boom');
    assert.equal(saw, 1);
  } finally {
    console.error = origErr;
  }
});

'use strict';
/* tests/integration/csv-pipeline.test.js
 *
 * End-to-end test of the CSV import path:
 *   readFileAsText → detectDelimiter → parseCsv → suggestMapping →
 *   applyMapping (with translate.js translating Portuguese categories)
 *
 * This is the *whole* pipeline a user hits when they drop the bundled
 * activo-statement.csv into the Import tab. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadProcessing, ROOT } = require('../helpers/load.js');

const CSV = path.join(ROOT, 'samples', 'activo-statement.csv');

test('Activo CSV parses, maps, and translates to canonical English rows', () => {
  const App = loadProcessing();
  const C   = App.processing.csv;

  const text  = fs.readFileSync(CSV, 'utf8');
  const delim = C.detectDelimiter(text);
  assert.equal(delim, ';', 'Activo uses semicolon delimiter');

  const rows  = C.parseCsv(text, delim);
  assert.equal(rows.length, 25,         'header + 24 monthly txs');

  const map = C.suggestMapping(rows);
  assert.equal(map.has_header,         true);
  assert.equal(typeof map.columns.date,     'number');
  assert.equal(typeof map.columns.amount,   'number');
  assert.equal(typeof map.columns.merchant, 'number');
  assert.equal(typeof map.columns.category, 'number');

  // Apply with Portuguese conventions.
  map.date_format    = 'dmy';
  map.amount_decimal = ',';
  const result = C.applyMapping(rows, map);
  assert.equal(result.errors.length, 0, 'no mapping errors');
  assert.equal(result.rows.length,   24, '24 canonical rows');

  // Date span: every month from Mar 2024 → Feb 2026 represented.
  const months = new Set(result.rows.map(r => r.date.slice(0, 7)));
  assert.equal(months.size, 24);
  const sorted = Array.from(months).sort();
  assert.equal(sorted[0],  '2024-03');
  assert.equal(sorted[23], '2026-02');

  // Translation: every Portuguese category should resolve to English.
  // The set of translated categories should NOT contain the source
  // strings, and should contain the canonical English names.
  const cats = new Set(result.rows.map(r => r.category));
  assert.ok( cats.has('Groceries'),            'Alimentação → Groceries');
  assert.ok( cats.has('Restaurants & Cafés'),  'Restauração → Restaurants & Cafés');
  assert.ok( cats.has('Transport'),            'Transportes → Transport');
  assert.ok( cats.has('Salary'),               'Salário → Salary');
  assert.ok( cats.has('Travel'),               'Viagens → Travel');
  assert.ok( cats.has('Healthcare'),           'Saúde → Healthcare');
  assert.ok( cats.has('Fees'),                 'Comissões → Fees');
  assert.ok(!cats.has('Alimentação'),  'no Portuguese left in translated set');
  assert.ok(!cats.has('Restauração'),  'no Portuguese left in translated set');

  // Raw value preserved on the row's audit slot.
  const raws = result.rows.map(r => r.raw && r.raw.csv_category_raw);
  assert.ok(raws.includes('Alimentação'), 'raw csv_category_raw kept for audit');
});

test('CSV pipeline: signed-amount convention sets kind correctly', () => {
  const App = loadProcessing();
  const C   = App.processing.csv;
  const text  = fs.readFileSync(CSV, 'utf8');
  const rows  = C.parseCsv(text, ';');
  const map = C.suggestMapping(rows);
  map.date_format    = 'dmy';
  map.amount_decimal = ',';
  const result = C.applyMapping(rows, map);
  // Salary row in the bundled CSV is positive (1850.00); rest are
  // negative expenses.
  const incomes  = result.rows.filter(r => r.kind === 'income');
  const expenses = result.rows.filter(r => r.kind === 'expense');
  assert.equal(incomes.length,  1, 'expected exactly one income (the Salary row)');
  assert.equal(expenses.length, 23);
  assert.ok(incomes[0].amount > 0);
  assert.ok(expenses.every(r => r.amount < 0));
});

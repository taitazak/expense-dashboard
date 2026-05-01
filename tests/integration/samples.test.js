'use strict';
/* tests/integration/samples.test.js
 *
 * Sanity checks for the bundled samples/ files. These don't validate
 * parser output (that's templates.test.js) — they validate that the
 * sample files THEMSELVES are well-formed and won't surprise a user
 * who just dropped them into the importer. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../helpers/load.js');

const SAMPLES = path.join(ROOT, 'samples');

test('samples/ contains the expected file set', () => {
  const files = fs.readdirSync(SAMPLES).sort();
  assert.deepEqual(files, [
    'activo-statement.csv',
    'ing-statement.pdf',
    'leumi-statement.pdf',
    'n26-statement.pdf',
    'santander-statement.pdf',
  ]);
});

test('samples/activo-statement.csv has Portuguese headers and 24 data rows', () => {
  const text  = fs.readFileSync(path.join(SAMPLES, 'activo-statement.csv'), 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 25, 'header + 24 data rows');
  // Header columns.
  const header = lines[0].split(';');
  assert.deepEqual(header, ['Data', 'Descrição', 'Valor', 'Categoria', 'Tipo', 'Saldo']);
  // Every data row has 6 fields.
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(';');
    assert.equal(cols.length, 6, `row ${i} has wrong column count: ${lines[i]}`);
    // First column is DD/MM/YYYY.
    assert.match(cols[0], /^\d{2}\/\d{2}\/\d{4}$/, 'bad date on row ' + i);
  }
});

test('samples/activo-statement.csv: every month from 03/2024 to 02/2026 is present', () => {
  const text  = fs.readFileSync(path.join(SAMPLES, 'activo-statement.csv'), 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean).slice(1);
  const yyyymm = new Set();
  for (const line of lines) {
    const [d] = line.split(';');
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
    yyyymm.add(m[3] + '-' + m[2]);
  }
  assert.equal(yyyymm.size, 24);
  const sorted = Array.from(yyyymm).sort();
  assert.equal(sorted[0],  '2024-03');
  assert.equal(sorted[23], '2026-02');
});

test('samples/*-statement.pdf each weigh under 200 KB', () => {
  // Sanity guard against accidentally checking in a multi-MB PDF.
  for (const f of fs.readdirSync(SAMPLES)) {
    if (!f.endsWith('.pdf')) continue;
    const size = fs.statSync(path.join(SAMPLES, f)).size;
    assert.ok(size > 0, f + ' is empty');
    assert.ok(size < 200 * 1024,
      `${f} is ${size} bytes — sample PDFs should be small`);
  }
});

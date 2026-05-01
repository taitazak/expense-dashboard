'use strict';
/* tests/processing/templates.test.js — bank PDF template parsers.
 *
 * The parsers consume pre-extracted text from PDF.js (one row of
 * extracted text per visible line, grouped by y-coordinate). To run
 * them under Node we extract the bundled samples once with
 * pdfplumber + a y-bucketing script (see tools/extract_for_tests.py)
 * and cache the output as JSON.
 *
 * Cache file:    tests/fixtures/extracted-pdfs.json
 * Builder:       tools/extract_for_tests.py  (run on demand; see comment)
 *
 * If the fixture is missing (e.g. fresh clone, no python yet) every
 * test in this file is SKIPPED with a clear message rather than
 * failing.  That keeps `npm test` green out of the box. */
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const { loadTemplates, ROOT } = require('../helpers/load.js');

const FIX = path.join(ROOT, 'tests', 'fixtures', 'extracted-pdfs.json');
const HAS_FIXTURE = fs.existsSync(FIX);

const expected = {
  'n26-statement.pdf':       'n26',
  'santander-statement.pdf': 'santander-pt',
  'ing-statement.pdf':       'ing-de',
  'leumi-statement.pdf':     'leumi',
};

function withFixture(name, fn) {
  test(name, { skip: !HAS_FIXTURE && 'tests/fixtures/extracted-pdfs.json missing — run `python3 tools/extract_for_tests.py`' }, fn);
}

withFixture('every shipping bank parser registers itself', () => {
  const App = loadTemplates();
  const ids = App.templates.all().map(t => t.id).sort();
  assert.deepEqual(ids, ['activo', 'ing-de', 'leumi', 'n26', 'santander-pt']);
});

for (const [filename, expectedId] of Object.entries(expected)) {
  withFixture(`detect: ${filename} → ${expectedId} at score 1.0`, () => {
    const App  = loadTemplates();
    const data = JSON.parse(fs.readFileSync(FIX, 'utf8'));
    const parsed = data[filename];
    assert.ok(parsed, 'fixture missing entry for ' + filename);
    const scores = App.templates.all()
      .map(t => ({ id: t.id, score: t.detect(parsed) }))
      .sort((a, b) => b.score - a.score);
    assert.equal(scores[0].id, expectedId);
    assert.equal(scores[0].score, 1.0);
  });

  withFixture(`parse: ${filename} → ≥20 rows with sane shape`, () => {
    const App  = loadTemplates();
    const data = JSON.parse(fs.readFileSync(FIX, 'utf8'));
    const parsed = data[filename];
    const tmpl = App.templates.byId(expectedId);
    const result = tmpl.parse(parsed);
    assert.ok(result && Array.isArray(result.rows));
    assert.ok(result.rows.length >= 20,
      `${filename} produced only ${result.rows.length} rows`);
    // Every row should have a valid ISO date and a finite numeric amount.
    for (const r of result.rows) {
      assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/,
        `bad date on ${filename} row: ${JSON.stringify(r)}`);
      assert.ok(Number.isFinite(r.amount),
        `bad amount on ${filename} row: ${JSON.stringify(r)}`);
      assert.ok(['expense', 'income', 'transfer'].includes(r.kind),
        `bad kind on ${filename} row: ${JSON.stringify(r)}`);
    }
  });
}

withFixture('multi-year sample spans Mar 2024 → Feb 2026 (N26)', () => {
  // N26 is the only sample whose row format carries full DD.MM.YYYY,
  // so it's the parser whose date range we can pin without tripping on
  // single-year anchor logic (Santander/Activo derive the year from a
  // statement-level header, capping any single PDF at ~12 months).
  const App  = loadTemplates();
  const data = JSON.parse(fs.readFileSync(FIX, 'utf8'));
  const parsed = data['n26-statement.pdf'];
  const result = App.templates.byId('n26').parse(parsed);
  const dates = result.rows.map(r => r.date).sort();
  assert.ok(dates[0] <= '2024-04-30',
    'first row should be in early 2024, got ' + dates[0]);
  assert.ok(dates[dates.length - 1] >= '2026-01-01',
    'last row should reach 2026, got ' + dates[dates.length - 1]);
});

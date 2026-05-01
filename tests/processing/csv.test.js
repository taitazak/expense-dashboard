'use strict';
/* tests/processing/csv.test.js — generic CSV parser + mapping engine. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProcessing } = require('../helpers/load.js');

function C() {
  const App = loadProcessing();
  return App.processing.csv;
}

// ----- delimiter detection ----------------------------------------------

test('detectDelimiter: comma when count is highest', () => {
  const c = C();
  assert.equal(c.detectDelimiter('a,b,c,d\n1,2,3,4'), ',');
});

test('detectDelimiter: semicolon (Portuguese exports)', () => {
  const c = C();
  assert.equal(c.detectDelimiter('Data;Descrição;Valor\n02/04/2024;Lidl;-12,50'), ';');
});

test('detectDelimiter: tab', () => {
  const c = C();
  assert.equal(c.detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
});

test('detectDelimiter: pipe', () => {
  const c = C();
  assert.equal(c.detectDelimiter('a|b|c\n1|2|3'), '|');
});

test('detectDelimiter: no candidates → fallback to comma', () => {
  const c = C();
  assert.equal(c.detectDelimiter('singlecolumn\nvalue'), ',');
});

// ----- parseCsv ---------------------------------------------------------

test('parseCsv: basic CRLF + LF mix', () => {
  const c = C();
  assert.deepEqual(c.parseCsv('a,b\r\n1,2\n3,4', ','), [['a','b'],['1','2'],['3','4']]);
});

test('parseCsv: quoted fields with embedded commas', () => {
  const c = C();
  assert.deepEqual(c.parseCsv('"Joe\'s Place, Berlin",10', ','),
    [['Joe\'s Place, Berlin', '10']]);
});

test('parseCsv: doubled quotes inside a quoted field become a single quote', () => {
  const c = C();
  assert.deepEqual(c.parseCsv('"Joe\'s ""Pizza"", Berlin",-9.50', ','),
    [['Joe\'s "Pizza", Berlin', '-9.50']]);
});

test('parseCsv: trailing newline does not yield empty row', () => {
  const c = C();
  assert.deepEqual(c.parseCsv('a,b\n1,2\n', ','), [['a','b'],['1','2']]);
});

test('parseCsv: empty input → []', () => {
  const c = C();
  assert.deepEqual(c.parseCsv('', ','), []);
});

test('parseCsv: BOM is handled by readFileAsText, not parseCsv (here, BOM = literal char)', () => {
  // parseCsv itself doesn't strip BOM. That's readFileAsText's job, see csv.js comments.
  const c = C();
  const rows = c.parseCsv('﻿a,b\n1,2', ',');
  // BOM stays attached to first cell of first row.
  assert.equal(rows[0][0], '﻿a');
});

// ----- suggestMapping (header heuristic) --------------------------------

test('suggestMapping: header detected when every cell is a label', () => {
  const c = C();
  const rows = c.parseCsv('Date,Amount,Merchant\n2024-01-15,-9.50,Coffee', ',');
  const m = c.suggestMapping(rows);
  assert.equal(m.has_header, true);
  assert.equal(m.columns.date, 0);
  assert.equal(m.columns.amount, 1);
  assert.equal(m.columns.merchant, 2);
});

test('suggestMapping: no header when first row looks like data (date in col 0)', () => {
  const c = C();
  const rows = c.parseCsv('04/17/2026,Starbucks,(-3.45)\n04/18/2026,Amazon,12.99', ',');
  const m = c.suggestMapping(rows);
  assert.equal(m.has_header, false);
  // Heuristic guesses: col 0 = date, last col = amount, col 1 = merchant.
  assert.equal(m.columns.date, 0);
  assert.equal(m.columns.amount, 2);
  assert.equal(m.columns.merchant, 1);
});

test('suggestMapping: matches Portuguese / German / Hebrew headers', () => {
  const c = C();
  const m1 = c.suggestMapping(c.parseCsv('Data;Descrição;Valor\n', ';'));
  assert.equal(m1.columns.date, 0);
  assert.equal(m1.columns.merchant, 1);
  assert.equal(m1.columns.amount, 2);

  const m2 = c.suggestMapping(c.parseCsv('Datum;Betrag;Beschreibung\n', ';'));
  assert.equal(m2.columns.date, 0);
  assert.equal(m2.columns.amount, 1);
  assert.equal(m2.columns.merchant, 2);
});

test('suggestMapping: split credit/debit columns flip sign convention', () => {
  const c = C();
  const rows = c.parseCsv('Date,Credit,Debit,Description\n', ',');
  const m = c.suggestMapping(rows);
  assert.equal(m.columns.amount_credit, 1);
  assert.equal(m.columns.amount_debit,  2);
  assert.equal(m.sign_convention, 'credit_positive');
});

// ----- parseDate (private helper, exposed) ------------------------------

test('parseDate: ISO short-circuit', () => {
  const c = C();
  assert.equal(c.parseDate('2026-04-30',         'auto'), '2026-04-30');
  assert.equal(c.parseDate('2026-04-30T12:00Z',  'auto'), '2026-04-30');
});

test('parseDate: DMY (European default)', () => {
  const c = C();
  assert.equal(c.parseDate('30/04/2026', 'auto'), '2026-04-30');
  assert.equal(c.parseDate('17.08.24',   'auto'), '2024-08-17');
});

test('parseDate: MDY when explicit', () => {
  const c = C();
  assert.equal(c.parseDate('04/30/2026', 'mdy'), '2026-04-30');
  assert.equal(c.parseDate('08/17/2024', 'mdy'), '2024-08-17');
});

test('parseDate: auto picks DMY when first-number > 12 forces it', () => {
  const c = C();
  assert.equal(c.parseDate('30/04/2026', 'auto'), '2026-04-30');
});

test('parseDate: 8-digit YYYYMMDD', () => {
  const c = C();
  assert.equal(c.parseDate('20260430', 'iso'),  '2026-04-30');
  assert.equal(c.parseDate('30042026', 'auto'), '2026-04-30');
});

test('parseDate: 2-digit year window', () => {
  const c = C();
  assert.equal(c.parseDate('15/04/24', 'dmy'), '2024-04-15');
  assert.equal(c.parseDate('15/04/99', 'dmy'), '1999-04-15');  // pre-2000 fallback
});

test('parseDate: junk → null', () => {
  const c = C();
  assert.equal(c.parseDate('not a date', 'auto'), null);
  assert.equal(c.parseDate('', 'auto'),           null);
  assert.equal(c.parseDate(null, 'auto'),         null);
});

// ----- parseAmount ------------------------------------------------------

test('parseAmount: dot decimal', () => {
  const c = C();
  assert.equal(c.parseAmount('1234.56',  '.'),    1234.56);
  assert.equal(c.parseAmount('-9.50',    '.'),    -9.5);
});

test('parseAmount: comma decimal', () => {
  const c = C();
  assert.equal(c.parseAmount('1234,56',   ','), 1234.56);
  assert.equal(c.parseAmount('-9,50',     ','), -9.5);
  assert.equal(c.parseAmount('1.234,56',  ','), 1234.56);   // EU thousand sep
});

test('parseAmount: parens → negative', () => {
  const c = C();
  assert.equal(c.parseAmount('(3.45)',  '.'), -3.45);
  assert.equal(c.parseAmount('(-3.45)', '.'),  3.45);    // double-neg
});

test('parseAmount: auto decimal infers from input', () => {
  const c = C();
  assert.equal(c.parseAmount('1.234,56', 'auto'), 1234.56);  // comma after dot
  assert.equal(c.parseAmount('1,234.56', 'auto'), 1234.56);  // dot after comma
  assert.equal(c.parseAmount('1234',     'auto'), 1234);
});

test('parseAmount: currency symbol stripped', () => {
  const c = C();
  assert.equal(c.parseAmount('€1.234,56', ','), 1234.56);
  assert.equal(c.parseAmount('$ 9.50',    '.'), 9.5);
});

test('parseAmount: empty/null → null', () => {
  const c = C();
  assert.equal(c.parseAmount('',     '.'), null);
  assert.equal(c.parseAmount(null,   '.'), null);
});

// ----- applyMapping (end-to-end small CSVs) -----------------------------

test('applyMapping: signed amount + DMY produces canonical rows', () => {
  const c = C();
  const text = 'Data;Descrição;Valor;Categoria\n02/04/2024;Lidl;-12,50;Alimentação';
  const rows = c.parseCsv(text, ';');
  const map = c.suggestMapping(rows);
  map.date_format = 'dmy';
  map.amount_decimal = ',';
  const result = c.applyMapping(rows, map);
  assert.equal(result.errors.length, 0);
  assert.equal(result.rows.length, 1);
  const r = result.rows[0];
  assert.equal(r.date,     '2024-04-02');
  assert.equal(r.amount,   -12.5);
  assert.equal(r.merchant, 'Lidl');
  assert.equal(r.kind,     'expense');
  assert.equal(r.year,     2024);
  assert.equal(r.month,    'April');
});

test('applyMapping: split credit/debit convention', () => {
  const c = C();
  const text = 'Date,Credit,Debit,Description\n2024-01-15,,9.50,Coffee\n2024-01-16,500.00,,Salary';
  const rows = c.parseCsv(text, ',');
  const map = c.suggestMapping(rows);
  map.date_format = 'iso';
  map.amount_decimal = '.';
  const result = c.applyMapping(rows, map);
  assert.equal(result.errors.length, 0);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].amount,  -9.5);
  assert.equal(result.rows[0].kind,    'expense');
  assert.equal(result.rows[1].amount,  500);
  assert.equal(result.rows[1].kind,    'income');
});

test('applyMapping: unparseable date counts as error, row dropped', () => {
  const c = C();
  const rows = [['Date','Amount','Merchant'], ['xyz','-9.50','Coffee'], ['2024-01-15','-3.50','Tea']];
  const map = c.suggestMapping(rows);
  map.date_format = 'iso';
  map.amount_decimal = '.';
  const result = c.applyMapping(rows, map);
  assert.equal(result.rows.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].reason.startsWith('Unparseable date'), true);
});

test('applyMapping: blank rows are skipped (not errors)', () => {
  const c = C();
  const rows = [['Date','Amount','Merchant'],
                ['','',''],
                ['2024-01-15','-9.50','Coffee']];
  const map = c.suggestMapping(rows);
  map.date_format = 'iso';
  map.amount_decimal = '.';
  const result = c.applyMapping(rows, map);
  assert.equal(result.rows.length, 1);
  assert.equal(result.errors.length, 0);
});

test('applyMapping: passes csv_category translation through translate.js', () => {
  const c = C();
  const text = 'Data;Descrição;Valor;Categoria\n02/04/2024;Lidl;-12,50;Alimentação';
  const rows = c.parseCsv(text, ';');
  const map = c.suggestMapping(rows);
  map.date_format = 'dmy';
  map.amount_decimal = ',';
  const result = c.applyMapping(rows, map);
  // category gets translated to English at applyMapping time.
  assert.equal(result.rows[0].category, 'Groceries');
  // raw value preserved for audit.
  assert.equal(result.rows[0].raw.csv_category_raw, 'Alimentação');
});

test('applyMapping: required-field validation error when amount missing', () => {
  const c = C();
  // Mapping has no amount column at all.
  const rows = [['Date','Merchant'], ['2024-01-15','Coffee']];
  const map = c.suggestMapping(rows);
  // suggestMapping picked col=1 as amount because it's "last col" — clear it
  // explicitly so we can test the missing-amount error path.
  map.columns.amount = null;
  map.date_format = 'iso';
  const result = c.applyMapping(rows, map);
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 1);
});

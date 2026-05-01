'use strict';
/* tests/processing/translate.test.js — non-English category → English. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProcessing } = require('../helpers/load.js');

function T() {
  const App = loadProcessing();
  return App.processing.translate.translateCategory;
}

test('German categories translate', () => {
  const tr = T();
  assert.equal(tr('Lebensmittel'),    'Groceries');
  assert.equal(tr('Einkommen'),       'Income');
  assert.equal(tr('Gehalt'),          'Salary');
  assert.equal(tr('Miete'),           'Rent');
  assert.equal(tr('Bargeld'),         'Cash');
  assert.equal(tr('Nebenkosten'),     'Utilities');
  assert.equal(tr('Versicherung'),    'Insurance');
  assert.equal(tr('Sport & Freizeit'), 'Leisure');
  assert.equal(tr('Sonstiges'),       'Other');
});

test('Portuguese categories translate', () => {
  const tr = T();
  assert.equal(tr('Alimentação'),     'Groceries');
  assert.equal(tr('Restauração'),     'Restaurants & Cafés');
  assert.equal(tr('Transportes'),     'Transport');
  assert.equal(tr('Salário'),         'Salary');
  assert.equal(tr('Habitação'),       'Housing');
  assert.equal(tr('Saúde'),           'Healthcare');
  assert.equal(tr('Comissões'),       'Fees');
});

test('Hebrew categories translate', () => {
  const tr = T();
  assert.equal(tr('מזון'),            'Groceries');
  assert.equal(tr('משכורת'),          'Salary');
  assert.equal(tr('בריאות'),          'Healthcare');
  assert.equal(tr('דיור'),            'Housing');
  assert.equal(tr('תחבורה'),          'Transport');
});

test('French/Spanish/Italian categories translate', () => {
  const tr = T();
  assert.equal(tr('Alimentation'),    'Groceries');     // FR
  assert.equal(tr('Salaire'),         'Salary');        // FR
  assert.equal(tr('Alimentación'),    'Groceries');     // ES
  assert.equal(tr('Sueldo'),          'Salary');        // ES
  assert.equal(tr('Alimentari'),      'Groceries');     // IT
  assert.equal(tr('Stipendio'),       'Salary');        // IT
});

test('case-insensitive', () => {
  const tr = T();
  assert.equal(tr('LEBENSMITTEL'),    'Groceries');
  assert.equal(tr('lebensmittel'),    'Groceries');
  assert.equal(tr('LeBeNsMiTtEl'),    'Groceries');
});

test('whitespace-tolerant', () => {
  const tr = T();
  assert.equal(tr('  Lebensmittel  '), 'Groceries');
});

test('English passes through unchanged', () => {
  const tr = T();
  assert.equal(tr('Groceries'),       'Groceries');
  assert.equal(tr('Restaurants & Cafés'), 'Restaurants & Cafés');
  assert.equal(tr('Transport'),       'Transport');
});

test('unknown strings pass through unchanged', () => {
  const tr = T();
  assert.equal(tr('My Custom Bucket'),    'My Custom Bucket');
  assert.equal(tr('SomeUnusualLabel'),    'SomeUnusualLabel');
  // Trimming still happens.
  assert.equal(tr('  unknown thing  '),   'unknown thing');
});

test('null / undefined / empty / whitespace → empty string', () => {
  const tr = T();
  assert.equal(tr(null),              '');
  assert.equal(tr(undefined),         '');
  assert.equal(tr(''),                '');
  assert.equal(tr('   '),             '');
});

test('numeric input is coerced to string then translated/passed through', () => {
  const tr = T();
  assert.equal(tr(42),                '42');   // number → string, no match
});

test('translateAll: bulk variant returns array of same length', () => {
  const App = loadProcessing();
  const result = App.processing.translate.translateAll(
    ['Lebensmittel', 'Salário', 'Groceries', null]);
  assert.deepEqual(result, ['Groceries', 'Salary', 'Groceries', '']);
});

test('TRANSLATIONS table has every value as plain string', () => {
  const App = loadProcessing();
  const T = App.processing.translate.TRANSLATIONS;
  for (const [k, v] of Object.entries(T)) {
    assert.equal(typeof k, 'string', 'key not string: ' + k);
    assert.equal(typeof v, 'string', 'value not string for ' + k);
    assert.ok(v.length > 0, 'empty translation for ' + k);
    // Keys must be lowercased (the lookup downcases input).
    assert.equal(k, k.toLowerCase(), 'key not lowercase: ' + k);
  }
});

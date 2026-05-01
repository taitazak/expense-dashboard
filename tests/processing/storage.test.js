'use strict';
/* tests/processing/storage.test.js — IndexedDB layer.
 *
 * Requires fake-indexeddb to be installed (`npm install`). The helper's
 * loadWithIDB() wires it onto global.indexedDB before storage.js loads. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWithIDB } = require('../helpers/load.js');

test('open: returns a connection without throwing', async () => {
  const App = await loadWithIDB();
  const db = await App.storage.open();
  assert.ok(db);
  // Schema check: every documented store should exist.
  const expected = ['transactions', 'accounts', 'categories', 'category_rules',
                    'imports', 'duplicate_ignores', 'merchants',
                    'normalize_rules', 'csv_templates'];
  for (const name of expected) {
    assert.ok(db.objectStoreNames.contains(name), 'missing store: ' + name);
  }
});

test('schema version is 5 (latest known)', async () => {
  const App = await loadWithIDB();
  const db = await App.storage.open();
  assert.equal(db.version, 5);
});

test('CRUD: accounts.put → all → delete round-trip', async () => {
  const App = await loadWithIDB();
  await App.storage.open();
  const id = await App.storage.accounts.put({
    name: 'N26 Main', bank: 'N26', currency: 'EUR',
    iban: 'DE89370400440532013000', is_own: true,
  });
  assert.ok(typeof id === 'number');
  let all = await App.storage.accounts.all();
  assert.equal(all.length, 1);
  assert.equal(all[0].name, 'N26 Main');
  await App.storage.accounts.delete(id);
  all = await App.storage.accounts.all();
  assert.equal(all.length, 0);
});

test('CRUD: categories with full flag set', async () => {
  const App = await loadWithIDB();
  await App.storage.open();
  await App.storage.categories.put({ name: 'Income', is_income: true,  excluded: false });
  await App.storage.categories.put({ name: 'Bank',   is_income: false, excluded: true  });
  const all = await App.storage.categories.all();
  assert.equal(all.length, 2);
  const inc = all.find(c => c.name === 'Income');
  assert.equal(inc.is_income, true);
  assert.equal(inc.excluded, false);
});

test('CRUD: rules + normalize_rules + csv_templates each work as simple CRUD', async () => {
  const App = await loadWithIDB();
  await App.storage.open();

  await App.storage.rules.put({ keyword: 'lidl', category: 'Groceries', source: 'manual' });
  await App.storage.normalizeRules.put({ pattern: '\\bLIDL\\b', flags: 'i', display: 'Lidl', source: 'default' });
  await App.storage.csvTemplates.put({
    name: 'ActivoBank', delimiter: ';', has_header: true,
    date_format: 'dmy', sign_convention: 'signed', amount_decimal: ',',
    columns: { date: 0, merchant: 1, amount: 2, category: 3 },
  });

  assert.equal((await App.storage.rules.all()).length, 1);
  assert.equal((await App.storage.normalizeRules.all()).length, 1);
  assert.equal((await App.storage.csvTemplates.all()).length, 1);
});

test('transactions.putMany inserts in one batch and returns ids', async () => {
  const App = await loadWithIDB();
  await App.storage.open();
  const ids = await App.storage.transactions.putMany([
    { date: '2026-04-01', amount: -10, merchant: 'Lidl',   account_id: 1 },
    { date: '2026-04-02', amount: -20, merchant: 'Edeka',  account_id: 1 },
    { date: '2026-04-03', amount: -30, merchant: 'REWE',   account_id: 1 },
  ]);
  assert.equal(ids.length, 3);
  assert.ok(ids.every(i => typeof i === 'number'));
  const all = await App.storage.transactions.all();
  assert.equal(all.length, 3);
});

test('transactions.byBatch retrieves by import_batch_id index', async () => {
  const App = await loadWithIDB();
  await App.storage.open();
  await App.storage.transactions.putMany([
    { date: '2026-04-01', amount: -10, merchant: 'A', account_id: 1, import_batch_id: 'B1' },
    { date: '2026-04-02', amount: -20, merchant: 'B', account_id: 1, import_batch_id: 'B1' },
    { date: '2026-04-03', amount: -30, merchant: 'C', account_id: 1, import_batch_id: 'B2' },
  ]);
  const b1 = await App.storage.transactions.byBatch('B1');
  assert.equal(b1.length, 2);
  const b2 = await App.storage.transactions.byBatch('B2');
  assert.equal(b2.length, 1);
});

test('transactions.deleteByBatch removes an entire batch', async () => {
  const App = await loadWithIDB();
  await App.storage.open();
  await App.storage.transactions.putMany([
    { date: '2026-04-01', amount: -10, merchant: 'A', account_id: 1, import_batch_id: 'B1' },
    { date: '2026-04-02', amount: -20, merchant: 'B', account_id: 1, import_batch_id: 'B1' },
    { date: '2026-04-03', amount: -30, merchant: 'C', account_id: 1, import_batch_id: 'B2' },
  ]);
  const removed = await App.storage.transactions.deleteByBatch('B1');
  assert.equal(removed, 2);
  const left = await App.storage.transactions.all();
  assert.equal(left.length, 1);
  assert.equal(left[0].merchant, 'C');
});

test('exportAll: produces every store with shape {schema, exported_at, data}', async () => {
  const App = await loadWithIDB();
  await App.storage.open();
  await App.storage.accounts.put({ name: 'A', bank: 'X', currency: 'EUR' });
  await App.storage.categories.put({ name: 'Groceries', is_income: false, excluded: false });
  const dump = await App.storage.exportAll();
  assert.equal(dump.schema.name, 'kalkala-expense-dashboard');
  assert.equal(typeof dump.exported_at, 'string');
  for (const k of ['transactions', 'accounts', 'categories', 'category_rules',
                   'imports', 'merchants', 'normalize_rules', 'csv_templates']) {
    assert.ok(Array.isArray(dump.data[k]), 'expected data.' + k + ' to be an array');
  }
  assert.equal(dump.data.accounts[0].name, 'A');
});

test('importAll: appends by default (ids stripped, existing rows preserved)', async () => {
  const App = await loadWithIDB();
  await App.storage.open();
  await App.storage.accounts.put({ name: 'Existing', bank: 'X', currency: 'EUR' });
  const counts = await App.storage.importAll({
    schema: { name: 'kalkala-expense-dashboard' },
    data: { accounts: [{ id: 99, name: 'Imported', bank: 'Y', currency: 'EUR' }] },
  });
  assert.equal(counts.accounts, 1);
  const all = await App.storage.accounts.all();
  assert.equal(all.length, 2);   // both kept
  // The imported one got a fresh id, not 99.
  const imported = all.find(a => a.name === 'Imported');
  assert.notEqual(imported.id, 99);
});

test('importAll: replace=true wipes every store first', async () => {
  const App = await loadWithIDB();
  await App.storage.open();
  await App.storage.accounts.put({ name: 'Existing', bank: 'X', currency: 'EUR' });
  await App.storage.categories.put({ name: 'Wipe me', is_income: false, excluded: false });
  await App.storage.importAll({
    schema: { name: 'kalkala-expense-dashboard' },
    data: { accounts: [{ id: 1, name: 'Imported', bank: 'Y', currency: 'EUR' }] },
  }, { replace: true });
  const accs = await App.storage.accounts.all();
  assert.equal(accs.length, 1);
  assert.equal(accs[0].name, 'Imported');
  // Categories store wiped too.
  const cats = await App.storage.categories.all();
  assert.equal(cats.length, 0);
});

test('exportAll → importAll roundtrip preserves transaction count', async () => {
  const App = await loadWithIDB();
  await App.storage.open();
  await App.storage.accounts.put({ name: 'A', bank: 'X', currency: 'EUR' });
  await App.storage.transactions.putMany([
    { date: '2026-04-01', amount: -10, merchant: 'A', account_id: 1 },
    { date: '2026-04-02', amount: -20, merchant: 'B', account_id: 1 },
  ]);
  const dump = await App.storage.exportAll();
  await App.storage.transactions.clear();
  assert.equal((await App.storage.transactions.all()).length, 0);
  await App.storage.importAll(dump, { replace: false });
  // After the round-trip the transactions are back. Existing accounts
  // weren't cleared (replace=false), so we get duplicate accounts —
  // that's documented behavior, not a bug.
  assert.equal((await App.storage.transactions.all()).length, 2);
});

test('importAll: rejects malformed JSON', async () => {
  const App = await loadWithIDB();
  await App.storage.open();
  await assert.rejects(
    () => App.storage.importAll({ no_data_key: true }),
    /missing `data`/);
});

test('clearAll: empties every store', async () => {
  const App = await loadWithIDB();
  await App.storage.open();
  await App.storage.accounts.put({ name: 'A', bank: 'X' });
  await App.storage.categories.put({ name: 'C' });
  await App.storage.rules.put({ keyword: 'k', category: 'C' });
  await App.storage.clearAll();
  assert.equal((await App.storage.accounts.all()).length, 0);
  assert.equal((await App.storage.categories.all()).length, 0);
  assert.equal((await App.storage.rules.all()).length, 0);
});

test('merchants.getByOriginal: index lookup', async () => {
  const App = await loadWithIDB();
  await App.storage.open();
  await App.storage.merchants.put({ original: 'COMPRA 1234 LIDL', display: 'Lidl' });
  const hit = await App.storage.merchants.getByOriginal('COMPRA 1234 LIDL');
  assert.ok(hit);
  assert.equal(hit.display, 'Lidl');
  // Miss returns undefined, not throw.
  const miss = await App.storage.merchants.getByOriginal('NOT THERE');
  assert.equal(miss, undefined);
});

test('diagnose: returns availability info without throwing', async () => {
  const App = await loadWithIDB();
  // diagnose() doesn't require open() to have been called.
  const info = await App.storage.diagnose();
  assert.ok(info);
  // fake-indexeddb implements databases() so we should get available=true.
  // If the polyfill version doesn't, accept either shape.
  assert.ok(typeof info.available === 'boolean');
});

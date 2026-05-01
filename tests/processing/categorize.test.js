'use strict';
/* tests/processing/categorize.test.js — keyword + history rule engine.
 *
 * Several entry points (categorizeRow / categorizeRows / applyRulesToAll /
 * learnCategoryRule) reach into App.storage. We don't need a real
 * IndexedDB for that — just an in-memory shim that mirrors the public
 * App.storage API. Each test sets up its own shim so they're independent. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProcessing } = require('../helpers/load.js');

// Build an in-memory App.storage replica. Only the methods categorize.js
// touches are implemented.
function installStorageShim(App, { rules = [], transactions = [], merchants = [] } = {}) {
  // Shallow-clone arrays so mutation in one test doesn't leak to the next.
  const _rules = rules.map(r => Object.assign({}, r));
  const _txs   = transactions.map(t => Object.assign({}, t));
  const _mer   = merchants.map(m => Object.assign({}, m));
  let nextId = Math.max(0, ..._rules.map(r => r.id || 0)) + 1;
  App.storage = {
    rules: {
      all: async () => _rules.slice(),
      put: async (row) => {
        if (row.id == null) row.id = nextId++;
        const idx = _rules.findIndex(r => r.id === row.id);
        if (idx === -1) _rules.push(row);
        else _rules[idx] = row;
        return row.id;
      },
    },
    transactions: {
      all: async () => _txs.slice(),
      update: async (row) => {
        const idx = _txs.findIndex(t => t.id === row.id);
        if (idx !== -1) _txs[idx] = Object.assign({}, _txs[idx], row);
      },
    },
    merchants: {
      all: async () => _mer.slice(),
    },
  };
  // Helpers for the test to inspect post-state.
  App.storage._dump = () => ({ rules: _rules, transactions: _txs, merchants: _mer });
  return App.storage;
}

const txn = (o) => Object.assign({
  date: '2026-04-01', amount: -10, merchant: 'Lidl Berlin',
  kind: 'expense', category: null,
}, o);

// ---------- compile + categorize (pure functions) -----------------------

test('categorize: substring match (case-insensitive)', () => {
  const App = loadProcessing();
  const c = App.processing.categorize;
  const cat = c.categorize('Coffee at Starbucks Berlin', [
    { kind: 'substring', needle: 'starbucks', category: 'Cafés' },
  ]);
  assert.equal(cat, 'Cafés');
});

test('categorize: regex rule', () => {
  const App = loadProcessing();
  const c = App.processing.categorize;
  // Test regex via categorizeRow which compiles rules.
  const compiled = [
    { kind: 'regex', re: /\bUBER\b/i, category: 'Transport' },
  ];
  assert.equal(c.categorize('UBER TRIP', compiled), 'Transport');
  assert.equal(c.categorize('something else', compiled), null);
});

test('categorize: empty / null haystack → null', () => {
  const App = loadProcessing();
  const c = App.processing.categorize;
  assert.equal(c.categorize('', []), null);
  assert.equal(c.categorize(null, []), null);
});

// ---------- categorizeRows (full pipeline) ------------------------------

test('categorizeRows: rule beats bank-provided category', async () => {
  const App = loadProcessing();
  installStorageShim(App, { rules: [
    { id: 1, keyword: 'lidl', is_regex: false, category: 'Groceries', source: 'manual' },
  ]});
  const rows = [txn({ merchant: 'Lidl Berlin', category: 'Lebensmittel' })];
  await App.processing.categorize.categorizeRows(rows, []);
  assert.equal(rows[0].category, 'Groceries');
});

test('categorizeRows: longest keyword wins (manual first)', async () => {
  const App = loadProcessing();
  installStorageShim(App, { rules: [
    { id: 1, keyword: 'coffee',          is_regex: false, category: 'Restaurants', source: 'manual' },
    { id: 2, keyword: 'starbucks coffee',is_regex: false, category: 'Cafés',       source: 'manual' },
  ]});
  const rows = [txn({ merchant: 'Starbucks Coffee Berlin' })];
  await App.processing.categorize.categorizeRows(rows, []);
  assert.equal(rows[0].category, 'Cafés');
});

test('categorizeRows: manual rule beats auto rule even if shorter', async () => {
  const App = loadProcessing();
  installStorageShim(App, { rules: [
    { id: 1, keyword: 'starbucks coffee',is_regex: false, category: 'Auto-Cafés',  source: 'auto'   },
    { id: 2, keyword: 'starbucks',       is_regex: false, category: 'Manual-Cafés',source: 'manual' },
  ]});
  const rows = [txn({ merchant: 'Starbucks Coffee Berlin' })];
  await App.processing.categorize.categorizeRows(rows, []);
  assert.equal(rows[0].category, 'Manual-Cafés');
});

test('categorizeRows: no rule, no history → falls back to bank category (translated)', async () => {
  const App = loadProcessing();
  installStorageShim(App, {});
  const rows = [txn({ merchant: 'Mystery Merchant', category: 'Lebensmittel' })];
  await App.processing.categorize.categorizeRows(rows, []);
  // German "Lebensmittel" → "Groceries" via translate.js
  assert.equal(rows[0].category, 'Groceries');
});

test('categorizeRows: bank category snapshot lands on raw.bank_category', async () => {
  const App = loadProcessing();
  installStorageShim(App, {});
  const rows = [txn({ merchant: 'Mystery', category: 'Lebensmittel' })];
  await App.processing.categorize.categorizeRows(rows, []);
  assert.equal(rows[0].raw.bank_category, 'Lebensmittel');
  // The visible category gets the English translation.
  assert.equal(rows[0].category, 'Groceries');
});

test('categorizeRows: locked rows are NOT touched', async () => {
  const App = loadProcessing();
  installStorageShim(App, { rules: [
    { id: 1, keyword: 'lidl', is_regex: false, category: 'Groceries', source: 'manual' },
  ]});
  const rows = [txn({
    merchant: 'Lidl Berlin', category: 'Pinned Manually', locked: true,
  })];
  await App.processing.categorize.categorizeRows(rows, []);
  assert.equal(rows[0].category, 'Pinned Manually');
});

test('categorizeRows: history fallback fires when no rule matches', async () => {
  const App = loadProcessing();
  installStorageShim(App, {
    rules: [],   // no rules
    transactions: [],   // (history is passed as separate arg below)
  });
  const history = [
    { merchant: 'Vapiano',         category: 'Restaurants & Cafés', kind: 'expense' },
    { merchant: 'Vapiano',         category: 'Restaurants & Cafés', kind: 'expense' },
  ];
  const rows = [txn({ merchant: 'Vapiano' })];
  await App.processing.categorize.categorizeRows(rows, history);
  assert.equal(rows[0].category, 'Restaurants & Cafés');
});

test('categorizeRows: row with no matching rule / history / bank → "Uncategorized"', async () => {
  const App = loadProcessing();
  installStorageShim(App, {});
  const rows = [txn({ merchant: 'No idea', category: null })];
  await App.processing.categorize.categorizeRows(rows, []);
  assert.equal(rows[0].category, 'Uncategorized');
});

// ---------- learnCategoryRule -------------------------------------------

test('learnCategoryRule: writes a new auto-rule', async () => {
  const App = loadProcessing();
  const s = installStorageShim(App, {});
  await App.processing.categorize.learnCategoryRule('Vapiano', 'Restaurants & Cafés');
  const rules = s._dump().rules;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].keyword, 'Vapiano');
  assert.equal(rules[0].category, 'Restaurants & Cafés');
  assert.equal(rules[0].source, 'auto');
});

test('learnCategoryRule: existing manual rule is preserved (only timestamp refreshed)', async () => {
  const App = loadProcessing();
  const s = installStorageShim(App, { rules: [
    { id: 1, keyword: 'vapiano', category: 'My Manual Cafés', source: 'manual',
      updated_at: '2024-01-01' },
  ]});
  await App.processing.categorize.learnCategoryRule('Vapiano', 'Restaurants & Cafés');
  const rules = s._dump().rules;
  assert.equal(rules.length, 1);
  // Manual category unchanged.
  assert.equal(rules[0].category, 'My Manual Cafés');
  // Manual source unchanged.
  assert.equal(rules[0].source, 'manual');
  // Timestamp refreshed.
  assert.notEqual(rules[0].updated_at, '2024-01-01');
});

test('learnCategoryRule: existing auto rule gets overwritten', async () => {
  const App = loadProcessing();
  const s = installStorageShim(App, { rules: [
    { id: 1, keyword: 'vapiano', category: 'Old Auto Cafés', source: 'auto',
      updated_at: '2024-01-01' },
  ]});
  await App.processing.categorize.learnCategoryRule('Vapiano', 'New Auto Cafés');
  const rules = s._dump().rules;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].category, 'New Auto Cafés');
});

test('learnCategoryRule: no-op on Uncategorized', async () => {
  const App = loadProcessing();
  const s = installStorageShim(App, {});
  await App.processing.categorize.learnCategoryRule('Vapiano', 'Uncategorized');
  assert.equal(s._dump().rules.length, 0);
});

test('learnCategoryRule: no-op on empty inputs', async () => {
  const App = loadProcessing();
  const s = installStorageShim(App, {});
  await App.processing.categorize.learnCategoryRule('', 'Cafés');
  await App.processing.categorize.learnCategoryRule('Vapiano', '');
  await App.processing.categorize.learnCategoryRule(null, 'Cafés');
  assert.equal(s._dump().rules.length, 0);
});

// ---------- applyRulesToAll ---------------------------------------------

test('applyRulesToAll: walks every row, returns counts, updates store', async () => {
  const App = loadProcessing();
  const s = installStorageShim(App, {
    rules: [
      { id: 1, keyword: 'lidl', is_regex: false, category: 'Groceries', source: 'manual' },
    ],
    transactions: [
      txn({ id: 1, merchant: 'Lidl Berlin',        category: null }),
      txn({ id: 2, merchant: 'Pingo Doce Lisbon',  category: 'Already Set' }),
      txn({ id: 3, merchant: 'Lidl Mitte',         category: 'Wrong' }),
    ],
  });
  const result = await App.processing.categorize.applyRulesToAll();
  assert.equal(result.changed, 2);   // rows 1 + 3 changed
  assert.equal(result.total, 3);
  // The store reflects the change.
  const txs = s._dump().transactions;
  assert.equal(txs.find(t => t.id === 1).category, 'Groceries');
  assert.equal(txs.find(t => t.id === 2).category, 'Already Set');  // no rule matched
  assert.equal(txs.find(t => t.id === 3).category, 'Groceries');
});

test('applyRulesToAll: locked rows are skipped (counts skippedLocked)', async () => {
  const App = loadProcessing();
  const s = installStorageShim(App, {
    rules: [
      { id: 1, keyword: 'lidl', is_regex: false, category: 'Groceries', source: 'manual' },
    ],
    transactions: [
      txn({ id: 1, merchant: 'Lidl Berlin', category: 'Pinned', locked: true }),
      txn({ id: 2, merchant: 'Lidl Mitte',  category: 'Wrong'                }),
    ],
  });
  const result = await App.processing.categorize.applyRulesToAll();
  assert.equal(result.changed, 1);
  assert.equal(result.skippedLocked, 1);
  assert.equal(s._dump().transactions[0].category, 'Pinned');   // unchanged
  assert.equal(s._dump().transactions[1].category, 'Groceries');
});

test('applyRulesToAll: no rules → 0 changed, 0 skippedLocked', async () => {
  const App = loadProcessing();
  installStorageShim(App, {
    rules: [],
    transactions: [txn({ id: 1, merchant: 'Lidl' })],
  });
  const result = await App.processing.categorize.applyRulesToAll();
  assert.equal(result.changed, 0);
  assert.equal(result.total, 1);
});

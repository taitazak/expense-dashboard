# Tests

Built on Node's `node:test` runner — zero framework dependencies.
The app itself remains pure static HTML/JS with no build step; this
folder exists only so contributors can run a regression suite before
opening a PR.

## Running

```sh
# Install the one dev dependency (fake-indexeddb) — required only for
# the storage tests under tests/processing/storage.test.js.
npm install

# All tests
npm test

# Watch mode (re-runs on save)
npm run test:watch

# Just one file
node --test tests/processing/translate.test.js

# Just one named test
node --test --test-name-pattern "DMY" tests/processing/csv.test.js
```

`npm install` reaches the npm registry only for `fake-indexeddb`;
everything else under `tests/` runs against `node` and the project's
own source.

## Layout

```
tests/
├── helpers/
│   └── load.js          # IIFE bootstrap: window/localStorage shim, fresh App per suite
├── processing/          # one suite per source module
│   ├── util.test.js
│   ├── translate.test.js
│   ├── csv.test.js
│   ├── normalize.test.js
│   ├── dates.test.js
│   ├── duplicate.test.js
│   ├── transfer.test.js
│   ├── categorize.test.js
│   ├── storage.test.js  # uses fake-indexeddb
│   └── templates.test.js
└── integration/         # cross-module pipelines
    ├── samples.test.js  # samples/ files validate against the schema
    └── csv-pipeline.test.js
```

Each test file calls `require('./helpers/load.js')` and uses one of:

- `loadUtil()`            — only `App.util`. Cheapest.
- `loadProcessing()`      — every pure-function processing module.
- `loadTemplates()`       — registry + 5 bank parsers.
- `loadWithIDB()`         — full app, with fake-indexeddb installed
  on the global. Use for storage/categorize/normalize-migration tests.

The helper resets the `App` global + module cache between calls, so
suites can't leak state into each other.

## What's covered

- **`util.js`**       — formatters, `escapeHtml`, `monthName`,
  `parseISODate`, `uuid`. DOM-touching helpers (`el()`, `modal`,
  `toast`) are not covered here — those are exercised indirectly by
  the templates/integration suites.
- **`translate.js`**  — DE / PT / HE / FR / ES / IT → English,
  case-insensitive, pass-through for English/unknown, null safety.
- **`csv.js`**        — delimiter detection, quoted fields with
  embedded commas/escaped quotes, headerless heuristic, all date
  formats (auto/iso/dmy/mdy + 8-digit), all decimal modes (auto / .
  / ,), signed vs split credit/debit conventions, currency
  pass-through.
- **`normalize.js`**  — `beautifyMerchant` against MB Way prefixes,
  payment providers (PayPal/SumUp/Stripe), brand collapses
  (Lidl/Lufthansa/Bolt/IKEA), title-casing, special-case map.
  `normalizeTxType` across the canonical vocabulary.
- **`dates.js`**      — future-date clamp, year reanchor.
- **`duplicate.js`**  — `findDuplicates` against existing rows,
  `findDuplicatesWithin` a candidate set, hard vs soft severity,
  signature stability for dismissal.
- **`transfer.js`**   — transfer-pair heuristic across two accounts.
- **`categorize.js`** — substring vs regex rules, manual-vs-auto
  precedence, longest-keyword wins, history fallback, locked rows
  skipped by `categorizeRows` and `applyRulesToAll`,
  `learnCategoryRule` no-ops on Uncategorized.
- **`storage.js`**    — open / put / get / delete on every store,
  `exportAll` → `importAll` roundtrip, `importAll(replace=true)`
  wipes first, `csv_templates` store works, the v5 schema upgrade
  applies cleanly on a fresh DB.
- **Bank templates** — for each shipping bank: `detect()` picks the
  right one against the bundled `samples/*-statement.pdf`, `parse()`
  produces ≥20 rows with sane dates and signed amounts.
- **Integration**    — `samples/sample-backup.json` validates
  against the schema (until removed). `samples/activo-statement.csv`
  runs through the full csv → translate → applyMapping pipeline and
  produces 24 canonical rows with English categories.

## Adding a test

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProcessing } = require('../helpers/load.js');

test('thing under test', () => {
  const App = loadProcessing();
  const T = App.processing.translate;
  assert.equal(T.translateCategory('Lebensmittel'), 'Groceries');
});
```

The first call to `loadProcessing()` (or any sibling loader) resets
the App global, so each `test(...)` block starts fresh as long as it
calls a loader. Tests that reuse a loaded `App` across `it()` blocks
should call the loader once at the top of `describe()`.

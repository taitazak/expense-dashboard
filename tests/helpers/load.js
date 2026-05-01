/* tests/helpers/load.js
 *
 * Reusable bootstrap for every test file. Each src module is an IIFE that
 * attaches to `window.App.*`, so to load them under Node we:
 *   1. point `global.window` at `global` itself (so `window.App = ...`
 *      ends up on a real object visible to subsequent requires)
 *   2. seed a minimal `localStorage` shim — App.processing.normalize uses
 *      it to remember whether the legacy merchants→rules migration ran
 *   3. require the src files in dependency order
 *
 * IndexedDB is loaded by `loadWithIDB()` only when a test asks for it
 * (storage / categorize / etc.) — pure-function tests skip the dep.
 */
'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC  = (rel) => path.join(ROOT, 'src', rel);

// ---- core globals --------------------------------------------------------

function ensureGlobals() {
  if (!global.window) global.window = global;
  // localStorage shim. The IDB layer + normalize migration both touch it;
  // tests rely on it working but not surviving across tests.
  if (!global.localStorage) {
    const store = new Map();
    global.localStorage = {
      getItem:    (k) => (store.has(k) ? store.get(k) : null),
      setItem:    (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
      clear:      ()  => { store.clear(); },
      get length(){ return store.size; },
      key(i) { return Array.from(store.keys())[i] || null; },
      // Internal escape hatch used in resetState() between tests.
      __reset()  { store.clear(); },
    };
  }
}

// ---- module loaders ------------------------------------------------------
//
// `require` caches modules, but our IIFEs side-effect-attach to window.App.
// When tests need a clean App we wipe the module cache + window.App and
// re-require.

function freshApp() {
  ensureGlobals();
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(ROOT, 'src') + path.sep)) delete require.cache[k];
  }
  if (global.window.App) delete global.window.App;
  if (global.localStorage && global.localStorage.__reset) global.localStorage.__reset();
}

// Pure-function modules — no IDB dependency. Fast.
function loadProcessing() {
  freshApp();
  require(SRC('core/util.js'));
  require(SRC('processing/translate.js'));
  require(SRC('processing/csv.js'));
  require(SRC('processing/normalize.js'));
  require(SRC('processing/dates.js'));
  require(SRC('processing/duplicate.js'));
  require(SRC('processing/transfer.js'));
  require(SRC('processing/categorize.js'));
  return global.window.App;
}

// Util only — for the lightest tests.
function loadUtil() {
  freshApp();
  require(SRC('core/util.js'));
  return global.window.App.util;
}

// Templates (PDF parsers). Each registers itself on App.templates.
function loadTemplates() {
  freshApp();
  require(SRC('core/util.js'));
  require(SRC('templates/registry.js'));
  ['leumi', 'n26', 'santander', 'ing', 'activo'].forEach(b => {
    require(SRC(path.join('templates', b + '.js')));
  });
  return global.window.App;
}

// Storage layer — needs fake-indexeddb on global before storage.js loads.
async function loadWithIDB() {
  // Fake IndexedDB stamps itself on global as `indexedDB` and `IDBKeyRange`
  // (and a few helpers). We require it lazily so tests that don't touch
  // storage don't pay the dep cost. The "auto" entrypoint also resets
  // state between tests when re-required, so call freshApp() first.
  let idb;
  try {
    idb = require('fake-indexeddb/auto');
  } catch (e) {
    throw new Error(
      'fake-indexeddb is not installed. Run `npm install` from the project ' +
      'root to fetch it (devDependency). Original error: ' + e.message);
  }
  freshApp();
  // fake-indexeddb/auto installs onto globalThis; mirror onto window so
  // storage.js (which checks `'indexedDB' in window`) is happy.
  global.window.indexedDB    = global.indexedDB;
  global.window.IDBKeyRange  = global.IDBKeyRange;
  // Wipe any DBs left over from an earlier test.
  if (global.indexedDB && global.indexedDB._databases) {
    global.indexedDB._databases.clear();
  }
  require(SRC('core/util.js'));
  require(SRC('core/storage.js'));
  require(SRC('processing/translate.js'));
  require(SRC('processing/csv.js'));
  require(SRC('processing/normalize.js'));
  require(SRC('processing/dates.js'));
  require(SRC('processing/duplicate.js'));
  require(SRC('processing/transfer.js'));
  require(SRC('processing/categorize.js'));
  return global.window.App;
}

module.exports = {
  ROOT, SRC,
  ensureGlobals, freshApp,
  loadUtil, loadProcessing, loadTemplates, loadWithIDB,
};

/*
 * src/core/storage.js — IndexedDB-backed local store.
 *
 * Stores: transactions, accounts, categories, category_rules, imports,
 *         duplicate_ignores, merchants.
 * Everything stays on the user's machine; nothing is sent over the network.
 *
 * Public API (all Promises unless noted):
 *   App.storage.open()                               -> ready promise
 *   App.storage.transactions.all()
 *   App.storage.transactions.byBatch(batchId)
 *   App.storage.transactions.putMany(rows)
 *   App.storage.transactions.update(row)
 *   App.storage.transactions.deleteByBatch(batchId)
 *   App.storage.transactions.clear()
 *   App.storage.accounts.all() / put() / delete()
 *   App.storage.categories.all() / put() / delete()
 *   App.storage.rules.all() / put() / delete()
 *   App.storage.imports.all() / put() / delete()
 *   App.storage.exportAll()                          -> {schema, exported_at, data}
 *   App.storage.importAll(json, {replace})
 *   App.storage.clearAll()
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};
  const DB_NAME = 'kalkala-expense-dashboard';
  // v2: added `duplicate_ignores` store for dismissed duplicate signatures.
  // v3: added `merchants` store for original→display-name mapping used to
  //     collapse noisy variants of the same merchant in stats.
  // v4: added `normalize_rules` store — persisted brand-collapse regexes for
  //     the merchant beautifier so users can audit/edit them in Manage.
  // v5: added `csv_templates` store — saved CSV column mappings so users
  //     can re-import statements from non-PDF sources without re-doing the
  //     "this column is the date, this one is the amount" mapping every time.
  const DB_VERSION = 5;

  const STORES = {
    transactions: { keyPath: 'id', autoIncrement: true,
      indexes: [
        ['by_batch', 'import_batch_id', {}],
        ['by_account', 'account_id', {}],
        ['by_date', 'date', {}],
      ] },
    accounts:       { keyPath: 'id', autoIncrement: true, indexes: [] },
    categories:     { keyPath: 'id', autoIncrement: true, indexes: [] },
    category_rules: { keyPath: 'id', autoIncrement: true, indexes: [] },
    imports:        { keyPath: 'id', autoIncrement: true, indexes: [] },
    // Signatures of duplicate groups the user has explicitly marked "ok",
    // so the Duplicates tab stops flagging them on every page load.
    duplicate_ignores: { keyPath: 'id', autoIncrement: true, indexes: [] },
    // Merchant display-name overrides. One row per raw merchant string the
    // user has beautified (unedited merchants are not stored — the UI
    // falls back to a live beautifier).
    merchants: { keyPath: 'id', autoIncrement: true,
      indexes: [
        ['by_original', 'original', { unique: true }],
      ] },
    // Brand-collapse rules used by the merchant beautifier. Each row:
    //   { id, pattern: '\\bLUFTHANSA', flags: 'i', display: 'Lufthansa',
    //     source: 'default'|'manual', updated_at }
    // The store is seeded on first boot from the hardcoded defaults in
    // normalize.js; user edits flip `source` to 'manual'.
    normalize_rules: { keyPath: 'id', autoIncrement: true, indexes: [] },
    // Saved CSV column mappings. Each row:
    //   { id, name, delimiter, has_header, date_format, sign_convention,
    //     amount_decimal, columns: { date, amount, merchant, category,
    //     account, notes }, updated_at }
    // `columns` values are zero-based column indices into the parsed row.
    // `null` means "not present in the CSV". Used by the Import flow's
    // CSV path so re-imports from the same source skip the mapping step.
    csv_templates: { keyPath: 'id', autoIncrement: true, indexes: [] },
  };

  let _db = null;
  let _opening = null;

  // Hard cap on how long the IDB open request can sit pending. Some browsers
  // / DB states leave open() in limbo without ever firing onsuccess, onerror,
  // or onblocked — the app's boot() then hangs and the user sees the header
  // with an empty page body. With this timeout we at least bail out and
  // surface the failure so the recovery UI can render.
  const OPEN_TIMEOUT_MS = 5000;

  function open() {
    if (_db) return Promise.resolve(_db);
    if (_opening) return _opening;
    _opening = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB is not available in this browser.'));
        return;
      }
      let settled = false;
      const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };
      const timer = setTimeout(() => {
        _opening = null;
        settle(reject, new Error(
          'IndexedDB open timed out after ' + OPEN_TIMEOUT_MS + 'ms — ' +
          'the local database is unreachable. Try closing other tabs of this ' +
          'app and reloading. If the page stays broken, use "Reset local data ' +
          'and reload" below to wipe IndexedDB for this app.'));
      }, OPEN_TIMEOUT_MS);

      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        for (const [name, cfg] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, {
              keyPath: cfg.keyPath,
              autoIncrement: cfg.autoIncrement,
            });
            (cfg.indexes || []).forEach(([idxName, keyPath, opts]) => {
              store.createIndex(idxName, keyPath, opts || {});
            });
          }
        }
      };
      req.onsuccess = () => {
        clearTimeout(timer);
        _db = req.result;
        // If another tab later opens the DB at a higher version, the
        // browser fires `versionchange` on this connection and blocks
        // that tab's upgrade until we close. Closing eagerly keeps the
        // app self-healing across reloads.
        _db.onversionchange = () => {
          try { _db.close(); } catch (_) { /* ignore */ }
          _db = null; _opening = null;
        };
        settle(resolve, _db);
      };
      req.onerror = () => {
        clearTimeout(timer);
        _opening = null;
        settle(reject, req.error);
      };
      // Fired when an open request can't run because another tab is still
      // holding an older version of the DB. Without this handler the
      // request just hangs forever.
      req.onblocked = () => {
        clearTimeout(timer);
        _opening = null;
        settle(reject, new Error(
          'IndexedDB upgrade blocked — another tab of this app is open ' +
          'with an older database version. Close the other tabs and reload.'));
      };
    });
    return _opening;
  }

  // Nuke the entire IndexedDB for this app and resolve once the browser
  // confirms the deletion. Used by the recovery UI when the DB is corrupt
  // or otherwise unreachable. Has its own timeout — when the browser's
  // IDB subsystem is wedged, deleteDatabase can hang the same way open
  // does, and we'd rather surface a clear error than spin forever.
  function deleteDB() {
    return new Promise((resolve, reject) => {
      try {
        if (_db) { try { _db.close(); } catch (_) { /* ignore */ } }
        _db = null; _opening = null;
        if (!('indexedDB' in window)) {
          reject(new Error('IndexedDB is not available in this browser.'));
          return;
        }
        let settled = false;
        const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };
        const timer = setTimeout(() => {
          settle(reject, new Error(
            'IndexedDB delete timed out after ' + OPEN_TIMEOUT_MS + 'ms — ' +
            'the browser\'s database subsystem is unresponsive. Try the ' +
            'manual recovery steps below.'));
        }, OPEN_TIMEOUT_MS);
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = () => { clearTimeout(timer); settle(resolve); };
        req.onerror   = () => { clearTimeout(timer); settle(reject, req.error); };
        // If another tab is holding the DB open, deleteDatabase fires
        // onblocked and waits — but we don't want to wait forever, so
        // surface a clear error after a short window.
        req.onblocked = () => {
          clearTimeout(timer);
          settle(reject, new Error(
            'Cannot reset: another tab is holding the database open. ' +
            'Close every other tab of this app and try again.'));
        };
      } catch (e) { reject(e); }
    });
  }

  // Best-effort diagnostic: which databases does the browser think exist
  // for this origin, and at what version? Returns null when the browser
  // doesn't expose `indexedDB.databases()` (older Safari) or it hangs.
  // Used by the recovery UI to tell users what state things are in.
  async function diagnose() {
    if (!('indexedDB' in window) || typeof indexedDB.databases !== 'function') {
      return { available: false, reason: 'indexedDB.databases() not supported' };
    }
    try {
      const list = await Promise.race([
        indexedDB.databases(),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error('databases() listing timed out')), 3000)),
      ]);
      return { available: true, databases: list || [] };
    } catch (e) {
      return { available: false, reason: e && e.message ? e.message : String(e) };
    }
  }

  // Open the DB at WHATEVER version is currently on disk — no upgrade
  // attempt. Used by the recovery UI: if the normal open() hangs because
  // its upgrade transaction is wedged, this one often still succeeds and
  // lets us read the existing data out for export or repair.
  // Returns a fresh, uncached IDBDatabase. Caller is responsible for
  // closing it when done.
  function openLegacy() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB is not available in this browser.'));
        return;
      }
      let settled = false;
      const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };
      const timer = setTimeout(() => {
        settle(reject, new Error(
          'IndexedDB legacy open timed out after ' + OPEN_TIMEOUT_MS + 'ms.'));
      }, OPEN_TIMEOUT_MS);

      // No version arg → browser opens at the existing on-disk version
      // and never fires onupgradeneeded.
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => { clearTimeout(timer); settle(resolve, req.result); };
      req.onerror   = () => { clearTimeout(timer); settle(reject, req.error); };
      req.onblocked = () => { clearTimeout(timer); settle(reject, new Error(
        'IndexedDB open blocked — another tab is holding the database.')); };
    });
  }

  // Walk every object store in `db` and read its rows into a plain object.
  // Returns the same shape as exportAll() so the existing import path can
  // consume it. Stores that vanished from the schema are still dumped if
  // they exist on disk — better to over-export than lose data.
  function dumpAll(db) {
    const names = Array.from(db.objectStoreNames);
    if (!names.length) {
      return Promise.resolve({
        schema: { name: DB_NAME, version: db.version, source: 'legacy-dump' },
        exported_at: new Date().toISOString(),
        data: {},
      });
    }
    return new Promise((resolve, reject) => {
      let pending = names.length;
      const data = {};
      let aborted = false;
      try {
        const t = db.transaction(names, 'readonly');
        t.onerror = () => { if (!aborted) { aborted = true; reject(t.error); } };
        t.onabort = () => { if (!aborted) { aborted = true; reject(t.error); } };
        names.forEach((name) => {
          const r = t.objectStore(name).getAll();
          r.onsuccess = () => {
            data[name] = r.result || [];
            pending--;
            if (pending === 0 && !aborted) {
              resolve({
                schema: { name: DB_NAME, version: db.version, source: 'legacy-dump' },
                exported_at: new Date().toISOString(),
                data,
              });
            }
          };
          r.onerror = () => { if (!aborted) { aborted = true; reject(r.error); } };
        });
      } catch (e) { reject(e); }
    });
  }

  // High-level "get me everything I can salvage" used by the recovery UI.
  // Opens at the existing on-disk version (skipping the broken upgrade),
  // dumps every store, closes the connection, and returns the dump.
  async function legacyExport() {
    const db = await openLegacy();
    try {
      const dump = await dumpAll(db);
      return dump;
    } finally {
      try { db.close(); } catch (_) { /* ignore */ }
    }
  }

  // Try to repair the local database in-place: dump current contents at
  // the existing on-disk version, delete the database, reopen at the
  // current target version (which triggers a clean upgrade onto an empty
  // store set), and write the dumped rows back. The caller can opt to
  // download a JSON safety copy first.
  //
  // Returns { dumped: <store->count>, restored: <store->count>, version }.
  async function repair() {
    // 1. Salvage what we can.
    const dump = await legacyExport();

    // 2. Wipe the wedged DB so the next open() gets a clean upgrade.
    await deleteDB();

    // 3. Open fresh — this triggers onupgradeneeded which builds the
    //    full v4 schema on an empty database. open() also sets _db so
    //    subsequent App.storage calls work normally without reload.
    const db = await open();

    // 4. Restore each store. Only restore stores that the new schema
    //    knows about — junk stores from old versions are dropped.
    const restored = {};
    const dumped = {};
    for (const [name, rows] of Object.entries(dump.data || {})) {
      dumped[name] = (rows || []).length;
      if (!STORES[name]) continue; // store no longer in the schema
      if (!rows || !rows.length) { restored[name] = 0; continue; }
      // Preserve the original keys (caller probably wants their existing
      // ids back). putMany uses .put which respects keyPath ids.
      await new Promise((resolve, reject) => {
        const t = db.transaction(name, 'readwrite');
        const s = t.objectStore(name);
        rows.forEach((r) => { try { s.put(r); } catch (_) { /* skip bad row */ } });
        t.oncomplete = () => resolve();
        t.onerror    = () => reject(t.error);
        t.onabort    = () => reject(t.error);
      });
      restored[name] = rows.length;
    }
    return { dumped, restored, version: db.version };
  }

  function tx(storeName, mode = 'readonly') {
    return open().then((db) => {
      const t = db.transaction(storeName, mode);
      return t.objectStore(storeName);
    });
  }

  function req2promise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror   = () => reject(request.error);
    });
  }

  function getAll(storeName) {
    return tx(storeName).then((s) => req2promise(s.getAll()));
  }
  function getOne(storeName, key) {
    return tx(storeName).then((s) => req2promise(s.get(key)));
  }
  function putOne(storeName, row) {
    return tx(storeName, 'readwrite').then((s) => req2promise(s.put(row)));
  }
  function deleteOne(storeName, key) {
    return tx(storeName, 'readwrite').then((s) => req2promise(s.delete(key)));
  }
  function clearStore(storeName) {
    return tx(storeName, 'readwrite').then((s) => req2promise(s.clear()));
  }

  // Bulk put into a single transaction; returns assigned keys.
  function putMany(storeName, rows) {
    if (!rows || rows.length === 0) return Promise.resolve([]);
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(storeName, 'readwrite');
      const s = t.objectStore(storeName);
      const keys = [];
      rows.forEach((r, i) => {
        const req = s.put(r);
        req.onsuccess = () => { keys[i] = req.result; };
      });
      t.oncomplete = () => resolve(keys);
      t.onerror    = () => reject(t.error);
      t.onabort    = () => reject(t.error);
    }));
  }

  function byIndex(storeName, indexName, value) {
    return open().then((db) => new Promise((resolve, reject) => {
      const s = db.transaction(storeName).objectStore(storeName);
      const idx = s.index(indexName);
      const req = idx.getAll(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    }));
  }

  function getOneByIndex(storeName, indexName, value) {
    return open().then((db) => new Promise((resolve, reject) => {
      const s = db.transaction(storeName).objectStore(storeName);
      const idx = s.index(indexName);
      const req = idx.get(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    }));
  }

  // ---------- high-level API ----------

  const transactions = {
    all:        () => getAll('transactions'),
    get:        (id) => getOne('transactions', id),
    byBatch:    (id) => byIndex('transactions', 'by_batch', id),
    putMany:    (rows) => putMany('transactions', rows),
    put:        (row) => putOne('transactions', row),
    update:     (row) => putOne('transactions', row),
    deleteByBatch(batchId) {
      return open().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction('transactions', 'readwrite');
        const s = t.objectStore('transactions');
        const idx = s.index('by_batch');
        const req = idx.openCursor(IDBKeyRange.only(batchId));
        let count = 0;
        req.onsuccess = (e) => {
          const cur = e.target.result;
          if (cur) { cur.delete(); count++; cur.continue(); }
        };
        t.oncomplete = () => resolve(count);
        t.onerror    = () => reject(t.error);
      }));
    },
    delete: (id) => deleteOne('transactions', id),
    clear:  ()   => clearStore('transactions'),
  };

  function simpleCRUD(storeName) {
    return {
      all:    () => getAll(storeName),
      put:    (row) => putOne(storeName, row),
      delete: (id)  => deleteOne(storeName, id),
      clear:  ()    => clearStore(storeName),
    };
  }

  async function exportAll() {
    const [tr, acc, cat, rul, imp, mer, nrm, csv] = await Promise.all([
      getAll('transactions'),
      getAll('accounts'),
      getAll('categories'),
      getAll('category_rules'),
      getAll('imports'),
      getAll('merchants').catch(() => []),
      getAll('normalize_rules').catch(() => []),
      getAll('csv_templates').catch(() => []),
    ]);
    return {
      schema: { name: 'kalkala-expense-dashboard', version: DB_VERSION },
      exported_at: new Date().toISOString(),
      data: { transactions: tr, accounts: acc, categories: cat,
              category_rules: rul, imports: imp, merchants: mer,
              normalize_rules: nrm, csv_templates: csv },
    };
  }

  async function importAll(json, opts) {
    opts = opts || { replace: false };
    if (!json || !json.data) throw new Error('Malformed backup: missing `data` field.');
    if (opts.replace) { await clearAll(); }
    const d = json.data;
    if (d.accounts)       await putMany('accounts', stripIds(d.accounts, opts.replace));
    if (d.categories)     await putMany('categories', stripIds(d.categories, opts.replace));
    if (d.category_rules) await putMany('category_rules', stripIds(d.category_rules, opts.replace));
    if (d.imports)        await putMany('imports', stripIds(d.imports, opts.replace));
    if (d.transactions)    await putMany('transactions', stripIds(d.transactions, opts.replace));
    if (d.merchants)       await putMany('merchants', stripIds(d.merchants, opts.replace));
    if (d.normalize_rules) await putMany('normalize_rules', stripIds(d.normalize_rules, opts.replace));
    if (d.csv_templates)   await putMany('csv_templates', stripIds(d.csv_templates, opts.replace));
    return {
      transactions:    (d.transactions || []).length,
      accounts:        (d.accounts || []).length,
      categories:      (d.categories || []).length,
      category_rules:  (d.category_rules || []).length,
      imports:         (d.imports || []).length,
      merchants:       (d.merchants || []).length,
      normalize_rules: (d.normalize_rules || []).length,
      csv_templates:   (d.csv_templates || []).length,
    };
  }

  // When appending (not replacing), drop existing IDs so new ones are generated.
  function stripIds(rows, replace) {
    if (replace) return rows;
    return rows.map((r) => {
      const c = Object.assign({}, r);
      delete c.id;
      return c;
    });
  }

  async function clearAll() {
    await Promise.all(Object.keys(STORES).map(clearStore));
  }

  const merchants = Object.assign(simpleCRUD('merchants'), {
    // Convenience: look up a row by the raw merchant string.
    getByOriginal: (original) => getOneByIndex('merchants', 'by_original', original),
  });

  App.storage = {
    open,
    deleteDB,
    legacyExport,
    repair,
    diagnose,
    transactions,
    accounts:   simpleCRUD('accounts'),
    categories: simpleCRUD('categories'),
    rules:      simpleCRUD('category_rules'),
    imports:    simpleCRUD('imports'),
    duplicateIgnores: simpleCRUD('duplicate_ignores'),
    merchants,
    normalizeRules: simpleCRUD('normalize_rules'),
    csvTemplates: simpleCRUD('csv_templates'),
    exportAll,
    importAll,
    clearAll,
  };
})();

# Contributing

Thanks for the interest. This is a small personal-expense dashboard with
a deliberately tiny toolchain — the whole app is static HTML and JS with
no build step — so the rules here are mostly about keeping it that way.

## Running locally

```sh
git clone https://github.com/<you>/expense-dashboard.git
cd expense-dashboard
# Option 1: just open the file
open index.html          # macOS
xdg-open index.html      # Linux

# Option 2: serve it (nicer for PDF imports)
python3 -m http.server 8000
# then http://localhost:8000/
```

There is no `npm install`. There is no bundler. There is no watcher.

## Before opening a PR

One check is effectively mandatory:

```sh
# Syntax-check every JS file in src/
find src -name '*.js' -print0 | xargs -0 -n1 node --check
```

Zero output means every file parses. Any error means the PR is not
ready.

Beyond that, a manual smoke test with a real statement (or the exported
sample JSON under Manage → Backups) is the honest way to confirm you
haven't broken the import pipeline.

## Module conventions

Every source file follows the same pattern:

```js
(function () {
  'use strict';
  const App = window.App = window.App || {};
  // ... module code ...
  App.myModule = { /* public surface */ };
})();
```

- No ES modules. No `import` / `export`. The app loads by dropping
  `<script>` tags in `index.html` in a fixed order — see the comment
  above that block.
- All cross-file references go through `window.App`. Never reach into
  another file's private functions.
- Templates register themselves onto `App.templates.registry` at load
  time; views register onto `App.views`; processing modules register
  onto `App.processing`.

## Where things live

| You want to…                                        | Touch…                              |
|-----------------------------------------------------|-------------------------------------|
| Add a bank                                          | `src/templates/<bank>.js`           |
| Change a route                                      | `src/features/<route>/`             |
| Change how duplicates are detected                  | `src/processing/duplicate.js`       |
| Change the auto-categorize rules engine             | `src/processing/categorize.js`      |
| Change the merchant beautifier / brand collapses    | `src/processing/normalize.js`       |
| Change IndexedDB schema / add a store               | `src/core/storage.js` (bump version)|
| Change shared helpers (`el`, formatters, toast)     | `src/core/util.js`                  |
| Add or restyle UI                                   | `src/styles.css`                    |

## Adding a new bank template

1. Copy one of `src/templates/n26.js` or `santander.js` as a starting
   point — they're the most representative of "line-oriented parser"
   and "multi-line block parser" respectively.
2. Implement a `match(firstPageText)` that returns `true` only on that
   bank's statement (keep it tight — false positives steal other banks'
   imports).
3. Implement `parse(allPagesText)` returning an array of
   `{ date, amount, currency, merchant, description?, original_text, ... }`
   records. Dates must be ISO `YYYY-MM-DD`.
4. Call `App.templates.register({ id, label, match, parse })` at the
   bottom of the IIFE.
5. Add the file to `index.html` in the templates block.

## IndexedDB changes

The schema is versioned via `DB_VERSION` in `src/core/storage.js`.

- **Bump the version** when adding a store or index. Migration happens
  in `open()`'s `onupgradeneeded` — existing stores survive; new ones
  are created.
- **Never rename a store** in place. Add the new one, mirror data, ship
  a migration, then delete the old store in a later release.
- `App.storage.repair()` exists for the "DB wedged at upgrade" case —
  it dumps, deletes, and rebuilds. Don't break that path.

## Style

- Two-space indentation, single quotes, trailing semicolons. Match the
  surrounding file.
- Prefer short, specific comments that answer *why*, not *what*. The
  existing codebase is comment-heavy on the unusual bits (retry loops,
  timeouts, parser quirks); follow that lead.
- No emojis in code. UI labels / README are fine.

## Privacy

This app never talks to a server. If your patch adds a `fetch` to any
non-CDN URL, the PR will be rejected on privacy grounds alone. The two
allowed remote loads are Chart.js and PDF.js, both from cdnjs with SRI
pins.

## Licensing

By contributing, you agree your changes are licensed under the MIT
License that applies to the rest of the project.

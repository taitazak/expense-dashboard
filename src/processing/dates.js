/*
 * src/processing/dates.js — date sanity utilities.
 *
 * Banks and PDF statements sometimes produce dates that are obviously wrong:
 * a statement for "Jan 2025" listing a Dec 30 booking which the template
 * resolves to Dec 30 2026 (future), or a two-digit year template that picks
 * the wrong century. The Santander resolver was the worst offender — we
 * fixed it to never emit a future date — but older imports still carry the
 * bad rows. These helpers run as a one-off migration on app boot (tracked
 * in localStorage), and also clamp at import-commit time so no new
 * offenders sneak in.
 *
 *   clampFutureDate("2026-12-30")  → "2025-12-30"   (today: 2026-04-23)
 *   clampFutureDate("2027-02-01")  → "2026-02-01"
 *   clampFutureDate("2024-05-11")  → "2024-05-11"   (already past; no-op)
 *
 * Shift is one year at a time, up to 10 iterations, so a date two years in
 * the future gets walked back twice. Bail with the original string (and a
 * console warning) if we can't land below today — the user can still fix
 * it by hand in Manage.
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};
  App.processing = App.processing || {};

  const MIGRATION_KEY = 'kalkala.future_dates_migrated.v1';
  const MAX_SHIFTS = 10;

  function todayEndOfDay() {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d;
  }

  function parseISO(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    // Accept "YYYY-MM-DD" (with optional time). We parse as local time so a
    // Dec 31 booking doesn't flip to Jan 1 the next morning in UTC.
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (!y || !mo || !d) return null;
    return new Date(y, mo - 1, d);
  }

  function toISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  // Clamp a future date backward in 1-year steps until it lands <= today.
  // Returns the adjusted ISO string, or the original if no change was
  // needed / possible.
  function clampFutureDate(dateStr) {
    const date = parseISO(dateStr);
    if (!date) return dateStr;
    const today = todayEndOfDay();
    if (date <= today) return dateStr;
    let d = new Date(date);
    for (let i = 0; i < MAX_SHIFTS; i++) {
      d = new Date(d.getFullYear() - 1, d.getMonth(), d.getDate());
      if (d <= today) return toISO(d);
    }
    console.warn('clampFutureDate: could not land', dateStr, 'under today after', MAX_SHIFTS, 'shifts');
    return dateStr;
  }

  // Returns true if the date is strictly in the future (past end of today).
  function isFutureDate(dateStr) {
    const date = parseISO(dateStr);
    if (!date) return false;
    return date > todayEndOfDay();
  }

  // Walk every stored transaction, clamp any future date back to a past year,
  // and also recompute the `year` field if present. Returns { scanned,
  // fixed, stillFuture } so callers can surface a toast. Safe to re-run.
  async function fixFutureDatesInStore() {
    const all = await App.storage.transactions.all();
    let scanned = 0, fixed = 0, stillFuture = 0;
    for (const row of all) {
      scanned++;
      if (!row || !row.date || !isFutureDate(row.date)) continue;
      const adjusted = clampFutureDate(row.date);
      if (adjusted === row.date) { stillFuture++; continue; }
      const next = Object.assign({}, row, { date: adjusted });
      // Keep `year` consistent so the Stats year-picker doesn't still list
      // the bad year.
      const parsed = parseISO(adjusted);
      if (parsed) next.year = parsed.getFullYear();
      await App.storage.transactions.put(next);
      fixed++;
    }
    return { scanned, fixed, stillFuture };
  }

  // Run the migration once per browser profile. The flag lives in
  // localStorage so the fix runs the first time the user opens the app
  // after this code ships, but never again automatically. Re-runs must be
  // triggered explicitly from Manage > Danger zone.
  async function runMigrationIfNeeded() {
    try {
      if (typeof localStorage === 'undefined') return null;
      if (localStorage.getItem(MIGRATION_KEY)) return null;
      const result = await fixFutureDatesInStore();
      localStorage.setItem(MIGRATION_KEY, new Date().toISOString());
      if (result.fixed) {
        console.info('Kalkala: fixed', result.fixed, 'future-dated transactions.');
      }
      return result;
    } catch (e) {
      console.warn('Kalkala date migration failed:', e);
      return null;
    }
  }

  App.processing.dates = {
    clampFutureDate, isFutureDate,
    fixFutureDatesInStore, runMigrationIfNeeded,
  };
})();

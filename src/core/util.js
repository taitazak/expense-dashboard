/*
 * src/core/util.js — small helpers shared by every view.
 *
 * Everything is attached to App.util. No external deps.
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};

  function escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    if (typeof unsafe !== 'string') unsafe = String(unsafe);
    return unsafe
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#039;');
  }

  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') n.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (k === 'dataset') { for (const [dk, dv] of Object.entries(v)) n.dataset[dk] = dv; }
        else if (v !== undefined && v !== null) n.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      if (typeof c === 'string' || typeof c === 'number') {
        n.appendChild(document.createTextNode(String(c)));
      } else if (Array.isArray(c)) {
        c.forEach((x) => { if (x) n.appendChild(x); });
      } else {
        n.appendChild(c);
      }
    }
    return n;
  }

  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  function monthName(n)  { return MONTHS[n - 1] || 'Unknown'; }
  function monthIndex(s) { return MONTHS.indexOf(s); }

  function parseISODate(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }

  // Locale-appropriate currency formatter. Caches formatters per currency.
  const _formatters = {};
  function formatCurrency(amount, currency) {
    currency = currency || 'EUR';
    if (!_formatters[currency]) {
      try {
        _formatters[currency] = new Intl.NumberFormat(undefined, {
          style: 'currency', currency,
          minimumFractionDigits: 2, maximumFractionDigits: 2,
        });
      } catch (e) {
        _formatters[currency] = { format: (n) => currency + ' ' + Number(n).toFixed(2) };
      }
    }
    return _formatters[currency].format(amount || 0);
  }

  function formatNumber(amount) {
    return new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(amount || 0);
  }

  // Very small pub-sub used by views to react to storage changes.
  const listeners = {};
  function on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); }
  function off(event, fn) {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter(f => f !== fn);
  }
  function emit(event, data) {
    (listeners[event] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'x'.replace(/[x]/g, () => (Math.random() * 16 | 0).toString(16)) +
      '-' + Date.now().toString(16);
  }

  function confirmAction(message) {
    return Promise.resolve(window.confirm(message));
  }

  /*
   * promptSelect — small modal dialog that asks the user to pick one of a
   * fixed set of options before proceeding. Resolves to the option's `value`
   * on confirm, or null on cancel.
   *
   * Usage:
   *   await App.util.promptSelect({
   *     title: 'Delete account',
   *     message: 'Move its transactions to…',
   *     options: [{ value: '', label: '— Leave unassigned —' }, { value: 3, label: 'N26 Main' }],
   *     confirmLabel: 'Delete & move',
   *     cancelLabel: 'Cancel',
   *     danger: true,
   *   });
   */
  function promptSelect(opts) {
    const options = Array.isArray(opts.options) ? opts.options : [];
    return new Promise((resolve) => {
      const overlay = el('div', { class: 'modal-overlay' });
      const box = el('div', { class: 'modal' });
      const select = el('select', { class: 'modal-select' },
        ...options.map(o => el('option', { value: String(o.value == null ? '' : o.value) }, o.label))
      );
      if (opts.defaultValue != null) select.value = String(opts.defaultValue);

      const cancel = el('button', {
        type: 'button', class: 'btn btn--ghost',
        onclick: () => { cleanup(); resolve(null); },
      }, opts.cancelLabel || 'Cancel');
      const confirmBtn = el('button', {
        type: 'button',
        class: 'btn ' + (opts.danger ? 'btn--danger' : 'btn--primary'),
        onclick: () => { const v = select.value; cleanup(); resolve(v); },
      }, opts.confirmLabel || 'Confirm');

      function onKey(e) {
        if (e.key === 'Escape') { cleanup(); resolve(null); }
        if (e.key === 'Enter') confirmBtn.click();
      }
      function cleanup() {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
      }
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { cleanup(); resolve(null); }
      });
      document.addEventListener('keydown', onKey);

      if (opts.title)   box.appendChild(el('h3', null, opts.title));
      if (opts.message) box.appendChild(el('p', { class: 'muted' }, opts.message));
      box.appendChild(select);
      box.appendChild(el('div', { class: 'modal-actions' }, cancel, confirmBtn));
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      setTimeout(() => select.focus(), 0);
    });
  }

  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'kalkala-export.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function toast(message, kind) {
    kind = kind || 'info';
    const t = el('div', { class: 'toast toast--' + kind }, message);
    document.body.appendChild(t);
    setTimeout(() => { t.classList.add('toast--leaving'); }, 2800);
    setTimeout(() => { t.remove(); }, 3300);
  }

  App.util = {
    escapeHtml, el, monthName, monthIndex, parseISODate,
    formatCurrency, formatNumber, on, off, emit, uuid,
    confirmAction, promptSelect, downloadJSON, toast,
  };
})();

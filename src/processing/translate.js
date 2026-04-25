/*
 * src/processing/translate.js — non-English → English category names.
 *
 * Banks and personal-finance exports often emit category names in the
 * local language (N26 → German, Santander/ActivoBank → Portuguese,
 * Bank Leumi → Hebrew). We normalise everything to English at import
 * time so:
 *   - the same merchant in two banks ("Lebensmittel" in N26, "Groceries"
 *     in Santander, "מזון" in Leumi) collapses into one category for
 *     stats and rules
 *   - users only see English labels in pickers, charts, and rules — no
 *     mixed-language category lists
 *
 * Called at:
 *   - categorize.js  — translates `bankCat` before it's accepted as the
 *     row's category (so the German source becomes English in storage)
 *   - csv.js         — translates the value of a CSV's category column
 *     (so a CSV exported from a German-language banking app comes in
 *     with English categories)
 *
 * Adding a translation: append to TRANSLATIONS below. Keys are
 * lowercased and trimmed before lookup, so casing doesn't matter on
 * the input side. The mapping is intentionally curated, not algorithmic
 * (machine translation would be overkill for ~50 strings and would
 * sometimes pick the wrong English equivalent).
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};
  App.processing = App.processing || {};

  // Lookup table — lowercased on the LEFT, canonical English on the
  // RIGHT. Order doesn't matter; map lookup is O(1).
  //
  // Coverage targets the three template languages we ship plus a
  // smattering of common French / Spanish / Italian terms in case a
  // user CSV-exports from a Bank-X-in-French app.
  const TRANSLATIONS = {
    // ===== German (N26, ING-DiBa, others) =====
    'lebensmittel':                 'Groceries',
    'lebensmittelgeschäfte':        'Groceries',
    'einkaufen':                    'Shopping',
    'shopping':                     'Shopping',
    'restaurants & cafés':          'Restaurants & Cafés',
    'restaurants':                  'Restaurants & Cafés',
    'gastronomie':                  'Restaurants & Cafés',
    'bars & restaurants':           'Bars & Restaurants',
    'transport':                    'Transport',
    'transport & auto':             'Transport',
    'reisen':                       'Travel',
    'urlaub':                       'Travel',
    'unterkunft':                   'Accommodation',
    'wohnen':                       'Housing',
    'miete':                        'Rent',
    'miete & nebenkosten':          'Housing',
    'haushalt':                     'Household',
    'nebenkosten':                  'Utilities',
    'strom':                        'Utilities',
    'gas':                          'Utilities',
    'wasser':                       'Utilities',
    'internet & telefon':           'Internet & Phone',
    'telekommunikation':            'Internet & Phone',
    'versicherung':                 'Insurance',
    'versicherungen':               'Insurance',
    'gesundheit':                   'Healthcare',
    'gesundheit & wellness':        'Healthcare',
    'apotheke':                     'Healthcare',
    'sport & freizeit':             'Leisure',
    'freizeit':                     'Leisure',
    'unterhaltung':                 'Entertainment',
    'medien & unterhaltung':        'Entertainment',
    'bildung':                      'Education',
    'bargeld':                      'Cash',
    'geldautomat':                  'Cash',
    'bankgebühren':                 'Bank',
    'gebühren':                     'Fees',
    'einkommen':                    'Income',
    'gehalt':                       'Salary',
    'lohn':                         'Salary',
    'gutschrift':                   'Income',
    'überweisung':                  'Transfer',
    'sparen':                       'Savings',
    'investitionen':                'Investments',
    'spenden':                      'Donations',
    'geschenke':                    'Gifts',
    'kinder':                       'Family',
    'haustiere':                    'Pets',
    'sonstiges':                    'Other',
    'unkategorisiert':              'Uncategorized',
    'nicht kategorisiert':          'Uncategorized',

    // ===== Portuguese (Santander PT, ActivoBank, generic apps) =====
    'alimentação':                  'Groceries',
    'supermercado':                 'Groceries',
    'mercearia':                    'Groceries',
    'compras':                      'Shopping',
    'restauração':                  'Restaurants & Cafés',
    'restaurantes':                 'Restaurants & Cafés',
    'café':                         'Restaurants & Cafés',
    'transportes':                  'Transport',
    'combustível':                  'Transport',
    'viagens':                      'Travel',
    'férias':                       'Travel',
    'alojamento':                   'Accommodation',
    'habitação':                    'Housing',
    'renda':                        'Rent',
    'água':                         'Utilities',
    'eletricidade':                 'Utilities',
    'telecomunicações':             'Internet & Phone',
    'telemóvel':                    'Internet & Phone',
    'seguros':                      'Insurance',
    'saúde':                        'Healthcare',
    'farmácia':                     'Healthcare',
    'lazer':                        'Leisure',
    'entretenimento':               'Entertainment',
    'educação':                     'Education',
    'levantamento':                 'Cash',
    'comissões':                    'Fees',
    'rendimento':                   'Income',
    'salário':                      'Salary',
    'transferência':                'Transfer',
    'poupança':                     'Savings',
    'investimentos':                'Investments',
    'donativos':                    'Donations',
    'presentes':                    'Gifts',
    'animais':                      'Pets',
    'outros':                       'Other',
    'sem categoria':                'Uncategorized',

    // ===== Hebrew (Bank Leumi, generic Israeli banks) =====
    'מזון':                          'Groceries',
    'סופרמרקט':                      'Groceries',
    'קניות':                         'Shopping',
    'מסעדות':                        'Restaurants & Cafés',
    'בתי קפה':                       'Restaurants & Cafés',
    'תחבורה':                        'Transport',
    'דלק':                           'Transport',
    'נסיעות':                        'Travel',
    'דיור':                          'Housing',
    'שכר דירה':                      'Rent',
    'חשבונות':                       'Utilities',
    'חשמל':                          'Utilities',
    'מים':                           'Utilities',
    'אינטרנט':                       'Internet & Phone',
    'טלפון':                         'Internet & Phone',
    'ביטוח':                         'Insurance',
    'בריאות':                        'Healthcare',
    'בית מרקחת':                     'Healthcare',
    'פנאי':                          'Leisure',
    'בידור':                         'Entertainment',
    'חינוך':                         'Education',
    'מזומן':                         'Cash',
    'עמלות':                         'Fees',
    'הכנסה':                         'Income',
    'משכורת':                        'Salary',
    'העברה':                         'Transfer',
    'חיסכון':                        'Savings',
    'השקעות':                        'Investments',
    'תרומות':                        'Donations',
    'מתנות':                         'Gifts',
    'משפחה':                         'Family',
    'חיות מחמד':                     'Pets',
    'אחר':                           'Other',
    'לא מסווג':                      'Uncategorized',

    // ===== French (occasional CSV exports) =====
    'alimentation':                 'Groceries',
    'supermarché':                  'Groceries',
    'achats':                       'Shopping',
    'restauration':                 'Restaurants & Cafés',
    'restaurants & cafés':          'Restaurants & Cafés',
    'voyages':                      'Travel',
    'logement':                     'Housing',
    'loyer':                        'Rent',
    'santé':                        'Healthcare',
    'loisirs':                      'Leisure',
    'divertissement':               'Entertainment',
    'éducation':                    'Education',
    'liquide':                      'Cash',
    'frais':                        'Fees',
    'revenu':                       'Income',
    'salaire':                      'Salary',
    'virement':                     'Transfer',
    'épargne':                      'Savings',
    'autres':                       'Other',

    // ===== Spanish (occasional CSV exports) =====
    'alimentación':                 'Groceries',
    'supermercados':                'Groceries',
    'restauración / bares':         'Restaurants & Cafés',
    'transporte':                   'Transport',
    'viajes':                       'Travel',
    'vivienda':                     'Housing',
    'alquiler':                     'Rent',
    'salud':                        'Healthcare',
    'ocio':                         'Leisure',
    'educación':                    'Education',
    'efectivo':                     'Cash',
    'comisiones':                   'Fees',
    'ingresos':                     'Income',
    'sueldo':                       'Salary',
    'salario':                      'Salary',
    'transferencia':                'Transfer',
    'ahorros':                      'Savings',
    'inversiones':                  'Investments',
    'otros gastos':                 'Other',
    'sin categoría':                'Uncategorized',

    // ===== Italian =====
    'alimentari':                   'Groceries',
    'shopping / acquisti':          'Shopping',
    'ristoranti':                   'Restaurants & Cafés',
    'trasporti':                    'Transport',
    'viaggi':                       'Travel',
    'casa':                         'Housing',
    'affitto':                      'Rent',
    'salute':                       'Healthcare',
    'tempo libero':                 'Leisure',
    'intrattenimento':              'Entertainment',
    'istruzione':                   'Education',
    'contanti':                     'Cash',
    'commissioni':                  'Fees',
    'reddito':                      'Income',
    'stipendio':                    'Salary',
    'bonifico':                     'Transfer',
    'risparmi':                     'Savings',
    'investimenti':                 'Investments',
    'altro':                        'Other',
    'senza categoria':              'Uncategorized',
  };

  // Look up a category string. Returns the canonical English name when
  // we have a translation, or the input unchanged when we don't (so
  // already-English categories pass through, and unknown-language
  // strings stay readable rather than getting silently wiped). Always
  // returns a string; null/undefined input → ''.
  function translateCategory(raw) {
    if (raw == null) return '';
    const s = String(raw).trim();
    if (!s) return '';
    const key = s.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(TRANSLATIONS, key)) {
      return TRANSLATIONS[key];
    }
    return s;
  }

  // Bulk variant: handy for tests / future legacy-data fixers.
  function translateAll(values) {
    return (values || []).map(translateCategory);
  }

  // Expose the table itself so test harnesses / debug tooling can audit
  // coverage. Don't mutate it from outside.
  App.processing.translate = {
    translateCategory,
    translateAll,
    TRANSLATIONS,
  };
})();

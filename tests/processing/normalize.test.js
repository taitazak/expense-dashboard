'use strict';
/* tests/processing/normalize.test.js — merchant beautifier + brand collapse +
 * canonical tx-type vocabulary. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProcessing } = require('../helpers/load.js');

function N() {
  const App = loadProcessing();
  return App.processing.normalize;
}

// ---------- beautifyMerchant: prefix stripping ---------------------------

test('beautifyMerchant: strips Portuguese COMPRA prefix + card last-4', () => {
  const b = N().beautifyMerchant;
  assert.equal(b('COMPRA 9723 LIDL LISBOA'), 'Lidl');
  assert.equal(b('COMPRA 1234 PINGO DOCE LISBOA'), 'Pingo Doce');
});

test('beautifyMerchant: strips Santander/Activo TRF prefixes', () => {
  const b = N().beautifyMerchant;
  // TRF.IMED. P/ recipient. Title-caser keeps short connectors ("da")
  // lowercase, so do a case-insensitive match.
  assert.match(b('TRF.IMED. P/ 12345 JOAO DA SILVA'), /Joao da Silva/i);
  // TRF CRED SEPA+
  assert.match(b('TRF CRED SEPA+ DE EMPRESA SA'), /Empresa/i);
});

test('beautifyMerchant: strips German KARTENZAHLUNG / LASTSCHRIFT', () => {
  const b = N().beautifyMerchant;
  assert.match(b('KARTENZAHLUNG REWE BERLIN'), /REWE/i);
  assert.match(b('LASTSCHRIFT VATTENFALL STROM'), /Vattenfall/);
});

test('beautifyMerchant: strips PAG SERVICOS prefix', () => {
  const b = N().beautifyMerchant;
  assert.match(b('PAG SERVICOS EDP COMERCIAL'), /EDP/i);
  assert.match(b('PAG SERV NOS COMUNICACOES'), /NOS/i);
});

test('beautifyMerchant: strips contactless / POS / direct-debit prefixes', () => {
  const b = N().beautifyMerchant;
  assert.match(b('CONTACTLESS PAYMENT TO STARBUCKS'), /Starbucks/);
  assert.match(b('POS LIDL'), /Lidl/i);
});

// ---------- beautifyMerchant: MB Way special path ------------------------

test('beautifyMerchant: MB Way masked recipient kept verbatim', () => {
  const b = N().beautifyMerchant;
  assert.equal(b('TRF MBWAY P/XXXXX2818'), 'P/XXXXX2818');
  assert.equal(b('MB WAY P/ ****8317'),    'P/ ****8317');
  assert.equal(b('MB WAY PARA *****6789'), '*****6789');
});

test('beautifyMerchant: MB Way real-name tail title-cases', () => {
  const b = N().beautifyMerchant;
  assert.equal(b('Mbway-Ana M Cunha Carvalho'), 'Ana M Cunha Carvalho');
});

test('beautifyMerchant: bare MB Way (no tail) → "MB Way"', () => {
  const b = N().beautifyMerchant;
  assert.equal(b('TRF MBWAY'), 'MB Way');
});

// ---------- beautifyMerchant: payment-provider stripping -----------------

test('beautifyMerchant: PayPal *MERCHANT → MERCHANT (recursed)', () => {
  const b = N().beautifyMerchant;
  assert.match(b('PAYPAL *LINKEDIN'), /LinkedIn/);
  assert.match(b('PAYPAL *SPOTIFY'), /Spotify/);
});

test('beautifyMerchant: SumUp / Stripe / Klarna get stripped too', () => {
  const b = N().beautifyMerchant;
  assert.match(b('SUMUP *CAFE NICOLA'), /Cafe Nicola/i);
  assert.match(b('STRIPE *VAPIANO'), /Vapiano/i);
});

// ---------- beautifyMerchant: brand collapses ----------------------------

test('beautifyMerchant: brand collapse keeps brand even with city/IDs/dates', () => {
  const b = N().beautifyMerchant;
  assert.equal(b('LUFTHANSAFLT0193 BERLIN'),     'Lufthansa');
  assert.equal(b('EDEKA SUPERMARKT BERLIN 123'), 'Edeka');
  assert.equal(b('AUCHAN12LIS'),                 'Auchan');
});

test('beautifyMerchant: bolt.eu/o/24-05-12 collapses to Bolt', () => {
  const b = N().beautifyMerchant;
  assert.equal(b('BOLT.EU/O/24-05-12'), 'Bolt');
});

test('beautifyMerchant: airline keywords (Ryanair, EasyJet, TAP) collapse', () => {
  const b = N().beautifyMerchant;
  assert.equal(b('RYANAIR LIM DUBLIN'),    'Ryanair');
  assert.equal(b('EASY JET LONDON'),       'EasyJet');
  assert.equal(b('TAP AP LISBOA'),         'TAP');
});

// ---------- title-casing + special-case map ------------------------------

test('beautifyMerchant: SPECIAL_CASE map keeps canonical capitalisation', () => {
  const b = N().beautifyMerchant;
  assert.equal(b('PAYPAL'),    'PayPal');
  assert.equal(b('IKEA'),      'IKEA');
  assert.equal(b('YOUTUBE'),   'YouTube');
  assert.equal(b('LINKEDIN'),  'LinkedIn');
  assert.equal(b('GITHUB'),    'GitHub');
});

test('beautifyMerchant: all-caps strings get title-cased', () => {
  const b = N().beautifyMerchant;
  assert.equal(b('SAMPLE MERCHANT NAME'), 'Sample Merchant Name');
});

test('beautifyMerchant: mixed-case is left alone', () => {
  const b = N().beautifyMerchant;
  assert.equal(b('SoundCloud Premium'), 'SoundCloud Premium');
});

test('beautifyMerchant: empty / null → empty string', () => {
  const b = N().beautifyMerchant;
  assert.equal(b(''),          '');
  assert.equal(b(null),        '');
  assert.equal(b(undefined),   '');
});

test('beautifyMerchant: strips embedded dates (YYYY-MM-DD)', () => {
  const b = N().beautifyMerchant;
  // Date should be stripped, not eaten entirely.
  const out = b('LUFTHANSA 2024-08-17');
  assert.match(out, /Lufthansa/);
});

test('beautifyMerchant: strips trailing card-tail digits', () => {
  const b = N().beautifyMerchant;
  // The "*8317" / "**1234" tails come off.
  assert.equal(b('Acme Corp **1234'),     'Acme Corp');
  assert.equal(b('Acme Corp 20240522101040090'), 'Acme Corp');
});

// ---------- buildMerchantResolver ----------------------------------------

test('buildMerchantResolver: exact override wins over beautifier', () => {
  const N1 = N();
  const resolver = N1.buildMerchantResolver([
    { original: 'COMPRA 9723 LIDL LISBOA', display: 'Lidl Custom', updated_at: '2026' },
  ]);
  assert.equal(resolver('COMPRA 9723 LIDL LISBOA'), 'Lidl Custom');
});

test('buildMerchantResolver: cross-bank brand override propagates to siblings', () => {
  const N1 = N();
  // A user renamed "LUFTHANSAFLT0193 BERLIN" to "Lufthansa Business" — the
  // resolver should propagate to OTHER Lufthansa-tabled variants because
  // they all beautify to "Lufthansa". Variants that don't beautify to
  // "Lufthansa" (e.g. bare "LH" tail without the full word) won't.
  const resolver = N1.buildMerchantResolver([
    { original: 'LUFTHANSAFLT0193 BERLIN', display: 'Lufthansa Business', updated_at: '2026' },
  ]);
  assert.equal(resolver('LUFTHANSA AMS-LIS'),  'Lufthansa Business');
  assert.equal(resolver('LUFTHANSA 12 BERLIN'), 'Lufthansa Business');
});

test('buildMerchantResolver: empty store → identity-via-beautifier', () => {
  const N1 = N();
  const resolver = N1.buildMerchantResolver([]);
  assert.equal(resolver('COMPRA 9723 LIDL LISBOA'), 'Lidl');
  assert.equal(resolver('Just Some Merchant'),       'Just Some Merchant');
});

// ---------- normalizeTxType ----------------------------------------------

test('normalizeTxType: vocabulary words pass through (case-insensitive)', () => {
  const N1 = N();
  assert.equal(N1.normalizeTxType('Card'),         'Card');
  assert.equal(N1.normalizeTxType('card'),         'Card');
  assert.equal(N1.normalizeTxType('Direct Debit'), 'Direct Debit');
});

test('normalizeTxType: common bank tokens map to vocabulary', () => {
  const N1 = N();
  assert.equal(N1.normalizeTxType('CARD_PURCHASE'),                'Card');
  assert.equal(N1.normalizeTxType('Mastercard'),                   'Card');
  assert.equal(N1.normalizeTxType('SEPA_TRANSFER_OUT'),            'Transfer');
  assert.equal(N1.normalizeTxType('Lastschrift'),                  'Direct Debit');
  assert.equal(N1.normalizeTxType('Direct Debits'),                'Direct Debit');
  assert.equal(N1.normalizeTxType('MBWAY P/'),                     'MB Way');
  assert.equal(N1.normalizeTxType('MB WAY'),                       'MB Way');
  assert.equal(N1.normalizeTxType('ATM withdrawal'),               'ATM');
  assert.equal(N1.normalizeTxType('CASH WITHDRAWAL'),              'ATM');
  assert.equal(N1.normalizeTxType('Bauausgleich Entgelt'),         'Fee');
  assert.equal(N1.normalizeTxType('NON SEPA TRANSFER FEE'),        'Fee');
  assert.equal(N1.normalizeTxType('Wertpapierkauf'),               'Other');   // securities → Other
});

test('normalizeTxType: gibberish → Other', () => {
  const N1 = N();
  assert.equal(N1.normalizeTxType('xxxx unrecognised'), 'Other');
  assert.equal(N1.normalizeTxType(''),                  'Other');
  assert.equal(N1.normalizeTxType(null),                'Other');
});

test('normalizeTxType: accent-insensitive match', () => {
  const N1 = N();
  assert.equal(N1.normalizeTxType('Überweisung'),  'Transfer');
  assert.equal(N1.normalizeTxType('UEBERWEISUNG'), 'Transfer');
  assert.equal(N1.normalizeTxType('DEBITO DIRETO'), 'Direct Debit');
});

test('TX_TYPE_VOCAB: 7 canonical entries', () => {
  const N1 = N();
  assert.deepEqual(N1.TX_TYPE_VOCAB,
    ['Card', 'Transfer', 'MB Way', 'ATM', 'Direct Debit', 'Fee', 'Other']);
});

// ---------- regex helpers ------------------------------------------------

test('escapeRegex: special chars are escaped', () => {
  const N1 = N();
  assert.equal(N1.escapeRegex('a.b*c?'), 'a\\.b\\*c\\?');
  assert.equal(N1.escapeRegex('(Acme)'), '\\(Acme\\)');
});

test('validateBrandPattern: bad regex caught, valid passes', () => {
  const N1 = N();
  const err = N1.validateBrandPattern('foo[bar', 'i');
  assert.ok(typeof err === 'string' && err.length > 0,
    'expected an error string, got ' + JSON.stringify(err));
  assert.match(err, /Invalid regex/);
  assert.equal(N1.validateBrandPattern('\\bLUFTHANSA', 'i'), null);
});

test('validateBrandPattern: empty pattern rejected', () => {
  const N1 = N();
  assert.equal(N1.validateBrandPattern('', 'i'), 'Pattern cannot be empty');
});

test('defaultBrandCollapses: returns full seed array', () => {
  const N1 = N();
  const arr = N1.defaultBrandCollapses();
  assert.ok(Array.isArray(arr) && arr.length > 10);
  // Every entry has the storage shape.
  for (const r of arr) {
    assert.ok(typeof r.pattern === 'string');
    assert.ok(typeof r.display === 'string');
    assert.equal(r.source, 'default');
  }
});

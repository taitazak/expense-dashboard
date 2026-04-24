/*
 * src/processing/normalize.js — merchant name beautifier.
 *
 * Bank statements carry noisy merchant strings like:
 *   "COMPRA 9723 TICKET LINE SA LISBOA"
 *   "TRF MB WAY P/ ****8317"
 *   "MEDIS-PAG SERVICOS 20240522101040090"
 *   "PAYPAL *LINKEDIN"
 *
 * For statistics we want to collapse these into a clean human name like
 * "Ticket Line", "MB Way", "Medis", "PayPal — LinkedIn".
 *
 * Two pieces live here:
 *   - beautifyMerchant(raw): a best-effort default for the "Manage Merchants"
 *     tab to show as a suggestion. The user always gets the final say.
 *   - buildMerchantResolver(rows): takes an array of merchants store rows and
 *     returns a function (original) -> display name, preferring a stored
 *     override and falling back to beautifyMerchant().
 *
 * This is a pure module with no side effects — safe to require from any view.
 */
(function () {
  'use strict';
  const App = window.App = window.App || {};
  App.processing = App.processing || {};

  // Ordered list: each prefix (case-insensitive) is stripped from the front
  // if present. Order matters — longer / more specific first.
  //
  // Portuguese note: Santander and ActivoBank statements lead each row with
  // a transaction-type token (TRF, TRF.IMED, TRF CRED, COMPRA 1234, PAG
  // SERVICOS, COB.REC, CRED., DD, MANUTENCAO, …). These are derived bank
  // jargon, never part of the merchant name. We strip them off aggressively
  // so the remainder — the actual merchant / recipient — can be title-cased.
  const PREFIX_RE = new RegExp(
    '^(?:' + [
      // Portuguese / generic card terminal prefixes.
      // "COMPRA 9723 LIDL ..." — the 4-digit tail is the card's last-4.
      'COMPRA\\s+ESTRANG\\.?\\s+\\d+\\s+',
      'COMPRA\\s+ESTRANG\\.?\\s+',
      'COMPRA\\s+\\d+\\s+',
      'COMPRA\\s+',
      // "CRED. 9723 FOO" — card refund with last-4 of the card.
      'CRED\\.\\s+\\d+\\s+',
      'CRED\\.\\s+',
      // Transfer families. TRF.IMED (instant) / TRF CRED SEPA / TRF COBR DUC
      // / TRF MBWAY all need specific handling; the bare "TRF " catch is
      // last so it doesn't swallow them. The trailing `\\d+\\s+` swallows
      // the recipient's masked account number when Santander emits it as a
      // bare numeric run (e.g. "TRF.IMED. P/ 12345 JOAO DA SILVA").
      'TRF\\.IMED\\.?\\s+(?:(?:P\\/|PARA|DE|TO)\\s*)?(?:\\d+\\s+)?',
      'TRF\\s+CRED\\.?\\s+SEPA\\+?\\s+(?:(?:P\\/|PARA|DE|TO)\\s*)?(?:\\d+\\s+)?',
      'TRF\\.?\\s+COBR\\.?\\s+DUC\\s+',
      'TRANSFERENCIA\\s+SPGT\\s+',
      'TRANSFERENCIA\\s+(?:PARA|DE|P\\/)?\\s*',
      'TRF\\s+(?:PARA|DE|P\\/)?\\s*',
      // Direct-debit / collection tokens.
      'COB\\.REC\\.?\\s+',
      'DEB\\s+DIR\\.?\\s+',
      'DEBITO\\s+DIRECTO\\s+',
      'D[ÉE]BITO\\s+DIRETO\\s+',
      'DD\\s+',
      // Service payments — "PAG SERVICOS …" is common enough to warrant a
      // specific strip so the service name (e.g. "MEDIS") surfaces cleanly.
      // "PAG ESTADO …" is deliberately not collapsed: leaving "Estado" in
      // place gives government payments a recognisable label instead of a
      // bare tax ID.
      'PAG(?:AMENTO)?\\s+SERVICO(?:S)?\\s+',
      'PAG(?:AMENTO)?\\s+SERV\\.?\\s+',
      'PAGAMENTO\\s+',
      'PAGTO\\s+',
      'PAG\\s+',
      // ATM / cash tokens.
      'LEV\\.?\\s+(?:ATM|MB)\\s+',
      'LEVANTAMENTO\\s+',
      // Spanish.
      'COMPRA\\s+EN\\s+',
      'PAGO\\s+(?:CON\\s+TARJETA\\s+)?EN\\s+',
      'BIZUM\\s+(?:A|DE)\\s+',
      // German / N26.
      'KARTENZAHLUNG\\s+',
      'ÜBERWEISUNG\\s+(?:AN|VON)\\s+',
      'LASTSCHRIFT\\s+',
      // English / generic. Order matters: longer specific prefixes first
      // so they win over their shorter variants via left-to-right matching.
      'CONTACTLESS\\s+PAYMENT\\s+TO\\s+',
      'CONTACTLESS\\s+PAYMENT\\s+',
      'CONTACTLESS\\s+',
      'CARD\\s+PAYMENT\\s+TO\\s+',
      'PAYMENT\\s+TO\\s+',
      'POS\\s+',
      'DIRECT\\s+DEBIT\\s+',
      'PURCHASE\\s+',
    ].join('|') + ')',
    'i'
  );

  // Payment-gateway prefixes. These aren't the merchant — the actual
  // merchant is in whatever follows the "*" (or trailing space). We strip
  // the provider and recurse on the remainder. If nothing sensible remains
  // we fall back to the provider name itself.
  //
  // Add new providers here. The separator is any "*"/"-" run so both
  // "PAYPAL *FOO" and "HIPAY-FOO" land on the same path.
  const PAYMENT_PROVIDER_RE = new RegExp(
    '^(?:' + [
      'PAYPAL',
      'SUMUP',
      'SP',            // SumUp's other prefix
      'SQ',            // Square
      'SQUARE',
      'IZETTLE',
      'ZETTLE',
      'STRIPE',
      'KLARNA',
      'ADYEN',
      'REVOLUT\\s+PAY',
      'APPLE\\s+PAY',
      'GOOGLE\\s+PAY',
      'MOLLIE',
      // Additional European / card-present acquirers.
      'HIPAY',
      'WORLDPAY',
      'CHECKOUT(?:\\.COM)?',
      'NEXI',
      'REDSYS',
      'IYZICO',
      'VIVA\\s+WALLET',
    ].join('|') + ')' +
    '\\s*[\\*\\-]\\s*(.+)$',
    'i'
  );

  // Strip card tails and id soup from the trailing end.
  const SUFFIX_STRIPS = [
    /\s*\*+\d{3,}\s*$/,                // "*8317", "***1234"
    /\s+\d{10,}\s*$/,                  // "20240522101040090"
    /\s+\d{4,}\s*$/,                   // trailing 4+ digit codes
    /\s+SG\s+PTE\.?\s+LTD\.?\s*$/i,    // corporate tails
    /\s+(?:SA|S\.A\.|LTD\.?|LLC|INC\.?|GMBH|SRL|UNIPESSOAL)\s*$/i,
    /\s+(?:LISBOA|PORTO|MADRID|BERLIN|LONDON|PARIS|AMSTERDAM|BARCELONA)\s*$/i,
  ];

  // Middle noise to drop before title-casing. Order matters: strip
  // longest/most-specific first, then shorter tails.
  const MIDDLE_STRIPS = [
    /\bCONTACTLESS\b/ig,               // Contactless is a payment method, not the merchant
    // Date tokens — airlines/transports/ride-hailing love to embed the
    // travel or ride date in the merchant string (e.g. "LUFTHANSA
    // 2024-08-17" or "BOLT.EU/O/24-05-12"). Strip the date so identical
    // trips on different days group together.
    /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g,                        // 2024-08-17 / 2024/08/17
    /\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g,                      // 17-08-2024 / 17/08/24
    /\b\d{1,2}\s+(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?\s+\d{2,4}\b/ig, // 17 AUG 2024
    /\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?\s+\d{1,2},?\s+\d{2,4}\b/ig, // AUG 17 2024
    /\b\d{1,2}[-\/]\d{1,2}\b(?!\d)/g,                            // 17-08 / 05/12
    // Common path-style dates inside merchant strings (Bolt/Uber/Lyft):
    /\b[A-Z]{2,}\.(?:EU|COM|IO)\/[A-Z0-9\/]+/g,
  ];

  // Big retailers that show up with wildly different tails on statements
  // (city, store number, id soup). The brand alone is a much better
  // grouping key, so we collapse any hit to the canonical display name.
  // Check AFTER prefix stripping so "COMPRA 1234 EDEKA ..." still hits.
  // Brand patterns deliberately use a *leading* \b only — no trailing
  // boundary. Banks happily glue numeric tails or city codes onto the brand
  // name with no separator (e.g. "LUFTHANSAFLT0193", "AUCHAN12LIS"), and a
  // trailing \b would miss those. Order is "longest/most-specific first" so
  // a generic word doesn't beat a multi-word brand.
  //
  // This array is the seed for the persisted `normalize_rules` IDB store —
  // on first boot every default lands in storage with `source: 'default'` so
  // the user can audit, edit, or delete them in Manage > Categorisation. At
  // runtime, beautifyMerchant() reads from `_activeBrandCollapses` (loaded
  // from storage), falling back to this in-memory list if storage hasn't
  // been initialised yet (e.g. during tests).
  const DEFAULT_BRAND_COLLAPSES = [
    // Grocers / drugstores.
    { re: /\bEDEKA/i,            display: 'Edeka' },
    { re: /\bREWE/i,             display: 'REWE' },
    { re: /\bROSSMANN/i,         display: 'Rossmann' },
    { re: /\bAUCHAN/i,           display: 'Auchan' },
    { re: /\bPINGO\s*DOCE/i,     display: 'Pingo Doce' },
    { re: /\bNETO\b/i,           display: 'Neto' },
    { re: /\bLIDL/i,             display: 'Lidl' },
    { re: /\bALDI/i,             display: 'Aldi' },
    { re: /\bMERCADONA/i,        display: 'Mercadona' },
    { re: /\bCARREFOUR/i,        display: 'Carrefour' },
    { re: /\bCONTINENTE/i,       display: 'Continente' },
    // dm — drogerie markt. The brand is two letters, so we anchor it to a
    // companion word ("drogerie", "markt", "filiale", or a "-" separator) to
    // avoid hitting random "DM" tokens like dates or codes.
    { re: /\bDM[\s-]?(?:DROGERIE|MARKT|FILIALE)/i, display: 'dm' },
    // Home / lifestyle stores.
    { re: /\bESPA[CÇ]O\s*CASA/i, display: 'Espaço Casa' },
    // Airlines — statements stamp the travel date, booking reference, and
    // sometimes a city, so we'd otherwise see dozens of unique rows for a
    // single carrier. Collapse to the brand.
    { re: /\bLUFTHANSA/i,        display: 'Lufthansa' },
    { re: /\bRYANAIR/i,          display: 'Ryanair' },
    { re: /\bWIZZ(?:\s*AIR)?/i,  display: 'Wizz Air' },
    { re: /\bEASYJET/i,          display: 'EasyJet' },
    { re: /\bEASY\s*JET/i,       display: 'EasyJet' },
    { re: /\bKLM\b/i,            display: 'KLM' },
    { re: /\bIBERIA/i,           display: 'Iberia' },
    { re: /\bVUELING/i,          display: 'Vueling' },
    { re: /\bAIR\s*FRANCE/i,     display: 'Air France' },
    { re: /\bAIR\s*SERBIA/i,     display: 'Air Serbia' },
    { re: /\bBRITISH\s*AIRWAYS/i, display: 'British Airways' },
    { re: /\bTAP\s*(?:AIR|AP|PORTUGAL)?\b/i, display: 'TAP' },
    // Ride-hailing / transport.
    { re: /\bBOLT(?:\.EU|\b)/i,  display: 'Bolt' },
    { re: /\bUBER\b/i,           display: 'Uber' },
    { re: /\bFREE\s*NOW/i,       display: 'Free Now' },
    { re: /\bMYTAXI/i,           display: 'Free Now' }, // Free Now's predecessor brand
    { re: /\bLYFT\b/i,           display: 'Lyft' },
    { re: /\bCABIFY/i,           display: 'Cabify' },
    // Telecom / mail / SaaS / pets.
    { re: /\bLYCA\s*MOBILE/i,    display: 'Lyca Mobile' },
    { re: /\bSCRIBD/i,           display: 'Scribd' },
    { re: /\bLEXOFFICE/i,        display: 'Lexoffice' },
    { re: /\bZOOPLUS/i,          display: 'Zooplus' },
    // CTT — Portuguese postal service. Three letters, so anchor with a
    // trailing word boundary to avoid hits inside random capital-letter runs.
    { re: /\bCTT\b/i,            display: 'CTT' },
  ];

  // Mutable cache used at runtime. loadBrandCollapses() refreshes it from
  // storage; until then beautifyMerchant() runs against the defaults so
  // unit-tests and the very first boot still work.
  let _activeBrandCollapses = DEFAULT_BRAND_COLLAPSES.slice();
  function activeBrandCollapses() { return _activeBrandCollapses; }

  function titleCase(s) {
    // Lowercase everything, then upper-case the first letter of each word
    // longer than 2 chars. Short words (de, da, do, el, la, of, and, &, etc.)
    // stay lowercase except when they're the first word.
    const lowers = new Set([
      'de','da','do','dos','das','e','el','la','los','las','of','the','and',
      'a','an','y','und','von','der','die','das','et','du','aux','al','in'
    ]);
    const lower = s.toLowerCase();
    return lower.split(/(\s+|[-/])/).map((part, i) => {
      if (!part.trim()) return part;
      if (part.length === 1 && /[-/&.,]/.test(part)) return part;
      if (i > 0 && lowers.has(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    }).join('');
  }

  // Special-case map for brands that read badly when title-cased: keep the
  // canonical spelling.
  const SPECIAL_CASE = {
    'paypal': 'PayPal',
    'mcdonald\'s': 'McDonald\'s',
    'mcdonalds': 'McDonald\'s',
    'ebay': 'eBay',
    'ikea': 'IKEA',
    'h&m': 'H&M',
    'hm': 'H&M',
    'kfc': 'KFC',
    'atm': 'ATM',
    'mb way': 'MB Way',
    'mbway': 'MB Way',
    'tap ap': 'TAP',
    'tap air': 'TAP',
    'linkedin': 'LinkedIn',
    'youtube': 'YouTube',
    'github': 'GitHub',
    'gitlab': 'GitLab',
  };

  function beautifyMerchant(raw) {
    if (!raw) return '';
    let s = String(raw).trim();
    if (!s) return '';

    // MB Way is a transaction *type*, not a merchant — strip any MB WAY /
    // TRF MBWAY / Mbway- / MB WAY PARA-style prefix and keep whatever
    // follows verbatim. The tail is either a masked recipient ("P/ ****8317",
    // "P/XXXXX2818") or a real person/merchant name ("Ana M Cunha Carvalho"),
    // and in both cases it is the only grouping-useful part of the string.
    //   "TRF MBWAY P/XXXXX2818"          -> "P/XXXXX2818"
    //   "MB WAY P/ ****8317"             -> "P/ ****8317"
    //   "MB WAY PARA *****6789"          -> "*****6789"
    //   "Mbway-Ana M Cunha Carvalho"     -> "Ana M Cunha Carvalho"
    const MBWAY_PREFIX = /^(?:TRF\s+)?MB\s*WAY[\s\-]*(?:PARA\s+|DE\s+|TO\s+)?/i;
    if (MBWAY_PREFIX.test(s)) {
      const tail = s.replace(MBWAY_PREFIX, '').trim();
      if (!tail) return 'MB Way';
      // Masked recipients come in several shapes — "P/ ****8317",
      // "P/XXXXX2818", "*****6789". The masks are the user's grouping
      // signal, so return them verbatim rather than running them through
      // title-casing or brand collapse.
      if (/^P\//i.test(tail) || /^[\*X]+\d+$/i.test(tail)) return tail;
      // Otherwise the tail is a real person or merchant — fall through to
      // prefix/suffix cleanup and title-casing so "ANA M CUNHA CARVALHO"
      // comes out as "Ana M Cunha Carvalho".
      s = tail;
    }

    // Payment-gateway prefixes (PayPal, SumUp, Stripe, Klarna, …). The
    // provider isn't the merchant — strip and recurse on the remainder.
    const ppMatch = PAYMENT_PROVIDER_RE.exec(s);
    if (ppMatch) {
      const tail = ppMatch[1].trim();
      if (tail) {
        const recursed = beautifyMerchant(tail);
        if (recursed) return recursed;
      }
      // Nothing useful after the provider — fall through to normal cleanup.
    }

    // Early brand collapse against the *raw* string. Airlines/transports
    // embed dates and domain-style IDs that the middle-strips would shred
    // before we could recognize the brand (e.g. "BOLT.EU/O/24-05-12"
    // loses the word BOLT once the path-date strip runs). Checking here
    // catches them; we check again after cleanup for cases where the
    // brand hides behind a prefix like "COMPRA 1234 EDEKA ...".
    for (const b of _activeBrandCollapses) {
      if (b.re.test(s)) return b.display;
    }

    // Strip prefixes repeatedly (some statements double up, e.g.
    // "COMPRA 9723 POS LIDL").
    for (let i = 0; i < 3; i++) {
      const before = s;
      s = s.replace(PREFIX_RE, '');
      if (s === before) break;
    }

    // Strip suffixes repeatedly — a single pass misses stacks like
    // "TICKET LINE SA LISBOA" where the city strip exposes a corporate
    // tail that could then be stripped too.
    for (let i = 0; i < 4; i++) {
      const before = s;
      SUFFIX_STRIPS.forEach(re => { s = s.replace(re, ''); });
      if (s === before) break;
    }

    // Middle noise.
    MIDDLE_STRIPS.forEach(re => { s = s.replace(re, ' '); });

    // Collapse runs of whitespace / punctuation noise.
    s = s.replace(/[_]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

    // Drop a leading "* " or "- " if we stripped a prefix onto punctuation.
    s = s.replace(/^[\*\-\s]+/, '').trim();

    // Big-retailer collapse: if the cleaned string still contains a known
    // brand anywhere, return just the brand. Keeps "EDEKA SUPERMARKT
    // BERLIN 123" and "EDEKA MUELLER" in the same bucket.
    for (const b of _activeBrandCollapses) {
      if (b.re.test(s)) return b.display;
    }

    if (!s) return String(raw).trim();

    const low = s.toLowerCase();
    if (SPECIAL_CASE[low]) return SPECIAL_CASE[low];

    // All-caps and short enough → title-case. Mixed-case strings that look
    // curated are left alone.
    if (/^[A-Z0-9\s\-/&.,']+$/.test(s) && s.length <= 60) {
      return titleCase(s);
    }
    return s;
  }

  // Build a resolver function from a snapshot of the merchants store. Returns
  // a stable (original) -> display lookup. Lookup precedence:
  //   1) Exact override on the raw original string (fastest, most specific).
  //   2) Cross-bank "brand" override: many statement strings beautify to the
  //      same brand name (e.g. "LUFTHANSAFLT0193 BERLIN" and "LH0234 FRA"
  //      both → "Lufthansa"). If the user renamed *one* of those, every
  //      string that beautifies to the same key inherits the new name. The
  //      key is the lowercase beautified-of-stored-original; ties are
  //      resolved by most-recently-updated.
  //   3) The beautifier itself (best-effort default).
  //   4) The raw original (when even the beautifier returns empty).
  function buildMerchantResolver(merchantRows) {
    const byOriginal = new Map();
    // brandKey (lowercase beautified) -> { display, updated_at }. We only
    // populate this from rows whose own `original` beautifies to a different
    // string than the override — that way an override of "LUFTHANSAFLT0193
    // BERLIN" → "Lufthansa Premium" propagates to other Lufthansa variants,
    // but a one-off rename ("Edeka" → "Edeka Berlin") doesn't pollute the
    // brand bucket. (If the user *wants* the rename to propagate they can
    // beautify-collapse it — by definition the beautifier output equals the
    // stored display.)
    const byBrand = new Map();
    (merchantRows || []).forEach(m => {
      if (!m || !m.original) return;
      byOriginal.set(m.original, m);
      const display = (m.display || '').trim();
      if (!display) return;
      const brandKey = (beautifyMerchant(m.original) || '').toLowerCase().trim();
      if (!brandKey) return;
      const existing = byBrand.get(brandKey);
      if (!existing || (m.updated_at || '') > (existing.updated_at || '')) {
        byBrand.set(brandKey, { display, updated_at: m.updated_at || '' });
      }
    });
    return function resolve(original) {
      if (!original) return '';
      const row = byOriginal.get(original);
      if (row && row.display && row.display.trim()) return row.display;
      const pretty = beautifyMerchant(original);
      if (pretty) {
        const brandHit = byBrand.get(pretty.toLowerCase().trim());
        if (brandHit && brandHit.display) return brandHit.display;
      }
      return pretty || original;
    };
  }

  // Canonical transaction-type vocabulary. Every row gets exactly one of
  // these on its top-level `type` field so UIs (filters, bulk edit, stats)
  // can work with a small stable set instead of each bank's raw strings.
  const TX_TYPE_VOCAB = ['Card', 'Transfer', 'MB Way', 'ATM', 'Direct Debit', 'Fee', 'Other'];

  // Ordered matchers: first hit wins. Patterns run against a *normalized*
  // version of the raw string (uppercased, non-alphanums collapsed to spaces),
  // so both the template tokens ("CARD_PURCHASE", "SEPA_TRANSFER_OUT") and the
  // human-readable ones ("Business Mastercard", "Direct Debits") match the
  // same rule. Order matters — FEE patterns go before TRANSFER so
  // "NON SEPA TRANSFER FEE" doesn't get miscategorised as Transfer.
  const TX_TYPE_PATTERNS = [
    [/\bATM\b|\bCASH\s+WITHDRAWAL\b|\bCASH\s+DEPOSIT\b|\bBARAUSZAHLUNG\b|\bBAREINZAHLUNG\b|\bLEVANT\b/, 'ATM'],
    [/\bMB\s*WAY\b|\bMBWAY\b|\bMONEYBEAM\b/, 'MB Way'],
    [/\bDIRECT\s+DEBITS?\b|\bDEBITO\s+DIRETO\b|\bLASTSCHRIFT(?:EN)?\b|\bBELASTUNGEN\b|\bCOB\s*REC\b/, 'Direct Debit'],
    [/\bFEES?\b|\bMAINTENANCE\b|\bMANUTENCAO\b|\bSTAMP\s+TAX\b|\bIMPOSTO\b|\bIRS\b|\bIRC\b|\bCOMMISSION\b|\bCOM\s+CHQ\b|\bENTGELT\b|\bMEMBERSHIP\b|\bMITGLIEDSCHAFT\b/, 'Fee'],
    // Securities/wertpapier are their own world — don't let "Wertpapierkauf"
    // (contains "KAUF") slip into Card/Transfer via the wider matchers below.
    [/\bSECURITIES\b|\bWERTPAPIER\w*\b|\bINTEREST\b|\bZINS(?:EN)?\b|\bDIVIDEND\w*\b/, 'Other'],
    [/\bCARDS?\b|\bMASTERCARD\b|\bVISA\b|\bCOMPRA\b|\bPURCHASE\b|\bCRED\b/, 'Card'],
    [/\bTRANSFERS?\b|\bTRF\b|\bTRANSFERENCIA\b|\b(?:UEBERWEISUNG|UBERWEISUNG)(?:EN)?\b|\bCREDIT\b|\bGUTSCHRIFT(?:EN)?\b|\bDAUERAUFTRAG\b|\bSALARY\b|\bGEHALT\b|\bSEPA\b|\bSPGT\b|\bRETURN\s+TRANSFER\b|\bINCOME\b|\bORDEM\s+PAGAMENTO\b|\bPAG\s+SERV\b|\bPAG\s+ESTADO\b/, 'Transfer'],
  ];

  // Fold accents for matching only — "Überweisung" → "UBERWEISUNG". Keeps
  // the happy path fast while handling the Portuguese / German strings
  // templates sometimes emit.
  function foldAscii(s) {
    try { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
    catch (e) { return s; }
  }

  // Normalize an arbitrary raw transaction-type string (from template output,
  // a description, or a user edit) into the canonical vocabulary. Returns
  // 'Other' when nothing recognisable shows up.
  function normalizeTxType(raw) {
    if (!raw) return 'Other';
    // If the raw is already a vocabulary word, keep it (case-insensitive).
    const exact = TX_TYPE_VOCAB.find(v => v.toLowerCase() === String(raw).trim().toLowerCase());
    if (exact) return exact;
    const hay = ' ' + foldAscii(String(raw)).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim() + ' ';
    for (const [re, label] of TX_TYPE_PATTERNS) {
      if (re.test(hay)) return label;
    }
    return 'Other';
  }

  // ---------- Brand-collapse rule storage facade ----------
  //
  // Persisted form: { id, pattern: '<regex source>', flags: 'i', display,
  //                   source: 'default'|'manual', updated_at }
  // Reified form (in-memory cache): { re: RegExp, display, id, source }.

  function reifyRule(row) {
    if (!row || !row.pattern || !row.display) return null;
    let re;
    try {
      re = new RegExp(row.pattern, row.flags || 'i');
    } catch (e) {
      console.warn('Invalid brand-collapse regex skipped:', row.pattern, e.message);
      return null;
    }
    return { re, display: row.display, id: row.id, source: row.source || 'default' };
  }

  // Seed the store from DEFAULT_BRAND_COLLAPSES if it's empty. Idempotent —
  // re-running after the seed lands is a no-op.
  async function seedBrandCollapsesIfNeeded() {
    if (!App.storage || !App.storage.normalizeRules) return;
    const existing = await App.storage.normalizeRules.all();
    if (existing && existing.length) return;
    const now = new Date().toISOString();
    for (let i = 0; i < DEFAULT_BRAND_COLLAPSES.length; i++) {
      const d = DEFAULT_BRAND_COLLAPSES[i];
      await App.storage.normalizeRules.put({
        pattern: d.re.source,
        flags: d.re.flags || 'i',
        display: d.display,
        source: 'default',
        order: i,
        updated_at: now,
      });
    }
  }

  // Pull every persisted brand rule and refresh the in-memory cache that
  // beautifyMerchant() iterates. Order: by `order` ascending, then by id
  // (matches the original DEFAULT_BRAND_COLLAPSES ordering).
  async function loadBrandCollapses() {
    if (!App.storage || !App.storage.normalizeRules) return _activeBrandCollapses;
    let rows = [];
    try { rows = await App.storage.normalizeRules.all(); }
    catch (e) { return _activeBrandCollapses; }
    if (!rows.length) {
      _activeBrandCollapses = DEFAULT_BRAND_COLLAPSES.slice();
      return _activeBrandCollapses;
    }
    rows.sort((a, b) => {
      const ao = (a.order != null) ? a.order : 1e9;
      const bo = (b.order != null) ? b.order : 1e9;
      if (ao !== bo) return ao - bo;
      return (a.id || 0) - (b.id || 0);
    });
    _activeBrandCollapses = rows.map(reifyRule).filter(Boolean);
    return _activeBrandCollapses;
  }

  // Return the seed defaults so the UI can offer "reset to defaults".
  function defaultBrandCollapses() {
    return DEFAULT_BRAND_COLLAPSES.map((d, i) => ({
      pattern: d.re.source,
      flags: d.re.flags || 'i',
      display: d.display,
      source: 'default',
      order: i,
    }));
  }

  // Validate a regex source string. Returns null on success, an error
  // message string on failure.
  function validateBrandPattern(pattern, flags) {
    if (!pattern || !String(pattern).trim()) return 'Pattern cannot be empty';
    try { new RegExp(pattern, flags || 'i'); return null; }
    catch (e) { return 'Invalid regex: ' + e.message; }
  }

  // Escape a literal string so it can be embedded in a regex source verbatim.
  // Used when migrating merchants-store overrides (which held raw strings
  // that were matched exactly by index lookup) into the regex-based
  // normalize_rules store, and when adding exact-match overrides from the
  // Transactions / Import / Stats tabs.
  function escapeRegex(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Persist a rule into normalize_rules. Pattern must already be a valid
  // regex source. Display is required. If a row with the same pattern+flags
  // already exists, its display is updated (and source flipped to the
  // argument). Otherwise a new row is appended with a fresh `order`.
  // Refreshes the in-memory cache on success. Returns the persisted row.
  async function saveDisplayRule({ pattern, flags = 'i', display, source = 'manual' }) {
    if (!pattern || !display || !display.trim()) {
      throw new Error('pattern and display are required');
    }
    const err = validateBrandPattern(pattern, flags);
    if (err) throw new Error(err);
    if (!App.storage || !App.storage.normalizeRules) {
      throw new Error('normalize_rules store is unavailable');
    }
    const existing = await App.storage.normalizeRules.all();
    const match = existing.find(r => r.pattern === pattern && (r.flags || 'i') === flags);
    const now = new Date().toISOString();
    if (match) {
      match.display = display.trim();
      match.source = source;
      match.updated_at = now;
      await App.storage.normalizeRules.put(match);
      await loadBrandCollapses();
      return match;
    }
    const order = (existing.reduce((m, r) => Math.max(m, r.order || 0), 0)) + 1;
    const row = {
      pattern, flags, display: display.trim(),
      source, order, updated_at: now,
    };
    const id = await App.storage.normalizeRules.put(row);
    row.id = id;
    await loadBrandCollapses();
    return row;
  }

  // Upsert an *exact-match* display override for a raw merchant string.
  // Wraps the raw string in an anchored, regex-escaped pattern so existing
  // behavior is preserved when callers pass e.g. `ACME STORE 123` — that
  // still only matches that exact raw string (case-insensitive). Empty
  // `display` deletes the matching rule if one exists.
  async function saveExactDisplayOverride(originalRaw, display) {
    const raw = String(originalRaw || '').trim();
    if (!raw) return null;
    const pattern = '^' + escapeRegex(raw) + '$';
    if (!display || !display.trim()) {
      return deleteDisplayRuleByPattern(pattern, 'i');
    }
    return saveDisplayRule({ pattern, flags: 'i', display, source: 'manual' });
  }

  // Delete every rule whose (pattern, flags) pair matches. Returns the
  // number of rows removed. Refreshes the in-memory cache afterwards.
  async function deleteDisplayRuleByPattern(pattern, flags = 'i') {
    if (!App.storage || !App.storage.normalizeRules) return 0;
    const all = await App.storage.normalizeRules.all();
    let removed = 0;
    for (const r of all) {
      if (r.pattern === pattern && (r.flags || 'i') === flags) {
        await App.storage.normalizeRules.delete(r.id);
        removed++;
      }
    }
    if (removed) await loadBrandCollapses();
    return removed;
  }

  // One-shot migration: move every row from the legacy `merchants` store
  // (which held exact-match `{original, display}` pairs) into the
  // regex-based `normalize_rules` store, then drop the source rows. Runs
  // at app boot after the brand-collapse seed; gated behind a localStorage
  // flag so it doesn't re-run every reload. Idempotent by that flag — if
  // a second merchants row shows up later, it would need a manual re-run.
  const MERCHANTS_MIGRATION_KEY = 'kalkala.merchants_migrated_to_rules.v1';
  async function migrateMerchantsToRulesIfNeeded() {
    if (!App.storage || !App.storage.merchants || !App.storage.normalizeRules) return null;
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem(MERCHANTS_MIGRATION_KEY)) {
        // Even if the flag is set, re-run the sweep if there are leftover
        // merchant rows (user may have restored from a backup). Safe: dedup
        // by anchored pattern so we don't double-write.
        const leftover = await App.storage.merchants.all().catch(() => []);
        if (!leftover.length) return null;
      }
      const merchants = await App.storage.merchants.all().catch(() => []);
      if (!merchants.length) {
        try { localStorage.setItem(MERCHANTS_MIGRATION_KEY, new Date().toISOString()); } catch (_) { /* ignore */ }
        return { migrated: 0, skipped: 0 };
      }
      const rules = await App.storage.normalizeRules.all();
      const byPattern = new Map();
      rules.forEach(r => {
        if (r && r.pattern) byPattern.set(r.pattern + '||' + (r.flags || 'i'), r);
      });
      let maxOrder = rules.reduce((m, r) => Math.max(m, r.order || 0), 0);
      const now = new Date().toISOString();
      let migrated = 0, skipped = 0;
      for (const m of merchants) {
        const original = (m && m.original || '').trim();
        const display  = (m && m.display  || '').trim();
        if (!original || !display) { await App.storage.merchants.delete(m.id); skipped++; continue; }
        const pattern = '^' + escapeRegex(original) + '$';
        const key = pattern + '||i';
        if (byPattern.has(key)) {
          // A rule already exists for this exact string — overwrite its
          // display only if the merchants row is newer, and skip the
          // creation.
          const existing = byPattern.get(key);
          if ((m.updated_at || '') > (existing.updated_at || '')) {
            existing.display = display;
            existing.source = 'manual';
            existing.updated_at = m.updated_at || now;
            await App.storage.normalizeRules.put(existing);
          }
          await App.storage.merchants.delete(m.id);
          skipped++;
          continue;
        }
        maxOrder += 1;
        const row = {
          pattern, flags: 'i', display,
          source: 'manual', order: maxOrder,
          updated_at: m.updated_at || now,
        };
        const id = await App.storage.normalizeRules.put(row);
        row.id = id;
        byPattern.set(key, row);
        await App.storage.merchants.delete(m.id);
        migrated++;
      }
      try { localStorage.setItem(MERCHANTS_MIGRATION_KEY, new Date().toISOString()); } catch (_) { /* ignore */ }
      return { migrated, skipped };
    } catch (e) {
      console.warn('Merchants → rules migration failed:', e);
      return null;
    }
  }

  App.processing.normalize = {
    beautifyMerchant, buildMerchantResolver,
    normalizeTxType, TX_TYPE_VOCAB,
    // Brand-collapse / display-name rule helpers — used by Manage > Rules
    // and by app.js boot to seed/load the IDB-backed cache.
    seedBrandCollapsesIfNeeded, loadBrandCollapses,
    defaultBrandCollapses, validateBrandPattern,
    activeBrandCollapses,
    // Write-side helpers. Every call site that used to touch App.storage
    // .merchants.{put,delete} should use these instead, so the display
    // rule cache stays coherent and the data lives in one store.
    escapeRegex, saveDisplayRule, saveExactDisplayOverride,
    deleteDisplayRuleByPattern,
    // Boot-time migration from the legacy merchants store.
    migrateMerchantsToRulesIfNeeded,
  };
})();

/**
 * Sdílené transformace IBKR Flex → interní tvar dat.
 *
 * Používá frontend (app.js — merge overlay do portfolia) i worker
 * cron-alerts (merge overlay pro vyhodnocení alertů). Jeden zdroj pravdy,
 * aby kopie logiky nedivergovaly (dřív měl frontend a worker každý svou
 * verzi — viz REVIZE_REPORT.md R5/R6).
 *
 * Čisté funkce bez závislosti na DOM / state — bezpečné pro browser i worker.
 */

// IBKR listingExchange → Yahoo Finance přípona tickeru.
// US burzy (NASDAQ, NYSE, ARCA, …) příponu nemají → symbol beze změny.
// Bez přípony Yahoo napáruje např. "CSG" na cizí US titul místo CSG.AS
// (Amsterdam) a vrátí null cenu. Kódy odpovídají konvenci statických
// instrumentů (SBF→.PA, SFB→.ST, TSE→.TO, IBIS→.DE).
export const IBKR_EXCHANGE_SUFFIX = {
  AEB: ".AS",     // Euronext Amsterdam
  SBF: ".PA",     // Euronext Paris
  IBIS: ".DE",    // Xetra
  IBIS2: ".DE",
  SFB: ".ST",     // Stockholm
  TSE: ".TO",     // Toronto
  VENTURE: ".V",  // TSX Venture
  LSE: ".L",      // London
  LSEETF: ".L",
  CPH: ".CO",     // Kodaň (DKK)
  OMXC: ".CO",
  OSE: ".OL",     // Oslo
  EBS: ".SW",     // SIX Swiss
  SWX: ".SW",
  VIRTX: ".SW",
  BVME: ".MI",    // Milán
  BM: ".MC",      // Madrid
  BME: ".MC",
  "ENEXT.BE": ".BR", // Brusel
  HEX: ".HE",     // Helsinki
  GPW: ".WA",     // Varšava
  WSE: ".WA",
  ASX: ".AX",     // Austrálie
  SEHK: ".HK",    // Hong Kong
};

// Odvodí Yahoo symbol z IBKR symbolu + burzy. Forex/holé symboly nechá být.
export function deriveYahooSymbol(symbol, listingExchange) {
  if (!symbol) return symbol;
  if (symbol.includes(".")) return symbol; // už má příponu / je to pár
  const suffix = IBKR_EXCHANGE_SUFFIX[listingExchange];
  return suffix ? symbol + suffix : symbol;
}

// Vytvoří záznam o instrumentu, pokud ještě v portfolio.instruments neexistuje.
export function ensureInstrument(portfolio, symbol, flexRow) {
  if (!symbol || portfolio.instruments[symbol]) return;
  portfolio.instruments[symbol] = {
    yahoo_symbol: deriveYahooSymbol(symbol, flexRow.listingExchange),
    isin: flexRow.isin || null,
    name: flexRow.description || symbol,
    currency: flexRow.currency || "USD",
    exchange: flexRow.listingExchange || null,
    _auto_added: true,              // marker, ať víme že přišel z Flex auto-importu
  };
}

// Flex datum yyyyMMdd → "yyyy-MM-dd"
export function flexDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

// Flex dateTime "yyyyMMdd;HHmmss" → time část "HH:MM:SS"
export function flexTime(s) {
  if (!s) return null;
  const m = String(s).match(/[;\s](\d{2})(\d{2})(\d{2})/);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : null;
}

// Je Flex trade měnová konverze (forex), ne obchod s cenným papírem?
// IBKR forex má assetCategory="CASH" a symbol ve tvaru "BASE.QUOTE"
// (např. EUR.USD). assetCategory bereme jako primární signál; symbol pattern
// je fallback, kdyby atribut ve Flex exportu chyběl.
export function isForexConversion(t) {
  if (t.assetCategory && t.assetCategory.toUpperCase() === "CASH") return true;
  return /^[A-Z]{3}\.[A-Z]{3}$/.test(t.symbol || "");
}

export function transformFlexTrade(t) {
  const qtyRaw = parseFloat(t.quantity);
  // Buy/Sell — IBKR Flex má buySell="BUY"|"SELL" a quantity je signovaný.
  // Pro náš JSON drží quantity vždy kladné, type rozhoduje směr.
  const type = t.buySell === "SELL" ? "SELL" : "BUY";
  const proceeds = parseFloat(t.proceeds);
  const commission = parseFloat(t.ibCommission);
  return {
    id: `flex-trade-${t.tradeID}`,
    flex_id: t.tradeID,
    date: flexDate(t.tradeDate || t.dateTime),
    time: flexTime(t.dateTime),
    symbol: t.symbol,
    type,
    quantity: Math.abs(qtyRaw),
    price: parseFloat(t.tradePrice),
    proceeds: proceeds,
    commission: commission,
    currency: t.currency,
    _source: "flex",
  };
}

export function transformFlexDividend(c) {
  return {
    id: `flex-div-${c.transactionID}`,
    flex_id: c.transactionID,
    date: flexDate(c.dateTime || c.reportDate),
    symbol: c.symbol,
    amount: parseFloat(c.amount),
    currency: c.currency,
    per_share: null, // Flex neuvádí explicitně per share, pouze total amount
    type: c.dividendType || "Regular",
    _source: "flex",
  };
}

export function transformFlexWithholding(c) {
  return {
    id: `flex-wh-${c.transactionID}`,
    flex_id: c.transactionID,
    date: flexDate(c.dateTime || c.reportDate),
    symbol: c.symbol,
    amount: parseFloat(c.amount),
    currency: c.currency,
    country: null,
    _source: "flex",
  };
}

export function transformFlexCashFlow(c) {
  return {
    id: `flex-cf-${c.transactionID}`,
    flex_id: c.transactionID,
    date: flexDate(c.dateTime || c.reportDate),
    type: c.type,
    amount: parseFloat(c.amount),
    currency: c.currency,
    description: c.description || c.code || "",
    _source: "flex",
  };
}

export function transformFlexCorpAction(a) {
  return {
    id: `flex-ca-${a.actionID}`,
    flex_id: a.actionID,
    date: flexDate(a.dateTime || a.reportDate),
    symbol: a.symbol,
    type: a.type,
    description: a.actionDescription || a.description || "",
    quantity: parseFloat(a.quantity) || 0,
    amount: parseFloat(a.amount) || 0,
    proceeds: parseFloat(a.proceeds) || 0,
    cost_basis: parseFloat(a.costBasis) || 0,
    currency: a.currency,
    _source: "flex",
  };
}

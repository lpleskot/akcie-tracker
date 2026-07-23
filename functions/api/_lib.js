/**
 * Sdílené helpery pro Pages Functions (/api/*).
 *
 * Soubor neexportuje žádný onRequest* handler, takže není routovaný jako
 * endpoint — požadavek na /api/_lib propadne na statický 404.
 *
 * fetchYahooQuote je JEDINÁ implementace Yahoo fetche (dřív měl quote.js
 * a watchlist.js každý svou kopii a watchlist neuměl minor units —
 * londýnské tituly v pencích, viz REVIZE_REPORT.md R5).
 */

export const YAHOO_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Normalizace minor units: některé burzy (London LSE, Johannesburg)
// vrací cenu v centech / pencích / agorech. Yahoo to označuje "GBp",
// "GBX", "ZAc". Převedeme na hlavní jednotku.
const MINOR_UNITS = { GBp: "GBP", GBX: "GBP", ZAc: "ZAR", ILA: "ILS" };

export async function fetchYahooQuote(symbol, { cacheTtl = 60 } = {}) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const res = await fetch(url, {
    headers: { "User-Agent": YAHOO_UA, Accept: "application/json" },
    cf: { cacheTtl },
  });
  if (!res.ok) {
    throw new Error(`Yahoo ${res.status} for ${symbol}`);
  }
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) {
    const err = data?.chart?.error;
    throw new Error(`No data for ${symbol}: ${err?.description || "unknown"}`);
  }

  const m = result.meta;
  let currency = m.currency;
  const scale = MINOR_UNITS[currency] ? 100 : 1;
  if (MINOR_UNITS[currency]) currency = MINOR_UNITS[currency];
  const val = (x) => (x != null ? x / scale : null);

  return {
    symbol: m.symbol,
    name: m.longName || m.shortName || null,
    currency,
    exchange: m.fullExchangeName || m.exchangeName,
    price: val(m.regularMarketPrice),
    previous_close: val(m.chartPreviousClose),
    day_high: val(m.regularMarketDayHigh),
    day_low: val(m.regularMarketDayLow),
    fifty_two_week_high: val(m.fiftyTwoWeekHigh),
    fifty_two_week_low: val(m.fiftyTwoWeekLow),
    market_time: m.regularMarketTime
      ? new Date(m.regularMarketTime * 1000).toISOString()
      : null,
    raw_currency: m.currency, // pro debug — původní Yahoo currency code
  };
}

// Chybové odpovědi se nesmí cachovat (no-store). Úspěch má default no-cache;
// endpoint může přepsat třetím parametrem (quote.js: public, max-age=60).
export function jsonResponse(obj, status = 200, cacheControl) {
  const cache = cacheControl || (status >= 400 ? "no-store" : "no-cache");
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cache,
    },
  });
}

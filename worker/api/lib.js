/**
 * Sdílené helpery API vrstvy — Yahoo fetch + JSON response.
 *
 * fetchYahooQuote je JEDINÁ implementace Yahoo fetche — používá ji
 * /api/quote, /api/watchlist (validace při add) i cron job alerts
 * (worker/jobs/alerts.js). Dřív měl quote.js a watchlist.js každý svou
 * kopii a watchlist neuměl minor units — londýnské tituly v pencích,
 * viz REVIZE_REPORT.md R5.
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

// Závěrečná cena k datu = poslední obchodní den ≤ dateISO (Yahoo chart API
// s period1/period2) + závěr obchodního dne před ním (prev_close) pro denní
// změnu. Datum baru se čte v časovém pásmu burzy, jinak by se asijská seance
// 31.12. (UTC 30.12. večer) tvářila jako 30.12.
// POZOR: Yahoo historické close jsou SPLIT-ADJUSTED — o splity po daném datu
// musí volající cenu vynásobit (splitFactorAfter ve fifo.js).
export async function fetchYahooCloseAt(symbol, dateISO) {
  const end = new Date(`${dateISO}T23:59:59Z`);
  const start = new Date(end.getTime() - 20 * 86400000); // rezerva na svátky
  const p1 = Math.floor(start.getTime() / 1000);
  const p2 = Math.floor(end.getTime() / 1000) + 86400; // +1 den kvůli pásmům
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${p1}&period2=${p2}`;
  const res = await fetch(url, {
    headers: { "User-Agent": YAHOO_UA, Accept: "application/json" },
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
  const tz = m.exchangeTimezoneName || "UTC";
  // en-CA formátuje jako YYYY-MM-DD
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  // Jeden závěr na den; kdyby Yahoo poslalo pro den víc bodů, platí pozdější.
  // prev_close tak vždy patří skutečně jinému (předchozímu) obchodnímu dni.
  const closeByDay = new Map();
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] == null) continue;
    const d = fmt.format(new Date(ts[i] * 1000));
    if (d <= dateISO) closeByDay.set(d, closes[i]);
  }
  // Yahoo doplňuje závěr do historické řady se zpožděním: ráno po obchodním
  // dni má bar za včerejšek u US a evropských burz ještě close = null. Závěr
  // posledního obchodního dne je ale v meta (regularMarketPrice/Time) — když
  // pro ten den bar s cenou chybí, doplní se odtud. Bar z řady má přednost.
  if (m.regularMarketPrice != null && m.regularMarketTime) {
    const lastDay = fmt.format(new Date(m.regularMarketTime * 1000));
    if (lastDay <= dateISO && !closeByDay.has(lastDay)) {
      closeByDay.set(lastDay, m.regularMarketPrice);
    }
  }
  const days = [...closeByDay.keys()].sort();
  if (days.length === 0) throw new Error(`No close on or before ${dateISO} for ${symbol}`);
  const day = days[days.length - 1];
  const prevDay = days.length > 1 ? days[days.length - 2] : null;

  let currency = m.currency;
  const scale = MINOR_UNITS[currency] ? 100 : 1;
  if (MINOR_UNITS[currency]) currency = MINOR_UNITS[currency];
  return {
    symbol: m.symbol,
    name: m.longName || m.shortName || null,
    currency,
    close: closeByDay.get(day) / scale,
    price_date: day,
    prev_close: prevDay ? closeByDay.get(prevDay) / scale : null,
    prev_date: prevDay,
    requested_date: dateISO,
    raw_currency: m.currency,
  };
}

// Vlastní statický asset (portfolio JSON, kurzy, manifest) přes ASSETS
// binding — stejná data, jaká vidí frontend, bez HTTP přes vlastní doménu,
// takže se čtení netýká Cloudflare Access. Hostname je pro binding
// irelevantní, směruje se podle path.
export async function fetchAssetJson(env, path, { optional = false } = {}) {
  const res = await env.ASSETS.fetch(`https://assets.internal${path}`);
  if (!res.ok) {
    if (optional) return null;
    throw new Error(`Asset ${path} → ${res.status}`);
  }
  return res.json();
}

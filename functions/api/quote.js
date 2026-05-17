/**
 * GET /api/quote?symbols=AAPL,7203.T,CEZ.PR
 *
 * Volá Yahoo Finance chart endpoint pro každý symbol paralelně,
 * vrací sjednocený JSON s aktuální cenou, předchozím zavřením, měnou a názvem.
 *
 * Cachuje na 60 s přes Cloudflare Cache API (sníží počet volání Yahoo
 * a zrychlí opakované načtení stránky).
 */

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CACHE_TTL_SECONDS = 60;

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const symbolsParam = url.searchParams.get("symbols");

  if (!symbolsParam) {
    return json({ error: "Missing ?symbols=AAPL,MSFT,..." }, 400);
  }

  const symbols = symbolsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (symbols.length === 0) {
    return json({ error: "Empty symbols list" }, 400);
  }

  if (symbols.length > 50) {
    return json({ error: "Too many symbols (max 50)" }, 400);
  }

  // Cache lookup
  const cacheKey = new Request(
    `https://cache.local/quote?symbols=${symbols.sort().join(",")}`,
    { method: "GET" },
  );
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  // Fetch all symbols in parallel
  const results = await Promise.allSettled(symbols.map(fetchOne));

  const quotes = {};
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const r = results[i];
    if (r.status === "fulfilled") {
      quotes[sym] = r.value;
    } else {
      quotes[sym] = { error: String(r.reason?.message || r.reason || "fetch failed") };
    }
  }

  const response = json({
    quotes,
    fetched_at: new Date().toISOString(),
    ttl_seconds: CACHE_TTL_SECONDS,
  });

  // Store in cache
  response.headers.set("Cache-Control", `public, max-age=${CACHE_TTL_SECONDS}`);
  await cache.put(cacheKey, response.clone());

  return response;
}

async function fetchOne(symbol) {
  const url = `${YAHOO_BASE}${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
    },
    cf: { cacheTtl: CACHE_TTL_SECONDS },
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
  // Normalizace minor units: některé burzy (London LSE, Johannesburg)
  // vrací cenu v centech / pencích / agorech. Yahoo to označuje "GBp",
  // "GBX", "ZAc". Převedeme na hlavní jednotku.
  const MINOR_UNITS = { GBp: "GBP", GBX: "GBP", ZAc: "ZAR", ILA: "ILS" };
  let currency = m.currency;
  const scale = MINOR_UNITS[currency] ? 100 : 1;
  if (MINOR_UNITS[currency]) currency = MINOR_UNITS[currency];

  return {
    symbol: m.symbol,
    name: m.longName || m.shortName || null,
    currency,
    exchange: m.fullExchangeName || m.exchangeName,
    price: m.regularMarketPrice != null ? m.regularMarketPrice / scale : null,
    previous_close:
      m.chartPreviousClose != null ? m.chartPreviousClose / scale : null,
    day_high: m.regularMarketDayHigh != null ? m.regularMarketDayHigh / scale : null,
    day_low: m.regularMarketDayLow != null ? m.regularMarketDayLow / scale : null,
    fifty_two_week_high:
      m.fiftyTwoWeekHigh != null ? m.fiftyTwoWeekHigh / scale : null,
    fifty_two_week_low:
      m.fiftyTwoWeekLow != null ? m.fiftyTwoWeekLow / scale : null,
    market_time: m.regularMarketTime
      ? new Date(m.regularMarketTime * 1000).toISOString()
      : null,
    raw_currency: m.currency, // pro debug — původní Yahoo currency code
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });
}

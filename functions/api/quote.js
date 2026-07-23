/**
 * GET /api/quote?symbols=AAPL,7203.T,CEZ.PR
 *
 * Volá Yahoo Finance chart endpoint pro každý symbol paralelně,
 * vrací sjednocený JSON s aktuální cenou, předchozím zavřením, měnou a názvem.
 *
 * Yahoo fetch + minor-units normalizace žije v _lib.js (sdílené s watchlist).
 *
 * Cachuje na 60 s přes Cloudflare Cache API (sníží počet volání Yahoo
 * a zrychlí opakované načtení stránky). Chybové odpovědi se necachují.
 */

import { fetchYahooQuote, jsonResponse } from "./_lib.js";

const CACHE_TTL_SECONDS = 60;

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const symbolsParam = url.searchParams.get("symbols");

  if (!symbolsParam) {
    return jsonResponse({ error: "Missing ?symbols=AAPL,MSFT,..." }, 400);
  }

  const symbols = symbolsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (symbols.length === 0) {
    return jsonResponse({ error: "Empty symbols list" }, 400);
  }

  if (symbols.length > 50) {
    return jsonResponse({ error: "Too many symbols (max 50)" }, 400);
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
  const results = await Promise.allSettled(
    symbols.map((s) => fetchYahooQuote(s, { cacheTtl: CACHE_TTL_SECONDS })),
  );

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

  const response = jsonResponse(
    {
      quotes,
      fetched_at: new Date().toISOString(),
      ttl_seconds: CACHE_TTL_SECONDS,
    },
    200,
    `public, max-age=${CACHE_TTL_SECONDS}`,
  );

  // Store in cache
  await cache.put(cacheKey, response.clone());

  return response;
}

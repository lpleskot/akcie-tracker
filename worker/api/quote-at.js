/**
 * GET /api/quote-at?symbols=AAPL,BKNG&date=2025-12-31
 *
 * Závěrečné ceny k datu (poslední obchodní den ≤ date) pro inventurní
 * výpis pozic. Historie se nemění → pro data starší než 2 dny se cachuje
 * týden; u čerstvých dat close ještě nemusí být finální, necachuje se.
 *
 * Ceny jsou split-adjusted (Yahoo) — korekci o splity po datu dělá frontend
 * (splitFactorAfter), protože zná corporate actions z portfolia.
 */

import { fetchYahooCloseAt, jsonResponse } from "./lib.js";

const MAX_SYMBOLS = 80;

export async function get(request) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date") || "";
  const symbolsParam = url.searchParams.get("symbols") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse({ error: "Missing/invalid ?date=YYYY-MM-DD" }, 400);
  }
  const symbols = [...new Set(symbolsParam.split(",").map((s) => s.trim()).filter(Boolean))].sort();
  if (symbols.length === 0) return jsonResponse({ error: "Missing ?symbols=" }, 400);
  if (symbols.length > MAX_SYMBOLS) {
    return jsonResponse({ error: `Too many symbols (max ${MAX_SYMBOLS})` }, 400);
  }

  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const cacheable = date <= twoDaysAgo;
  const cacheKey = new Request(
    `https://cache.local/quote-at?date=${date}&symbols=${symbols.join(",")}`,
  );
  const cache = caches.default;
  if (cacheable) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const results = await Promise.allSettled(symbols.map((s) => fetchYahooCloseAt(s, date)));
  const quotes = {};
  symbols.forEach((s, i) => {
    const r = results[i];
    quotes[s] = r.status === "fulfilled"
      ? r.value
      : { error: String(r.reason?.message || r.reason || "fetch failed") };
  });

  const response = jsonResponse(
    { date, quotes, fetched_at: new Date().toISOString() },
    200,
    cacheable ? "public, max-age=604800" : "no-cache",
  );
  if (cacheable) await cache.put(cacheKey, response.clone());
  return response;
}

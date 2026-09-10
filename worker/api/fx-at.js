/**
 * GET /api/fx-at?date=2025-12-31
 *
 * Kurzy ČNB k libovolnému datu — živě z ČNB API, stejný zdroj i tvar
 * záznamu jako scripts/fx-update.mjs ({ valid_for, rates: { USD: {rate,
 * amount} } }). fx_rates.json je před rokem 2026 záměrně řídký (jen settle
 * dny transakcí), inventurní výpis ale potřebuje kurz k rozvahovému dni.
 * O víkendu/svátku ČNB vrací poslední vyhlášené kurzy — valid_for říká,
 * ze kterého dne skutečně jsou (účetně = poslední vyhlášený kurz).
 */

import { jsonResponse } from "./lib.js";

const CNB_API = "https://api.cnb.cz/cnbapi/exrates/daily";

export async function get(request) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse({ error: "Missing/invalid ?date=YYYY-MM-DD" }, 400);
  }

  const today = new Date().toISOString().slice(0, 10);
  const cacheable = date < today; // minulé kurzy se nemění
  const cacheKey = new Request(`https://cache.local/fx-at?date=${date}`);
  const cache = caches.default;
  if (cacheable) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  // lang=EN — na lang=CS vrací ČNB API od 2026 HTTP 400
  const res = await fetch(`${CNB_API}?date=${date}&lang=EN`, {
    headers: { "User-Agent": "akcie-tracker/1.0" },
  });
  if (!res.ok) return jsonResponse({ error: `ČNB API ${res.status}` }, 502);
  const payload = await res.json();
  const rates = payload?.rates || [];
  if (rates.length === 0) {
    return jsonResponse({ error: `ČNB nevrátila kurzy pro ${date}` }, 404);
  }
  const validFor = payload?.validFor || rates[0]?.validFor || date;
  const out = { date, valid_for: validFor, rates: {} };
  for (const r of rates) {
    out.rates[r.currencyCode] = { rate: r.rate, amount: r.amount ?? 1 };
  }

  const response = jsonResponse(out, 200, cacheable ? "public, max-age=2592000" : "no-cache");
  if (cacheable) await cache.put(cacheKey, response.clone());
  return response;
}

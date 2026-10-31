/**
 * Kurzy ČNB pro skripty fx-update (denní GitHub Action) a fx-backfill
 * (doplnění historie nového portfolia) — jeden seznam měn a jeden tvar
 * záznamu v data/fx_rates.json.
 */

export const CNB_API = "https://api.cnb.cz/cnbapi/exrates/daily";

// HKD od 31. 10. 2026 — Lynx držel tituly z hongkongské burzy
export const CURRENCIES = [
  "CAD", "DKK", "EUR", "JPY", "NOK", "PLN", "SEK", "CHF",
  "GBP", "USD", "AUD", "HUF", "HKD",
];

/**
 * Kurzy ČNB k jednomu dni ve tvaru záznamu fx_rates.json
 * ({ valid_for, rates: { USD: { rate, amount } } }), nebo null, když ČNB ten
 * den nevyhlásila (víkend, svátek) nebo chybí všechny měny ze seznamu.
 * Chyba HTTP nebo sítě se hází — volající rozhodne, jestli skončit.
 */
export async function fetchCnbDay(date) {
  // lang=EN — ČNB API od 2026 vrací na lang=CS chybu HTTP 400 (typeMismatch)
  const res = await fetch(`${CNB_API}?date=${date}&lang=EN`, {
    headers: { "User-Agent": "akcie-tracker-fx-update/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  const rates = payload?.rates || [];
  if (rates.length === 0) return null;
  // validFor je nově per-rate (payload.validFor už ČNB nevrací); fallback na date
  const entry = { valid_for: payload?.validFor || rates[0]?.validFor || date, rates: {} };
  for (const r of rates) {
    if (CURRENCIES.includes(r.currencyCode)) {
      entry.rates[r.currencyCode] = { rate: r.rate, amount: r.amount ?? 1 };
    }
  }
  return Object.keys(entry.rates).length ? entry : null;
}

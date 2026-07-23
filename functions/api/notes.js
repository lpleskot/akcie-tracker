/**
 * /api/notes — krátké poznámky o firmě per ticker.
 *
 * GET   → { notes: { "AAPL": "Vyrábí iPhone, Mac, …", … } }
 * POST  body { symbol, text } → uloží/přepíše. Prázdný text smaže.
 *
 * KV klíč: "notes" → JSON { "AAPL": "…", "NET": "…", … }
 *
 * Poznámka je sdílená napříč Přehledem pozic, Watchlistem i dalšími
 * pohledy — jeden ticker = jedna note.
 */

import { jsonResponse as json } from "./_lib.js";

const KV_KEY = "notes";
const MAX_LEN = 800; // pohodlné limit; ~120 slov stačí na popis firmy

export async function onRequestGet({ env }) {
  const notes = (await env.AKCIE_TRACKER_KV.get(KV_KEY, "json")) || {};
  return json({ notes });
}

export async function onRequestPost({ env, request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const symbol = (body.symbol || "").trim().toUpperCase();
  if (!symbol) return json({ error: "Missing symbol" }, 400);

  const text = (body.text || "").trim();
  if (text.length > MAX_LEN) {
    return json({ error: `Text je moc dlouhý (max ${MAX_LEN} znaků)` }, 400);
  }

  const notes = (await env.AKCIE_TRACKER_KV.get(KV_KEY, "json")) || {};

  if (text === "") {
    delete notes[symbol];
  } else {
    notes[symbol] = text;
  }

  await env.AKCIE_TRACKER_KV.put(KV_KEY, JSON.stringify(notes));
  return json({ ok: true, symbol, text });
}

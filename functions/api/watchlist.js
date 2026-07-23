/**
 * /api/watchlist — CRUD pro watchlist (KV-backed).
 *
 * GET    → { items: [...] }
 * POST   body { action: "add",    symbol, yahoo_symbol?, rules } → přidá s validací proti Yahoo
 *        body { action: "delete", id }                            → smaže item
 *        body { action: "update", id, rules }                     → přepíše rules pole
 *
 * KV klíč: "watchlist" → JSON { items: [...] }
 */

import { fetchYahooQuote, jsonResponse as json } from "./_lib.js";

const KV_KEY = "watchlist";

export async function onRequestGet({ env }) {
  const data = (await env.AKCIE_TRACKER_KV.get(KV_KEY, "json")) || {
    items: [],
  };
  return json(data);
}

export async function onRequestPost({ env, request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const data = (await env.AKCIE_TRACKER_KV.get(KV_KEY, "json")) || {
    items: [],
  };

  if (body.action === "add") {
    return handleAdd(env, data, body);
  }
  if (body.action === "delete") {
    return handleDelete(env, data, body);
  }
  if (body.action === "update") {
    return handleUpdate(env, data, body);
  }
  if (body.action === "set_benchmark") {
    return handleSetBenchmark(env, data, body);
  }
  if (body.action === "clear_benchmark") {
    return handleClearBenchmark(env, data, body);
  }
  return json({ error: "Unknown action" }, 400);
}

async function handleSetBenchmark(env, data, body) {
  const id = body.id;
  if (!id) return json({ error: "Missing id" }, 400);
  const item = data.items.find((x) => x.id === id);
  if (!item) return json({ error: "Item not found" }, 404);
  const price = parseFloat(body.price);
  if (isNaN(price) || price <= 0) {
    return json({ error: "Invalid price" }, 400);
  }
  item.benchmark = {
    price,
    date: body.date || new Date().toISOString().slice(0, 10),
    currency: body.currency || item.currency || null,
  };
  await env.AKCIE_TRACKER_KV.put(KV_KEY, JSON.stringify(data));
  return json({ ok: true, item });
}

async function handleClearBenchmark(env, data, body) {
  const id = body.id;
  if (!id) return json({ error: "Missing id" }, 400);
  const item = data.items.find((x) => x.id === id);
  if (!item) return json({ error: "Item not found" }, 404);
  delete item.benchmark;
  await env.AKCIE_TRACKER_KV.put(KV_KEY, JSON.stringify(data));
  return json({ ok: true, item });
}

async function handleAdd(env, data, body) {
  const symbol = (body.symbol || "").trim().toUpperCase();
  const yahooSymbol = (body.yahoo_symbol || symbol).trim();
  if (!symbol) return json({ error: "Missing symbol" }, 400);

  // Validace proti Yahoo
  try {
    const quote = await fetchYahooQuote(yahooSymbol);
    const item = {
      id: crypto.randomUUID(),
      symbol,
      yahoo_symbol: yahooSymbol,
      name: quote.name || symbol,
      currency: quote.currency || null,
      exchange: quote.exchange || null,
      added: new Date().toISOString().slice(0, 10),
      rules: (body.rules || []).map((r) => ({
        ...r,
        id: r.id || crypto.randomUUID(),
        armed: r.armed !== false,
      })),
    };
    // Deduplikace na yahoo_symbol
    if (data.items.some((x) => x.yahoo_symbol === yahooSymbol)) {
      return json({ error: `${yahooSymbol} už ve watchlistu je` }, 409);
    }
    data.items.push(item);
    await env.AKCIE_TRACKER_KV.put(KV_KEY, JSON.stringify(data));
    return json({ ok: true, item });
  } catch (e) {
    return json(
      {
        error: `Ticker '${yahooSymbol}' nenalezen na Yahoo Finance: ${e.message}`,
      },
      400,
    );
  }
}

async function handleDelete(env, data, body) {
  const id = body.id;
  if (!id) return json({ error: "Missing id" }, 400);
  const before = data.items.length;
  data.items = data.items.filter((x) => x.id !== id);
  if (data.items.length === before) {
    return json({ error: "Item not found" }, 404);
  }
  await env.AKCIE_TRACKER_KV.put(KV_KEY, JSON.stringify(data));
  // Smazat i fired stavy pro tento item
  await cleanupFiredForItem(env, id);
  return json({ ok: true });
}

async function handleUpdate(env, data, body) {
  const id = body.id;
  if (!id) return json({ error: "Missing id" }, 400);
  const item = data.items.find((x) => x.id === id);
  if (!item) return json({ error: "Item not found" }, 404);
  if (body.rules) {
    item.rules = body.rules.map((r) => ({
      ...r,
      id: r.id || crypto.randomUUID(),
      armed: r.armed !== false,
    }));
  }
  await env.AKCIE_TRACKER_KV.put(KV_KEY, JSON.stringify(data));
  return json({ ok: true, item });
}

// Yahoo fetch je sdílený z _lib.js — na rozdíl od dřívější lokální kopie
// normalizuje minor units (GBp → GBP), takže londýnské tituly se ukládají
// v librách, ne pencích, konzistentně s /api/quote.

async function cleanupFiredForItem(env, itemId) {
  // Vyčistit fired:watch:{itemId}:* klíče
  const list = await env.AKCIE_TRACKER_KV.list({
    prefix: `fired:watch:${itemId}:`,
  });
  await Promise.all(
    list.keys.map((k) => env.AKCIE_TRACKER_KV.delete(k.name)),
  );
}

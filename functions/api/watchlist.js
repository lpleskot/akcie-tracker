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
  return json({ error: "Unknown action" }, 400);
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

async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) {
    throw new Error(data?.chart?.error?.description || "ticker not found");
  }
  const m = result.meta;
  return {
    name: m.longName || m.shortName,
    currency: m.currency,
    exchange: m.fullExchangeName || m.exchangeName,
    price: m.regularMarketPrice,
  };
}

async function cleanupFiredForItem(env, itemId) {
  // Vyčistit fired:watch:{itemId}:* klíče
  const list = await env.AKCIE_TRACKER_KV.list({
    prefix: `fired:watch:${itemId}:`,
  });
  await Promise.all(
    list.keys.map((k) => env.AKCIE_TRACKER_KV.delete(k.name)),
  );
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

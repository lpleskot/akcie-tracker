/**
 * /api/alerts — CRUD pro alert pravidla na držené pozice.
 *
 * GET    → { rules: [...], fired: { "ruleId:symbol": "2026-05-17T..." } }
 * POST   body { action: "add",    rule } → přidá nové pravidlo
 *        body { action: "delete", id }   → smaže pravidlo
 *        body { action: "update", id, patch } → mění armed nebo threshold_pct
 *        body { action: "rearm",  id, symbol? } → smaže fired stav (pro celé pravidlo nebo per symbol)
 */

import { jsonResponse as json } from "./_lib.js";

const KV_KEY = "alerts";
const DEFAULT_RULES = [
  {
    id: "any-position-drop-20",
    type: "drop_from_buy_all",
    scope: "owned",
    threshold_pct: -20,
    armed: true,
    description: "Jakákoliv držená pozice klesne 20 % pod průměrnou nákupní cenu",
  },
];

export async function onRequestGet({ env }) {
  const data = (await env.AKCIE_TRACKER_KV.get(KV_KEY, "json")) || {
    rules: DEFAULT_RULES,
  };
  // Načíst fired stavy
  const list = await env.AKCIE_TRACKER_KV.list({ prefix: "fired:alert:" });
  const fired = {};
  for (const k of list.keys) {
    // klíč: fired:alert:<rule_id>:<symbol>
    const parts = k.name.split(":");
    const ruleId = parts[2];
    const symbol = parts[3] || "_global";
    fired[`${ruleId}:${symbol}`] = k.metadata?.fired_at || null;
  }
  return json({ ...data, fired });
}

export async function onRequestPost({ env, request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const data = (await env.AKCIE_TRACKER_KV.get(KV_KEY, "json")) || {
    rules: DEFAULT_RULES,
  };

  if (body.action === "add") {
    const rule = body.rule || {};
    if (!rule.type) return json({ error: "Missing rule.type" }, 400);
    rule.id = rule.id || crypto.randomUUID();
    rule.armed = rule.armed !== false;
    data.rules.push(rule);
    await env.AKCIE_TRACKER_KV.put(KV_KEY, JSON.stringify(data));
    return json({ ok: true, rule });
  }

  if (body.action === "delete") {
    const id = body.id;
    if (!id) return json({ error: "Missing id" }, 400);
    data.rules = data.rules.filter((r) => r.id !== id);
    await env.AKCIE_TRACKER_KV.put(KV_KEY, JSON.stringify(data));
    await cleanupFired(env, id);
    return json({ ok: true });
  }

  if (body.action === "update") {
    const id = body.id;
    const rule = data.rules.find((r) => r.id === id);
    if (!rule) return json({ error: "Not found" }, 404);
    // Whitelist — patch nesmí přepsat id/type/scope pravidla
    const patch = body.patch || {};
    for (const k of ["armed", "threshold_pct", "description"]) {
      if (k in patch) rule[k] = patch[k];
    }
    await env.AKCIE_TRACKER_KV.put(KV_KEY, JSON.stringify(data));
    return json({ ok: true, rule });
  }

  if (body.action === "rearm") {
    const id = body.id;
    if (!id) return json({ error: "Missing id" }, 400);
    if (body.symbol) {
      await env.AKCIE_TRACKER_KV.delete(`fired:alert:${id}:${body.symbol}`);
    } else {
      await cleanupFired(env, id);
    }
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
}

async function cleanupFired(env, ruleId) {
  const list = await env.AKCIE_TRACKER_KV.list({
    prefix: `fired:alert:${ruleId}:`,
  });
  await Promise.all(
    list.keys.map((k) => env.AKCIE_TRACKER_KV.delete(k.name)),
  );
}

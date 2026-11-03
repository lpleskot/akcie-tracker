/**
 * /api/alerts — CRUD pro alert pravidla na držené pozice ve všech portfoliích.
 *
 * GET    → { rules: [...], fired: { "ruleId:portfolioId:symbol": "2026-05-17T..." } }
 * POST   body { action: "add",    rule } → přidá nové pravidlo
 *        body { action: "delete", id }   → smaže pravidlo
 *        body { action: "update", id, patch } → mění armed nebo threshold_pct
 *        body { action: "rearm",  id, symbol?, portfolio? } → smaže fired stav
 *          (pro celé pravidlo, nebo jednu pozici; bez portfolia firemní IBKR)
 */

import { jsonResponse as json } from "./lib.js";
import {
  LEGACY_FIRED_PORTFOLIO,
  firedAlertId,
  firedAlertKey,
  legacyFiredAlertKey,
  parseFiredAlertKey,
} from "../../assets/js/alerts-shared.js";

const KV_KEY = "alerts";

// Výchozí pravidlo, když v KV ještě nic není. Importuje ho i cron job
// alerts (worker/jobs/alerts.js) — UI a cron musí ukazovat totéž,
// dřív to byly dvě kopie, které se mohly rozejít.
export const DEFAULT_RULES = [
  {
    id: "any-position-drop-20",
    type: "drop_from_buy_all",
    scope: "owned",
    threshold_pct: -20,
    armed: true,
    description: "Jakákoliv držená pozice klesne 20 % pod průměrnou nákupní cenu",
  },
];

export async function get(request, env) {
  const data = (await env.AKCIE_TRACKER_KV.get(KV_KEY, "json")) || {
    rules: DEFAULT_RULES,
  };
  return json({ ...data, fired: await readFiredAlerts(env) });
}

// Pozice, které ranní kontrola už poznačila jako splněné:
// "ruleId:portfolioId:symbol" → kdy (ISO). Čte ji i ranní kontrola.
export async function readFiredAlerts(env) {
  const fired = {};
  let cursor;
  do {
    const page = await env.AKCIE_TRACKER_KV.list({ prefix: "fired:alert:", cursor });
    for (const k of page.keys) {
      const f = parseFiredAlertKey(k.name);
      if (f) fired[firedAlertId(f.ruleId, f.portfolioId, f.symbol)] = k.metadata?.fired_at || null;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return fired;
}

export async function post(request, env) {
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
      const portfolioId = body.portfolio || LEGACY_FIRED_PORTFOLIO;
      const keys = [firedAlertKey(id, portfolioId, body.symbol)];
      if (portfolioId === LEGACY_FIRED_PORTFOLIO) keys.push(legacyFiredAlertKey(id, body.symbol));
      await Promise.all(keys.map((k) => env.AKCIE_TRACKER_KV.delete(k)));
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

/**
 * /api/settings — nastavení aplikace (vlastníci portfolií).
 *
 * GET   → { settings: { owners, assignments, updated_at } | null }
 *          null = nic neuloženo, platí výchozí vlastníci z manifestu
 * POST  body { owners: [{ id, name, type }], assignments: { portfolioId: ownerId } }
 *          → přepíše celé nastavení, vrátí { ok, settings }
 *
 * KV klíč: "settings". Validace sdílená s frontendem (assets/js/owners.js).
 */

import { jsonResponse as json } from "./lib.js";
import { validateOwnerSettings } from "../../assets/js/owners.js";

const KV_KEY = "settings";

export async function get(request, env) {
  const settings = await env.AKCIE_TRACKER_KV.get(KV_KEY, "json");
  return json({ settings: settings || null });
}

export async function post(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { settings, error } = validateOwnerSettings(body);
  if (error) return json({ error }, 400);
  const saved = { ...settings, updated_at: new Date().toISOString() };
  await env.AKCIE_TRACKER_KV.put(KV_KEY, JSON.stringify(saved));
  return json({ ok: true, settings: saved });
}

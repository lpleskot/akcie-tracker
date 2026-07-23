/**
 * /api/journal — Deník investora (KV-backed).
 *
 * GET   → { entries: [{ id, date, text }, ...] }
 * POST  body { action: "add",    text }            → přidá zápis s nowISO datem
 *        body { action: "update", id, text }       → přepíše text
 *        body { action: "delete", id }             → smaže zápis
 *
 * KV klíč: "journal" → JSON { entries: [...] }
 *
 * Datum se ukládá jako ISO 8601 timestamp (UTC) ve formátu
 * "2026-05-17T14:23:45.123Z". UI ho zobrazí jako "17.5.2026 16:23"
 * podle lokální časové zóny prohlížeče.
 */

import { jsonResponse as json } from "./_lib.js";

const KV_KEY = "journal";
const MAX_LEN = 10000; // pohodlné dlouhé zápisky

export async function onRequestGet({ env }) {
  const data = (await env.AKCIE_TRACKER_KV.get(KV_KEY, "json")) || {
    entries: [],
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
    entries: [],
  };

  if (body.action === "add") {
    const text = (body.text || "").trim();
    if (!text) return json({ error: "Prázdný zápis" }, 400);
    if (text.length > MAX_LEN) {
      return json({ error: `Text je moc dlouhý (max ${MAX_LEN} znaků)` }, 400);
    }
    const entry = {
      id: crypto.randomUUID(),
      date: new Date().toISOString(),
      text,
    };
    data.entries.push(entry);
    await env.AKCIE_TRACKER_KV.put(KV_KEY, JSON.stringify(data));
    return json({ ok: true, entry });
  }

  if (body.action === "update") {
    if (!body.id) return json({ error: "Missing id" }, 400);
    const entry = data.entries.find((e) => e.id === body.id);
    if (!entry) return json({ error: "Entry not found" }, 404);
    const text = (body.text || "").trim();
    if (!text) return json({ error: "Prázdný zápis" }, 400);
    if (text.length > MAX_LEN) {
      return json({ error: `Text je moc dlouhý (max ${MAX_LEN} znaků)` }, 400);
    }
    entry.text = text;
    // Datum NEMĚNÍME — datum vzniku je historický fakt
    await env.AKCIE_TRACKER_KV.put(KV_KEY, JSON.stringify(data));
    return json({ ok: true, entry });
  }

  if (body.action === "delete") {
    if (!body.id) return json({ error: "Missing id" }, 400);
    const before = data.entries.length;
    data.entries = data.entries.filter((e) => e.id !== body.id);
    if (data.entries.length === before) {
      return json({ error: "Entry not found" }, 404);
    }
    await env.AKCIE_TRACKER_KV.put(KV_KEY, JSON.stringify(data));
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
}

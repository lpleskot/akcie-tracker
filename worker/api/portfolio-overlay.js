/**
 * /api/portfolio-overlay/:id — vrátí KV overlay pro dané portfolio.
 *
 * Overlay obsahuje nové transakce / dividendy / corporate actions /
 * transfers, které cron job flex-import automaticky stáhl z IBKR
 * Flex Web Service. Frontend načte statický JSON i overlay a mergne
 * je dohromady (dedupe podle interních ID).
 *
 * KV klíč: "portfolio-overlay:{id}"  → JSON (viz worker/jobs/flex-import.js)
 *
 * Pokud overlay neexistuje, vrátí prázdnou strukturu (200 OK).
 */

import { jsonResponse as json } from "./lib.js";

const KV_PREFIX = "portfolio-overlay:";

export async function get(env, id) {
  if (!id) return json({ error: "Missing portfolio id" }, 400);

  const overlay = (await env.AKCIE_TRACKER_KV.get(`${KV_PREFIX}${id}`, "json")) || {
    schema_version: 1,
    last_import: null,
    trades: [],
    cash_transactions: [],
    corporate_actions: [],
    transfers: [],
    open_positions_snapshot: [],
    nav_snapshot: [],
    m2m_ytd: [],
  };
  return json(overlay);
}

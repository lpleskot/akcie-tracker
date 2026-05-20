/**
 * /api/portfolio-overlay/:id — vrátí KV overlay pro dané portfolio.
 *
 * Overlay obsahuje nové transakce / dividendy / corporate actions /
 * transfers, které worker `flex-import` automaticky stáhl z IBKR
 * Flex Web Service. Frontend načte statický JSON i overlay a mergne
 * je dohromady (dedupe podle interních ID).
 *
 * KV klíč: "portfolio-overlay:{id}"  → JSON (viz workers/flex-import)
 *
 * Pokud overlay neexistuje, vrátí prázdnou strukturu (200 OK).
 */

const KV_PREFIX = "portfolio-overlay:";

export async function onRequestGet({ env, params }) {
  const id = (params.id || "").trim();
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

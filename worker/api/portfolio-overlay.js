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
 * import_status = výsledek posledního ranního běhu importu (KV
 * "flex-import:{id}", null u portfolia bez auto-importu) — appka podle něj
 * ukáže, proč import selhal.
 *
 * Pokud overlay neexistuje, vrátí prázdnou strukturu (200 OK).
 */

import { jsonResponse as json } from "./lib.js";
import { emptyOverlay, readImportStatus } from "../jobs/flex-import.js";

const KV_PREFIX = "portfolio-overlay:";

export async function get(env, id) {
  if (!id) return json({ error: "Missing portfolio id" }, 400);

  const [overlay, importStatus] = await Promise.all([
    env.AKCIE_TRACKER_KV.get(`${KV_PREFIX}${id}`, "json"),
    readImportStatus(env, id),
  ]);
  return json({ ...(overlay || emptyOverlay()), import_status: importStatus });
}

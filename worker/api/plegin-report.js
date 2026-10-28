/**
 * Ranní report do PLEGINu — ruční běh a stav (PLEGIN_ZADANI_01 B).
 *
 * POST /api/plegin-report/run  {"date":"YYYY-MM-DD"} (bez data = včerejšek)
 *   ?dry=1 → report jen sestaví a vrátí, nic neposílá ani nezapisuje.
 *   Jen s `Authorization: Bearer <REPORT_RUN_TOKEN>`; bez secretu zavřeno.
 *   Volá ho hlídač PLEGINu (Worker todo, secret AKCIE_RUN_TOKEN) přes service
 *   binding — HTTPS mezi Workery jednoho CF účtu nejde a /api/* je za Access.
 * GET /api/plegin-report/status → stav posledních dnů (sent / holiday / …).
 */

import { bearerToken, jsonResponse, tokensEqual } from "./lib.js";
import { parseArgs, pragueToday } from "../mcp/akcie-den.js";
import { listReportStatuses, runPleginReport } from "../jobs/plegin-report.js";

const HTTP_STATUS = { disabled: 503, error: 502 };

export async function run(request, env) {
  const token = bearerToken(request);
  if (!env.REPORT_RUN_TOKEN || !token || !(await tokensEqual(token, env.REPORT_RUN_TOKEN))) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  let body = {};
  const text = await request.text();
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return jsonResponse({ ok: false, error: "Tělo musí být JSON, např. {\"date\":\"2026-10-27\"}." }, 400);
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ ok: false, error: "Tělo musí být JSON objekt." }, 400);
  }

  // Stejná validace data jako nástroj akcie_den (skutečné datum, ne v budoucnosti)
  let datum;
  try {
    datum = parseArgs({ datum: body.date }, [], pragueToday()).datum;
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 400);
  }

  const dry = new URL(request.url).searchParams.get("dry") === "1";
  const result = await runPleginReport(env, { datum, source: "manual", dry });
  return jsonResponse(result, result.ok ? 200 : HTTP_STATUS[result.status] || 500);
}

export async function status(request, env) {
  return jsonResponse({ dny: await listReportStatuses(env) });
}

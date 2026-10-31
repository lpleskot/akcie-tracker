/**
 * akcie-tracker — jednotný Worker: web + API + oba denní crony.
 *
 * - Statické assety (index.html, assets/, data/…) servíruje Cloudflare přímo
 *   z [assets] konfigurace — fetch handler se volá jen pro cesty, které
 *   žádnému assetu neodpovídají (tj. /api/*, /run/* a 404).
 * - /api/*  → routovací tabulka níže (worker/api/*.js).
 * - /mcp    → MCP server pro PLEGIN (worker/mcp/server.js), token MCP_TOKEN;
 *   v Cloudflare Access vyjmutý politikou Bypass.
 * - /run/*  → manuální spuštění cron jobů, vyžaduje header x-admin-key
 *   = secret ADMIN_KEY (bez nastaveného secretu trvale zavřeno).
 * - Cron "0 5 * * *" (= 7:00 Prahy v létě / 6:00 v zimě): flex-import všech
 *   zdrojů (IBKR, Lynx), ranní report do PLEGINu (worker/jobs/plegin-report.js),
 *   vyhodnocení alertů.
 * - Cron "20 5,6 * * TUE-SAT": pojistka reportu v 7:20 Prahy (léto i zima).
 */

import { jsonResponse } from "./api/lib.js";
import * as quote from "./api/quote.js";
import * as quoteAt from "./api/quote-at.js";
import * as fxAt from "./api/fx-at.js";
import * as watchlist from "./api/watchlist.js";
import * as alerts from "./api/alerts.js";
import * as notes from "./api/notes.js";
import * as journal from "./api/journal.js";
import * as settings from "./api/settings.js";
import * as portfolioOverlay from "./api/portfolio-overlay.js";
import { handleMcp } from "./mcp/server.js";
import { addDays, pragueToday } from "./mcp/akcie-den.js";
import { runAllImports, runImport } from "./jobs/flex-import.js";
import { runAlertEvaluation } from "./jobs/alerts.js";
import { isBackupHour, readReportStatus, reportEnabled, runPleginReport } from "./jobs/plegin-report.js";
import * as pleginReport from "./api/plegin-report.js";

const OVERLAY_PREFIX = "/api/portfolio-overlay/";

// Endpoint → modul s get/post handlery (request, env) → Response
const API_ROUTES = {
  "/api/quote": quote,
  "/api/quote-at": quoteAt,
  "/api/fx-at": fxAt,
  "/api/watchlist": watchlist,
  "/api/alerts": alerts,
  "/api/notes": notes,
  "/api/journal": journal,
  "/api/settings": settings,
  "/api/plegin-report/run": { post: pleginReport.run },
  "/api/plegin-report/status": { get: pleginReport.status },
};

// Pojistka reportu — musí sedět s wrangler.toml; každý jiný cron je ranní sekvence
const CRON_REPORT_BACKUP = "20 5,6 * * tue-sat";

// Ranní sekvence: import musí doběhnout před reportem i alerty, aby viděly
// čerstvý overlay. Importy i runPleginReport chyby chytají uvnitř (vrací
// ok:false), takže alerty poběží i při selhání importu nebo reportu.
async function runDailyJobs(env) {
  await runAllImports(env);
  await runPleginReport(env, { source: "import" });
  await runAlertEvaluation(env, "scheduled");
}

// Pojistka 7:20 Prahy: report za včerejšek, pokud ještě neodešel. Když ranní
// import neměl data za včerejšek (stav stale) nebo report vůbec neběžel,
// zkusí nejdřív import znovu; report pak odejde i s varováním o datech.
// Čerstvost reportu hlídá firemní IBKR, proto se opakuje jen jeho import.
async function runReportBackup(env, now) {
  if (!isBackupHour(now) || !reportEnabled(env)) return;
  const prev = await readReportStatus(env, addDays(pragueToday(now), -1));
  if (prev?.status === "sent" || prev?.status === "holiday") return;
  if (!prev || prev.status === "stale") await runImport(env);
  await runPleginReport(env, { source: "backup", now });
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron.toLowerCase() === CRON_REPORT_BACKUP) {
      ctx.waitUntil(runReportBackup(env, new Date(event.scheduledTime)));
      return;
    }
    ctx.waitUntil(runDailyJobs(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      return handleApi(request, env, url);
    }
    if (path === "/mcp") {
      return handleMcp(request, env);
    }
    if (path.startsWith("/run/")) {
      return handleRun(request, env, url);
    }
    // Cesta neodpovídá žádnému assetu ani route → not_found_handling
    // z wrangler.toml vrátí 404.html.
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url) {
  const path = url.pathname;

  // /api/portfolio-overlay/:id — jediná route s path parametrem
  if (path.startsWith(OVERLAY_PREFIX)) {
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }
    const id = decodeURIComponent(path.slice(OVERLAY_PREFIX.length)).trim();
    return portfolioOverlay.get(env, id);
  }

  const mod = API_ROUTES[path];
  if (!mod) {
    return jsonResponse({ error: "Not found" }, 404);
  }
  const handler =
    request.method === "GET" ? mod.get : request.method === "POST" ? mod.post : null;
  if (!handler) {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  return handler(request, env);
}

// Manuální trigger cron jobů. Bez nastaveného ADMIN_KEY trvale zavřeno —
// veřejný /run by komukoli dovolil pálit IBKR rate limit / posílat e-maily.
async function handleRun(request, env, url) {
  if (!env.ADMIN_KEY || request.headers.get("x-admin-key") !== env.ADMIN_KEY) {
    return new Response("Forbidden", { status: 403 });
  }

  if (url.pathname === "/run/flex-import") {
    // ?source=ibkr|lynx = jen jeden zdroj, bez parametru všechny jako ranní cron
    const source = url.searchParams.get("source");
    const result = source ? await runImport(env, source) : await runAllImports(env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.pathname === "/run/alerts") {
    const dryRun = url.searchParams.get("dry") === "1";
    const result = await runAlertEvaluation(env, "manual", dryRun);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  }
  return jsonResponse(
    { error: "Unknown job — použij /run/flex-import (?source=ibkr|lynx) nebo /run/alerts (?dry=1)" },
    404,
  );
}

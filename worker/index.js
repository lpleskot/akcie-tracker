/**
 * akcie-tracker — jednotný Worker: web + API + oba denní crony.
 *
 * - Statické assety (index.html, assets/, data/…) servíruje Cloudflare přímo
 *   z [assets] konfigurace — fetch handler se volá jen pro cesty, které
 *   žádnému assetu neodpovídají (tj. /api/*, /run/* a 404).
 * - /api/*  → routovací tabulka níže (worker/api/*.js).
 * - /run/*  → manuální spuštění cron jobů, vyžaduje header x-admin-key
 *   = secret ADMIN_KEY (bez nastaveného secretu trvale zavřeno).
 * - Jediný cron trigger "0 5 * * *" (= 7:00 Prahy v létě / 6:00 v zimě):
 *   nejdřív flex-import, pak nad čerstvým overlay vyhodnocení alertů.
 */

import { jsonResponse } from "./api/lib.js";
import * as quote from "./api/quote.js";
import * as watchlist from "./api/watchlist.js";
import * as alerts from "./api/alerts.js";
import * as notes from "./api/notes.js";
import * as journal from "./api/journal.js";
import * as portfolioOverlay from "./api/portfolio-overlay.js";
import { runImport } from "./jobs/flex-import.js";
import { runAlertEvaluation } from "./jobs/alerts.js";

const OVERLAY_PREFIX = "/api/portfolio-overlay/";

// Endpoint → modul s get/post handlery (request, env) → Response
const API_ROUTES = {
  "/api/quote": quote,
  "/api/watchlist": watchlist,
  "/api/alerts": alerts,
  "/api/notes": notes,
  "/api/journal": journal,
};

// Ranní sekvence: import musí doběhnout před alerty, aby vyhodnocení vidělo
// čerstvý overlay. runImport chyby chytá uvnitř (vrací ok:false), takže
// alerty poběží i při selhání importu.
async function runDailyJobs(env) {
  await runImport(env);
  await runAlertEvaluation(env, "scheduled");
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyJobs(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      return handleApi(request, env, url);
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
    const result = await runImport(env);
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
    { error: "Unknown job — použij /run/flex-import nebo /run/alerts (?dry=1)" },
    404,
  );
}

/**
 * akcie-tracker — jednotný Worker: web + API + oba denní crony.
 *
 * - Statické assety (index.html, assets/, data/…) servíruje Cloudflare přímo
 *   z [assets] konfigurace — fetch handler se volá jen pro cesty, které
 *   žádnému assetu neodpovídají (tj. /api/*, /run/* a 404).
 * - /api/*  → routovací tabulka níže (worker/api/*.js).
 * - /run/*  → manuální spuštění cron jobů, vyžaduje header x-admin-key
 *   = secret ADMIN_KEY (bez nastaveného secretu trvale zavřeno).
 * - Cron triggery (wrangler.toml):
 *     "0 5 * * *" + "0 6 * * *"  → flex-import v 07:00 Prahy (DST pár,
 *                                   spustí se jen trigger odpovídající 7:00)
 *     "0 15 * * *"               → alerts (cca 1h po otevření US burz)
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

const ALERTS_CRON = "0 15 * * *";
const OVERLAY_PREFIX = "/api/portfolio-overlay/";

// Endpoint → modul s get/post handlery (request, env) → Response
const API_ROUTES = {
  "/api/quote": quote,
  "/api/watchlist": watchlist,
  "/api/alerts": alerts,
  "/api/notes": notes,
  "/api/journal": journal,
};

// Hodina v Evropě/Praze pro daný timestamp — Intl řeší přechod CET/CEST za nás.
function pragueHour(ts) {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Prague",
      hour: "2-digit",
      hour12: false,
    }).format(new Date(ts)),
  );
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === ALERTS_CRON) {
      ctx.waitUntil(runAlertEvaluation(env, "scheduled"));
      return;
    }
    // Flex import: cíl 07:00 Prahy celoročně. Crony jedou jen v UTC, proto
    // jsou v configu dva triggery (5:00 + 6:00 UTC) — spustí se jen ten,
    // kterému v Praze právě je 7 hodin; DST dvojče tiše skončí.
    if (pragueHour(event.scheduledTime) !== 7) {
      console.log(`⏭️ Skip — trigger ${event.cron} není 7:00 v Praze (DST dvojče)`);
      return;
    }
    ctx.waitUntil(runImport(env));
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

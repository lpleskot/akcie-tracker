/**
 * Cron job alerts — evaluace alert pravidel nad pozicemi a watchlistem.
 *
 * Vstupní body (worker/index.js): denní cron hned po flex-importu (ranní běh
 * pracuje se zavíracími cenami předchozího dne — pro denní kontrolu poklesů
 * stačí) a manuální GET /run/alerts (x-admin-key), /run/alerts?dry=1 =
 * testovací režim bez zápisu fired stavů.
 *
 * Pipeline:
 *   1. Načte všechna portfolia z manifestu (ASSETS binding) + jejich KV overlay
 *      (Flex auto-import) → merge. Do 2026-11-03 hlídal job jen firemní IBKR.
 *   2. Načte watchlist + alerts pravidla z KV
 *   3. Vyhledá relevantní Yahoo tickery a stáhne aktuální ceny
 *   4. Vyhodnotí pravidla — která pozice splňují podmínku a ještě nejsou fired
 *   5. Zapíše fired stav do KV pro každou pozici zvlášť (pravidlo + portfolio
 *      + ticker) — UI ho ukáže v tabu Alerty; pozice se znovu nehlásí, dokud
 *      není pravidlo manuálně re-armed
 *
 * Žádné notifikace — e-maily (Resend) odstraněny 2026-07-23, fired stav
 * je vidět při otevření aplikace; selhání jobu jen v CF lozích.
 *
 * Vše běží uvnitř jednoho Workeru — portfolio JSON se čte přes ASSETS binding
 * a ceny přímo sdílenou funkcí fetchYahooQuote, žádné HTTP na vlastní URL.
 * Cloudflare Access na doméně se jobu netýká (nepotřebuje service token).
 *
 * FIFO počítá sdílený engine ../../assets/js/fifo.js, overlay merguje
 * ../../assets/js/portfolio-shared.js a pravidla vyhodnocuje
 * ../../assets/js/alerts-shared.js — stejný kód jako náhled v tabu Alerty,
 * žádná divergentní kopie. (Wrangler/esbuild je zabalí při deployi.)
 */

import { computePositions } from "../../assets/js/fifo.js";
import { mergeOverlayIntoPortfolio } from "../../assets/js/portfolio-shared.js";
import {
  alertRuleMatches,
  firedAlertId,
  firedAlertKey,
  heldYahooSymbols,
} from "../../assets/js/alerts-shared.js";
import { fetchYahooQuote } from "../api/lib.js";
import { DEFAULT_RULES, readFiredAlerts } from "../api/alerts.js";

export async function runAlertEvaluation(env, source, dryRun = false) {
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] cron evaluation start (source=${source}, dry=${dryRun})`);

  try {
    // 1) Všechna portfolia z manifestu: statický JSON (vlastní asset) + KV
    //    overlay (Flex auto-import). Bez overlay by job neviděl pozice
    //    z denního auto-importu — nehlídal by nové a hlídal dál prodané
    //    (REVIZE_REPORT.md R6).
    const manifest = await fetchAssetJson(env, "/data/portfolios/manifest.json");
    const holdings = [];
    // Portfolio, které se nenačte, se přeskočí (a je ve výsledku), ať kvůli
    // jednomu nepřestanou fungovat alerty ostatních
    const skipped = [];
    for (const meta of manifest.portfolios || []) {
      let portfolio;
      try {
        portfolio = await fetchAssetJson(env, `/data/portfolios/${meta.file}`);
      } catch (e) {
        console.error(`Portfolio ${meta.id} se nenačetlo: ${e.message}`);
        skipped.push(meta.id);
        continue;
      }
      const overlay = await env.AKCIE_TRACKER_KV.get(`portfolio-overlay:${meta.id}`, "json");
      // Kurzy se nepředávají: ovlivní jen total_deposits_usd, se kterým alerty
      // nepracují.
      mergeOverlayIntoPortfolio(portfolio, overlay, null);
      holdings.push({
        id: meta.id,
        name: meta.name,
        instruments: portfolio.instruments || {},
        // FIFO pozice (sdílený engine — splity, bonusy, cancellations)
        positions: computePositions(
          portfolio.transactions || [],
          portfolio.corporate_actions || [],
        ),
      });
    }

    // 2) Watchlist + alert pravidla z KV
    const watchlistData =
      (await env.AKCIE_TRACKER_KV.get("watchlist", "json")) || { items: [] };
    const alertsData =
      (await env.AKCIE_TRACKER_KV.get("alerts", "json")) || { rules: DEFAULT_RULES };
    const watchlist = watchlistData.items || [];
    const alertRules = alertsData.rules || [];

    // 3) Sesbírat relevantní symboly: držené pozice všech portfolií (delisted
    //    tituly na Yahoo neexistují a s nulovou cenou by falešně plnily drop
    //    pravidla) a watchlist
    const symbols = new Set(heldYahooSymbols(holdings));
    for (const w of watchlist) {
      if (w.yahoo_symbol) symbols.add(w.yahoo_symbol);
    }
    // Která portfolia běh prošel — ve výsledku pro ruční /run/alerts
    const checked = { portfolios: holdings.map((h) => h.id), skipped };
    if (symbols.size === 0) {
      console.log("Žádné symboly k vyhodnocení");
      return { ok: true, message: "no symbols", evaluated: 0, ...checked };
    }

    // 4) Stáhnout ceny — přímo sdílenou funkcí, stejný tvar jako /api/quote
    const quotes = await fetchQuotes([...symbols]);

    // 5) Vyhodnotit pravidla
    const triggers = [];

    // Pravidla na držené pozice — každá pozice (portfolio + ticker) zvlášť;
    // splněné dřív se přeskočí (i se starým klíčem z doby, kdy job hlídal jen IBKR)
    const fired = await readFiredAlerts(env);
    for (const rule of alertRules) {
      if (!rule.armed) continue;
      for (const m of alertRuleMatches(rule, holdings, quotes)) {
        if (firedAlertId(rule.id, m.portfolioId, m.symbol) in fired) continue;
        triggers.push({
          kind: "alert",
          ruleId: rule.id,
          ruleDesc: rule.description || rule.id,
          portfolioId: m.portfolioId,
          symbol: m.symbol,
          name: m.name,
          currency: m.currency,
          current: m.current,
          reference: m.reference,
          changePct: m.changePct,
          firedKey: firedAlertKey(rule.id, m.portfolioId, m.symbol),
        });
      }
    }

    // Pravidla na watchlist
    for (const item of watchlist) {
      const q = quotes[item.yahoo_symbol];
      if (!q || q.price == null) continue;
      for (const rule of item.rules || []) {
        if (!rule.armed) continue;
        const triggered = evaluateWatchRule(rule, q.price);
        if (!triggered) continue;
        const firedKey = `fired:watch:${item.id}:${rule.id}`;
        const existing = await env.AKCIE_TRACKER_KV.get(firedKey);
        if (existing) continue;
        triggers.push({
          kind: "watch",
          itemId: item.id,
          ruleId: rule.id,
          symbol: item.symbol,
          name: item.name || q.name,
          currency: q.currency,
          current: q.price,
          rule,
          firedKey,
        });
      }
    }

    if (triggers.length === 0) {
      console.log("Žádný nový alert");
      return {
        ok: true,
        evaluated: alertRules.length + watchlist.length,
        triggers: 0,
        ...checked,
      };
    }

    // Dry run — vrátit co BY se zapsalo, nic nezapisovat
    if (dryRun) {
      console.log(`🧪 DRY RUN — ${triggers.length} triggerů, fired se nezapisuje.`);
      return { ok: true, dry_run: true, triggers, ...checked };
    }

    // 6) Označit jako fired (s timestamp v metadata) — UI je zobrazí v tabu Alerty
    const now = new Date().toISOString();
    await Promise.all(
      triggers.map((t) =>
        env.AKCIE_TRACKER_KV.put(t.firedKey, now, {
          metadata: { fired_at: now },
        }),
      ),
    );

    console.log(`Zapsáno ${triggers.length} fired alertů`);
    return { ok: true, triggers: triggers.length, ...checked };
  } catch (err) {
    console.error("Cron selhal:", err);
    return { ok: false, error: String(err.message || err) };
  }
}

// Manifest a statické portfolio JSON přes ASSETS binding — čte vlastní
// deploynutý asset, takže data jsou vždy konzistentní s tím, co vidí frontend.
// Hostname je pro binding irelevantní, směruje se podle path.
async function fetchAssetJson(env, path) {
  const res = await env.ASSETS.fetch(`https://assets.internal${path}`);
  if (!res.ok) throw new Error(`Asset ${path} → ${res.status}`);
  return res.json();
}

// Stejný tvar výsledku jako /api/quote (mapa symbol → quote | {error}),
// jen bez HTTP a bez edge cache — pro 1× denně běžící job zbytečná.
async function fetchQuotes(symbols) {
  const results = await Promise.allSettled(symbols.map((s) => fetchYahooQuote(s)));
  const quotes = {};
  symbols.forEach((s, i) => {
    const r = results[i];
    quotes[s] =
      r.status === "fulfilled"
        ? r.value
        : { error: String(r.reason?.message || r.reason || "fetch failed") };
  });
  return quotes;
}

// ---------- Evaluace pravidel watchlistu ----------
function evaluateWatchRule(rule, currentPrice) {
  if (rule.type === "price_below") return currentPrice < rule.value;
  if (rule.type === "price_above") return currentPrice > rule.value;
  if (rule.type === "drop_pct" && rule.ref_price) {
    const change = ((currentPrice - rule.ref_price) / rule.ref_price) * 100;
    // threshold_pct akceptujeme kladně i záporně — počítáme magnitudu poklesu
    return change <= -Math.abs(rule.threshold_pct);
  }
  return false;
}

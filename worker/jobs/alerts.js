/**
 * Cron job alerts — evaluace alert pravidel nad pozicemi a watchlistem.
 *
 * Vstupní body (worker/index.js): cron 15:00 UTC (cca 1h po otevření US burz)
 * a manuální GET /run/alerts (x-admin-key), /run/alerts?dry=1 = testovací
 * režim bez zápisu fired stavů.
 *
 * Pipeline:
 *   1. Načte portfolio (ASSETS binding) + KV overlay (Flex auto-import) → merge
 *   2. Načte watchlist + alerts pravidla z KV
 *   3. Vyhledá relevantní Yahoo tickery a stáhne aktuální ceny
 *   4. Vyhodnotí pravidla — která splňují podmínku a ještě nejsou fired
 *   5. Zapíše fired stav do KV — UI ho zobrazí v tabu Alerty; pravidlo se
 *      znovu nevyhodnotí, dokud není manuálně re-armed
 *
 * Žádné notifikace — e-maily (Resend) odstraněny 2026-07-23, fired stav
 * je vidět při otevření aplikace; selhání jobu jen v CF lozích.
 *
 * Vše běží uvnitř jednoho Workeru — portfolio JSON se čte přes ASSETS binding
 * a ceny přímo sdílenou funkcí fetchYahooQuote, žádné HTTP na vlastní URL.
 * Cloudflare Access na doméně se jobu netýká (nepotřebuje service token).
 *
 * FIFO počítá sdílený engine ../../assets/js/fifo.js a overlay transformace
 * ../../assets/js/flex-shared.js — stejný kód jako frontend, žádná
 * divergentní kopie. (Wrangler/esbuild je zabalí při deployi.)
 */

import { computePositions } from "../../assets/js/fifo.js";
import {
  ensureInstrument,
  isForexConversion,
  transformFlexTrade,
  transformFlexCorpAction,
} from "../../assets/js/flex-shared.js";
import { fetchYahooQuote } from "../api/lib.js";
import { DEFAULT_RULES } from "../api/alerts.js";

export async function runAlertEvaluation(env, source, dryRun = false) {
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] cron evaluation start (source=${source}, dry=${dryRun})`);

  try {
    // 1) Statický portfolio JSON (vlastní asset) + KV overlay (Flex auto-import).
    //    Bez overlay by job neviděl pozice z denního auto-importu —
    //    nehlídal by nové a hlídal dál prodané (REVIZE_REPORT.md R6).
    const portfolio = await fetchPortfolioJson(env);
    const overlay = await env.AKCIE_TRACKER_KV.get(
      `portfolio-overlay:${env.PORTFOLIO_ID}`,
      "json",
    );
    mergeOverlayForAlerts(portfolio, overlay);

    // 2) Watchlist + alert pravidla z KV
    const watchlistData =
      (await env.AKCIE_TRACKER_KV.get("watchlist", "json")) || { items: [] };
    const alertsData =
      (await env.AKCIE_TRACKER_KV.get("alerts", "json")) || { rules: DEFAULT_RULES };
    const watchlist = watchlistData.items || [];
    const alertRules = alertsData.rules || [];

    // 3) Sesbírat všechny relevantní symboly
    const symbols = new Set();
    for (const [, inst] of Object.entries(portfolio.instruments)) {
      symbols.add(inst.yahoo_symbol);
    }
    for (const w of watchlist) {
      if (w.yahoo_symbol) symbols.add(w.yahoo_symbol);
    }
    if (symbols.size === 0) {
      console.log("Žádné symboly k vyhodnocení");
      return { ok: true, message: "no symbols", evaluated: 0 };
    }

    // 4) Stáhnout ceny — přímo sdílenou funkcí, stejný tvar jako /api/quote
    const quotes = await fetchQuotes([...symbols]);

    // 5) Vypočítat FIFO pozice (sdílený engine — splity, bonusy, cancellations)
    const positions = computePositions(
      portfolio.transactions,
      portfolio.corporate_actions || [],
    );

    // 6) Vyhodnotit pravidla
    const triggers = [];

    // Pravidla na držené pozice
    for (const rule of alertRules) {
      if (!rule.armed) continue;
      const matches = evaluatePortfolioRule(rule, positions, quotes, portfolio);
      for (const m of matches) {
        const firedKey = `fired:alert:${rule.id}:${m.symbol}`;
        const existing = await env.AKCIE_TRACKER_KV.get(firedKey);
        if (existing) continue; // už fired, nezapisovat znovu
        triggers.push({
          kind: "alert",
          ruleId: rule.id,
          ruleDesc: rule.description || rule.id,
          symbol: m.symbol,
          name: m.name,
          currency: m.currency,
          current: m.current,
          reference: m.reference,
          changePct: m.changePct,
          firedKey,
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
      };
    }

    // Dry run — vrátit co BY se zapsalo, nic nezapisovat
    if (dryRun) {
      console.log(`🧪 DRY RUN — ${triggers.length} triggerů, fired se nezapisuje.`);
      return { ok: true, dry_run: true, triggers };
    }

    // 7) Označit jako fired (s timestamp v metadata) — UI je zobrazí v tabu Alerty
    const now = new Date().toISOString();
    await Promise.all(
      triggers.map((t) =>
        env.AKCIE_TRACKER_KV.put(t.firedKey, now, {
          metadata: { fired_at: now },
        }),
      ),
    );

    console.log(`Zapsáno ${triggers.length} fired alertů`);
    return { ok: true, triggers: triggers.length };
  } catch (err) {
    console.error("Cron selhal:", err);
    return { ok: false, error: String(err.message || err) };
  }
}

// Statický portfolio JSON přes ASSETS binding — čte vlastní deploynutý asset,
// takže data jsou vždy konzistentní s tím, co vidí frontend. Hostname je
// pro binding irelevantní, směruje se podle path.
async function fetchPortfolioJson(env) {
  const path = `/data/portfolios/${env.PORTFOLIO_ID}.json`;
  const res = await env.ASSETS.fetch(`https://assets.internal${path}`);
  if (!res.ok) throw new Error(`Portfolio asset ${path} → ${res.status}`);
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

/**
 * Mergne KV overlay do portfolia — jen část potřebná pro alerty
 * (transakce → pozice, corporate actions → splity, instrumenty).
 * Zrcadlí mergeOverlayIntoPortfolio v app.js; transformace jsou sdílené
 * z flex-shared.js, tady je jen dedupe smyčka.
 */
function mergeOverlayForAlerts(portfolio, overlay) {
  portfolio.transactions = portfolio.transactions || [];
  portfolio.corporate_actions = portfolio.corporate_actions || [];
  portfolio.instruments = portfolio.instruments || {};
  if (!overlay) return;

  const txIds = new Set(
    portfolio.transactions.map((t) => t.flex_id).filter(Boolean),
  );
  for (const t of overlay.trades || []) {
    if (!t.tradeID || txIds.has(t.tradeID)) continue;
    if (isForexConversion(t)) continue; // konverze měn nejsou pozice
    ensureInstrument(portfolio, t.symbol, t);
    portfolio.transactions.push(transformFlexTrade(t));
    txIds.add(t.tradeID);
  }

  const caIds = new Set(
    portfolio.corporate_actions.map((a) => a.flex_id).filter(Boolean),
  );
  for (const a of overlay.corporate_actions || []) {
    if (!a.actionID || caIds.has(a.actionID)) continue;
    portfolio.corporate_actions.push(transformFlexCorpAction(a));
    caIds.add(a.actionID);
  }
}

// ---------- Evaluace pravidel ----------
function evaluatePortfolioRule(rule, positions, quotes, portfolio) {
  const matches = [];
  if (rule.scope !== "owned") return matches;

  if (rule.type === "drop_from_buy_all") {
    for (const sym in positions) {
      const pos = positions[sym];
      if (!pos || pos.net_qty === 0) continue;
      const inst = portfolio.instruments[sym];
      if (!inst) continue;
      const q = quotes[inst.yahoo_symbol];
      if (!q || q.price == null) continue;
      const change = ((q.price - pos.avg_open_price) / pos.avg_open_price) * 100;
      if (change <= -Math.abs(rule.threshold_pct)) {
        matches.push({
          symbol: sym,
          name: inst.name,
          currency: inst.currency,
          current: q.price,
          reference: pos.avg_open_price,
          changePct: change,
        });
      }
    }
  }

  if (rule.type === "drop_from_buy" && rule.symbol) {
    const sym = rule.symbol;
    const pos = positions[sym];
    const inst = portfolio.instruments[sym];
    if (pos && pos.net_qty > 0 && inst) {
      const q = quotes[inst.yahoo_symbol];
      if (q && q.price != null) {
        const change =
          ((q.price - pos.avg_open_price) / pos.avg_open_price) * 100;
        if (change <= -Math.abs(rule.threshold_pct)) {
          matches.push({
            symbol: sym,
            name: inst.name,
            currency: inst.currency,
            current: q.price,
            reference: pos.avg_open_price,
            changePct: change,
          });
        }
      }
    }
  }

  if (rule.type === "drop_from_52w_high") {
    for (const sym in positions) {
      const pos = positions[sym];
      if (!pos || pos.net_qty === 0) continue;
      const inst = portfolio.instruments[sym];
      if (!inst) continue;
      const q = quotes[inst.yahoo_symbol];
      if (!q || q.price == null || q.fifty_two_week_high == null) continue;
      const change =
        ((q.price - q.fifty_two_week_high) / q.fifty_two_week_high) * 100;
      if (change <= -Math.abs(rule.threshold_pct)) {
        matches.push({
          symbol: sym,
          name: inst.name,
          currency: inst.currency,
          current: q.price,
          reference: q.fifty_two_week_high,
          changePct: change,
        });
      }
    }
  }

  return matches;
}

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

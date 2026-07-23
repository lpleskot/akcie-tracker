/**
 * Akcie tracker — cron worker pro evaluaci alert pravidel.
 *
 * Spouští se 1× denně v 15:00 UTC (cca 1h po otevření US burz).
 *
 * Pipeline:
 *   1. Načte portfolio (HTTP) + KV overlay (Flex auto-import) → merge
 *   2. Načte watchlist + alerts pravidla přímo z KV (binding — žádné HTTP)
 *   3. Vyhledá relevantní Yahoo tickery a stáhne aktuální ceny
 *   4. Vyhodnotí pravidla — která splňují podmínku a ještě nejsou fired
 *   5. Pošle souhrnný email přes Resend
 *   6. Zapíše fired stav do KV (neposílá znovu dokud manuálně re-armed)
 *   Při selhání pošle failure email (pokud je nastavený RESEND_API_KEY).
 *
 * FIFO počítá sdílený engine ../../../assets/js/fifo.js a overlay transformace
 * ../../../assets/js/flex-shared.js — stejný kód jako frontend, žádná
 * divergentní kopie. (Wrangler/esbuild je zabalí při deployi.)
 *
 * Manuální spuštění (vyžaduje secret ADMIN_KEY):
 *   curl -H "x-admin-key: <ADMIN_KEY>" https://akcie-tracker-cron.<subdoména>.workers.dev/run
 *   Testovací režim bez odeslání emailu a zápisu fired stavů: /run?dry=1
 *
 * Za Cloudflare Access: nastav secrets CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET
 * (service token) — přidají se jako hlavičky k HTTP fetchům na pages.dev.
 */

import { computePositions, fmtNum, fmtPct } from "../../../assets/js/fifo.js";
import {
  ensureInstrument,
  isForexConversion,
  transformFlexTrade,
  transformFlexCorpAction,
} from "../../../assets/js/flex-shared.js";
import { sendResendEmail, sendFailureEmail } from "../../_shared/notify.js";

// Výchozí pravidlo, když v KV ještě nic není.
// MUSÍ odpovídat DEFAULT_RULES ve functions/api/alerts.js (UI ukazuje totéž).
const DEFAULT_RULES = [
  {
    id: "any-position-drop-20",
    type: "drop_from_buy_all",
    scope: "owned",
    threshold_pct: -20,
    armed: true,
    description: "Jakákoliv držená pozice klesne 20 % pod průměrnou nákupní cenu",
  },
];

export default {
  // Scheduled trigger (cron)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlertEvaluation(env, "scheduled"));
  },

  // HTTP endpoint pro manuální trigger — jen se správným x-admin-key.
  // Bez nastaveného ADMIN_KEY je endpoint zavřený (cron běží dál).
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run" || url.pathname === "/__scheduled") {
      if (!env.ADMIN_KEY || request.headers.get("x-admin-key") !== env.ADMIN_KEY) {
        return new Response("Forbidden", { status: 403 });
      }
      const dryRun = url.searchParams.get("dry") === "1";
      const result = await runAlertEvaluation(env, "manual", dryRun);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      "Akcie tracker cron worker. GET /run (x-admin-key) pro manuální evaluaci, /run?dry=1 bez odeslání.",
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  },
};

async function runAlertEvaluation(env, source, dryRun = false) {
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] cron evaluation start (source=${source}, dry=${dryRun})`);

  try {
    // 1) Statický portfolio JSON (HTTP) + KV overlay (Flex auto-import).
    //    Bez overlay by worker neviděl pozice z denního auto-importu —
    //    nehlídal by nové a hlídal dál prodané (REVIZE_REPORT.md R6).
    const portfolio = await fetchJson(env.PORTFOLIO_URL, env);
    const overlay = await env.AKCIE_TRACKER_KV.get(
      `portfolio-overlay:${env.PORTFOLIO_ID}`,
      "json",
    );
    mergeOverlayForAlerts(portfolio, overlay);

    // 2) Watchlist + alert pravidla přímo z KV (sdílený binding s Pages)
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

    // 4) Stáhnout ceny
    const quoteUrl = `${env.QUOTE_API}?symbols=${encodeURIComponent([...symbols].join(","))}`;
    const quotesData = await fetchJson(quoteUrl, env);
    const quotes = quotesData?.quotes || {};

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
        if (existing) continue; // už fired, neposílat znovu
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
      console.log("Žádný alert k odeslání");
      return {
        ok: true,
        evaluated: alertRules.length + watchlist.length,
        triggers: 0,
      };
    }

    // Dry run — vrátit co BY se poslalo, nic neodesílat ani nezapisovat
    if (dryRun) {
      console.log(`🧪 DRY RUN — ${triggers.length} triggerů, email se neposílá.`);
      return { ok: true, dry_run: true, triggers };
    }

    // 7) Sestavit + odeslat email přes Resend
    const subject = buildEmailSubject(triggers);
    const html = buildEmailHtml(triggers, env);
    const text = buildEmailText(triggers, env);
    const sendRes = await sendResendEmail(env, subject, html, text);
    if (!sendRes.ok) {
      console.error("Resend selhal:", sendRes.error);
      return { ok: false, error: sendRes.error, triggers: triggers.length };
    }

    // 8) Označit jako fired (s timestamp v metadata)
    const now = new Date().toISOString();
    await Promise.all(
      triggers.map((t) =>
        env.AKCIE_TRACKER_KV.put(t.firedKey, now, {
          metadata: { fired_at: now },
        }),
      ),
    );

    console.log(`Odesláno ${triggers.length} alertů, email id: ${sendRes.id}`);
    return { ok: true, triggers: triggers.length, email_id: sendRes.id };
  } catch (err) {
    console.error("Cron selhal:", err);
    // Selhání musí být vidět, ne jen v logu, který nikdo nečte
    await sendFailureEmail(env, "cron-alerts", err);
    return { ok: false, error: String(err.message || err) };
  }
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

// Fetch JSON; za Cloudflare Access přidá service-token hlavičky (pokud jsou
// nastavené secrets CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET).
async function fetchJson(url, env) {
  const headers = { "User-Agent": "akcie-tracker-cron" };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Fetch ${url} → ${res.status}`);
  return res.json();
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

// ---------- Email ----------
function buildEmailSubject(triggers) {
  const count = triggers.length;
  const top = triggers
    .slice(0, 3)
    .map((t) => {
      if (t.kind === "alert") {
        return `${t.symbol} ${fmtPct(t.changePct)}`;
      } else {
        const dir =
          t.rule.type === "price_below"
            ? "<"
            : t.rule.type === "price_above"
              ? ">"
              : "↓";
        return `${t.symbol} ${dir}`;
      }
    })
    .join(", ");
  return `[Akcie tracker] ${count} ${count === 1 ? "alert" : count < 5 ? "alerty" : "alertů"} — ${top}${count > 3 ? "…" : ""}`;
}

function buildEmailHtml(triggers, env) {
  const sections = [];
  const portfolioTriggers = triggers.filter((t) => t.kind === "alert");
  const watchTriggers = triggers.filter((t) => t.kind === "watch");

  if (portfolioTriggers.length > 0) {
    sections.push(`<h2 style="font-size:16px;margin:0 0 10px;">Vlastní pozice</h2>`);
    sections.push(
      `<table style="width:100%;border-collapse:collapse;font-size:13px;">`,
    );
    sections.push(
      `<thead><tr style="background:#fafaf8;">
        <th style="text-align:left;padding:8px;">Symbol</th>
        <th style="text-align:left;padding:8px;">Název</th>
        <th style="text-align:right;padding:8px;">Současná cena</th>
        <th style="text-align:right;padding:8px;">Referenční</th>
        <th style="text-align:right;padding:8px;">Změna</th>
        <th style="text-align:left;padding:8px;">Pravidlo</th>
      </tr></thead><tbody>`,
    );
    for (const t of portfolioTriggers) {
      sections.push(
        `<tr style="border-top:1px solid #e4e4e0;">
          <td style="padding:8px;"><strong>${t.symbol}</strong></td>
          <td style="padding:8px;">${escapeHtml(t.name)}</td>
          <td style="padding:8px;text-align:right;font-variant-numeric:tabular-nums;">${fmtNum(t.current, 2)} ${t.currency}</td>
          <td style="padding:8px;text-align:right;font-variant-numeric:tabular-nums;">${fmtNum(t.reference, 2)}</td>
          <td style="padding:8px;text-align:right;color:#b3261e;font-weight:600;">${fmtPct(t.changePct)}</td>
          <td style="padding:8px;color:#6b6b66;">${escapeHtml(t.ruleDesc)}</td>
        </tr>`,
      );
    }
    sections.push(`</tbody></table>`);
  }

  if (watchTriggers.length > 0) {
    sections.push(`<h2 style="font-size:16px;margin:20px 0 10px;">Watchlist</h2>`);
    sections.push(
      `<table style="width:100%;border-collapse:collapse;font-size:13px;">`,
    );
    sections.push(
      `<thead><tr style="background:#fafaf8;">
        <th style="text-align:left;padding:8px;">Symbol</th>
        <th style="text-align:left;padding:8px;">Název</th>
        <th style="text-align:right;padding:8px;">Současná cena</th>
        <th style="text-align:left;padding:8px;">Splněné pravidlo</th>
      </tr></thead><tbody>`,
    );
    for (const t of watchTriggers) {
      const rule = t.rule;
      let ruleText = "";
      if (rule.type === "price_below")
        ruleText = `cena < ${fmtNum(rule.value, 2)}`;
      else if (rule.type === "price_above")
        ruleText = `cena > ${fmtNum(rule.value, 2)}`;
      else if (rule.type === "drop_pct")
        ruleText = `pokles ≥ ${Math.abs(rule.threshold_pct)}% od ${fmtNum(rule.ref_price, 2)}`;
      sections.push(
        `<tr style="border-top:1px solid #e4e4e0;">
          <td style="padding:8px;"><strong>${t.symbol}</strong></td>
          <td style="padding:8px;">${escapeHtml(t.name || "")}</td>
          <td style="padding:8px;text-align:right;font-variant-numeric:tabular-nums;">${fmtNum(t.current, 2)} ${t.currency || ""}</td>
          <td style="padding:8px;color:#6b6b66;">${ruleText}</td>
        </tr>`,
      );
    }
    sections.push(`</tbody></table>`);
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8" /></head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f7f7f5;padding:20px;">
    <div style="max-width:680px;margin:0 auto;background:#fff;padding:24px;border-radius:8px;">
      <h1 style="font-size:18px;margin:0 0 16px;">Akcie tracker — ${triggers.length} ${triggers.length === 1 ? "alert" : triggers.length < 5 ? "alerty" : "alertů"}</h1>
      ${sections.join("")}
      <p style="margin-top:24px;font-size:12px;color:#6b6b66;">
        <a href="${env.DASHBOARD_URL}" style="color:#1a5fb4;">Otevřít tracker</a> ·
        Tyto alerty se nepošlou znovu, dokud manuálně neuděláte Re-arm v tabu Alerty.
      </p>
    </div>
  </body></html>`;
}

function buildEmailText(triggers, env) {
  const lines = [];
  lines.push(`Akcie tracker — ${triggers.length} alertů`);
  lines.push("");
  for (const t of triggers) {
    if (t.kind === "alert") {
      lines.push(
        `[${t.symbol}] ${t.name} — ${fmtNum(t.current, 2)} ${t.currency} (ref ${fmtNum(t.reference, 2)}, ${fmtPct(t.changePct)})`,
      );
      lines.push(`   ${t.ruleDesc}`);
    } else {
      lines.push(`[${t.symbol}] watchlist — ${fmtNum(t.current, 2)}`);
    }
    lines.push("");
  }
  lines.push(`Otevřít tracker: ${env.DASHBOARD_URL}`);
  return lines.join("\n");
}

// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

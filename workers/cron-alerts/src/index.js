/**
 * Akcie tracker — cron worker pro evaluaci alert pravidel.
 *
 * Spouští se 1× denně v 15:00 UTC (cca 1h po otevření US burz).
 *
 * Pipeline:
 *   1. Načte portfolio + watchlist + alerts pravidla
 *   2. Vyhledá relevantní Yahoo tickery a stáhne aktuální ceny
 *   3. Vyhodnotí pravidla — která splňují podmínku a ještě nejsou fired
 *   4. Pošle souhrnný email přes Resend
 *   5. Zapíše fired stav do KV (neposílá znovu dokud manuálně re-armed)
 *
 * Manuální spuštění pro testování:
 *   curl -X POST https://akcie-tracker-cron.<account>.workers.dev/__scheduled \
 *        -H "Authorization: Bearer <wrangler dev key>"
 *   nebo `wrangler dev --test-scheduled` lokálně a hit /__scheduled
 */

export default {
  // Scheduled trigger (cron)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlertEvaluation(env, "scheduled"));
  },

  // HTTP endpoint pro manuální trigger (pro test)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run" || url.pathname === "/__scheduled") {
      const result = await runAlertEvaluation(env, "manual");
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      "Akcie tracker cron worker. POST /run pro manuální evaluaci.",
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  },
};

async function runAlertEvaluation(env, source) {
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] cron evaluation start (source=${source})`);

  try {
    // 1) Načíst data
    const portfolio = await fetchJson(env.PORTFOLIO_URL);
    const watchlistData = await fetchJson(env.WATCHLIST_API);
    const alertsData = await fetchJson(env.ALERTS_API);
    const watchlist = watchlistData?.items || [];
    const alertRules = alertsData?.rules || [];

    // 2) Sesbírat všechny relevantní symboly
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

    // 3) Stáhnout ceny
    const quoteUrl = `${env.QUOTE_API}?symbols=${encodeURIComponent([...symbols].join(","))}`;
    const quotesData = await fetchJson(quoteUrl);
    const quotes = quotesData?.quotes || {};

    // 4) Vypočítat FIFO pozice (pro pravidla na vlastnictví)
    const positions = computePositions(
      portfolio.transactions,
      portfolio.corporate_actions || [],
    );

    // 5) Vyhodnotit pravidla
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

    // 6) Sestavit email
    const subject = buildEmailSubject(triggers);
    const html = buildEmailHtml(triggers, env);
    const text = buildEmailText(triggers, env);

    // 7) Odeslat přes Resend
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
    return { ok: false, error: String(err.message || err) };
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

// ---------- FIFO engine (zjednodušená kopie pro worker — bez splitů, ty řešeno už v statickém JSON) ----------
function computePositions(transactions, corporateActions = []) {
  const events = [
    ...transactions.map((t) => ({
      ...t,
      _kind: "tx",
      _ts: `${t.date} ${t.time || "00:00:00"}`,
    })),
    ...corporateActions.map((c) => ({
      ...c,
      _kind: "corp",
      _ts: `${c.date} 23:59:59`,
    })),
  ];
  events.sort((a, b) => a._ts.localeCompare(b._ts));

  const state = new Map();
  function s(sym) {
    if (!state.has(sym))
      state.set(sym, { open_lots: [], realized_pnl: 0 });
    return state.get(sym);
  }

  for (const ev of events) {
    if (ev._kind === "corp") {
      if (ev.type === "split") {
        const ratio = ev.ratio_to / ev.ratio_from;
        for (const lot of s(ev.symbol).open_lots) {
          lot.qty *= ratio;
          lot.price /= ratio;
          lot.cost_per_unit /= ratio;
        }
      }
      continue;
    }
    const tx = ev;
    const qty = Math.abs(tx.quantity);
    const comm = Math.abs(tx.commission || 0);
    const commPerUnit = qty > 0 ? comm / qty : 0;
    if (tx.type === "BUY") {
      s(tx.symbol).open_lots.push({
        date: tx.date,
        qty,
        price: tx.price,
        cost_per_unit: tx.price + commPerUnit,
      });
    } else if (tx.type === "SELL") {
      let remaining = qty;
      const sellNet = tx.price - commPerUnit;
      const lots = s(tx.symbol).open_lots;
      while (remaining > 0 && lots.length > 0) {
        const lot = lots[0];
        const take = Math.min(remaining, lot.qty);
        s(tx.symbol).realized_pnl += take * (sellNet - lot.cost_per_unit);
        lot.qty -= take;
        remaining -= take;
        if (lot.qty <= 1e-9) lots.shift();
      }
    }
  }

  const result = {};
  for (const [sym, st] of state.entries()) {
    let net_qty = 0;
    let cost = 0;
    for (const lot of st.open_lots) {
      net_qty += lot.qty;
      cost += lot.qty * lot.cost_per_unit;
    }
    result[sym] = {
      net_qty,
      avg_open_price: net_qty > 0 ? cost / net_qty : 0,
      realized_pnl: st.realized_pnl,
    };
  }
  return result;
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

async function sendResendEmail(env, subject, html, text) {
  if (!env.RESEND_API_KEY) {
    return { ok: false, error: "RESEND_API_KEY není nastavený (secret)" };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [env.EMAIL_TO],
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    return { ok: false, error: `Resend ${res.status}: ${errText}` };
  }
  const data = await res.json();
  return { ok: true, id: data.id };
}

// ---------- Helpers ----------
async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "akcie-tracker-cron" },
  });
  if (!res.ok) throw new Error(`Fetch ${url} → ${res.status}`);
  return res.json();
}

function fmtNum(n, decimals = 2) {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString("cs-CZ", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return "—";
  return `${n > 0 ? "+" : ""}${fmtNum(n, 2)} %`;
}

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

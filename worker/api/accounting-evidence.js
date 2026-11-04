/**
 * GET /api/accounting-evidence?owner=plegi-invest&from=2025-01-01&to=2025-12-31
 *
 * Evidence portfolií jednoho vlastníka pro odsouhlasení s účetnictvím. Čte ji
 * účetní BI (Worker plegi-invest-bi) přes service binding a porovnává s deníkem
 * z POHODY: účet 063 po titulech, prodeje (661/561), dividendy (665) a hotovost
 * u brokerů.
 *
 * Metodika je ta appky (Report pro účetní, Pozice k datu): FIFO zvlášť pro
 * každé portfolio, pořizovací cena včetně poplatků, rozhoduje datum vypořádání
 * a Kč kurzem ČNB k němu — strict, chybějící kurz = null a varování. Nákup nese
 * Kč i kurzem ke dni obchodu (czk_trade): účetní tak přepočetla nákupy u IBKR
 * 12/2025 a BI podle toho páruje analytiky.
 *
 * Odpověď po portfoliích:
 *   purchases   – každý nákup (BUY se stejným dnem obchodu a vypořádání, IBKR
 *                 dělí pokyn na víc obchodů; bonusové kusy z corporate actions
 *                 s nulovou cenou) vypořádaný do `to`: cena v měně a Kč, kolik
 *                 z něj bylo drženo den před `from` (start_*) a k `to` (end_*)
 *   sales       – prodeje vypořádané v období: hrubě (= tržba), poplatek,
 *                 FIFO pořizovací cena v Kč a nákupy, ze kterých šly
 *   dividends   – dividendy hrubě v období, withholding – sražená daň (kladně)
 *   cash        – hotovost den před `from` a k `to` (cashAtDate: IBKR denní NAV,
 *                 KB kvartální výpis), oceněná kurzem ČNB k tomu dni
 *   cash_flows  – pohyby hotovosti v období (vklady, výběry, konverze, poplatky)
 *
 * Bez vlastního tokenu: /api/* je za Cloudflare Access a service binding jde
 * jen z Workerů stejného účtu. Jen čtení.
 */

import { cashAtDate, computePositionsAt } from "../../assets/js/fifo.js";
import { cashToCzk, fxToCzk, realizedSales } from "../../assets/js/portfolio-shared.js";
import { resolveOwners } from "../../assets/js/owners.js";
import { addDays, loadPortfolio } from "../mcp/akcie-den.js";
import { fetchAssetJson, jsonResponse } from "./lib.js";

export async function get(request, env) {
  const params = parseParams(new URL(request.url).searchParams);
  if (params.error) return jsonResponse({ error: params.error }, 400);

  const [manifest, fxRates, settings] = await Promise.all([
    fetchAssetJson(env, "/data/portfolios/manifest.json"),
    fetchAssetJson(env, "/data/fx_rates.json"),
    env.AKCIE_TRACKER_KV.get("settings", "json"),
  ]);
  // Vlastníci z Nastavení jako v appce — firma nikdy nedostane cizí portfolio
  const owner = resolveOwners(manifest, settings).owners.find((o) => o.id === params.owner);
  if (!owner) return jsonResponse({ error: `Neznámý vlastník „${params.owner}“` }, 404);

  const metas = manifest.portfolios.filter((m) => owner.portfolios.includes(m.id));
  const loaded = await Promise.all(metas.map((meta) => loadPortfolio(env, meta, fxRates)));
  return jsonResponse(buildAccountingEvidence({ owner, from: params.from, to: params.to, loaded, fxRates }));
}

function isIsoDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function parseParams(searchParams) {
  const owner = (searchParams.get("owner") || "").trim();
  const from = searchParams.get("from") || "";
  const to = searchParams.get("to") || "";
  if (!owner) return { error: "Chybí ?owner= – id vlastníka z Nastavení (např. plegi-invest)" };
  if (!isIsoDate(from) || !isIsoDate(to)) return { error: "from a to musí být skutečná data ve tvaru YYYY-MM-DD" };
  if (from > to) return { error: "from musí být nejpozději to" };
  return { owner, from, to };
}

// ---------- Čisté funkce (testované bez sítě) ----------

const round = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

// Klíč nákupu sedí s FIFO loty: lot z BUY nese datum obchodu i vypořádání,
// bonusový lot z corporate action jen datum
const lotKey = (symbol, date, settle) => `${symbol}|${date}|${settle || "bonus"}`;

export function buildAccountingEvidence({ owner, from, to, loaded, fxRates, now = new Date() }) {
  const warnings = [];
  const dayBefore = addDays(from, -1);
  const portfolios = loaded.map(({ meta, portfolio, lastImport }) =>
    portfolioEvidence({ meta, portfolio, lastImport, from, to, dayBefore, fxRates, warnings }),
  );
  return {
    owner: { id: owner.id, name: owner.name, type: owner.type },
    from,
    to,
    generated_at: now.toISOString(),
    fx_last_date: Object.keys(fxRates?.dates || {}).sort().pop() || null,
    // Věta pro čtenáře (BI ji ukazuje pod čísly) — bez názvů polí
    methodology:
      "FIFO zvlášť pro každé portfolio, pořizovací cena včetně poplatků, rozhoduje datum vypořádání " +
      "a Kč kurzem ČNB k němu.",
    portfolios,
    warnings,
  };
}

function portfolioEvidence({ meta, portfolio, lastImport, from, to, dayBefore, fxRates, warnings }) {
  const label = meta.short || meta.id;
  const instruments = portfolio.instruments || {};
  const describe = (symbol) => {
    const inst = instruments[symbol] || {};
    return { isin: inst.isin || null, name: inst.name || symbol, currency: inst.currency || null };
  };
  const txs = portfolio.transactions || [];
  const cas = portfolio.corporate_actions || [];
  const atStart = computePositionsAt(txs, cas, dayBefore);
  const atEnd = computePositionsAt(txs, cas, to);

  return {
    id: meta.id,
    name: meta.name || portfolio.name || meta.id,
    short: meta.short || null,
    broker: meta.broker || portfolio.broker || null,
    account: portfolio.account || null,
    base_currency: portfolio.base_currency || null,
    inception_date: portfolio.inception_date || null,
    last_import: lastImport || null,
    purchases: purchasesOf({ portfolio, to, atStart, atEnd, describe, fxRates, warnings, label }),
    sales: salesOf({ atEnd, instruments, from, to, describe, fxRates, warnings, label }),
    dividends: incomeOf(portfolio.dividends, 1, { from, to, describe, fxRates, warnings, label }),
    withholding: incomeOf(portfolio.withholding_tax, -1, { from, to, describe, fxRates, warnings, label }),
    cash: {
      start: cashOf(portfolio, dayBefore, fxRates, warnings, label),
      end: cashOf(portfolio, to, fxRates, warnings, label),
    },
    cash_flows: (portfolio.cash_flows || [])
      .filter((f) => f.date >= from && f.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((f) => ({
        date: f.date,
        type: f.type || null,
        currency: f.currency || null,
        amount: round(parseFloat(f.amount), 2),
        description: f.description || "",
      })),
  };
}

// Zbytek lotů držený k datu po klíči nákupu — cena v měně se splitem nemění
function openByKey(positions) {
  const out = new Map();
  for (const [symbol, pos] of Object.entries(positions)) {
    for (const lot of pos.open_lots || []) {
      const key = lotKey(symbol, lot.date, lot.settle_date);
      const o = out.get(key) || { qty: 0, cost: 0, date: lot.date };
      o.qty += lot.qty;
      o.cost += lot.qty * lot.cost_per_unit;
      out.set(key, o);
    }
  }
  return out;
}

function purchasesOf({ portfolio, to, atStart, atEnd, describe, fxRates, warnings, label }) {
  const map = new Map();
  for (const t of portfolio.transactions || []) {
    if (t.type !== "BUY") continue;
    const settle = t.settle_date || t.date;
    if (settle > to) continue;
    const key = lotKey(t.symbol, t.date, settle);
    let p = map.get(key);
    if (!p) {
      p = { key, symbol: t.symbol, ...describe(t.symbol), trade_date: t.date, settle_date: settle, qty: 0, cost: 0, synthetic: false, bonus: false };
      map.set(key, p);
    }
    // Cena jako lot ve FIFO: autoritativní je objem (KB zaokrouhluje kurz), komise do ceny
    const qty = Math.abs(t.quantity);
    const value = t.proceeds != null && Math.abs(t.proceeds) > 0 ? Math.abs(t.proceeds) : qty * t.price;
    p.qty += qty;
    p.cost += value + Math.abs(t.commission || 0);
    if (t.synthetic_opening) p.synthetic = true;
  }

  const start = openByKey(atStart);
  const end = openByKey(atEnd);
  // Bonusové kusy (nespárované připsání CP u KB) nejsou BUY — jen lot za 0
  for (const [key, o] of [...start, ...end]) {
    if (map.has(key)) continue;
    const symbol = key.split("|")[0];
    map.set(key, { key, symbol, ...describe(symbol), trade_date: o.date, settle_date: null, qty: o.qty, cost: 0, synthetic: false, bonus: true });
  }

  const out = [];
  for (const p of map.values()) {
    const fx = p.bonus ? null : fxToCzk(fxRates, p.settle_date, p.currency);
    const fxTrade = p.bonus ? null : fxToCzk(fxRates, p.trade_date, p.currency, { allowFallback: true });
    if (fx == null && !p.bonus) {
      warnings.push(`${label} ${p.symbol}: chybí kurz ČNB ${p.currency} k ${p.settle_date} – nákup je bez Kč.`);
    }
    const czk = (x) => (p.bonus ? 0 : fx == null ? null : round(x * fx, 2));
    const s = start.get(p.key) || { qty: 0, cost: 0 };
    const e = end.get(p.key) || { qty: 0, cost: 0 };
    out.push({
      symbol: p.symbol,
      isin: p.isin,
      name: p.name,
      currency: p.currency,
      trade_date: p.trade_date,
      settle_date: p.settle_date,
      qty: round(p.qty, 6),
      cost: round(p.cost, 2),
      fx,
      czk: czk(p.cost),
      fx_trade: fxTrade,
      czk_trade: p.bonus ? 0 : fxTrade == null ? null : round(p.cost * fxTrade, 2),
      synthetic: p.synthetic,
      bonus: p.bonus,
      start_qty: round(s.qty, 6),
      start_cost: round(s.cost, 2),
      start_czk: czk(s.cost),
      end_qty: round(e.qty, 6),
      end_cost: round(e.cost, 2),
      end_czk: czk(e.cost),
    });
  }
  return out.sort(
    (a, b) => a.symbol.localeCompare(b.symbol) || a.trade_date.localeCompare(b.trade_date) || String(a.settle_date).localeCompare(String(b.settle_date)),
  );
}

function salesOf({ atEnd, instruments, from, to, describe, fxRates, warnings, label }) {
  for (const [symbol, pos] of Object.entries(atEnd)) {
    for (const cl of pos.closed_lots || []) {
      const sd = cl.sell_settle_date || cl.sell_date;
      if (cl.orphan && sd >= from && sd <= to) {
        warnings.push(`${label} ${symbol}: prodej ${cl.qty} ks vypořádaný ${sd} nemá nákup v evidenci – není v prodejích.`);
      }
    }
  }
  return realizedSales(atEnd, instruments, fxRates, { from, to }).map((ev) => {
    // Hrubě = kusy × prodejní cena po lotech (jeden den může mít víc prodejů za různé ceny)
    const gross = ev.buys.reduce((sum, b) => sum + b.gross, 0);
    if (!ev.allFxFound) {
      warnings.push(`${label} ${ev.symbol}: prodej vypořádaný ${ev.sell_date} bez kurzu ČNB – Kč chybí.`);
    }
    return {
      symbol: ev.symbol,
      ...describe(ev.symbol),
      trade_date: ev.sell_trade_date,
      settle_date: ev.sell_date,
      qty: round(ev.sell_qty, 6),
      gross: round(gross, 2),
      net: round(ev.sell_net_total, 2),
      fee: round(gross - ev.sell_net_total, 2),
      fx: ev.sellFx,
      gross_czk: ev.sellFx == null ? null : round(gross * ev.sellFx, 2),
      net_czk: round(ev.sellCzk, 2),
      cost_czk: ev.allFxFound ? round(ev.costCzk, 2) : null,
      profit_czk: round(ev.profitCzk, 2),
      fx_ok: ev.allFxFound,
      lots: ev.buys.map((b) => ({ trade_date: b.trade_date, settle_date: b.date, qty: round(b.qty, 6), cost: round(b.total, 2), czk: round(b.czk, 2) })),
    };
  });
}

// Dividendy a srážková daň v období v Kč kurzem ke dni výplaty. Daň se vrací
// kladně (sign = −1); vrácená daň je pak záporná.
function incomeOf(records, sign, { from, to, describe, fxRates, warnings, label }) {
  return (records || [])
    .filter((r) => r.symbol && r.date >= from && r.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol))
    .map((r) => {
      let fx = fxToCzk(fxRates, r.date, r.currency);
      let estimated = false;
      if (fx == null) {
        fx = fxToCzk(fxRates, r.date, r.currency, { allowFallback: true });
        estimated = fx != null;
        warnings.push(`${label} ${r.symbol}: ${sign > 0 ? "dividenda" : "srážková daň"} ${r.date} bez kurzu ČNB k tomu dni – ${estimated ? "použit předchozí vyhlášený" : "Kč chybí"}.`);
      }
      const amount = sign * (Number(r.amount) || 0);
      return {
        date: r.date,
        symbol: r.symbol,
        ...describe(r.symbol),
        currency: r.currency,
        amount: round(amount, 2),
        fx,
        czk: fx == null ? null : round(amount * fx, 2),
        fx_estimated: estimated,
        description: r.description || "",
      };
    });
}

function cashOf(portfolio, date, fxRates, warnings, label) {
  const c = cashAtDate(portfolio, date);
  if (!c) return null;
  if (c.asOf < date) {
    warnings.push(`${label}: hotovost k ${date} je ze stavu k ${c.asOf} (${c.source || "evidence"}) – novější výpis v evidenci není.`);
  }
  const valued = cashToCzk(c.cash, fxRates, date, { allowFallback: true });
  return {
    date,
    as_of: c.asOf,
    source: c.source || null,
    estimate: c.estimate === true,
    balances: [
      ...valued.items.map((i) => ({ currency: i.currency, amount: round(i.amount, 2), fx: i.rate, czk: round(i.czk, 2) })),
      ...valued.missing.map((ccy) => ({ currency: ccy, amount: round(c.cash[ccy], 2), fx: null, czk: null })),
    ].sort((a, b) => a.currency.localeCompare(b.currency)),
    czk: round(valued.czk, 2),
  };
}

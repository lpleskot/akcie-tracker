/**
 * Daňová optimalizace (tab „Daňová optimalizace", zadání PLEGIN #7, 28. 10. 2026)
 * — za celou společnost, tedy přes všechna portfolia: co by daňově znamenal
 * prodej každé držené pozice dnes a jaký je výsledek prodejů v daňovém roce.
 *
 * Daňový pohled je v Kč kurzy ČNB: nákup kurzem k datu vypořádání každého
 * otevřeného lotu (FIFO), hypotetický prodej dnešní cenou a posledním
 * vyhlášeným kurzem — stejná metodika jako Report pro účetní, jen pro prodej,
 * který ještě neproběhl. Proto se Z/Z v Kč liší od Nereal. Z/Z v měně
 * (Přehled pozic) o kurzový rozdíl. Realizace je po účtech (každý broker má
 * vlastní FIFO), daň za společnost je součet.
 *
 * Čisté funkce bez DOM a globálního stavu — tests/tax-optimization.test.mjs.
 */

import { computePositions, unrealizedPnl } from "./fifo.js";
import { fxDateFor, fxToCzk, openLotsCostCzk, realizedSales } from "./portfolio-shared.js";

// Sazba daně z příjmů právnických osob od 2024 (§ 21 ZDP)
export const DPPO_RATE = 0.21;

export function taxEstimate(net) {
  return net > 0 ? net * DPPO_RATE : 0;
}

export function accountLabel(meta) {
  return meta.short || meta.broker || meta.name || meta.id;
}

/** FIFO pozice každého portfolia — počítá se jednou, sdílí řádky i realizace. */
export function withPositions(portfolios) {
  return portfolios.map(({ meta, portfolio }) => ({
    meta,
    portfolio,
    positions: computePositions(
      portfolio.transactions || [],
      portfolio.corporate_actions || [],
      portfolio.dividends || [],
      portfolio.withholding_tax || [],
    ),
  }));
}

/**
 * Řádek za každou drženou pozici každého účtu. quotes = odpověď /api/quote
 * (klíč yahoo symbol, `price` v hlavní jednotce měny). `sellable` = jde
 * prodat a hodnoty jsou kompletní — jen takové pozice vstupují do součtů
 * a simulace. Delisted titul prodat nejde: ztráta se realizuje až odpisem.
 */
export function taxPositionRows(accounts, quotes, fxRates, today) {
  const rows = [];
  for (const { meta, portfolio, positions } of accounts) {
    for (const sym of Object.keys(positions).sort((a, b) => a.localeCompare(b, "cs"))) {
      const pos = positions[sym];
      if (!(pos.net_qty > 1e-9)) continue;
      const inst = portfolio.instruments?.[sym] || {};
      const currency = inst.currency || null;
      const q = quotes?.[inst.yahoo_symbol || sym];
      const notes = [];

      let price = null;
      if (inst.delisted) {
        price = 0;
        notes.push(`staženo z burzy ${inst.delisted} – nelze prodat, ztráta se realizuje až odpisem`);
      } else if (q && !q.error && Number.isFinite(q.price)) {
        price = q.price;
        if (q.currency && currency && q.currency !== currency) notes.push(`cena v ${q.currency}, pozice v ${currency}`);
      } else {
        notes.push("chybí aktuální cena");
      }

      const fxNow = fxToCzk(fxRates, today, currency, { allowFallback: true });
      if (fxNow == null) notes.push(`chybí kurz ČNB ${currency}`);
      const cost = openLotsCostCzk(pos.open_lots, currency, fxRates, { estimateLatest: true });
      if (cost.czk == null) notes.push("chybí kurz ČNB k datu nákupu");
      if (cost.estimated) notes.push("čerstvý nákup – kurz ČNB k vypořádání odhadem");

      const valueLocal = price != null ? pos.net_qty * price : null;
      const valueCzk = valueLocal != null && fxNow != null ? valueLocal * fxNow : null;
      const pnlCzk = valueCzk != null && cost.czk != null ? valueCzk - cost.czk : null;

      rows.push({
        key: `${meta.id}|${sym}`,
        portfolioId: meta.id,
        account: accountLabel(meta),
        sym,
        name: inst.name || sym,
        currency,
        qty: pos.net_qty,
        price,
        fxNow,
        costLocal: pos.cost_basis,
        costCzk: cost.czk,
        valueLocal,
        valueCzk,
        pnlLocal: price != null ? unrealizedPnl(pos, price).value : null,
        pnlCzk,
        pct: pnlCzk != null && cost.czk > 0 ? (pnlCzk / cost.czk) * 100 : null,
        lots: mergeLots(cost.lots, price, fxNow),
        lastBuy: cost.lots.reduce((max, l) => (l.fxDate > max ? l.fxDate : max), ""),
        delisted: inst.delisted || null,
        sellable: !inst.delisted && pnlCzk != null,
        note: notes.join("; "),
      });
    }
  }
  return rows;
}

// Loty se stejným datem vypořádání sloučit (IBKR dělí příkaz na víc fillů) —
// v detailu jeden řádek na nákup, jako v Reportu pro účetní
function mergeLots(lots, price, fxNow) {
  const byDate = new Map();
  for (const l of lots) {
    const k = l.fxDate;
    if (!byDate.has(k)) {
      byDate.set(k, { date: l.date, settleDate: k, qty: 0, cost: 0, czk: 0, fx: l.fx, czkOk: true, estimated: false });
    }
    const m = byDate.get(k);
    m.qty += l.qty;
    m.cost += l.cost;
    if (l.czk == null) m.czkOk = false;
    else m.czk += l.czk;
    if (l.estimated) m.estimated = true;
  }
  return [...byDate.values()]
    .sort((a, b) => a.settleDate.localeCompare(b.settleDate))
    .map((m) => {
      const czk = m.czkOk ? m.czk : null;
      const valueCzk = price != null && fxNow != null ? m.qty * price * fxNow : null;
      return {
        date: m.date,
        settleDate: m.settleDate,
        qty: m.qty,
        costPerUnit: m.qty > 0 ? m.cost / m.qty : 0,
        fx: m.fx,
        estimated: m.estimated,
        costCzk: czk,
        valueCzk,
        pnlCzk: valueCzk != null && czk != null ? valueCzk - czk : null,
      };
    });
}

/**
 * Výsledek prodejů vypořádaných v roce — součet Reportu pro účetní za každý
 * účet. Prodej bez kompletních kurzů ČNB se nesčítá a vrátí se v `missing`.
 */
export function realizedInYear(accounts, fxRates, year) {
  const range = { from: `${year}-01-01`, to: `${year}-12-31` };
  const out = { net: 0, gains: 0, losses: 0, sales: 0, byAccount: [], missing: [] };
  for (const { meta, portfolio, positions } of accounts) {
    let net = 0;
    for (const ev of realizedSales(positions, portfolio.instruments, fxRates, range)) {
      out.sales++;
      if (!ev.allFxFound) {
        out.missing.push(`${ev.symbol} (${accountLabel(meta)}, vypořádání ${ev.sell_date})`);
        continue;
      }
      net += ev.profitCzk;
      if (ev.profitCzk >= 0) out.gains += ev.profitCzk;
      else out.losses += ev.profitCzk;
    }
    out.net += net;
    out.byAccount.push({ account: accountLabel(meta), net });
  }
  return out;
}

/**
 * Dividendy připsané v roce v Kč kurzem ČNB k datu výplaty (strict). Jen
 * informace: dividendy jsou samostatný základ daně a ztráta z prodejů je
 * nekompenzuje.
 */
export function dividendsInYear(accounts, fxRates, year) {
  const out = { grossCzk: 0, withheldCzk: 0, count: 0, missing: 0 };
  const add = (items, field) => {
    for (const d of items || []) {
      if (!d.date || !d.date.startsWith(`${year}-`) || !Number.isFinite(d.amount)) continue;
      const fx = fxToCzk(fxRates, d.date, d.currency);
      if (fx == null) {
        out.missing++;
        continue;
      }
      out[field] += d.amount * fx;
      if (field === "grossCzk") out.count++;
    }
  };
  for (const { portfolio } of accounts) {
    add(portfolio.dividends, "grossCzk");
    add(portfolio.withholding_tax, "withheldCzk");
  }
  return out;
}

/** Součty prodejných pozic: nerealizovaný zisk a ztráta v Kč. */
export function unrealizedTotals(rows) {
  const t = { gains: 0, losses: 0, gainCount: 0, lossCount: 0, excluded: [] };
  for (const r of rows) {
    if (!r.sellable) {
      t.excluded.push(r);
      continue;
    }
    if (r.pnlCzk >= 0) {
      t.gains += r.pnlCzk;
      t.gainCount++;
    } else {
      t.losses += r.pnlCzk;
      t.lossCount++;
    }
  }
  return t;
}

/** Simulace: výsledek roku, kdyby se vybrané pozice dnes prodaly celé. */
export function simulateSale(realizedNet, rows, selectedKeys) {
  let selectedPnl = 0;
  let count = 0;
  for (const r of rows) {
    if (!r.sellable || !selectedKeys.has(r.key)) continue;
    selectedPnl += r.pnlCzk;
    count++;
  }
  const net = realizedNet + selectedPnl;
  return { count, selectedPnl, net, tax: taxEstimate(net) };
}

/** Den a datum vyhlášení kurzu, kterým se oceňuje „dnes". */
export function currentFxInfo(fxRates, today) {
  const date = fxDateFor(fxRates, today);
  return { date, validFor: date ? fxRates?.dates?.[date]?.valid_for || date : null };
}

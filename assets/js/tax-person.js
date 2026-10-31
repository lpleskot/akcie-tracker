/**
 * Daňová optimalizace pro fyzickou osobu (vlastník typu osoba – Lynx). Lukáš
 * 31. 10. 2026: „pohled, kde jasně vidím, jak dlouho to držím a kdy mi vyprší
 * časový test".
 *
 * Prodej cenných papírů je u osoby ostatní příjem (§ 10 ZDP). Je osvobozený, když
 * - úhrn příjmů z prodejů cenných papírů za rok nepřesáhne 100 000 Kč
 *   (§ 4 odst. 1 písm. t) ZDP) — počítají se VŠECHNY prodeje roku včetně těch se
 *   splněným časovým testem: Pokyn GFŘ D-59 (k tehdejším písm. w) a x)) — limit
 *   „neposuzuje okamžik nabytí", osvobození podle výše příjmu a časového testu
 *   „nelze kombinovat"; jinak
 * - doba mezi nabytím a prodejem přesáhne 3 roky (časový test, písm. u)) —
 *   posuzuje se každý nákup zvlášť a prodávají se nejdřív nejstarší (FIFO).
 * Zdanitelné prodeje: zisky a ztráty roku se sčítají, ztráta se nepřenáší;
 * daň 15 % (23 % nad 36násobek průměrné mzdy). Strop osvobození 40 mil. Kč platil
 * pro cenné papíry jen v roce 2025.
 *
 * Doba držby se počítá opatrně: od VYPOŘÁDÁNÍ nákupu (připsání na účet, o 1–2 dny
 * později než obchod) do dne OBCHODU prodeje. Který den rozhoduje, se vykládá
 * různě — takhle vyjde test nejpozději, nikdy dřív. Pro držené nákupy navíc
 * rezerva SAFETY_DAYS (Lukáš 31. 10. 2026: „ať vidím, že musím radši čekat").
 *
 * Kč stejně jako u firmy (tax-optimization.js): nákup kurzem ČNB k datu
 * vypořádání, prodej k datu vypořádání, rok prodeje podle vypořádání.
 *
 * Čisté funkce bez DOM a globálního stavu — tests/tax-person.test.mjs.
 */

import { realizedSales } from "./portfolio-shared.js";
import { accountLabel } from "./tax-optimization.js";

export const TIME_TEST_YEARS = 3;
export const VALUE_LIMIT_CZK = 100_000;
export const PIT_RATE = 0.15;
// Rezerva navíc k časovému testu u držených nákupů — prodávat až po ní
export const SAFETY_DAYS = 3;

const toMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
export const daysBetween = (from, to) => Math.round((toMs(to) - toMs(from)) / 86400000);
const addDays = (iso, n) => new Date(toMs(iso) + n * 86400000).toISOString().slice(0, 10);

/**
 * První den obchodu, kdy je prodej osvobozený: den po třetím výročí nabytí.
 * Výročí 29. 2. v nepřestupném roce připadne na 28. 2.
 */
export function timeTestDate(acquired) {
  const [y, m, d] = acquired.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y + TIME_TEST_YEARS, m, 0)).getUTCDate();
  const anniversary = Date.UTC(y + TIME_TEST_YEARS, m - 1, Math.min(d, lastDay));
  return new Date(anniversary + 86400000).toISOString().slice(0, 10);
}

/** Od kdy prodávat: časový test + rezerva SAFETY_DAYS. */
export const safeSellDate = (acquired) => addDays(timeTestDate(acquired), SAFETY_DAYS);

/** Doba držby kalendářně v celých letech a měsících, k tomu dny celkem. */
export function holding(from, to) {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  const months = Math.max(0, (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0));
  return { years: Math.floor(months / 12), months: months % 12, days: daysBetween(from, to) };
}

export const personTax = (net) => (net > 0 ? net * PIT_RATE : 0);

// Součet pole přes loty; chybí-li hodnota u kteréhokoli, součet není známý
const sumOf = (list, field) => list.reduce((s, l) => (s == null || l[field] == null ? null : s + l[field]), 0);

/**
 * Řádky Daňové optimalizace (taxPositionRows) doplněné o časový test každého
 * drženého nákupu k `today`. Nákup je „bez daně" až po rezervě (safeFrom),
 * mezi koncem lhůty a koncem rezervy je `inBuffer`. exemptQty = kusy, které jde
 * dnes prodat bez daně: FIFO prodává nejdřív nejstarší nákupy, a to jsou právě
 * ty se splněným testem.
 */
export function withTimeTest(rows, today) {
  return rows.map((r) => {
    const lots = r.lots.map((l) => {
      const exemptFrom = timeTestDate(l.settleDate);
      const safeFrom = safeSellDate(l.settleDate);
      return {
        ...l,
        held: holding(l.settleDate, today),
        exemptFrom,
        safeFrom,
        daysLeft: daysBetween(today, safeFrom),
        exempt: today >= safeFrom,
        inBuffer: today >= exemptFrom && today < safeFrom,
      };
    });
    const exemptLots = lots.filter((l) => l.exempt);
    const taxableLots = lots.filter((l) => !l.exempt);
    return {
      ...r,
      lots,
      exemptQty: exemptLots.reduce((s, l) => s + l.qty, 0),
      exemptValueCzk: sumOf(exemptLots, "valueCzk"),
      exemptPnlCzk: sumOf(exemptLots, "pnlCzk"),
      taxablePnlCzk: sumOf(taxableLots, "pnlCzk"),
      nextTest: taxableLots[0] || null,
    };
  });
}

/**
 * Držené pozice v kostce: co jde dnes prodat bez daně a nákupy, kterým časový
 * test teprve doběhne (od nejbližšího).
 */
export function timeTestSummary(rows) {
  const out = { exemptValueCzk: 0, exemptPnlCzk: 0, exemptLots: 0, upcoming: [] };
  for (const r of rows) {
    if (!r.sellable) continue;
    for (const l of r.lots) {
      if (l.exempt) {
        out.exemptValueCzk += l.valueCzk;
        out.exemptPnlCzk += l.pnlCzk;
        out.exemptLots++;
      } else {
        out.upcoming.push({ sym: r.sym, account: r.account, qty: l.qty, safeFrom: l.safeFrom, daysLeft: l.daysLeft, valueCzk: l.valueCzk });
      }
    }
  }
  out.upcoming.sort((a, b) => a.safeFrom.localeCompare(b.safeFrom) || a.sym.localeCompare(b.sym, "cs"));
  return out;
}

/**
 * Prodeje vypořádané v roce po nákupech, s časovým testem každého prodaného
 * nákupu (bez rezervy — prodej už proběhl; `tight` = prodáno v rezervě, tedy
 * nejvýš 3 dny po konci lhůty). Příjem = prodejní cena (do limitu 100 000 Kč),
 * výdaje = nákup vč. komise + komise z prodeje. Prodej bez kurzu ČNB se nesčítá
 * a je v `missing`.
 */
export function personSalesInYear(accounts, fxRates, year) {
  const out = { lines: [], grossCzk: 0, exemptPnl: 0, gains: 0, losses: 0, missing: [] };
  const missing = new Set();
  for (const { meta, portfolio, positions } of accounts) {
    for (const ev of realizedSales(positions, portfolio.instruments, fxRates, { from: `${year}-01-01`, to: `${year}-12-31` })) {
      for (const b of ev.buys) {
        const exemptFrom = timeTestDate(b.date);
        const exempt = ev.sell_trade_date >= exemptFrom;
        const grossCzk = ev.sellFx != null ? b.gross * ev.sellFx : null;
        const netCzk = ev.sellFx != null ? b.net * ev.sellFx : null;
        const pnlCzk = netCzk != null && b.czk != null ? netCzk - b.czk : null;
        out.lines.push({
          account: accountLabel(meta),
          symbol: ev.symbol,
          name: ev.name,
          sellDate: ev.sell_trade_date,
          sellSettle: ev.sell_date,
          buyDate: b.trade_date,
          buySettle: b.date,
          qty: b.qty,
          held: holding(b.date, ev.sell_trade_date),
          exemptFrom,
          exempt,
          tight: exempt && ev.sell_trade_date < safeSellDate(b.date),
          grossCzk,
          expensesCzk: pnlCzk != null ? grossCzk - pnlCzk : null,
          pnlCzk,
        });
        if (pnlCzk == null) {
          missing.add(`${ev.symbol} (${accountLabel(meta)}, vypořádání ${ev.sell_date})`);
          continue;
        }
        out.grossCzk += grossCzk;
        if (exempt) out.exemptPnl += pnlCzk;
        else if (pnlCzk >= 0) out.gains += pnlCzk;
        else out.losses += pnlCzk;
      }
    }
  }
  out.lines.sort((a, b) => a.sellDate.localeCompare(b.sellDate) || a.symbol.localeCompare(b.symbol, "cs") || a.buySettle.localeCompare(b.buySettle));
  out.missing = [...missing];
  out.overLimit = out.grossCzk > VALUE_LIMIT_CZK;
  out.taxableNet = out.overLimit ? out.gains + out.losses : 0;
  out.tax = personTax(out.taxableNet);
  return out;
}

/**
 * Simulace: rok, kdyby se vybrané pozice dnes prodaly celé — příjem = hodnota
 * dnes, do zdanitelného výsledku jen nákupy bez splněného časového testu.
 */
export function simulatePersonSale(sales, rows, selectedKeys) {
  const sim = { count: 0, valueCzk: 0, taxablePnl: 0, exemptPnl: 0 };
  for (const r of rows) {
    if (!r.sellable || !selectedKeys.has(r.key)) continue;
    sim.count++;
    sim.valueCzk += r.valueCzk;
    sim.taxablePnl += r.taxablePnlCzk;
    sim.exemptPnl += r.exemptPnlCzk;
  }
  sim.grossCzk = sales.grossCzk + sim.valueCzk;
  sim.overLimit = sim.grossCzk > VALUE_LIMIT_CZK;
  sim.net = sim.overLimit ? sales.gains + sales.losses + sim.taxablePnl : 0;
  sim.tax = personTax(sim.net);
  return sim;
}

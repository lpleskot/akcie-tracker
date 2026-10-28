/**
 * Unit testy tabu Daňová optimalizace (zadání PLEGIN #7) a sdílených výpočtů,
 * které používá i Report pro účetní: realizované prodeje v Kč, pořizovací
 * cena otevřených lotů v Kč, daňový pohled na držené pozice, výsledek roku,
 * dividendy a simulace prodeje. Kurzy a ceny jsou ručně zvolené fixtures.
 *
 * Spuštění: node --test tests/*.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openLotsCostCzk, realizedSales } from "../assets/js/portfolio-shared.js";
import { computePositions } from "../assets/js/fifo.js";
import {
  dividendsInYear,
  lossCarryOverview,
  realizedInYear,
  simulateSale,
  taxEstimate,
  taxPositionRows,
  unrealizedTotals,
  withPositions,
} from "../assets/js/tax-optimization.js";

function close(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) < eps, `očekáváno ${expected}, dostal ${actual}`);
}

// Kurzy ČNB: USD 23 (2025), 22 (2026-03), 21,5 (poslední den 2026-10-27); EUR 25
function fx(days) {
  const dates = {};
  for (const [date, usd] of Object.entries(days)) {
    dates[date] = { valid_for: date, rates: { USD: { rate: usd, amount: 1 }, EUR: { rate: 25, amount: 1 } } };
  }
  return { dates };
}
const FX = fx({
  "2025-06-02": 23,
  "2025-12-31": 22.5,
  "2026-01-02": 22.4,
  "2026-03-02": 22,
  "2026-10-27": 21.5,
});

function tx(over) {
  return { date: "2025-06-02", settle_date: "2025-06-02", time: "10:00:00", symbol: "AAA", type: "BUY", quantity: 10, price: 100, proceeds: null, commission: 0, ...over };
}

function account(id, { transactions = [], instruments = {}, dividends = [], withholding_tax = [] } = {}) {
  return { meta: { id, short: id.toUpperCase(), broker: id }, portfolio: { instruments, transactions, corporate_actions: [], dividends, withholding_tax } };
}

const INST = { currency: "USD", name: "AAA Corp", yahoo_symbol: "AAA" };

test("realizedSales: prodeje po datu vypořádání, nákupy sloučené po datu, Kč kurzem ČNB", () => {
  const positions = computePositions([
    tx({ quantity: 6, price: 100 }),
    tx({ quantity: 4, price: 110, time: "11:00:00" }), // stejný den vypořádání → jeden řádek nákupu
    tx({ date: "2026-03-02", settle_date: "2026-03-02", type: "SELL", quantity: 10, price: 120 }),
  ]);
  const [ev] = realizedSales(positions, { AAA: INST }, FX, { from: "2026-01-01", to: "2026-12-31" });
  assert.equal(ev.symbol, "AAA");
  assert.equal(ev.sell_date, "2026-03-02");
  assert.equal(ev.buys.length, 1);
  close(ev.buys[0].total, 1040);
  close(ev.costCzk, 1040 * 23);
  close(ev.sellCzk, 1200 * 22);
  close(ev.profitCzk, 1200 * 22 - 1040 * 23); // +2 480 Kč
  assert.equal(ev.allFxFound, true);
  assert.equal(ev.buys[0].fxValidFor, "2025-06-02");
  // mimo období nic
  assert.equal(realizedSales(positions, { AAA: INST }, FX, { from: "2025-01-01", to: "2025-12-31" }).length, 0);
});

test("realizedSales: chybí-li kurz, zisk je null — nikdy tichá nula", () => {
  const positions = computePositions([
    tx({ date: "2025-05-05", settle_date: "2025-05-05" }), // kurz k tomu dni v datech není
    tx({ date: "2026-03-02", settle_date: "2026-03-02", type: "SELL", quantity: 10, price: 50 }),
  ]);
  const [ev] = realizedSales(positions, { AAA: INST }, FX);
  assert.equal(ev.allFxFound, false);
  assert.equal(ev.profitCzk, null);
  assert.equal(ev.buys[0].czk, null);
});

test("openLotsCostCzk: strict, čerstvý nákup po posledním kurzu jen s estimateLatest", () => {
  const lots = [
    { date: "2025-06-02", settle_date: "2025-06-02", qty: 10, cost_per_unit: 100 },
    { date: "2026-10-27", settle_date: "2026-10-28", qty: 2, cost_per_unit: 50 },
  ];
  assert.equal(openLotsCostCzk(lots, "USD", FX).czk, null);
  const est = openLotsCostCzk(lots, "USD", FX, { estimateLatest: true });
  close(est.czk, 1000 * 23 + 100 * 21.5);
  assert.equal(est.estimated, true);
  assert.equal(est.lots[1].estimated, true);
  // díra v kurzech uprostřed historie se neodhaduje
  const hole = openLotsCostCzk([{ date: "2025-05-05", qty: 1, cost_per_unit: 1 }], "USD", FX, { estimateLatest: true });
  assert.equal(hole.czk, null);
});

test("taxPositionRows: kurzový rozdíl — v dolarech nula, v korunách ztráta", () => {
  const accounts = withPositions([account("ibkr", { transactions: [tx({ quantity: 10, price: 100 })], instruments: { AAA: INST } })]);
  const [r] = taxPositionRows(accounts, { AAA: { price: 100, currency: "USD" } }, FX, "2026-10-28");
  close(r.pnlLocal, 0);
  close(r.costCzk, 1000 * 23);
  close(r.valueCzk, 1000 * 21.5); // „dnes" = poslední kurz 27. 10.
  close(r.pnlCzk, -1500);
  close(r.pct, (-1500 / 23000) * 100);
  assert.equal(r.sellable, true);
  assert.equal(r.account, "IBKR");
  assert.equal(r.key, "ibkr|AAA");
});

test("taxPositionRows: loty po datu vypořádání, poslední nákup, čerstvý nákup odhadem", () => {
  const accounts = withPositions([
    account("ibkr", {
      instruments: { AAA: INST },
      transactions: [
        tx({ quantity: 5, price: 100 }),
        tx({ quantity: 5, price: 100, time: "12:00:00" }),
        tx({ date: "2026-03-02", settle_date: "2026-03-02", quantity: 4, price: 90 }),
        tx({ date: "2026-10-27", settle_date: "2026-10-28", quantity: 1, price: 80 }),
      ],
    }),
  ]);
  const [r] = taxPositionRows(accounts, { AAA: { price: 95 } }, FX, "2026-10-28");
  assert.deepEqual(r.lots.map((l) => [l.settleDate, l.qty]), [["2025-06-02", 10], ["2026-03-02", 4], ["2026-10-28", 1]]);
  assert.equal(r.lastBuy, "2026-10-28");
  assert.equal(r.lots[2].estimated, true);
  assert.match(r.note, /odhadem/);
  close(r.lots[1].pnlCzk, 4 * 95 * 21.5 - 360 * 22);
  close(r.pnlCzk, r.lots.reduce((s, l) => s + l.pnlCzk, 0));
});

test("taxPositionRows: delisted a chybějící cena nejdou do součtů ani simulace", () => {
  const accounts = withPositions([
    account("kb", {
      instruments: {
        AAA: INST,
        CNE: { currency: "USD", name: "Canacol", yahoo_symbol: "CNE.TO", delisted: "2025-11-17" },
      },
      transactions: [tx({}), tx({ symbol: "CNE", quantity: 100, price: 5 })],
    }),
  ]);
  const rows = taxPositionRows(accounts, {}, FX, "2026-10-28");
  const cne = rows.find((r) => r.sym === "CNE");
  const aaa = rows.find((r) => r.sym === "AAA");
  assert.equal(cne.sellable, false);
  close(cne.pnlCzk, -500 * 23); // ukáže se, ale realizuje se až odpisem
  assert.match(cne.note, /nelze prodat/);
  assert.equal(aaa.sellable, false);
  assert.equal(aaa.pnlCzk, null);
  assert.match(aaa.note, /chybí aktuální cena/);
  const t = unrealizedTotals(rows);
  assert.equal(t.excluded.length, 2);
  assert.equal(t.losses, 0);
  assert.equal(simulateSale(0, rows, new Set(rows.map((r) => r.key))).count, 0);
});

test("realizedInYear: rok podle data vypořádání, součet za účty, prodej bez kurzu stranou", () => {
  const accounts = withPositions([
    account("ibkr", {
      instruments: { AAA: INST },
      transactions: [
        tx({}),
        // obchod 31. 12. 2025, vypořádání 2. 1. 2026 → patří do roku 2026
        tx({ date: "2025-12-31", settle_date: "2026-01-02", type: "SELL", quantity: 10, price: 90 }),
      ],
    }),
    account("kb", {
      instruments: { BBB: { currency: "USD", name: "BBB" } },
      transactions: [
        tx({ symbol: "BBB", quantity: 2, price: 100 }),
        tx({ symbol: "BBB", date: "2026-03-02", settle_date: "2026-03-02", type: "SELL", quantity: 1, price: 150 }),
        // vypořádání v den, kdy kurz ještě není → mimo součet, ale přiznaný
        tx({ symbol: "BBB", date: "2026-10-27", settle_date: "2026-10-28", type: "SELL", quantity: 1, price: 150 }),
      ],
    }),
  ]);
  assert.equal(realizedInYear(accounts, FX, "2025").sales, 0);
  const r = realizedInYear(accounts, FX, "2026");
  const ibkr = 900 * 22.4 - 1000 * 23; // −2 840
  const kb = 150 * 22 - 100 * 23; // +1 000
  close(r.net, ibkr + kb);
  close(r.gains, kb);
  close(r.losses, ibkr);
  assert.equal(r.sales, 3);
  assert.deepEqual(r.byAccount.map((a) => a.account), ["IBKR", "KB"]);
  assert.equal(r.missing.length, 1);
  assert.match(r.missing[0], /BBB \(KB, vypořádání 2026-10-28\)/);
});

test("dividendsInYear: hrubé dividendy a sražená daň v Kč kurzem k datu výplaty", () => {
  const accounts = withPositions([
    account("ibkr", {
      dividends: [
        { symbol: "AAA", date: "2026-03-02", amount: 10, currency: "USD" },
        { symbol: "AAA", date: "2025-12-31", amount: 99, currency: "USD" }, // jiný rok
        { symbol: "AAA", date: "2026-05-05", amount: 7, currency: "USD" }, // bez kurzu
      ],
      withholding_tax: [{ symbol: "AAA", date: "2026-03-02", amount: -1.5, currency: "USD" }],
    }),
  ]);
  const d = dividendsInYear(accounts, FX, "2026");
  close(d.grossCzk, 220);
  close(d.withheldCzk, -33);
  assert.equal(d.count, 1);
  assert.equal(d.missing, 1);
});

test("simulace a odhad daně: realizace + vybrané pozice, 21 % jen z kladného výsledku", () => {
  const rows = [
    { key: "a", sellable: true, pnlCzk: -50000 },
    { key: "b", sellable: true, pnlCzk: 20000 },
    { key: "c", sellable: false, pnlCzk: -99999 },
  ];
  assert.equal(taxEstimate(-1), 0);
  close(taxEstimate(100000), 21000);
  const none = simulateSale(30000, rows, new Set());
  assert.deepEqual([none.count, none.net], [0, 30000]);
  close(none.tax, 6300);
  const sim = simulateSale(30000, rows, new Set(["a", "c"]));
  assert.equal(sim.count, 1); // c nejde prodat
  assert.equal(sim.net, -20000);
  assert.equal(sim.tax, 0);
  const t = unrealizedTotals(rows);
  assert.deepEqual([t.gains, t.losses, t.gainCount, t.lossCount], [20000, -50000, 1, 1]);
});

test("lossCarryOverview: zpětné odečtení do 2 let, kapacita snížená o dřívější zpětné odečtení, ztráta dopředu", () => {
  const ret = (year, over) => ({ year, filed: `${year + 1}-04-30`, loss_deducted: 0, separate_tax: 0, loss: 0, loss_used: [], ...over });
  const returns = [
    ret(2021, { base: 100000, base_after_deductions: 100000, rate: 19, tax: 19000 }),
    ret(2022, { base: 300000, base_after_deductions: 300000, rate: 19, tax: 57000 }),
    // ztráta 2023: 120 000 zpětně do 2022, 10 000 dopředu do 2024, zbývá 20 000
    ret(2023, { base: -150000, base_after_deductions: 0, rate: null, tax: 0, loss: 150000, loss_used: [{ year: 2022, amount: 120000 }, { year: 2024, amount: 10000 }] }),
    ret(2024, { base: 50500, loss_deducted: 10000, base_after_deductions: 40500, rate: 21, tax: 8400 }),
  ];
  const o = lossCarryOverview(returns);
  assert.equal(o.openYear, 2025);
  assert.deepEqual(o.rows.map((r) => r.year), [2024, 2023, 2022, 2021]);
  assert.deepEqual(o.back.map((b) => [b.year, b.capacity, b.refund]), [[2023, 0, 0], [2024, 40500, 8400]]); // 21 % × 40 500 = 8 505 > zaplaceno 8 400
  assert.deepEqual([o.backCapacity, o.backRefund], [40500, 8400]);
  assert.deepEqual([o.forwardFrom, o.forwardTo], [2026, 2030]);
  assert.deepEqual(o.unused.map((l) => [l.year, l.remaining, l.until]), [[2023, 20000, 2028]]);
  assert.equal(o.unusedTotal, 20000);
  assert.deepEqual(o.rows.find((r) => r.year === 2022).deductedFrom, [{ year: 2023, amount: 120000 }]);

  // Bez přiznání 2024: otevřený rok 2024, základ 2022 už snížený o zpětně odečtenou ztrátu 2023
  const earlier = lossCarryOverview(returns.slice(0, 3));
  assert.equal(earlier.openYear, 2024);
  assert.deepEqual(earlier.back.map((b) => [b.year, b.capacity, b.refund]), [[2022, 180000, 34200], [2023, 0, 0]]);

  // Rok bez přiznání v okně (první rok firmy) a strop 30 mil. Kč
  const big = lossCarryOverview([ret(2025, { base: 40e6, base_after_deductions: 40e6, rate: 21, tax: 8.4e6 })]);
  assert.deepEqual(big.back.map((b) => [b.year, b.filed]), [[2024, false], [2025, true]]);
  assert.equal(big.backCapacity, 30e6);
  assert.equal(lossCarryOverview([]), null);
});

test("data/tax-returns.json: dopočty sedí s řádky přiznání", () => {
  const { returns } = JSON.parse(readFileSync(new URL("../data/tax-returns.json", import.meta.url), "utf8"));
  assert.ok(returns.length > 0);
  const years = returns.map((r) => r.year);
  assert.equal(new Set(years).size, years.length, "rok je v datech dvakrát");
  const forwardInto = new Map(); // rok → ztráta minulých let odečtená dopředu (= ř. 230)
  for (const r of returns) {
    const at = `rok ${r.year}`;
    assert.match(r.filed, /^\d{4}-\d{2}-\d{2}$/, at);
    assert.ok(r.filed > `${r.year}-12-31`, `${at}: podáno až po skončení roku`);
    if (r.base > 0) {
      assert.equal(r.base_after_deductions, r.base - r.loss_deducted, `${at}: ř. 250 = ř. 220 − ř. 230`);
      assert.equal(r.loss, 0, `${at}: kladný základ bez ztráty`);
    } else {
      assert.equal(r.loss, -r.base, `${at}: ztráta = záporný základ`);
      assert.equal(r.base_after_deductions, 0, at);
      assert.equal(r.tax, 0, at);
    }
    if (r.rate != null) {
      assert.equal(r.tax, (Math.floor(r.base_after_deductions / 1000) * 1000 * r.rate) / 100, `${at}: daň = sazba × základ zaokrouhlený na tisíce dolů`);
    }
    assert.equal(r.tax_total, r.tax + r.separate_tax, `${at}: ř. 340 = ř. 290 + ř. 335`);
    let used = 0;
    for (const u of r.loss_used) {
      assert.ok(u.year !== r.year && u.year >= r.year - 2 && u.year <= r.year + 5, `${at}: ztráta odečtená mimo lhůtu (${u.year})`);
      used += u.amount;
      if (u.year > r.year) forwardInto.set(u.year, (forwardInto.get(u.year) || 0) + u.amount);
    }
    assert.ok(used <= r.loss, `${at}: odečteno víc, než byla ztráta`);
  }
  for (const r of returns) {
    assert.equal(r.loss_deducted, forwardInto.get(r.year) || 0, `rok ${r.year}: ř. 230 nesedí s tabulkou E ztrátových let`);
  }
  const o = lossCarryOverview(returns);
  assert.equal(o.openYear, Math.max(...years) + 1);
});

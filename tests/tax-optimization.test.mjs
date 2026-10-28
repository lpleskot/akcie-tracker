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
import { openLotsCostCzk, realizedSales } from "../assets/js/portfolio-shared.js";
import { computePositions } from "../assets/js/fifo.js";
import {
  dividendsInYear,
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

/**
 * Daňová optimalizace pro fyzickou osobu (assets/js/tax-person.js): časový test
 * po nákupech, hodnotový limit 100 000 Kč, zdanitelný výsledek a simulace.
 * Ručně spočítané fixtures. Spuštění: node --test tests/*.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withPositions } from "../assets/js/tax-optimization.js";
import {
  holding,
  personSalesInYear,
  simulatePersonSale,
  timeTestDate,
  timeTestSummary,
  withTimeTest,
} from "../assets/js/tax-person.js";

function close(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) < eps, `očekáváno ${expected}, dostal ${actual}`);
}

test("timeTestDate: den po třetím výročí, 29. 2. v nepřestupném roce = 28. 2.", () => {
  assert.equal(timeTestDate("2021-07-13"), "2024-07-14");
  assert.equal(timeTestDate("2023-12-31"), "2027-01-01");
  assert.equal(timeTestDate("2024-02-29"), "2027-03-01");
  assert.equal(timeTestDate("2025-02-28"), "2028-02-29");
});

test("holding: celé roky a měsíce kalendářně", () => {
  assert.deepEqual(holding("2021-07-13", "2024-07-12"), { years: 2, months: 11, days: 1095 });
  assert.deepEqual(holding("2021-07-13", "2024-07-13"), { years: 3, months: 0, days: 1096 });
  assert.deepEqual(holding("2026-10-30", "2026-10-31"), { years: 0, months: 0, days: 1 });
});

test("withTimeTest + timeTestSummary: splněné nákupy jsou nejstarší, další test s rezervou 3 dny", () => {
  const rows = [{
    key: "x|AAA", sym: "AAA", account: "X", sellable: true, lots: [
      { settleDate: "2021-01-06", qty: 10, valueCzk: 20000, pnlCzk: 18000 },
      { settleDate: "2025-06-04", qty: 10, valueCzk: 20000, pnlCzk: 3000 },
      { settleDate: "2026-02-10", qty: 5, valueCzk: 10000, pnlCzk: -500 },
    ],
  }];
  const [r] = withTimeTest(rows, "2026-10-31");
  assert.deepEqual(r.lots.map((l) => l.exempt), [true, false, false]);
  assert.deepEqual([r.exemptQty, r.exemptValueCzk, r.exemptPnlCzk, r.taxablePnlCzk], [10, 20000, 18000, 2500]);
  assert.deepEqual([r.nextTest.exemptFrom, r.nextTest.safeFrom, r.nextTest.daysLeft], ["2028-06-05", "2028-06-08", 586]);
  const s = timeTestSummary([r]);
  assert.deepEqual([s.exemptValueCzk, s.exemptPnlCzk, s.exemptLots], [20000, 18000, 1]);
  assert.deepEqual(s.upcoming.map((u) => u.safeFrom), ["2028-06-08", "2029-02-14"]);
});

test("withTimeTest: v rezervě po konci lhůty ještě není bez daně", () => {
  // lhůta skončila 28. 10., rezerva do 31. 10. → 30. 10. čekat, 1. 11. prodávat
  const rows = [{ key: "x|BBB", sym: "BBB", account: "X", sellable: true, lots: [{ settleDate: "2023-10-27", qty: 1, valueCzk: 1, pnlCzk: 1 }] }];
  const [lot] = withTimeTest(rows, "2026-10-30")[0].lots;
  assert.deepEqual([lot.exemptFrom, lot.safeFrom, lot.exempt, lot.inBuffer, lot.daysLeft], ["2026-10-28", "2026-10-31", false, true, 1]);
  const [later] = withTimeTest(rows, "2026-10-31")[0].lots;
  assert.deepEqual([later.exempt, later.inBuffer], [true, false]);
});

// Nákup 10 ks 2021 (časový test splněn) a 10 ks 2025, prodej 15 ks v březnu 2026 → FIFO
// bere 10 ks z 2021 (osvobozeno) a 5 ks z 2025 (zdanitelné); kurz USD 20 Kč
const FX = {
  dates: Object.fromEntries(
    ["2021-01-06", "2025-06-04", "2026-03-04"].map((d) => [d, { valid_for: d, rates: { USD: { rate: 20, amount: 1 } } }]),
  ),
};
function account(sellPrice) {
  const tx = (date, settle, type, quantity, price) => ({ symbol: "AAA", date, settle_date: settle, type, quantity, price, proceeds: (type === "BUY" ? -1 : 1) * quantity * price, commission: 0 });
  return withPositions([{
    meta: { id: "lynx", short: "Lynx" },
    portfolio: {
      instruments: { AAA: { currency: "USD", name: "Alpha" } },
      transactions: [
        tx("2021-01-04", "2021-01-06", "BUY", 10, 100),
        tx("2025-06-02", "2025-06-04", "BUY", 10, 120),
        tx("2026-03-02", "2026-03-04", "SELL", 15, sellPrice),
      ],
      corporate_actions: [],
    },
  }]);
}

test("personSalesInYear: nad limitem 100 000 Kč se daní jen nákup bez časového testu", () => {
  const s = personSalesInYear(account(1000), FX, "2026");
  assert.deepEqual(s.lines.map((l) => [l.buySettle, l.qty, l.exempt]), [["2021-01-06", 10, true], ["2025-06-04", 5, false]]);
  close(s.grossCzk, 15 * 1000 * 20);
  close(s.exemptPnl, 10 * 900 * 20);
  close(s.gains, 5 * 880 * 20);
  assert.equal(s.overLimit, true);
  close(s.taxableNet, 88000);
  close(s.tax, 13200);
  close(s.lines[1].expensesCzk, 5 * 120 * 20);
});

test("personSalesInYear: prodej v rezervě po konci lhůty je splněný, ale „těsně“", () => {
  const fx = { dates: { ...FX.dates, "2023-02-27": { valid_for: "2023-02-27", rates: { USD: { rate: 20, amount: 1 } } } } };
  const accounts = withPositions([{
    meta: { id: "lynx", short: "Lynx" },
    portfolio: {
      instruments: { AAA: { currency: "USD", name: "Alpha" } },
      transactions: [
        { symbol: "AAA", date: "2023-02-23", settle_date: "2023-02-27", type: "BUY", quantity: 1, price: 100, proceeds: -100, commission: 0 },
        // lhůta skončila 27. 2. 2026 → osvobozeno od 28. 2., rezerva do 2. 3. → obchod 2. 3. je těsně
        { symbol: "AAA", date: "2026-03-02", settle_date: "2026-03-04", type: "SELL", quantity: 1, price: 150, proceeds: 150, commission: 0 },
      ],
      corporate_actions: [],
    },
  }]);
  const [line] = personSalesInYear(accounts, fx, "2026").lines;
  assert.deepEqual([line.exemptFrom, line.exempt, line.tight], ["2026-02-28", true, true]);
});

test("personSalesInYear: příjmy do 100 000 Kč jsou osvobozené celé", () => {
  const s = personSalesInYear(account(300), FX, "2026");
  close(s.grossCzk, 90000);
  assert.equal(s.overLimit, false);
  assert.deepEqual([s.taxableNet, s.tax], [0, 0]);
  assert.deepEqual(personSalesInYear(account(300), FX, "2025").lines, []);
});

test("simulatePersonSale: prodej vybraných přidá příjem do limitu a jen zdanitelné Z/Z", () => {
  const sales = { grossCzk: 90000, gains: 4000, losses: 0 };
  const rows = [
    { key: "a", sellable: true, valueCzk: 5000, taxablePnlCzk: 1000, exemptPnlCzk: 2000 },
    { key: "b", sellable: true, valueCzk: 50000, taxablePnlCzk: -3000, exemptPnlCzk: 0 },
    { key: "c", sellable: false, valueCzk: null, taxablePnlCzk: null, exemptPnlCzk: null },
  ];
  const pod = simulatePersonSale(sales, rows, new Set(["a", "c"]));
  assert.deepEqual([pod.count, pod.grossCzk, pod.overLimit, pod.net, pod.tax], [1, 95000, false, 0, 0]);
  const nad = simulatePersonSale(sales, rows, new Set(["a", "b"]));
  assert.deepEqual([nad.count, nad.grossCzk, nad.overLimit, nad.net, nad.exemptPnl], [2, 145000, true, 2000, 2000]);
  close(nad.tax, 300);
});

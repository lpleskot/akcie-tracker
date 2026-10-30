/**
 * Unit testy pohledu Prodané pozice (Přehled pozic → Prodané): souhrn celé
 * prodaných titulů v měně i v Kč a odhad kurzu u čerstvého prodeje.
 *
 * Spuštění: node --test tests/*.test.mjs
 * Fixtures jsou ručně spočítané malé případy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { closedPositions, realizedSales } from "../assets/js/portfolio-shared.js";
import { computePositions } from "../assets/js/fifo.js";

function close(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) < eps, `očekáváno ${expected}, dostal ${actual}`);
}

// Kurzy ČNB: USD 23 → 21,5 (poslední den v kurzech 2026-10-27), EUR 25
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
  "2026-03-02": 22,
  "2026-10-27": 21.5,
});

function tx(over) {
  return { date: "2025-06-02", settle_date: "2025-06-02", time: "10:00:00", symbol: "AAA", type: "BUY", quantity: 10, price: 100, proceeds: null, commission: 0, ...over };
}

const INSTRUMENTS = {
  AAA: { currency: "USD", name: "AAA Corp" },
  BBB: { currency: "USD", name: "BBB Corp" },
  CCC: { currency: "USD", name: "CCC Corp" },
  DDD: { currency: "USD", name: "DDD Corp" },
};

test("closedPositions: celé prodaný titul – ceny a výsledek v měně, Kč prodeje i dividend", () => {
  const positions = computePositions(
    [
      tx({ quantity: 10, price: 100 }),
      tx({ date: "2026-03-02", settle_date: "2026-03-02", quantity: 5, price: 120 }),
      tx({ date: "2026-10-27", settle_date: "2026-10-27", type: "SELL", quantity: 15, price: 130, commission: -15 }),
      tx({ symbol: "BBB" }), // držený – mezi prodanými není
      tx({ symbol: "CCC" }),
      tx({ symbol: "CCC", date: "2026-03-02", settle_date: "2026-03-02", type: "SELL", quantity: 4, price: 90 }), // částečný prodej
    ],
    [],
    [{ symbol: "AAA", date: "2025-12-31", amount: 20, currency: "USD" }],
    [{ symbol: "AAA", date: "2025-12-31", amount: -3, currency: "USD" }],
  );
  const rows = closedPositions(positions, INSTRUMENTS, FX);
  assert.deepEqual(rows.map((r) => r.symbol), ["AAA"]);
  const [r] = rows;
  assert.equal(r.firstBuy, "2025-06-02");
  assert.equal(r.lastSell, "2026-10-27");
  close(r.qty, 15);
  close(r.cost, 10 * 100 + 5 * 120); // 1 600
  close(r.proceeds, 15 * (130 - 1)); // komise 15 USD = 1 USD/ks → 1 935
  close(r.avgBuy, 1600 / 15);
  close(r.avgSell, 129);
  close(r.realized, 335);
  assert.equal(r.dividendCurrency, "USD");
  close(r.dividends, 17);
  close(r.total, 352);
  close(r.totalPct, 22);
  // Kč: nákupy 1 000 × 23 + 600 × 22, prodej 1 935 × 21,5; dividendy 17 × 22,5
  close(r.saleCzk, 1935 * 21.5 - (1000 * 23 + 600 * 22)); // 5 402,5
  close(r.dividendsCzk, 17 * 22.5); // 382,5
  close(r.totalCzk, 5402.5 + 382.5);
  assert.equal(r.estimated, false);
  assert.deepEqual(r.missingFx, []);
  assert.equal(r.sales.length, 1);
});

test("closedPositions: prodej vypořádaný po posledním kurzu – strict chybí, s estimateLatest odhad", () => {
  const positions = computePositions([
    tx({}),
    tx({ date: "2026-10-28", settle_date: "2026-10-29", type: "SELL", quantity: 10, price: 110 }),
  ]);
  const [strict] = closedPositions(positions, INSTRUMENTS, FX);
  assert.equal(strict.saleCzk, null);
  assert.equal(strict.totalCzk, null);
  assert.deepEqual(strict.missingFx, ["prodej vypořádaný 2026-10-29"]);
  close(strict.realized, 100); // v měně je výsledek přesný i bez kurzu

  const [est] = closedPositions(positions, INSTRUMENTS, FX, { estimateLatest: true });
  close(est.saleCzk, 1100 * 21.5 - 1000 * 23);
  close(est.totalCzk, 1100 * 21.5 - 1000 * 23);
  assert.equal(est.estimated, true);
  assert.deepEqual(est.missingFx, []);
});

test("closedPositions: dividendy v jiné měně se v měně nesčítají, v Kč ano", () => {
  const positions = computePositions(
    [
      tx({ symbol: "DDD" }),
      tx({ symbol: "DDD", date: "2026-03-02", settle_date: "2026-03-02", type: "SELL", quantity: 10, price: 90 }),
    ],
    [],
    [{ symbol: "DDD", date: "2025-12-31", amount: 10, currency: "EUR" }],
    [],
  );
  const [r] = closedPositions(positions, INSTRUMENTS, FX);
  assert.equal(r.dividendCurrency, "EUR");
  close(r.dividends, 10);
  close(r.total, -100); // jen výsledek z prodeje
  close(r.dividendsCzk, 250);
  close(r.totalCzk, 900 * 22 - 1000 * 23 + 250);
});

test("closedPositions: řazení od posledního prodeje", () => {
  const positions = computePositions([
    tx({}),
    tx({ date: "2026-03-02", settle_date: "2026-03-02", type: "SELL", quantity: 10, price: 110 }),
    tx({ symbol: "DDD" }),
    tx({ symbol: "DDD", date: "2026-10-27", settle_date: "2026-10-27", type: "SELL", quantity: 10, price: 90 }),
  ]);
  assert.deepEqual(closedPositions(positions, INSTRUMENTS, FX).map((r) => r.symbol), ["DDD", "AAA"]);
});

test("realizedSales: estimateLatest odhadne jen kurz po posledním dni, výchozí zůstává strict", () => {
  const positions = computePositions([
    tx({}),
    tx({ date: "2026-10-28", settle_date: "2026-10-29", type: "SELL", quantity: 10, price: 110 }),
  ]);
  const [strict] = realizedSales(positions, INSTRUMENTS, FX);
  assert.equal(strict.profitCzk, null);
  assert.equal(strict.estimated, false);
  const [est] = realizedSales(positions, INSTRUMENTS, FX, { estimateLatest: true });
  assert.equal(est.estimated, true);
  close(est.sellFx, 21.5);
  assert.equal(est.sellFxValidFor, "2026-10-27");
  assert.equal(est.buys[0].fxValidFor, "2025-06-02");
  close(est.profitCzk, 1100 * 21.5 - 1000 * 23);
});

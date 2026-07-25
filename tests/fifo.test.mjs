/**
 * Unit testy FIFO enginu (REVIZE_REPORT.md R9).
 *
 * Spuštění: node --test tests/
 * Fixtures jsou ručně spočítané malé případy zrcadlící chování ověřené
 * na reálných datech (revizní smoke test 2026-07-22 + validace vs IBKR/KB).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePositions, unrealizedPnl } from "../assets/js/fifo.js";

// Floating-point tolerance na cent při násobení kurzů/cen
function close(actual, expected, eps = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `očekáváno ${expected}, dostal ${actual}`,
  );
}

function tx(over) {
  return {
    date: "2026-01-05",
    time: "10:00:00",
    symbol: "AAA",
    type: "BUY",
    quantity: 10,
    price: 100,
    proceeds: null,
    commission: 0,
    ...over,
  };
}

test("BUY + částečný SELL: prorace komise do cost basis i výnosu", () => {
  const pos = computePositions([
    // proceeds -1000 → efektivní cena 100; komise 10 → cost/ks 101
    tx({ proceeds: -1000, commission: -10 }),
    // prodej 4 ks @ 120, komise 8 → čistý výnos/ks 118
    tx({ date: "2026-02-01", type: "SELL", quantity: 4, price: 120, commission: -8 }),
  ]).AAA;

  close(pos.net_qty, 6);
  close(pos.cost_basis, 6 * 101);
  close(pos.avg_open_price, 101);
  close(pos.realized_pnl, 4 * (118 - 101)); // 68
  close(pos.closed_cost_basis, 4 * 101);
  close(pos.total_invested, 10 * 101);
  assert.equal(pos.closed_lots.length, 1);
  close(pos.closed_lots[0].sell_net_per_unit, 118);
});

test("objem (proceeds) je autoritativní před zaokrouhlenou cenou (KB výpisy)", () => {
  const pos = computePositions([
    tx({ quantity: 3, price: 33.33, proceeds: -100 }),
  ]).AAA;
  close(pos.cost_basis, 100);
  close(pos.avg_open_price, 100 / 3);
});

test("FIFO pořadí přes více lotů + net_qty po částečném prodeji", () => {
  const pos = computePositions([
    tx({ date: "2026-01-01", quantity: 5, price: 10 }),
    tx({ date: "2026-01-02", quantity: 5, price: 20 }),
    tx({ date: "2026-01-03", type: "SELL", quantity: 7, price: 30 }),
  ]).AAA;

  close(pos.realized_pnl, 5 * 20 + 2 * 10); // 120 — nejdřív celý starší lot
  close(pos.net_qty, 3);
  close(pos.cost_basis, 3 * 20);
  assert.equal(pos.closed_lots.length, 2);
  assert.equal(pos.closed_lots[0].buy_date, "2026-01-01");
  assert.equal(pos.closed_lots[1].buy_date, "2026-01-02");
});

test("transakce mimo pořadí se seřadí podle data a času", () => {
  const pos = computePositions([
    tx({ date: "2026-01-03", type: "SELL", quantity: 5, price: 30 }),
    tx({ date: "2026-01-01", quantity: 5, price: 10 }),
  ]).AAA;
  close(pos.realized_pnl, 5 * 20);
  assert.ok(!pos.closed_lots.some((c) => c.orphan));
});

test("prodej bez pokrytí → orphan lot, žádné vymyšlené P/L", () => {
  const pos = computePositions([
    tx({ quantity: 5, price: 10 }),
    tx({ date: "2026-01-06", type: "SELL", quantity: 8, price: 20 }),
  ]).AAA;
  close(pos.realized_pnl, 5 * 10);
  const orphan = pos.closed_lots.find((c) => c.orphan);
  assert.ok(orphan);
  close(orphan.qty, 3);
});

test("forward split 1:2 zachová cost basis a aplikuje se na konci dne", () => {
  const pos = computePositions(
    [
      tx({ quantity: 10, price: 100 }),
      // prodej v den splitu PŘED splitem (split platí 23:59:59)
      tx({ date: "2026-03-01", time: "12:00:00", type: "SELL", quantity: 2, price: 110 }),
      tx({ date: "2026-03-02", type: "SELL", quantity: 16, price: 60 }),
    ],
    [{ type: "split", date: "2026-03-01", symbol: "AAA", ratio_from: 1, ratio_to: 2 }],
  ).AAA;

  // Před splitem: prodáno 2 @ 110 (P/L 20); zbylo 8 → split → 16 @ 50
  close(pos.realized_pnl, 2 * 10 + 16 * 10);
  close(pos.net_qty, 0);
  assert.equal(pos.splits.length, 1);
});

test("BKNG-style split 1:25 (25 nových za 1 starý)", () => {
  const pos = computePositions(
    [tx({ symbol: "BKNG", quantity: 2, price: 5000, commission: -25 })],
    [{ type: "split", date: "2026-04-06", symbol: "BKNG", ratio_from: 1, ratio_to: 25 }],
  ).BKNG;
  close(pos.net_qty, 50);
  close(pos.cost_basis, 2 * 5000 + 25); // cost basis se splitem nemění
  close(pos.avg_open_price, (2 * 5000 + 25) / 50);
});

test("KB received+removed ve 30 dnech → auto-detect split", () => {
  const pos = computePositions(
    [tx({ symbol: "XYZ", quantity: 100, price: 10 })],
    [
      { type: "removed_share", date: "2026-02-10", symbol: "XYZ", isin_underlying: "ISIN1", quantity: 100 },
      { type: "received_share", date: "2026-02-14", symbol: "XYZ", isin_underlying: "ISIN1", quantity: 200 },
    ],
  ).XYZ;
  close(pos.net_qty, 200);
  close(pos.cost_basis, 1000);
  close(pos.avg_open_price, 5);
});

test("unpaired received_share → bonus shares za nulový cost", () => {
  const pos = computePositions(
    [tx({ symbol: "XYZ", quantity: 10, price: 100 })],
    [{ type: "received_share", date: "2026-03-01", symbol: "XYZ", isin_underlying: "ISIN1", quantity: 5 }],
  ).XYZ;
  close(pos.net_qty, 15);
  close(pos.cost_basis, 1000);
  close(pos.avg_open_price, 1000 / 15);
});

test("unpaired removed_share → cancellation bez realized P/L", () => {
  const pos = computePositions(
    [tx({ symbol: "XYZ", quantity: 10, price: 100 })],
    [{ type: "removed_share", date: "2026-03-01", symbol: "XYZ", isin_underlying: "ISIN1", quantity: 4 }],
  ).XYZ;
  close(pos.net_qty, 6);
  close(pos.cost_basis, 600);
  close(pos.realized_pnl, 0);
  assert.equal(pos.closed_lots.length, 0);
});

test("párování received+removed přes různá ISIN se NEspáruje", () => {
  const pos = computePositions(
    [tx({ symbol: "XYZ", quantity: 100, price: 10 })],
    [
      { type: "removed_share", date: "2026-02-10", symbol: "XYZ", isin_underlying: "ISIN1", quantity: 100 },
      { type: "received_share", date: "2026-02-14", symbol: "XYZ", isin_underlying: "ISIN2", quantity: 200 },
    ],
  ).XYZ;
  // removed = cancellation 100 ks, received = bonus 200 ks za nulu
  close(pos.net_qty, 200);
  close(pos.cost_basis, 0);
  close(pos.realized_pnl, 0);
});

test("closed lots nesou settle data (a fallback na datum obchodu)", () => {
  const pos = computePositions([
    tx({ date: "2026-05-21", settle_date: "2026-05-22", quantity: 400, price: 21.285 }),
    tx({ date: "2026-07-21", settle_date: "2026-07-22", type: "SELL", quantity: 400, price: 17.495 }),
  ]).AAA;
  const cl = pos.closed_lots[0];
  assert.equal(cl.buy_date, "2026-05-21");
  assert.equal(cl.buy_settle_date, "2026-05-22");
  assert.equal(cl.sell_date, "2026-07-21");
  assert.equal(cl.sell_settle_date, "2026-07-22");

  const noSettle = computePositions([
    tx({ quantity: 1, price: 10 }),
    tx({ date: "2026-01-06", type: "SELL", quantity: 1, price: 12 }),
  ]).AAA.closed_lots[0];
  assert.equal(noSettle.buy_settle_date, "2026-01-05");
  assert.equal(noSettle.sell_settle_date, "2026-01-06");
});

test("dividendy + srážková daň se agregují per symbol (i bez transakcí)", () => {
  const res = computePositions(
    [],
    [],
    [{ symbol: "DIV", amount: 100, amount_usd: 100 }],
    [{ symbol: "DIV", amount: -15, amount_usd: -15 }],
  );
  const pos = res.DIV;
  assert.ok(pos, "symbol jen s dividendou musí existovat");
  close(pos.net_qty, 0);
  close(pos.net_dividend_local, 85);
  assert.equal(pos.dividend_records.length, 1);
  assert.equal(pos.withholding_records.length, 1);
});

test("unrealizedPnl počítá tržní hodnotu i procenta", () => {
  const pos = computePositions([tx({ proceeds: -1000, commission: -10 })]).AAA;
  const u = unrealizedPnl(pos, 120);
  close(u.market_value, 1200);
  close(u.value, 1200 - 1010);
  close(u.pct, ((1200 - 1010) / 1010) * 100);
  // bez ceny → nuly
  const empty = unrealizedPnl(pos, null);
  close(empty.value, 0);
});

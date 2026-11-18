/**
 * Unit testy tabu Poplatky (assets/js/fees.js): které záznamy jsou poplatek,
 * do kterého roku patří a jak se přepočítají na Kč.
 *
 * Spuštění: node --test tests/*.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cashFlowCategory, feeItems, feesByYear, usedCategories } from "../assets/js/fees.js";

function close(actual, expected, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) < eps, `očekáváno ${expected}, dostal ${actual}`);
}

const FX = {
  dates: {
    "2025-06-10": { valid_for: "2025-06-10", rates: { USD: { rate: 22, amount: 1 } } },
    "2026-01-02": { valid_for: "2026-01-02", rates: { USD: { rate: 20, amount: 1 }, EUR: { rate: 25, amount: 1 } } },
    "2026-01-05": { valid_for: "2026-01-05", rates: { USD: { rate: 21, amount: 1 } } },
  },
};

function portfolio() {
  return {
    instruments: { BBB: { currency: "EUR" } },
    transactions: [
      { symbol: "AAA", type: "BUY", date: "2025-06-10", settle_date: "2025-06-10", quantity: 10, commission: -2, currency: "USD" },
      // obchod v prosinci, vypořádání v lednu → poplatek patří do nového roku (jako Report pro účetní)
      { symbol: "AAA", type: "SELL", date: "2025-12-30", settle_date: "2026-01-02", quantity: 10, commission: -3, currency: "USD" },
      // statický obchod IBKR bez měny – měna z instrumentu; komise vč. daně z obchodu (DSY)
      { symbol: "BBB", type: "BUY", date: "2026-01-02", quantity: 2.5, commission: -1, ib_commission: -0.4, taxes: -0.6 },
      { symbol: "CCC", type: "BUY", date: "2026-01-02", quantity: 1, commission: -5, currency: "USD", synthetic_opening: true },
      { symbol: "DDD", type: "BUY", date: "2026-01-02", quantity: 1, commission: 0, currency: "USD" },
    ],
    fx_conversions: [
      { date: "2026-01-05", settle_date: "2026-01-07", pair: "EUR.CZK", base_currency: "EUR", quantity: 1349, proceeds: -34882.442, currency: "CZK", commission: -100, commission_currency: "CZK" },
      { date: "2026-01-05", settle_date: "2026-01-07", pair: "USD.CZK", base_currency: "USD", quantity: -1.739, proceeds: 38.45, currency: "CZK", commission: 0, commission_currency: "CZK" },
    ],
    cash_flows: [
      { date: "2026-01-05", type: "external_fee", currency: "USD", amount: -2, description: "Externí poplatek za CA c. 1" },
      { date: "2026-01-05", type: "management_fee", currency: "CZK", amount: -300, description: "Poplatek za správu 01.12 - 31.12" },
      { date: "2026-01-05", type: "management_fee_vat", currency: "CZK", amount: -63, description: "DPH poplatku za správu 01.12 - 31.12" },
      // vratka = záporný náklad
      { date: "2026-01-05", type: "fee_rebilling", currency: "CZK", amount: 10, description: "Přefakturace externích poplatků" },
      // daň z obchodu mimo provizi: zaúčtuje se k vypořádání obchodu; EUR k 5. 1. chybí → kurz 2. 1. odhadem
      { date: "2026-01-02", settle_date: "2026-01-05", type: "Transaction Fees", symbol: "DSY", currency: "EUR", amount: -17.33, description: "French Daily Trade Charge Tax" },
      // den v kurzech chybí → poslední předchozí (5. 1.) odhadem
      { date: "2026-01-06", type: "Other Fees", symbol: "KSPI", currency: "USD", amount: -1.3, description: "ADR FEE" },
      // HKD v kurzech není vůbec → bez Kč, mimo součty
      { date: "2026-01-05", type: "Broker Interest Paid", currency: "HKD", amount: -0.14, description: "HKD DEBIT INT" },
      { date: "2026-01-05", type: "Broker Interest Received", currency: "USD", amount: 5, description: "USD CREDIT INT" },
      { date: "2026-01-05", type: "deposit", currency: "USD", amount: 1000, description: "vklad" },
      { date: "2026-01-05", type: "withdrawal", currency: "USD", amount: -500, description: "výběr" },
      { date: "2026-01-05", type: "Deposits/Withdrawals", currency: "CZK", amount: 1000, description: "vklad Flex" },
      { date: "2026-01-05", type: "interest", currency: "USD", amount: 3, description: "úrok" },
      { date: "2026-01-05", type: "fx_conversion", currency: "CZK", amount: -100000, description: "Měnová konverze KB" },
    ],
  };
}

test("cashFlowCategory: poplatky ano, vklady, výběry, přijaté úroky a konverze KB ne", () => {
  assert.equal(cashFlowCategory("management_fee"), "account");
  assert.equal(cashFlowCategory("management_fee_vat"), "account");
  assert.equal(cashFlowCategory("fee_rebilling"), "account");
  assert.equal(cashFlowCategory("external_fee"), "other");
  assert.equal(cashFlowCategory("Other Fees"), "other");
  assert.equal(cashFlowCategory("Transaction Fees"), "other");
  assert.equal(cashFlowCategory("Broker Interest Paid"), "interest");
  for (const t of ["deposit", "withdrawal", "Deposits/Withdrawals", "Broker Interest Received", "interest", "fx_conversion", "", undefined]) {
    assert.equal(cashFlowCategory(t), null, String(t));
  }
});

test("feeItems: druhy, rok podle vypořádání, měna z instrumentu, odhad nákupu bez provize", () => {
  const items = feeItems(portfolio(), FX);
  assert.deepEqual(
    items.map((i) => [i.date, i.category, i.symbol, i.currency, i.amount]),
    [
      ["2025-06-10", "buy", "AAA", "USD", 2],
      ["2026-01-02", "buy", "BBB", "EUR", 1],
      ["2026-01-02", "sell", "AAA", "USD", 3],
      ["2026-01-05", "account", null, "CZK", 300],
      ["2026-01-05", "account", null, "CZK", 63],
      ["2026-01-05", "account", null, "CZK", -10],
      ["2026-01-05", "other", null, "USD", 2],
      ["2026-01-05", "other", "DSY", "EUR", 17.33],
      ["2026-01-05", "interest", null, "HKD", 0.14],
      ["2026-01-06", "other", "KSPI", "USD", 1.3],
      ["2026-01-07", "fx", null, "CZK", 100],
    ],
  );
  const sell = items.find((i) => i.category === "sell");
  assert.equal(sell.trade_date, "2025-12-30");
  assert.equal(sell.description, "Prodej 10 ks");
  assert.equal(items.find((i) => i.symbol === "BBB").description, "Nákup 2,5000 ks (vč. daně z obchodu 0,60 EUR)");
  // cs-CZ odděluje tisíce nezlomitelnou mezerou
  assert.equal(items.find((i) => i.category === "fx").description, "Nákup 1 349 EUR za 34 882,44 CZK");
});

test("feeItems: Kč kurzem ke dni zaúčtování, chybějící den odhadem, bez kurzu mimo součty", () => {
  const items = feeItems(portfolio(), FX);
  const by = (cat, sym) => items.find((i) => i.category === cat && (sym === undefined || i.symbol === sym));
  close(by("sell").czk, 3 * 20);
  assert.deepEqual([by("sell").rate_date, by("sell").estimate], ["2026-01-02", false]);
  close(by("buy", "BBB").czk, 25);
  // CZK bez kurzu
  assert.deepEqual([by("fx").rate, by("fx").czk, by("fx").estimate], [1, 100, false]);
  // EUR k 5. 1. chybí → 2. 1.
  const dsy = by("other", "DSY");
  assert.deepEqual([dsy.estimate, dsy.rate_date], [true, "2026-01-02"]);
  close(dsy.czk, 17.33 * 25);
  // 6. 1. v kurzech není → 5. 1.
  const adr = by("other", "KSPI");
  assert.deepEqual([adr.estimate, adr.rate_date], [true, "2026-01-05"]);
  close(adr.czk, 1.3 * 21);
  const hkd = by("interest");
  assert.deepEqual([hkd.rate, hkd.czk, hkd.estimate], [null, null, false]);
});

test("feesByYear: součty po druzích, FIFO vs. samostatný náklad, chybějící kurz mimo součet", () => {
  const years = feesByYear(feeItems(portfolio(), FX));
  assert.deepEqual(years.map((y) => y.year), ["2026", "2025"]);
  const [y26, y25] = years;
  close(y26.categories.buy.czk, 25);
  close(y26.categories.sell.czk, 60);
  close(y26.categories.fx.czk, 100);
  close(y26.categories.account.czk, 353);
  close(y26.categories.other.czk, 42 + 17.33 * 25 + 1.3 * 21);
  assert.deepEqual(y26.categories.interest, { czk: 0, count: 1, missing: 1 });
  close(y26.inFifo, 85);
  close(y26.separate, 100 + 353 + 42 + 17.33 * 25 + 1.3 * 21);
  close(y26.czk, y26.inFifo + y26.separate);
  assert.deepEqual([y26.count, y26.missing, y26.estimates], [10, 1, 2]);
  assert.deepEqual([y25.count, y25.czk, y25.categories.buy.count], [1, 44, 1]);
});

test("usedCategories: jen druhy, které účet má, v pevném pořadí", () => {
  const items = feeItems(portfolio(), FX);
  assert.deepEqual(usedCategories(items).map((c) => c.key), ["buy", "sell", "fx", "account", "other", "interest"]);
  const ibkrLike = feeItems({ transactions: [{ symbol: "X", type: "SELL", date: "2026-01-02", commission: -1, currency: "USD", quantity: 1 }] }, FX);
  assert.deepEqual(usedCategories(ibkrLike).map((c) => c.key), ["sell"]);
  assert.deepEqual(feeItems({}, FX), []);
  assert.deepEqual(feesByYear([]), []);
});

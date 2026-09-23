/**
 * Unit testy sdíleného výpočtu portfolia (merge overlay, kurzy, hotovost,
 * Celkový výnos) — stejný kód používá appka i MCP konektor.
 *
 * Spuštění: node --test tests/*.test.mjs
 * Fixtures jsou ručně spočítané malé případy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amountToUsd,
  capitalFlowsUsd,
  cashToCzk,
  fxDateFor,
  fxToCzk,
  mergeOverlayIntoPortfolio,
  portfolioTotalReturn,
  xirrPct,
} from "../assets/js/portfolio-shared.js";

function close(actual, expected, eps = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `očekáváno ${expected}, dostal ${actual}`,
  );
}

const FX = {
  dates: {
    "2026-09-18": {
      valid_for: "2026-09-18",
      rates: { USD: { rate: 20.5, amount: 1 }, HUF: { rate: 6.2, amount: 100 } },
    },
    "2026-09-21": {
      valid_for: "2026-09-21",
      rates: { USD: { rate: 20.8, amount: 1 }, EUR: { rate: 24.3, amount: 1 } },
    },
  },
};

test("fxToCzk: přesný den, množství v kurzu, CZK = 1", () => {
  close(fxToCzk(FX, "2026-09-21", "USD"), 20.8);
  close(fxToCzk(FX, "2026-09-18", "HUF"), 0.062); // 6,2 Kč za 100 HUF
  assert.equal(fxToCzk(FX, "2026-09-21", "CZK"), 1);
  assert.equal(fxToCzk(null, "2026-09-21", "CZK"), 1);
  assert.equal(fxToCzk(null, "2026-09-21", "USD"), null);
});

test("fxToCzk: strict vrací null, fallback bere poslední den PŘED datem", () => {
  assert.equal(fxToCzk(FX, "2026-09-20", "USD"), null);
  close(fxToCzk(FX, "2026-09-20", "USD", { allowFallback: true }), 20.5);
  close(fxToCzk(FX, "2026-09-22", "EUR", { allowFallback: true }), 24.3);
  // fallback nehledá měnu dál do minulosti — 18. 9. EUR nemá
  assert.equal(fxToCzk(FX, "2026-09-19", "EUR", { allowFallback: true }), null);
  assert.equal(fxToCzk(FX, "2026-01-01", "USD", { allowFallback: true }), null);
});

test("fxDateFor: den, ze kterého fallback skutečně čte", () => {
  assert.equal(fxDateFor(FX, "2026-09-21"), "2026-09-21");
  assert.equal(fxDateFor(FX, "2026-09-20"), "2026-09-18");
  assert.equal(fxDateFor(FX, "2026-01-01"), null);
});

test("amountToUsd: přes CZK kurzy, chybějící den → nejnovější v kurzech", () => {
  assert.equal(amountToUsd(FX, 100, "USD", "cokoli"), 100);
  close(amountToUsd(FX, 100, "EUR", "2026-09-21"), (100 * 24.3) / 20.8);
  close(amountToUsd(FX, 100, "EUR", "2026-09-25"), (100 * 24.3) / 20.8);
  assert.ok(Number.isNaN(amountToUsd(FX, NaN, "EUR", "2026-09-21")));
  assert.ok(Number.isNaN(amountToUsd(null, 100, "EUR", "2026-09-21")));
});

function basePortfolio() {
  return {
    transactions: [
      { flex_id: "T0", symbol: "AAA", date: "2026-01-02", type: "BUY", quantity: 10, price: 10 },
    ],
    instruments: { AAA: { currency: "USD", yahoo_symbol: "AAA" } },
    cash_balance: { USD: 100 },
    total_deposits_usd: 1000,
  };
}

function overlay() {
  return {
    last_import: "2026-09-22T05:00:12Z",
    trades: [
      // T0 už je ve statickém JSON → přeskočit
      { tradeID: "T0", symbol: "AAA", tradeDate: "20260102", buySell: "BUY", quantity: "10", netCash: "-100", currency: "USD" },
      { tradeID: "T1", symbol: "AAA", tradeDate: "20260915", settleDateTarget: "20260916", buySell: "BUY", quantity: "5", tradePrice: "10", proceeds: "-50", ibCommission: "0", netCash: "-50", currency: "USD" },
      // forex konverze: +20 EUR, −22 USD, žádná pozice
      { tradeID: "FX1", symbol: "EUR.USD", assetCategory: "CASH", tradeDate: "20260916", buySell: "BUY", quantity: "20", netCash: "-22", currency: "USD" },
    ],
    cash_transactions: [
      { transactionID: "D1", type: "Dividends", symbol: "AAA", amount: "5", currency: "USD", dateTime: "20260918" },
      { transactionID: "W1", type: "Withholding Tax", symbol: "AAA", amount: "-0.75", currency: "USD", dateTime: "20260918" },
      { transactionID: "DEP1", type: "Deposits/Withdrawals", amount: "200", currency: "EUR", dateTime: "20260921" },
      { transactionID: "F1", type: "Other Fees", amount: "-3", currency: "USD", dateTime: "20260919" },
    ],
    corporate_actions: [
      { actionID: "CA1", symbol: "AAA", type: "FS", dateTime: "20260920", proceeds: "1.5", currency: "USD" },
    ],
    nav_snapshot: [{ reportDate: "20260921", currency: "USD", cash: "31", total: "500" }],
  };
}

test("mergeOverlayIntoPortfolio: dedupe, forex jen do hotovosti, dividendy, vklady", () => {
  const p = basePortfolio();
  const origCash = p.cash_balance;
  const stats = mergeOverlayIntoPortfolio(p, overlay(), FX);

  assert.deepEqual(stats, {
    trades: 1, dividends: 1, withholding: 1, corp_actions: 1, cash_flows: 2,
    last_import: "2026-09-22T05:00:12Z",
  });
  assert.deepEqual(p.transactions.map((t) => t.flex_id), ["T0", "T1"]);
  assert.equal(p.transactions[1].settle_date, "2026-09-16");
  // USD: 100 − 50 (T1) − 22 (forex) + 5 − 0,75 − 3 + 1,5 (CA) = 30,75
  close(p.cash_balance.USD, 30.75);
  // EUR: +20 (forex) + 200 (vklad)
  close(p.cash_balance.EUR, 220);
  // vklad 200 EUR kurzem k 21. 9. → USD
  close(p.total_deposits_usd, 1000 + (200 * 24.3) / 20.8);
  assert.equal(p.nav_history.length, 1);
  // statický snapshot se nemutuje — merge pracuje nad kopií
  assert.deepEqual(origCash, { USD: 100 });
});

test("mergeOverlayIntoPortfolio: opakovaný merge téhož overlay nic nezdvojí", () => {
  const p = basePortfolio();
  mergeOverlayIntoPortfolio(p, overlay(), FX);
  const second = mergeOverlayIntoPortfolio(p, overlay(), FX);
  assert.equal(second.trades + second.dividends + second.cash_flows + second.corp_actions, 0);
  assert.equal(p.transactions.length, 2);
});

test("mergeOverlayIntoPortfolio: null overlay a bez kurzů nespadne", () => {
  const p = basePortfolio();
  const stats = mergeOverlayIntoPortfolio(p, null, null);
  assert.equal(stats.last_import, null);
  assert.deepEqual(p.nav_history, []);
  assert.equal(p.transactions.length, 1);
  // Bez kurzů se ne-USD vklad do total_deposits_usd nepřičte (alerty ho nepotřebují)
  const q = basePortfolio();
  mergeOverlayIntoPortfolio(q, overlay(), null);
  assert.equal(q.total_deposits_usd, 1000);
});

test("cashToCzk: součet v Kč, měna bez kurzu se přizná v missing", () => {
  const r = cashToCzk({ USD: 10, EUR: 2, XXX: 5, CZK: 100, JPY: null }, FX, "2026-09-21");
  close(r.czk, 10 * 20.8 + 2 * 24.3 + 100);
  assert.deepEqual(r.missing, ["XXX"]);
  assert.deepEqual(r.items.map((i) => i.currency), ["CZK", "EUR", "USD"]);
});

test("capitalFlowsUsd: počáteční kapitál, vklady a výběry z evidence, podle data", () => {
  const p = {
    inception_date: "2026-09-18",
    opening_cash: { date: "2026-09-18", balances: { USD: 50 } },
    transactions: [
      // počáteční pozice: cost basis v EUR, kurz k datu vypořádání
      { symbol: "X", date: "2026-09-18", settle_date: "2026-09-21", type: "BUY", quantity: 2, price: 100, proceeds: -200, currency: "EUR", synthetic_opening: true },
      // běžný nákup není tok kapitálu
      { symbol: "Y", date: "2026-09-19", type: "BUY", quantity: 1, price: 10, proceeds: -10, currency: "USD" },
    ],
    cash_flows: [
      { date: "2026-09-21", type: "deposit", currency: "USD", amount: 1000 },
      { date: "2026-09-21", type: "withdrawal", currency: "EUR", amount: -100 },
      { date: "2026-09-21", type: "Deposits/Withdrawals", currency: "USD", amount: 300 }, // Flex overlay
      { date: "2026-09-21", type: "interest", currency: "USD", amount: 2.6 },
      { date: "2026-09-21", type: "fx_conversion", currency: "USD", amount: 500 },
    ],
    total_deposits_usd: 999999, // s evidencí toků se nepoužije
  };
  const eurUsd = 24.3 / 20.8;
  const f = capitalFlowsUsd(p, FX);
  assert.deepEqual(f.map((x) => [x.date, x.kind]), [
    ["2026-09-18", "opening"], ["2026-09-18", "opening"],
    ["2026-09-21", "deposit"], ["2026-09-21", "withdrawal"], ["2026-09-21", "deposit"],
  ]);
  close(f[0].usd, 50);
  close(f[1].usd, 200 * eurUsd);
  close(f[3].usd, -100 * eurUsd);
  // výnos k datu nevidí pozdější toky
  assert.equal(capitalFlowsUsd(p, FX, { upTo: "2026-09-20" }).length, 2);
  assert.equal(capitalFlowsUsd(p, FX, { upTo: "2026-09-17" }).length, 0);
});

test("capitalFlowsUsd: bez evidence toků total_deposits_usd k datu založení", () => {
  const f = capitalFlowsUsd({ inception_date: "2025-11-24", total_deposits_usd: 5000, cash_flows: [] }, FX);
  assert.deepEqual(f, [{ date: "2025-11-24", usd: 5000, kind: "deposit" }]);
});

// Toky postavené ze známé sazby 10 % p. a. — XIRR ji musí zpětně najít
const yearsBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000 / 365.25;

test("xirrPct: jediný vklad = prostá anualizace", () => {
  const t = yearsBetween("2025-01-01", "2027-01-01");
  close(xirrPct([{ date: "2025-01-01", usd: 100 }], 121, "2027-01-01"), (Math.pow(1.21, 1 / t) - 1) * 100, 1e-8);
});

test("xirrPct: najde sazbu u postupných vkladů i u výběru", () => {
  const [t0, t1, t2] = ["2021-01-01", "2022-01-01", "2023-01-01"];
  const grow = (from) => Math.pow(1.1, yearsBetween(from, t2));
  const twoDeposits = 100 * grow(t0) + 100 * grow(t1);
  close(xirrPct([{ date: t0, usd: 100 }, { date: t1, usd: 100 }], twoDeposits, t2), 10, 1e-8);
  const withWithdrawal = 100 * grow(t0) - 50 * grow(t1);
  close(xirrPct([{ date: t0, usd: 100 }, { date: t1, usd: -50 }], withWithdrawal, t2), 10, 1e-8);
  // bez řešení (hodnota záporná) → null, ne vymyšlené číslo
  assert.equal(xirrPct([{ date: t0, usd: 100 }], -10, t2), null);
});

test("portfolioTotalReturn: jen vklady (IBKR) = (hodnota − vklady) / vklady", () => {
  const r = portfolioTotalReturn({
    assetsUsd: 110000,
    flows: [{ date: "2025-01-01", usd: 100000 }],
    inceptionDate: "2025-01-01",
    asOf: "2026-01-01",
    usdToCzk: 20,
  });
  close(r.usd, 10000);
  close(r.pct, 10);
  close(r.czk, 200000);
  close(r.days, 365);
  close(r.vlozeno, 100000);
  close(r.vybrano, 0);
  close(r.paPct, (Math.pow(1.1, 365.25 / 365) - 1) * 100, 1e-8);
  // Date i ISO datum dávají stejný počet dní; bez kurzu USD žádné Kč
  const d = portfolioTotalReturn({
    assetsUsd: 110000, flows: [{ date: "2025-01-01", usd: 100000 }],
    inceptionDate: "2025-01-01", asOf: new Date("2026-01-01T00:00:00Z"),
  });
  close(d.days, 365);
  assert.equal(d.czk, null);
});

test("portfolioTotalReturn: výběry nezmenšují základ (KB)", () => {
  // počátek 100, vklad 100, výběr 150, dnes 120 → zisk 70 z vložených 200
  const r = portfolioTotalReturn({
    assetsUsd: 120,
    flows: [
      { date: "2023-01-01", usd: 100 },
      { date: "2024-01-01", usd: 100 },
      { date: "2025-01-01", usd: -150 },
    ],
    inceptionDate: "2023-01-01",
    asOf: "2026-01-01",
  });
  close(r.vlozeno, 200);
  close(r.vybrano, 150);
  close(r.usd, 70);
  close(r.pct, 35); // starý vzorec (hodnota − čisté vklady) / čisté vklady by dal 140 %
  assert.ok(r.paPct > 0 && r.paPct < 35);
});

test("portfolioTotalReturn: nulové vklady → 0 %, minimálně 1 den", () => {
  const r = portfolioTotalReturn({ assetsUsd: 5, flows: [], inceptionDate: "2026-09-22", asOf: "2026-09-22" });
  assert.equal(r.usd, 0);
  assert.equal(r.pct, 0);
  assert.equal(r.paPct, 0);
  assert.equal(r.days, 1);
});

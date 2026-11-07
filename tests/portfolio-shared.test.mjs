/**
 * Unit testy sdíleného výpočtu portfolia (merge overlay, kurzy, hotovost,
 * Celkový výnos) — stejný kód používá appka i MCP konektor.
 *
 * Spuštění: node --test tests/*.test.mjs
 * Fixtures jsou ručně spočítané malé případy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePositions } from "../assets/js/fifo.js";
import {
  amountToCzk,
  amountToUsd,
  capitalFlowsCzk,
  capitalFlowsUsd,
  cashToCzk,
  fxDateFor,
  fxToCzk,
  importWarning,
  mergeOverlayIntoPortfolio,
  portfolioTotalReturn,
  portfolioTotalReturnCzk,
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
      // forex konverze: +20 EUR, −22 USD, žádná pozice (IB u konverzí vrací netCash 0)
      { tradeID: "FX1", symbol: "EUR.USD", assetCategory: "CASH", tradeDate: "20260916", buySell: "BUY", quantity: "20", proceeds: "-22", ibCommission: "0", ibCommissionCurrency: "USD", netCash: "0", currency: "USD" },
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
  // dividendy z overlay nesou amount_usd jako statické — dlaždice Dividendy je sčítá
  assert.deepEqual([p.dividends[0].amount_usd, p.withholding_tax[0].amount_usd], [5, -0.75]);
  assert.equal(p.nav_history.length, 1);
  // statický snapshot se nemutuje — merge pracuje nad kopií
  assert.deepEqual(origCash, { USD: 100 });
});

test("mergeOverlayIntoPortfolio: konverze s netCash 0 – obě měny i poplatek v měně účtu (Lynx)", () => {
  const p = { transactions: [], instruments: {}, cash_balance: { CZK: 40000 } };
  mergeOverlayIntoPortfolio(p, {
    trades: [
      // Lynx 8. 7. 2021: koupě 1 349 EUR za CZK, poplatek 100 CZK
      { tradeID: "L1", symbol: "EUR.CZK", assetCategory: "CASH", buySell: "BUY", quantity: "1349", proceeds: "-34882.442", ibCommission: "-100", ibCommissionCurrency: "CZK", netCash: "0", currency: "CZK" },
      // prodej těch 1 349 EUR za HKD, poplatek opět v CZK
      { tradeID: "L2", symbol: "EUR.HKD", assetCategory: "CASH", buySell: "SELL", quantity: "-1349", proceeds: "12404.66", ibCommission: "-112.59", ibCommissionCurrency: "CZK", netCash: "0", currency: "HKD" },
    ],
  }, null);
  close(p.cash_balance.CZK, 40000 - 34882.442 - 100 - 112.59, 1e-6);
  close(p.cash_balance.EUR, 0);
  close(p.cash_balance.HKD, 12404.66);
  assert.equal(p.transactions.length, 0); // konverze není pozice
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

test("capitalFlowsUsd: skutečný nákup před evidencí vkladů (opening_position) i s provizí", () => {
  const p = {
    inception_date: "2026-09-18",
    transactions: [
      { symbol: "X", date: "2026-09-18", settle_date: "2026-09-21", type: "BUY", quantity: 2, price: 100, proceeds: -200, commission: -5, currency: "EUR", opening_position: true },
    ],
  };
  const f = capitalFlowsUsd(p, FX);
  assert.deepEqual(f.map((x) => [x.date, x.kind]), [["2026-09-18", "opening"]]);
  close(f[0].usd, 205 * (24.3 / 20.8));
});

test("capitalFlowsUsd: bez evidence toků total_deposits_usd k datu založení", () => {
  const f = capitalFlowsUsd({ inception_date: "2025-11-24", total_deposits_usd: 5000, cash_flows: [] }, FX);
  assert.deepEqual(f, [{ date: "2025-11-24", usd: 5000, kind: "deposit" }]);
});

test("capitalFlowsCzk: tytéž toky v Kč kurzem ke dni toku, víkend z předchozího dne", () => {
  const p = {
    inception_date: "2026-09-18",
    opening_cash: { date: "2026-09-18", balances: { USD: 50, CZK: 1000 } },
    cash_flows: [
      { date: "2026-09-21", type: "deposit", currency: "CZK", amount: 100000 },
      { date: "2026-09-21", type: "withdrawal", currency: "USD", amount: -100 },
      { date: "2026-09-22", type: "deposit", currency: "EUR", amount: 10 }, // úterý → kurz z pondělí 21. 9.
      { date: "2026-09-10", type: "deposit", currency: "EUR", amount: 1 }, // před prvním kurzem EUR → nejbližší pozdější
      { date: "2026-09-21", type: "deposit", currency: "XXX", amount: 5 }, // měna bez kurzu → vypadne
    ],
  };
  const f = capitalFlowsCzk(p, FX);
  assert.deepEqual(f.map((x) => [x.date, x.kind, x.czk]), [
    ["2026-09-10", "deposit", 24.3],
    ["2026-09-18", "opening", 50 * 20.5],
    ["2026-09-18", "opening", 1000],
    ["2026-09-21", "deposit", 100000], // koruny jsou koruny, žádný přepočet tam a zpět
    ["2026-09-21", "withdrawal", -100 * 20.8],
    ["2026-09-22", "deposit", 10 * 24.3],
  ]);
  // měna bez kurzu vypadne stejně jako v USD
  assert.ok(Number.isNaN(amountToCzk(FX, 5, "XXX", "2026-09-21")));
  assert.equal(capitalFlowsUsd(p, FX).length, f.length);
});

test("portfolioTotalReturnCzk: výnos v korunách včetně kurzu dolaru", () => {
  // 100 USD vloženo při 25 Kč, dnes portfolio 100 USD při 20 Kč:
  // v dolarech 0 %, v korunách −20 % (dolar oslabil)
  const flows = [{ date: "2025-01-01", czk: 2500 }];
  const r = portfolioTotalReturnCzk({ assetsCzk: 100 * 20, flows, asOf: "2026-01-01" });
  close(r.czk, -500);
  close(r.pct, -20);
  close(r.vlozeno, 2500);
  close(r.vybrano, 0);
  close(r.paPct, (Math.pow(0.8, 365.25 / 365) - 1) * 100, 1e-8);
  // výběry základ nezmenšují stejně jako v USD
  const kb = portfolioTotalReturnCzk({
    assetsCzk: 120,
    flows: [{ date: "2023-01-01", czk: 100 }, { date: "2024-01-01", czk: 100 }, { date: "2025-01-01", czk: -150 }],
    asOf: "2026-01-01",
  });
  close(kb.czk, 70);
  close(kb.pct, 35);
  close(kb.paPct, xirrPct([{ date: "2023-01-01", usd: 100 }, { date: "2024-01-01", usd: 100 }, { date: "2025-01-01", usd: -150 }], 120, "2026-01-01"), 1e-9);
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

test("mergeOverlayIntoPortfolio: split z IBKR se započítá jednou, i když je ručně ve statickém JSON", () => {
  const split = {
    actionID: "S1",
    symbol: "AAA",
    type: "FS",
    dateTime: "20260920;202500",
    description: "AAA(US0000000000) SPLIT 2 FOR 1 (AAA, AAA CORP)",
    currency: "USD",
  };
  const p = basePortfolio();
  mergeOverlayIntoPortfolio(p, { corporate_actions: [split] }, FX);
  const pos = computePositions(p.transactions, p.corporate_actions).AAA;
  assert.equal(pos.net_qty, 20);
  close(pos.open_lots[0].cost_per_unit, 5);

  // týž split zapsaný ručně (k datu o den jinak) → overlay ho nepřidá podruhé
  const q = basePortfolio();
  q.corporate_actions = [{ symbol: "AAA", type: "split", date: "2026-09-21", ratio_from: 1, ratio_to: 2 }];
  mergeOverlayIntoPortfolio(q, { corporate_actions: [split] }, FX);
  assert.equal(q.corporate_actions.length, 1);
  assert.equal(computePositions(q.transactions, q.corporate_actions).AAA.net_qty, 20);
});

test("mergeOverlayIntoPortfolio: titul pod jiným symbolem IBKR se spáruje přes ISIN (EVOG.ST = EVO)", () => {
  const p = {
    transactions: [
      { symbol: "EVO", date: "2025-12-16", settle_date: "2025-12-18", type: "BUY", quantity: 150, price: 634.2, proceeds: -95130, commission: -49 },
    ],
    instruments: { EVO: { isin: "SE0012673267", currency: "SEK", exchange: "SFB", yahoo_symbol: "EVO.ST" } },
    cash_balance: {},
  };
  const evo = { symbol: "EVOG.ST", isin: "SE0012673267", currency: "SEK", listingExchange: "SFB", description: "EVOLUTION AB" };
  mergeOverlayIntoPortfolio(p, {
    trades: [
      { ...evo, tradeID: "T9", tradeDate: "20261105", settleDateTarget: "20261107", buySell: "SELL", quantity: "-50", tradePrice: "850", proceeds: "42500", ibCommission: "-49", netCash: "42451" },
    ],
    cash_transactions: [
      { ...evo, transactionID: "D9", type: "Dividends", amount: "4500", dateTime: "20261110" },
      { ...evo, transactionID: "W9", type: "Withholding Tax", amount: "-675", dateTime: "20261110" },
    ],
  }, FX);

  assert.deepEqual(Object.keys(p.instruments), ["EVO"]); // žádný nový titul EVOG.ST
  assert.deepEqual([p.transactions[1].symbol, p.transactions[1].flex_symbol], ["EVO", "EVOG.ST"]);
  assert.deepEqual([p.dividends[0].symbol, p.withholding_tax[0].symbol], ["EVO", "EVO"]);
  const pos = computePositions(p.transactions, p.corporate_actions, p.dividends, p.withholding_tax).EVO;
  assert.equal(pos.net_qty, 100);
  // prodej se spároval s nákupem – žádný „prodej bez odpovídajícího nákupu“
  assert.equal(pos.closed_lots.filter((l) => l.orphan).length, 0);
  close(p.cash_balance.SEK, 42451 + 4500 - 675);
});

test("importWarning: chyba posledního běhu hned i s důvodem, stáří dat až od 4 dnů", () => {
  const now = Date.parse("2026-11-07T18:00:00Z");
  const lastImport = "2026-11-01T05:03:01.514Z";
  const failed = { at: "2026-11-07T05:00:20.000Z", ok: false, error: "SendRequest selhal: code=1012, error=Token has expired." };
  assert.equal(
    importWarning("Lynx", lastImport, failed, now),
    "Auto-import Lynx 7. 11. 6:00 neprošel – SendRequest selhal: code=1012, error=Token has expired. " +
      "Data Lynx jsou z importu 1. 11. 6:03.",
  );
  // Chyba se hlásí, i když jsou data ze včerejška čerstvá
  assert.match(importWarning("IBKR", "2026-11-06T05:00:14Z", { ...failed, error: "GetStatement HTTP 503" }, now), /neprošel – GetStatement HTTP 503\. Data IBKR jsou z importu 6\. 11\. 6:00\.$/);

  const ok = { at: "2026-11-07T05:00:20.000Z", ok: true, new_items: 0, nav_do: "2026-10-30" };
  assert.equal(
    importWarning("Lynx", lastImport, ok, now),
    "Auto-import Lynx naposledy proběhl 7. 11. 6:00 bez chyby, ale nová data naposledy přinesl před 6 dny (1. 11. 6:03).",
  );
  assert.equal(importWarning("Lynx", lastImport, null, now), "Auto-import Lynx nová data naposledy přinesl před 6 dny (1. 11. 6:03).");
  // Víkend (data z pátečního rána, je pondělí večer) ani portfolio bez importu nehlásí nic
  assert.equal(importWarning("IBKR", "2026-11-06T05:00:14Z", ok, Date.parse("2026-11-09T18:00:00Z")), null);
  assert.equal(importWarning("KB", null, null, now), null);
});

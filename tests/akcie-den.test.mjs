/**
 * Unit testy MCP nástroje akcie_den — čisté sestavení reportu bez sítě
 * (ceny, kurzy a portfolia jsou fixtures).
 *
 * Spuštění: node --test tests/*.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  buildAkcieDenReport,
  openPositionsAt,
  parseArgs,
  pragueToday,
} from "../worker/mcp/akcie-den.js";

function close(actual, expected, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) < eps, `očekáváno ${expected}, dostal ${actual}`);
}

test("pragueToday: obchodní den je pražský, i když v UTC je ještě včera", () => {
  // 00:30 Prahy (CEST) = 22:30 UTC předchozího dne
  assert.equal(pragueToday(new Date("2026-09-22T22:30:00Z")), "2026-09-23");
  assert.equal(pragueToday(new Date("2026-09-23T02:45:00Z")), "2026-09-23");
  // zima (CET, +1)
  assert.equal(pragueToday(new Date("2026-01-15T23:30:00Z")), "2026-01-16");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("parseArgs: výchozí včera + vše, validace data a portfolia", () => {
  const ids = ["a", "b"];
  assert.deepEqual(parseArgs({}, ids, "2026-09-23"), { datum: "2026-09-22", portfolioId: "vse" });
  assert.deepEqual(parseArgs({ datum: "", portfolio: "" }, ids, "2026-09-23"), { datum: "2026-09-22", portfolioId: "vse" });
  assert.deepEqual(parseArgs({ datum: "2026-09-19", portfolio: "b" }, ids, "2026-09-23"), { datum: "2026-09-19", portfolioId: "b" });
  assert.throws(() => parseArgs({ datum: "2026-02-30" }, ids, "2026-09-23"), /YYYY-MM-DD/);
  assert.throws(() => parseArgs({ datum: "22.9.2026" }, ids, "2026-09-23"), /YYYY-MM-DD/);
  assert.throws(() => parseArgs({ datum: "2026-09-24" }, ids, "2026-09-23"), /budoucnosti/);
  assert.throws(() => parseArgs({ portfolio: "x" }, ids, "2026-09-23"), /Neznámé portfolio/);
});

const DATUM = "2026-09-22";
const FX = {
  dates: {
    [DATUM]: { valid_for: DATUM, rates: { USD: { rate: 20, amount: 1 }, EUR: { rate: 25, amount: 1 } } },
  },
};
const buy = (symbol, quantity, price, date = "2026-01-05", extra = {}) => ({
  symbol, date, time: "10:00:00", type: "BUY", quantity, price, proceeds: -quantity * price, commission: 0, ...extra,
});

// Portfolio A: AAA obchoduje (split PO datu → ceny ×2), BBB burza měla zavřeno,
// CCC bez ceny, DDD delisted. Hotovost z denního NAV (cash_balance se ignoruje).
function portfolioA() {
  return {
    inception_date: "2026-01-01",
    total_deposits_usd: 2000,
    instruments: {
      AAA: { currency: "USD", yahoo_symbol: "AAA", name: "Alpha" },
      BBB: { currency: "EUR", yahoo_symbol: "BBB.DE", name: "Beta" },
      CCC: { currency: "USD", yahoo_symbol: "CCC", name: "Gamma" },
      DDD: { currency: "USD", yahoo_symbol: "DDD", name: "Delta", delisted: "2026-01-01" },
    },
    transactions: [buy("AAA", 10, 100), buy("BBB", 4, 50), buy("CCC", 1, 10), buy("DDD", 3, 5)],
    corporate_actions: [{ type: "split", symbol: "AAA", date: "2026-10-01", ratio_from: 1, ratio_to: 2 }],
    static_nav_history: [{ reportDate: "20260922", currency: "USD", cash: 100 }],
    cash_balance: { USD: 999 },
  };
}

// Portfolio B: EEE v EUR s dividendou před datem (počítá se) a po datu (ne);
// bez NAV i snapshotů → hotovost z cash_balance
function portfolioB() {
  return {
    inception_date: "2026-02-01",
    total_deposits_usd: 500,
    instruments: { EEE: { currency: "EUR", yahoo_symbol: "EEE.PA", name: "Epsilon" } },
    transactions: [buy("EEE", 2, 100, "2026-02-01")],
    corporate_actions: [],
    dividends: [
      { symbol: "EEE", date: "2026-05-01", amount: 10, currency: "EUR" },
      { symbol: "EEE", date: "2026-10-01", amount: 99, currency: "EUR" },
    ],
    cash_balance: { EUR: 40 },
  };
}

const QUOTES = {
  AAA: { close: 60, prev_close: 55, price_date: DATUM, currency: "USD" },
  "BBB.DE": { close: 52, prev_close: 50, price_date: "2026-09-21", currency: "EUR" },
  CCC: { error: "No data for CCC" },
  "EEE.PA": { close: 90, prev_close: 100, price_date: DATUM, currency: "EUR" },
};

function report() {
  const loaded = [
    { meta: { id: "a", name: "Port A" }, portfolio: portfolioA(), lastImport: "2026-09-22T05:00:12Z" },
    { meta: { id: "b", name: "Port B" }, portfolio: portfolioB(), lastImport: null },
  ];
  for (const l of loaded) l.open = openPositionsAt(l.portfolio, DATUM);
  return buildAkcieDenReport({ datum: DATUM, today: "2026-09-23", loaded, quotes: QUOTES, fxRates: FX, origin: "https://x.test" });
}

test("akcie_den: pozice — split po datu, neobchodovaný den, chybějící cena, delisted", () => {
  const a = report().portfolia[0];
  const by = Object.fromEntries(a.pozice.map((p) => [p.symbol, p]));
  // AAA: Yahoo close 60/55 je split-adjusted → skutečně 120/110
  assert.equal(by.AAA.close, 120);
  assert.equal(by.AAA.prev_close, 110);
  assert.equal(by.AAA.obchodovano, true);
  assert.equal(by.AAA.hodnota_czk, 24000);
  assert.equal(by.AAA.den.zmena_pct, 9.09);
  assert.equal(by.AAA.den.zmena_czk, 2000);
  assert.deepEqual(by.AAA.total_return, { mena: 200, czk: 4000, pct: 20, div_stejna_mena: true });
  // BBB: poslední závěr z 21. 9. — změna se vypíše, ale neobchodoval
  assert.equal(by.BBB.obchodovano, false);
  assert.equal(by.BBB.obchodni_den, "2026-09-21");
  assert.equal(by.BBB.den.zmena_pct, 4);
  // CCC bez ceny, DDD delisted — nezmizí, jen cena_chybi
  assert.equal(by.CCC.cena_chybi, true);
  assert.equal(by.CCC.hodnota_czk, null);
  assert.match(by.CCC.duvod, /cena nedostupná/);
  assert.equal(by.DDD.cena_chybi, true);
  assert.equal(by.DDD.hodnota_czk, 0);
  assert.equal(by.DDD.total_return.mena, -15); // oceněno 0 jako v appce
  // řazení: denní změna sestupně, bez změny na konec
  assert.deepEqual(a.pozice.map((p) => p.symbol), ["AAA", "BBB", "CCC", "DDD"]);
});

test("akcie_den: souhrn portfolia — denní změna jen z obchodovaných, hotovost, výnos", () => {
  const [a, b] = report().portfolia;
  assert.equal(a.hodnota_pozic_czk, 24000 + 5200);
  assert.deepEqual(a.den, { zmena_czk: 2000, zmena_pct: 7.35, obchodovalo: 1, neobchodovalo: 1, cena_chybi: 2 });
  // hotovost z denního NAV (100 USD), ne z cash_balance
  assert.equal(a.cash_czk, 2000);
  assert.equal(a.cash_k, DATUM);
  assert.equal(a.cash_denni, true);
  assert.deepEqual(a.cash_meny, [{ mena: "USD", castka: 100, czk: 2000 }]);
  assert.equal(a.hodnota_celkem_czk, 31200);
  // (31200/20 − 2000) / 2000 = −22 %
  assert.equal(a.celkovy_vynos.usd, -440);
  assert.equal(a.celkovy_vynos.pct, -22);
  assert.equal(a.celkovy_vynos.czk, -8800);
  assert.equal(a.celkovy_vynos.od, "2026-01-01");
  // bez evidence toků → total_deposits_usd k datu založení; P.a. = XIRR (spočteno nezávisle)
  assert.equal(a.celkovy_vynos.vlozeno_usd, 2000);
  assert.equal(a.celkovy_vynos.vybrano_usd, 0);
  assert.equal(a.celkovy_vynos.pa_pct, -29.09);
  assert.deepEqual(a.nejlepsi, { symbol: "AAA", zmena_pct: 9.09 });

  // B: dividenda po datu se nepočítá; bez snapshotu hotovost z cash_balance
  const eee = b.pozice[0];
  assert.deepEqual(eee.total_return, { mena: -10, czk: -250, pct: -5, div_stejna_mena: true });
  assert.deepEqual(b.den, { zmena_czk: -500, zmena_pct: -10, obchodovalo: 1, neobchodovalo: 0, cena_chybi: 0 });
  assert.equal(b.cash_czk, 1000);
  assert.equal(b.cash_k, null);
  assert.equal(b.cash_denni, false);
  assert.match(b.cash_zdroj, /cash_balance/);
  assert.deepEqual(b.cash_meny, [{ mena: "EUR", castka: 40, czk: 1000 }]);
});

test("akcie_den: hotovost po měnách ukáže i měnu bez kurzu, nulové vynechá", () => {
  const p = portfolioB();
  p.cash_balance = { EUR: 40, XXX: 5, CZK: 0 };
  const loaded = [{ meta: { id: "b" }, portfolio: p, lastImport: null }];
  loaded[0].open = openPositionsAt(p, DATUM);
  const r = buildAkcieDenReport({ datum: DATUM, today: "2026-09-23", loaded, quotes: QUOTES, fxRates: FX, origin: null });
  assert.deepEqual(r.portfolia[0].cash_meny, [
    { mena: "EUR", castka: 40, czk: 1000 },
    { mena: "XXX", castka: 5, czk: null },
  ]);
  assert.equal(r.portfolia[0].cash_czk, 1000); // bez kurzu se nesčítá
  assert.ok(r.varovani.some((v) => v.includes("XXX")));
});

test("akcie_den: vse sčítá v Kč, výnos = Σ zisků / čistý vložený kapitál, P.a. = XIRR všech toků", () => {
  const r = report();
  assert.equal(r.vse.hodnota_pozic_czk, 33700);
  assert.equal(r.vse.cash_czk, 3000);
  assert.equal(r.vse.hodnota_celkem_czk, 36700);
  close(r.vse.den.zmena_pct, 4.66);
  assert.equal(r.vse.den.zmena_czk, 1500);
  assert.deepEqual(r.vse.celkovy_vynos, { pct: -26.6, czk: -13300, usd: -665, pa_pct: -35.49, vlozeno_usd: 2500, vybrano_usd: 0 });
  assert.deepEqual(r.vse.nejlepsi, { symbol: "AAA", portfolio: "a", zmena_pct: 9.09 });
  assert.deepEqual(r.vse.nejhorsi, { symbol: "EEE", portfolio: "b", zmena_pct: -10 });
  assert.deepEqual(r.fx, { datum: DATUM, platny_k: DATUM, EUR: 25, USD: 20 });
  assert.deepEqual(r.overlay, { last_import: "2026-09-22T05:00:12Z", nav_do: DATUM });
  assert.equal(r.odkaz, "https://x.test/");
  assert.deepEqual(r.varovani, []);
});

test("akcie_den: KB — počáteční kapitál a výběry z evidence, vklad po datu se nepočítá", () => {
  const b = portfolioB();
  delete b.total_deposits_usd;
  b.opening_cash = { date: "2026-02-01", balances: { USD: 300 } };
  b.cash_flows = [
    { date: "2026-03-01", type: "deposit", currency: "USD", amount: 400 },
    // EUR bez kurzu k datu → nejnovější kurz (25/20): −100 EUR = −125 USD
    { date: "2026-06-01", type: "withdrawal", currency: "EUR", amount: -100 },
    { date: "2026-10-01", type: "deposit", currency: "USD", amount: 5000 },
  ];
  const loaded = [
    { meta: { id: "a" }, portfolio: portfolioA(), lastImport: null },
    { meta: { id: "b" }, portfolio: b, lastImport: null },
  ];
  for (const l of loaded) l.open = openPositionsAt(l.portfolio, DATUM);
  const r = buildAkcieDenReport({ datum: DATUM, today: "2026-09-23", loaded, quotes: QUOTES, fxRates: FX, origin: null });
  // hodnota B 275 USD; zisk = 275 + 125 − 700 = −300; % z vloženého (výběry základ nezmenšují)
  assert.deepEqual(r.portfolia[1].celkovy_vynos, {
    pct: -42.86, czk: -6000, usd: -300, pa_pct: -66.8, od: "2026-02-01", vlozeno_usd: 700, vybrano_usd: 125,
  });
  // vse: −740 / (2700 − 125); převody mezi portfolii se v čistém kapitálu vyruší
  assert.deepEqual(r.vse.celkovy_vynos, {
    pct: -28.74, czk: -14800, usd: -740, pa_pct: -38, vlozeno_usd: 2700, vybrano_usd: 125,
  });
});

test("akcie_den: den bez obchodování → nulová denní změna, pozice si nesou poslední", () => {
  const loaded = [{ meta: { id: "b" }, portfolio: portfolioB(), lastImport: null }];
  loaded[0].open = openPositionsAt(loaded[0].portfolio, "2026-09-19");
  const quotes = { "EEE.PA": { close: 90, prev_close: 100, price_date: "2026-09-18", currency: "EUR" } };
  const r = buildAkcieDenReport({ datum: "2026-09-19", today: "2026-09-23", loaded, quotes, fxRates: FX, origin: null });
  const b = r.portfolia[0];
  assert.equal(b.den.zmena_czk, 0);
  assert.equal(b.den.obchodovalo, 0);
  assert.equal(b.nejlepsi, null);
  assert.equal(b.pozice[0].obchodovano, false);
  assert.equal(b.pozice[0].den.zmena_pct, -10);
});

test("openPositionsAt: nákup se počítá podle data obchodu, ne vypořádání", () => {
  const p = portfolioB();
  p.transactions.push(buy("EEE", 3, 90, DATUM, { settle_date: "2026-09-23" }));
  close(openPositionsAt(p, DATUM)[0].pos.net_qty, 5);
  close(openPositionsAt(p, "2026-09-21")[0].pos.net_qty, 2);
});

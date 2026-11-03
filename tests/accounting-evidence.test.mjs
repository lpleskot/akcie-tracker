/**
 * Unit testy /api/accounting-evidence — evidence pro odsouhlasení s účetnictvím
 * (účetní BI plegi-invest-bi). Portfolio a kurzy jsou fixtures, hodnoty
 * spočítané ručně v komentářích.
 *
 * Spuštění: node --test tests/*.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAccountingEvidence, parseParams } from "../worker/api/accounting-evidence.js";

function close(actual, expected, eps = 0.005) {
  assert.ok(actual != null && Math.abs(actual - expected) < eps, `očekáváno ${expected}, dostal ${actual}`);
}

const rate = (r) => ({ rate: r, amount: 1 });
const FX = {
  dates: {
    "2024-06-03": { valid_for: "2024-06-03", rates: { USD: rate(22.9) } },
    "2024-06-04": { valid_for: "2024-06-04", rates: { USD: rate(23) } },
    "2024-12-30": { valid_for: "2024-12-30", rates: { USD: rate(24) } },
    "2025-03-10": { valid_for: "2025-03-10", rates: { USD: rate(23) } },
    "2025-03-11": { valid_for: "2025-03-11", rates: { USD: rate(23.2) } },
    "2025-04-15": { valid_for: "2025-04-15", rates: { USD: rate(22.5) } },
    "2025-06-03": { valid_for: "2025-06-03", rates: { USD: rate(22.1) } },
    "2025-12-31": { valid_for: "2025-12-31", rates: { USD: rate(20), EUR: rate(25) } },
  },
};

const tx = (symbol, type, date, settle_date, quantity, price, commission, extra = {}) => ({
  symbol, type, date, settle_date, time: "10:00:00", quantity, price, proceeds: (type === "BUY" ? -1 : 1) * quantity * price, commission, ...extra,
});

// AAA: nákup před obdobím (syntetický počáteční stav), nákup v období ze dvou
// obchodů téhož dne, prodej 12 ks (FIFO: celý první nákup + 2 ks druhého),
// split 1:2. BBB: bonusové kusy bez nákupu a nákup vypořádaný až po období.
// CCC: prodej bez nákupu (orphan) → jen varování.
function portfolio() {
  return {
    account: "1609386",
    base_currency: "CZK",
    instruments: {
      AAA: { isin: "US0000000001", name: "Alpha Inc", currency: "USD" },
      BBB: { isin: "DE0000000002", name: "Beta AG", currency: "EUR" },
      CCC: { isin: "US0000000003", name: "Gamma", currency: "USD" },
    },
    transactions: [
      tx("AAA", "BUY", "2024-06-03", "2024-06-04", 10, 100, -2, { synthetic_opening: true }),
      tx("AAA", "BUY", "2025-03-10", "2025-03-11", 5, 110, -1),
      tx("AAA", "BUY", "2025-03-10", "2025-03-11", 5, 112, -1, { time: "11:00:00" }),
      tx("AAA", "SELL", "2025-06-02", "2025-06-03", 12, 130, -3),
      tx("BBB", "BUY", "2025-12-30", "2026-01-02", 4, 50, 0),
      tx("CCC", "SELL", "2025-07-01", "2025-07-02", 2, 10, 0),
    ],
    corporate_actions: [
      { type: "split", symbol: "AAA", date: "2025-09-01", ratio_from: 1, ratio_to: 2 },
      { type: "bonus_shares", symbol: "BBB", date: "2025-02-01", quantity: 3 },
    ],
    dividends: [
      { date: "2025-04-15", symbol: "AAA", amount: 5, currency: "USD" },
      { date: "2025-05-01", symbol: "AAA", amount: 4, currency: "USD" },
    ],
    withholding_tax: [{ date: "2025-04-15", symbol: "AAA", amount: -0.75, currency: "USD" }],
    cash_flows: [
      { date: "2024-11-01", type: "deposit", currency: "USD", amount: 50 },
      { date: "2025-02-03", type: "deposit", currency: "USD", amount: 300, description: "Vklad" },
    ],
    cash_history: [
      { date: "2024-12-31", source: "výpis 2024", cash: { USD: 100 } },
      { date: "2025-09-30", source: "výpis Q3", cash: { USD: 200, CZK: 1000 } },
    ],
  };
}

function build() {
  return buildAccountingEvidence({
    owner: { id: "firma", name: "Firma s.r.o.", type: "firma", portfolios: ["kb"] },
    from: "2025-01-01",
    to: "2025-12-31",
    loaded: [{ meta: { id: "kb", name: "Firma KB", short: "KB", broker: "Komerční banka" }, portfolio: portfolio(), lastImport: null }],
    fxRates: FX,
    now: new Date("2026-11-03T20:00:00Z"),
  });
}

test("parseParams: vlastník a skutečná data od ≤ do", () => {
  const p = (q) => parseParams(new URLSearchParams(q));
  assert.deepEqual(p("owner=plegi-invest&from=2025-01-01&to=2025-12-31"), { owner: "plegi-invest", from: "2025-01-01", to: "2025-12-31" });
  assert.match(p("from=2025-01-01&to=2025-12-31").error, /owner/);
  assert.match(p("owner=x&from=2025-02-30&to=2025-12-31").error, /YYYY-MM-DD/);
  assert.match(p("owner=x&from=2025-12-31&to=2025-01-01").error, /nejpozději/);
});

test("hlavička: vlastník, období, poslední den v kurzech, portfolio", () => {
  const out = build();
  assert.deepEqual(out.owner, { id: "firma", name: "Firma s.r.o.", type: "firma" });
  assert.equal(out.from, "2025-01-01");
  assert.equal(out.to, "2025-12-31");
  assert.equal(out.fx_last_date, "2025-12-31");
  assert.equal(out.generated_at, "2026-11-03T20:00:00.000Z");
  const p = out.portfolios[0];
  assert.equal(p.id, "kb");
  assert.equal(p.short, "KB");
  assert.equal(p.account, "1609386");
});

test("nákupy: Kč k vypořádání i ke dni obchodu, zbytek na začátku a na konci období", () => {
  const { purchases } = build().portfolios[0];
  // BBB nákup vypořádaný 2. 1. 2026 do období nepatří
  assert.equal(purchases.filter((p) => p.symbol === "BBB" && !p.bonus).length, 0);

  // 10 × 100 + komise 2 = 1 002 USD; × 23 (4. 6.) = 23 046; × 22,9 (den obchodu) = 22 945,80
  const p1 = purchases.find((p) => p.symbol === "AAA" && p.trade_date === "2024-06-03");
  assert.equal(p1.settle_date, "2024-06-04");
  assert.equal(p1.synthetic, true);
  close(p1.cost, 1002);
  close(p1.czk, 23046);
  close(p1.czk_trade, 22945.8);
  // držený celý k 31. 12. 2024, prodaný v červnu 2025
  close(p1.start_qty, 10);
  close(p1.start_czk, 23046);
  close(p1.end_qty, 0);
  close(p1.end_czk, 0);

  // dva obchody téhož dne = jeden nákup: 550 + 1 + 560 + 1 = 1 112 USD; × 23,2 = 25 798,40; × 23 = 25 576
  const p2 = purchases.find((p) => p.symbol === "AAA" && p.trade_date === "2025-03-10");
  close(p2.qty, 10);
  close(p2.cost, 1112);
  close(p2.czk, 25798.4);
  close(p2.czk_trade, 25576);
  close(p2.start_czk, 0);
  // prodej vzal 2 ks z prvního obchodu (110,20/ks), zbývá 3 × 110,20 + 5 × 112,20 = 891,60 USD;
  // split 1:2 zdvojí kusy (8 → 16), cenu nemění; × 23,2 = 20 685,12
  close(p2.end_qty, 16);
  close(p2.end_cost, 891.6);
  close(p2.end_czk, 20685.12);

  const bonus = purchases.find((p) => p.symbol === "BBB");
  assert.equal(bonus.bonus, true);
  assert.equal(bonus.settle_date, null);
  close(bonus.end_qty, 3);
  assert.equal(bonus.czk, 0);
  assert.equal(bonus.end_czk, 0);
});

test("prodeje: hrubě = tržba, poplatek, FIFO pořizovací cena z nákupů kurzem k jejich vypořádání", () => {
  const { sales } = build().portfolios[0];
  assert.equal(sales.length, 1); // CCC bez nákupu se nepočítá
  const s = sales[0];
  assert.equal(s.symbol, "AAA");
  assert.equal(s.trade_date, "2025-06-02");
  assert.equal(s.settle_date, "2025-06-03");
  close(s.qty, 12);
  close(s.gross, 1560);
  close(s.fee, 3);
  close(s.net, 1557);
  close(s.gross_czk, 34476); // 1 560 × 22,1
  close(s.net_czk, 34409.7);
  // 23 046 (celý první nákup) + 2 × 110,20 × 23,2 = 5 113,28
  close(s.cost_czk, 28159.28);
  close(s.profit_czk, 6250.42);
  assert.equal(s.fx_ok, true);
  assert.deepEqual(
    s.lots.map((l) => [l.settle_date, l.qty]),
    [["2024-06-04", 10], ["2025-03-11", 2]],
  );
});

test("dividendy a srážková daň: kurz ke dni výplaty, chybějící den = předchozí kurz s varováním", () => {
  const out = build();
  const { dividends, withholding } = out.portfolios[0];
  assert.equal(dividends.length, 2);
  close(dividends[0].czk, 112.5);
  assert.equal(dividends[0].fx_estimated, false);
  // 1. 5. v kurzech není → 15. 4. (22,5)
  close(dividends[1].czk, 90);
  assert.equal(dividends[1].fx_estimated, true);
  assert.ok(out.warnings.some((w) => w.includes("dividenda 2025-05-01")));
  // daň kladně
  close(withholding[0].amount, 0.75);
  close(withholding[0].czk, 16.88);
});

test("hotovost na začátku a na konci období, starší výpis s varováním; pohyby hotovosti v období", () => {
  const out = build();
  const { cash, cash_flows } = out.portfolios[0];
  assert.equal(cash.start.as_of, "2024-12-31");
  close(cash.start.czk, 2400); // 100 USD × 24 (31. 12. 2024 v kurzech není → 30. 12.)
  assert.equal(cash.end.as_of, "2025-09-30");
  close(cash.end.czk, 5000); // 1 000 Kč + 200 USD × 20
  assert.deepEqual(cash.end.balances.map((b) => b.currency), ["CZK", "USD"]);
  assert.ok(out.warnings.some((w) => w.includes("hotovost k 2025-12-31 je ze stavu k 2025-09-30")));
  assert.deepEqual(cash_flows, [{ date: "2025-02-03", type: "deposit", currency: "USD", amount: 300, description: "Vklad" }]);
});

test("prodej bez nákupu v evidenci je jen varování", () => {
  const out = build();
  assert.ok(out.warnings.some((w) => w.includes("CCC") && w.includes("nemá nákup")));
});

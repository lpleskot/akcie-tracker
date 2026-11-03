/**
 * Unit testy pravidel alertů — stejný kód používá ranní kontrola, API
 * /api/alerts i náhled v tabu Alerty.
 *
 * Spuštění: node --test tests/*.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_FIRED_PORTFOLIO,
  alertRuleMatches,
  firedAlertId,
  firedAlertKey,
  heldYahooSymbols,
  legacyFiredAlertKey,
  parseFiredAlertKey,
} from "../assets/js/alerts-shared.js";

const RULE_ALL = { id: "r1", type: "drop_from_buy_all", scope: "owned", threshold_pct: -20, armed: true };

// Stejný ticker ve dvou portfoliích s jinou nákupní cenou + titul jen v jednom
const HOLDINGS = [
  {
    id: "firma-ibkr",
    name: "Firma IBKR",
    positions: {
      ADBE: { net_qty: 10, avg_open_price: 500 },
      NKE: { net_qty: 5, avg_open_price: 100 },
      PLUG: { net_qty: 0, avg_open_price: 10 },
    },
    instruments: {
      ADBE: { yahoo_symbol: "ADBE", name: "Adobe", currency: "USD" },
      NKE: { yahoo_symbol: "NKE", name: "Nike", currency: "USD" },
      PLUG: { yahoo_symbol: "PLUG", name: "Plug Power", currency: "USD" },
    },
  },
  {
    id: "osoba-lynx",
    name: "Osoba Lynx",
    positions: {
      ADBE: { net_qty: 3, avg_open_price: 350 },
      CEDER: { net_qty: 100, avg_open_price: 20 },
      OLD: { net_qty: 50, avg_open_price: 5 },
    },
    instruments: {
      ADBE: { yahoo_symbol: "ADBE", name: "Adobe", currency: "USD" },
      CEDER: { yahoo_symbol: "CEDER.ST", name: "Cederroth", currency: "SEK" },
      OLD: { yahoo_symbol: "OLD", name: "Delisted Co", currency: "USD", delisted: "2025-01-10" },
    },
  },
];

const QUOTES = {
  ADBE: { price: 300, fifty_two_week_high: 450 },
  NKE: { price: 85, fifty_two_week_high: 120 },
  PLUG: { price: 2 },
  "CEDER.ST": { price: 10, fifty_two_week_high: 12 },
  OLD: { price: 0, delisted: true },
};

test("drop_from_buy_all: pozice ze všech portfolií, každá se svou nákupní cenou", () => {
  const m = alertRuleMatches(RULE_ALL, HOLDINGS, QUOTES);
  // ADBE firma −40 %, CEDER −50 %; ADBE osoba jen −14,3 %, NKE −15 %, PLUG prodaný, OLD delisted
  assert.deepEqual(
    m.map((x) => [x.portfolioId, x.symbol, Math.round(x.changePct)]),
    [["osoba-lynx", "CEDER", -50], ["firma-ibkr", "ADBE", -40]],
  );
  assert.equal(m[1].portfolioName, "Firma IBKR");
  assert.equal(m[1].reference, 500);
  assert.equal(m[1].current, 300);
});

test("drop_from_buy: jen zvolený ticker, ve všech portfoliích", () => {
  const rule = { ...RULE_ALL, type: "drop_from_buy", symbol: "ADBE", threshold_pct: 10 };
  const m = alertRuleMatches(rule, HOLDINGS, QUOTES);
  assert.deepEqual(m.map((x) => x.portfolioId), ["firma-ibkr", "osoba-lynx"]);
  assert.deepEqual(alertRuleMatches({ ...rule, symbol: undefined }, HOLDINGS, QUOTES), []);
});

test("drop_from_52w_high měří od 52týdenního maxima", () => {
  const rule = { ...RULE_ALL, type: "drop_from_52w_high", threshold_pct: -25 };
  const m = alertRuleMatches(rule, HOLDINGS, QUOTES);
  // ADBE 300 vs 450 = −33,3 % v obou portfoliích; NKE −29,2 %; CEDER −16,7 %
  assert.deepEqual(
    m.map((x) => `${x.portfolioId}:${x.symbol}`),
    ["firma-ibkr:ADBE", "osoba-lynx:ADBE", "firma-ibkr:NKE"],
  );
  assert.equal(m[0].reference, 450);
});

test("bez ceny, s nulovou referencí, cizí scope nebo neznámý typ nic nehlásí", () => {
  assert.deepEqual(alertRuleMatches(RULE_ALL, HOLDINGS, {}), []);
  assert.deepEqual(alertRuleMatches({ ...RULE_ALL, scope: "watchlist" }, HOLDINGS, QUOTES), []);
  assert.deepEqual(alertRuleMatches({ ...RULE_ALL, type: "jiny" }, HOLDINGS, QUOTES), []);
  assert.deepEqual(alertRuleMatches({ ...RULE_ALL, threshold_pct: undefined }, HOLDINGS, QUOTES), []);
  const zero = [{ ...HOLDINGS[0], positions: { ADBE: { net_qty: 1, avg_open_price: 0 } } }];
  assert.deepEqual(alertRuleMatches(RULE_ALL, zero, QUOTES), []);
});

test("heldYahooSymbols: držené tituly všech portfolií bez delisted a prodaných", () => {
  assert.deepEqual(heldYahooSymbols(HOLDINGS).sort(), ["ADBE", "CEDER.ST", "NKE"]);
});

test("klíče splnění: nový tvar s portfoliem i starý z doby jen IBKR", () => {
  const key = firedAlertKey("r1", "osoba-lynx", "ADBE");
  assert.equal(key, "fired:alert:r1:osoba-lynx:ADBE");
  assert.deepEqual(parseFiredAlertKey(key), { ruleId: "r1", portfolioId: "osoba-lynx", symbol: "ADBE" });
  assert.deepEqual(parseFiredAlertKey(legacyFiredAlertKey("r1", "MSTR")), {
    ruleId: "r1",
    portfolioId: LEGACY_FIRED_PORTFOLIO,
    symbol: "MSTR",
  });
  assert.equal(parseFiredAlertKey("fired:watch:item:rule"), null);
  assert.equal(parseFiredAlertKey("fired:alert:r1"), null);
  assert.equal(firedAlertId("r1", "osoba-lynx", "ADBE"), "r1:osoba-lynx:ADBE");
});

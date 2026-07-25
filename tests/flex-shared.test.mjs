/**
 * Unit testy sdílených Flex transformací (REVIZE_REPORT.md R9).
 * Spuštění: node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  transformFlexTrade,
  transformFlexDividend,
  isForexConversion,
  deriveYahooSymbol,
  ensureInstrument,
  flexDate,
  flexTime,
} from "../assets/js/flex-shared.js";

test("transformFlexTrade BUY: datumy, settle_date, čísla", () => {
  const t = transformFlexTrade({
    tradeID: "123",
    tradeDate: "20260521",
    settleDateTarget: "20260522",
    dateTime: "20260521;153000",
    symbol: "TTD",
    buySell: "BUY",
    quantity: "400",
    tradePrice: "21.285",
    proceeds: "-8514",
    ibCommission: "-1.5",
    currency: "USD",
  });
  assert.equal(t.type, "BUY");
  assert.equal(t.date, "2026-05-21");
  assert.equal(t.settle_date, "2026-05-22"); // účetně rozhoduje vypořádání
  assert.equal(t.time, "15:30:00");
  assert.equal(t.quantity, 400);
  assert.equal(t.price, 21.285);
  assert.equal(t.commission, -1.5);
  assert.equal(t.flex_id, "123");
});

test("transformFlexTrade SELL: záporné qty → kladné, type SELL", () => {
  const t = transformFlexTrade({
    tradeID: "124",
    tradeDate: "20260721",
    symbol: "TTD",
    buySell: "SELL",
    quantity: "-400",
    tradePrice: "17.495",
    proceeds: "6998",
    ibCommission: "-2.22",
  });
  assert.equal(t.type, "SELL");
  assert.equal(t.quantity, 400);
  assert.equal(t.settle_date, null); // bez settleDateTarget — FIFO fallbackne na date
});

test("isForexConversion: CASH kategorie i BASE.QUOTE symbol", () => {
  assert.equal(isForexConversion({ assetCategory: "CASH", symbol: "EUR.USD" }), true);
  assert.equal(isForexConversion({ symbol: "USD.DKK" }), true);
  assert.equal(isForexConversion({ assetCategory: "STK", symbol: "AAPL" }), false);
});

test("deriveYahooSymbol: burzovní přípony + ponechání existujících", () => {
  assert.equal(deriveYahooSymbol("CSG", "AEB"), "CSG.AS");
  assert.equal(deriveYahooSymbol("ERIC-B", "SFB"), "ERIC-B.ST");
  assert.equal(deriveYahooSymbol("AAPL", "NASDAQ"), "AAPL"); // US bez přípony
  assert.equal(deriveYahooSymbol("SHEL.L", "LSE"), "SHEL.L"); // už má tečku
});

test("ensureInstrument: doplní auto-added, nepřepisuje existující", () => {
  const p = { instruments: { AAPL: { name: "Apple", yahoo_symbol: "AAPL" } } };
  ensureInstrument(p, "CSG", {
    listingExchange: "AEB",
    description: "CSG NV",
    currency: "EUR",
    isin: "NL000",
  });
  assert.equal(p.instruments.CSG.yahoo_symbol, "CSG.AS");
  assert.equal(p.instruments.CSG._auto_added, true);
  ensureInstrument(p, "AAPL", { description: "JINÝ NÁZEV" });
  assert.equal(p.instruments.AAPL.name, "Apple"); // nezměněno
});

test("flexDate/flexTime: formáty a null vstupy", () => {
  assert.equal(flexDate("20260101"), "2026-01-01");
  assert.equal(flexDate(null), null);
  assert.equal(flexTime("20260101;093005"), "09:30:05");
  assert.equal(flexTime(null), null);
});

test("transformFlexDividend: mapování částky a data", () => {
  const d = transformFlexDividend({
    transactionID: "99",
    dateTime: "20260615;000000",
    symbol: "AAPL",
    amount: "12.5",
    currency: "USD",
    dividendType: "Ordinary",
  });
  assert.equal(d.date, "2026-06-15");
  assert.equal(d.amount, 12.5);
  assert.equal(d.type, "Ordinary");
  assert.equal(d.flex_id, "99");
});

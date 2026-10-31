/**
 * Unit testy sdílených Flex transformací (REVIZE_REPORT.md R9).
 * Spuštění: node --test tests/*.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  transformFlexTrade,
  transformFlexDividend,
  transformFlexCorpAction,
  isForexConversion,
  deriveYahooSymbol,
  ensureInstrument,
  symbolByIsin,
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

test("transformFlexTrade: kolkovné (taxes) patří do komise – UK nákup CRST", () => {
  const t = transformFlexTrade({
    tradeID: "125",
    tradeDate: "20220308",
    symbol: "CRST",
    buySell: "BUY",
    quantity: "350",
    tradePrice: "2.74",
    proceeds: "-959",
    ibCommission: "-10",
    taxes: "-4.795",
    netCash: "-973.795",
    currency: "GBP",
  });
  assert.equal(t.commission, -14.795); // = netCash − proceeds
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
  // Hongkong: Yahoo chce čtyřmístný kód
  assert.equal(deriveYahooSymbol("468", "SEHK"), "0468.HK");
  assert.equal(deriveYahooSymbol("9988", "SEHK"), "9988.HK");
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

test("symbolByIsin: neznámý symbol IBKR se páruje přes ISIN a měnu", () => {
  const inst = {
    EVO: { isin: "SE0012673267", currency: "SEK" },
    SHEL: { isin: "GB00BP6MXD84", currency: "GBP" },
  };
  const evo = { symbol: "EVOG.ST", isin: "SE0012673267", currency: "SEK" };
  assert.equal(symbolByIsin(inst, evo), "EVO");
  // známý symbol a řádek bez ISIN zůstávají
  assert.equal(symbolByIsin(inst, { ...evo, symbol: "EVO" }), "EVO");
  assert.equal(symbolByIsin(inst, { symbol: "EVOG.ST", currency: "SEK" }), "EVOG.ST");
  // stejné ISIN v jiné měně = druhá kotace, nový titul
  assert.equal(symbolByIsin(inst, { symbol: "SHELL", isin: "GB00BP6MXD84", currency: "EUR" }), "SHELL");
  // dva instrumenty se stejným ISIN a měnou – nejde poznat, ke kterému patří
  assert.equal(symbolByIsin({ ...inst, EVO2: { isin: "SE0012673267", currency: "SEK" } }, evo), "EVOG.ST");
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

test("transformFlexCorpAction: split z IBKR (FS/RS) → split s poměrem z popisu", () => {
  const fs = transformFlexCorpAction({
    actionID: "173471161",
    symbol: "APH",
    type: "FS",
    dateTime: "20260902;202500",
    reportDate: "20260903",
    description: "APH(US0320951017) SPLIT 2 FOR 1 (APH, AMPHENOL CORP-CL A, US0320951017)",
    quantity: "35",
    currency: "USD",
  });
  assert.equal(fs.type, "split");
  assert.equal(fs.flex_type, "FS");
  assert.deepEqual([fs.ratio_to, fs.ratio_from, fs.date, fs.symbol], [2, 1, "2026-09-02", "APH"]);
  const rs = transformFlexCorpAction({
    actionID: "9",
    symbol: "XYZ",
    type: "RS",
    dateTime: "20260410",
    actionDescription: "XYZ(US0000000000) SPLIT 1 FOR 10 (XYZ, XYZ CORP)",
  });
  assert.deepEqual([rs.type, rs.ratio_to, rs.ratio_from], ["split", 1, 10]);
  // jiný typ (spinoff) nebo split bez poměru v popisu zůstává beze změny
  assert.equal(transformFlexCorpAction({ actionID: "1", symbol: "A", type: "SO", description: "A SPINOFF" }).type, "SO");
  assert.equal(transformFlexCorpAction({ actionID: "2", symbol: "A", type: "FS" }).type, "FS");
});

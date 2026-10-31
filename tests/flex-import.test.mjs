/**
 * Unit testy denního Flex importu bez sítě: zdroje (IBKR + Lynx), parser XML
 * a dedupe overlay — totéž, čím jde i historie ze scripts/flex-history.mjs.
 *
 * Spuštění: node --test tests/*.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyOverlay,
  flexSource,
  mergeOverlay,
  parseFlexXml,
  runAllImports,
} from "../worker/jobs/flex-import.js";

test("flexSource: IBKR z vars, Lynx s pevným portfoliem a vlastním tokenem", () => {
  const env = { PORTFOLIO_ID: "plegi-invest-ibkr", FLEX_TOKEN: "t1", FLEX_QUERY_ID: "1514926", LYNX_FLEX_TOKEN: "t2", LYNX_FLEX_QUERY_ID: "42" };
  const ibkr = flexSource(env, "ibkr");
  assert.deepEqual([ibkr.portfolioId, ibkr.token, ibkr.queryId], ["plegi-invest-ibkr", "t1", "1514926"]);
  const lynx = flexSource(env, "lynx");
  assert.deepEqual([lynx.portfolioId, lynx.token, lynx.queryId, lynx.optional], ["lukas-pleskot-lynx", "t2", "42", true]);
  assert.equal(flexSource(env, "xtb"), null);
});

test("runAllImports: Lynx bez secretu přeskočí, IBKR bez tokenu je chyba", async () => {
  const log = console.log;
  const error = console.error;
  console.log = console.error = () => {};
  try {
    const r = await runAllImports({ PORTFOLIO_ID: "plegi-invest-ibkr", FLEX_QUERY_ID: "1514926" });
    assert.deepEqual(r.lynx, { ok: true, skipped: true });
    assert.equal(r.ibkr.ok, false);
    assert.match(r.ibkr.error, /FLEX_TOKEN/);
  } finally {
    console.log = log;
    console.error = error;
  }
});

const XML = `<FlexQueryResponse queryName="akcie-tracker" type="AF">
<FlexStatements count="1">
<FlexStatement accountId="U1" fromDate="20220101" toDate="20221230" period="" whenGenerated="20261031;085430">
<Trades>
<Trade currency="GBP" assetCategory="STK" symbol="CRST" isin="GB00B8VZXT93" listingExchange="LSE" dateTime="20220308;064959" tradeDate="20220308" settleDateTarget="20220310" quantity="350" tradePrice="2.74" proceeds="-959" taxes="-4.795" ibCommission="-10" ibCommissionCurrency="GBP" netCash="-973.795" buySell="BUY" tradeID="347463486" levelOfDetail="EXECUTION" />
</Trades>
<EquitySummaryInBase>
<EquitySummaryByReportDateInBase currency="CZK" reportDate="20221230" cash="2568.28" stock="80000" total="82568.28" />
</EquitySummaryInBase>
</FlexStatement>
</FlexStatements>
</FlexQueryResponse>`;

test("parseFlexXml + mergeOverlay: kolkovné se načte, opakovaný výpis nic nezdvojí", () => {
  const parsed = parseFlexXml(XML);
  assert.equal(parsed.trades[0].taxes, "-4.795");
  assert.equal(parsed.nav[0].currency, "CZK");
  const first = mergeOverlay(emptyOverlay(), parsed);
  assert.deepEqual([first.stats.newTrades, first.stats.newNavDays], [1, 1]);
  const again = mergeOverlay(first.merged, parseFlexXml(XML));
  assert.deepEqual([again.stats.newTrades, again.stats.newNavDays], [0, 0]);
});

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
  failedSourcesToday,
  flexSource,
  mergeOverlay,
  parseFlexXml,
  readImportStatus,
  runAllImports,
  runImport,
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

function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      return v == null ? null : type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

// Flex Web Service bez sítě: SendRequest vrátí referenci, GetStatement výpis.
// Pole = odpovědi po sobě (opakování), { status } = HTTP chyba (WAF IBKR).
async function withFlex(responses, fn) {
  const { fetch: realFetch } = globalThis;
  const { log, error } = console;
  globalThis.fetch = async (url) => {
    const slot = String(url).includes(".SendRequest") ? "send" : "get";
    const handler = Array.isArray(responses[slot]) ? responses[slot].shift() : responses[slot];
    if (handler instanceof Error) throw handler;
    if (handler && typeof handler === "object") return new Response(handler.body ?? "Forbidden", { status: handler.status });
    return new Response(handler);
  };
  console.log = console.error = () => {};
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    console.log = log;
    console.error = error;
  }
}

const SEND_OK = "<FlexStatementResponse><Status>Success</Status><ReferenceCode>991</ReferenceCode></FlexStatementResponse>";
const lynxEnv = (kv) => ({ LYNX_FLEX_TOKEN: "tajny-token", LYNX_FLEX_QUERY_ID: "42", AKCIE_TRACKER_KV: kv });

test("runImport: stav běhu se zapíše i bez nových dat, overlay jen s novými daty", async () => {
  const kv = fakeKv();
  const first = await withFlex({ send: SEND_OK, get: XML }, () => runImport(lynxEnv(kv), "lynx"));
  assert.equal(first.ok, true);
  const status = await readImportStatus(lynxEnv(kv), "lukas-pleskot-lynx");
  assert.deepEqual([status.ok, status.new_items, status.nav_do], [true, 2, "2022-12-30"]);
  assert.match(status.at, /^\d{4}-\d{2}-\d{2}T/);
  const overlay = kv.store.get("portfolio-overlay:lukas-pleskot-lynx");

  await withFlex({ send: SEND_OK, get: XML }, () => runImport(lynxEnv(kv), "lynx"));
  assert.equal(kv.store.get("portfolio-overlay:lukas-pleskot-lynx"), overlay); // bez nových dat nepřepsán
  assert.equal((await readImportStatus(lynxEnv(kv), "lukas-pleskot-lynx")).new_items, 0);
});

test("runImport: chyba Flexu jde do stavu bez tokenu, overlay zůstane", async () => {
  const kv = fakeKv();
  kv.store.set("portfolio-overlay:lukas-pleskot-lynx", "{}");
  const expired =
    "<FlexStatementResponse><Status>Fail</Status><ErrorCode>1012</ErrorCode><ErrorMessage>Token has expired.</ErrorMessage></FlexStatementResponse>";
  const r = await withFlex({ send: expired, get: XML }, () => runImport(lynxEnv(kv), "lynx"));
  assert.equal(r.ok, false);
  const status = await readImportStatus(lynxEnv(kv), "lukas-pleskot-lynx");
  assert.deepEqual([status.ok, status.error], [false, "SendRequest selhal: code=1012, error=Token has expired."]);
  assert.equal(kv.store.get("portfolio-overlay:lukas-pleskot-lynx"), "{}");

  const leak = new Error("Spojení přerušeno: GetStatement?t=tajny-token&q=991");
  await withFlex({ send: SEND_OK, get: leak }, () => runImport(lynxEnv(kv), "lynx"));
  assert.equal((await readImportStatus(lynxEnv(kv), "lukas-pleskot-lynx")).error, "Spojení přerušeno: GetStatement?t=***&q=991");
});

const BUSY =
  "<FlexStatementResponse><Status>Fail</Status><ErrorCode>1001</ErrorCode><ErrorMessage>Statement could not be generated at this time. Please try again shortly.</ErrorMessage></FlexStatementResponse>";

test("runImport: 1001 a 403 z WAF IBKR se zkusí znovu (12. 11. 2026 skončil Lynx hned po 403)", async () => {
  const kv = fakeKv();
  const env = { ...lynxEnv(kv), FLEX_RETRY_MS: "1" };
  const r = await withFlex({ send: [BUSY, { status: 403 }, SEND_OK], get: [{ status: 403 }, XML] }, () => runImport(env, "lynx"));
  assert.equal(r.ok, true);
  assert.equal((await readImportStatus(env, "lukas-pleskot-lynx")).ok, true);

  const blocked = await withFlex({ send: [{ status: 403 }, { status: 403 }, { status: 403 }], get: XML }, () => runImport(env, "lynx"));
  assert.deepEqual([blocked.ok, blocked.error], [false, "SendRequest HTTP 403"]);
});

test("failedSourcesToday: pojistka zkusí znovu Lynx, jen když dnes ráno selhal", async () => {
  const kv = fakeKv();
  const env = lynxEnv(kv);
  const now = new Date("2026-11-12T06:20:00Z"); // 7:20 Prahy
  const status = (at, ok) => kv.store.set("flex-import:lukas-pleskot-lynx", JSON.stringify({ at, ok, error: ok ? undefined : "SendRequest HTTP 403" }));

  status("2026-11-12T05:01:16Z", false);
  assert.deepEqual(await failedSourcesToday(env, now), ["lynx"]);
  status("2026-11-11T23:30:00Z", false); // 0:30 Prahy 12. 11. – pořád dnešek
  assert.deepEqual(await failedSourcesToday(env, now), ["lynx"]);
  status("2026-11-11T05:01:16Z", false); // včera
  assert.deepEqual(await failedSourcesToday(env, now), []);
  status("2026-11-12T05:00:30Z", true);
  assert.deepEqual(await failedSourcesToday(env, now), []);
  assert.deepEqual(await failedSourcesToday({ AKCIE_TRACKER_KV: kv }, now), []); // bez tokenu Lynx není
});

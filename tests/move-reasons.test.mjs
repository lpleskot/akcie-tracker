/**
 * Důvody velkých pohybů pro ranní report (worker/jobs/move-reasons.js):
 * rozbor odpovědi Claude API s vyhledáváním (tvar podle dokumentace web
 * search toolu), ověření zdroje, mezipaměť v KV a časový limit. Bez sítě –
 * klient Claude je falešný.
 *
 * Spuštění: node --test tests/*.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { explainMoves, parseAnswer, reasonsEnabled } from "../worker/jobs/move-reasons.js";

// Testy neplní provozní log
console.log = () => {};
console.error = () => {};

const ARTICLE = "https://247wallst.com/investing/2026/11/06/draftkings-plunges-27-on-weak-2027-forecast/";
const OTHER = "https://www.kiplinger.com/investing/stocks/stock-market-today";

const search = (urls, extra = {}) => [
  { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "DraftKings stock 6 November 2026" } },
  {
    type: "web_search_tool_result",
    tool_use_id: "srvtoolu_1",
    ...extra,
    content: urls.map((url) => ({ type: "web_search_result", url, title: "t", encrypted_content: "e", page_age: "November 6, 2026" })),
  },
];

const answer = (text, { citations = [], stop_reason = "end_turn", before = search([ARTICLE, OTHER]) } = {}) => ({
  model: "claude-opus-5-5",
  stop_reason,
  content: [
    { type: "thinking", thinking: "", signature: "s" },
    ...before,
    { type: "text", text, citations },
  ],
  usage: { input_tokens: 21000, output_tokens: 900, server_tool_use: { web_search_requests: 2 } },
});

const cite = (url) => ({ type: "web_search_result_location", url, title: "t", cited_text: "c", encrypted_index: "i" });

test("odpověď: věta a zdroj z výsledků hledání, en dash a bez tečky na konci", () => {
  const r = parseAnswer([
    answer(
      "slabší výsledky za 3. čtvrtletí a snížený výhled zisku kvůli investicím do predikčních trhů — trh čekal víc.\n" +
        `Zdroj: ${ARTICLE}`,
    ),
  ]);
  assert.deepEqual(r, {
    status: "ok",
    text: "slabší výsledky za 3. čtvrtletí a snížený výhled zisku kvůli investicím do predikčních trhů – trh čekal víc",
    url: ARTICLE,
    host: "247wallst.com",
  });
});

test("odpověď: odkaz v markdownu, bez www a sledovacích parametrů se spáruje s výsledkem", () => {
  const r = parseAnswer([
    answer("**akcie** táhly nahoru zakázky armády USA.\nZdroj: [Kiplinger](https://kiplinger.com/investing/stocks/stock-market-today/?utm_source=x)"),
  ]);
  assert.equal(r.status, "ok");
  assert.equal(r.text, "akcie táhly nahoru zakázky armády USA");
  assert.equal(r.url, OTHER);
  assert.equal(r.host, "kiplinger.com");
});

test("odpověď: vymyšlený odkaz neprojde – vezme se citace, bez ní nic", () => {
  const fake = "https://example.com/neexistuje";
  const withCitation = parseAnswer([answer(`propad po výsledcích.\nZdroj: ${fake}`, { citations: [cite(OTHER)] })]);
  assert.equal(withCitation.url, OTHER);
  const without = parseAnswer([answer(`propad po výsledcích.\nZdroj: ${fake}`)]);
  assert.deepEqual(without, { status: "unknown", reason: "zdroj se mezi výsledky hledání nenašel" });
});

test("odpověď: NEZNÁMO, odmítnutí a useknutá odpověď", () => {
  assert.deepEqual(parseAnswer([answer("NEZNÁMO")]), { status: "unknown" });
  assert.deepEqual(parseAnswer([answer("Neznámo.")]), { status: "unknown" });
  assert.deepEqual(parseAnswer([answer("", { stop_reason: "refusal" })]), { status: "error", error: "stop_reason refusal" });
  assert.equal(parseAnswer([answer("…", { stop_reason: "max_tokens" })]).status, "error");
});

test("odpověď: výsledky z dynamického filtrování (vnořené, s caller) i z dřívějšího tahu", () => {
  const nested = search([ARTICLE], { caller: { type: "code_execution_20260120", tool_id: "srvtoolu_0" } });
  const paused = { ...answer("", { stop_reason: "pause_turn", before: nested }), content: nested };
  const final = answer(`slabý výhled.\nZdroj: ${ARTICLE}`, { before: [] });
  assert.equal(parseAnswer([paused, final]).url, ARTICLE);
});

// ---------- explainMoves s falešným KV a klientem ----------

const MOVE = { symbol: "DKNG", name: "DraftKings", nazev: "DRAFTKINGS INC-CL A", mena: "USD", pctText: "−21,30 %" };
const OPTS = { datum: "2026-11-06", denPopis: "pátek 6. 11. 2026", budgetMs: 1000 };

function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(key, type) {
      const v = map.get(key);
      return v == null ? null : type === "json" ? JSON.parse(v.value) : v.value;
    },
    async put(key, value, opts) {
      map.set(key, { value, opts });
    },
  };
}

function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params, options) {
          calls.push({ params: structuredClone(params), options });
          return { finalMessage: () => handler(params, options, calls.length) };
        },
      },
    },
  };
}

const env = (extra = {}) => ({ ANTHROPIC_API_KEY: "sk-test", AKCIE_TRACKER_KV: fakeKv(), ...extra });

test("bez klíče nebo s PLEGIN_DUVODY = off se nic nevolá", async () => {
  const client = fakeClient(() => assert.fail("nemá se volat"));
  assert.equal(reasonsEnabled({}), false);
  assert.equal(reasonsEnabled({ ANTHROPIC_API_KEY: "k", PLEGIN_DUVODY: "off" }), false);
  assert.equal((await explainMoves({ AKCIE_TRACKER_KV: fakeKv() }, [MOVE], { ...OPTS, client })).size, 0);
  assert.equal((await explainMoves(env({ PLEGIN_DUVODY: "off" }), [MOVE], { ...OPTS, client })).size, 0);
  assert.equal(client.calls.length, 0);
});

test("dotaz: Opus 5.5, hledání max. 3×, záložní model, ven jen titul, den a změna", async () => {
  const client = fakeClient(async () => answer(`slabý výhled.\nZdroj: ${ARTICLE}`));
  await explainMoves(env(), [MOVE], { ...OPTS, client });
  const { params, options } = client.calls[0];
  assert.equal(params.model, "claude-opus-5-5");
  assert.deepEqual(params.tools, [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }]);
  assert.equal(params.fallbacks, "default");
  assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01"]);
  assert.deepEqual(params.output_config, { effort: "medium" });
  assert.equal(
    params.messages[0].content,
    "Akcie: DraftKings (DKNG; v evidenci „DRAFTKINGS INC-CL A“), obchoduje se v USD\n" +
      "Obchodní den: pátek 6. 11. 2026\n" +
      "Změna závěrečné ceny proti předchozímu obchodnímu dni: −21,30 %",
  );
  assert.ok(options.signal instanceof AbortSignal);
});

test("výsledek se uloží do KV i se spotřebou a další běh za stejný den už neplatí", async () => {
  const e = env();
  const client = fakeClient(async () => answer(`slabý výhled.\nZdroj: ${ARTICLE}`));
  const first = await explainMoves(e, [MOVE], { ...OPTS, client });
  assert.equal(first.get("DKNG").status, "ok");
  const saved = e.AKCIE_TRACKER_KV.map.get("plegin-duvod:2026-11-06:DKNG");
  assert.equal(saved.opts.expirationTtl, 60 * 86400);
  const value = JSON.parse(saved.value);
  assert.equal(value.model, "claude-opus-5-5");
  assert.deepEqual(value.usage, { input: 21000, output: 900, cache_read: 0, searches: 2 });

  const again = await explainMoves(e, [MOVE], { ...OPTS, client });
  assert.equal(again.get("DKNG").text, "slabý výhled");
  assert.equal(client.calls.length, 1);
});

test("pause_turn: tah se pošle zpět a pokračuje", async () => {
  const client = fakeClient(async (params, _o, n) =>
    n === 1
      ? { ...answer("", { stop_reason: "pause_turn" }), content: search([ARTICLE]) }
      : answer(`slabý výhled.\nZdroj: ${ARTICLE}`, { before: [] }),
  );
  const r = await explainMoves(env(), [MOVE], { ...OPTS, client });
  assert.equal(r.get("DKNG").status, "ok");
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].params.messages.length, 2);
  assert.equal(client.calls[1].params.messages[1].role, "assistant");
});

test("chyba API a vypršený čas: výsledek error, do KV se nic neuloží", async () => {
  const e = env();
  const failing = fakeClient(async () => {
    throw new Error("529 overloaded");
  });
  const r = await explainMoves(e, [MOVE], { ...OPTS, client: failing });
  assert.deepEqual(r.get("DKNG"), { status: "error", error: "529 overloaded" });

  const slow = fakeClient(
    (_p, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  );
  const moves = ["A", "B", "C", "D"].map((symbol) => ({ ...MOVE, symbol }));
  const late = await explainMoves(e, moves, { ...OPTS, budgetMs: 20, client: slow });
  assert.deepEqual([...late.values()].map((x) => x.error), ["nestihlo se", "nestihlo se", "nestihlo se", "nestihlo se"]);
  assert.equal(slow.calls.length, 3); // čtvrtý titul se po vypršení už nezačal
  assert.equal(e.AKCIE_TRACKER_KV.map.size, 0);
});

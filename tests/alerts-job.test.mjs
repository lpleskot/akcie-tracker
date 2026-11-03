/**
 * Ranní kontrola alertů (worker/jobs/alerts.js) s falešným KV, ASSETS
 * a Yahoo: prochází všechna portfolia z manifestu, splnění značí pro každou
 * pozici zvlášť a respektuje staré značky z doby, kdy hlídala jen IBKR.
 *
 * Spuštění: node --test tests/*.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAlertEvaluation } from "../worker/jobs/alerts.js";
import { get as getAlerts } from "../worker/api/alerts.js";

const buy = (symbol, quantity, price) => ({
  date: "2026-03-02",
  time: "15:30:00",
  symbol,
  type: "BUY",
  quantity,
  price,
  proceeds: -quantity * price,
  commission: 0,
});
const inst = (yahoo_symbol) => ({ yahoo_symbol, name: yahoo_symbol, currency: "USD" });

// ADBE v obou portfoliích s jinou nákupní cenou; při ceně 300 je firma −40 %,
// osoba −25 %. NKE při 85: firma −15 % (nesplňuje), osoba −22,7 %.
const FILES = {
  "/data/portfolios/manifest.json": {
    portfolios: [
      { id: "plegi-invest-ibkr", name: "PLEGI invest IBKR", file: "plegi-invest-ibkr.json" },
      { id: "lukas-pleskot-lynx", name: "Lukáš Pleskot Lynx", file: "lukas-pleskot-lynx.json" },
    ],
  },
  "/data/portfolios/plegi-invest-ibkr.json": {
    instruments: { ADBE: inst("ADBE"), NKE: inst("NKE") },
    transactions: [buy("ADBE", 10, 500), buy("NKE", 5, 100)],
  },
  "/data/portfolios/lukas-pleskot-lynx.json": {
    instruments: { ADBE: inst("ADBE"), NKE: inst("NKE") },
    transactions: [buy("ADBE", 3, 400), buy("NKE", 2, 110)],
  },
};
const PRICES = { ADBE: 300, NKE: 85 };
const RULES = { rules: [{ id: "r1", type: "drop_from_buy_all", scope: "owned", threshold_pct: -20, armed: true }] };

// Yahoo chart API — stejný tvar odpovědi, jaký čte fetchYahooQuote
globalThis.fetch = async (url) => {
  const symbol = decodeURIComponent(new URL(url).pathname.split("/").pop());
  const meta = { symbol, currency: "USD", regularMarketPrice: PRICES[symbol] };
  return new Response(JSON.stringify({ chart: { result: [{ meta }] } }));
};
// Job loguje každý běh — v testu by jen zahlcoval výstup
console.log = () => {};

function fakeEnv({ files = FILES, kv: initial = {} } = {}) {
  const kv = new Map(Object.entries({ alerts: { value: JSON.stringify(RULES) }, ...initial }));
  return {
    kv,
    env: {
      ASSETS: {
        async fetch(url) {
          const body = files[new URL(url).pathname];
          return body ? new Response(JSON.stringify(body)) : new Response("Not found", { status: 404 });
        },
      },
      AKCIE_TRACKER_KV: {
        async get(key, type) {
          const v = kv.get(key);
          return v == null ? null : type === "json" ? JSON.parse(v.value) : v.value;
        },
        async put(key, value, opts) {
          kv.set(key, { value, opts });
        },
        async list({ prefix }) {
          const keys = [...kv]
            .filter(([k]) => k.startsWith(prefix))
            .map(([name, v]) => ({ name, metadata: v.opts?.metadata }));
          return { keys, list_complete: true };
        },
      },
    },
  };
}

const firedKeys = (kv) => [...kv.keys()].filter((k) => k.startsWith("fired:alert:")).sort();

test("ranní kontrola prochází všechna portfolia a splnění značí pro každou pozici", async () => {
  const { env, kv } = fakeEnv();
  const res = await runAlertEvaluation(env, "test");
  assert.equal(res.ok, true);
  assert.equal(res.triggers, 3);
  assert.deepEqual(res.portfolios, ["plegi-invest-ibkr", "lukas-pleskot-lynx"]);
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(firedKeys(kv), [
    "fired:alert:r1:lukas-pleskot-lynx:ADBE",
    "fired:alert:r1:lukas-pleskot-lynx:NKE",
    "fired:alert:r1:plegi-invest-ibkr:ADBE",
  ]);
  assert.ok(kv.get("fired:alert:r1:plegi-invest-ibkr:ADBE").opts.metadata.fired_at);

  // Zapsané pozice se při dalším běhu znovu nehlásí
  const again = await runAlertEvaluation(env, "test");
  assert.equal(again.triggers, 0);
});

test("starý klíč bez portfolia platí pro firemní IBKR, ne pro stejný ticker jinde", async () => {
  const legacy = { value: "2026-10-01T05:00:00.000Z", opts: { metadata: { fired_at: "2026-10-01T05:00:00.000Z" } } };
  const { env, kv } = fakeEnv({ kv: { "fired:alert:r1:ADBE": legacy } });
  const res = await runAlertEvaluation(env, "test", true);
  assert.equal(res.dry_run, true);
  assert.deepEqual(
    res.triggers.map((t) => `${t.portfolioId}:${t.symbol}`).sort(),
    ["lukas-pleskot-lynx:ADBE", "lukas-pleskot-lynx:NKE"],
  );
  // Dry run nic nezapisuje
  assert.deepEqual(firedKeys(kv), ["fired:alert:r1:ADBE"]);

  // API vrací starý klíč pod firemním IBKR
  const body = await (await getAlerts(new Request("https://x/api/alerts"), env)).json();
  assert.deepEqual(body.fired, { "r1:plegi-invest-ibkr:ADBE": "2026-10-01T05:00:00.000Z" });
});

test("portfolio, které se nenačte, se přeskočí a ostatní se hlídají dál", async () => {
  const manifest = FILES["/data/portfolios/manifest.json"];
  const files = {
    ...FILES,
    "/data/portfolios/manifest.json": {
      portfolios: [...manifest.portfolios, { id: "chybi", name: "Chybí", file: "chybi.json" }],
    },
  };
  const { env } = fakeEnv({ files });
  const res = await runAlertEvaluation(env, "test", true);
  assert.equal(res.ok, true);
  assert.deepEqual(res.skipped, ["chybi"]);
  assert.equal(res.triggers.length, 3);
});

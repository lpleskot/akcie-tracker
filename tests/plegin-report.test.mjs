/**
 * Unit testy ranního reportu „Akcie" do PLEGINu (PLEGIN_ZADANI_01):
 * sestavení reportu z výstupu akcie_den bez sítě, rozhodnutí o dni
 * (svátek, nečerstvý import, víkend, pojistka) a běh s falešným KV a PLEGINem.
 *
 * Vzorky ze skutečných dnů: tests/fixtures/akcie-den-*.json (výstup akcie_den)
 * a tests/fixtures/plegin-akcie-skutecne.json (reporty, které z týchž dat
 * složila Claude úloha). Spuštění: node --test tests/*.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import {
  SHORT_NAMES,
  buildPleginReport,
  isBackupHour,
  isImportFresh,
  isWeekend,
  kc,
  pct,
  runPleginReport,
  tone,
  tradingDay,
} from "../worker/jobs/plegin-report.js";
import { run as runEndpoint } from "../worker/api/plegin-report.js";

// timingSafeEqual na crypto.subtle je rozšíření Workers runtime, Node ho nemá
crypto.subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const den = (datum) => fixture(`akcie-den-${datum}.json`);
const REAL = fixture("plegin-akcie-skutecne.json");

const NBSP = "\u00a0";
const plain = (s) => s.replaceAll(NBSP, " ");
// Vědomé rozdíly Workeru proti reportům Claude úlohy (viz PLEGIN_01_PREDANI.md)
const asWorker = (s) =>
  s.replace("— (", "– (").replace(" — ", " – ").replace("CSG · CSG", "CSG · Czechoslovak Group").replace("+0,00 %", "0,00 %");

test("čísla česky: NBSP, desetinná čárka, pravé mínus, nula bez znaménka", () => {
  assert.equal(kc(20163), `+20${NBSP}163${NBSP}Kč`);
  assert.equal(kc(-1234567), `−1${NBSP}234${NBSP}567${NBSP}Kč`);
  assert.equal(kc(832583, { signed: false }), `832${NBSP}583${NBSP}Kč`);
  assert.equal(kc(0), `0${NBSP}Kč`);
  assert.equal(pct(0.23), `+0,23${NBSP}%`);
  assert.equal(pct(-16.95), `−16,95${NBSP}%`);
  assert.equal(pct(-0.004), `0,00${NBSP}%`); // zaokrouhlená −0 je nula
  assert.equal(pct(1234.5), `+1${NBSP}234,50${NBSP}%`);
  assert.equal(pct(null), "–");
});

test("barva dlaždic: ≥ 0 ok, pokles do −1 % warn, pod −1 % bad", () => {
  assert.equal(tone(0), "ok");
  assert.equal(tone(0.52), "ok");
  assert.equal(tone(-0.38), "warn");
  assert.equal(tone(-1), "warn");
  assert.equal(tone(-1.01), "bad");
});

for (const datum of ["2026-10-23", "2026-10-26", "2026-10-27"]) {
  test(`skutečný den ${datum}: souhrn, dlaždice a obě tabulky jako report v PLEGINu`, () => {
    const real = REAL[datum];
    const r = buildPleginReport(den(datum));
    assert.equal(r.key, "akcie");
    assert.equal(r.name, "Akcie");
    assert.equal(r.icon, "📈");
    assert.equal(r.color, "#16a34a");
    assert.equal(r.report_date, datum);
    assert.equal(plain(r.title), asWorker(real.title));
    assert.equal(plain(r.summary), asWorker(real.summary));

    const [stats, ibkr, kb, kontext, detail] = r.sections;
    assert.equal(stats.type, "stats");
    assert.ok(stats.items.length <= 7);
    assert.deepEqual(
      stats.items.map((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, plain(v)]))),
      real.stats.map((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, asWorker(v)]))),
    );

    const realTables = Object.entries(real.tables);
    for (const [i, table] of [ibkr, kb].entries()) {
      const [title, rows] = realTables[i];
      assert.equal(table.type, "table");
      assert.equal(plain(table.title), asWorker(title));
      assert.deepEqual(table.columns, ["Titul", "Den %", "Total Return %", "Total Return Kč"]);
      assert.deepEqual(table.rows.map((row) => row.map(plain)), rows.map((row) => row.map(asWorker)));
    }

    assert.equal(kontext.type, "text");
    assert.equal(kontext.title, "Kontext");
    assert.equal(kontext.body.includes("Data IBKR můžou být o den pozadu"), real.stale);
    assert.deepEqual(detail, {
      type: "list",
      title: "Detail",
      items: [{ title: "Otevřít akcie-tracker", link: "https://akcie-tracker.lukas-pleskot.workers.dev/" }],
    });
  });
}

test("Kontext 27. 10.: účty a tituly dne, hvězdička, hotovost KB, nečerstvý import", () => {
  const body = plain(buildPleginReport(den("2026-10-27")).sections[3].body);
  const odstavce = body.split("\n\n");
  assert.equal(
    odstavce[0],
    "Den táhl nahoru hlavně účet IBKR (+16 333 Kč) díky SOFI · SoFi (+16 943 Kč), PYPL · PayPal (+12 009 Kč) " +
      "a OUST · Ouster (+10 087 Kč); proti šly ADBE · Adobe (−12 321 Kč) a ACN · Accenture (−10 541 Kč). " +
      "Účet KB přidal 3 830 Kč díky P911.DE · Porsche (+11 464 Kč) a YAL.AX · Yancoal (+4 040 Kč); " +
      "proti šla HUYA · Huya (−6 234 Kč).",
  );
  assert.deepEqual(odstavce.slice(1), [
    "\\* NOV · Novo Nordisk vyplácí dividendy v jiné měně, Total Return je jen kapitálový.",
    "Hotovost KB je ze čtvrtletního výpisu k 30. 6. 2026.",
    "Data IBKR můžou být o den pozadu (ranní import z IBKR neproběhl).",
  ]);
});

test("Kontext při poklesu: vede účet, který den nejvíc stáhl dolů", () => {
  const body = plain(buildPleginReport(den("2026-10-26")).sections[3].body);
  assert.match(body, /^Den táhl dolů hlavně účet IBKR \(−104 751 Kč\) kvůli NU · Nu Holdings \(/);
  assert.match(body, /Účet KB ztratil 39 093 Kč kvůli NU · Nu Holdings/);
  assert.ok(!body.includes("o den pozadu"));
});

// Jedno portfolio se čtyřmi pozicemi — základ pro syntetické případy
function sampleDen(overrides = {}) {
  const pozice = [
    { symbol: "SOFI", nazev: "SOFI TECHNOLOGIES INC", obchodni_den: "2026-10-27", obchodovano: true,
      den: { zmena_pct: 2.5, zmena_czk: 5000 }, total_return: { pct: 10, czk: 20000, div_stejna_mena: true }, cena_chybi: false },
    { symbol: "ZZZZ", nazev: "ZZZZ HOLDINGS INC-CL A", obchodni_den: "2026-10-27", obchodovano: true,
      den: { zmena_pct: -1.2, zmena_czk: -1000 }, total_return: { pct: -5, czk: -3000, div_stejna_mena: true }, cena_chybi: false },
    { symbol: "DSY", nazev: "DASSAULT SYSTEMES SE", obchodni_den: "2026-10-23", obchodovano: false,
      den: { zmena_pct: 1.2, zmena_czk: 600 }, total_return: { pct: 40, czk: 45000, div_stejna_mena: false }, cena_chybi: false },
    { symbol: "CNE.TO", nazev: "CANACOL ENERGY LTD", obchodni_den: null, obchodovano: false, den: null,
      total_return: { pct: -96.27, czk: -280000, div_stejna_mena: true }, cena_chybi: true, duvod: "staženo z burzy 2025-11-17, oceněno 0" },
  ];
  return {
    datum: "2026-10-27",
    portfolia: [{
      id: "plegi-invest-ibkr", nazev: "PLEGI invest IBKR", cash_czk: 100000, cash_k: "2026-10-27", cash_denni: true,
      cash_meny: [{ mena: "USD", castka: 4600, czk: 100000 }],
      den: { zmena_czk: 4000, zmena_pct: 0.4, obchodovalo: 2, neobchodovalo: 1, cena_chybi: 1 },
      pozice,
    }],
    vse: {
      den: { zmena_czk: 4000, zmena_pct: 0.4 },
      nejlepsi: { symbol: "SOFI", portfolio: "plegi-invest-ibkr", zmena_pct: 2.5 },
      nejhorsi: { symbol: "ZZZZ", portfolio: "plegi-invest-ibkr", zmena_pct: -1.2 },
    },
    overlay: { last_import: "2026-10-28T05:00:31.000Z", nav_do: "2026-10-27" },
    varovani: [],
    odkaz: "https://akcie-tracker.lukas-pleskot.workers.dev/",
    ...overrides,
  };
}

test("neznámý ticker: titul s názvem z dat; známý z mapy", () => {
  assert.equal(SHORT_NAMES.ZZZZ, undefined);
  const rows = buildPleginReport(sampleDen()).sections[1].rows;
  assert.equal(rows[1][0], "ZZZZ · ZZZZ HOLDINGS INC-CL A");
  assert.equal(rows[0][0], "SOFI · SoFi");
  const worst = buildPleginReport(sampleDen()).sections[0].items.find((t) => t.label === "Nejhorší");
  assert.deepEqual(worst, { label: "Nejhorší", value: `−1,20${NBSP}%`, sub: "ZZZZ · ZZZZ HOLDINGS INC-CL A", tone: "bad" });
});

test("neobchodovaný titul, chybějící cena a hvězdička v tabulce i Kontextu", () => {
  const r = buildPleginReport(sampleDen());
  const [, , dsy, cne] = r.sections[1].rows.map((row) => row.map(plain));
  assert.deepEqual(dsy, ["DSY · Dassault Systèmes", "+1,20 % (23. 10.)", "+40,00 % *", "+45 000 Kč"]);
  assert.deepEqual(cne, ["CNE.TO · Canacol Energy", "– (staženo z burzy 2025-11-17, oceněno 0)", "−96,27 %", "−280 000 Kč"]);
  const body = plain(r.sections[2].body);
  assert.match(body, /Tituly s datem v závorce ten den neobchodovaly/);
  assert.match(body, /\\\* DSY · Dassault Systèmes vyplácí dividendy v jiné měně/);
});

test("hotovost: víc měn → pod hodnotou největší cizí měna", () => {
  const d = sampleDen();
  d.portfolia[0].cash_meny = [
    { mena: "CZK", castka: 0.03, czk: 0 },
    { mena: "EUR", castka: 645.34, czk: 15707 },
    { mena: "GBP", castka: 2288.2, czk: 66579 },
    { mena: "USD", castka: 460.33, czk: 10051 },
  ];
  const tile = buildPleginReport(d).sections[0].items.find((t) => t.label === "Volná hotovost IBKR");
  assert.equal(plain(tile.sub), "+ GBP 2 288");
});

test("svátek: žádná oceněná pozice neobchodovala; bez cen to svátek není", () => {
  const holiday = sampleDen();
  holiday.portfolia[0].pozice.forEach((p) => (p.obchodovano = false));
  assert.equal(tradingDay(holiday), "svatek");
  assert.equal(tradingDay(sampleDen()), "obchodni");
  const noPrices = sampleDen();
  noPrices.portfolia[0].pozice.forEach((p) => (p.cena_chybi = true));
  assert.equal(tradingDay(noPrices), "bez-cen");
});

test("nečerstvý import: NAV za den reportu a import až po něm", () => {
  const fresh = { last_import: "2026-10-28T05:00:31Z", nav_do: "2026-10-27" };
  assert.equal(isImportFresh(fresh, "2026-10-27"), true);
  // ranní import ještě neměl NAV za včerejšek (27. 10. 2026)
  assert.equal(isImportFresh({ last_import: "2026-10-27T05:00:31Z", nav_do: "2026-10-26" }, "2026-10-27"), false);
  // nový NAV, ale import ze včerejška (dnešní ranní import selhal)
  assert.equal(isImportFresh({ last_import: "2026-10-27T21:00:00Z", nav_do: "2026-10-27" }, "2026-10-27"), false);
  // import po půlnoci pražského času, v UTC ještě předchozí den
  assert.equal(isImportFresh({ last_import: "2026-10-27T23:30:00Z", nav_do: "2026-10-27" }, "2026-10-27"), true);
  // ruční běh za starší den — import ho mezitím pokryl
  assert.equal(isImportFresh(fresh, "2026-10-21"), true);
  assert.equal(isImportFresh({ last_import: null, nav_do: "2026-10-27" }, "2026-10-27"), false);
  assert.match(buildPleginReport(sampleDen({ overlay: { last_import: "2026-10-27T05:00:00Z", nav_do: "2026-10-26" } }))
    .sections[2].body, /Data IBKR můžou být o den pozadu/);
});

test("víkend a pojistka v 7:20 Prahy v létě i v zimě", () => {
  assert.equal(isWeekend("2026-10-24"), true); // sobota
  assert.equal(isWeekend("2026-10-25"), true);
  assert.equal(isWeekend("2026-10-26"), false);
  assert.equal(isBackupHour(new Date("2026-07-15T05:20:00Z")), true); // CEST
  assert.equal(isBackupHour(new Date("2026-07-15T06:20:00Z")), false);
  assert.equal(isBackupHour(new Date("2026-11-17T05:20:00Z")), false); // CET
  assert.equal(isBackupHour(new Date("2026-11-17T06:20:00Z")), true);
});

// ---------- Běh s falešným KV a PLEGINem ----------

function fakeEnv({ token = "plr_test", status = 201, body = { created: true } } = {}) {
  const kv = new Map();
  const calls = [];
  return {
    kv,
    calls,
    env: {
      PLEGIN_REPORT: "on",
      PLEGIN_REPORT_TOKEN: token,
      AKCIE_TRACKER_KV: {
        async get(key, type) {
          const v = kv.get(key);
          return v == null ? null : type === "json" ? JSON.parse(v.value) : v.value;
        },
        async put(key, value, opts) {
          kv.set(key, { value, opts });
        },
        async list({ prefix }) {
          return { keys: [...kv].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.opts?.metadata })) };
        },
      },
      PLEGIN: {
        async fetch(url, init) {
          calls.push({ url, init });
          return new Response(JSON.stringify(body), { status });
        },
      },
    },
  };
}

const loadDen = (d) => async () => d;
const status = (kv, datum) => JSON.parse(kv.get(`plegin-report:${datum}`).value);

test("běh: odeslání přes binding PLEGIN s report tokenem, stav sent", async () => {
  const { env, kv, calls } = fakeEnv();
  const res = await runPleginReport(env, { datum: "2026-10-27", source: "manual", loadDen: loadDen(sampleDen()) });
  assert.equal(res.status, "sent");
  assert.equal(res.created, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://todo.lukas-pleskot.workers.dev/mcp/api/reports");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer plr_test");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.key, "akcie");
  assert.equal(sent.report_date, "2026-10-27");
  assert.equal(status(kv, "2026-10-27").status, "sent");
  assert.equal(kv.get("plegin-report:2026-10-27").opts.expirationTtl, 60 * 86400);
});

test("běh po importu: nečerstvá data → jen stav stale, report počká na pojistku", async () => {
  const { env, kv, calls } = fakeEnv();
  const stale = sampleDen({ overlay: { last_import: "2026-10-27T05:00:00Z", nav_do: "2026-10-26" } });
  const res = await runPleginReport(env, { datum: "2026-10-27", source: "import", loadDen: loadDen(stale) });
  assert.equal(res.status, "stale");
  assert.equal(calls.length, 0);
  assert.equal(status(kv, "2026-10-27").status, "stale");
  // pojistka pak pošle i s varováním
  const backup = await runPleginReport(env, { datum: "2026-10-27", source: "backup", loadDen: loadDen(stale) });
  assert.equal(backup.status, "sent");
  assert.equal(backup.fresh, false);
  assert.match(JSON.parse(calls[0].init.body).sections[2].body, /o den pozadu/);
});

test("běh: svátek se nehlásí, odeslaný den automatika nepošle podruhé", async () => {
  const { env, kv, calls } = fakeEnv();
  const holiday = sampleDen();
  holiday.portfolia[0].pozice.forEach((p) => (p.obchodovano = false));
  assert.equal((await runPleginReport(env, { datum: "2026-10-27", source: "import", loadDen: loadDen(holiday) })).status, "holiday");
  assert.equal(calls.length, 0);
  assert.equal(status(kv, "2026-10-27").status, "holiday");

  const { env: env2, calls: calls2 } = fakeEnv();
  await runPleginReport(env2, { datum: "2026-10-27", source: "import", loadDen: loadDen(sampleDen()) });
  const again = await runPleginReport(env2, { datum: "2026-10-27", source: "backup", loadDen: loadDen(sampleDen()) });
  assert.equal(again.status, "skipped");
  assert.equal(calls2.length, 1);
  // ruční běh (hlídač) report přepíše
  await runPleginReport(env2, { datum: "2026-10-27", source: "manual", loadDen: loadDen(sampleDen()) });
  assert.equal(calls2.length, 2);
});

test("běh: víkend, vypnuto, chybí token, dry", async () => {
  const { env, calls } = fakeEnv();
  assert.equal((await runPleginReport(env, { datum: "2026-10-25", source: "manual", loadDen: loadDen(sampleDen()) })).status, "weekend");
  const off = await runPleginReport({ ...env, PLEGIN_REPORT: "off" }, { datum: "2026-10-27", source: "manual", loadDen: loadDen(sampleDen()) });
  assert.deepEqual([off.ok, off.status], [false, "disabled"]);
  const noToken = await runPleginReport({ ...env, PLEGIN_REPORT_TOKEN: "" }, { datum: "2026-10-27", source: "manual", loadDen: loadDen(sampleDen()) });
  assert.match(noToken.error, /PLEGIN_REPORT_TOKEN/);
  const dry = await runPleginReport({ ...env, PLEGIN_REPORT_TOKEN: "" }, { datum: "2026-10-27", source: "manual", dry: true, loadDen: loadDen(sampleDen()) });
  assert.equal(dry.status, "dry");
  assert.equal(dry.report.key, "akcie");
  assert.equal(calls.length, 0);
});

test("běh: 4xx z PLEGINu se neopakuje, 5xx se zkusí třikrát; chyba je v KV", async () => {
  const unauthorized = fakeEnv({ status: 401, body: { error: "Invalid report token." } });
  const res = await runPleginReport(unauthorized.env, { datum: "2026-10-27", source: "backup", loadDen: loadDen(sampleDen()), retryDelaysMs: [0, 0] });
  assert.deepEqual([res.ok, res.status], [false, "error"]);
  assert.match(res.error, /PLEGIN 401/);
  assert.equal(unauthorized.calls.length, 1);
  assert.equal(status(unauthorized.kv, "2026-10-27").status, "error");

  const down = fakeEnv({ status: 503, body: { error: "down" } });
  await runPleginReport(down.env, { datum: "2026-10-27", source: "backup", loadDen: loadDen(sampleDen()), retryDelaysMs: [0, 0] });
  assert.equal(down.calls.length, 3);
});

test("ruční běh: bez tokenu 401, špatný token 401, špatné datum 400", async () => {
  const env = { REPORT_RUN_TOKEN: "spravny-token" };
  const req = (auth, body) =>
    new Request("https://akcie-tracker/api/plegin-report/run?dry=1", {
      method: "POST",
      headers: auth ? { Authorization: `Bearer ${auth}` } : {},
      body,
    });
  assert.equal((await runEndpoint(req(null, "{}"), env)).status, 401);
  assert.equal((await runEndpoint(req("spatny-token", "{}"), env)).status, 401);
  assert.equal((await runEndpoint(req("spravny-token", "{}"), {})).status, 401); // bez secretu zavřeno
  assert.equal((await runEndpoint(req("spravny-token", '{"date":"2026-13-01"}'), env)).status, 400);
  assert.equal((await runEndpoint(req("spravny-token", '{"date":"2099-01-01"}'), env)).status, 400);
  assert.equal((await runEndpoint(req("spravny-token", "není json"), env)).status, 400);
});

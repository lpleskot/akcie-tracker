/**
 * Ranní report „Akcie" do PLEGINu (pohled Daily reports) — PLEGIN_ZADANI_01.
 * Nahrazuje Claude úlohu „PLEGIN — report Akcie": čísla bere z nástroje
 * akcie_den za včerejšek (stejný výpočet jako MCP a appka), report skládá
 * šablonou — krátké názvy z pevné mapy, Kontext z šablonových vět, žádné AI.
 *
 * Kdy (orchestrace v index.js):
 * - hned po ranním importu z IBKR. Když import ještě nemá data za včerejšek
 *   (IBKR je v 5:00 UTC občas nemá — 22. a 27. 10. 2026), report počká;
 * - pojistka út–so v 7:20 Prahy: když report ještě neodešel, zkusí import
 *   znovu a report pošle i s varováním o nečerstvých datech;
 * - ruční běh pro hlídač PLEGINu: POST /api/plegin-report/run.
 * Den bez obchodování (víkend, svátek) se nehlásí.
 *
 * Kam: service binding PLEGIN → Worker `todo` (stejný CF účet — HTTPS mezi
 * Workery jednoho účtu Cloudflare nepustí, chyba 1042), cesta
 * /mcp/api/reports s tokenem PLEGIN_REPORT_TOKEN, který smí jen report
 * `akcie` (zadání 13 v PLEGINu). Stejný key + report_date se přepíše.
 *
 * Stav dne je v KV `plegin-report:<datum>` (sent / holiday / stale / error),
 * podle něj pojistka pozná, že report už odešel; GET /api/plegin-report/status.
 */

import { fmtNum } from "../../assets/js/fifo.js";
import { addDays, pragueToday, runAkcieDen } from "../mcp/akcie-den.js";

const APP_ORIGIN = "https://akcie-tracker.lukas-pleskot.workers.dev";
const PLEGIN_REPORTS_URL = "https://todo.lukas-pleskot.workers.dev/mcp/api/reports";
const POST_TIMEOUT_MS = 15000;
const RETRY_DELAYS_MS = [1000, 3000];

const STATUS_PREFIX = "plegin-report:";
const STATUS_TTL_S = 60 * 86400;

const REPORT = { key: "akcie", name: "Akcie", icon: "📈", color: "#16a34a" };

const ACCOUNT_LABELS = { "plegi-invest-ibkr": "IBKR", "plegi-invest-kb": "KB" };

// Titul v tabulkách = „<symbol> · <krátký název>" — tvary schválené Lukášem
// v reportech Claude úlohy (do 28. 10. 2026), bez Inc/Corp/ADR. Obsahuje
// i dřív držené tituly obou účtů, kdyby se k nim portfolio vrátilo.
// Neznámý ticker dostane název z dat — doplnit ho sem.
export const SHORT_NAMES = {
  ACN: "Accenture",
  ADBE: "Adobe",
  AMBP: "Ardagh Metal Packaging",
  AMD: "AMD",
  AMZN: "Amazon",
  APH: "Amphenol",
  AXTI: "AXT",
  BABA: "Alibaba",
  BKNG: "Booking",
  CEDER: "Cedergrenska",
  CELH: "Celsius",
  "CNE.TO": "Canacol Energy",
  "CRST.L": "Crest Nicholson",
  CSG: "Czechoslovak Group",
  CSU: "Constellation Software",
  CVS: "CVS Health",
  DIS: "Disney",
  DKNG: "DraftKings",
  "DNP.WA": "Dino Polska",
  DSY: "Dassault Systèmes",
  DUOL: "Duolingo",
  EEFT: "Euronet",
  EVO: "Evolution",
  "EVO.ST": "Evolution",
  "FILA.MI": "Fila",
  GOOG: "Alphabet",
  GRPN: "Groupon",
  HUYA: "Huya",
  INTC: "Intel",
  "IPO.TO": "InPlay Oil",
  "KOMB.PR": "Komerční banka",
  KSPI: "Kaspi.kz",
  LMT: "Lockheed Martin",
  "LNF.TO": "Leon's Furniture",
  "MC.PA": "LVMH",
  META: "Meta",
  MSTR: "Strategy",
  NET: "Cloudflare",
  NFLX: "Netflix",
  NKE: "Nike",
  NOV: "Novo Nordisk",
  "NOV.DE": "Novo Nordisk",
  NOW: "ServiceNow",
  NU: "Nu Holdings",
  ON: "onsemi",
  OUST: "Ouster",
  "P911.DE": "Porsche",
  "PKN.WA": "Orlen",
  PLUG: "Plug Power",
  "PRX.AS": "Prosus",
  "PXT.TO": "Parex Resources",
  PYPL: "PayPal",
  QCOM: "Qualcomm",
  RCAT: "Red Cat",
  RDDT: "Reddit",
  RICK: "RCI Hospitality",
  S: "SentinelOne",
  SEDG: "SolarEdge",
  SMSI: "Smith Micro",
  "SMSN.IL": "Samsung",
  SOFI: "SoFi",
  SPCE: "Virgin Galactic",
  SPCX: "SpaceX",
  TDOC: "Teladoc",
  TTD: "The Trade Desk",
  "UMT.DE": "United Mobility Technology",
  UNH: "UnitedHealth",
  UPST: "Upstart",
  "URW.AS": "Unibail-Rodamco-Westfield",
  "VNA.DE": "Vonovia",
  WBD: "Warner Bros. Discovery",
  "YAL.AX": "Yancoal",
};

const STALE_SENTENCE = "Data IBKR můžou být o den pozadu (ranní import z IBKR neproběhl).";
const NOT_TRADED_SENTENCE =
  "Tituly s datem v závorce ten den neobchodovaly, změna je z jejich posledního obchodního dne.";

// ---------- Čísla a data česky ----------

const NBSP = "\u00a0";
const MINUS = "\u2212";
const NDASH = "\u2013";
const DNY = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];

// Číslice dává fmtNum (cs-CZ: NBSP mezi tisíci, desetinná čárka), znaménko
// a jednotku formát PLEGINu: pravé mínus (cs-CZ má spojovník), NBSP před Kč a %.
// Nula (i zaokrouhlená −0,004) je bez znaménka.
const withSign = (x, body) => (x > 0 ? `+${body}` : x < 0 ? `${MINUS}${body}` : body);

export function kc(x, { signed = true } = {}) {
  if (x == null || !Number.isFinite(x)) return NDASH;
  const r = Math.round(x);
  const body = `${fmtNum(Math.abs(r), 0)}${NBSP}Kč`;
  return signed ? withSign(r, body) : r < 0 ? `${MINUS}${body}` : body;
}

export function pct(x) {
  if (x == null || !Number.isFinite(x)) return NDASH;
  const r = Math.round(x * 100) / 100;
  return withSign(r, `${fmtNum(Math.abs(r), 2)}${NBSP}%`);
}

function amount(x) {
  const r = Math.round(x);
  return `${r < 0 ? MINUS : ""}${fmtNum(Math.abs(r), 0)}`;
}

const parts = (iso) => iso.split("-").map(Number);
const dm = (iso) => {
  const [, m, d] = parts(iso);
  return `${d}.${NBSP}${m}.`;
};
const dmy = (iso) => `${dm(iso)}${NBSP}${parts(iso)[0]}`;
const weekday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

export function isWeekend(iso) {
  const d = weekday(iso);
  return d === 0 || d === 6;
}

// Barva dlaždice podle denní změny v %: ≥ 0 ok, pokles do −1 % warn, pod −1 % bad
export function tone(p) {
  if (p == null) return undefined;
  return p >= 0 ? "ok" : p >= -1 ? "warn" : "bad";
}

// ---------- Rozhodnutí o dni (čisté funkce) ----------

/**
 * „obchodni" / „svatek" (žádná oceněná pozice ten den neobchodovala) /
 * „bez-cen" (žádná pozice nemá cenu — výpadek Yahoo, ne svátek; report se
 * neposílá a pojistka nebo hlídač to zkusí znovu).
 */
export function tradingDay(den) {
  const priced = den.portfolia.flatMap((p) => p.pozice).filter((p) => !p.cena_chybi);
  if (!priced.length) return "bez-cen";
  return priced.some((p) => p.obchodovano) ? "obchodni" : "svatek";
}

/**
 * Čerstvý import = IBKR NAV už má den reportu a import proběhl až po něm
 * (v pražském kalendáři). Pro běžné ráno je to pravidlo přílohy zadání
 * („last_import z dnešního rána a nav_do = DATUM"), u ručního běhu za starší
 * den nehlásí nečerstvá data, když import den mezitím pokryl.
 */
export function isImportFresh(overlay, datum) {
  if (!overlay?.nav_do || overlay.nav_do < datum || !overlay.last_import) return false;
  const imported = new Date(overlay.last_import);
  return !Number.isNaN(imported.getTime()) && pragueToday(imported) > datum;
}

// Pojistka má dva UTC časy (léto/zima) — pustí se jen ten, kdy je v Praze 7:xx
export function isBackupHour(now) {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Prague",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(now);
  return Number(hour) === 7;
}

// ---------- Sestavení reportu (čistá funkce) ----------

function shortName(symbol, nazev) {
  return SHORT_NAMES[symbol] || nazev || symbol;
}

const titul = (p) => `${p.symbol} · ${shortName(p.symbol, p.nazev)}`;

function joinCs(items) {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} a ${items.at(-1)}`;
}

function denCell(p) {
  if (p.cena_chybi) return p.duvod ? `${NDASH} (${p.duvod})` : NDASH;
  const zmena = pct(p.den?.zmena_pct);
  if (p.obchodovano || !p.obchodni_den) return zmena;
  return `${zmena} (${dm(p.obchodni_den)})`;
}

function positionRow(p) {
  const tr = p.total_return;
  const star = tr && tr.div_stejna_mena === false ? `${NBSP}*` : "";
  return [titul(p), denCell(p), tr ? `${pct(tr.pct)}${star}` : NDASH, kc(tr?.czk)];
}

function dayTile(label, den) {
  return { label, value: kc(den.zmena_czk), sub: pct(den.zmena_pct), tone: tone(den.zmena_pct) };
}

function cashTile(acc) {
  const tile = { label: `Volná hotovost ${acc.label}`, value: kc(acc.p.cash_czk, { signed: false }) };
  // Víc měn → pod hodnotou jen největší cizí měna (podle hodnoty v Kč)
  const meny = acc.p.cash_meny || [];
  if (meny.length > 1) {
    const top = meny
      .filter((m) => m.mena !== "CZK" && m.czk != null)
      .sort((a, b) => Math.abs(b.czk) - Math.abs(a.czk))[0];
    if (top) tile.sub = `+${NBSP}${top.mena}${NBSP}${amount(top.castka)}`;
  }
  return tile;
}

function extremeTile(label, ext, den, best) {
  if (!ext) return null;
  const p = den.portfolia.find((x) => x.id === ext.portfolio)?.pozice.find((x) => x.symbol === ext.symbol);
  const t = best ? (ext.zmena_pct >= 0 ? "ok" : tone(ext.zmena_pct)) : ext.zmena_pct < 0 ? "bad" : "ok";
  return { label, value: pct(ext.zmena_pct), sub: `${ext.symbol} · ${shortName(ext.symbol, p?.nazev)}`, tone: t };
}

// Tituly, které den v účtu nejvíc posunuly (Kč), jen obchodované
function movers(p) {
  const traded = p.pozice.filter((x) => x.obchodovano && x.den?.zmena_czk);
  return {
    ups: traded.filter((x) => x.den.zmena_czk > 0).sort((a, b) => b.den.zmena_czk - a.den.zmena_czk),
    downs: traded.filter((x) => x.den.zmena_czk < 0).sort((a, b) => a.den.zmena_czk - b.den.zmena_czk),
  };
}

const moverList = (list) => joinCs(list.map((x) => `${titul(x)} (${kc(x.den.zmena_czk)})`));

function moverClauses(acc, dir, nMain, nOpp) {
  const { ups, downs } = movers(acc.p);
  const main = (dir > 0 ? ups : downs).slice(0, nMain);
  const opp = (dir > 0 ? downs : ups).slice(0, nOpp);
  let s = main.length ? ` ${dir > 0 ? "díky" : "kvůli"} ${moverList(main)}` : "";
  if (opp.length) s += `${main.length ? ";" : ":"} proti ${opp.length === 1 ? "šla" : "šly"} ${moverList(opp)}`;
  return s;
}

// Kontext: 1. věta = účet, který den nejvíc táhl směrem celkové změny, a jeho
// hlavní tituly; 2. věta = druhý účet. Pak jen potřebná vysvětlení.
function contextBody(den, accounts, fresh) {
  const paragraphs = [];
  const total = den.vse.den.zmena_czk || 0;
  const dir = total >= 0 ? 1 : -1;
  const ordered = [...accounts].sort((a, b) => dir * ((b.p.den.zmena_czk || 0) - (a.p.den.zmena_czk || 0)));
  const sentences = ordered.map((acc, i) => {
    const change = acc.p.den.zmena_czk || 0;
    if (i === 0) {
      return `Den táhl ${dir > 0 ? "nahoru" : "dolů"} hlavně účet ${acc.label} (${kc(change)})${moverClauses(acc, dir, 3, 2)}.`;
    }
    if (!acc.p.den.obchodovalo) return `V účtu ${acc.label} ten den burzy neobchodovaly.`;
    const d = change >= 0 ? 1 : -1;
    const head =
      change > 0
        ? `Účet ${acc.label} přidal ${kc(change, { signed: false })}`
        : change < 0
          ? `Účet ${acc.label} ztratil ${kc(-change, { signed: false })}`
          : `Účet ${acc.label} skončil beze změny`;
    return `${head}${moverClauses(acc, d, 2, 1)}.`;
  });
  paragraphs.push(sentences.join(" "));

  const all = den.portfolia.flatMap((p) => p.pozice);
  if (all.some((p) => !p.cena_chybi && !p.obchodovano)) paragraphs.push(NOT_TRADED_SENTENCE);

  const starred = [...new Map(
    all.filter((p) => p.total_return?.div_stejna_mena === false).map((p) => [p.symbol, titul(p)]),
  ).values()];
  if (starred.length === 1) {
    paragraphs.push(`\\* ${starred[0]} vyplácí dividendy v jiné měně, Total Return je jen kapitálový.`);
  } else if (starred.length > 1) {
    paragraphs.push(`\\* ${joinCs(starred)} vyplácejí dividendy v jiné měně, Total Return je u nich jen kapitálový.`);
  }

  for (const acc of accounts) {
    if (acc.p.cash_denni) continue;
    let sentence = `Hotovost ${acc.label} je poslední známý zůstatek z evidence.`;
    if (acc.p.cash_odhad) {
      sentence = `Hotovost ${acc.label} je odhad k ${dmy(acc.p.cash_k)}: ${acc.p.cash_zdroj}.`;
    } else if (acc.p.cash_k) {
      sentence = `Hotovost ${acc.label} je ze čtvrtletního výpisu k ${dmy(acc.p.cash_k)}.`;
    }
    paragraphs.push(sentence);
  }
  paragraphs.push(...(den.varovani || []));
  if (!fresh) paragraphs.push(STALE_SENTENCE);
  return paragraphs.join("\n\n");
}

/**
 * Report pro POST /api/reports PLEGINu z výstupu akcie_den (portfolio vse).
 * Struktura podle přílohy zadání 01: 7 dlaždic bez hodnot portfolia, tabulka
 * pozic za každý účet, Kontext, odkaz do appky.
 */
export function buildPleginReport(den) {
  const datum = den.datum;
  const fresh = isImportFresh(den.overlay, datum);
  const accounts = den.portfolia.map((p) => ({ p, label: ACCOUNT_LABELS[p.id] || p.nazev || p.id }));
  const { nejlepsi, nejhorsi } = den.vse;

  const summary = [
    `${kc(den.vse.den.zmena_czk)} (${pct(den.vse.den.zmena_pct)})`,
    ...accounts.map((a) => `${a.label} ${kc(a.p.den.zmena_czk)}`),
    [
      nejlepsi && `nejlepší ${nejlepsi.symbol} ${pct(nejlepsi.zmena_pct)}`,
      nejhorsi && `nejhorší ${nejhorsi.symbol} ${pct(nejhorsi.zmena_pct)}`,
    ].filter(Boolean).join(", "),
  ].filter(Boolean).join(" · ");

  const sections = [
    {
      type: "stats",
      items: [
        dayTile("Portfolio za den", den.vse.den),
        ...accounts.map((a) => dayTile(`${a.label} za den`, a.p.den)),
        ...accounts.map(cashTile),
        extremeTile("Nejlepší", nejlepsi, den, true),
        extremeTile("Nejhorší", nejhorsi, den, false),
      ].filter(Boolean),
    },
    ...accounts.map((a) => ({
      type: "table",
      title: `${a.label} ${NDASH} pozice (${a.p.pozice.length})`,
      columns: ["Titul", "Den %", "Total Return %", "Total Return Kč"],
      rows: a.p.pozice.map(positionRow),
    })),
    { type: "text", title: "Kontext", body: contextBody(den, accounts, fresh) },
    // Pevná adresa appky, ne den.odkaz — ten nese hostitele, přes kterého běh
    // přišel (service binding hlídače, lokální wrangler dev)
    { type: "list", title: "Detail", items: [{ title: "Otevřít akcie-tracker", link: `${APP_ORIGIN}/` }] },
  ];

  return {
    ...REPORT,
    report_date: datum,
    title: `Akcie ${NDASH} ${DNY[weekday(datum)]} ${dm(datum)}`,
    summary: summary.slice(0, 200),
    sections,
  };
}

// ---------- Běh: data → report → PLEGIN ----------

function disabledReason(env) {
  if (env.PLEGIN_REPORT === "off") return "report je vypnutý (PLEGIN_REPORT = off)";
  if (!env.PLEGIN_REPORT_TOKEN) return "chybí secret PLEGIN_REPORT_TOKEN";
  return null;
}

export const reportEnabled = (env) => !disabledReason(env);

export async function readReportStatus(env, datum) {
  return env.AKCIE_TRACKER_KV.get(`${STATUS_PREFIX}${datum}`, "json");
}

async function saveStatus(env, datum, status) {
  const value = { ...status, at: new Date().toISOString() };
  // Stav i v metadata — přehled /status ho přečte jedním list() bez get() na každý den
  await env.AKCIE_TRACKER_KV.put(`${STATUS_PREFIX}${datum}`, JSON.stringify(value), {
    metadata: value,
    expirationTtl: STATUS_TTL_S,
  });
}

export async function listReportStatuses(env) {
  const { keys } = await env.AKCIE_TRACKER_KV.list({ prefix: STATUS_PREFIX });
  return keys
    .map((k) => ({ datum: k.name.slice(STATUS_PREFIX.length), ...(k.metadata || {}) }))
    .sort((a, b) => b.datum.localeCompare(a.datum));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Opakuje jen síť a 5xx; 4xx (token, validace) se opakováním nespraví
async function postReport(env, report, retryDelaysMs) {
  if (!env.PLEGIN) throw new Error("chybí service binding PLEGIN (Worker todo) – viz wrangler.toml");
  let lastError;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt) await sleep(retryDelaysMs[attempt - 1]);
    try {
      const res = await env.PLEGIN.fetch(PLEGIN_REPORTS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.PLEGIN_REPORT_TOKEN}`,
        },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      lastError = new Error(`PLEGIN ${res.status}: ${text.slice(0, 200)}`);
      if (res.status < 500) break;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/**
 * Jeden běh reportu za den `datum` (výchozí včera, Europe/Prague).
 * source: "import" (po ranním importu — při nečerstvých datech jen zapíše
 * stale a nechá report pojistce), "backup", "manual". dry = jen sestavit
 * a vrátit, nic neposlat ani nezapsat. Nikdy nehází — výsledek nese
 * ok/status/error a neúspěch je zapsaný v KV pro pojistku a /status.
 * loadDen a retryDelaysMs mění jen testy (data bez sítě, opakování bez čekání).
 */
export async function runPleginReport(
  env,
  { datum, source, dry = false, now = new Date(), loadDen = runAkcieDen, retryDelaysMs = RETRY_DELAYS_MS } = {},
) {
  const day = datum || addDays(pragueToday(now), -1);
  const base = { datum: day, source, dry };
  const done = (result) => {
    const line = `📈 PLEGIN report ${day} (${source}${dry ? ", dry" : ""}): ${result.status}`;
    if (result.ok) console.log(line);
    else console.error(`${line} – ${result.error}`);
    return { ...base, ...result };
  };

  if (isWeekend(day)) return done({ ok: true, status: "weekend" });
  const off = dry ? null : disabledReason(env);
  if (off) return done({ ok: false, status: "disabled", error: off });

  try {
    // Automatické běhy neposílají podruhé; ruční běh (hlídač) report přepíše
    if (!dry && source !== "manual") {
      const prev = await readReportStatus(env, day);
      if (prev?.status === "sent" || prev?.status === "holiday") {
        return done({ ok: true, status: "skipped", previous: prev.status });
      }
    }

    const den = await loadDen(env, { datum: day }, { origin: APP_ORIGIN, now });
    const trading = tradingDay(den);
    if (trading === "bez-cen") throw new Error("žádná pozice nemá cenu z Yahoo");
    if (trading === "svatek") {
      if (!dry) await saveStatus(env, day, { status: "holiday", source });
      return done({ ok: true, status: "holiday" });
    }
    const fresh = isImportFresh(den.overlay, day);
    if (source === "import" && !fresh && !dry) {
      await saveStatus(env, day, { status: "stale", source, overlay: den.overlay });
      return done({ ok: true, status: "stale", fresh });
    }
    const report = buildPleginReport(den);
    if (dry) return done({ ok: true, status: "dry", fresh, report });

    const res = await postReport(env, report, retryDelaysMs);
    await saveStatus(env, day, { status: "sent", source, fresh, created: res?.created ?? null });
    return done({ ok: true, status: "sent", fresh, created: res?.created ?? null });
  } catch (e) {
    const error = String(e?.message || e).slice(0, 300);
    if (!dry) {
      await saveStatus(env, day, { status: "error", source, error }).catch((err) =>
        console.error(`PLEGIN report ${day}: stav se nezapsal – ${err?.message || err}`),
      );
    }
    return done({ ok: false, status: "error", error });
  }
}

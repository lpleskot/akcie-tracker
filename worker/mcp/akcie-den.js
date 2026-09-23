/**
 * MCP nástroj akcie_den — stav portfolií k závěru obchodního dne pro denní
 * report v PLEGINu: denní změna každé držené pozice, její Total Return a
 * souhrn portfolia (hodnota, hotovost, denní změna, celkový výnos).
 *
 * Čísla musí sedět s appkou, proto se tu nic nepočítá po svém: merge overlay,
 * Total Return pozice, hotovost i Celkový výnos jsou sdílené funkce, které
 * používá i frontend (assets/js/portfolio-shared.js, fifo.js).
 *
 * Rozdíly proti obrazovce appky jsou záměrné a plynou z „k závěru dne":
 * - pozice podle DATA OBCHODU ≤ datum (ne podle vypořádání jako inventura) —
 *   nákup z 22. 9. s vypořádáním 23. 9. hýbe hodnotou už 22. 9.;
 * - ceny = uzavřené denní závěry burzy (ne živá cena), kurzy ČNB k datu;
 * - hotovost k datu (cashAtDate): IBKR denní NAV snapshot, KB kvartální
 *   snapshot ze STAV PTF — dlaždice v appce ukazuje cash_balance.
 */

import { computePositionsAt, positionTotalReturn, splitFactorAfter, cashAtDate } from "../../assets/js/fifo.js";
import {
  cashToCzk,
  fxDateFor,
  fxToCzk,
  mergeOverlayIntoPortfolio,
  portfolioTotalReturn,
} from "../../assets/js/portfolio-shared.js";
import { flexDate } from "../../assets/js/flex-shared.js";
import { fetchAssetJson, fetchYahooCloseAt } from "../api/lib.js";

export const AKCIE_DEN_TOOL = "akcie_den";

// Souběžných dotazů na Yahoo — KB má ~50 instrumentů, neposílat je najednou
const PRICE_CONCURRENCY = 8;

export async function toolDefinition(env) {
  const manifest = await fetchAssetJson(env, "/data/portfolios/manifest.json");
  return {
    name: AKCIE_DEN_TOOL,
    title: "Akcie — stav portfolia k závěru dne",
    description:
      "Stav akciových portfolií PLEGI invest k závěru obchodního dne. U každé držené " +
      "pozice denní změna (%, v měně, v Kč) a Total Return (realizovaná + nerealizovaná " +
      "Z/Z + čisté dividendy, v % z investice); za portfolio hodnota pozic, hotovost, " +
      "denní změna a celkový výnos od založení. Čísla odpovídají appce akcie-tracker. " +
      "Ceny jsou uzavřené denní závěry burzy; obchodovano=false znamená, že burza ten den " +
      "neobchodovala a denní změna pozice se do souhrnu nepočítá. Vrací JSON.",
    inputSchema: {
      type: "object",
      properties: {
        datum: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Den ocenění YYYY-MM-DD. Výchozí: včera (Europe/Prague).",
        },
        portfolio: {
          type: "string",
          enum: [...manifest.portfolios.map((p) => p.id), "vse"],
          default: "vse",
          description: "Které portfolio; vse = všechna.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  };
}

/**
 * Spuštění nástroje: načte data (ASSETS + KV overlay), ceny z Yahoo a sestaví
 * report. Chyby vstupu hází s textem pro model (server je vrátí jako isError).
 */
export async function runAkcieDen(env, args, { origin, now = new Date() } = {}) {
  const [manifest, fxRates] = await Promise.all([
    fetchAssetJson(env, "/data/portfolios/manifest.json"),
    fetchAssetJson(env, "/data/fx_rates.json"),
  ]);
  const today = pragueToday(now);
  const { datum, portfolioId } = parseArgs(args, manifest.portfolios.map((p) => p.id), today);

  const metas = manifest.portfolios.filter((m) => portfolioId === "vse" || m.id === portfolioId);
  const loaded = await Promise.all(metas.map((meta) => loadPortfolio(env, meta, fxRates)));
  for (const l of loaded) l.open = openPositionsAt(l.portfolio, datum);

  const symbols = [
    ...new Set(
      loaded.flatMap((l) =>
        l.open.filter((o) => !delistedAt(o.inst, datum)).map((o) => yahooSymbol(o)),
      ),
    ),
  ];
  const quotes = await fetchQuotesAt(symbols, datum);
  return buildAkcieDenReport({ datum, today, loaded, quotes, fxRates, origin });
}

async function loadPortfolio(env, meta, fxRates) {
  const [portfolio, overlay, history] = await Promise.all([
    fetchAssetJson(env, `/data/portfolios/${meta.file}`),
    env.AKCIE_TRACKER_KV.get(`portfolio-overlay:${meta.id}`, "json"),
    fetchAssetJson(env, `/data/portfolio-history-${meta.id}.json`, { optional: true }),
  ]);
  const stats = mergeOverlayIntoPortfolio(portfolio, overlay, fxRates);
  portfolio.static_nav_history = history?.nav_history || [];
  return { meta, portfolio, lastImport: stats.last_import };
}

async function fetchQuotesAt(symbols, datum) {
  const quotes = {};
  let next = 0;
  const worker = async () => {
    while (next < symbols.length) {
      const s = symbols[next++];
      try {
        quotes[s] = await fetchYahooCloseAt(s, datum);
      } catch (e) {
        quotes[s] = { error: String(e?.message || e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PRICE_CONCURRENCY, symbols.length) }, worker));
  return quotes;
}

// ---------- Čisté funkce (testované bez sítě) ----------

// Obchodní „dnes" je pražský den, ne UTC — mezi půlnocí a 1–2 h ráno
// pražského času je v UTC ještě předchozí den a „včera" by ujelo o den zpět.
export function pragueToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Prague",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isIsoDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function parseArgs(args, portfolioIds, today) {
  const a = args && typeof args === "object" ? args : {};
  const datum = a.datum == null || a.datum === "" ? addDays(today, -1) : a.datum;
  if (!isIsoDate(datum)) {
    throw new Error(`datum musí být skutečné datum ve tvaru YYYY-MM-DD (dostal jsem ${JSON.stringify(a.datum)}).`);
  }
  if (datum > today) {
    throw new Error(`datum ${datum} je v budoucnosti — závěr dne ještě neexistuje (dnes je ${today}).`);
  }
  const portfolioId = a.portfolio == null || a.portfolio === "" ? "vse" : a.portfolio;
  if (portfolioId !== "vse" && !portfolioIds.includes(portfolioId)) {
    throw new Error(`Neznámé portfolio ${JSON.stringify(portfolioId)} — povolené: ${[...portfolioIds, "vse"].join(", ")}.`);
  }
  return { datum, portfolioId };
}

/**
 * Pozice držené při závěru dne: rozhoduje datum obchodu, dividendy a daně
 * do FIFO k datu (Total Return pozice je potřebuje).
 */
export function openPositionsAt(portfolio, datum) {
  const positions = computePositionsAt(
    portfolio.transactions || [],
    portfolio.corporate_actions || [],
    datum,
    {
      dateField: "date",
      dividends: portfolio.dividends || [],
      withholdingTax: portfolio.withholding_tax || [],
    },
  );
  return Object.keys(positions)
    .sort()
    .filter((sym) => positions[sym].net_qty > 1e-9)
    .map((sym) => ({ sym, pos: positions[sym], inst: portfolio.instruments?.[sym] || {} }));
}

function delistedAt(inst, datum) {
  return inst.delisted && inst.delisted <= datum ? inst.delisted : null;
}

function yahooSymbol(o) {
  return o.inst.yahoo_symbol || o.sym;
}

const round = (x, d) =>
  x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;

/**
 * Sestaví odpověď nástroje z načtených portfolií, cen a kurzů. Součty se
 * sčítají v Kč z nezaokrouhlených hodnot; zaokrouhluje se až výstup
 * (Kč celé, % na 2 místa, ceny na 4, částky v měně na 2).
 */
export function buildAkcieDenReport({ datum, today, loaded, quotes, fxRates, origin }) {
  const varovani = [];
  const fxCache = new Map();
  const fxFor = (ccy) => {
    if (!ccy) return null;
    if (!fxCache.has(ccy)) fxCache.set(ccy, fxToCzk(fxRates, datum, ccy, { allowFallback: true }));
    return fxCache.get(ccy);
  };
  const usdToCzk = fxFor("USD");
  const currencies = new Set(["USD"]);

  const portfolia = [];
  const sum = { pozice: 0, cash: 0, zmena: 0, obchodovalo: 0, neobchodovalo: 0, chybi: 0, usd: 0, vklady: 0, usdOk: true };
  const traded = [];
  let lastImport = null;
  let navDo = null;

  for (const { meta, portfolio, open, lastImport: li } of loaded) {
    if (li && (!lastImport || li > lastImport)) lastImport = li;
    const nd = latestNavDate(portfolio);
    if (nd && (!navDo || nd > navDo)) navDo = nd;

    const rows = open.map((o) => positionRow(o, portfolio, datum, quotes, fxFor, varovani));
    rows.forEach((r) => r.mena && currencies.add(r.mena));

    // Souhrn pozic — denní změna jen z titulů, které ten den obchodovaly
    let pozice = 0, zmena = 0, obchodovalo = 0, neobchodovalo = 0, chybi = 0;
    for (const r of rows) {
      if (r.cenaChybi) chybi++;
      else if (r.obchodovano) obchodovalo++;
      else neobchodovalo++;
      if (!r.cenaChybi && r.valueCzk != null) pozice += r.valueCzk;
      if (r.obchodovano && r.den?.czk != null) {
        zmena += r.den.czk;
        traded.push({ symbol: r.symbol, portfolio: meta.id, pct: r.den.pct });
      }
    }

    // Hotovost k datu; bez snapshotu k datu poslední známý zůstatek (jako dlaždice)
    const c = cashAtDate(portfolio, datum);
    const cashMap = c ? c.cash : portfolio.cash_balance || {};
    Object.keys(cashMap).forEach((ccy) => currencies.add(ccy));
    const cash = cashToCzk(cashMap, fxRates, datum, { allowFallback: true });
    if (cash.missing.length) {
      varovani.push(`${meta.id}: hotovost v ${cash.missing.join(", ")} bez kurzu ČNB — není v součtu.`);
    }
    const celkem = pozice + cash.czk;

    // Celkový výnos od založení — vzorec dlaždice, jen k datu
    let vynos = null;
    if (usdToCzk && portfolio.inception_date) {
      const ret = portfolioTotalReturn({
        assetsUsd: celkem / usdToCzk,
        totalDepositsUsd: portfolio.total_deposits_usd,
        inceptionDate: portfolio.inception_date,
        asOf: datum,
        usdToCzk,
      });
      vynos = { ...ret, vklady: portfolio.total_deposits_usd || 0 };
      sum.usd += ret.usd;
      sum.vklady += vynos.vklady;
    } else {
      sum.usdOk = false;
    }

    const portTraded = traded.filter((t) => t.portfolio === meta.id);
    portfolia.push({
      id: meta.id,
      nazev: meta.name || portfolio.name || meta.id,
      hodnota_pozic_czk: round(pozice, 0),
      cash_czk: round(cash.czk, 0),
      hodnota_celkem_czk: round(celkem, 0),
      cash_k: c ? c.asOf : null,
      cash_denni: c ? c.daily : false,
      cash_zdroj: c ? c.source : "cash_balance — poslední známý zůstatek z evidence, ne k datu",
      den: denOut(zmena, pozice, obchodovalo, neobchodovalo, chybi),
      celkovy_vynos: vynos && {
        pct: round(vynos.pct, 2),
        czk: round(vynos.czk, 0),
        usd: round(vynos.usd, 0),
        pa_pct: round(vynos.paPct, 2),
        od: portfolio.inception_date,
        vklady_usd: round(vynos.vklady, 0),
      },
      nejlepsi: extreme(portTraded, 1, false),
      nejhorsi: extreme(portTraded, -1, false),
      pozice: rows.sort(byDayChangeDesc).map(rowOut),
    });

    sum.pozice += pozice;
    sum.cash += cash.czk;
    sum.zmena += zmena;
    sum.obchodovalo += obchodovalo;
    sum.neobchodovalo += neobchodovalo;
    sum.chybi += chybi;
  }

  if (datum === today) {
    varovani.push("datum je dnešek — závěrečné ceny burz, které ještě obchodují, nemusí být finální.");
  }

  // vse = součet v Kč (nikdy ne přes různé měny); výnos = Σ USD / Σ vkladů
  const vseVynos =
    sum.usdOk && sum.vklady > 0
      ? {
          pct: round((sum.usd / sum.vklady) * 100, 2),
          czk: round(sum.usd * usdToCzk, 0),
          usd: round(sum.usd, 0),
          vklady_usd: round(sum.vklady, 0),
        }
      : null;

  const fxDate = fxDateFor(fxRates, datum);
  const fx = { datum: fxDate, platny_k: fxRates?.dates?.[fxDate]?.valid_for || null };
  for (const ccy of [...currencies].sort()) {
    if (ccy !== "CZK") fx[ccy] = round(fxFor(ccy), 4);
  }

  return {
    datum,
    fx,
    portfolia,
    vse: {
      hodnota_pozic_czk: round(sum.pozice, 0),
      cash_czk: round(sum.cash, 0),
      hodnota_celkem_czk: round(sum.pozice + sum.cash, 0),
      den: denOut(sum.zmena, sum.pozice, sum.obchodovalo, sum.neobchodovalo, sum.chybi),
      celkovy_vynos: vseVynos,
      nejlepsi: extreme(traded, 1, true),
      nejhorsi: extreme(traded, -1, true),
    },
    overlay: { last_import: lastImport, nav_do: navDo },
    varovani,
    odkaz: origin ? `${origin}/` : null,
  };
}

function positionRow({ sym, pos, inst }, portfolio, datum, quotes, fxFor, varovani) {
  const mena = inst.currency || null;
  const fx = fxFor(mena);
  if (mena && fx == null) varovani.push(`${sym}: chybí kurz ČNB ${mena} — hodnota v Kč se nesčítá.`);
  const base = { symbol: sym, nazev: inst.name || sym, mena, ks: pos.net_qty, fx };

  // Delisted: appka titul oceňuje nulou, Total Return tak sedí s přehledem
  const delisted = delistedAt(inst, datum);
  if (delisted) {
    return {
      ...base, obchodniDen: null, obchodovano: false, close: 0, prev: null,
      value: 0, valueCzk: 0, den: null,
      tr: trFor(pos, mena, 0, fx), cenaChybi: true, duvod: `staženo z burzy ${delisted}, oceněno 0`,
    };
  }

  const q = quotes[yahooSymbol({ sym, inst })];
  if (!q || q.error || q.close == null) {
    return {
      ...base, obchodniDen: null, obchodovano: false, close: null, prev: null,
      value: null, valueCzk: null, den: null, tr: null, cenaChybi: true,
      duvod: q?.error ? `cena nedostupná (${q.error})` : "cena nedostupná",
    };
  }
  if (q.currency && mena && q.currency !== mena) {
    varovani.push(`${sym}: Yahoo vrací cenu v ${q.currency}, pozice je v ${mena}.`);
  }

  // Yahoo historie je split-adjusted — o splity PO datu zpět (jako inventura)
  const f = splitFactorAfter(portfolio.corporate_actions || [], sym, datum);
  const close = q.close * f;
  const prev = q.prev_close != null ? q.prev_close * f : null;
  const value = pos.net_qty * close;
  const den =
    prev != null && prev !== 0
      ? {
          pct: (close / prev - 1) * 100,
          mena: pos.net_qty * (close - prev),
          czk: fx != null ? pos.net_qty * (close - prev) * fx : null,
          obchodVDen: tradedOn(portfolio, sym, q.price_date),
        }
      : null;
  return {
    ...base,
    obchodniDen: q.price_date,
    obchodovano: q.price_date === datum,
    close,
    prev,
    value,
    valueCzk: fx != null ? value * fx : null,
    den,
    tr: trFor(pos, mena, close, fx),
    cenaChybi: false,
  };
}

function trFor(pos, mena, price, fx) {
  const tr = positionTotalReturn(pos, mena, price);
  return { mena: tr.totalPnl, czk: fx != null ? tr.totalPnl * fx : null, pct: tr.totalPct, divSameCcy: tr.divSameCcy };
}

function tradedOn(portfolio, sym, day) {
  return (portfolio.transactions || []).some(
    (t) => t.symbol === sym && t.date === day && (t.type === "BUY" || t.type === "SELL"),
  );
}

function latestNavDate(portfolio) {
  let max = null;
  for (const n of [...(portfolio.static_nav_history || []), ...(portfolio.nav_history || [])]) {
    const d = flexDate(n.reportDate);
    if (d && (!max || d > max)) max = d;
  }
  return max;
}

// Denní % z hodnoty pozic na začátku dne: u obchodovaných titulů předchozí
// závěr, u neobchodovaných jejich (nezměněná) hodnota = pozice − změna.
function denOut(zmena, pozice, obchodovalo, neobchodovalo, chybi) {
  const start = pozice - zmena;
  return {
    zmena_czk: round(zmena, 0),
    zmena_pct: start > 0 ? round((zmena / start) * 100, 2) : 0,
    obchodovalo,
    neobchodovalo,
    cena_chybi: chybi,
  };
}

function extreme(list, dir, withPortfolio) {
  let best = null;
  for (const t of list) {
    if (t.pct == null) continue;
    if (!best || (dir > 0 ? t.pct > best.pct : t.pct < best.pct)) best = t;
  }
  if (!best) return null;
  return withPortfolio
    ? { symbol: best.symbol, portfolio: best.portfolio, zmena_pct: round(best.pct, 2) }
    : { symbol: best.symbol, zmena_pct: round(best.pct, 2) };
}

function byDayChangeDesc(a, b) {
  const pa = a.den?.pct, pb = b.den?.pct;
  if (pa == null && pb == null) return a.symbol.localeCompare(b.symbol);
  if (pa == null) return 1;
  if (pb == null) return -1;
  return pb - pa || a.symbol.localeCompare(b.symbol);
}

function rowOut(r) {
  const out = {
    symbol: r.symbol,
    nazev: r.nazev,
    mena: r.mena,
    ks: round(r.ks, 4),
    obchodni_den: r.obchodniDen,
    obchodovano: r.obchodovano,
    close: round(r.close, 4),
    prev_close: round(r.prev, 4),
    hodnota_mena: round(r.value, 2),
    hodnota_czk: round(r.valueCzk, 0),
    den: r.den && {
      zmena_pct: round(r.den.pct, 2),
      zmena_mena: round(r.den.mena, 2),
      zmena_czk: round(r.den.czk, 0),
      obchod_v_den: r.den.obchodVDen,
    },
    total_return: r.tr && {
      mena: round(r.tr.mena, 2),
      czk: round(r.tr.czk, 0),
      pct: round(r.tr.pct, 2),
      div_stejna_mena: r.tr.divSameCcy,
    },
    cena_chybi: r.cenaChybi,
  };
  if (r.duvod) out.duvod = r.duvod;
  return out;
}

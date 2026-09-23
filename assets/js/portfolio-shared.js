/**
 * Sdílené výpočty nad portfoliem: kurzy ČNB, merge Flex overlay do statického
 * portfolia, hotovost v Kč a Celkový výnos portfolia.
 *
 * Importuje frontend (app.js — přehled, dlaždice, inventura), cron job alerts
 * i MCP konektor. Čísla konektoru musí sedět s appkou na korunu, a to jde jen
 * se stejným kódem — žádné paralelní kopie (REVIZE_REPORT.md R5/R6).
 *
 * Čisté funkce bez DOM a globálního stavu: kurzy se předávají parametrem
 * ve tvaru data/fx_rates.json — { dates: { "YYYY-MM-DD": { valid_for, rates } } }.
 */

import {
  ensureInstrument,
  isForexConversion,
  flexDate,
  transformFlexTrade,
  transformFlexDividend,
  transformFlexWithholding,
  transformFlexCashFlow,
  transformFlexCorpAction,
} from "./flex-shared.js";

/**
 * Kurz ČNB: CZK za 1 jednotku měny k datu. Bez `allowFallback` vrací null,
 * když den chybí — pro daňové výstupy se kurzy nevymýšlejí. S fallbackem
 * vezme poslední den PŘED datem (víkend, svátek, ještě nestažený den).
 */
export function fxToCzk(fxRates, date, currency, opts) {
  if (currency === "CZK") return 1;
  const dates = fxRates?.dates;
  if (!dates) return null;
  const r = dates[date]?.rates?.[currency];
  if (r) return r.rate / r.amount;
  if (!opts?.allowFallback) return null;
  const prev = Object.keys(dates).filter((d) => d < date).sort().pop();
  const rp = prev ? dates[prev]?.rates?.[currency] : null;
  return rp ? rp.rate / rp.amount : null;
}

/**
 * Den v kurzech, ze kterého fxToCzk s fallbackem skutečně čte: datum samo,
 * nebo poslední den před ním. Výstupy ho uvádějí vedle kurzu.
 */
export function fxDateFor(fxRates, date) {
  const dates = fxRates?.dates;
  if (!dates) return null;
  if (dates[date]) return date;
  return Object.keys(dates).filter((d) => d < date).sort().pop() || null;
}

/**
 * Částka v měně → USD přes CZK kurzy ČNB. Chybí-li kurz k datu, bere se
 * NEJNOVĚJŠÍ den v kurzech (ne poslední předchozí jako u fxToCzk) — takhle
 * se přepočítávají vklady z overlay do total_deposits_usd i toky kapitálu
 * v capitalFlowsUsd, aby oba součty vyšly stejně.
 */
export function amountToUsd(fxRates, amount, currency, date) {
  if (!Number.isFinite(amount)) return NaN;
  if (currency === "USD") return amount;
  const dates = fxRates?.dates;
  if (!dates) return NaN;
  const all = Object.keys(dates).sort();
  if (all.length === 0) return NaN;
  const useDate = date && dates[date] ? date : all[all.length - 1];
  const ccyToCzk = fxToCzk(fxRates, useDate, currency);
  const usdToCzk = fxToCzk(fxRates, useDate, "USD");
  if (!ccyToCzk || !usdToCzk) return NaN;
  return (amount * ccyToCzk) / usdToCzk;
}

/**
 * Mergne KV overlay (IBKR Flex auto-import) do načteného portfolia.
 * Overlay drží data z Flex Web Service v nativním tvaru; transformace do
 * tvaru statického JSON jsou ve flex-shared.js, tady je dedupe proti
 * existujícím `flex_id` a promítnutí do hotovosti a vkladů.
 *
 * `fxRates` slouží jen k přepočtu vkladů do total_deposits_usd — kdo
 * s vklady nepracuje (alerty), může předat null.
 *
 * Mutuje `portfolio`. Vrací počty NOVĚ přidaných záznamů + last_import.
 */
export function mergeOverlayIntoPortfolio(portfolio, overlay, fxRates) {
  overlay = overlay || {};
  const stats = {
    trades: 0,
    dividends: 0,
    withholding: 0,
    corp_actions: 0,
    cash_flows: 0,
    last_import: overlay.last_import || null,
  };

  portfolio.transactions = portfolio.transactions || [];
  portfolio.dividends = portfolio.dividends || [];
  portfolio.withholding_tax = portfolio.withholding_tax || [];
  portfolio.corporate_actions = portfolio.corporate_actions || [];
  portfolio.cash_flows = portfolio.cash_flows || [];
  portfolio.instruments = portfolio.instruments || {};
  portfolio.cash_balance = { ...(portfolio.cash_balance || {}) };

  // Denní NAV snapshoty z IBKR Flex — graf Hodnota portfolia a hotovost k datu
  portfolio.nav_history = overlay.nav_snapshot || [];

  const idsOf = (arr) => new Set(arr.map((x) => x.flex_id).filter(Boolean));
  const existingTradeIds = idsOf(portfolio.transactions);
  const existingDivIds = idsOf(portfolio.dividends);
  const existingWithholdingIds = idsOf(portfolio.withholding_tax);
  const existingCaIds = idsOf(portfolio.corporate_actions);
  const existingCfIds = idsOf(portfolio.cash_flows);

  // Statický cash_balance je zafixovaný snapshot k datu výpisu — přičítají
  // se k němu jen události z overlay, které ve statickém JSON ještě nejsou.
  const addCash = (ccy, amount) => {
    if (!ccy || !Number.isFinite(amount)) return;
    if (portfolio.cash_balance[ccy] == null) portfolio.cash_balance[ccy] = 0;
    portfolio.cash_balance[ccy] += amount;
  };

  // 1) Trades — dopad do hotovosti = netCash (signed, už po komisi)
  for (const t of overlay.trades || []) {
    if (!t.tradeID || existingTradeIds.has(t.tradeID)) continue;
    const symbol = t.symbol;
    if (!symbol) continue;

    // Forex konverze (IBKR mění měnu při nákupu titulu v cizí měně) NEJSOU
    // pozice: symbol je měnový pár "BASE.QUOTE". Obě nohy jdou jen do hotovosti:
    //   base měna  = symbol před tečkou, delta = quantity (signed)
    //   quote měna = t.currency, delta = netCash (signed, po komisi)
    if (isForexConversion(t)) {
      existingTradeIds.add(t.tradeID);
      const [baseCcy] = symbol.split(".");
      const qty = parseFloat(t.quantity);
      const netCash = parseFloat(t.netCash);
      if (Number.isFinite(qty)) addCash(baseCcy, qty);
      if (Number.isFinite(netCash)) addCash(t.currency, netCash);
      continue;
    }

    ensureInstrument(portfolio, symbol, t);
    portfolio.transactions.push(transformFlexTrade(t));
    existingTradeIds.add(t.tradeID);
    stats.trades++;
    const netCash = parseFloat(t.netCash);
    if (Number.isFinite(netCash)) addCash(t.currency, netCash);
  }

  // 2) Cash transactions → dividendy / srážková daň / ostatní cash flows
  for (const c of overlay.cash_transactions || []) {
    if (!c.transactionID) continue;
    const type = c.type || "";
    const amt = parseFloat(c.amount);
    if (/Dividends/i.test(type)) {
      if (existingDivIds.has(c.transactionID)) continue;
      ensureInstrument(portfolio, c.symbol, c);
      portfolio.dividends.push(transformFlexDividend(c));
      existingDivIds.add(c.transactionID);
      stats.dividends++;
      addCash(c.currency, amt);
    } else if (/Withholding/i.test(type)) {
      if (existingWithholdingIds.has(c.transactionID)) continue;
      portfolio.withholding_tax.push(transformFlexWithholding(c));
      existingWithholdingIds.add(c.transactionID);
      stats.withholding++;
      addCash(c.currency, amt); // amount je už záporný
    } else {
      // Deposits/Withdrawals, Other Fees, Broker Interest, …
      if (existingCfIds.has(c.transactionID)) continue;
      portfolio.cash_flows.push(transformFlexCashFlow(c));
      existingCfIds.add(c.transactionID);
      stats.cash_flows++;
      addCash(c.currency, amt);

      // Vklad zvedá hotovost (čitatel výnosu) — bez navýšení vkladů
      // (jmenovatel) by se Celkový výnos uměle nafoukl.
      if (/Deposits.*Withdrawals|Account Transfers|Internal Transfers/i.test(type)) {
        const date = flexDate(c.dateTime || c.reportDate);
        const usdAmt = amountToUsd(fxRates, amt, c.currency, date);
        if (Number.isFinite(usdAmt)) {
          portfolio.total_deposits_usd = (portfolio.total_deposits_usd || 0) + usdAmt;
        }
      }
    }
  }

  // 3) Corporate actions — některé mají hotovostní složku (cash-in-lieu)
  for (const a of overlay.corporate_actions || []) {
    if (!a.actionID || existingCaIds.has(a.actionID)) continue;
    ensureInstrument(portfolio, a.symbol, a);
    portfolio.corporate_actions.push(transformFlexCorpAction(a));
    existingCaIds.add(a.actionID);
    stats.corp_actions++;
    const proc = parseFloat(a.proceeds);
    if (Number.isFinite(proc) && proc !== 0) addCash(a.currency, proc);
  }

  return stats;
}

/**
 * Hotovost ve více měnách → CZK kurzem k datu. Měna bez kurzu se nesčítá
 * a vrátí se v `missing` — volající ji musí přiznat, ne tiše vynechat.
 */
export function cashToCzk(cash, fxRates, date, opts) {
  const items = [];
  const missing = [];
  let czk = 0;
  for (const currency of Object.keys(cash || {}).sort()) {
    const amount = cash[currency];
    if (amount == null) continue;
    const rate = fxToCzk(fxRates, date, currency, opts);
    if (rate == null) {
      missing.push(currency);
      continue;
    }
    czk += amount * rate;
    items.push({ currency, amount, rate, czk: amount * rate });
  }
  return { czk, items, missing };
}

const toMs = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

// Vklady a výběry v evidenci: statické JSON je vedou jako deposit/withdrawal,
// Flex overlay pod typy IBKR (stejný test jako vklady v mergeOverlayIntoPortfolio).
const CAPITAL_FLOW = /^(deposit|withdrawal)$|Deposits.*Withdrawals|Account Transfers|Internal Transfers/i;

/**
 * Toky kapitálu portfolia v USD (+ přišlo do portfolia, − odešlo) podle data:
 * počáteční kapitál, se kterým portfolio vstoupilo do evidence (opening_cash
 * + pozice se synthetic_opening, oceněné jako jejich cost basis), vklady
 * a výběry z cash_flows. Portfolio bez evidence toků spadne na
 * total_deposits_usd k datu založení. `upTo` odřízne toky po datu — výnos
 * k datu nesmí vidět pozdější vklady.
 */
export function capitalFlowsUsd(portfolio, fxRates, { upTo } = {}) {
  const flows = [];
  const add = (date, usd, kind) => {
    if (date && Number.isFinite(usd) && usd !== 0) flows.push({ date, usd, kind });
  };
  const oc = portfolio.opening_cash;
  for (const [ccy, amount] of Object.entries(oc?.balances || {})) {
    add(oc.date, amountToUsd(fxRates, amount, ccy, oc.date), "opening");
  }
  for (const t of portfolio.transactions || []) {
    if (!t.synthetic_opening) continue;
    const value = t.proceeds != null ? Math.abs(t.proceeds) : t.quantity * t.price;
    add(t.date, amountToUsd(fxRates, value, t.currency, t.settle_date || t.date), "opening");
  }
  for (const f of portfolio.cash_flows || []) {
    if (!CAPITAL_FLOW.test(f.type || "")) continue;
    const amount = parseFloat(f.amount);
    add(f.date, amountToUsd(fxRates, amount, f.currency, f.date), amount < 0 ? "withdrawal" : "deposit");
  }
  if (flows.length === 0 && portfolio.total_deposits_usd) {
    add(portfolio.inception_date, portfolio.total_deposits_usd, "deposit");
  }
  return flows
    .filter((f) => !upTo || f.date <= upTo)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Roční výnos vážený penězi (XIRR) v %: sazba, při které se vyrovnají vložené
 * a vybrané peníze s hodnotou portfolia k `asOf`. Počítá s tím, kdy peníze
 * skutečně přišly a odešly — anualizace prostého výnosu by přecenila
 * portfolio, kam se vkládalo postupně nebo odkud se vybíralo. Při jediném
 * vkladu je totožná s (hodnota / vklad)^(1 / roky) − 1. Bez řešení → null.
 */
export function xirrPct(flows, valueUsd, asOf) {
  if (!flows.length || !Number.isFinite(valueUsd)) return null;
  const t0 = Math.min(...flows.map((f) => toMs(f.date)));
  const years = (ms) => Math.max(0, ms - t0) / 86400000 / 365.25;
  // Z pohledu investora: vklad je výdaj, výběr a konečná hodnota příjem
  const cash = flows.map((f) => ({ t: years(toMs(f.date)), v: -f.usd }));
  cash.push({ t: Math.max(1 / 365.25, years(toMs(asOf))), v: valueUsd });
  const npv = (r) => cash.reduce((s, c) => s + c.v / Math.pow(1 + r, c.t), 0);

  let lo = -0.9999;
  let hi = 100; // −99,99 % až +10 000 % ročně
  let fLo = npv(lo);
  const fHi = npv(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (fLo * fMid <= 0) hi = mid;
    else {
      lo = mid;
      fLo = fMid;
    }
  }
  return ((lo + hi) / 2) * 100;
}

/**
 * Celkový výnos portfolia od založení (dlaždice „Celkový výnos" a „P.a."):
 *   zisk = hodnota + vybráno − vloženo, % = zisk / vloženo, p.a. = XIRR,
 * kde vloženo = počáteční kapitál + vklady. Výběry základ nezmenšují —
 * jinak by po vybrání většiny peněz výnos v % narostl nesmyslně (KB).
 * Bez výběrů a počátečních pozic (IBKR) je to totéž co
 * (hodnota − vklady) / vklady. Počítá se v USD (vklady se evidují v USD),
 * do Kč se převádí výsledek. `asOf`: Date, nebo ISO datum (půlnoc UTC).
 */
export function portfolioTotalReturn({ assetsUsd, flows, inceptionDate, asOf, usdToCzk }) {
  let vlozeno = 0;
  let vybrano = 0;
  for (const f of flows) {
    if (f.usd > 0) vlozeno += f.usd;
    else vybrano -= f.usd;
  }
  const usd = vlozeno > 0 ? assetsUsd + vybrano - vlozeno : 0;
  const pct = vlozeno > 0 ? (usd / vlozeno) * 100 : 0;
  const days = Math.max(1, (toMs(asOf) - new Date(inceptionDate).getTime()) / 86400000);
  const years = days / 365.25;
  const paPct = vlozeno > 0 ? xirrPct(flows, assetsUsd, asOf) : 0;
  return { usd, pct, paPct, days, years, vlozeno, vybrano, czk: usdToCzk ? usd * usdToCzk : null };
}

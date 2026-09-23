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
 * se historicky přepočítávají vklady z overlay do total_deposits_usd.
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

/**
 * Celkový výnos portfolia od založení — vzorec dlaždice „Celkový výnos":
 * (pozice + hotovost − vklady) / vklady. Vklady se evidují v USD
 * (total_deposits_usd), proto se počítá v USD a do Kč se převádí výsledek.
 * P.a. = geometrická anualizace přes roky od inception do `asOf`
 * (Date, nebo ISO datum — pak se počítá k půlnoci UTC toho dne).
 */
export function portfolioTotalReturn({ assetsUsd, totalDepositsUsd, inceptionDate, asOf, usdToCzk }) {
  const deposits = totalDepositsUsd || 0;
  const usd = deposits > 0 ? assetsUsd - deposits : 0;
  const pct = deposits > 0 ? (usd / deposits) * 100 : 0;
  const asOfMs = asOf instanceof Date ? asOf.getTime() : new Date(asOf).getTime();
  const days = Math.max(1, (asOfMs - new Date(inceptionDate).getTime()) / 86400000);
  const years = days / 365.25;
  const paPct = years > 0 ? (Math.pow(1 + pct / 100, 1 / years) - 1) * 100 : 0;
  return { usd, pct, paPct, days, years, czk: usdToCzk ? usd * usdToCzk : null };
}

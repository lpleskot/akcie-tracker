/**
 * Poplatky účtu po kalendářních letech – podklad pro účetnictví (tab Poplatky).
 *
 * Sbírá náklady ze všech záznamů portfolia: provize a burzovní daně u obchodů,
 * poplatky za konverze měn, správu účtu, ostatní poplatky (ADR, externí poplatky
 * za corporate actions) a placené úroky. Poplatky obchodů patří do roku podle
 * vypořádání, stejně jako v Reportu pro účetní – jinak by se součty rozešly.
 *
 * Kč kurzem ČNB ke dni zaúčtování. Chybí-li den v kurzech, vezme se poslední
 * předchozí vyhlášený a položka nese `estimate` – na obrazovce „≈“, aby se
 * odhad nedal splést s přesným kurzem.
 *
 * Čisté funkce bez DOM, kurzy parametrem (tvar data/fx_rates.json).
 */

import { fmtNum } from "./fifo.js";
import { fxToCzk } from "./portfolio-shared.js";

// Pořadí = pořadí dlaždic a sloupců. `inFifo`: poplatek je v aplikaci součástí
// FIFO (nákupní v pořizovací ceně akcií, prodejní snižuje výnos z prodeje) –
// účetní ho nesmí započítat podruhé jako samostatný náklad.
export const FEE_CATEGORIES = [
  { key: "buy", label: "Poplatky při nákupu", inFifo: true, note: "v pořizovací ceně akcií (FIFO)" },
  { key: "sell", label: "Poplatky při prodeji", inFifo: true, note: "snižují výnos z prodeje (FIFO)" },
  { key: "fx", label: "Konverze měn", inFifo: false, note: "samostatný náklad" },
  { key: "account", label: "Správa účtu", inFifo: false, note: "samostatný náklad vč. DPH" },
  { key: "other", label: "Ostatní poplatky", inFifo: false, note: "samostatný náklad" },
  { key: "interest", label: "Placené úroky", inFifo: false, note: "samostatný náklad" },
];

export const FEE_LABELS = Object.fromEntries(FEE_CATEGORIES.map((c) => [c.key, c.label]));

// Druhy pohybů hotovosti, které jsou nákladem. Vklady, výběry, přijaté úroky
// a konverze KB (poplatek je v kurzu, samostatně ho KB neúčtuje) sem nepatří.
const CASH_FLOW_CATEGORIES = [
  [/^(management_fee|management_fee_vat|fee_rebilling)$/, "account"],
  [/^external_fee$|Other Fees|Transaction Fees|Commission Adjustments/i, "other"],
  [/Broker Interest Paid/i, "interest"],
];

export function cashFlowCategory(type) {
  for (const [re, category] of CASH_FLOW_CATEGORIES) if (re.test(type || "")) return category;
  return null;
}

// Kurz ke dni zaúčtování: přesný den, jinak poslední předchozí jako odhad.
// Den předchozího kurzu stejně jako fxToCzk s fallbackem: poslední den PŘED
// datem – i když den sám v kurzech je, jen bez této měny (fxDateFor by vrátil jeho).
function rateFor(fxRates, days, date, currency) {
  if (currency === "CZK") return { rate: 1, rateDate: null, estimate: false };
  const exact = fxToCzk(fxRates, date, currency);
  if (exact) return { rate: exact, rateDate: date, estimate: false };
  const fallback = fxToCzk(fxRates, date, currency, { allowFallback: true });
  if (fallback) return { rate: fallback, rateDate: days.filter((d) => d < date).pop(), estimate: true };
  return { rate: null, rateDate: null, estimate: false };
}

const qtyText = (q) => fmtNum(Math.abs(q), Number.isInteger(q) ? 0 : 4);

function fxDescription(x) {
  const base = x.base_currency || String(x.pair || "").split(".")[0];
  const bought = x.quantity > 0;
  return `${bought ? "Nákup" : "Prodej"} ${qtyText(x.quantity)} ${base} za ${fmtNum(Math.abs(x.proceeds), 2)} ${x.currency}`;
}

/**
 * Všechny poplatky portfolia jako položky, chronologicky.
 * Položka: { date (zaúčtování), trade_date, category, symbol, description,
 *   amount (náklad kladně, vratka záporně), currency, rate, rate_date, estimate, czk }
 * `czk` je null, když kurz ČNB chybí úplně – taková položka není v součtech.
 */
export function feeItems(portfolio, fxRates) {
  const items = [];
  const days = Object.keys(fxRates?.dates || {}).sort();
  const push = (item) => {
    const fx = rateFor(fxRates, days, item.date, item.currency);
    items.push({
      ...item,
      rate: fx.rate,
      rate_date: fx.rateDate,
      estimate: fx.estimate,
      czk: fx.rate != null ? item.amount * fx.rate : null,
    });
  };

  for (const t of portfolio.transactions || []) {
    const commission = Number(t.commission);
    // Odhad počáteční pozice nemá skutečnou provizi – nebyl to obchod
    if (t.synthetic_opening || !Number.isFinite(commission) || commission === 0) continue;
    const sell = t.type === "SELL";
    // Statické obchody IBKR měnu nenesou – je u instrumentu
    const currency = t.currency || portfolio.instruments?.[t.symbol]?.currency;
    // Daň z obchodu doplněná do komise (DSY, francouzská daň) – ať je vidět, proč komise nesedí s provizí
    const taxes = Number(t.taxes);
    const taxNote = Number.isFinite(taxes) && taxes !== 0 ? ` (vč. daně z obchodu ${fmtNum(-taxes, 2)} ${currency})` : "";
    push({
      date: t.settle_date || t.date,
      trade_date: t.date,
      category: sell ? "sell" : "buy",
      symbol: t.symbol,
      description: `${sell ? "Prodej" : "Nákup"} ${qtyText(t.quantity)} ks${taxNote}`,
      amount: -commission,
      currency,
    });
  }

  for (const x of portfolio.fx_conversions || []) {
    const commission = Number(x.commission);
    if (!Number.isFinite(commission) || commission === 0) continue;
    push({
      date: x.settle_date || x.date,
      trade_date: x.date,
      category: "fx",
      symbol: null,
      description: fxDescription(x),
      amount: -commission,
      currency: x.commission_currency || x.currency,
    });
  }

  for (const f of portfolio.cash_flows || []) {
    const category = cashFlowCategory(f.type);
    const amount = Number(f.amount);
    if (!category || !Number.isFinite(amount) || amount === 0) continue;
    push({
      date: f.settle_date || f.date,
      trade_date: f.date,
      category,
      symbol: f.symbol || null,
      description: f.description || f.type,
      amount: -amount,
      currency: f.currency,
    });
  }

  const order = Object.fromEntries(FEE_CATEGORIES.map((c, i) => [c.key, i]));
  return items.sort((a, b) => a.date.localeCompare(b.date) || order[a.category] - order[b.category]);
}

/**
 * Součty po letech (rok = rok data zaúčtování), nejnovější první.
 * Rok: { year, czk, count, missing, estimates, inFifo, separate,
 *   categories: { [key]: { czk, count, missing } } }
 */
export function feesByYear(items) {
  const years = new Map();
  for (const item of items) {
    const year = item.date.slice(0, 4);
    let sum = years.get(year);
    if (!sum) {
      sum = {
        year,
        czk: 0,
        count: 0,
        missing: 0,
        estimates: 0,
        inFifo: 0,
        separate: 0,
        categories: Object.fromEntries(FEE_CATEGORIES.map((c) => [c.key, { czk: 0, count: 0, missing: 0 }])),
      };
      years.set(year, sum);
    }
    const cat = sum.categories[item.category];
    sum.count++;
    cat.count++;
    if (item.czk == null) {
      sum.missing++;
      cat.missing++;
      continue;
    }
    if (item.estimate) sum.estimates++;
    sum.czk += item.czk;
    cat.czk += item.czk;
    if (FEE_CATEGORIES.find((c) => c.key === item.category).inFifo) sum.inFifo += item.czk;
    else sum.separate += item.czk;
  }
  return [...years.values()].sort((a, b) => b.year.localeCompare(a.year));
}

// Druhy poplatků, které účet vůbec má – dlaždice a sloupce se při přepnutí roku nemění
export function usedCategories(items) {
  const used = new Set(items.map((i) => i.category));
  return FEE_CATEGORIES.filter((c) => used.has(c.key));
}

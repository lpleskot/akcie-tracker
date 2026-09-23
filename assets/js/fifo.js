/**
 * FIFO engine — výpočet pozic, cost basis a realized P/L z chronologického seznamu transakcí.
 *
 * Vstup: pole transakcí ve tvaru:
 *   { date, time, symbol, type: "BUY"|"SELL", quantity, price, proceeds, commission }
 *
 * Výstup z computePositions(): mapa symbol -> {
 *   open_lots: [{ date, qty, price, original_qty, cost_per_unit_with_comm }],
 *   net_qty,
 *   cost_basis,           // součet open_lots * (cena vč. části komise)
 *   avg_open_price,       // cost_basis / net_qty
 *   realized_pnl,         // P/L z uzavřených částí
 *   closed_lots: [{ buy_date, sell_date, qty, buy_price, sell_price, pnl }]
 * }
 *
 * Předpoklady:
 *   - quantity je vždy kladné (nepoužíváme záporné qty u SELL — type to říká)
 *   - commission je záporná (jak ji vrací IBKR), bereme abs hodnotu
 *   - prodeje matchují FIFO proti nejstarším otevřeným lotům
 *
 * Při importu z IBKR má SELL `qty` záporné — handluje se přes Math.abs.
 */

import { flexDate } from "./flex-shared.js";

/**
 * Pre-process KB-style corporate actions:
 *   - received_share + removed_share spárované ve 30 dnech na stejném
 *     isin_underlying → SPLIT (forward / reverse podle směru qty).
 *   - Unpaired received_share → BONUS_SHARES (přidat lot za 0).
 *   - Unpaired removed_share → CANCELLATION (FIFO konzumace bez realized).
 *   - Pokud je vstup už klasický {type:"split", ratio_from, ratio_to} → projde beze změny.
 */
export function preprocessCorporateActions(corps) {
  const result = [];
  const consumed = new Set();
  const byIsin = new Map();
  // Index podle isin_underlying pro rychlé párování
  for (let i = 0; i < corps.length; i++) {
    const c = corps[i];
    // Už normalizované eventy (split / bonus / cancellation) projdou beze změny —
    // computePositionsAt normalizuje předem, aby datumový filtr nerozbil párování.
    if (c.type === "split" || c.type === "bonus_shares" || c.type === "cancellation") {
      result.push(c);
      consumed.add(i);
      continue;
    }
    if (c.type === "received_share" || c.type === "removed_share") {
      const k = c.isin_underlying || c.symbol;
      if (!byIsin.has(k)) byIsin.set(k, []);
      byIsin.get(k).push({ ...c, _idx: i });
    }
  }
  // Pro každý isin: najít páry (received + removed) ve 30 dnech
  for (const [, items] of byIsin) {
    items.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < items.length; i++) {
      if (consumed.has(items[i]._idx)) continue;
      const a = items[i];
      // Najít párovou položku opačného typu ve 30 dnech
      const targetType =
        a.type === "received_share" ? "removed_share" : "received_share";
      let pair = null;
      for (let j = 0; j < items.length; j++) {
        if (i === j || consumed.has(items[j]._idx)) continue;
        const b = items[j];
        if (b.type !== targetType) continue;
        const daysDiff = Math.abs(
          (new Date(b.date).getTime() - new Date(a.date).getTime()) /
            86400000,
        );
        if (daysDiff <= 30) {
          pair = b;
          break;
        }
      }
      if (pair) {
        // Split: starý qty (removed) → nový qty (received)
        const removed = a.type === "removed_share" ? a : pair;
        const received = a.type === "received_share" ? a : pair;
        const ratio_from = removed.quantity;
        const ratio_to = received.quantity;
        result.push({
          type: "split",
          date: received.date,
          symbol: received.symbol || received.isin_underlying,
          ratio_from,
          ratio_to,
          note: `${received.name || ""} ↔ ${removed.name || ""} (auto-detected split ${ratio_to}:${ratio_from})`,
        });
        consumed.add(a._idx);
        consumed.add(pair._idx);
      }
    }
    // Unpaired položky
    for (const it of items) {
      if (consumed.has(it._idx)) continue;
      if (it.type === "received_share") {
        result.push({
          type: "bonus_shares",
          date: it.date,
          symbol: it.symbol || it.isin_underlying,
          quantity: it.quantity,
          name: it.name,
          note: it.note,
        });
      } else if (it.type === "removed_share") {
        result.push({
          type: "cancellation",
          date: it.date,
          symbol: it.symbol || it.isin_underlying,
          quantity: it.quantity,
          name: it.name,
          note: it.note,
        });
      }
      consumed.add(it._idx);
    }
  }
  return result;
}

/**
 * @param {Array} transactions  Pole transakcí (chronologicky setřízené).
 * @param {Array} [corporateActions]  Pole corporate actions (zatím jen "split").
 * @param {Array} [dividends]  Pole vyplacených dividend.
 * @param {Array} [withholdingTax]  Pole sražených daní u zdroje.
 * @returns {Object}  Mapa symbol -> position summary.
 */
export function computePositions(
  transactions,
  corporateActions = [],
  dividends = [],
  withholdingTax = [],
) {
  // Předzpracování corporate actions: spárovat received_share + removed_share
  // ve 30denním okně se stejným isin_underlying → split event.
  // Unpaired received_share = bonus shares (add zero-cost lot).
  // Unpaired removed_share = cancellation (consume FIFO bez realized).
  const processedCorps = preprocessCorporateActions(corporateActions);

  // Sloučit transakce + corporate actions do jednoho chronologického streamu.
  // Splity označíme časem 23:59:59 daného dne — aplikují se po všech transakcích.
  const events = [
    ...transactions.map((t) => ({
      ...t,
      _kind: "tx",
      _ts: `${t.date} ${t.time || "00:00:00"}`,
    })),
    ...processedCorps.map((c) => ({
      ...c,
      _kind: "corp",
      _ts: `${c.date} 23:59:59`,
    })),
  ];
  events.sort((a, b) => a._ts.localeCompare(b._ts));

  // Per-symbol state: { open_lots: [...], closed_lots: [...], realized_pnl, splits: [] }
  const state = new Map();

  function s(sym) {
    if (!state.has(sym)) {
      state.set(sym, {
        open_lots: [],
        closed_lots: [],
        realized_pnl: 0,
        splits: [],
      });
    }
    return state.get(sym);
  }

  for (const ev of events) {
    if (ev._kind === "corp") {
      if (ev.type === "split") {
        // Forward split 1:N → každý držený lot získá N-násobek kusů
        // za 1/N původní ceny. Total cost basis zůstává stejný.
        const ratio = ev.ratio_to / ev.ratio_from;
        const st = s(ev.symbol);
        for (const lot of st.open_lots) {
          lot.qty *= ratio;
          lot.original_qty *= ratio;
          lot.price /= ratio;
          lot.cost_per_unit /= ratio;
        }
        st.splits.push({
          date: ev.date,
          ratio_from: ev.ratio_from,
          ratio_to: ev.ratio_to,
          note: ev.note || "",
        });
      } else if (ev.type === "bonus_shares") {
        // Bonus / spinoff shares: přidat lot za nulový cost
        const sym = ev.symbol || ev.isin_underlying;
        s(sym).open_lots.push({
          date: ev.date,
          time: "",
          qty: ev.quantity,
          original_qty: ev.quantity,
          price: 0,
          cost_per_unit: 0,
        });
        s(sym).splits.push({
          date: ev.date,
          ratio_from: 0,
          ratio_to: 0,
          note: `Bonus shares: ${ev.quantity} ks ${ev.name || sym}`,
        });
      } else if (ev.type === "cancellation") {
        // Cancellation: konzumovat FIFO, bez realized P/L
        const sym = ev.symbol || ev.isin_underlying;
        let remaining = ev.quantity;
        const lots = s(sym).open_lots;
        while (remaining > 0 && lots.length > 0) {
          const lot = lots[0];
          const take = Math.min(remaining, lot.qty);
          lot.qty -= take;
          remaining -= take;
          if (lot.qty <= 1e-9) lots.shift();
        }
        s(sym).splits.push({
          date: ev.date,
          ratio_from: 0,
          ratio_to: 0,
          note: `Cancellation: ${ev.quantity} ks zaniklo`,
        });
      }
      continue;
    }

    const tx = ev;
    const sym = tx.symbol;
    const qty = Math.abs(tx.quantity);
    // KB zaokrouhluje Kurz ve výpisech na 2 desetinná místa — autoritativní
    // je objem (proceeds). Efektivní cena za kus = |objem| / kusy; fallback
    // na price, když objem chybí. Pro IBKR identické (price je přesná).
    const price =
      tx.proceeds != null && Math.abs(tx.proceeds) > 0 && qty > 0
        ? Math.abs(tx.proceeds) / qty
        : tx.price;
    const comm = Math.abs(tx.commission || 0);
    const commPerUnit = qty > 0 ? comm / qty : 0;

    if (tx.type === "BUY") {
      // Cost per unit includes prorated commission (přesnější cost basis pro FIFO)
      s(sym).open_lots.push({
        date: tx.date,
        // Datum vypořádání — pro účetnictví určuje rok i kurz ČNB
        settle_date: tx.settle_date || tx.date,
        time: tx.time,
        qty: qty,
        original_qty: qty,
        price: price,
        cost_per_unit: price + commPerUnit,
      });
    } else if (tx.type === "SELL") {
      // FIFO: vezmi z nejstaršího open lotu
      let remaining = qty;
      const sellPriceNet = price - commPerUnit; // čistý výnos po prorataci komise prodeje
      const sellSettle = tx.settle_date || tx.date;
      const lots = s(sym).open_lots;

      while (remaining > 0 && lots.length > 0) {
        const lot = lots[0];
        const take = Math.min(remaining, lot.qty);
        const pnl = take * (sellPriceNet - lot.cost_per_unit);

        s(sym).closed_lots.push({
          buy_date: lot.date,
          buy_settle_date: lot.settle_date || lot.date,
          buy_time: lot.time,
          sell_date: tx.date,
          sell_settle_date: sellSettle,
          sell_time: tx.time,
          qty: take,
          buy_price: lot.price,
          buy_cost_per_unit: lot.cost_per_unit,
          sell_price: price,
          sell_net_per_unit: sellPriceNet,
          pnl: pnl,
        });
        s(sym).realized_pnl += pnl;

        lot.qty -= take;
        remaining -= take;
        if (lot.qty <= 1e-9) lots.shift();
      }

      if (remaining > 0) {
        // Prodej, který nelze pokrýt FIFO — chyba v datech / nedostatečná historie
        s(sym).closed_lots.push({
          orphan: true,
          sell_date: tx.date,
          sell_settle_date: sellSettle,
          sell_time: tx.time,
          qty: remaining,
          sell_price: price,
          note: "Prodej bez odpovídajícího nákupu v historii",
        });
      }
    }
  }

  // Agregovat dividendy + withholding tax per symbol
  const incomeBySym = {};
  function inc(sym) {
    if (!incomeBySym[sym]) {
      incomeBySym[sym] = {
        dividends_local: 0,
        dividends_usd: 0,
        withholding_local: 0,
        withholding_usd: 0,
        dividend_records: [],
        withholding_records: [],
      };
    }
    return incomeBySym[sym];
  }
  for (const d of dividends) {
    if (!d.symbol) continue;
    const it = inc(d.symbol);
    it.dividends_local += d.amount || 0;
    it.dividends_usd += d.amount_usd || 0;
    it.dividend_records.push(d);
  }
  for (const t of withholdingTax) {
    if (!t.symbol) continue;
    const it = inc(t.symbol);
    it.withholding_local += t.amount || 0;
    it.withholding_usd += t.amount_usd || 0;
    it.withholding_records.push(t);
  }

  // Sumarizovat výstup
  const result = {};
  // Pozice nebo income — sjednotit klíče
  const allSyms = new Set([...state.keys(), ...Object.keys(incomeBySym)]);
  for (const sym of allSyms) {
    const st = state.get(sym) || {
      open_lots: [],
      closed_lots: [],
      realized_pnl: 0,
      splits: [],
    };
    let net_qty = 0;
    let cost_basis = 0;
    for (const lot of st.open_lots) {
      net_qty += lot.qty;
      cost_basis += lot.qty * lot.cost_per_unit;
    }
    let closed_cost_basis = 0;
    for (const c of st.closed_lots) {
      if (!c.orphan) closed_cost_basis += c.qty * c.buy_cost_per_unit;
    }
    const inc = incomeBySym[sym] || {
      dividends_local: 0,
      dividends_usd: 0,
      withholding_local: 0,
      withholding_usd: 0,
      dividend_records: [],
      withholding_records: [],
    };
    result[sym] = {
      net_qty,
      cost_basis,
      avg_open_price: net_qty > 0 ? cost_basis / net_qty : 0,
      realized_pnl: st.realized_pnl,
      closed_cost_basis,
      total_invested: cost_basis + closed_cost_basis,
      open_lots: st.open_lots,
      closed_lots: st.closed_lots,
      splits: st.splits || [],
      // Dividendy a daně (v původní měně i USD ekv.)
      dividends_local: inc.dividends_local,
      dividends_usd: inc.dividends_usd,
      withholding_local: inc.withholding_local,
      withholding_usd: inc.withholding_usd,
      net_dividend_local: inc.dividends_local + inc.withholding_local,
      net_dividend_usd: inc.dividends_usd + inc.withholding_usd,
      dividend_records: inc.dividend_records,
      withholding_records: inc.withholding_records,
    };
  }
  return result;
}

/**
 * Pozice držené KE DNI. Výchozí je účetní konvence projektu (inventura,
 * rozvahový den): rozhoduje datum vypořádání — bere se obchod vypořádaný
 * do data včetně, dividendy se do FIFO nepředávají.
 *
 * `opts.dateField: "date"` přepne na datum obchodu — co bylo drženo při
 * závěru dne pro ocenění (nákup 22. 9. s vypořádáním 23. 9. hýbe hodnotou
 * portfolia už 22. 9.). `opts.dividends` / `opts.withholdingTax` se
 * ořežou na datum ≤ date a jdou do FIFO (net_dividend_local, …).
 *
 * Corporate actions se nejdřív normalizují nad celou historií (párování
 * received/removed v 30denním okně nesmí rozbít datumový filtr) a použijí
 * se jen ty s datem ≤ date. Split PO datu se tedy neaplikuje — kusy odpovídají
 * stavu k tomu dni (a k ceně z burzy je nutná korekce, viz splitFactorAfter).
 */
export function computePositionsAt(transactions, corporateActions, date, opts = {}) {
  const byTradeDate = opts.dateField === "date";
  const txs = (transactions || []).filter(
    (t) => (byTradeDate ? t.date : t.settle_date || t.date) <= date,
  );
  const cas = preprocessCorporateActions(corporateActions || []).filter(
    (c) => c.date <= date,
  );
  const upTo = (arr) => (arr || []).filter((x) => x.date <= date);
  return computePositions(txs, cas, upTo(opts.dividends), upTo(opts.withholdingTax));
}

/**
 * Součin poměrů splitů daného symbolu PO datu. Yahoo historické close jsou
 * split-adjusted (staré ceny přepočtené na dnešní počet kusů) — skutečná cena
 * k datu = Yahoo close × tento faktor. Bez korekce by BKNG k 31.12.2025 vyšel
 * 25× levněji (split 1:25 z dubna 2026).
 */
export function splitFactorAfter(corporateActions, symbol, date) {
  let factor = 1;
  for (const c of preprocessCorporateActions(corporateActions || [])) {
    if (c.type !== "split" || c.symbol !== symbol || !(c.date > date)) continue;
    if (!c.ratio_from || !c.ratio_to) continue;
    factor *= c.ratio_to / c.ratio_from;
  }
  return factor;
}

/**
 * Hotovost u brokera k datu. Každý broker dává jiné rozlišení:
 *   IBKR — denní NAV snapshoty z Flex (`cash` v base měně účtu)
 *   KB   — kvartální snapshoty ze STAV PTF (`cash_history`, po měnách)
 * Vrací i `asOf` datum snapshotu: když je starší než dotaz, volající to musí
 * přiznat — jinak by se stav tvářil přesněji, než ve skutečnosti je.
 *
 * Hotovost se zásadně NEdopočítává z cash_flows: u KB nejsou v evidenci
 * poplatky za vedení účtu, takže dopočet by proti výpisu tiše driftoval.
 */
export function cashAtDate(portfolio, date) {
  if (!portfolio || !date) return null;

  // Denní NAV (IBKR): backfill + overlay z cronu, pro stejný den vyhrává overlay
  const navByDate = new Map();
  for (const [arr, source] of [
    [portfolio.static_nav_history, "static"],
    [portfolio.nav_history, "overlay"],
  ]) {
    for (const n of arr || []) {
      const d = flexDate(n.reportDate);
      const cash = parseFloat(n.cash);
      if (!d || d > date || !Number.isFinite(cash)) continue;
      if (!navByDate.has(d) || source === "overlay") {
        navByDate.set(d, { cash, currency: n.currency || portfolio.base_currency || "USD" });
      }
    }
  }
  if (navByDate.size) {
    const asOf = [...navByDate.keys()].sort().pop();
    const n = navByDate.get(asOf);
    return { asOf, cash: { [n.currency]: n.cash }, daily: true, source: "IBKR Flex NAV" };
  }

  // Kvartální snapshoty (KB) — poslední s datem ≤ dotaz
  let snap = null;
  for (const s of portfolio.cash_history || []) {
    if (s.date <= date && (!snap || s.date > snap.date)) snap = s;
  }
  if (snap) {
    return { asOf: snap.date, cash: { ...snap.cash }, daily: false, source: snap.source };
  }
  return null;
}

/**
 * Vypočítá nerealizovanou P/L pozice vůči aktuální tržní ceně.
 */
export function unrealizedPnl(position, currentPrice) {
  if (!position || position.net_qty === 0 || currentPrice == null) {
    return { value: 0, pct: 0, market_value: 0 };
  }
  const market_value = position.net_qty * currentPrice;
  const value = market_value - position.cost_basis;
  const pct = position.cost_basis > 0 ? (value / position.cost_basis) * 100 : 0;
  return { value, pct, market_value };
}

/**
 * Total Return pozice při dané ceně — sloupec „Celkem Z/Z" v přehledu:
 * kapitálová Z/Z (realizovaná + nerealizovaná) + čisté dividendy, v %
 * z celkové investice (total_invested = otevřené i uzavřené loty).
 * Dividendy se přičtou jen ve stejné měně jako pozice — jinak by se sčítaly
 * různé měny (NOV: EUR pozice, DKK dividendy). Pak je totalPnl jen kapitálová
 * Z/Z a divSameCcy = false.
 */
export function positionTotalReturn(pos, currency, price) {
  const u = unrealizedPnl(pos, price);
  const capitalPnl = pos.realized_pnl + u.value;
  const divCcys = new Set([
    ...(pos.dividend_records || []).map((d) => d.currency),
    ...(pos.withholding_records || []).map((t) => t.currency),
  ]);
  const divSameCcy =
    divCcys.size === 0 || (divCcys.size === 1 && divCcys.has(currency));
  const totalPnl = divSameCcy ? capitalPnl + (pos.net_dividend_local || 0) : capitalPnl;
  const pctOfInvested = (x) =>
    pos.total_invested > 0 ? (x / pos.total_invested) * 100 : 0;
  return {
    marketValue: u.market_value,
    unrealizedPnl: u.value,
    capitalPnl,
    capitalPct: pctOfInvested(capitalPnl),
    totalPnl,
    totalPct: pctOfInvested(totalPnl),
    divSameCcy,
    hasDividends: divCcys.size > 0,
    dividendCurrencies: [...divCcys],
  };
}

/**
 * Formátování čísla podle locale.
 */
export function fmtNum(n, decimals = 2) {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString("cs-CZ", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtPct(n, decimals = 2) {
  if (n == null || isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${fmtNum(n, decimals)} %`;
}

export function fmtMoney(n, currency, decimals = 2) {
  if (n == null || isNaN(n)) return "—";
  return `${fmtNum(n, decimals)} ${currency || ""}`.trim();
}

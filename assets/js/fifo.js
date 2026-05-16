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

/**
 * @param {Array} transactions  Pole transakcí (chronologicky setřízené).
 * @returns {Object}  Mapa symbol -> position summary.
 */
export function computePositions(transactions) {
  // Setřídit chronologicky pro jistotu (date + time)
  const sorted = [...transactions].sort((a, b) => {
    const ka = `${a.date} ${a.time || "00:00:00"}`;
    const kb = `${b.date} ${b.time || "00:00:00"}`;
    return ka.localeCompare(kb);
  });

  // Per-symbol state: { open_lots: [...], closed_lots: [...], realized_pnl }
  const state = new Map();

  function s(sym) {
    if (!state.has(sym)) {
      state.set(sym, { open_lots: [], closed_lots: [], realized_pnl: 0 });
    }
    return state.get(sym);
  }

  for (const tx of sorted) {
    const sym = tx.symbol;
    const qty = Math.abs(tx.quantity);
    const price = tx.price;
    const comm = Math.abs(tx.commission || 0);
    const commPerUnit = qty > 0 ? comm / qty : 0;

    if (tx.type === "BUY") {
      // Cost per unit includes prorated commission (přesnější cost basis pro FIFO)
      s(sym).open_lots.push({
        date: tx.date,
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
      const lots = s(sym).open_lots;

      while (remaining > 0 && lots.length > 0) {
        const lot = lots[0];
        const take = Math.min(remaining, lot.qty);
        const pnl = take * (sellPriceNet - lot.cost_per_unit);

        s(sym).closed_lots.push({
          buy_date: lot.date,
          buy_time: lot.time,
          sell_date: tx.date,
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
          sell_time: tx.time,
          qty: remaining,
          sell_price: price,
          note: "Prodej bez odpovídajícího nákupu v historii",
        });
      }
    }
  }

  // Sumarizovat výstup
  const result = {};
  for (const [sym, st] of state.entries()) {
    let net_qty = 0;
    let cost_basis = 0;
    for (const lot of st.open_lots) {
      net_qty += lot.qty;
      cost_basis += lot.qty * lot.cost_per_unit;
    }
    result[sym] = {
      net_qty,
      cost_basis,
      avg_open_price: net_qty > 0 ? cost_basis / net_qty : 0,
      realized_pnl: st.realized_pnl,
      open_lots: st.open_lots,
      closed_lots: st.closed_lots,
    };
  }
  return result;
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

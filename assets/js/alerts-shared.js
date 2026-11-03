/**
 * Pravidla alertů na držené pozice: vyhodnocení a značky splnění v KV.
 *
 * Importuje ranní kontrola (worker/jobs/alerts.js), API /api/alerts i náhled
 * v tabu Alerty. Ranní kontrola i náhled procházejí všechna portfolia
 * z manifestu a musí ukázat totéž – žádné paralelní kopie vyhodnocení.
 *
 * Čisté funkce bez DOM a globálního stavu.
 */

// Do 2026-11-03 hlídala ranní kontrola jen firemní IBKR a splnění si značila
// klíčem bez portfolia. Takové klíče v KV zůstávají a patří tomuto portfoliu.
export const LEGACY_FIRED_PORTFOLIO = "plegi-invest-ibkr";

const FIRED_PREFIX = "fired:alert:";

// Splnění se značí pro každou pozici zvlášť: stejný ticker bývá ve víc
// portfoliích s jinou průměrnou nákupní cenou
export function firedAlertKey(ruleId, portfolioId, symbol) {
  return `${FIRED_PREFIX}${ruleId}:${portfolioId}:${symbol}`;
}

export function legacyFiredAlertKey(ruleId, symbol) {
  return `${FIRED_PREFIX}${ruleId}:${symbol}`;
}

// Identifikátor pozice v mapě splnění, kterou vrací GET /api/alerts
export function firedAlertId(ruleId, portfolioId, symbol) {
  return `${ruleId}:${portfolioId}:${symbol}`;
}

export function parseFiredAlertKey(name) {
  if (!name.startsWith(FIRED_PREFIX)) return null;
  const parts = name.slice(FIRED_PREFIX.length).split(":");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { ruleId: parts[0], portfolioId: LEGACY_FIRED_PORTFOLIO, symbol: parts[1] };
  }
  if (parts.length === 3 && parts.every(Boolean)) {
    return { ruleId: parts[0], portfolioId: parts[1], symbol: parts[2] };
  }
  return null;
}

function isHeld(pos) {
  return pos?.net_qty > 1e-9;
}

/**
 * Yahoo tickery držených pozic napříč portfolii – jen u nich má smysl stahovat
 * cenu. Delisted tituly Yahoo nezná.
 * holdings = [{ id, name, positions, instruments }], jedno za portfolio.
 */
export function heldYahooSymbols(holdings) {
  const symbols = new Set();
  for (const h of holdings) {
    for (const [sym, pos] of Object.entries(h.positions || {})) {
      const inst = h.instruments?.[sym];
      if (isHeld(pos) && inst && !inst.delisted) symbols.add(inst.yahoo_symbol || sym);
    }
  }
  return [...symbols];
}

// Cena, od které se měří pokles: průměrná nákupní cena, nebo 52týdenní maximum
function referencePrice(rule, pos, quote) {
  if (rule.type === "drop_from_buy_all" || rule.type === "drop_from_buy") {
    return pos.avg_open_price;
  }
  if (rule.type === "drop_from_52w_high") return quote.fifty_two_week_high;
  return null;
}

/**
 * Pozice, které právě teď splňují pravidlo, od největšího propadu.
 * quotes = mapa yahoo_symbol → { price, fifty_two_week_high, delisted? }
 * ve tvaru odpovědi /api/quote.
 */
export function alertRuleMatches(rule, holdings, quotes) {
  if (rule.scope !== "owned") return [];
  // Konkrétní ticker bez vyplněného symbolu nehlídá nic
  if (rule.type === "drop_from_buy" && !rule.symbol) return [];
  const threshold = -Math.abs(Number(rule.threshold_pct));
  if (!Number.isFinite(threshold)) return [];
  const matches = [];
  for (const h of holdings) {
    for (const [sym, pos] of Object.entries(h.positions || {})) {
      if (rule.type === "drop_from_buy" && sym !== rule.symbol) continue;
      if (!isHeld(pos)) continue;
      const inst = h.instruments?.[sym];
      if (!inst || inst.delisted) continue;
      const quote = quotes?.[inst.yahoo_symbol || sym];
      // Delisted (syntetická cena 0) by vždy „splnil" pokles — nehlídáme ho
      if (!quote || quote.price == null || quote.delisted) continue;
      const reference = referencePrice(rule, pos, quote);
      if (!(reference > 0)) continue;
      const changePct = ((quote.price - reference) / reference) * 100;
      if (changePct > threshold) continue;
      matches.push({
        portfolioId: h.id,
        portfolioName: h.name,
        symbol: sym,
        name: inst.name || sym,
        currency: inst.currency || "",
        current: quote.price,
        reference,
        changePct,
      });
    }
  }
  return matches.sort((a, b) => a.changePct - b.changePct);
}

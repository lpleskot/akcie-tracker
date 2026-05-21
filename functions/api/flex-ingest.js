/**
 * POST /api/flex-ingest?portfolio_id=X
 *
 * Přijímá IBKR Flex Web Service XML od GitHub Action workflow,
 * parsuje a mergne idempotentně do KV pod klíčem portfolio-overlay:X.
 *
 * Auth: header X-Ingest-Secret musí odpovídat env.INGEST_SECRET.
 *
 * Důvod, proč XML přichází z GH Action a ne přímo z CF Worker:
 * IBKR WAF blokuje Cloudflare Worker edge IP (vrací 403). GitHub-hosted
 * runners používají Azure DC IP rozsahy, které IBKR pouští. Pages Function
 * sama IBKR nevolá — jen přijímá XML, parsuje a ukládá do KV.
 *
 * Frontend čte KV přes /api/portfolio-overlay/:id (beze změny).
 */

const KV_OVERLAY_PREFIX = "portfolio-overlay:";

export async function onRequestPost({ env, request }) {
  // Auth
  const secret = request.headers.get("X-Ingest-Secret");
  if (!env.INGEST_SECRET) {
    return json({ error: "Server nemá INGEST_SECRET env" }, 500);
  }
  if (!secret || secret !== env.INGEST_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Query params
  const url = new URL(request.url);
  const portfolioId = url.searchParams.get("portfolio_id");
  if (!portfolioId) return json({ error: "Missing portfolio_id" }, 400);

  // Read XML body
  const xml = await request.text();
  if (!xml.includes("<FlexQueryResponse")) {
    return json({ error: "Body není validní Flex XML" }, 400);
  }

  // Parse
  const parsed = parseFlexXml(xml);

  // Merge do KV
  const overlayKey = `${KV_OVERLAY_PREFIX}${portfolioId}`;
  const existing =
    (await env.AKCIE_TRACKER_KV.get(overlayKey, "json")) || emptyOverlay();
  const { merged, stats } = mergeOverlay(existing, parsed);

  merged.last_import = new Date().toISOString();
  await env.AKCIE_TRACKER_KV.put(overlayKey, JSON.stringify(merged));

  return json({
    ok: true,
    last_import: merged.last_import,
    stats,
    parsed_counts: {
      trades: parsed.trades.length,
      cash_transactions: parsed.cashTransactions.length,
      corporate_actions: parsed.corporateActions.length,
      transfers: parsed.transfers.length,
      open_positions: parsed.openPositions.length,
      nav_snapshots: parsed.nav.length,
      m2m_rows: parsed.m2m.length,
    },
    totals_in_kv: {
      trades: merged.trades.length,
      cash_transactions: merged.cash_transactions.length,
      corporate_actions: merged.corporate_actions.length,
      transfers: merged.transfers.length,
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

// ---------- XML parser (kopie z původního cron workeru) ----------

const TRADE_FIELDS = [
  "tradeID", "currency", "assetCategory", "symbol", "description",
  "conid", "isin", "listingExchange", "dateTime", "tradeDate",
  "settleDateTarget", "transactionType", "exchange", "quantity",
  "tradePrice", "tradeMoney", "proceeds", "ibCommission",
  "ibCommissionCurrency", "netCash", "buySell", "openCloseIndicator",
  "notes", "fxRateToBase", "cost",
];
const CASH_TX_FIELDS = [
  "transactionID", "currency", "assetCategory", "symbol", "description",
  "conid", "isin", "listingExchange", "dateTime", "settleDate",
  "amount", "type", "dividendType", "tradeID", "actionID",
  "code", "reportDate", "exDate", "clientReference", "fxRateToBase",
];
const CORP_ACTION_FIELDS = [
  "actionID", "transactionID", "currency", "assetCategory", "symbol",
  "description", "conid", "isin", "listingExchange",
  "reportDate", "dateTime", "type", "actionDescription", "code",
  "quantity", "value", "amount", "proceeds", "costBasis",
];
const TRANSFER_FIELDS = [
  "transactionID", "currency", "assetCategory", "symbol", "description",
  "conid", "isin", "listingExchange", "reportDate", "date",
  "dateTime", "settleDate", "type", "direction", "transferCompany",
  "transferAccount", "transferAccountName", "deliveringBroker",
  "quantity", "transferPrice", "positionAmount", "positionAmountInBase",
  "plAmount", "plAmountInBase", "cashTransfer", "code", "clientReference",
  "fxRateToBase",
];
const OPEN_POSITION_FIELDS = [
  "currency", "assetCategory", "symbol", "description", "conid",
  "isin", "listingExchange", "reportDate", "position", "markPrice",
  "positionValue", "openPrice", "costBasisPrice", "costBasisMoney",
  "fifoPnlUnrealized", "side", "fxRateToBase",
];
const NAV_FIELDS = ["currency", "reportDate", "cash", "stock", "total"];
const M2M_FIELDS = [
  "currency", "assetCategory", "symbol", "conid", "isin",
  "reportDate", "previousCloseQuantity", "previousClosePrice",
  "closeQuantity", "closePrice", "transactionMtm", "priorOpenMtm",
  "commissions", "other", "otherAccruals", "total", "totalAccruals", "code",
];

function parseFlexXml(xml) {
  return {
    trades: parseElements(xml, "Trade", TRADE_FIELDS),
    cashTransactions: parseElements(xml, "CashTransaction", CASH_TX_FIELDS),
    corporateActions: parseElements(xml, "CorporateAction", CORP_ACTION_FIELDS),
    transfers: parseElements(xml, "Transfer", TRANSFER_FIELDS),
    openPositions: parseElements(xml, "OpenPosition", OPEN_POSITION_FIELDS),
    nav: parseElements(xml, "EquitySummaryByReportDateInBase", NAV_FIELDS),
    m2m: parseElements(xml, "MTMPerformanceSummaryUnderlying", M2M_FIELDS),
  };
}

function parseElements(xml, tagName, fields) {
  const regex = new RegExp(`<${tagName}\\s+([^>]+?)\\s*/?>`, "g");
  const items = [];
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const attrs = parseAttributes(m[1]);
    const item = {};
    for (const f of fields) if (attrs[f] !== undefined) item[f] = attrs[f];
    items.push(item);
  }
  return items;
}

function parseAttributes(s) {
  const result = {};
  const regex = /([a-zA-Z][a-zA-Z0-9_]*)="([^"]*)"/g;
  let m;
  while ((m = regex.exec(s)) !== null) result[m[1]] = m[2];
  return result;
}

// ---------- KV merge / overlay ----------

function emptyOverlay() {
  return {
    schema_version: 1,
    last_import: null,
    trades: [],
    cash_transactions: [],
    corporate_actions: [],
    transfers: [],
    open_positions_snapshot: [],
    nav_snapshot: [],
    m2m_ytd: [],
  };
}

function mergeOverlay(existing, parsed) {
  const merged = { ...emptyOverlay(), ...existing };

  const tradeIds = new Set(merged.trades.map((t) => t.tradeID));
  const cashTxIds = new Set(merged.cash_transactions.map((t) => t.transactionID));
  const corpActionIds = new Set(merged.corporate_actions.map((a) => a.actionID));
  const transferIds = new Set(merged.transfers.map((t) => t.transactionID));

  let newTrades = 0,
    newCashTx = 0,
    newCorpActions = 0,
    newTransfers = 0;

  for (const t of parsed.trades) {
    if (t.tradeID && !tradeIds.has(t.tradeID)) {
      merged.trades.push(t);
      tradeIds.add(t.tradeID);
      newTrades++;
    }
  }
  for (const c of parsed.cashTransactions) {
    if (c.transactionID && !cashTxIds.has(c.transactionID)) {
      merged.cash_transactions.push(c);
      cashTxIds.add(c.transactionID);
      newCashTx++;
    }
  }
  for (const a of parsed.corporateActions) {
    if (a.actionID && !corpActionIds.has(a.actionID)) {
      merged.corporate_actions.push(a);
      corpActionIds.add(a.actionID);
      newCorpActions++;
    }
  }
  for (const t of parsed.transfers) {
    if (t.transactionID && !transferIds.has(t.transactionID)) {
      merged.transfers.push(t);
      transferIds.add(t.transactionID);
      newTransfers++;
    }
  }

  // Snapshoty (Open Positions, NAV, M2M) — vždy přepsat aktuálním stavem
  merged.open_positions_snapshot = parsed.openPositions;
  merged.nav_snapshot = parsed.nav;
  merged.m2m_ytd = parsed.m2m;

  return {
    merged,
    stats: { newTrades, newCashTx, newCorpActions, newTransfers },
  };
}

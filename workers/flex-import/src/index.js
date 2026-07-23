/**
 * akcie-tracker-flex-import
 *
 * Cron worker — denně stahuje z IBKR Flex Web Service nové transakce
 * (Trades, CashTransactions, CorporateActions, Transfers, NAV snapshot,
 * Open Positions, M2M YTD) a ukládá je idempotentně do KV jako overlay
 * nad statický portfolio JSON.
 *
 * Flow:
 *   1) SendRequest(token, queryId)  →  ReferenceCode
 *   2) wait 30 s + retry             →  GetStatement(refCode)  → XML
 *   3) parse XML                     →  parsed object
 *   4) merge do KV pod klíčem `portfolio-overlay:{PORTFOLIO_ID}`
 *      — dedupe podle unikátních ID (tradeID, transactionID, actionID)
 *
 * DRY_RUN="true" → parsuje a loguje, ale neukládá. Pro bezpečné testování.
 */

import { sendFailureEmail } from "../../_shared/notify.js";

const FLEX_BASE = "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService";
const KV_OVERLAY_PREFIX = "portfolio-overlay:";
// IBKR má WAF pravidla, která odmítají "bot-like" User-Agent z CF edge IP
// (vrací HTTP 530). Browser-style UA prochází — osvědčeno i v /api/quote pro Yahoo.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Hodina v Evropě/Praze pro daný timestamp — Intl řeší přechod CET/CEST za nás.
function pragueHour(ts) {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Prague",
      hour: "2-digit",
      hour12: false,
    }).format(new Date(ts)),
  );
}

export default {
  async scheduled(event, env, ctx) {
    // Cíl: běžet v 07:00 Prahy celoročně. Crony jedou jen v UTC, proto jsou
    // v configu dva triggery (5:00 + 6:00 UTC) — spustí se jen ten, kterému
    // v Praze právě je 7 hodin; DST dvojče tiše skončí.
    if (pragueHour(event.scheduledTime) !== 7) {
      console.log(`⏭️ Skip — trigger ${event.cron} není 7:00 v Praze (DST dvojče)`);
      return;
    }
    ctx.waitUntil(runImport(env));
  },

  // Manuální HTTP trigger pro testing — vyžaduje secret ADMIN_KEY.
  // Bez nastaveného ADMIN_KEY je endpoint zavřený (cron běží dál) —
  // veřejný /run by komukoli dovolil pálit IBKR Flex rate limit.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      if (!env.ADMIN_KEY || request.headers.get("x-admin-key") !== env.ADMIN_KEY) {
        return new Response("Forbidden", { status: 403 });
      }
      const result = await runImport(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      "akcie-tracker-flex-import\n\nEndpoints:\n  GET /run — trigger import manuálně\n",
      { headers: { "Content-Type": "text/plain" } },
    );
  },
};

// ---------- Main flow ----------
async function runImport(env) {
  const dryRun = env.DRY_RUN === "true";
  console.log(`🚀 Flex import start — dry_run=${dryRun}, portfolio=${env.PORTFOLIO_ID}`);

  try {
    // 1) Stáhnout XML přes Flex API
    const xml = await fetchFlexStatement(env.FLEX_TOKEN, env.FLEX_QUERY_ID);
    console.log(`📥 Stáhnuto ${xml.length} znaků XML`);

    // 2) Parse
    const parsed = parseFlexXml(xml);
    console.log(
      `📊 Parsed: ${parsed.trades.length} trades, ${parsed.cashTransactions.length} cash tx, ` +
        `${parsed.corporateActions.length} corp actions, ${parsed.transfers.length} transfers, ` +
        `${parsed.openPositions.length} open positions`,
    );

    // 3) Načíst existující overlay z KV
    const overlayKey = `${KV_OVERLAY_PREFIX}${env.PORTFOLIO_ID}`;
    const existing = (await env.AKCIE_TRACKER_KV.get(overlayKey, "json")) || emptyOverlay();

    // 4) Merge — dedupe podle unikátních ID
    const { merged, stats } = mergeOverlay(existing, parsed);
    console.log(
      `🔀 Merge stats: +${stats.newTrades} trades, +${stats.newCashTx} cash tx, ` +
        `+${stats.newCorpActions} corp actions, +${stats.newTransfers} transfers, ` +
        `+${stats.newNavDays} NAV days`,
    );

    // 5) Save — pokud DRY_RUN, neukládá
    if (dryRun) {
      console.log(`🧪 DRY_RUN — KV se neaktualizuje. Skončeno.`);
      return { ok: true, dry_run: true, stats, parsed_counts: countParsed(parsed) };
    }

    // POZOR: newNavDays MUSÍ být v podmínce — v den bez obchodů/dividend by se
    // jinak denní NAV snapshot zahodil, a protože Flex vrací jen ~7denní okno,
    // vznikla by v grafu hodnoty portfolia trvalá díra (REVIZE_REPORT.md R3).
    if (stats.newTrades + stats.newCashTx + stats.newCorpActions + stats.newTransfers + stats.newNavDays > 0) {
      merged.last_import = new Date().toISOString();
      await env.AKCIE_TRACKER_KV.put(overlayKey, JSON.stringify(merged));
      console.log(`✅ Overlay uložen do KV (${overlayKey})`);
    } else {
      console.log(`ℹ️  Žádné nové položky, KV neaktualizováno.`);
    }

    return { ok: true, dry_run: false, stats };
  } catch (err) {
    console.error(`❌ Flex import selhal: ${err.message}`);
    console.error(err.stack);
    // Selhání musí být vidět — jinak je jediným signálem chybějící overlay
    // (posílá se jen pokud je nastaven RESEND_API_KEY + EMAIL_FROM/TO)
    await sendFailureEmail(env, "flex-import", err);
    return { ok: false, error: err.message };
  }
}

// ---------- Flex API (2-call flow) ----------
async function fetchFlexStatement(token, queryId) {
  if (!token) throw new Error("FLEX_TOKEN secret není nastaven");
  if (!queryId) throw new Error("FLEX_QUERY_ID není nastaveno");

  // 1) SendRequest → ReferenceCode  (s retry pro 530 a "try again shortly")
  const refCode = await sendRequestWithRetry(token, queryId);
  console.log(`🔑 ReferenceCode: ${refCode}`);

  // 2) GetStatement — s retry pokud Status=InProgress
  // IBKR generuje report obvykle 5-30 s; můžeme čekat až 90 s.
  const getUrl = `${FLEX_BASE}.GetStatement?t=${encodeURIComponent(token)}&q=${encodeURIComponent(refCode)}&v=3`;
  const maxAttempts = 6;
  const waitMs = 15000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(waitMs);
    console.log(`⏳ GetStatement attempt ${attempt}/${maxAttempts}…`);

    const res = await fetch(getUrl, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) {
      throw new Error(`GetStatement HTTP ${res.status}`);
    }
    const xml = await res.text();

    // Detekce "ještě se generuje"
    if (xml.includes("<ErrorCode>") && xml.includes("Statement generation in progress")) {
      console.log(`   ⏳ Statement se ještě generuje, čekám ${waitMs / 1000}s…`);
      continue;
    }
    // Detekce jiných chyb
    const errCode = matchTag(xml, "ErrorCode");
    if (errCode && !xml.includes("<FlexQueryResponse")) {
      const msg = matchTag(xml, "ErrorMessage") || "unknown";
      throw new Error(`GetStatement error code ${errCode}: ${msg}`);
    }
    // OK — máme report
    if (xml.includes("<FlexQueryResponse")) {
      return xml;
    }
    throw new Error(`Neočekávaný response: ${xml.slice(0, 200)}`);
  }
  throw new Error(`GetStatement timeout po ${maxAttempts} pokusech`);
}

// SendRequest s retry. IBKR občas vrací:
//  - HTTP 530 z CF edge (transient routing)
//  - HTTP 200 + Status=Fail + "Statement could not be generated at this time" (rate limit)
// Obě jsou dočasné, pokoušíme až 3× s exponential backoff (45s, 90s).
async function sendRequestWithRetry(token, queryId, maxAttempts = 3) {
  const sendUrl = `${FLEX_BASE}.SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const wait = 30000 * attempt; // 60s, 90s
      console.log(`   ⏳ Retry SendRequest #${attempt} za ${wait / 1000}s…`);
      await sleep(wait);
    }
    try {
      const res = await fetch(sendUrl, { headers: { "User-Agent": USER_AGENT } });

      // HTTP úroveň — 530 / 502 / 504 jsou transient, retry
      if (!res.ok) {
        const transient = [502, 503, 504, 522, 524, 530].includes(res.status);
        lastErr = new Error(`SendRequest HTTP ${res.status}`);
        if (transient && attempt < maxAttempts) {
          console.log(`   ⚠️  ${lastErr.message} (transient, retry)`);
          continue;
        }
        throw lastErr;
      }

      const xml = await res.text();
      const status = matchTag(xml, "Status");
      const refCode = matchTag(xml, "ReferenceCode");
      const errorMsg = matchTag(xml, "ErrorMessage");
      const errorCode = matchTag(xml, "ErrorCode");

      if (status === "Success" && refCode) {
        return refCode;
      }

      // 1001 = rate limit, "try again shortly" → retry
      const isTransient =
        errorCode === "1001" ||
        (errorMsg && /try again shortly/i.test(errorMsg));
      lastErr = new Error(
        `SendRequest selhal: code=${errorCode || "?"}, error=${errorMsg || "?"}`,
      );
      if (isTransient && attempt < maxAttempts) {
        console.log(`   ⚠️  ${lastErr.message} (transient, retry)`);
        continue;
      }
      throw lastErr;
    } catch (e) {
      lastErr = e;
      // Síťová chyba (DNS, TCP) — retry
      if (attempt < maxAttempts && /fetch|network|timeout/i.test(e.message)) {
        console.log(`   ⚠️  Network error ${e.message} (retry)`);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("SendRequest selhal po retry");
}

function matchTag(xml, tagName) {
  const m = xml.match(new RegExp(`<${tagName}>([^<]*)</${tagName}>`));
  return m ? m[1].trim() : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- XML parser ----------
// IBKR Flex XML používá self-closing tags s atributy:
//   <Trade accountId="…" symbol="…" tradeID="…" … />
// Parsujeme regexem na atributy — Worker nemá DOMParser ani snadný XML lib.

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

const NAV_FIELDS = [
  "currency", "reportDate", "cash", "stock", "total",
];

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
  // Najít všechny <TagName …/> nebo <TagName …>…</TagName>
  const regex = new RegExp(`<${tagName}\\s+([^>]+?)\\s*/?>`, "g");
  const items = [];
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const attrs = parseAttributes(m[1]);
    const item = {};
    for (const f of fields) {
      if (attrs[f] !== undefined) item[f] = attrs[f];
    }
    items.push(item);
  }
  return items;
}

function parseAttributes(s) {
  // Parsuje key="value" páry. Hodnoty jsou string; číselné konverze řeší overlay merger.
  const result = {};
  const regex = /([a-zA-Z][a-zA-Z0-9_]*)="([^"]*)"/g;
  let m;
  while ((m = regex.exec(s)) !== null) {
    result[m[1]] = decodeXmlEntities(m[2]);
  }
  return result;
}

// XML entity v hodnotách atributů ("Barnes &amp; Noble" → "Barnes & Noble").
// Pořadí: numerické → pojmenované → &amp; ÚPLNĚ NAPOSLED (jinak by se
// "&amp;lt;" chybně rozbalilo dvakrát).
function decodeXmlEntities(s) {
  if (!s.includes("&")) return s;
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
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

  // Indexy existujících záznamů podle dedupe klíčů
  const tradeIds = new Set(merged.trades.map((t) => t.tradeID));
  const cashTxIds = new Set(merged.cash_transactions.map((t) => t.transactionID));
  const corpActionIds = new Set(merged.corporate_actions.map((a) => a.actionID));
  const transferIds = new Set(merged.transfers.map((t) => t.transactionID));

  let newTrades = 0;
  let newCashTx = 0;
  let newCorpActions = 0;
  let newTransfers = 0;
  let newNavDays = 0;

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

  // Open Positions a M2M YTD — vždy přepsat aktuálním stavem (snapshot reality).
  merged.open_positions_snapshot = parsed.openPositions;
  merged.m2m_ytd = parsed.m2m;

  // NAV snapshot — AKUMULUJ historii (dedupe by reportDate), ať se nemažeme
  // 7-denní okno IBKR Flexu. Pro graf "Hodnota portfolia v čase" potřebujeme
  // co nejvíc dní.
  merged.nav_snapshot = merged.nav_snapshot || [];
  const navByDate = new Map(
    merged.nav_snapshot.map((n) => [n.reportDate, n]),
  );
  for (const n of parsed.nav) {
    if (!n.reportDate) continue;
    if (!navByDate.has(n.reportDate)) newNavDays++;
    navByDate.set(n.reportDate, n); // nový/přepíše stejné datum
  }
  merged.nav_snapshot = [...navByDate.values()].sort((a, b) =>
    (a.reportDate || "").localeCompare(b.reportDate || ""),
  );

  return {
    merged,
    stats: { newTrades, newCashTx, newCorpActions, newTransfers, newNavDays },
  };
}

function countParsed(parsed) {
  return {
    trades: parsed.trades.length,
    cash_transactions: parsed.cashTransactions.length,
    corporate_actions: parsed.corporateActions.length,
    transfers: parsed.transfers.length,
    open_positions: parsed.openPositions.length,
    nav_snapshots: parsed.nav.length,
    m2m_rows: parsed.m2m.length,
  };
}

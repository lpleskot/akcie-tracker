import {
  computePositions,
  unrealizedPnl,
  fmtNum,
  fmtPct,
  fmtMoney,
} from "./fifo.js";

const MANIFEST_URL = "./data/portfolios/manifest.json";
const PORTFOLIO_BASE = "./data/portfolios/";
const FX_URL = "./data/fx_rates.json";
// Watchlist + alerts jsou teď KV-backed přes Pages Functions
const WATCHLIST_URL = "/api/watchlist";
const ALERTS_URL = "/api/alerts";
const NOTES_URL = "/api/notes";
const JOURNAL_URL = "/api/journal";
const QUOTE_URL = "/api/quote";

// LocalStorage key pro pamatování posledního výběru portfolia
const LS_PORTFOLIO = "akcie-tracker.portfolio";

const state = {
  manifest: null,
  portfolioId: null,
  portfolio: null,
  positions: null,
  quotes: {},
  fxRates: null,
  view: "overview",
  sort: { key: "sym", dir: "asc" },
  txFilter: { from: null, to: null },
  reportFilter: { from: null, to: null },
  divFilter: { year: null },
  searches: {
    overview: "",
    allocation: "",
    watchlist: "",
    transactions: "",
    dividends: "",
  },
};

// Reusable search input setup — toggle × button + onChange callback
function setupSearchInput(inputId, clearId, stateKey, onChange) {
  const inp = document.getElementById(inputId);
  const clr = document.getElementById(clearId);
  if (!inp || !clr) return;
  function update() {
    state.searches[stateKey] = inp.value.trim().toLowerCase();
    clr.hidden = inp.value.length === 0;
    onChange();
  }
  inp.addEventListener("input", update);
  clr.addEventListener("click", () => {
    inp.value = "";
    update();
    inp.focus();
  });
}

const sortGetters = {
  sym: (r) => r.sym,
  name: (r) => r.inst.name,
  exchange: (r) => r.inst.exchange,
  currency: (r) => r.inst.currency,
  qty: (r) => r.pos.net_qty,
  avg_buy: (r) => r.pos.avg_open_price,
  current: (r) => (r.hasPrice ? r.currentPrice : -Infinity),
  cost: (r) => r.pos.cost_basis,
  value: (r) => (r.hasPrice ? r.marketValue : -Infinity),
  unrealized: (r) => (r.hasPrice ? r.unrealizedPnl : -Infinity),
  pnl: (r) => (r.hasPrice ? r.totalPnl : -Infinity),
  pct: (r) => (r.hasPrice ? r.totalPct : -Infinity),
};

// ---------- Bootstrap ----------
init().catch((err) => {
  console.error(err);
  showError(`Chyba při načítání: ${err.message}`);
});

async function init() {
  setStatus("Načítám manifest…");

  // 1) Load manifest, FX rates, watchlist, alerts, notes, journal paralelně
  const [manifestRes, fxRes, watchRes, alertsRes, notesRes, journalRes] = await Promise.all([
    fetch(MANIFEST_URL, { cache: "no-cache" }),
    fetch(FX_URL, { cache: "no-cache" }),
    fetch(WATCHLIST_URL, { cache: "no-cache" }),
    fetch(ALERTS_URL, { cache: "no-cache" }),
    fetch(NOTES_URL, { cache: "no-cache" }),
    fetch(JOURNAL_URL, { cache: "no-cache" }),
  ]);
  if (!manifestRes.ok) throw new Error(`Manifest ${manifestRes.status}`);
  state.manifest = await manifestRes.json();
  state.fxRates = fxRes.ok ? await fxRes.json() : { dates: {} };
  state.watchlist = watchRes.ok ? await watchRes.json() : { items: [] };
  state.alerts = alertsRes.ok ? await alertsRes.json() : { rules: [], fired: {} };
  const notesData = notesRes.ok ? await notesRes.json() : { notes: {} };
  state.notes = notesData.notes || {};
  state.journal = journalRes.ok ? await journalRes.json() : { entries: [] };
  state.journalSearch = "";
  state.journalEditingId = null;

  // 2) Vybrat aktivní portfolio (z localStorage nebo primary)
  const savedId = localStorage.getItem(LS_PORTFOLIO);
  const primary = state.manifest.portfolios.find((p) => p.primary);
  const found = state.manifest.portfolios.find((p) => p.id === savedId);
  state.portfolioId = found?.id || primary?.id || state.manifest.portfolios[0]?.id;

  // 3) Load aktivního portfolia
  await loadActivePortfolio();

  // 4) Setup UI + selector
  renderHeader();
  setupTabs();
  setupRefresh();
  setupSort();
  setupExpand();
  setupTxFilter();
  setupDivFilter();
  setupReportFilter();
  setupOverviewSearch();
  setupWatchlistModal();
  setupEditWatchModal();
  setupAlertsModal();
  setupJournal();
  setupPortfolioHistory();
  setupPortfolioSwitcher();

  // 5) Fetch live quotes
  await refreshQuotes();
}

async function loadActivePortfolio() {
  const meta = state.manifest.portfolios.find((p) => p.id === state.portfolioId);
  if (!meta) throw new Error(`Portfolio ${state.portfolioId} v manifestu nenalezeno`);
  setStatus(`Načítám ${meta.name}…`);
  const url = `${PORTFOLIO_BASE}${meta.file}`;

  // Paralelně načíst:
  //  1) Statický portfolio JSON (transakce, instrumenty, …)
  //  2) KV overlay (auto-import z Flex API) — optional
  //  3) Statický backfill NAV history (jednorázový z IBKR statementu + Yahoo)
  //     — pro graf "Hodnota portfolia v čase" pre-2026-06-06
  const [res, overlayRes, navHistoryRes] = await Promise.all([
    fetch(url, { cache: "no-cache" }),
    fetch(`/api/portfolio-overlay/${meta.id}`, { cache: "no-cache" }).catch(() => null),
    fetch(`${PORTFOLIO_BASE.replace("portfolios/", "")}portfolio-history-${meta.id}.json`, { cache: "no-cache" }).catch(() => null),
  ]);

  if (!res.ok) {
    // Portfolio nemusí ještě existovat (např. KB čeká na import)
    state.portfolio = makeEmptyPortfolio(meta);
    state.positions = {};
    state.overlayStats = null;
    return;
  }
  state.portfolio = await res.json();

  // Mergnout overlay (pokud existuje a má nějaká data)
  state.overlayStats = null;
  if (overlayRes && overlayRes.ok) {
    try {
      const overlay = await overlayRes.json();
      state.overlayStats = mergeOverlayIntoPortfolio(state.portfolio, overlay);
    } catch (e) {
      console.warn(`Overlay merge selhal: ${e.message}`);
    }
  }

  // Static NAV history backfill (jednorázový seed z IBKR Activity Statement)
  // Mergne se s overlay nav_history v renderPortfolioHistory.
  state.portfolio.static_nav_history = [];
  state.portfolio.static_deposits = [];
  if (navHistoryRes && navHistoryRes.ok) {
    try {
      const histData = await navHistoryRes.json();
      state.portfolio.static_nav_history = histData.nav_history || [];
      state.portfolio.static_deposits = histData.deposits || [];
    } catch (e) {
      console.warn(`NAV history load selhal: ${e.message}`);
    }
  }

  state.positions = computePositions(
    state.portfolio.transactions || [],
    state.portfolio.corporate_actions || [],
    state.portfolio.dividends || [],
    state.portfolio.withholding_tax || [],
  );
}

/**
 * Mergne KV overlay (Flex API import) do načteného portfolia.
 * Overlay obsahuje data z IBKR Flex Web Service v jejich nativním
 * tvaru. Tahle funkce je transformuje do shape, který používá
 * statický JSON + FIFO engine, a dedupuje proti existujícím IDs.
 *
 * Vrací { trades, dividends, withholding, corp_actions, cash_flows }
 * — počty NOVĚ přidaných záznamů pro UI indikátor.
 */
function mergeOverlayIntoPortfolio(portfolio, overlay) {
  const stats = {
    trades: 0,
    dividends: 0,
    withholding: 0,
    corp_actions: 0,
    cash_flows: 0,
    last_import: overlay.last_import || null,
  };

  // Zajistit existenci polí na portfolio objektu
  portfolio.transactions = portfolio.transactions || [];
  portfolio.dividends = portfolio.dividends || [];
  portfolio.withholding_tax = portfolio.withholding_tax || [];
  portfolio.corporate_actions = portfolio.corporate_actions || [];
  portfolio.cash_flows = portfolio.cash_flows || [];
  portfolio.instruments = portfolio.instruments || {};
  portfolio.cash_balance = { ...(portfolio.cash_balance || {}) };

  // NAV snapshot historie z overlay (denní hodnoty z IBKR Flex)
  // — pro graf "Hodnota portfolia v čase"
  portfolio.nav_history = overlay.nav_snapshot || [];

  // Indexy pro dedupe podle Flex ID (uložené v `flex_id` poli)
  const existingTradeIds = new Set(
    portfolio.transactions.map((t) => t.flex_id).filter(Boolean),
  );
  const existingDivIds = new Set(
    portfolio.dividends.map((d) => d.flex_id).filter(Boolean),
  );
  const existingWithholdingIds = new Set(
    portfolio.withholding_tax.map((w) => w.flex_id).filter(Boolean),
  );
  const existingCaIds = new Set(
    portfolio.corporate_actions.map((a) => a.flex_id).filter(Boolean),
  );
  const existingCfIds = new Set(
    portfolio.cash_flows.map((f) => f.flex_id).filter(Boolean),
  );

  // Tracking delt na cash balance, aplikované jen pro Flex-imported události
  // (static cash_balance je už zafixovaný snapshot, nové eventy se k němu přičítají).
  const addCash = (ccy, amount) => {
    if (!ccy || !Number.isFinite(amount)) return;
    if (portfolio.cash_balance[ccy] == null) portfolio.cash_balance[ccy] = 0;
    portfolio.cash_balance[ccy] += amount;
  };

  // 1) Trades — cash impact = netCash (signed: + sell, − buy, již po komisi)
  for (const t of overlay.trades || []) {
    if (!t.tradeID || existingTradeIds.has(t.tradeID)) continue;
    const symbol = t.symbol;
    if (!symbol) continue;
    ensureInstrument(portfolio, symbol, t);
    portfolio.transactions.push(transformFlexTrade(t));
    existingTradeIds.add(t.tradeID);
    stats.trades++;
    // Cash delta — netCash je už proceeds + commission (signed)
    const netCash = parseFloat(t.netCash);
    if (Number.isFinite(netCash)) addCash(t.currency, netCash);
  }

  // 2) Cash transactions — split do dividends / withholding / cash_flows
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
      addCash(c.currency, amt); // dividenda = inflow
    } else if (/Withholding/i.test(type)) {
      if (existingWithholdingIds.has(c.transactionID)) continue;
      portfolio.withholding_tax.push(transformFlexWithholding(c));
      existingWithholdingIds.add(c.transactionID);
      stats.withholding++;
      addCash(c.currency, amt); // withholding amount je už negativní (outflow)
    } else {
      // Deposits/Withdrawals, Other Fees, Broker Interest, … → cash_flows
      if (existingCfIds.has(c.transactionID)) continue;
      portfolio.cash_flows.push(transformFlexCashFlow(c));
      existingCfIds.add(c.transactionID);
      stats.cash_flows++;
      addCash(c.currency, amt); // amount je už signed

      // Pokud je to deposit/withdrawal, aktualizovat i total_deposits_usd —
      // bez tohoto by se procento výnosu uměle nafouklo (cash by se přičetl
      // do current value, ale jmenovatel deposits by zůstal stejný).
      if (
        /Deposits.*Withdrawals|Account Transfers|Internal Transfers/i.test(type)
      ) {
        const date = flexDate(c.dateTime || c.reportDate);
        const usdAmt = convertToUsd(amt, c.currency, date);
        if (Number.isFinite(usdAmt)) {
          portfolio.total_deposits_usd =
            (portfolio.total_deposits_usd || 0) + usdAmt;
        }
      }
    }
  }

  // 3) Corporate actions
  for (const a of overlay.corporate_actions || []) {
    if (!a.actionID || existingCaIds.has(a.actionID)) continue;
    ensureInstrument(portfolio, a.symbol, a);
    portfolio.corporate_actions.push(transformFlexCorpAction(a));
    existingCaIds.add(a.actionID);
    stats.corp_actions++;
    // Některé CA mají cash složku (cash-in-lieu apod.)
    const proc = parseFloat(a.proceeds);
    if (Number.isFinite(proc) && proc !== 0) addCash(a.currency, proc);
  }

  return stats;
}

// Vytvoří záznam o instrumentu, pokud ještě v portfolio.instruments neexistuje.
function ensureInstrument(portfolio, symbol, flexRow) {
  if (!symbol || portfolio.instruments[symbol]) return;
  portfolio.instruments[symbol] = {
    yahoo_symbol: symbol,           // pro IBKR je Flex symbol = Yahoo symbol
    isin: flexRow.isin || null,
    name: flexRow.description || symbol,
    currency: flexRow.currency || "USD",
    exchange: flexRow.listingExchange || null,
    _auto_added: true,              // marker, ať víme že přišel z Flex auto-importu
  };
}

// Přepočet částky z lokální měny na USD pomocí ČNB kurzů.
// Pokud kurz pro dané datum neexistuje, fallback na nejnovější dostupný.
// Pokud měna je USD nebo kurzy nemáme, vrátí původní amount.
function convertToUsd(amount, currency, date) {
  if (!Number.isFinite(amount)) return NaN;
  if (currency === "USD") return amount;
  if (!state.fxRates?.dates) return NaN;
  const allDates = Object.keys(state.fxRates.dates).sort();
  if (allDates.length === 0) return NaN;
  // Použít kurz k datu transakce, jinak nejnovější
  const useDate =
    date && state.fxRates.dates[date] ? date : allDates[allDates.length - 1];
  const ccyToCzk = getFxToCzk(useDate, currency);
  const usdToCzk = getFxToCzk(useDate, "USD");
  if (!ccyToCzk || !usdToCzk) return NaN;
  return (amount * ccyToCzk) / usdToCzk;
}

// Flex datum yyyyMMdd → "yyyy-MM-dd"
function flexDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

// Flex dateTime "yyyyMMdd;HHmmss" → time část "HH:MM:SS"
function flexTime(s) {
  if (!s) return null;
  const m = String(s).match(/[;\s](\d{2})(\d{2})(\d{2})/);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : null;
}

function transformFlexTrade(t) {
  const qtyRaw = parseFloat(t.quantity);
  // Buy/Sell — IBKR Flex má buySell="BUY"|"SELL" a quantity je signovaný.
  // Pro náš JSON drží quantity vždy kladné, type rozhoduje směr.
  const type = t.buySell === "SELL" ? "SELL" : "BUY";
  const proceeds = parseFloat(t.proceeds);
  const commission = parseFloat(t.ibCommission);
  return {
    id: `flex-trade-${t.tradeID}`,
    flex_id: t.tradeID,
    date: flexDate(t.tradeDate || t.dateTime),
    time: flexTime(t.dateTime),
    symbol: t.symbol,
    type,
    quantity: Math.abs(qtyRaw),
    price: parseFloat(t.tradePrice),
    proceeds: proceeds,
    commission: commission,
    currency: t.currency,
    _source: "flex",
  };
}

function transformFlexDividend(c) {
  return {
    id: `flex-div-${c.transactionID}`,
    flex_id: c.transactionID,
    date: flexDate(c.dateTime || c.reportDate),
    symbol: c.symbol,
    amount: parseFloat(c.amount),
    currency: c.currency,
    per_share: null, // Flex neuvádí explicitně per share, pouze total amount
    type: c.dividendType || "Regular",
    _source: "flex",
  };
}

function transformFlexWithholding(c) {
  return {
    id: `flex-wh-${c.transactionID}`,
    flex_id: c.transactionID,
    date: flexDate(c.dateTime || c.reportDate),
    symbol: c.symbol,
    amount: parseFloat(c.amount),
    currency: c.currency,
    country: null,
    _source: "flex",
  };
}

function transformFlexCashFlow(c) {
  return {
    id: `flex-cf-${c.transactionID}`,
    flex_id: c.transactionID,
    date: flexDate(c.dateTime || c.reportDate),
    type: c.type,
    amount: parseFloat(c.amount),
    currency: c.currency,
    description: c.description || c.code || "",
    _source: "flex",
  };
}

function transformFlexCorpAction(a) {
  return {
    id: `flex-ca-${a.actionID}`,
    flex_id: a.actionID,
    date: flexDate(a.dateTime || a.reportDate),
    symbol: a.symbol,
    type: a.type,
    description: a.actionDescription || a.description || "",
    quantity: parseFloat(a.quantity) || 0,
    amount: parseFloat(a.amount) || 0,
    proceeds: parseFloat(a.proceeds) || 0,
    cost_basis: parseFloat(a.costBasis) || 0,
    currency: a.currency,
    _source: "flex",
  };
}

function makeEmptyPortfolio(meta) {
  return {
    id: meta.id,
    name: meta.name,
    broker: meta.broker,
    account: "",
    instruments: {},
    transactions: [],
    corporate_actions: [],
    dividends: [],
    withholding_tax: [],
    cash_flows: [],
    cash_balance: {},
    _placeholder: true,
  };
}

function setupPortfolioSwitcher() {
  const list = state.manifest.portfolios || [];
  if (list.length < 2) return; // jediné portfolio — selector neukazujeme

  const wrap = document.getElementById("portfolio-switcher");
  const sel = document.getElementById("portfolio-select");
  if (!sel || !wrap) return;
  sel.innerHTML = "";
  for (const p of list) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  sel.value = state.portfolioId;
  wrap.hidden = false;

  sel.addEventListener("change", async () => {
    state.portfolioId = sel.value;
    localStorage.setItem(LS_PORTFOLIO, state.portfolioId);
    state.quotes = {}; // invalidate
    await loadActivePortfolio();
    renderHeader();
    await refreshQuotes();
  });
}

// ---------- Header ----------
function renderHeader() {
  const p = state.portfolio;
  document.getElementById("portfolio-name").textContent = p.name;

  // Hlavička: broker + account holder + account number, NIC víc.
  // Statické počty/období z gitového JSON byly matoucí — overlay je upravuje
  // a uživatel viděl zastaralá čísla.
  const parts = [p.broker];
  if (p.account_holder) parts.push(p.account_holder);
  if (p.account) parts.push(`účet ${p.account}`);
  if (p.customer_type) parts.push(p.customer_type);
  if (p._placeholder) {
    parts.push("⏳ data se připravují");
  }

  // Jediný status indikátor: kdy proběhl poslední auto-import (cron z IBKR Flex).
  const ov = state.overlayStats;
  if (ov?.last_import) {
    const lastImport = new Date(ov.last_import).toLocaleString("cs-CZ", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
    parts.push(`🔄 poslední import ${lastImport}`);
  }

  document.getElementById("portfolio-meta").textContent = parts.join(" · ");
  document.title = `${p.name} — Akcie tracker`;
}

// ---------- Tabs ----------
function setupTabs() {
  const setTabSpecificButtons = (view) => {
    // "Export pro účetní" jen na Transakce
    const accBtn = document.getElementById("btn-export-accounting");
    if (accBtn) accBtn.hidden = view !== "transactions";
  };
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view;
      state.view = view;
      document.querySelectorAll(".tab").forEach((t) =>
        t.classList.toggle("active", t.dataset.view === view),
      );
      document.querySelectorAll(".view").forEach((v) =>
        v.classList.toggle("active", v.id === `view-${view}`),
      );
      setTabSpecificButtons(view);
    });
  });
  // Initial state
  setTabSpecificButtons(state.view || "overview");
}

function setupRefresh() {
  document.getElementById("btn-refresh").addEventListener("click", () => {
    refreshQuotes().catch((err) => showError(err.message));
  });
  document.getElementById("btn-export-xlsx").addEventListener("click", () => {
    exportCurrentViewXlsx();
  });
  document.getElementById("btn-export-accounting")?.addEventListener("click", () => {
    exportTransactionsAccountingXlsx();
  });
}

function setupSort() {
  document.querySelectorAll("#tbl-overview th.sortable").forEach((th) => {
    th.addEventListener("click", (e) => {
      // Klik na info ikonu nemá triggerovat sort
      if (e.target.classList.contains("hint")) return;
      const key = th.dataset.sortKey;
      const isNumeric = th.classList.contains("num");
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort.key = key;
        // Číselné sloupce: první klik = desc (největší první), text. = asc (abecedně)
        state.sort.dir = isNumeric ? "desc" : "asc";
      }
      renderOverview();
    });
  });
}

// ---------- Quotes ----------
async function refreshQuotes() {
  const symbols = Object.values(state.portfolio.instruments).map(
    (i) => i.yahoo_symbol,
  );
  setStatus(`Načítám ceny pro ${symbols.length} titulů…`);

  const url = `${QUOTE_URL}?symbols=${encodeURIComponent(symbols.join(","))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Quote API ${res.status}`);
  const data = await res.json();
  state.quotes = data.quotes;
  state.quotesFetchedAt = data.fetched_at;

  // Pre-fetch quotes pro symboly ve watchlistu (nedrží je, ale chceme cenu)
  const portfolioSyms = Object.values(state.portfolio.instruments).map(
    (i) => i.yahoo_symbol,
  );
  const watchSyms = (state.watchlist?.items || [])
    .map((w) => w.yahoo_symbol)
    .filter((s) => s && !portfolioSyms.includes(s));
  if (watchSyms.length > 0) {
    try {
      const wRes = await fetch(
        `${QUOTE_URL}?symbols=${encodeURIComponent(watchSyms.join(","))}`,
      );
      if (wRes.ok) {
        const wData = await wRes.json();
        Object.assign(state.quotes, wData.quotes);
      }
    } catch (e) {
      console.warn("Watchlist quotes fetch failed", e);
    }
  }

  setStatus(null);
  renderOverview();
  renderAllocation();
  renderWatchlist();
  renderAlerts();
  renderTransactions();
  renderDividends();
  renderReport();
  renderJournal();
  renderPortfolioHistory();
  renderSummary();
}

// ---------- Modal helpers ----------
function openModal(id) {
  const m = document.getElementById(id);
  if (m) {
    m.hidden = false;
    // Focus first input
    const inp = m.querySelector("input, select");
    if (inp) inp.focus();
  }
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.hidden = true;
}
function setupModalClose(id) {
  const m = document.getElementById(id);
  if (!m) return;
  // Close on backdrop click
  m.addEventListener("click", (e) => {
    if (e.target === m) closeModal(id);
  });
  // Close on data-close buttons
  m.querySelectorAll("[data-close]").forEach((b) =>
    b.addEventListener("click", () => closeModal(id)),
  );
  // ESC key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !m.hidden) closeModal(id);
  });
}

// ---------- Watchlist modal + reload ----------
function setupWatchlistModal() {
  document
    .getElementById("btn-add-watch")
    ?.addEventListener("click", () => {
      // Reset form
      const f = document.getElementById("form-add-watch");
      if (f) f.reset();
      document.getElementById("watch-error").textContent = "";
      // Skrýt nápovědnou tabulku burz, dokud na ni uživatel neklikne
      const help = document.getElementById("exchange-suffixes-help");
      const helpLink = document.getElementById("link-exchange-suffixes");
      if (help) help.hidden = true;
      if (helpLink) helpLink.textContent = "zobrazit kompletní tabulku";
      openModal("modal-add-watch");
    });
  setupModalClose("modal-add-watch");

  // Checkbox toggle — pravidlo volitelné
  const enableRule = document.getElementById("rule-enable-watch");
  const ruleFields = document.getElementById("rule-fields-watch");
  enableRule?.addEventListener("change", () => {
    ruleFields.hidden = !enableRule.checked;
  });

  // Toggle vstupů podle typu pravidla
  const typeSel = document.getElementById("rule-type-watch");
  const valueWrap = document.getElementById("rule-value-wrap");
  const refWrap = document.getElementById("rule-ref-wrap");
  const thresholdWrap = document.getElementById("rule-threshold-wrap");
  function syncRuleFields() {
    const t = typeSel.value;
    if (t === "drop_pct") {
      valueWrap.hidden = true;
      refWrap.hidden = false;
      thresholdWrap.hidden = false;
    } else {
      valueWrap.hidden = false;
      refWrap.hidden = true;
      thresholdWrap.hidden = true;
    }
  }
  typeSel?.addEventListener("change", syncRuleFields);
  syncRuleFields();

  // Submit
  document
    .getElementById("form-add-watch")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const symbol = fd.get("symbol").trim();
      if (!symbol) {
        showWatchError("Vyplň ticker");
        return;
      }

      const rules = [];
      // Pravidlo se přidá jen pokud uživatel zaškrtl checkbox
      if (enableRule?.checked) {
        const type = fd.get("rule_type");
        const rule = { type, armed: true };
        if (type === "drop_pct") {
          rule.ref_price = parseFloat(fd.get("rule_ref_price"));
          const rawThreshold = parseFloat(fd.get("rule_threshold"));
          // Normalizace: pokles ukládáme vždy záporně (např. -5 = pokles o 5 %).
          rule.threshold_pct = -Math.abs(rawThreshold);
          if (isNaN(rule.ref_price) || isNaN(rule.threshold_pct)) {
            showWatchError("Vyplň referenční cenu i pokles %");
            return;
          }
        } else {
          rule.value = parseFloat(fd.get("rule_value"));
          if (isNaN(rule.value)) {
            showWatchError("Vyplň hodnotu pravidla (nebo odškrtni checkbox)");
            return;
          }
        }
        rules.push(rule);
      }

      try {
        const res = await fetch(WATCHLIST_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "add",
            symbol,
            yahoo_symbol: symbol,
            rules,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          showWatchError(data.error || `HTTP ${res.status}`);
          return;
        }
        closeModal("modal-add-watch");
        await reloadWatchlist();
      } catch (err) {
        showWatchError(err.message);
      }
    });
}

function showWatchError(msg) {
  const el = document.getElementById("watch-error");
  if (el) el.textContent = msg;
}

async function reloadWatchlist() {
  const res = await fetch(WATCHLIST_URL, { cache: "no-cache" });
  if (res.ok) {
    state.watchlist = await res.json();
    // Re-fetch quotes pro nové symboly
    const have = new Set(Object.keys(state.quotes));
    const need = (state.watchlist.items || [])
      .map((w) => w.yahoo_symbol)
      .filter((s) => s && !have.has(s));
    if (need.length > 0) {
      try {
        const qRes = await fetch(
          `${QUOTE_URL}?symbols=${encodeURIComponent(need.join(","))}`,
        );
        if (qRes.ok) {
          const qData = await qRes.json();
          Object.assign(state.quotes, qData.quotes);
        }
      } catch {}
    }
    renderWatchlist();
  }
}

// ---------- Alerts modal + reload ----------
function setupAlertsModal() {
  document.getElementById("btn-add-alert")?.addEventListener("click", () => {
    const f = document.getElementById("form-add-alert");
    if (f) f.reset();
    document.getElementById("alert-error").textContent = "";
    // Naplnit symbol dropdown držených pozic
    const sel = document.getElementById("alert-symbol");
    if (sel) {
      sel.innerHTML = "";
      const syms = Object.keys(state.positions || {})
        .filter((s) => state.positions[s].net_qty > 0)
        .sort();
      for (const s of syms) {
        const o = document.createElement("option");
        o.value = s;
        o.textContent = `${s} — ${state.portfolio.instruments[s]?.name || ""}`;
        sel.appendChild(o);
      }
    }
    openModal("modal-add-alert");
  });
  setupModalClose("modal-add-alert");

  // Toggle symbol dropdown
  const alertType = document.getElementById("alert-type");
  const symbolWrap = document.getElementById("alert-symbol-wrap");
  function syncAlertFields() {
    const t = alertType.value;
    symbolWrap.hidden = t !== "drop_from_buy";
  }
  alertType?.addEventListener("change", syncAlertFields);
  syncAlertFields();

  // Submit
  document
    .getElementById("form-add-alert")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const type = fd.get("alert_type");
      const threshold = parseFloat(fd.get("alert_threshold"));
      const desc = fd.get("alert_desc")?.trim();
      if (isNaN(threshold)) {
        document.getElementById("alert-error").textContent =
          "Vyplň pokles v %";
        return;
      }
      const rule = {
        type,
        scope: "owned",
        threshold_pct: threshold,
        armed: true,
        description:
          desc ||
          `${type === "drop_from_buy_all" ? "Jakákoliv pozice" : type === "drop_from_52w_high" ? "52w high" : fd.get("alert_symbol")} pokles ≥ ${Math.abs(threshold)}%`,
      };
      if (type === "drop_from_buy") {
        rule.symbol = fd.get("alert_symbol");
        if (!rule.symbol) {
          document.getElementById("alert-error").textContent =
            "Vyber ticker";
          return;
        }
      }
      try {
        const res = await fetch(ALERTS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "add", rule }),
        });
        const data = await res.json();
        if (!res.ok) {
          document.getElementById("alert-error").textContent =
            data.error || `HTTP ${res.status}`;
          return;
        }
        closeModal("modal-add-alert");
        await reloadAlerts();
      } catch (err) {
        document.getElementById("alert-error").textContent = err.message;
      }
    });
}

async function reloadAlerts() {
  const res = await fetch(ALERTS_URL, { cache: "no-cache" });
  if (res.ok) {
    state.alerts = await res.json();
    renderAlerts();
  }
}

// ---------- Edit Watchlist Modal ----------
let editingWatchId = null;

function openEditWatch(id) {
  const item = (state.watchlist?.items || []).find((x) => x.id === id);
  if (!item) return;
  editingWatchId = id;

  document.getElementById("edit-watch-title").textContent =
    `Upravit pravidla — ${item.symbol}`;
  document.getElementById("edit-watch-subtitle").textContent =
    `${item.name || ""} · ${item.currency || ""}`;
  document.getElementById("edit-watch-error").textContent = "";

  const container = document.getElementById("edit-watch-rules");
  container.innerHTML = "";
  for (const rule of item.rules || []) {
    container.appendChild(buildRuleRow(rule));
  }
  if ((item.rules || []).length === 0) {
    container.innerHTML =
      '<div class="muted small" style="margin: 8px 0 4px;">Žádné pravidlo. Přidejte níže.</div>';
  }

  openModal("modal-edit-watch");
}

function buildRuleRow(rule = {}) {
  const row = document.createElement("div");
  row.className = "rule-row";
  row.innerHTML = `
    <select class="rule-type">
      <option value="price_below" ${rule.type === "price_below" ? "selected" : ""}>Cena pod X</option>
      <option value="price_above" ${rule.type === "price_above" ? "selected" : ""}>Cena nad X</option>
      <option value="drop_pct" ${rule.type === "drop_pct" ? "selected" : ""}>Pokles % od ref. ceny</option>
    </select>
    <input class="rule-value" type="number" step="0.0001" placeholder="hodnota" value="${rule.value ?? ""}" />
    <input class="rule-ref" type="number" step="0.0001" placeholder="ref cena" value="${rule.ref_price ?? ""}" />
    <input class="rule-threshold" type="number" step="0.1" placeholder="pokles %" value="${rule.threshold_pct ?? ""}" />
    <button type="button" class="btn-clear rule-remove" title="Odebrat pravidlo">×</button>
  `;
  // Toggle visibility per type
  const typeSel = row.querySelector(".rule-type");
  const valueInp = row.querySelector(".rule-value");
  const refInp = row.querySelector(".rule-ref");
  const thrInp = row.querySelector(".rule-threshold");
  function sync() {
    if (typeSel.value === "drop_pct") {
      valueInp.style.display = "none";
      refInp.style.display = "";
      thrInp.style.display = "";
    } else {
      valueInp.style.display = "";
      refInp.style.display = "none";
      thrInp.style.display = "none";
    }
  }
  typeSel.addEventListener("change", sync);
  sync();
  row.querySelector(".rule-remove").addEventListener("click", () => {
    row.remove();
  });
  return row;
}

function setupEditWatchModal() {
  setupModalClose("modal-edit-watch");
  document.getElementById("btn-add-rule-row")?.addEventListener("click", () => {
    const c = document.getElementById("edit-watch-rules");
    // pokud tam je "Žádné pravidlo" hint, smazat
    if (c.querySelector(".muted")) c.innerHTML = "";
    c.appendChild(buildRuleRow());
  });
  document.getElementById("btn-save-watch")?.addEventListener("click", async () => {
    if (!editingWatchId) return;
    const rows = document.querySelectorAll("#edit-watch-rules .rule-row");
    const rules = [];
    for (const row of rows) {
      const type = row.querySelector(".rule-type").value;
      const r = { type, armed: true };
      if (type === "drop_pct") {
        r.ref_price = parseFloat(row.querySelector(".rule-ref").value);
        const rawThreshold = parseFloat(row.querySelector(".rule-threshold").value);
        // Normalizace: pokles ukládáme vždy záporně.
        r.threshold_pct = -Math.abs(rawThreshold);
        if (isNaN(r.ref_price) || isNaN(r.threshold_pct)) {
          document.getElementById("edit-watch-error").textContent =
            "Vyplň referenční cenu i pokles % u všech drop_pct pravidel.";
          return;
        }
      } else {
        r.value = parseFloat(row.querySelector(".rule-value").value);
        if (isNaN(r.value)) {
          document.getElementById("edit-watch-error").textContent =
            "Vyplň hodnotu u všech cena_pod/cena_nad pravidel.";
          return;
        }
      }
      rules.push(r);
    }
    const res = await fetch(WATCHLIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", id: editingWatchId, rules }),
    });
    if (res.ok) {
      closeModal("modal-edit-watch");
      editingWatchId = null;
      await reloadWatchlist();
    } else {
      const d = await res.json();
      document.getElementById("edit-watch-error").textContent =
        d.error || `HTTP ${res.status}`;
    }
  });
}

// Globální delegovaný handler pro Delete/Re-arm/Edit tlačítka
// Akční menu (⋯) — fixed-position dropdown, ať nemůže být oříznuto
// .table-wrap overflow: auto.
function positionActionMenu(toggle, menu) {
  const rect = toggle.getBoundingClientRect();
  // Dočasně zobrazit, aby šlo změřit rozměry
  menu.style.visibility = "hidden";
  menu.hidden = false;
  const menuRect = menu.getBoundingClientRect();
  menu.hidden = true;
  menu.style.visibility = "";

  // Defaultně pod toggle, zarovnáno k pravému okraji
  let top = rect.bottom + 4;
  let left = rect.right - menuRect.width;
  // Pokud by přesahovalo dolní okraj viewportu, otevři nad
  if (top + menuRect.height > window.innerHeight - 8) {
    top = rect.top - menuRect.height - 4;
  }
  if (left < 8) left = 8;
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

document.addEventListener("click", (e) => {
  const toggle = e.target.closest?.(".action-menu-toggle");
  // Zavřít všechna otevřená menu kromě toho, na které se klikne
  document.querySelectorAll(".action-menu-items").forEach((m) => {
    if (toggle && m === toggle.parentElement.querySelector(".action-menu-items")) {
      return;
    }
    m.hidden = true;
    const t = m.parentElement?.querySelector?.(".action-menu-toggle");
    if (t) t.setAttribute("aria-expanded", "false");
  });
  if (toggle) {
    const menu = toggle.parentElement.querySelector(".action-menu-items");
    const willOpen = menu.hidden;
    if (willOpen) {
      positionActionMenu(toggle, menu);
      menu.hidden = false;
    } else {
      menu.hidden = true;
    }
    toggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
    e.stopPropagation();
  }
});
// Zavřít menu při scrollu nebo resize (jinak by zůstalo "viset" v původní pozici)
window.addEventListener("scroll", () => {
  document.querySelectorAll(".action-menu-items").forEach((m) => (m.hidden = true));
}, true);
window.addEventListener("resize", () => {
  document.querySelectorAll(".action-menu-items").forEach((m) => (m.hidden = true));
});
// Klik na položku v menu → zavřít menu (akce se vykoná v existujícím delegovaném handleru)
document.addEventListener("click", (e) => {
  const item = e.target.closest?.(".action-menu-items button");
  if (item) {
    const menu = item.closest(".action-menu-items");
    if (menu) menu.hidden = true;
    const toggle = menu?.parentElement.querySelector(".action-menu-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }
});

// Zobrazit/skrýt tabulku burzovních suffixů pod inputem ve Watchlist Add
document.getElementById("link-exchange-suffixes")?.addEventListener("click", (e) => {
  e.preventDefault();
  const help = document.getElementById("exchange-suffixes-help");
  if (!help) return;
  const willShow = help.hidden;
  help.hidden = !willShow;
  e.target.textContent = willShow
    ? "skrýt tabulku"
    : "zobrazit kompletní tabulku";
});

document.addEventListener("click", async (e) => {
  const t = e.target;
  // Deník — Upravit / Uložit / Zrušit / Smazat
  if (t.matches?.("[data-journal-edit]")) {
    state.journalEditingId = t.dataset.journalEdit;
    renderJournal();
    setTimeout(() => {
      const ta = document.querySelector(`.journal-entry[data-id="${state.journalEditingId}"] .journal-edit-text`);
      ta?.focus();
    }, 30);
    return;
  }
  if (t.matches?.("[data-journal-cancel]")) {
    state.journalEditingId = null;
    renderJournal();
    return;
  }
  if (t.matches?.("[data-journal-save]")) {
    const id = t.dataset.journalSave;
    const card = t.closest(".journal-entry");
    const text = card.querySelector(".journal-edit-text").value.trim();
    const errEl = card.querySelector(".journal-edit-error");
    errEl.textContent = "";
    if (!text) {
      errEl.textContent = "Prázdný zápis nelze uložit.";
      return;
    }
    try {
      const res = await journalUpdate(id, text);
      const data = await res.json();
      if (!res.ok) {
        errEl.textContent = data.error || `HTTP ${res.status}`;
        return;
      }
      const entry = state.journal.entries.find((x) => x.id === id);
      if (entry) entry.text = data.entry.text;
      state.journalEditingId = null;
      renderJournal();
    } catch (err) {
      errEl.textContent = `Síťová chyba: ${err.message}`;
    }
    return;
  }
  if (t.matches?.("[data-journal-delete]")) {
    const id = t.dataset.journalDelete;
    if (!confirm("Smazat tento zápis z deníku?")) return;
    try {
      const res = await journalDelete(id);
      if (!res.ok) {
        alert("Smazání selhalo.");
        return;
      }
      state.journal.entries = state.journal.entries.filter((x) => x.id !== id);
      if (state.journalEditingId === id) state.journalEditingId = null;
      renderJournal();
    } catch (err) {
      alert(`Síťová chyba: ${err.message}`);
    }
    return;
  }
  // Poznámka — klik na "i" ikonku nebo na button "Poznámka" / "Upravit poznámku"
  if (t.matches?.("[data-note-edit]")) {
    e.stopPropagation();
    openNoteModal(t.dataset.noteEdit);
    return;
  }
  if (t.matches?.("[data-note-edit-symbol]")) {
    e.stopPropagation();
    openNoteModal(t.dataset.noteEditSymbol);
    return;
  }
  if (t.matches?.("[data-watch-edit]")) {
    openEditWatch(t.dataset.watchEdit);
    return;
  }
  if (t.matches?.("[data-watch-delete]")) {
    const id = t.dataset.watchDelete;
    if (!confirm("Smazat ticker z watchlistu?")) return;
    const res = await fetch(WATCHLIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id }),
    });
    if (res.ok) await reloadWatchlist();
  }
  if (t.matches?.("[data-watch-mark]")) {
    const id = t.dataset.watchMark;
    const price = parseFloat(t.dataset.currentPrice);
    if (isNaN(price) || price <= 0) {
      alert("Aktuální cena není k dispozici, nelze označit.");
      return;
    }
    const item = (state.watchlist?.items || []).find((x) => x.id === id);
    const isUpdate = item?.benchmark?.price != null;
    if (isUpdate && !confirm(
      `Přepsat dosavadní benchmark ${fmtNum(item.benchmark.price, 2)} (${item.benchmark.date}) na aktuální ${fmtNum(price, 2)}?`,
    )) return;
    const res = await fetch(WATCHLIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "set_benchmark",
        id,
        price,
        date: new Date().toISOString().slice(0, 10),
        currency: item?.currency || null,
      }),
    });
    if (res.ok) await reloadWatchlist();
  }
  if (t.matches?.("[data-watch-unmark]")) {
    const id = t.dataset.watchUnmark;
    if (!confirm("Zrušit označenou referenční cenu?")) return;
    const res = await fetch(WATCHLIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear_benchmark", id }),
    });
    if (res.ok) await reloadWatchlist();
  }
  if (t.matches?.("[data-alert-delete]")) {
    const id = t.dataset.alertDelete;
    if (!confirm("Smazat alert pravidlo?")) return;
    const res = await fetch(ALERTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id }),
    });
    if (res.ok) await reloadAlerts();
  }
  if (t.matches?.("[data-alert-rearm]")) {
    const id = t.dataset.alertRearm;
    const res = await fetch(ALERTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rearm", id }),
    });
    if (res.ok) await reloadAlerts();
  }
});

// ---------- Watchlist ----------
function renderWatchlist() {
  const allItems = state.watchlist?.items || [];
  const q = state.searches.watchlist;
  const items = q
    ? allItems.filter((it) => {
        const h = `${it.symbol} ${it.name || ""}`.toLowerCase();
        return h.includes(q);
      })
    : allItems;
  const count = document.getElementById("watchlist-count");
  const empty = document.getElementById("watchlist-empty");
  const wrap = document.getElementById("watchlist-wrap");
  const tbody = document.querySelector("#tbl-watchlist tbody");
  if (!tbody) return;

  if (count) {
    if (allItems.length === 0) {
      count.textContent = "prázdný";
    } else if (items.length === allItems.length) {
      count.textContent = `${allItems.length} ticker${allItems.length === 1 ? "" : allItems.length < 5 ? "y" : "ů"}`;
    } else {
      count.textContent = `${items.length} z ${allItems.length}`;
    }
  }
  if (allItems.length === 0) {
    if (empty) empty.style.display = "block";
    if (wrap) wrap.style.display = "none";
    return;
  }
  if (empty) empty.style.display = "none";
  if (wrap) wrap.style.display = "";

  tbody.innerHTML = "";
  for (const it of items) {
    const quote = state.quotes[it.yahoo_symbol] || {};
    const price = quote.price;
    const ccy = quote.currency || "?";
    const rules = it.rules || [];

    const rulesHtml = rules
      .map((r) => {
        if (r.type === "price_below") {
          const met = price != null && price < r.value;
          return `<span class="${met ? "neg" : "muted"}">cena < ${fmtNum(r.value, 2)} ${ccy}</span>`;
        }
        if (r.type === "price_above") {
          const met = price != null && price > r.value;
          return `<span class="${met ? "pos" : "muted"}">cena > ${fmtNum(r.value, 2)} ${ccy}</span>`;
        }
        if (r.type === "drop_pct") {
          const change =
            price != null && r.ref_price
              ? ((price - r.ref_price) / r.ref_price) * 100
              : null;
          // "Pokles ≥ X%" znamená cena klesla o X% i více → change ≤ -X.
          // threshold_pct akceptujeme kladně i záporně, počítáme magnitudu.
          const dropMagnitude = -Math.abs(r.threshold_pct);
          const met = change != null && change <= dropMagnitude;
          return `<span class="${met ? "neg" : "muted"}">pokles ≥ ${Math.abs(r.threshold_pct)}% od ${fmtNum(r.ref_price, 2)} (${change != null ? fmtPct(change) : "?"})</span>`;
        }
        return `<span class="muted">${escapeHtml(r.type)}</span>`;
      })
      .join(" · ");

    const anyMet = rules.some((r) => {
      if (price == null) return false;
      if (r.type === "price_below") return price < r.value;
      if (r.type === "price_above") return price > r.value;
      if (r.type === "drop_pct" && r.ref_price) {
        const change = ((price - r.ref_price) / r.ref_price) * 100;
        return change <= -Math.abs(r.threshold_pct);
      }
      return false;
    });

    // Benchmark display
    let benchmarkCell = '<span class="muted">—</span>';
    let deltaCell = '<span class="muted">—</span>';
    if (it.benchmark && it.benchmark.price != null) {
      benchmarkCell = `${fmtNum(it.benchmark.price, 2)}<br><span class="benchmark-tooltip">${it.benchmark.date}</span>`;
      if (price != null) {
        const delta = price - it.benchmark.price;
        const deltaPct = (delta / it.benchmark.price) * 100;
        deltaCell = `<span class="${signClass(delta)}">${fmtNum(delta, 2)} ${ccy}</span><br><span class="${signClass(delta)} benchmark-tooltip">${fmtPct(deltaPct)}</span>`;
      }
    }

    // Action button label — "Označit cenu" / "Aktualizovat" / "Zrušit"
    const hasBench = !!(it.benchmark && it.benchmark.price != null);
    const markLabel = hasBench ? "Aktualizovat značku" : "Označit cenu";
    const markDisabled = price == null ? "disabled" : "";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="symbol">${it.symbol}${noteIconHtml(it.symbol)}</td>
      <td>${escapeHtml(it.name || quote.name || "")}</td>
      <td>${ccy}</td>
      <td class="num">${price != null ? fmtNum(price, 2) : '<span class="muted">—</span>'}</td>
      <td class="num">${benchmarkCell}</td>
      <td class="num">${deltaCell}</td>
      <td>${rulesHtml || '<span class="muted">žádné pravidlo</span>'}</td>
      <td>${anyMet ? '<span class="badge sell">SPLNĚNO</span>' : '<span class="muted">armed</span>'}</td>
      <td>
        <div class="action-menu">
          <button class="btn-action action-menu-toggle" type="button" aria-haspopup="true" aria-expanded="false" title="Zobrazit akce">⋯</button>
          <ul class="action-menu-items" role="menu" hidden>
            <li><button type="button" role="menuitem" data-watch-mark="${it.id}" data-current-price="${price ?? ''}" ${markDisabled}>${markLabel}</button></li>
            ${hasBench ? `<li><button type="button" role="menuitem" data-watch-unmark="${it.id}">Zrušit značku</button></li>` : ""}
            <li><button type="button" role="menuitem" data-watch-edit="${it.id}">Upravit pravidla</button></li>
            <li><button type="button" role="menuitem" data-note-edit-symbol="${it.symbol}">Poznámka</button></li>
            <li class="separator"></li>
            <li><button type="button" role="menuitem" class="danger" data-watch-delete="${it.id}">Smazat z watchlistu</button></li>
          </ul>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

// ---------- Alerts (na držené pozice) ----------
function renderAlerts() {
  const rules = state.alerts?.rules || [];
  const container = document.getElementById("alerts-content");
  const count = document.getElementById("alerts-count");
  if (!container) return;
  container.innerHTML = "";
  if (count) {
    count.textContent =
      rules.length === 0
        ? "žádné"
        : `${rules.length} pravidl${rules.length === 1 ? "o" : rules.length < 5 ? "a" : ""}`;
  }

  if (rules.length === 0) {
    container.innerHTML = `<div class="status">Žádná pravidla. Až bude backend, přidáte je přes formulář.</div>`;
    return;
  }

  for (const rule of rules) {
    const card = document.createElement("div");
    card.className = "report-event";
    let header = `<strong>${escapeHtml(rule.description || rule.id)}</strong>`;
    const armedBadge = rule.armed
      ? `<span class="badge buy">armed</span>`
      : `<span class="badge sell">disabled</span>`;
    let html = `
      <div class="report-event-header">
        <span>${header}</span>
        <span>
          ${armedBadge}
          <button class="btn-action" data-alert-rearm="${rule.id}" title="Smaže fired stav — pravidlo bude znovu odpalovat při příští kontrole">Re-arm</button>
          <button class="btn-action danger" data-alert-delete="${rule.id}">Smazat</button>
        </span>
      </div>
    `;

    // Vyhodnotit kdo by aktuálně splnil
    const matches = evaluateRule(rule);

    if (matches.length === 0) {
      html += `<div style="padding:12px 18px;" class="muted">Aktuálně žádný titul nesplňuje toto pravidlo. ✓</div>`;
    } else {
      html += `<table><thead><tr><th>Symbol</th><th>Název</th><th class="num">Současná cena</th><th class="num">Ø nákup</th><th class="num">Změna</th></tr></thead><tbody>`;
      for (const m of matches) {
        html += `
          <tr>
            <td class="symbol">${m.symbol}</td>
            <td>${escapeHtml(m.name)}</td>
            <td class="num">${fmtNum(m.current, 2)} ${m.currency}</td>
            <td class="num">${fmtNum(m.reference, 2)} ${m.currency}</td>
            <td class="num neg"><strong>${fmtPct(m.changePct)}</strong></td>
          </tr>`;
      }
      html += `</tbody></table>`;
      html += `<div style="padding:8px 18px;" class="muted">Pokud by cron běžel teď: <strong>${matches.length} ${matches.length === 1 ? "alert" : matches.length < 5 ? "alerty" : "alertů"}</strong> by se odeslalo.</div>`;
    }
    card.innerHTML = html;
    container.appendChild(card);
  }
}

function evaluateRule(rule) {
  const matches = [];
  if (rule.type === "drop_from_buy_all" && rule.scope === "owned") {
    for (const sym in state.positions) {
      const pos = state.positions[sym];
      if (!pos || pos.net_qty === 0) continue;
      const inst = state.portfolio.instruments[sym];
      const quote = state.quotes[inst.yahoo_symbol] || {};
      if (quote.price == null) continue;
      const change =
        ((quote.price - pos.avg_open_price) / pos.avg_open_price) * 100;
      if (change <= -Math.abs(rule.threshold_pct)) {
        matches.push({
          symbol: sym,
          name: inst.name,
          currency: inst.currency,
          current: quote.price,
          reference: pos.avg_open_price,
          changePct: change,
        });
      }
    }
  }
  if (rule.type === "drop_from_buy" && rule.symbol) {
    const sym = rule.symbol;
    const pos = state.positions[sym];
    const inst = state.portfolio.instruments[sym];
    if (pos && pos.net_qty > 0 && inst) {
      const quote = state.quotes[inst.yahoo_symbol] || {};
      if (quote.price != null) {
        const change =
          ((quote.price - pos.avg_open_price) / pos.avg_open_price) * 100;
        if (change <= -Math.abs(rule.threshold_pct)) {
          matches.push({
            symbol: sym,
            name: inst.name,
            currency: inst.currency,
            current: quote.price,
            reference: pos.avg_open_price,
            changePct: change,
          });
        }
      }
    }
  }
  // Setřídit dle největšího propadu
  matches.sort((a, b) => a.changePct - b.changePct);
  return matches;
}

// ---------- Deník investora ----------
function setupJournal() {
  // Vyhledávání
  const search = document.getElementById("journal-search");
  const clear = document.getElementById("journal-search-clear");
  search?.addEventListener("input", (e) => {
    state.journalSearch = e.target.value;
    clear.hidden = !e.target.value;
    renderJournal();
  });
  clear?.addEventListener("click", () => {
    search.value = "";
    state.journalSearch = "";
    clear.hidden = true;
    renderJournal();
    search.focus();
  });

  // Přidat zápis
  document.getElementById("btn-journal-add")?.addEventListener("click", async () => {
    const ta = document.getElementById("journal-new-text");
    const errEl = document.getElementById("journal-new-error");
    errEl.textContent = "";
    const text = ta.value.trim();
    if (!text) {
      errEl.textContent = "Napiš něco — zápis nemůže být prázdný.";
      return;
    }
    try {
      const res = await fetch(JOURNAL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", text }),
      });
      const data = await res.json();
      if (!res.ok) {
        errEl.textContent = data.error || `HTTP ${res.status}`;
        return;
      }
      state.journal.entries.push(data.entry);
      ta.value = "";
      renderJournal();
    } catch (e) {
      errEl.textContent = `Síťová chyba: ${e.message}`;
    }
  });

  // Cmd/Ctrl + Enter v textarea = uložit
  document.getElementById("journal-new-text")?.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      document.getElementById("btn-journal-add").click();
    }
  });
}

function renderJournal() {
  const list = document.getElementById("journal-list");
  const countEl = document.getElementById("journal-count");
  if (!list) return;

  const entries = (state.journal?.entries || []).slice();
  // Chronologicky, nejnovější nahoře
  entries.sort((a, b) => b.date.localeCompare(a.date));

  // Filtr podle hledaného textu
  const q = state.journalSearch.trim().toLowerCase();
  const filtered = q
    ? entries.filter((e) => e.text.toLowerCase().includes(q))
    : entries;

  if (countEl) {
    if (entries.length === 0) {
      countEl.textContent = "";
    } else if (q && filtered.length !== entries.length) {
      countEl.textContent = `${filtered.length} z ${entries.length} zápisů`;
    } else {
      countEl.textContent = `${entries.length} zápis${entries.length === 1 ? "" : entries.length < 5 ? "y" : "ů"}`;
    }
  }

  list.innerHTML = "";

  if (entries.length === 0) {
    list.innerHTML = `<div class="status">Zatím žádné zápisy. Napiš první nahoře.</div>`;
    return;
  }
  if (filtered.length === 0) {
    list.innerHTML = `<div class="status">Žádný zápis neodpovídá hledanému textu „${escapeHtml(q)}".</div>`;
    return;
  }

  for (const entry of filtered) {
    const card = document.createElement("div");
    card.className = "journal-entry";
    card.dataset.id = entry.id;

    if (state.journalEditingId === entry.id) {
      // Edit režim — inline textarea
      card.innerHTML = `
        <div class="journal-entry-header">
          <span class="journal-date">${formatJournalDate(entry.date)}</span>
          <span class="muted small">(úprava)</span>
        </div>
        <textarea class="journal-edit-text" rows="4" maxlength="10000">${escapeHtml(entry.text)}</textarea>
        <div class="journal-entry-actions">
          <span class="muted small journal-edit-error"></span>
          <button class="btn" data-journal-cancel="${entry.id}">Zrušit</button>
          <button class="btn primary" data-journal-save="${entry.id}">Uložit</button>
        </div>
      `;
    } else {
      // Read režim
      card.innerHTML = `
        <div class="journal-entry-header">
          <span class="journal-date">${formatJournalDate(entry.date)}</span>
          <div class="journal-entry-buttons">
            <button class="btn-action" data-journal-edit="${entry.id}">Upravit</button>
            <button class="btn-icon-x" data-journal-delete="${entry.id}" title="Smazat zápis" aria-label="Smazat">×</button>
          </div>
        </div>
        <div class="journal-text">${escapeHtml(entry.text)}</div>
      `;
    }
    list.appendChild(card);
  }
}

function formatJournalDate(iso) {
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString("cs-CZ", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    const time = d.toLocaleTimeString("cs-CZ", {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${date} · ${time}`;
  } catch {
    return iso;
  }
}

async function journalUpdate(id, text) {
  const res = await fetch(JOURNAL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update", id, text }),
  });
  return res;
}

async function journalDelete(id) {
  const res = await fetch(JOURNAL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", id }),
  });
  return res;
}

// ---------- Hodnota portfolia (NAV time-series) ----------
function setupPortfolioHistory() {
  state.phPeriod = state.phPeriod || "ALL";
  const chips = document.querySelectorAll("#ph-period-chips .filter-chip");
  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      state.phPeriod = chip.dataset.period;
      chips.forEach((c) => c.classList.toggle("active", c === chip));
      renderPortfolioHistory();
    });
  });
}

/**
 * Stav ke konci roku — pro každý uzavřený rok poslední dostupný NAV
 * snapshot (poslední obchodní den). Hodnota v originální měně účtu
 * + přepočet do CZK kurzem ČNB k datu snapshotu (ne k dnešku).
 * Účetní potřebuje stav k 31.12. — proto fixní tabulka mimo period filtr.
 */
function renderPhYearEnd(navRaw) {
  const wrap = document.getElementById("ph-year-end-wrap");
  const tbody = document.querySelector("#tbl-ph-year-end tbody");
  if (!wrap || !tbody) return;

  // navRaw je seřazené vzestupně → poslední záznam roku vyhraje
  const lastByYear = new Map();
  for (const n of navRaw) lastByYear.set(n.date.slice(0, 4), n);

  const currentYear = new Date().toISOString().slice(0, 4);
  const rows = [...lastByYear.entries()]
    .filter(([y]) => y < currentYear)
    .sort((a, b) => b[0].localeCompare(a[0]));

  if (rows.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  tbody.innerHTML = "";
  for (const [y, n] of rows) {
    const ccy = n.currency || "USD";
    const fx = getFxToCzk(n.date, ccy, { allowFallback: true });
    const czk = fx != null ? n.value_usd * fx : null;
    tbody.innerHTML += `
      <tr>
        <td><strong>${y}</strong></td>
        <td class="num">${n.date}</td>
        <td class="num"><strong>${fmtNum(n.value_usd, 2)} ${ccy}</strong></td>
        <td class="num">${fx != null ? fmtNum(fx, 3) : '<span class="muted">—</span>'}</td>
        <td class="num">${czk != null ? fmtNum(czk, 0) : '<span class="muted">—</span>'}</td>
      </tr>
    `;
  }
}

function renderPortfolioHistory() {
  const p = state.portfolio;
  const chartEl = document.getElementById("ph-chart");
  const tbody = document.querySelector("#tbl-ph tbody");
  const countEl = document.getElementById("ph-count");
  if (!chartEl || !tbody) return;

  // 1) Sebrat NAV snapshoty ze DVOU zdrojů:
  //    - static_nav_history = jednorázový backfill z IBKR Activity Statement
  //      (Python script + Yahoo historical, viz outputs/backfill_nav.py)
  //    - nav_history (overlay) = denní cron z IBKR Flex Web Service
  //    Dedupe po reportDate, overlay (čerstvější) má prioritu pro stejné datum.
  const navByDate = new Map();
  const ingest = (arr, source) => {
    for (const n of arr || []) {
      if (!n.reportDate || n.total == null) continue;
      const date = flexDate(n.reportDate);
      const value_usd = parseFloat(n.total);
      if (!date || !Number.isFinite(value_usd)) continue;
      // Pokud už máme záznam pro to datum, prioritu má 'overlay' (čerstvější data)
      const existing = navByDate.get(date);
      if (!existing || source === "overlay") {
        navByDate.set(date, {
          date,
          value_usd,
          cash_usd: parseFloat(n.cash || 0),
          stock_usd: parseFloat(n.stock || 0),
          currency: n.currency || "USD",
          source,
        });
      }
    }
  };
  ingest(p?.static_nav_history || [], "static");
  ingest(p?.nav_history || [], "overlay");
  const navRaw = [...navByDate.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  // 2) Filtr období
  const period = state.phPeriod || "ALL";
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = computePeriodCutoff(today, period);
  const nav = cutoff ? navRaw.filter((n) => n.date >= cutoff) : navRaw;

  // 3) Identifikace dní s vkladem — DVA zdroje:
  //    a) p.static_deposits[] = backfill z IBKR Activity Statement (historicky)
  //    b) p.cash_flows[] (filtr na Deposits typu) = z Flex overlay (nové)
  const depositsByDate = new Map();
  const addDep = (date, amount, currency) => {
    if (!date || !Number.isFinite(amount) || amount === 0) return;
    if (!depositsByDate.has(date)) depositsByDate.set(date, []);
    depositsByDate.get(date).push({ amount, currency });
  };
  for (const d of p?.static_deposits || []) {
    addDep(d.date, parseFloat(d.amount), d.currency);
  }
  for (const f of p?.cash_flows || []) {
    if (!f.date) continue;
    if (!/Deposits.*Withdrawals|Account Transfers|Internal Transfers/i.test(f.type || "")) {
      continue;
    }
    // Dedupe: pokud už máme stejný den + amount, neduplikovat
    const amt = parseFloat(f.amount);
    const existing = depositsByDate.get(f.date) || [];
    const dup = existing.some((e) => Math.abs(e.amount - amt) < 0.01 && e.currency === f.currency);
    if (!dup) addDep(f.date, amt, f.currency);
  }

  // 4) Globální (all-time) dlaždice — pevné, nezávislé na zvoleném období
  renderPhGlobalTiles(navRaw, p, depositsByDate);

  // 4b) Stav ke konci roku — podklad pro účetnictví, nezávislý na období
  renderPhYearEnd(navRaw);

  // 5) Vykreslit chart (SVG line s deposit markery) — pro zvolené období
  chartEl.innerHTML = renderNavChartSvg(nav, depositsByDate);

  // 6) Souhrnné dlaždice pro období (start, end, change, deposits in period)
  renderPhTiles(nav, depositsByDate);

  // 6) Tabulka den po dni (nejnovější nahoře)
  countEl.textContent =
    nav.length === 0 ? "" : `${nav.length} dní v období`;
  tbody.innerHTML = "";

  if (nav.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="status">Žádná historická data NAV. Jakmile cron několik dní poběží, data tady budou. <br><br>Tip: dočasně rozšiř Flex Query v IBKR portálu na 90 dní pro rychlý backfill — viz instrukce v chatu.</td></tr>`;
    return;
  }

  const fxUsdToCzk = (date) => getFxToCzk(date, "USD", { allowFallback: true });

  // V tabulce chronologicky obráceně (nejnovější nahoře)
  for (let i = nav.length - 1; i >= 0; i--) {
    const n = nav[i];
    const prev = i > 0 ? nav[i - 1] : null;
    const fx = fxUsdToCzk(n.date);
    const valueCzk = fx ? n.value_usd * fx : null;
    const dayDelta =
      prev != null ? n.value_usd - prev.value_usd : null;
    const dayDeltaCzk = dayDelta != null && fx ? dayDelta * fx : null;
    const dayDeltaPct =
      prev != null && prev.value_usd > 0
        ? (dayDelta / prev.value_usd) * 100
        : null;

    const deps = depositsByDate.get(n.date);
    const noteHtml = deps
      ? `<span class="ph-deposit-note">💰 vklad ${deps.map((d) => `${fmtNum(d.amount, 2)} ${d.currency}`).join(", ")}</span>`
      : "";

    const rowClass = deps ? ' class="ph-row-deposit"' : "";
    tbody.innerHTML += `
      <tr${rowClass}>
        <td>${n.date}</td>
        <td class="num">${valueCzk != null ? fmtNum(valueCzk, 0) : '<span class="muted">—</span>'}</td>
        <td class="num">${fmtNum(n.value_usd, 0)}</td>
        <td class="num ${signClass(dayDeltaCzk)}">${dayDeltaCzk != null ? (dayDeltaCzk > 0 ? "+" : "") + fmtNum(dayDeltaCzk, 0) : '<span class="muted">—</span>'}</td>
        <td class="num ${signClass(dayDeltaPct)}">${dayDeltaPct != null ? fmtPct(dayDeltaPct) : '<span class="muted">—</span>'}</td>
        <td>${noteHtml}</td>
      </tr>
    `;
  }
}

/**
 * Globální (all-time) dlaždice — nezávislé na zvoleném období filtru:
 *  - Celkem vloženo (suma všech depositů od inception, v USD a CZK)
 *  - Aktuální hodnota portfolia (poslední záznam v NAV historii)
 *  - Rozdíl = current − deposits (kolik jsi vydělal/ztratil oproti tomu co jsi vložil)
 */
function renderPhGlobalTiles(navRaw, p, depositsByDateMap) {
  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  // Total deposits — sečíst VŠECHNY (historické + Flex overlay), dedupe by (date+amount+ccy)
  let totalDepositsUsd = 0;
  for (const [date, deps] of depositsByDateMap) {
    for (const d of deps) {
      const usd =
        d.currency === "USD" ? d.amount : convertToUsd(d.amount, d.currency, date);
      if (Number.isFinite(usd)) totalDepositsUsd += usd;
    }
  }

  // Current NAV = poslední záznam v navRaw (bez ohledu na filtr)
  const last = navRaw.length > 0 ? navRaw[navRaw.length - 1] : null;
  const currentNavUsd = last ? last.value_usd : 0;
  const currentDate = last ? last.date : null;
  const fxToday = currentDate
    ? getFxToCzk(currentDate, "USD", { allowFallback: true })
    : null;

  const fmtMoney = (usd) => {
    if (fxToday != null) return `${fmtNum(usd * fxToday, 0)} Kč`;
    return `${fmtNum(usd, 0)} USD`;
  };

  setText("ph-total-deposits-czk", fmtMoney(totalDepositsUsd));
  setText("ph-total-deposits-usd", `${fmtNum(totalDepositsUsd, 0)} USD ekv.`);

  setText("ph-current-nav-czk", fmtMoney(currentNavUsd));
  setText("ph-current-nav-usd", `${fmtNum(currentNavUsd, 0)} USD ekv.`);

  // Diff
  const diffUsd = currentNavUsd - totalDepositsUsd;
  const diffCzk = fxToday != null ? diffUsd * fxToday : null;
  const diffPct =
    totalDepositsUsd > 0 ? (diffUsd / totalDepositsUsd) * 100 : 0;

  const diffEl = document.getElementById("ph-net-diff-czk");
  if (diffEl) {
    const prefix = diffUsd > 0 ? "+" : "";
    diffEl.textContent =
      diffCzk != null
        ? `${prefix}${fmtNum(diffCzk, 0)} Kč`
        : `${prefix}${fmtNum(diffUsd, 0)} USD`;
    diffEl.className = `ph-tile-value ${signClass(diffUsd)}`;
  }
  const pctEl = document.getElementById("ph-net-diff-pct");
  if (pctEl) {
    pctEl.textContent = `${diffUsd > 0 ? "+" : ""}${diffPct.toFixed(2)} %`;
    pctEl.className = `ph-tile-sub ${signClass(diffUsd)}`;
  }
}

function renderPhTiles(nav, depositsByDate) {
  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  if (nav.length === 0) {
    ["ph-start-value", "ph-start-date", "ph-end-value", "ph-end-date",
     "ph-change-value", "ph-change-pct", "ph-deposits-value", "ph-deposits-count"]
      .forEach((id) => setText(id, "—"));
    return;
  }
  const start = nav[0];
  const end = nav[nav.length - 1];
  const fxStart = getFxToCzk(start.date, "USD", { allowFallback: true });
  const fxEnd = getFxToCzk(end.date, "USD", { allowFallback: true });
  const startCzk = fxStart ? start.value_usd * fxStart : null;
  const endCzk = fxEnd ? end.value_usd * fxEnd : null;
  const changeUsd = end.value_usd - start.value_usd;
  const changeCzk = endCzk != null && startCzk != null ? endCzk - startCzk : null;
  const changePct =
    start.value_usd > 0 ? (changeUsd / start.value_usd) * 100 : 0;

  setText("ph-start-value", startCzk != null ? `${fmtNum(startCzk, 0)} Kč` : `${fmtNum(start.value_usd, 0)} USD`);
  setText("ph-start-date", start.date);
  setText("ph-end-value", endCzk != null ? `${fmtNum(endCzk, 0)} Kč` : `${fmtNum(end.value_usd, 0)} USD`);
  setText("ph-end-date", end.date);

  const changeEl = document.getElementById("ph-change-value");
  if (changeEl) {
    changeEl.textContent = changeCzk != null ? `${changeCzk > 0 ? "+" : ""}${fmtNum(changeCzk, 0)} Kč` : `${changeUsd > 0 ? "+" : ""}${fmtNum(changeUsd, 0)} USD`;
    changeEl.className = `ph-tile-value ${signClass(changeCzk ?? changeUsd)}`;
  }
  setText("ph-change-pct", `${changePct > 0 ? "+" : ""}${changePct.toFixed(2)} %`);

  // Vklady v období — sečíst všechny v daterange (start..end), per currency
  let depCountInRange = 0;
  let depTotalUsd = 0;
  for (const [date, deps] of depositsByDate) {
    if (date < start.date || date > end.date) continue;
    for (const d of deps) {
      depCountInRange++;
      // Hrubý přepočet na USD pro souhrn
      if (d.currency === "USD") depTotalUsd += d.amount;
      else {
        const usd = convertToUsd(d.amount, d.currency, date);
        if (Number.isFinite(usd)) depTotalUsd += usd;
      }
    }
  }
  setText("ph-deposits-value", `${fmtNum(depTotalUsd, 0)} USD`);
  setText("ph-deposits-count", `${depCountInRange} transakc${depCountInRange === 1 ? "e" : depCountInRange < 5 ? "í" : "í"}`);
}

function renderNavChartSvg(nav, depositsByDate) {
  if (nav.length < 2) {
    return `<div class="ph-chart-empty">Graf vyžaduje aspoň 2 data points. Aktuálně máme ${nav.length}.</div>`;
  }

  const W = 1200;
  const H = 320;
  const padL = 70, padR = 20, padT = 16, padB = 32;

  const xs = nav.map((n) => new Date(n.date).getTime());
  const ys = nav.map((n) => n.value_usd);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const yPad = (yMax - yMin) * 0.08 || yMax * 0.05 || 1;
  const yLo = yMin - yPad, yHi = yMax + yPad;

  const sx = (t) =>
    padL + ((t - xMin) / (xMax - xMin || 1)) * (W - padL - padR);
  const sy = (v) => H - padB - ((v - yLo) / (yHi - yLo || 1)) * (H - padT - padB);

  // Line path
  const path = nav
    .map((n, i) => `${i === 0 ? "M" : "L"}${sx(new Date(n.date).getTime()).toFixed(1)},${sy(n.value_usd).toFixed(1)}`)
    .join(" ");

  // Area under line (subtle gradient fill)
  const areaPath =
    `M${sx(xs[0]).toFixed(1)},${(H - padB).toFixed(1)} ` +
    nav.map((n) => `L${sx(new Date(n.date).getTime()).toFixed(1)},${sy(n.value_usd).toFixed(1)}`).join(" ") +
    ` L${sx(xs[xs.length - 1]).toFixed(1)},${(H - padB).toFixed(1)} Z`;

  // Deposit markers — větší zelené tečky + tenká vertikální vodící čára,
  // ať jsou opravdu vidět (i u depozitů, kde NAV moc nepokleslo).
  const depositMarkers = nav
    .filter((n) => depositsByDate.has(n.date))
    .map((n) => {
      const x = sx(new Date(n.date).getTime());
      const y = sy(n.value_usd);
      const deps = depositsByDate.get(n.date);
      const total = deps.reduce((s, d) => s + d.amount, 0);
      const ccy = deps[0]?.currency || "USD";
      const tip = `Vklad ${n.date}: +${total.toLocaleString("cs-CZ", { maximumFractionDigits: 0 })} ${ccy}`;
      return `
        <line x1="${x.toFixed(1)}" y1="${(padT).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(H - padB).toFixed(1)}" stroke="var(--color-positive)" stroke-width="1" stroke-opacity="0.3" stroke-dasharray="2,3" />
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="var(--color-positive)" stroke="#fff" stroke-width="2.5"><title>${tip}</title></circle>
      `;
    })
    .join("");

  // Y-axis ticks (5 segments)
  const yTicks = [];
  for (let i = 0; i <= 4; i++) {
    const v = yLo + (i / 4) * (yHi - yLo);
    const y = sy(v);
    yTicks.push(`
      <line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="#eee" stroke-dasharray="3,3" />
      <text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#888">${fmtNum(v / 1000, 0)}K USD</text>
    `);
  }

  // X-axis labels (start, middle, end)
  const xTicks = [];
  const tickPositions = [0, Math.floor(nav.length / 2), nav.length - 1];
  for (const idx of [...new Set(tickPositions)]) {
    const n = nav[idx];
    const x = sx(new Date(n.date).getTime());
    xTicks.push(`<text x="${x.toFixed(1)}" y="${(H - padB + 18).toFixed(1)}" text-anchor="middle" font-size="11" fill="#888">${n.date}</text>`);
  }

  return `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="ph-chart-svg" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="ph-grad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="var(--color-accent)" stop-opacity="0.25" />
          <stop offset="100%" stop-color="var(--color-accent)" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${yTicks.join("")}
      <path d="${areaPath}" fill="url(#ph-grad)" />
      <path d="${path}" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      ${depositMarkers}
      ${xTicks.join("")}
    </svg>
  `;
}

function computePeriodCutoff(today, period) {
  const d = new Date(`${today}T00:00:00Z`);
  if (period === "1M") d.setUTCMonth(d.getUTCMonth() - 1);
  else if (period === "3M") d.setUTCMonth(d.getUTCMonth() - 3);
  else if (period === "6M") d.setUTCMonth(d.getUTCMonth() - 6);
  else if (period === "1Y") d.setUTCFullYear(d.getUTCFullYear() - 1);
  else return null; // ALL
  return d.toISOString().slice(0, 10);
}

// ---------- Allocation ----------
function renderAllocation() {
  const tbody = document.querySelector("#tbl-allocation tbody");
  const tfoot = document.getElementById("tfoot-allocation");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (tfoot) tfoot.innerHTML = "";

  // Najít nejnovější ČNB datum
  const fxDates = state.fxRates?.dates
    ? Object.keys(state.fxRates.dates).sort()
    : [];
  const todayFxDate = fxDates[fxDates.length - 1] || null;
  const fxUsdToCzk = todayFxDate ? getFxToCzk(todayFxDate, "USD") : null;

  // Spočítat váhy z CELÉHO portfolia (váha musí být relativní k portfoliu, ne k filtru)
  const allRows = [];
  let sumValueUsd = 0;
  let sumInvestedUsd = 0;
  for (const sym of Object.keys(state.portfolio.instruments)) {
    const pos = state.positions[sym];
    if (!pos || pos.net_qty === 0) continue;
    const inst = state.portfolio.instruments[sym];
    const ccy = inst.currency;
    const ccyToCzk = todayFxDate ? getFxToCzk(todayFxDate, ccy) : null;
    if (ccyToCzk == null || fxUsdToCzk == null) continue;
    const quote = state.quotes[inst.yahoo_symbol] || {};
    const valueLocal =
      quote.price != null ? pos.net_qty * quote.price : null;
    const valueUsd =
      valueLocal != null ? (valueLocal * ccyToCzk) / fxUsdToCzk : null;
    const investedUsd = (pos.total_invested * ccyToCzk) / fxUsdToCzk;
    if (valueUsd != null) sumValueUsd += valueUsd;
    sumInvestedUsd += investedUsd;
    allRows.push({
      sym,
      inst,
      pos,
      valueLocal,
      valueUsd,
      investedUsd,
    });
  }
  // Aplikovat search filter pro display (váhy zůstávají z plného portfolia)
  const q = state.searches.allocation;
  const rows = q
    ? allRows.filter((r) => {
        const h = `${r.sym} ${r.inst.name}`.toLowerCase();
        return h.includes(q);
      })
    : allRows;
  // Counter
  const allocCount = document.getElementById("allocation-count");
  if (allocCount) {
    allocCount.textContent =
      rows.length === allRows.length
        ? `${allRows.length} pozic`
        : `${rows.length} z ${allRows.length} pozic`;
  }

  // Dopočítat váhy NA allRows (relativní k plnému portfoliu)
  for (const r of allRows) {
    r.weightValue =
      sumValueUsd > 0 && r.valueUsd != null
        ? (r.valueUsd / sumValueUsd) * 100
        : null;
    r.weightInvested =
      sumInvestedUsd > 0 ? (r.investedUsd / sumInvestedUsd) * 100 : 0;
    r.delta =
      r.weightValue != null ? r.weightValue - r.weightInvested : null;
  }

  // Setřídit FILTROVANÉ řádky podle aktuální váhy desc
  rows.sort((a, b) => (b.weightValue ?? 0) - (a.weightValue ?? 0));

  // Maximální hodnota pro normalizaci bar widths — z plného portfolia
  const maxWeight = Math.max(
    ...allRows.map((r) => Math.max(r.weightValue ?? 0, r.weightInvested ?? 0)),
    1,
  );

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="symbol">${r.sym}</td>
      <td>${escapeHtml(r.inst.name)}</td>
      <td>${r.inst.currency}</td>
      <td class="num">${r.valueUsd != null ? fmtNum(r.valueUsd, 0) : '<span class="muted">—</span>'}</td>
      <td class="num"><strong>${r.weightValue != null ? fmtPct(r.weightValue, 2) : '<span class="muted">—</span>'}</strong></td>
      <td><div class="alloc-bar-wrap"><div class="alloc-bar-fill" style="width: ${r.weightValue != null ? Math.min(100, (r.weightValue / maxWeight) * 100) : 0}%"></div></div></td>
      <td class="num">${fmtNum(r.investedUsd, 0)}</td>
      <td class="num"><strong>${fmtPct(r.weightInvested, 2)}</strong></td>
      <td><div class="alloc-bar-wrap"><div class="alloc-bar-fill cost" style="width: ${Math.min(100, (r.weightInvested / maxWeight) * 100)}%"></div></div></td>
      <td class="num ${signClass(r.delta)}">${r.delta != null ? fmtPct(r.delta, 2) : '<span class="muted">—</span>'}</td>
    `;
    tbody.appendChild(tr);
  }

  if (tfoot) {
    tfoot.innerHTML = `
      <tr>
        <td colspan="3">Celkem portfolio (${allRows.length} pozic)</td>
        <td class="num"><strong>${fmtNum(sumValueUsd, 0)}</strong></td>
        <td class="num"><strong>100,00 %</strong></td>
        <td></td>
        <td class="num"><strong>${fmtNum(sumInvestedUsd, 0)}</strong></td>
        <td class="num"><strong>100,00 %</strong></td>
        <td></td>
        <td></td>
      </tr>
    `;
  }
}

// ---------- FX rate lookup ----------
// Strict by default: vrátí null, když pro dané datum kurz neexistuje
// (např. víkend, svátek, datum mimo dostupné rozmezí). Pro účetní
// report je to správné chování — nesmíme vyrábět falešné kurzy.
//
// Volitelný 3. argument `{ allowFallback: true }` zapne forward-fill na
// nejbližší předchozí datum (vhodné jen pro interní hrubé přepočty,
// např. odhad USD ekvivalentu).
function getFxToCzk(date, currency, opts) {
  if (currency === "CZK") return 1;
  const fx = state.fxRates;
  if (!fx || !fx.dates) return null;

  const day = fx.dates[date];
  if (day?.rates?.[currency]) {
    const r = day.rates[currency];
    return r.rate / r.amount;
  }

  if (!opts?.allowFallback) return null;

  const candidates = Object.keys(fx.dates).filter((d) => d < date).sort();
  if (candidates.length === 0) return null;
  const fallbackDate = candidates[candidates.length - 1];
  const r = fx.dates[fallbackDate]?.rates?.[currency];
  if (!r) return null;
  return r.rate / r.amount;
}

// ---------- Overview ----------
function setupOverviewSearch() {
  setupSearchInput(
    "overview-search",
    "overview-search-clear",
    "overview",
    renderOverview,
  );
  setupSearchInput(
    "allocation-search",
    "allocation-search-clear",
    "allocation",
    renderAllocation,
  );
  setupSearchInput(
    "watchlist-search",
    "watchlist-search-clear",
    "watchlist",
    renderWatchlist,
  );
  setupSearchInput(
    "transactions-search",
    "transactions-search-clear",
    "transactions",
    renderTransactions,
  );
  setupSearchInput(
    "dividends-search",
    "dividends-search-clear",
    "dividends",
    renderDividends,
  );
}

function renderOverview() {
  const tbody = document.querySelector("#tbl-overview tbody");
  tbody.innerHTML = "";

  // 1) Sesbírat řádky s vypočtenými hodnotami
  const rows = [];
  const searchQuery = state.searches.overview;
  for (const sym of Object.keys(state.portfolio.instruments)) {
    const inst = state.portfolio.instruments[sym];
    const pos = state.positions[sym];
    if (!pos || pos.net_qty === 0) continue;
    // Search filter
    if (searchQuery) {
      const haystack = `${sym} ${inst.name}`.toLowerCase();
      if (!haystack.includes(searchQuery)) continue;
    }

    const quote = state.quotes[inst.yahoo_symbol] || {};
    const currentPrice = quote.price;
    const hasPrice = currentPrice != null && !quote.error;
    const u = unrealizedPnl(pos, currentPrice);

    // Kapitálová Z/Z = realizovaná + nerealizovaná (jen kapitálové pohyby)
    const capitalPnl = pos.realized_pnl + u.value;

    // Total Return = kapitálová Z/Z + čistý dividendový výnos
    // (jen pokud je dividenda ve stejné měně jako pozice; NOV: EUR pozice, DKK
    // dividendy → nesčítáme, zobrazí se jen kapitálová Z/Z s indikátorem)
    const divCcys = new Set([
      ...(pos.dividend_records || []).map((dRec) => dRec.currency),
      ...(pos.withholding_records || []).map((t) => t.currency),
    ]);
    const divSameCcy =
      divCcys.size === 0 ||
      (divCcys.size === 1 && divCcys.has(inst.currency));
    const totalPnl = divSameCcy
      ? capitalPnl + (pos.net_dividend_local || 0)
      : capitalPnl;
    const totalPct =
      pos.total_invested > 0 ? (totalPnl / pos.total_invested) * 100 : 0;

    rows.push({
      sym,
      inst,
      pos,
      currentPrice,
      hasPrice,
      marketValue: u.market_value,
      unrealizedPnl: u.value,    // jen otevřené loty — bez realizovaných a dividend
      capitalPnl,
      totalPnl,
      totalPct,
      divSameCcy,
      hasDividends: divCcys.size > 0,
      hasRealized: (pos.realized_pnl || 0) !== 0, // pro tooltip / vizuál
    });
  }

  // 2) Setřídit
  const getter = sortGetters[state.sort.key] || sortGetters.sym;
  const dir = state.sort.dir === "desc" ? -1 : 1;
  rows.sort((a, b) => {
    const va = getter(a);
    const vb = getter(b);
    if (typeof va === "string") {
      return dir * va.localeCompare(vb, "cs");
    }
    return dir * (va - vb);
  });

  // 3) Aktualizovat sortovací indikátory v hlavičkách
  document.querySelectorAll("#tbl-overview th.sortable").forEach((th) => {
    const isSorted = th.dataset.sortKey === state.sort.key;
    th.classList.toggle("sorted", isSorted);
    th.classList.toggle("desc", isSorted && state.sort.dir === "desc");
  });

  // 3b) Counter
  const countEl = document.getElementById("overview-count");
  if (countEl) {
    const totalOpen = Object.values(state.positions).filter(
      (p) => p && p.net_qty > 0,
    ).length;
    countEl.textContent =
      rows.length === totalOpen
        ? `${totalOpen} otevřených pozic`
        : `${rows.length} z ${totalOpen} pozic`;
  }

  // 4) Vykreslit
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.className = "position";
    tr.dataset.sym = r.sym;
    tr.innerHTML = `
      <td class="symbol">${r.sym}${noteIconHtml(r.sym)}</td>
      <td>${escapeHtml(r.inst.name)}</td>
      <td>${r.inst.exchange}</td>
      <td>${r.inst.currency}</td>
      <td class="num">${fmtNum(r.pos.net_qty, 0)}</td>
      <td class="num">${fmtNum(r.pos.avg_open_price, 4)}</td>
      <td class="num">${r.hasPrice ? fmtNum(r.currentPrice, 2) : '<span class="muted">—</span>'}</td>
      <td class="num">${fmtNum(r.pos.cost_basis, 2)}</td>
      <td class="num">${r.hasPrice ? fmtNum(r.marketValue, 2) : '<span class="muted">—</span>'}</td>
      <td class="num ${signClass(r.unrealizedPnl)}" title="Nerealizovaná Z/Z = Hodnota pozice − Nákupní cena pozice (jen otevřené loty).${r.hasRealized ? ' Tento ticker má historické realizované obchody — viz sloupec Celkem Z/Z pro celkový pohled.' : ''}">${r.hasPrice ? fmtNum(r.unrealizedPnl, 2) : '<span class="muted">—</span>'}</td>
      <td class="num clickable ${signClass(r.totalPnl)}" data-action="expand" title="${r.hasDividends && !r.divSameCcy ? 'Pozor: dividendy v jiné měně než pozice — Total Return není sečteno. Vidíte jen kapitálovou Z/Z. Klikněte pro detail.' : 'Celkový (historický) Total Return = realizovaná Z/Z + nerealizovaná Z/Z + čisté dividendy. Klikněte pro detail.'}">${r.hasPrice ? fmtNum(r.totalPnl, 2) + (r.hasDividends && r.divSameCcy ? ' <span class="benchmark-tooltip">＋div</span>' : '') + ' <span class="caret">▾</span>' : '<span class="muted">—</span>'}</td>
      <td class="num ${signClass(r.totalPct)}">${r.hasPrice ? fmtPct(r.totalPct) : '<span class="muted">—</span>'}</td>
    `;
    tbody.appendChild(tr);
  }
}

function setupExpand() {
  const tbody = document.querySelector("#tbl-overview tbody");
  tbody.addEventListener("click", (e) => {
    const cell = e.target.closest('[data-action="expand"]');
    if (!cell) return;
    const tr = cell.closest("tr.position");
    if (!tr) return;
    toggleDetail(tr.dataset.sym, tr);
  });
}

function toggleDetail(sym, tr) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains("detail") && next.dataset.sym === sym) {
    next.remove();
    tr.classList.remove("expanded");
    return;
  }
  // Zavřít všechny ostatní otevřené detaily
  document.querySelectorAll("tr.detail").forEach((d) => d.remove());
  document.querySelectorAll("tr.position.expanded").forEach((p) =>
    p.classList.remove("expanded"),
  );
  // Vytvořit nový detail
  const detail = buildDetailRow(sym);
  tr.after(detail);
  tr.classList.add("expanded");
}

function buildDetailRow(sym) {
  const inst = state.portfolio.instruments[sym];
  const pos = state.positions[sym];
  const q = state.quotes[inst.yahoo_symbol] || {};
  const currentPrice = q.price;
  const hasPrice = currentPrice != null && !q.error;
  const u = unrealizedPnl(pos, currentPrice);
  const ccy = inst.currency;

  const txs = state.portfolio.transactions
    .filter((t) => t.symbol === sym)
    .sort((a, b) =>
      `${a.date} ${a.time || ""}`.localeCompare(`${b.date} ${b.time || ""}`),
    );

  const buys = txs.filter((t) => t.type === "BUY");
  const sells = txs.filter((t) => t.type === "SELL");

  const html = [];
  html.push(`<div class="detail-card">`);
  html.push(
    `<h3>${sym} — ${escapeHtml(inst.name)} <span class="muted">· ${inst.exchange} · ${ccy}</span></h3>`,
  );

  // Poznámka o firmě (volitelná, KV-backed přes /api/notes)
  // — sekce span přes obě grid sloupce, ať levý sloupec nezůstává prázdný
  // když je Nákupů hodně.
  const note = state.notes?.[sym];
  html.push(`<div class="detail-section detail-note-section detail-section-fullwidth">`);
  if (note) {
    html.push(
      `<div class="note-inline"><strong class="note-inline-label">Poznámka:</strong> ${escapeHtml(note)} <button class="btn-action note-inline-edit" data-note-edit-symbol="${sym}">Upravit</button></div>`,
    );
  } else {
    html.push(
      `<button class="btn-action" data-note-edit-symbol="${sym}">+ Přidat poznámku k firmě</button>`,
    );
  }
  html.push(`</div>`);

  // Nákupy
  html.push(`<div class="detail-section">`);
  html.push(`<h4>Nákupy</h4>`);
  html.push(`<table class="mini"><tbody>`);
  let totalBuyQty = 0;
  let totalBuyCost = 0;
  for (const b of buys) {
    const cost = Math.abs(b.proceeds) + Math.abs(b.commission);
    totalBuyQty += b.quantity;
    totalBuyCost += cost;
    html.push(
      `<tr>
        <td>${b.date}</td>
        <td class="num">${fmtNum(b.quantity, 0)} ks</td>
        <td class="num muted">@ ${fmtNum(b.price, 4)}</td>
        <td class="num muted">komise ${fmtNum(b.commission, 2)}</td>
        <td class="num"><strong>${fmtNum(cost, 2)} ${ccy}</strong></td>
      </tr>`,
    );
  }
  html.push(`</tbody></table>`);
  html.push(
    `<div class="mini-total">Celkem ${buys.length} nákup${buys.length === 1 ? "" : "ů"}: <strong>${fmtNum(totalBuyCost, 2)} ${ccy}</strong> (${fmtNum(totalBuyQty, 0)} ks <span class="muted">před splity</span>)</div>`,
  );
  html.push(`</div>`);

  // Corporate actions (zatím jen splity)
  if (pos.splits && pos.splits.length > 0) {
    html.push(`<div class="detail-section">`);
    html.push(`<h4>Splity / Corporate actions</h4>`);
    html.push(`<table class="mini"><tbody>`);
    for (const sp of pos.splits) {
      const ratio = `${sp.ratio_to}:${sp.ratio_from}`;
      const direction =
        sp.ratio_to > sp.ratio_from ? "forward split" : "reverse split";
      html.push(
        `<tr>
          <td>${sp.date}</td>
          <td><strong>${ratio} ${direction}</strong></td>
          <td class="muted">${escapeHtml(sp.note || "")}</td>
        </tr>`,
      );
    }
    html.push(`</tbody></table>`);
    html.push(
      `<div class="mini-total muted">Split mění počet kusů a cenu za 1 ks, ale celková nákupní hodnota zůstává stejná.</div>`,
    );
    html.push(`</div>`);
  }

  // Prodeje
  if (sells.length > 0) {
    html.push(`<div class="detail-section">`);
    html.push(`<h4>Prodeje</h4>`);
    html.push(`<table class="mini"><tbody>`);
    let totalSellQty = 0;
    let totalSellNet = 0;
    for (const s of sells) {
      const qty = Math.abs(s.quantity);
      const net = Math.abs(s.proceeds) - Math.abs(s.commission);
      totalSellQty += qty;
      totalSellNet += net;
      html.push(
        `<tr>
          <td>${s.date}</td>
          <td class="num">${fmtNum(qty, 0)} ks</td>
          <td class="num muted">@ ${fmtNum(s.price, 4)}</td>
          <td class="num muted">komise ${fmtNum(s.commission, 2)}</td>
          <td class="num"><strong>${fmtNum(net, 2)} ${ccy}</strong></td>
        </tr>`,
      );
    }
    html.push(`</tbody></table>`);
    html.push(
      `<div class="mini-total">Celkem ${sells.length} prodej${sells.length === 1 ? "" : sells.length < 5 ? "e" : "ů"}: <strong>${fmtNum(totalSellNet, 2)} ${ccy}</strong> (${fmtNum(totalSellQty, 0)} ks)</div>`,
    );
    html.push(`</div>`);

    // FIFO matching
    html.push(`<div class="detail-section">`);
    html.push(
      `<h4>FIFO matching — co bylo prodáno z jakého nákupu</h4>`,
    );
    html.push(`<table class="mini"><tbody>`);
    for (const c of pos.closed_lots) {
      if (c.orphan) {
        html.push(
          `<tr><td colspan="4" class="neg">⚠️ Prodej bez odpovídajícího nákupu: ${fmtNum(c.qty, 0)} ks @ ${fmtNum(c.sell_price, 4)} dne ${c.sell_date}</td></tr>`,
        );
        continue;
      }
      html.push(
        `<tr>
          <td class="num">${fmtNum(c.qty, 0)} ks</td>
          <td class="muted">z lotu ${c.buy_date} @ ${fmtNum(c.buy_price, 4)}</td>
          <td class="muted">→ prodáno ${c.sell_date} @ ${fmtNum(c.sell_price, 4)}</td>
          <td class="num ${signClass(c.pnl)}"><strong>${fmtNum(c.pnl, 2)} ${ccy}</strong></td>
        </tr>`,
      );
    }
    html.push(`</tbody></table>`);
    html.push(
      `<div class="mini-total"><strong class="${signClass(pos.realized_pnl)}">Realizovaná Zisk/Ztráta: ${fmtNum(pos.realized_pnl, 2)} ${ccy}</strong></div>`,
    );
    html.push(`</div>`);
  }

  // Otevřené pozice
  html.push(`<div class="detail-section">`);
  html.push(
    `<h4>Otevřené pozice (zbývá ${fmtNum(pos.net_qty, 0)} ks)</h4>`,
  );
  html.push(`<table class="mini"><tbody>`);
  for (const lot of pos.open_lots) {
    html.push(
      `<tr>
        <td>${lot.date}</td>
        <td class="num">${fmtNum(lot.qty, 0)} ks</td>
        <td class="num muted">@ ${fmtNum(lot.price, 4)} (cost ${fmtNum(lot.cost_per_unit, 4)}/ks vč. komise)</td>
        <td class="num"><strong>${fmtNum(lot.qty * lot.cost_per_unit, 2)} ${ccy}</strong></td>
      </tr>`,
    );
  }
  html.push(`</tbody></table>`);
  if (hasPrice) {
    // Nereal. % = unrealized / cost_basis_open_lots
    const unrealizedPct =
      pos.cost_basis > 0 ? (u.value / pos.cost_basis) * 100 : 0;
    html.push(
      `<div class="mini-total">Aktuální cena <strong>${fmtNum(currentPrice, 2)} ${ccy}</strong> → market value <strong>${fmtNum(u.market_value, 2)} ${ccy}</strong> &nbsp;·&nbsp; <strong class="${signClass(u.value)}">Nerealizovaná Z/Z: ${fmtNum(u.value, 2)} ${ccy} (${fmtPct(unrealizedPct)})</strong></div>`,
    );
  } else {
    html.push(
      `<div class="mini-total muted">Aktuální cena z Yahoo není dostupná</div>`,
    );
  }
  html.push(`</div>`);

  // Dividendy + withholding (pokud nějaké přišly)
  const hasDividends =
    (pos.dividend_records && pos.dividend_records.length > 0) ||
    (pos.withholding_records && pos.withholding_records.length > 0);
  if (hasDividends) {
    html.push(`<div class="detail-section">`);
    html.push(`<h4>Dividendy a sražená daň u zdroje</h4>`);
    html.push(`<table class="mini"><tbody>`);
    // Spojit dividend a tax záznamy, setřídit chronologicky
    const merged = [
      ...pos.dividend_records.map((d) => ({ ...d, _kind: "div" })),
      ...pos.withholding_records.map((t) => ({ ...t, _kind: "tax" })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    for (const m of merged) {
      const isDiv = m._kind === "div";
      const label = isDiv
        ? `Dividenda${m.per_share != null ? ` · ${fmtNum(m.per_share, 4)}/ks` : ""}`
        : `Withholding tax${m.country ? ` (${m.country})` : ""}`;
      html.push(
        `<tr>
          <td>${m.date}</td>
          <td class="muted">${label}</td>
          <td class="num ${signClass(m.amount)}"><strong>${fmtNum(m.amount, 2)} ${m.currency}</strong></td>
          ${m.amount_usd != null && m.currency !== "USD" ? `<td class="num muted">(${fmtNum(m.amount_usd, 2)} USD)</td>` : `<td></td>`}
        </tr>`,
      );
    }
    html.push(`</tbody></table>`);
    const netLocal = pos.net_dividend_local;
    const netUsd = pos.net_dividend_usd;
    let netLine = `<strong class="${signClass(netLocal)}">Čistý dividendový výnos: ${fmtNum(netLocal, 2)} ${ccy}</strong>`;
    if (ccy !== "USD" && netUsd) {
      netLine += ` <span class="muted">(${fmtNum(netUsd, 2)} USD)</span>`;
    }
    html.push(`<div class="mini-total">${netLine}</div>`);
    html.push(`</div>`);
  }

  // Sumář — kapitálová Z/Z + dividendy = Total Return
  if (hasPrice) {
    const capitalPnl = pos.realized_pnl + u.value;
    const capitalPct =
      pos.total_invested > 0 ? (capitalPnl / pos.total_invested) * 100 : 0;

    // Zkontrolovat, zda všechny dividendy a daně jsou ve stejné měně jako pozice.
    // Pokud ano, můžeme sčítat. Pokud ne (např. NOV: EUR pozice, DKK dividendy),
    // ukážeme čísla separátně bez sumarizace.
    const divCcys = new Set([
      ...(pos.dividend_records || []).map((d) => d.currency),
      ...(pos.withholding_records || []).map((t) => t.currency),
    ]);
    const sameCcy = divCcys.size <= 1 && (divCcys.size === 0 || divCcys.has(ccy));

    // FX přepočet do CZK (pro zobrazení Total Return i v Kč)
    const fxDates = state.fxRates?.dates
      ? Object.keys(state.fxRates.dates).sort()
      : [];
    const todayFxDate = fxDates[fxDates.length - 1] || null;
    const fxLocalToCzk = todayFxDate ? getFxToCzk(todayFxDate, ccy) : null;
    const willShowTotalReturn = hasDividends && sameCcy;
    const capitalCzk =
      fxLocalToCzk != null ? capitalPnl * fxLocalToCzk : null;
    const capitalCzkSuffix =
      !willShowTotalReturn && capitalCzk != null
        ? ` <span class="muted">≈ ${fmtNum(capitalCzk, 0)} Kč</span>`
        : "";

    html.push(`<div class="detail-section summary">`);
    html.push(`<div>`);
    html.push(
      `<div>Kapitálová Z/Z: <span class="${signClass(capitalPnl)}"><strong>${fmtNum(capitalPnl, 2)} ${ccy}</strong> (${fmtPct(capitalPct)})</span>${capitalCzkSuffix}</div>`,
    );
    if (hasDividends && sameCcy) {
      const totalReturn = capitalPnl + pos.net_dividend_local;
      const totalReturnPct =
        pos.total_invested > 0
          ? (totalReturn / pos.total_invested) * 100
          : 0;
      const totalReturnCzk =
        fxLocalToCzk != null ? totalReturn * fxLocalToCzk : null;
      const czkSuffix =
        totalReturnCzk != null
          ? ` <span class="muted">≈ ${fmtNum(totalReturnCzk, 0)} Kč</span>`
          : "";
      html.push(
        `<div>+ Čistý dividendový výnos: <span class="${signClass(pos.net_dividend_local)}"><strong>${fmtNum(pos.net_dividend_local, 2)} ${ccy}</strong></span></div>`,
      );
      html.push(
        `<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--color-border);">= <strong>TOTAL RETURN</strong>: <span class="${signClass(totalReturn)}"><strong>${fmtNum(totalReturn, 2)} ${ccy}</strong> (${fmtPct(totalReturnPct)})</span>${czkSuffix}</div>`,
      );
    } else if (hasDividends) {
      const divCcy = [...divCcys][0];
      html.push(
        `<div>+ Čistý dividendový výnos: <span class="${signClass(pos.net_dividend_local)}"><strong>${fmtNum(pos.net_dividend_local, 2)} ${divCcy}</strong></span> <span class="muted">(${fmtNum(pos.net_dividend_usd, 2)} USD ekv.)</span></div>`,
      );
      html.push(
        `<div class="muted" style="margin-top:4px;font-size:11.5px;">Total Return nelze přímo sečíst — kapitál v ${ccy}, dividendy v ${divCcy}. Pro celkový výnos je třeba FX přepočet.</div>`,
      );
    }
    html.push(`</div>`);
    html.push(
      `<span class="muted">vůči celkové investici ${fmtNum(pos.total_invested, 2)} ${ccy}</span>`,
    );
    html.push(`</div>`);
  }

  html.push(`</div>`);

  const tr = document.createElement("tr");
  tr.className = "detail";
  tr.dataset.sym = sym;
  const td = document.createElement("td");
  td.colSpan = 11;
  td.innerHTML = html.join("");
  tr.appendChild(td);
  return tr;
}

// ---------- Transactions ----------
function setupTxFilter() {
  // Vygenerovat roky chipy z dostupných dat (vč. dividend)
  const years = new Set();
  for (const t of state.portfolio.transactions) {
    years.add(t.date.slice(0, 4));
  }
  for (const d of state.portfolio.dividends || []) {
    years.add(d.date.slice(0, 4));
  }
  const sortedYears = [...years].sort().reverse();

  const wrap = document.getElementById("year-chips");
  wrap.innerHTML = "";
  // "Vše"
  const chipAll = document.createElement("button");
  chipAll.className = "filter-chip active";
  chipAll.dataset.year = "all";
  chipAll.textContent = "Vše";
  wrap.appendChild(chipAll);
  for (const y of sortedYears) {
    const c = document.createElement("button");
    c.className = "filter-chip";
    c.dataset.year = y;
    c.textContent = y;
    wrap.appendChild(c);
  }

  // Click na chip
  wrap.addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-chip");
    if (!btn) return;
    const y = btn.dataset.year;
    if (y === "all") {
      state.txFilter.from = null;
      state.txFilter.to = null;
    } else {
      state.txFilter.from = `${y}-01-01`;
      state.txFilter.to = `${y}-12-31`;
    }
    document.getElementById("filter-from").value = state.txFilter.from || "";
    document.getElementById("filter-to").value = state.txFilter.to || "";
    updateChipsActive();
    renderTransactions();
  });

  // Date inputs override
  const fromInp = document.getElementById("filter-from");
  const toInp = document.getElementById("filter-to");
  fromInp.addEventListener("change", () => {
    state.txFilter.from = fromInp.value || null;
    updateChipsActive();
    renderTransactions();
  });
  toInp.addEventListener("change", () => {
    state.txFilter.to = toInp.value || null;
    updateChipsActive();
    renderTransactions();
  });
  document.getElementById("filter-clear").addEventListener("click", () => {
    state.txFilter.from = null;
    state.txFilter.to = null;
    fromInp.value = "";
    toInp.value = "";
    updateChipsActive();
    renderTransactions();
  });
}

// ---------- Dividends rok filtr ----------
function setupDivFilter() {
  const wrap = document.getElementById("div-year-chips");
  if (!wrap) return;

  const years = new Set();
  for (const d of state.portfolio.dividends || []) years.add(d.date.slice(0, 4));
  for (const t of state.portfolio.withholding_tax || []) years.add(t.date.slice(0, 4));
  const sortedYears = [...years].sort().reverse();

  wrap.innerHTML = "";
  const chipAll = document.createElement("button");
  chipAll.className = "filter-chip active";
  chipAll.dataset.year = "all";
  chipAll.textContent = "Vše";
  wrap.appendChild(chipAll);
  for (const y of sortedYears) {
    const c = document.createElement("button");
    c.className = "filter-chip";
    c.dataset.year = y;
    c.textContent = y;
    wrap.appendChild(c);
  }

  wrap.addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-chip");
    if (!btn) return;
    const y = btn.dataset.year;
    state.divFilter.year = y === "all" ? null : y;
    wrap.querySelectorAll(".filter-chip").forEach((c) =>
      c.classList.toggle("active", c === btn),
    );
    renderDividends();
  });
}

function updateChipsActive() {
  const { from, to } = state.txFilter;
  document.querySelectorAll("#year-chips .filter-chip").forEach((c) => {
    const y = c.dataset.year;
    let active = false;
    if (y === "all" && !from && !to) {
      active = true;
    } else if (y !== "all" && from === `${y}-01-01` && to === `${y}-12-31`) {
      active = true;
    }
    c.classList.toggle("active", active);
  });
}

function renderTransactions() {
  const tbody = document.querySelector("#tbl-transactions tbody");
  tbody.innerHTML = "";

  const { from, to } = state.txFilter;
  const search = state.searches.transactions;
  let txs = state.portfolio.transactions.filter((t) => {
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
    if (search) {
      const inst = state.portfolio.instruments[t.symbol];
      const h = `${t.symbol} ${inst?.name || ""}`.toLowerCase();
      if (!h.includes(search)) return false;
    }
    return true;
  });

  // Nejnovější nahoře
  txs = txs.sort((a, b) =>
    `${b.date} ${b.time || ""}`.localeCompare(`${a.date} ${a.time || ""}`),
  );

  // Counter
  const total = state.portfolio.transactions.length;
  const countEl = document.getElementById("filter-count");
  if (countEl) {
    countEl.textContent =
      txs.length === total
        ? `${total} transakcí`
        : `${txs.length} z ${total} transakcí`;
  }

  for (const t of txs) {
    const inst = state.portfolio.instruments[t.symbol];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="num">${t.date}</td>
      <td class="muted">${t.time}</td>
      <td class="symbol">${t.symbol}</td>
      <td>${escapeHtml(inst.name)}</td>
      <td>${inst.exchange}</td>
      <td><span class="badge ${t.type === "BUY" ? "buy" : "sell"}">${t.type}</span></td>
      <td class="num">${fmtNum(Math.abs(t.quantity), 0)}</td>
      <td class="num">${fmtNum(t.price, 4)}</td>
      <td class="num">${fmtNum(t.proceeds, 2)}</td>
      <td class="num">${fmtNum(t.commission, 2)}</td>
      <td>${inst.currency}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ---------- Dividends ----------
function renderDividends() {
  const tbody = document.querySelector("#tbl-dividends tbody");
  const tfoot = document.getElementById("tfoot-dividends");
  tbody.innerHTML = "";
  if (tfoot) tfoot.innerHTML = "";

  // Sloučit dividends + withholding tax podle (symbol, date) — IBKR posílá oboje
  // v ten samý den ke stejné akci
  const events = new Map();
  for (const d of state.portfolio.dividends || []) {
    const key = `${d.symbol}|${d.date}`;
    if (!events.has(key)) {
      events.set(key, {
        symbol: d.symbol,
        date: d.date,
        currency: d.currency,
        gross: 0,
        tax: 0,
        country: null,
        gross_usd: 0,
        tax_usd: 0,
        per_share: d.per_share,
      });
    }
    const e = events.get(key);
    e.gross += d.amount;
    e.gross_usd += d.amount_usd || 0;
  }
  for (const t of state.portfolio.withholding_tax || []) {
    const key = `${t.symbol}|${t.date}`;
    if (!events.has(key)) {
      events.set(key, {
        symbol: t.symbol,
        date: t.date,
        currency: t.currency,
        gross: 0,
        tax: 0,
        country: t.country,
        gross_usd: 0,
        tax_usd: 0,
        per_share: null,
      });
    }
    const e = events.get(key);
    e.tax += t.amount;
    e.tax_usd += t.amount_usd || 0;
    e.country = e.country || t.country;
  }

  // Nejnovější nahoře
  const allRows = [...events.values()].sort((a, b) =>
    b.date.localeCompare(a.date),
  );
  // Rok + search filter
  const yr = state.divFilter.year;
  const q = state.searches.dividends;
  const rows = allRows.filter((r) => {
    if (yr && !r.date.startsWith(yr)) return false;
    if (q) {
      const inst = state.portfolio.instruments[r.symbol] || {};
      const h = `${r.symbol} ${inst.name || ""}`.toLowerCase();
      if (!h.includes(q)) return false;
    }
    return true;
  });
  // Counter
  const divCount = document.getElementById("dividends-count");
  if (divCount) {
    divCount.textContent =
      rows.length === allRows.length
        ? `${allRows.length} výplat`
        : `${rows.length} z ${allRows.length}`;
  }

  let totalGrossUsd = 0;
  let totalTaxUsd = 0;
  for (const r of rows) {
    const inst = state.portfolio.instruments[r.symbol] || {};
    const net = r.gross + r.tax;
    const netUsd = r.gross_usd + r.tax_usd;
    totalGrossUsd += r.gross_usd;
    totalTaxUsd += r.tax_usd;

    const taxPct = withholdingPct(r.gross, r.tax);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="num">${r.date}</td>
      <td class="symbol">${r.symbol}</td>
      <td>${escapeHtml(inst.name || "")}</td>
      <td>${r.country || '<span class="muted">—</span>'}</td>
      <td class="num pos">${fmtNum(r.gross, 2)}</td>
      <td class="num ${r.tax !== 0 ? "neg" : "muted"}">${r.tax !== 0 ? fmtNum(r.tax, 2) : "—"}</td>
      <td class="num ${taxPct != null ? "neg" : "muted"}">${taxPct != null ? `${fmtNum(taxPct, 1)} %` : "—"}</td>
      <td class="num pos"><strong>${fmtNum(net, 2)}</strong></td>
      <td>${r.currency}</td>
      <td class="num">${fmtNum(netUsd, 2)}</td>
    `;
    tbody.appendChild(tr);
  }

  // Total v patce
  if (tfoot && rows.length > 0) {
    const totalNetUsd = totalGrossUsd + totalTaxUsd;
    const avgTaxPct = withholdingPct(totalGrossUsd, totalTaxUsd);
    tfoot.innerHTML = `
      <tr>
        <td colspan="4">Celkem (USD ekvivalent)</td>
        <td class="num pos">${fmtNum(totalGrossUsd, 2)}</td>
        <td class="num neg">${fmtNum(totalTaxUsd, 2)}</td>
        <td class="num neg">${avgTaxPct != null ? `${fmtNum(avgTaxPct, 1)} %` : "—"}</td>
        <td class="num pos"><strong>${fmtNum(totalNetUsd, 2)}</strong></td>
        <td>USD</td>
        <td class="num"><strong>${fmtNum(totalNetUsd, 2)}</strong></td>
      </tr>
    `;
  }
}

// Efektivní % srážkové daně z brutto dividendy (daň je v datech záporná)
function withholdingPct(gross, tax) {
  if (!gross || gross <= 0 || !tax) return null;
  return (Math.abs(tax) / gross) * 100;
}

// ---------- Summary ----------
function renderSummary() {
  const p = state.portfolio;
  const symbols = Object.keys(p.instruments);
  const wrap = document.getElementById("summary-cards");
  wrap.innerHTML = "";

  // === 1) Hodnota portfolia (CZK, USD v závorce) — placeholder, doplníme
  //         hned jak budeme mít spočítaný currentValueUsd a fxUsdToCzk ===
  const portfolioValueCard = document.createElement("div");
  portfolioValueCard.className = "summary-card";
  wrap.appendChild(portfolioValueCard);

  // Najít nejnovější ČNB datum (potřebujeme níže pro cash + agregáty)
  const fxDatesEarly = state.fxRates?.dates
    ? Object.keys(state.fxRates.dates).sort()
    : [];
  const todayFxDateEarly = fxDatesEarly[fxDatesEarly.length - 1] || null;
  const fxUsdToCzkEarly = todayFxDateEarly
    ? getFxToCzk(todayFxDateEarly, "USD")
    : null;

  // === 2) Cash zůstatek — sumovat všechny měny do CZK ===
  const cashBalance = p.cash_balance || {};
  let cashCzkTotal = 0;
  const cashBreakdown = [];
  for (const ccy of Object.keys(cashBalance).sort()) {
    const amt = cashBalance[ccy];
    if (amt == null) continue;
    const rate = todayFxDateEarly ? getFxToCzk(todayFxDateEarly, ccy) : null;
    if (rate != null) {
      cashCzkTotal += amt * rate;
      cashBreakdown.push(`${fmtNum(amt, 2)} ${ccy}`);
    }
  }
  if (Object.keys(cashBalance).length > 0) {
    const subText = cashBreakdown.join(" · ");
    wrap.appendChild(
      cardHtml(
        `Cash zůstatek · CZK`,
        `<span class="${signClass(cashCzkTotal)}">${fmtNum(cashCzkTotal, 0)} Kč</span>`,
        subText,
      ),
    );
  }

  // Použít už vytažené FX hodnoty z bloku výše
  const todayFxDate = todayFxDateEarly;
  const fxUsdToCzk = fxUsdToCzkEarly;

  // Sesbírat data pro agregaci
  let currentValueUsd = 0;
  let capitalPnlUsd = 0;
  let netDividendsUsd = 0;
  let dividendsGrossUsd = 0;
  let dividendsTaxUsd = 0;
  let allPricesAvailable = true;
  const missingPriceSymbols = [];

  for (const sym of symbols) {
    const inst = p.instruments[sym];
    const pos = state.positions[sym];
    if (!pos) continue;
    const ccy = inst.currency;
    const fxToCzk = todayFxDate ? getFxToCzk(todayFxDate, ccy) : null;
    const usdRate = fxUsdToCzk;
    // USD ekvivalent kapitálové P/L
    if (fxToCzk != null && usdRate) {
      capitalPnlUsd += (pos.realized_pnl * fxToCzk) / usdRate;
    }
    // Current value
    const q = state.quotes[inst.yahoo_symbol] || {};
    if (q.price != null && pos.net_qty > 0 && fxToCzk != null && usdRate) {
      const mvLocal = pos.net_qty * q.price;
      currentValueUsd += (mvLocal * fxToCzk) / usdRate;
      capitalPnlUsd += ((mvLocal - pos.cost_basis) * fxToCzk) / usdRate;
    } else if (pos.net_qty > 0) {
      allPricesAvailable = false;
      missingPriceSymbols.push(sym);
    }
    netDividendsUsd += pos.net_dividend_usd || 0;
    dividendsGrossUsd += pos.dividends_usd || 0;
    dividendsTaxUsd += pos.withholding_usd || 0;
  }

  // Cash USD ekv = total cash CZK / USD/CZK
  const cashUsdAll =
    fxUsdToCzk && cashCzkTotal ? cashCzkTotal / fxUsdToCzk : 0;
  const totalAssetsUsd = currentValueUsd + cashUsdAll;
  const totalDeposits = p.total_deposits_usd || 0;
  const totalReturnUsd =
    totalDeposits > 0 ? totalAssetsUsd - totalDeposits : 0;
  const totalReturnPct =
    totalDeposits > 0 ? (totalReturnUsd / totalDeposits) * 100 : 0;

  // Inception (od první aktivity)
  const inception = p.inception_date || "2025-11-24";
  const today = new Date();
  const inceptionDt = new Date(inception);
  const daysSince = Math.max(
    1,
    (today.getTime() - inceptionDt.getTime()) / 86400000,
  );
  const yearsSince = daysSince / 365.25;
  const paPct =
    yearsSince > 0
      ? (Math.pow(1 + totalReturnPct / 100, 1 / yearsSince) - 1) * 100
      : 0;

  // === Doplnit Hodnotu portfolia (1. dlaždice — placeholder výše) ===
  // Total = pozice (tržní hodnota) + cash. Odpovídá IBKR Net Liquidity.
  {
    const totalAssetsCzk = fxUsdToCzk ? totalAssetsUsd * fxUsdToCzk : null;
    const positionsCzk = fxUsdToCzk ? currentValueUsd * fxUsdToCzk : null;
    const cashCzk = fxUsdToCzk ? cashUsdAll * fxUsdToCzk : null;
    const mainLine =
      totalAssetsCzk != null
        ? `${fmtNum(totalAssetsCzk, 0)} Kč`
        : `${fmtNum(totalAssetsUsd, 0)} USD`;
    const subLine =
      totalAssetsCzk != null
        ? `${fmtNum(totalAssetsUsd, 0)} USD ekv. · pozice ${fmtNum(positionsCzk, 0)} + cash ${fmtNum(cashCzk, 0)} Kč`
        : "";
    const missingPricesNote = allPricesAvailable
      ? ""
      : `<br><span class="muted">chybí cena: ${missingPriceSymbols.join(", ")}</span>`;
    portfolioValueCard.innerHTML = `
      <div class="label">Hodnota portfolia · CZK <span class="hint" title="Total Net Liquidity — tržní hodnota držených pozic + hotovost ve všech měnách, vše přepočteno přes ČNB kurz. Odpovídá IBKR Net Liquidity v jejich Portal.">i</span></div>
      <div class="value">${mainLine}</div>
      <div class="sub">${subLine}${missingPricesNote}</div>
      <div class="ph-tile-link muted small">📈 Klikni pro vývoj v čase</div>
    `;
    // Klik na dlaždici → přepnutí na tab Hodnota portfolia
    portfolioValueCard.style.cursor = "pointer";
    portfolioValueCard.addEventListener("click", () => {
      const tab = document.querySelector('.tab[data-view="portfolio-history"]');
      if (tab) tab.click();
    });
  }

  // === 3) Total Return % od inception (primary = %, sub = absolutní hodnoty) ===
  const totalReturnCzk = fxUsdToCzk ? totalReturnUsd * fxUsdToCzk : null;
  const absLine =
    totalReturnCzk != null
      ? `${fmtNum(totalReturnCzk, 0)} Kč (${fmtNum(totalReturnUsd, 0)} USD)`
      : `${fmtNum(totalReturnUsd, 0)} USD`;
  wrap.appendChild(
    cardHtml(
      `Celkový výnos`,
      `<span class="${signClass(totalReturnPct)}">${fmtPct(totalReturnPct)}</span>`,
      `${absLine}<br>od založení ${inception} (${Math.round(daysSince)} dní)`,
    ),
  );

  // === 4) P.a. ===
  wrap.appendChild(
    cardHtml(
      `P.a. (anualizováno)`,
      `<span class="${signClass(paPct)}">${fmtPct(paPct)}</span>`,
      `průměrný roční výnos<br>${yearsSince.toFixed(2)} let od založení`,
    ),
  );

  // === 5) YTD % ===
  // Pro IBKR: použít předpočítaný M2M YTD z Activity Statement.
  // Pro KB (a obecně pokud chybí snapshot): spočítat realized z 2026 transakcí
  // + dividends 2026 net + interest 2026.
  const yearStart = `${today.getFullYear()}-01-01`;
  let ytdDivNet = 0;
  for (const dRec of p.dividends || []) {
    if (dRec.date >= yearStart) ytdDivNet += dRec.amount_usd || 0;
  }
  for (const t of p.withholding_tax || []) {
    if (t.date >= yearStart) ytdDivNet += t.amount_usd || 0;
  }
  let ytdInterest = 0;
  for (const f of p.cash_flows || []) {
    if (f.type === "interest" && f.date >= yearStart) {
      ytdInterest += f.amount_usd || f.amount;
    }
  }
  const ytdM2m = p.ytd_mark_to_market_usd || 0;

  // YTD realized z 2026 transakcí (pro KB, kde nemáme snapshot)
  let ytdRealizedUsd = 0;
  let hasYtdRealized = false;
  if (!p.ytd_mark_to_market_usd && state.positions) {
    for (const sym in state.positions) {
      const pos = state.positions[sym];
      if (!pos.closed_lots) continue;
      const inst = p.instruments[sym] || {};
      const fxLocalToCzk = todayFxDate
        ? getFxToCzk(todayFxDate, inst.currency)
        : null;
      if (!fxLocalToCzk || !fxUsdToCzk) continue;
      for (const cl of pos.closed_lots) {
        if (cl.orphan) continue;
        if (!cl.sell_date || cl.sell_date < yearStart) continue;
        const pnlUsd = (cl.pnl * fxLocalToCzk) / fxUsdToCzk;
        ytdRealizedUsd += pnlUsd;
        hasYtdRealized = true;
      }
    }
  }

  const ytdPlUsd = ytdM2m + ytdRealizedUsd + ytdDivNet + ytdInterest;
  const ytdPct =
    totalAssetsUsd > 0 ? (ytdPlUsd / totalAssetsUsd) * 100 : 0;
  const ytdCzk = fxUsdToCzk ? ytdPlUsd * fxUsdToCzk : null;
  const ytdAbs =
    ytdCzk != null
      ? `${fmtNum(ytdCzk, 0)} Kč (${fmtNum(ytdPlUsd, 0)} USD)`
      : `${fmtNum(ytdPlUsd, 0)} USD`;
  let ytdSourceNote;
  if (p.ytd_mark_to_market_usd != null && p.ytd_mark_to_market_usd !== 0) {
    ytdSourceNote = `snapshot ${p.broker} k ${p.statement_period_end || "?"}`;
  } else if (hasYtdRealized) {
    ytdSourceNote = `realiz. prodeje + div. + úroky 2026 (nezahrnuje změnu tržní hodnoty otevřených pozic)`;
  } else {
    ytdSourceNote = `pouze div. + úroky 2026 (nezahrnuje změnu tržní hodnoty otevřených pozic)`;
  }
  wrap.appendChild(
    cardHtml(
      `YTD ${today.getFullYear()}`,
      `<span class="${signClass(ytdPct)}">${fmtPct(ytdPct)}</span>`,
      `${ytdAbs}<br>${ytdSourceNote}`,
    ),
  );

  // === 6) Aggregované dividendy v CZK ===
  if (fxUsdToCzk != null) {
    const netDivCzk = netDividendsUsd * fxUsdToCzk;
    const grossDivCzk = dividendsGrossUsd * fxUsdToCzk;
    const taxDivCzk = dividendsTaxUsd * fxUsdToCzk;
    wrap.appendChild(
      cardHtml(
        `Dividendy (po dani) · CZK`,
        `<span class="${signClass(netDivCzk)}">${fmtNum(netDivCzk, 0)} Kč</span>`,
        `${fmtNum(netDividendsUsd, 0)} USD ekv.<br>hrubé ${fmtNum(grossDivCzk, 0)} · daň ${fmtNum(taxDivCzk, 0)} Kč`,
      ),
    );
  }
}

function card(label, value, sub = "") {
  return cardHtml(label, String(value), sub);
}

function cardHtml(label, valueHtml, sub = "") {
  const d = document.createElement("div");
  d.className = "summary-card";
  // sub může obsahovat HTML (např. <br>) — volající si escape řeší sám
  d.innerHTML = `
    <div class="label">${escapeHtml(label)}</div>
    <div class="value">${valueHtml}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ""}
  `;
  return d;
}

// ---------- Report pro účetní ----------
function setupReportFilter() {
  // Roky chipy — jen roky, kdy došlo k SELL
  const years = new Set();
  for (const sym in state.positions) {
    for (const cl of state.positions[sym].closed_lots || []) {
      if (!cl.orphan && cl.sell_date) years.add(cl.sell_date.slice(0, 4));
    }
  }
  const sortedYears = [...years].sort().reverse();

  const wrap = document.getElementById("report-year-chips");
  wrap.innerHTML = "";
  // Default "Vše" je preselected, ale typicky účetní vybere konkrétní rok.
  // Pokud existuje jen jeden rok, předvybereme ho.
  const chipAll = document.createElement("button");
  chipAll.className = "filter-chip" + (sortedYears.length !== 1 ? " active" : "");
  chipAll.dataset.year = "all";
  chipAll.textContent = "Vše";
  wrap.appendChild(chipAll);
  for (const y of sortedYears) {
    const c = document.createElement("button");
    c.className = "filter-chip" + (sortedYears.length === 1 ? " active" : "");
    c.dataset.year = y;
    c.textContent = y;
    wrap.appendChild(c);
  }
  // Pokud existuje jen jeden rok, předvybrat ho
  if (sortedYears.length === 1) {
    state.reportFilter.from = `${sortedYears[0]}-01-01`;
    state.reportFilter.to = `${sortedYears[0]}-12-31`;
  }

  wrap.addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-chip");
    if (!btn) return;
    const y = btn.dataset.year;
    if (y === "all") {
      state.reportFilter.from = null;
      state.reportFilter.to = null;
    } else {
      state.reportFilter.from = `${y}-01-01`;
      state.reportFilter.to = `${y}-12-31`;
    }
    document.getElementById("report-from").value = state.reportFilter.from || "";
    document.getElementById("report-to").value = state.reportFilter.to || "";
    updateReportChipsActive();
    renderReport();
  });

  const fromInp = document.getElementById("report-from");
  const toInp = document.getElementById("report-to");
  fromInp.value = state.reportFilter.from || "";
  toInp.value = state.reportFilter.to || "";
  fromInp.addEventListener("change", () => {
    state.reportFilter.from = fromInp.value || null;
    updateReportChipsActive();
    renderReport();
  });
  toInp.addEventListener("change", () => {
    state.reportFilter.to = toInp.value || null;
    updateReportChipsActive();
    renderReport();
  });
  document.getElementById("report-clear").addEventListener("click", () => {
    state.reportFilter.from = null;
    state.reportFilter.to = null;
    fromInp.value = "";
    toInp.value = "";
    updateReportChipsActive();
    renderReport();
  });
}

function updateReportChipsActive() {
  const { from, to } = state.reportFilter;
  document.querySelectorAll("#report-year-chips .filter-chip").forEach((c) => {
    const y = c.dataset.year;
    let active = false;
    if (y === "all" && !from && !to) {
      active = true;
    } else if (y !== "all" && from === `${y}-01-01` && to === `${y}-12-31`) {
      active = true;
    }
    c.classList.toggle("active", active);
  });
}

function renderReport() {
  const container = document.getElementById("report-content");
  const summary = document.getElementById("report-summary");
  const countEl = document.getElementById("report-count");
  container.innerHTML = "";
  summary.innerHTML = "";

  // Sesbírat všechny prodejní eventy v daném období
  // Klíč = symbol + sell_date (IBKR někdy dělí 1 prodej na víc closed lotů)
  const { from, to } = state.reportFilter;
  const eventsMap = new Map();
  for (const sym in state.positions) {
    const pos = state.positions[sym];
    for (const cl of pos.closed_lots || []) {
      if (cl.orphan) continue;
      const sd = cl.sell_date;
      if (from && sd < from) continue;
      if (to && sd > to) continue;
      const key = `${sym}|${sd}`;
      let ev = eventsMap.get(key);
      if (!ev) {
        ev = {
          symbol: sym,
          sell_date: sd,
          currency: state.portfolio.instruments[sym].currency,
          name: state.portfolio.instruments[sym].name,
          buys: [],
          sell_qty: 0,
          sell_net_total: 0,
          sell_price: cl.sell_price,
        };
        eventsMap.set(key, ev);
      }
      ev.buys.push({
        date: cl.buy_date,
        qty: cl.qty,
        cost_per_unit: cl.buy_cost_per_unit,
        total: cl.qty * cl.buy_cost_per_unit,
      });
      ev.sell_qty += cl.qty;
      ev.sell_net_total += cl.qty * cl.sell_net_per_unit;
    }
  }

  const events = [...eventsMap.values()].sort((a, b) =>
    a.sell_date.localeCompare(b.sell_date),
  );

  if (countEl) {
    countEl.textContent =
      events.length === 0
        ? "Žádný prodej v období"
        : `${events.length} prodej${events.length === 1 ? "" : events.length < 5 ? "e" : "ů"}`;
  }

  if (events.length === 0) {
    container.innerHTML = `<div class="status">V daném období neproběhl žádný prodej. Zkuste vybrat jiný rok nebo "Vše".</div>`;
    return;
  }

  let grandCostCzk = 0;
  let grandSellCzk = 0;
  let grandProfitCzk = 0;
  let anyMissingFx = false;

  for (const ev of events) {
    // Slučit duplicitní buy lots (stejné datum) — IBKR někdy dělí intra-day
    const buysByDate = new Map();
    for (const b of ev.buys) {
      if (!buysByDate.has(b.date)) {
        buysByDate.set(b.date, { date: b.date, qty: 0, total: 0 });
      }
      const e = buysByDate.get(b.date);
      e.qty += b.qty;
      e.total += b.total;
    }
    const buys = [...buysByDate.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    );

    // FX přepočet — strict mode (pro účetnictví musí být přesné datum).
    // Když ČNB kurz pro daný den chybí, zobrazí se "chybí kurz".
    let costCzk = 0;
    let allFxFound = true;
    for (const b of buys) {
      const fx = getFxToCzk(b.date, ev.currency);
      b.fx = fx;
      b.czk = fx != null ? b.total * fx : null;
      if (fx == null) allFxFound = false;
      else costCzk += b.czk;
    }
    const sellFx = getFxToCzk(ev.sell_date, ev.currency);
    const sellCzk = sellFx != null ? ev.sell_net_total * sellFx : null;
    if (sellFx == null) allFxFound = false;
    const profitCzk = sellCzk != null ? sellCzk - costCzk : null;

    if (!allFxFound) anyMissingFx = true;
    if (sellCzk != null) {
      grandCostCzk += costCzk;
      grandSellCzk += sellCzk;
      grandProfitCzk += profitCzk;
    }

    // Build HTML
    const card = document.createElement("div");
    card.className = "report-event";
    let html = `
      <div class="report-event-header">
        <span><strong>${ev.symbol}</strong> — ${escapeHtml(ev.name)} <span class="muted">· ${ev.currency}</span></span>
        <span class="muted">Prodej ${ev.sell_date} · ${fmtNum(ev.sell_qty, 0)} ks @ ${fmtNum(ev.sell_price, 4)}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Datum</th>
            <th class="num">Kusů</th>
            <th class="num">Cena celkem (${ev.currency})</th>
            <th class="num">Kurz ČNB CZK/${ev.currency}</th>
            <th class="num">Cena celkem v Kč</th>
            <th>Pozn.</th>
          </tr>
        </thead>
        <tbody>
    `;
    // Mezisoučty nákupů — kusy a foreign total
    let totalBuyQty = 0;
    let totalBuyForeign = 0;
    for (const b of buys) {
      totalBuyQty += b.qty;
      totalBuyForeign += b.total;
      html += `
        <tr class="buy">
          <td>${b.date}</td>
          <td class="num">${fmtNum(b.qty, 0)}</td>
          <td class="num">${fmtNum(b.total, 2)}</td>
          <td class="num">${b.fx != null ? fmtNum(b.fx, 4) : '<span class="missing-fx">chybí kurz</span>'}</td>
          <td class="num">${b.czk != null ? fmtNum(b.czk, 2) : '<span class="missing-fx">—</span>'}</td>
          <td class="report-buy">nákup</td>
        </tr>
      `;
    }
    html += `
      <tr class="subtotal">
        <td class="label">Celkem nákup:</td>
        <td class="num"><strong>${fmtNum(totalBuyQty, 0)}</strong></td>
        <td class="num"><strong>${fmtNum(totalBuyForeign, 2)}</strong></td>
        <td></td>
        <td class="num"><strong>${allFxFound ? fmtNum(costCzk, 2) : '<span class="missing-fx">—</span>'}</strong></td>
        <td></td>
      </tr>
      <tr class="sell">
        <td>${ev.sell_date}</td>
        <td class="num">${fmtNum(ev.sell_qty, 0)}</td>
        <td class="num">${fmtNum(ev.sell_net_total, 2)}</td>
        <td class="num">${sellFx != null ? fmtNum(sellFx, 4) : '<span class="missing-fx">chybí kurz</span>'}</td>
        <td class="num">${sellCzk != null ? fmtNum(sellCzk, 2) : '<span class="missing-fx">—</span>'}</td>
        <td class="report-sell">prodej</td>
      </tr>
      <tr class="totals">
        <td colspan="4" class="label" style="text-align:right;">${profitCzk >= 0 ? "Zisk" : "Ztráta"} v Kč:</td>
        <td class="num ${signClass(profitCzk)}"><strong>${profitCzk != null ? fmtNum(profitCzk, 2) : '<span class="missing-fx">—</span>'}</strong></td>
        <td></td>
      </tr>
      </tbody>
      </table>
    `;
    card.innerHTML = html;
    container.appendChild(card);
  }

  // Souhrn pod kartami
  let sumHtml = `
    <div>
      <div class="total-label">Celkem nákup (CZK)</div>
      <div class="total-value">${fmtNum(grandCostCzk, 2)}</div>
    </div>
    <div>
      <div class="total-label">Celkem prodej (CZK)</div>
      <div class="total-value">${fmtNum(grandSellCzk, 2)}</div>
    </div>
    <div>
      <div class="total-label">${grandProfitCzk >= 0 ? "Zisk z prodejů" : "Ztráta z prodejů"} (CZK)</div>
      <div class="total-value ${signClass(grandProfitCzk)}">${fmtNum(grandProfitCzk, 2)}</div>
    </div>
  `;
  if (anyMissingFx) {
    sumHtml += `<div class="muted" style="flex-basis:100%;">⚠️ Některé kurzy ČNB chybí — souhrn nemusí být úplný.</div>`;
  }
  summary.innerHTML = sumHtml;
}

// ---------- XLSX export — current view ----------
function exportCurrentViewXlsx() {
  if (typeof XLSX === "undefined") {
    alert("XLSX knihovna se nenačetla. Hard refresh (Cmd+Shift+R) a zkuste znovu.");
    return;
  }
  const view = state.view;
  let aoa = []; // array of arrays
  let sheetName = view;
  let filenamePart = view;

  if (view === "overview") {
    aoa = buildOverviewAoa();
    sheetName = "Přehled pozic";
    filenamePart = "prehled-pozic";
  } else if (view === "allocation") {
    aoa = buildAllocationAoa();
    sheetName = "Alokace";
    filenamePart = "alokace";
  } else if (view === "transactions") {
    aoa = buildTransactionsAoa();
    sheetName = "Transakce";
    filenamePart = "transakce";
  } else if (view === "dividends") {
    aoa = buildDividendsAoa();
    sheetName = "Dividendy";
    filenamePart = "dividendy";
  } else if (view === "watchlist") {
    aoa = buildWatchlistAoa();
    sheetName = "Watchlist";
    filenamePart = "watchlist";
  } else if (view === "alerts") {
    aoa = buildAlertsAoa();
    sheetName = "Alerty";
    filenamePart = "alerty";
  } else if (view === "report") {
    return exportReportXlsx();
  } else if (view === "journal") {
    aoa = buildJournalAoa();
    sheetName = "Deník investora";
    filenamePart = "denik";
  } else {
    alert(`Export pro tab ${view} zatím není podporovaný.`);
    return;
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const filename = `${state.portfolio.id}-${filenamePart}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, filename);
}

/**
 * Export pro účetní (Transakce s CZK přepočtem) — vždy export transakcí
 * bez ohledu na to, který tab je právě aktivní (tlačítko je viditelné
 * jen v Transakce, ale logicky exportuje ten dataset).
 */
function exportTransactionsAccountingXlsx() {
  if (typeof XLSX === "undefined") {
    alert("XLSX knihovna se nenačetla. Hard refresh (Cmd+Shift+R) a zkuste znovu.");
    return;
  }
  const aoa = buildTransactionsAccountingAoa();
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, "Transakce pro účetní");
  const filename = `${state.portfolio.id}-transakce-pro-ucetni-${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, filename);
}

function getFilteredOverviewRows() {
  const rows = [];
  const q = state.searches.overview;
  for (const sym of Object.keys(state.portfolio.instruments)) {
    const inst = state.portfolio.instruments[sym];
    const pos = state.positions[sym];
    if (!pos || pos.net_qty === 0) continue;
    if (q) {
      const h = `${sym} ${inst.name}`.toLowerCase();
      if (!h.includes(q)) continue;
    }
    const quote = state.quotes[inst.yahoo_symbol] || {};
    const currentPrice = quote.price;
    const hasPrice = currentPrice != null && !quote.error;
    const u = unrealizedPnl(pos, currentPrice);
    const totalPnl = pos.realized_pnl + u.value;
    const totalPct =
      pos.total_invested > 0 ? (totalPnl / pos.total_invested) * 100 : 0;
    rows.push({
      sym, inst, pos, currentPrice, hasPrice,
      marketValue: u.market_value, totalPnl, totalPct,
    });
  }
  return rows;
}

function buildOverviewAoa() {
  const rows = getFilteredOverviewRows();
  const header = [
    "Symbol", "Název", "Burza", "Měna",
    "Kusů", "Ø nákup/ks", "Aktuální", "Nák. cena pozice",
    "Hodnota pozice", "Nereal. Z/Z", "Realiz. Z/Z",
    "Kapitál. Z/Z", "Net dividendy",
    "Celkem Z/Z (Total Return)", "%",
  ];
  const data = rows.map((r) => [
    r.sym, r.inst.name, r.inst.exchange, r.inst.currency,
    r.pos.net_qty, r.pos.avg_open_price,
    r.hasPrice ? r.currentPrice : null,
    r.pos.cost_basis,
    r.hasPrice ? r.marketValue : null,
    r.hasPrice ? r.unrealizedPnl : null,
    r.pos.realized_pnl || 0,
    r.hasPrice ? r.capitalPnl : null,
    r.divSameCcy ? r.pos.net_dividend_local || 0 : null,
    r.hasPrice ? r.totalPnl : null,
    r.hasPrice ? r.totalPct : null,
  ]);
  return [header, ...data];
}

function buildAllocationAoa() {
  // Reuse computation logic — but we need full rows incl. weights, sorted.
  // Voláme renderAllocation by side effect? Lepší přímo počítat.
  const fxDates = state.fxRates?.dates ? Object.keys(state.fxRates.dates).sort() : [];
  const todayFxDate = fxDates[fxDates.length - 1] || null;
  const fxUsdToCzk = todayFxDate ? getFxToCzk(todayFxDate, "USD") : null;
  const all = [];
  let sumV = 0, sumI = 0;
  for (const sym of Object.keys(state.portfolio.instruments)) {
    const pos = state.positions[sym];
    if (!pos || pos.net_qty === 0) continue;
    const inst = state.portfolio.instruments[sym];
    const ccyToCzk = todayFxDate ? getFxToCzk(todayFxDate, inst.currency) : null;
    if (ccyToCzk == null || fxUsdToCzk == null) continue;
    const quote = state.quotes[inst.yahoo_symbol] || {};
    const valLocal = quote.price != null ? pos.net_qty * quote.price : null;
    const valUsd = valLocal != null ? (valLocal * ccyToCzk) / fxUsdToCzk : null;
    const invUsd = (pos.total_invested * ccyToCzk) / fxUsdToCzk;
    if (valUsd != null) sumV += valUsd;
    sumI += invUsd;
    all.push({ sym, inst, valUsd, invUsd });
  }
  for (const r of all) {
    r.wV = sumV > 0 && r.valUsd != null ? (r.valUsd / sumV) * 100 : null;
    r.wI = sumI > 0 ? (r.invUsd / sumI) * 100 : 0;
    r.delta = r.wV != null ? r.wV - r.wI : null;
  }
  const q = state.searches.allocation;
  const filtered = q
    ? all.filter((r) => `${r.sym} ${r.inst.name}`.toLowerCase().includes(q))
    : all;
  filtered.sort((a, b) => (b.wV ?? 0) - (a.wV ?? 0));
  const header = [
    "Symbol", "Název", "Měna",
    "Hodnota teď (USD)", "Váha teď %",
    "Vloženo (USD)", "Váha podle vkladu %",
    "Δ p.b.",
  ];
  const data = filtered.map((r) => [
    r.sym, r.inst.name, r.inst.currency,
    r.valUsd, r.wV,
    r.invUsd, r.wI,
    r.delta,
  ]);
  return [header, ...data];
}

function getFilteredTransactions() {
  const { from, to } = state.txFilter;
  const search = state.searches.transactions;
  let txs = state.portfolio.transactions.filter((t) => {
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
    if (search) {
      const inst = state.portfolio.instruments[t.symbol];
      const h = `${t.symbol} ${inst?.name || ""}`.toLowerCase();
      if (!h.includes(search)) return false;
    }
    return true;
  });
  return txs.sort((a, b) =>
    `${b.date} ${b.time || ""}`.localeCompare(`${a.date} ${a.time || ""}`),
  );
}

function buildTransactionsAoa() {
  const txs = getFilteredTransactions();
  const header = [
    "Datum", "Čas", "Symbol", "Název", "ISIN", "Burza", "Měna",
    "Typ", "Množství", "Cena", "Hodnota", "Komise",
  ];
  const data = txs.map((t) => {
    const inst = state.portfolio.instruments[t.symbol] || {};
    return [
      t.date, t.time, t.symbol, inst.name, inst.isin, inst.exchange, inst.currency,
      t.type, Math.abs(t.quantity), t.price, t.proceeds, t.commission,
    ];
  });
  return [header, ...data];
}

/**
 * Export pro účetní — stejná data jako Transakce, ale s přepočtem
 * do CZK kurzem ČNB k datu transakce. Účetní účtuje celkový náklad
 * pořízení (hodnota + komise), proto poslední sloupec „Nákup celkem CZK"
 * = (hodnota + komise) × kurz. Díky znaménkům (BUY záporná hodnota
 * i komise, SELL kladná hodnota, záporná komise) vzorec platí pro oba
 * typy — u SELL jde o čistý výnos po komisi.
 * Pokud kurz pro daný den chybí (víkend/svátek/budoucnost), v posledním
 * sloupci je místo částky text „chybí kurz ČNB".
 */
function buildTransactionsAccountingAoa() {
  const txs = getFilteredTransactions();
  const header = [
    "Datum", "Čas", "Symbol", "Název", "Burza", "Měna",
    "Typ", "Množství",
    "Cena (orig.)", "Hodnota (orig.)", "Komise (orig.)",
    "Kurz ČNB", "Nákup celkem CZK",
  ];
  const data = txs.map((t) => {
    const inst = state.portfolio.instruments[t.symbol] || {};
    const ccy = inst.currency || t.currency;
    // Strict mode — pokud kurz pro datum chybí, vrátí null
    const fxToCzk = getFxToCzk(t.date, ccy);
    const qty = Math.abs(t.quantity);

    const totalCzk = fxToCzk != null
      ? (t.proceeds + t.commission) * fxToCzk
      : "chybí kurz ČNB";

    return [
      t.date, t.time, t.symbol, inst.name, inst.exchange, ccy,
      t.type, qty,
      t.price, t.proceeds, t.commission,
      fxToCzk, totalCzk,
    ];
  });
  return [header, ...data];
}

function buildDividendsAoa() {
  // Replicate render grouping
  const events = new Map();
  for (const d of state.portfolio.dividends || []) {
    const k = `${d.symbol}|${d.date}`;
    if (!events.has(k)) {
      events.set(k, {
        symbol: d.symbol, date: d.date, currency: d.currency,
        gross: 0, tax: 0, country: null,
        gross_usd: 0, tax_usd: 0, per_share: d.per_share,
      });
    }
    const e = events.get(k);
    e.gross += d.amount;
    e.gross_usd += d.amount_usd || 0;
  }
  for (const t of state.portfolio.withholding_tax || []) {
    const k = `${t.symbol}|${t.date}`;
    if (!events.has(k)) {
      events.set(k, {
        symbol: t.symbol, date: t.date, currency: t.currency,
        gross: 0, tax: 0, country: t.country,
        gross_usd: 0, tax_usd: 0,
      });
    }
    const e = events.get(k);
    e.tax += t.amount;
    e.tax_usd += t.amount_usd || 0;
    e.country = e.country || t.country;
  }
  let arr = [...events.values()].sort((a, b) => b.date.localeCompare(a.date));
  const yr = state.divFilter.year;
  const q = state.searches.dividends;
  arr = arr.filter((r) => {
    if (yr && !r.date.startsWith(yr)) return false;
    if (q) {
      const inst = state.portfolio.instruments[r.symbol] || {};
      const h = `${r.symbol} ${inst.name || ""}`.toLowerCase();
      if (!h.includes(q)) return false;
    }
    return true;
  });
  // CZK přepočet kurzem ČNB k datu výplaty — strict mode (žádný fallback),
  // export slouží jako podklad pro účetnictví
  const header = [
    "Datum", "Symbol", "Název", "Země zdroje",
    "Hrubá", "Daň u zdroje", "Daň %", "Net", "Měna", "Net USD ekv.",
    "Kurz ČNB", "Hrubá CZK", "Daň CZK", "Net CZK",
  ];
  const data = arr.map((r) => {
    const inst = state.portfolio.instruments[r.symbol] || {};
    const taxPct = withholdingPct(r.gross, r.tax);
    const fx = getFxToCzk(r.date, r.currency);
    return [
      r.date, r.symbol, inst.name || "", r.country || "",
      r.gross, r.tax, taxPct, r.gross + r.tax, r.currency,
      r.gross_usd + r.tax_usd,
      fx != null ? fx : "chybí kurz ČNB",
      fx != null ? r.gross * fx : null,
      fx != null ? r.tax * fx : null,
      fx != null ? (r.gross + r.tax) * fx : null,
    ];
  });
  return [header, ...data];
}

function buildJournalAoa() {
  const entries = (state.journal?.entries || []).slice();
  entries.sort((a, b) => b.date.localeCompare(a.date));
  const q = (state.journalSearch || "").trim().toLowerCase();
  const filtered = q
    ? entries.filter((e) => e.text.toLowerCase().includes(q))
    : entries;
  const header = ["Datum", "Čas", "Text"];
  const data = filtered.map((e) => {
    const d = new Date(e.date);
    const date = d.toLocaleDateString("cs-CZ", {
      day: "2-digit", month: "2-digit", year: "numeric",
    });
    const time = d.toLocaleTimeString("cs-CZ", {
      hour: "2-digit", minute: "2-digit",
    });
    return [date, time, e.text];
  });
  return [header, ...data];
}

function buildWatchlistAoa() {
  const items = state.watchlist?.items || [];
  const q = state.searches.watchlist;
  const filtered = q
    ? items.filter((it) => `${it.symbol} ${it.name || ""}`.toLowerCase().includes(q))
    : items;
  const header = [
    "Symbol", "Název", "Měna", "Aktuální", "Pravidla", "Stav",
  ];
  const data = filtered.map((it) => {
    const quote = state.quotes[it.yahoo_symbol] || {};
    const rules = (it.rules || []).map((r) => {
      if (r.type === "price_below") return `cena < ${r.value}`;
      if (r.type === "price_above") return `cena > ${r.value}`;
      if (r.type === "drop_pct")
        return `pokles ≥ ${Math.abs(r.threshold_pct)}% od ${r.ref_price}`;
      return r.type;
    }).join(" · ");
    return [
      it.symbol, it.name || "", quote.currency || "",
      quote.price ?? null, rules || "(bez pravidla)",
      it.rules?.length > 0 ? "armed" : "no rule",
    ];
  });
  return [header, ...data];
}

function buildAlertsAoa() {
  const rules = state.alerts?.rules || [];
  const header = [
    "Pravidlo", "Typ", "Threshold %", "Symbol (pokud specific)", "Armed",
  ];
  const data = rules.map((r) => [
    r.description || r.id,
    r.type,
    r.threshold_pct ?? null,
    r.symbol || "",
    r.armed ? "yes" : "no",
  ]);
  return [header, ...data];
}

function exportReportXlsx() {
  // Report má strukturu blok per prodej. Vyexportujeme jako jeden flat list.
  const { from, to } = state.reportFilter;
  const fxDates = state.fxRates?.dates ? Object.keys(state.fxRates.dates).sort() : [];
  const eventsMap = new Map();
  for (const sym in state.positions) {
    const pos = state.positions[sym];
    for (const cl of pos.closed_lots || []) {
      if (cl.orphan) continue;
      if (from && cl.sell_date < from) continue;
      if (to && cl.sell_date > to) continue;
      const key = `${sym}|${cl.sell_date}`;
      let ev = eventsMap.get(key);
      if (!ev) {
        ev = {
          symbol: sym,
          sell_date: cl.sell_date,
          currency: state.portfolio.instruments[sym].currency,
          name: state.portfolio.instruments[sym].name,
          buys: [],
          sell_qty: 0,
          sell_net_total: 0,
          sell_price: cl.sell_price,
        };
        eventsMap.set(key, ev);
      }
      ev.buys.push({
        date: cl.buy_date,
        qty: cl.qty,
        total: cl.qty * cl.buy_cost_per_unit,
      });
      ev.sell_qty += cl.qty;
      ev.sell_net_total += cl.qty * cl.sell_net_per_unit;
    }
  }
  const events = [...eventsMap.values()].sort((a, b) =>
    a.sell_date.localeCompare(b.sell_date),
  );

  const aoa = [
    [
      "Symbol", "Název", "Měna", "Typ", "Datum", "Kusů",
      "Cena celkem (orig.)", "Kurz ČNB", "Cena celkem v Kč",
    ],
  ];
  let grandCost = 0, grandSell = 0;
  for (const ev of events) {
    // Slučit nákupy stejných dat
    const byDate = new Map();
    for (const b of ev.buys) {
      if (!byDate.has(b.date)) byDate.set(b.date, { date: b.date, qty: 0, total: 0 });
      const e = byDate.get(b.date);
      e.qty += b.qty;
      e.total += b.total;
    }
    const buys = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    let costCzk = 0;
    for (const b of buys) {
      const fx = getFxToCzk(b.date, ev.currency);
      const czk = fx != null ? b.total * fx : null;
      if (czk != null) costCzk += czk;
      aoa.push([
        ev.symbol, ev.name, ev.currency, "Nákup",
        b.date, b.qty, b.total, fx, czk,
      ]);
    }
    const sellFx = getFxToCzk(ev.sell_date, ev.currency);
    const sellCzk = sellFx != null ? ev.sell_net_total * sellFx : null;
    aoa.push([
      ev.symbol, ev.name, ev.currency, "Prodej",
      ev.sell_date, ev.sell_qty, ev.sell_net_total, sellFx, sellCzk,
    ]);
    aoa.push([
      ev.symbol, ev.name, ev.currency, "── Sumář",
      "", "", "",
      `Nákup: ${fmtNum(costCzk, 2)} CZK · Zisk: ${fmtNum((sellCzk ?? 0) - costCzk, 2)} CZK`,
      (sellCzk ?? 0) - costCzk,
    ]);
    aoa.push([]); // prázdný řádek mezi prodejními bloky
    grandCost += costCzk;
    grandSell += sellCzk ?? 0;
  }
  if (events.length > 0) {
    aoa.push([]);
    aoa.push(["GRAND TOTAL", "", "", "", "", "", "Nákup CZK", grandCost, ""]);
    aoa.push(["", "", "", "", "", "", "Prodej CZK", grandSell, ""]);
    aoa.push(["", "", "", "", "", "", "Zisk/Ztráta CZK", grandSell - grandCost, ""]);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, "Report");
  const fname = `${state.portfolio.id}-report-${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fname);
}

// ---------- Notes ----------
function noteIconHtml(symbol) {
  const note = state.notes?.[symbol];
  if (!note) return "";
  // Tooltip-safe (žádné " v title) + krátký prefix pro hover náhled
  const safe = String(note).replace(/"/g, "&quot;");
  return ` <span class="hint hint-note" data-note-edit="${symbol}" title="${safe}">i</span>`;
}

async function openNoteModal(symbol) {
  if (!symbol) return;
  const inst = state.portfolio?.instruments?.[symbol] || {};
  const watchItem = (state.watchlist?.items || []).find(
    (it) => it.symbol === symbol,
  );
  const name = inst.name || watchItem?.name || "";
  const existing = state.notes?.[symbol] || "";

  document.getElementById("note-title").textContent =
    `Poznámka — ${symbol}${name ? ` (${name})` : ""}`;
  document.getElementById("note-subtitle").textContent =
    "Poznámka je sdílená mezi Přehled pozic a Watchlistem.";
  const ta = document.getElementById("note-text");
  ta.value = existing;
  document.getElementById("note-error").textContent = "";

  const btnDelete = document.getElementById("btn-delete-note");
  btnDelete.hidden = !existing;

  // Save handler — bind každý open znovu kvůli capture symbolu
  const btnSave = document.getElementById("btn-save-note");
  const newBtnSave = btnSave.cloneNode(true);
  btnSave.parentNode.replaceChild(newBtnSave, btnSave);
  newBtnSave.addEventListener("click", () => saveNote(symbol, ta.value));

  const newBtnDelete = btnDelete.cloneNode(true);
  btnDelete.parentNode.replaceChild(newBtnDelete, btnDelete);
  newBtnDelete.hidden = !existing;
  newBtnDelete.addEventListener("click", () => saveNote(symbol, ""));

  openModal("modal-edit-note");
  setTimeout(() => ta.focus(), 50);
}

async function saveNote(symbol, text) {
  const errEl = document.getElementById("note-error");
  errEl.textContent = "";
  try {
    const res = await fetch(NOTES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, text }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || `HTTP ${res.status}`;
      return;
    }
    // Lokálně promítnout
    if (text.trim() === "") {
      delete state.notes[symbol];
    } else {
      state.notes[symbol] = text.trim();
    }
    closeModal("modal-edit-note");
    // Re-render všeho, co note zobrazuje
    if (state.positions) renderOverview();
    renderWatchlist();
  } catch (e) {
    errEl.textContent = `Síťová chyba: ${e.message}`;
  }
}

// ---------- Helpers ----------
function signClass(n) {
  if (n == null || isNaN(n) || n === 0) return "";
  return n > 0 ? "pos" : "neg";
}

function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function setStatus(msg) {
  const el = document.getElementById("status");
  if (!msg) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  el.classList.remove("error");
  el.textContent = msg;
}

function showError(msg) {
  const el = document.getElementById("status");
  el.style.display = "block";
  el.classList.add("error");
  el.textContent = msg;
}

import {
  cashAtDate,
  computePositions,
  computePositionsAt,
  positionTotalReturn,
  splitFactorAfter,
  unrealizedPnl,
  fmtNum,
  fmtPct,
  fmtMoney,
} from "./fifo.js";
import { flexDate } from "./flex-shared.js";
import {
  amountToUsd,
  capitalFlowsUsd,
  cashToCzk,
  closedPositions,
  fxToCzk,
  mergeOverlayIntoPortfolio,
  openLotsCostCzk,
  portfolioTotalReturn,
  pragueToday,
  realizedSales,
} from "./portfolio-shared.js";
import {
  DPPO_RATE,
  currentFxInfo,
  dividendsInYear,
  lossCarryOverview,
  realizedInYear,
  simulateSale,
  taxEstimate,
  taxPositionRows,
  unrealizedTotals,
  withPositions,
} from "./tax-optimization.js";
import {
  OWNER_TYPES,
  OWNER_TYPE_LABELS,
  companiesOf,
  ownerIdFromName,
  resolveOwners,
  validateOwnerSettings,
} from "./owners.js";

const MANIFEST_URL = "./data/portfolios/manifest.json";
const PORTFOLIO_BASE = "./data/portfolios/";
const FX_URL = "./data/fx_rates.json";
const TAX_RETURNS_URL = "./data/tax-returns.json";
// Watchlist + alerts jsou teď KV-backed přes Pages Functions
const WATCHLIST_URL = "/api/watchlist";
const ALERTS_URL = "/api/alerts";
const NOTES_URL = "/api/notes";
const JOURNAL_URL = "/api/journal";
const SETTINGS_URL = "/api/settings";
const QUOTE_URL = "/api/quote";

// LocalStorage key pro pamatování posledního výběru portfolia
const LS_PORTFOLIO = "akcie-tracker.portfolio";
const LS_COMPANY = "akcie-tracker.company";

// Taby z hlavičky: přehledy za firmu a Nastavení. Nezávisí na zvoleném portfoliu,
// dlaždice a výběr portfolia se u nich schovají.
const COMPANY_VIEWS = new Set(["tax", "positions-at"]);
const HEADER_VIEWS = new Set([...COMPANY_VIEWS, "settings"]);

const state = {
  manifest: null,
  portfolioId: null,
  portfolio: null,
  positions: null,
  quotes: {},
  fxRates: null,
  view: "overview",
  // Vlastníci portfolií: uložené nastavení (/api/settings) a výsledek s manifestem
  ownerSettings: null,
  owners: null,
  companyId: null,
  // Rozepsané změny v Nastavení — při návratu do tabu se formulář nepřekreslí
  settingsDirty: false,
  settingsBaseline: "",
  // Inventurní výpis pozic k datu (tab Pozice k datu) — cache portfolií per session
  positionsAt: {
    date: null, rows: null, cashRows: null, cashMissing: null,
    portfolios: null, fxValidFor: null, loading: false,
  },
  // Daňová optimalizace (za zvolenou firmu) — sestaví se při prvním otevření tabu
  taxOpt: { data: null, loading: false, selected: new Set(), sort: { key: "pnlCzk", dir: "asc" } },
  sort: { key: "sym", dir: "asc" },
  // Přehled pozic: držené („open“), nebo celé prodané tituly („closed“) s vlastním řazením
  overviewMode: "open",
  closedSort: { key: "lastSell", dir: "desc" },
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
  loadWarnings: [],
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

  // 1) Load manifest, FX rates, watchlist, alerts, notes, journal, nastavení paralelně
  const [manifestRes, fxRes, watchRes, alertsRes, notesRes, journalRes, settingsRes] = await Promise.all([
    fetch(MANIFEST_URL, { cache: "no-cache" }),
    fetch(FX_URL, { cache: "no-cache" }),
    fetch(WATCHLIST_URL, { cache: "no-cache" }),
    fetch(ALERTS_URL, { cache: "no-cache" }),
    fetch(NOTES_URL, { cache: "no-cache" }),
    fetch(JOURNAL_URL, { cache: "no-cache" }),
    fetch(SETTINGS_URL, { cache: "no-cache" }).catch(() => null),
  ]);
  if (!manifestRes.ok) throw new Error(`Manifest ${manifestRes.status}`);
  state.manifest = await manifestRes.json();
  // Bez uloženého nastavení (nebo když API neodpoví) platí vlastníci z manifestu
  state.ownerSettings = settingsRes?.ok ? (await settingsRes.json()).settings : null;
  state.owners = resolveOwners(state.manifest, state.ownerSettings);
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
  state.companyId = pickCompany(localStorage.getItem(LS_COMPANY));

  // 3) Load aktivního portfolia
  await loadActivePortfolio();

  // 4) Setup UI + selector
  renderHeader();
  setupTabs();
  setupRefresh();
  setupSort();
  setupExpand();
  setupOverviewMode();
  setupTxFilter();
  setupDivFilter();
  setupReportFilter();
  setupOverviewSearch();
  setupWatchlistModal();
  setupEditWatchModal();
  setupAlertsModal();
  setupModalClose("modal-edit-note");
  setupJournal();
  setupPortfolioHistory();
  setupPortfolioSwitcher();
  setupCompanySwitcher();
  setupPositionsAt();
  setupTaxOpt();
  setupSettings();

  // 5) Fetch live quotes
  await refreshQuotes();
}

async function loadActivePortfolio() {
  const meta = state.manifest.portfolios.find((p) => p.id === state.portfolioId);
  if (!meta) throw new Error(`Portfolio ${state.portfolioId} v manifestu nenalezeno`);
  setStatus(`Načítám ${meta.name}…`);
  state.loadWarnings = [];
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
    renderLoadWarnings();
    return;
  }
  state.portfolio = await res.json();

  // Mergnout overlay (pokud existuje a má nějaká data)
  state.overlayStats = null;
  if (overlayRes && overlayRes.ok) {
    try {
      const overlay = await overlayRes.json();
      state.overlayStats = mergeOverlayIntoPortfolio(state.portfolio, overlay, state.fxRates);
    } catch (e) {
      console.warn(`Overlay merge selhal: ${e.message}`);
      state.loadWarnings.push(
        "Overlay z auto-importu se nepodařilo zpracovat — zobrazena jsou jen data z posledního ručního commitu.",
      );
    }
  } else {
    // Tichá degradace je horší než viditelná chyba — bez overlay chybí
    // transakce z denního auto-importu, ale čísla vypadají validně.
    state.loadWarnings.push(
      "Overlay auto-import je nedostupný — zobrazena jsou jen data z posledního ručního commitu.",
    );
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
      state.loadWarnings.push(
        "NAV historie se nenačetla — graf Hodnota portfolia může být neúplný.",
      );
    }
  }

  // Zastaralý auto-import = pravděpodobně spadlý flex-import worker.
  // Víkendová pauza dělá mezeru max ~3 dny, 4+ dní je podezřelých.
  if (state.overlayStats?.last_import) {
    const ageDays =
      (Date.now() - new Date(state.overlayStats.last_import).getTime()) / 86400000;
    if (ageDays > 4) {
      state.loadWarnings.push(
        `Poslední auto-import (${meta.short || meta.broker}) proběhl před ${Math.floor(ageDays)} dny — zkontroluj worker flex-import.`,
      );
    }
  }

  state.positions = computePositions(
    state.portfolio.transactions || [],
    state.portfolio.corporate_actions || [],
    state.portfolio.dividends || [],
    state.portfolio.withholding_tax || [],
  );
  renderLoadWarnings();
}

// Merge overlay, kurzy a přepočty žijí v ./portfolio-shared.js, Flex
// transformace v ./flex-shared.js — sdílené s Workerem (alerty, MCP konektor).
// Tady jen tenký obal nad kurzy načtenými appkou.
function convertToUsd(amount, currency, date) {
  return amountToUsd(state.fxRates, amount, currency, date);
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
  const sel = document.getElementById("portfolio-select");
  if (!sel) return;
  renderPortfolioOptions();
  sel.addEventListener("change", async () => {
    state.portfolioId = sel.value;
    localStorage.setItem(LS_PORTFOLIO, state.portfolioId);
    state.quotes = {}; // invalidate
    await loadActivePortfolio();
    renderHeader();
    await refreshQuotes();
  });
}

// Portfolia seskupená podle vlastníků (Nastavení), portfolio bez vlastníka na konci
function renderPortfolioOptions() {
  const sel = document.getElementById("portfolio-select");
  if (!sel) return;
  const metas = new Map((state.manifest.portfolios || []).map((p) => [p.id, p]));
  const group = (label, list) => {
    const g = document.createElement("optgroup");
    g.label = label;
    for (const p of list) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      g.appendChild(o);
    }
    sel.appendChild(g);
  };
  sel.innerHTML = "";
  for (const owner of state.owners.owners) {
    if (owner.portfolios.length) group(owner.name, owner.portfolios.map((id) => metas.get(id)));
  }
  const orphans = (state.manifest.portfolios || []).filter((p) => !state.owners.ownerOf[p.id]);
  if (orphans.length) group("Bez vlastníka", orphans);
  sel.value = state.portfolioId;
}

// ---------- Firma (přehledy za firmu) ----------
// Uložená volba, jinak vlastník aktivního portfolia, jinak první firma
function pickCompany(preferred) {
  const ids = companiesOf(state.owners).map((c) => c.id);
  if (ids.includes(preferred)) return preferred;
  const own = state.owners.ownerOf[state.portfolioId];
  return ids.includes(own) ? own : ids[0] || null;
}

function currentCompany() {
  return companiesOf(state.owners).find((c) => c.id === state.companyId) || null;
}

function companyPortfolioLabel(company) {
  const metas = new Map((state.manifest.portfolios || []).map((p) => [p.id, p]));
  return (company?.portfolios || []).map((id) => metas.get(id)?.short || metas.get(id)?.name || id).join(", ");
}

// Přehledy za firmu počítají jen portfolia zvolené firmy — nikdy jiné firmy ani osob
function companyPortfolios(list) {
  return list.filter(({ meta }) => state.owners.ownerOf[meta.id] === state.companyId);
}

function setupCompanySwitcher() {
  const sel = document.getElementById("company-select");
  if (!sel) return;
  renderCompanyOptions();
  sel.addEventListener("change", () => setCompany(sel.value));
}

function renderCompanyOptions() {
  const sel = document.getElementById("company-select");
  if (!sel) return;
  sel.innerHTML = "";
  for (const c of companiesOf(state.owners)) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name;
    sel.appendChild(o);
  }
  sel.value = state.companyId || "";
}

function setCompany(id) {
  state.companyId = id;
  try {
    localStorage.setItem(LS_COMPANY, id);
  } catch {}
  resetCompanyViews();
  renderHeader();
  if (state.view === "tax") buildTaxOpt();
  else if (state.view === "positions-at") buildPositionsAt();
}

// Výsledky patří k jedné firmě — po změně firmy nebo vlastníků se sestaví znovu
function resetCompanyViews() {
  state.taxOpt.data = null;
  state.taxOpt.selected = new Set();
  state.positionsAt.rows = null;
  for (const id of ["tax-cards", "tax-wrap", "pa-title", "pa-wrap", "pa-cash-wrap", "pa-summary"]) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  for (const id of ["tax-count", "pa-count"]) {
    const el = document.getElementById(id);
    if (el) el.textContent = "";
  }
}

// ---------- Nastavení: vlastníci portfolií ----------
let newOwnerSeq = 0;

function setupSettings() {
  const form = document.getElementById("settings-form");
  if (!form) return;
  // Změna = úprava od uživatele; programové doplnění formuláře se nepočítá
  form.addEventListener("input", (e) => {
    if (!e.isTrusted) return;
    if (e.target.matches("[data-owner-name]")) refreshOwnerChoices();
    updateSettingsDirty();
  });
  form.addEventListener("change", (e) => {
    if (!e.isTrusted) return;
    refreshOwnerChoices();
    updateSettingsDirty();
  });
  document.getElementById("settings-add-owner").addEventListener("click", () => {
    const tbody = document.querySelector("#tbl-owners tbody");
    const tr = ownerRow({ id: "", name: "", type: "firma" });
    tbody.appendChild(tr);
    refreshOwnerChoices();
    updateSettingsDirty();
    tr.querySelector("[data-owner-name]").focus();
  });
  document.querySelector("#tbl-owners tbody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-owner-remove]");
    if (!btn || btn.disabled) return;
    btn.closest("tr").remove();
    refreshOwnerChoices();
    updateSettingsDirty();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    saveSettings();
  });
  // Rozepsané nastavení nezmizí se zavřením stránky bez varování
  window.addEventListener("beforeunload", (e) => {
    if (!state.settingsDirty) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

function ownerRow(owner) {
  const tr = document.createElement("tr");
  tr.dataset.ownerId = owner.id;
  tr.dataset.ownerKey = owner.id || `new-${++newOwnerSeq}`;
  const name = document.createElement("input");
  name.type = "text";
  name.maxLength = 80;
  name.value = owner.name;
  name.placeholder = "Název firmy nebo jméno";
  name.setAttribute("aria-label", "Název vlastníka");
  name.dataset.ownerName = "";
  const type = document.createElement("select");
  type.setAttribute("aria-label", "Typ vlastníka");
  type.dataset.ownerType = "";
  for (const t of OWNER_TYPES) type.add(new Option(OWNER_TYPE_LABELS[t], t, false, t === owner.type));
  const count = document.createElement("td");
  count.className = "num";
  count.dataset.ownerCount = "";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn-action";
  remove.textContent = "Odebrat";
  remove.dataset.ownerRemove = "";
  for (const el of [name, type]) {
    const td = document.createElement("td");
    td.appendChild(el);
    tr.appendChild(td);
  }
  tr.appendChild(count);
  const td = document.createElement("td");
  td.appendChild(remove);
  tr.appendChild(td);
  return tr;
}

function renderSettings() {
  const ownersBody = document.querySelector("#tbl-owners tbody");
  const portBody = document.querySelector("#tbl-owner-portfolios tbody");
  if (!ownersBody || !portBody) return;
  ownersBody.innerHTML = "";
  for (const o of state.owners.owners) ownersBody.appendChild(ownerRow(o));
  portBody.innerHTML = "";
  for (const p of state.manifest.portfolios || []) {
    const tr = document.createElement("tr");
    tr.dataset.portfolioId = p.id;
    const sel = document.createElement("select");
    sel.dataset.portfolioOwner = "";
    sel.dataset.value = state.owners.ownerOf[p.id] || "";
    sel.setAttribute("aria-label", `Vlastník portfolia ${p.name}`);
    for (const text of [p.name, p.broker || ""]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }
    const td = document.createElement("td");
    td.appendChild(sel);
    tr.appendChild(td);
    portBody.appendChild(tr);
  }
  document.getElementById("settings-error").textContent = "";
  refreshOwnerChoices();
  state.settingsBaseline = settingsSnapshot();
  state.settingsDirty = false;
  renderSettingsState();
}

// Neuložené změny = formulář se liší od stavu po posledním vykreslení
// (přepsat název a vrátit ho zpět změna není)
function settingsSnapshot() {
  const owners = [...document.querySelectorAll("#tbl-owners tbody tr")].map((tr) => [
    tr.dataset.ownerKey,
    tr.querySelector("[data-owner-name]").value.trim(),
    tr.querySelector("[data-owner-type]").value,
  ]);
  const assignments = [...document.querySelectorAll("[data-portfolio-owner]")].map((sel) => sel.value);
  return JSON.stringify([owners, assignments]);
}

function updateSettingsDirty() {
  state.settingsDirty = settingsSnapshot() !== state.settingsBaseline;
  renderSettingsState();
}

// Volby vlastníků u portfolií podle aktuálních řádků (i neuložených), počty
// portfolií a zákaz odebrat vlastníka, který ještě něco vlastní
function refreshOwnerChoices() {
  const rows = [...document.querySelectorAll("#tbl-owners tbody tr")];
  const counts = new Map(rows.map((tr) => [tr.dataset.ownerKey, 0]));
  for (const sel of document.querySelectorAll("[data-portfolio-owner]")) {
    const current = sel.options.length ? sel.value : sel.dataset.value;
    sel.innerHTML = "";
    if (!counts.has(current)) sel.add(new Option("— vyber vlastníka —", ""));
    for (const tr of rows) {
      const name = tr.querySelector("[data-owner-name]").value.trim() || "(bez názvu)";
      sel.add(new Option(name, tr.dataset.ownerKey));
    }
    sel.value = counts.has(current) ? current : "";
    if (counts.has(sel.value)) counts.set(sel.value, counts.get(sel.value) + 1);
  }
  for (const tr of rows) {
    const n = counts.get(tr.dataset.ownerKey);
    tr.querySelector("[data-owner-count]").textContent = String(n);
    const btn = tr.querySelector("[data-owner-remove]");
    btn.disabled = n > 0 || rows.length === 1;
    btn.title = n > 0
      ? "Nejdřív přiřaď jeho portfolia jinému vlastníkovi"
      : rows.length === 1
        ? "Aspoň jeden vlastník musí zůstat"
        : "";
  }
}

function renderSettingsState() {
  const el = document.getElementById("settings-state");
  if (!el) return;
  const saved = state.ownerSettings?.updated_at;
  el.classList.toggle("dirty", state.settingsDirty);
  el.textContent = state.settingsDirty
    ? "Neuložené změny"
    : saved
      ? `Uloženo ${new Date(saved).toLocaleString("cs-CZ", { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}`
      : "Výchozí nastavení z manifestu – zatím neuloženo";
}

async function saveSettings() {
  const errEl = document.getElementById("settings-error");
  errEl.textContent = "";
  const rows = [...document.querySelectorAll("#tbl-owners tbody tr")];
  // Id nového vlastníka vznikne z názvu až při uložení
  const taken = new Set(rows.map((tr) => tr.dataset.ownerId).filter(Boolean));
  const idOf = new Map();
  const owners = rows.map((tr) => {
    const name = tr.querySelector("[data-owner-name]").value.trim();
    let id = tr.dataset.ownerId;
    if (!id) {
      id = ownerIdFromName(name, taken);
      taken.add(id);
    }
    idOf.set(tr.dataset.ownerKey, id);
    return { id, name, type: tr.querySelector("[data-owner-type]").value };
  });
  const assignments = {};
  for (const tr of document.querySelectorAll("#tbl-owner-portfolios tbody tr")) {
    const key = tr.querySelector("[data-portfolio-owner]").value;
    if (!key) {
      errEl.textContent = `Portfolio ${tr.firstChild.textContent} nemá vlastníka.`;
      return;
    }
    assignments[tr.dataset.portfolioId] = idOf.get(key);
  }
  const { settings, error } = validateOwnerSettings({ owners, assignments });
  if (error) {
    errEl.textContent = error;
    return;
  }
  const btn = document.getElementById("settings-save");
  btn.disabled = true;
  try {
    const res = await fetch(SETTINGS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    state.ownerSettings = json.settings;
    state.owners = resolveOwners(state.manifest, state.ownerSettings);
    state.companyId = pickCompany(state.companyId);
    resetCompanyViews();
    renderPortfolioOptions();
    renderCompanyOptions();
    renderSettings();
  } catch (e) {
    errEl.textContent = `Uložení selhalo: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- Header ----------
function renderHeader() {
  const view = state.view;
  const h1 = document.getElementById("portfolio-name");
  const metaEl = document.getElementById("portfolio-meta");
  document.getElementById("portfolio-switcher").hidden =
    HEADER_VIEWS.has(view) || (state.manifest.portfolios || []).length < 2;
  document.getElementById("company-switcher").hidden = !COMPANY_VIEWS.has(view);
  if (view === "settings") {
    h1.textContent = "Nastavení";
    metaEl.textContent = "Vlastníci portfolií – kdo které portfolio vlastní";
    document.title = "Nastavení — Akcie tracker";
    return;
  }
  if (COMPANY_VIEWS.has(view)) {
    const company = currentCompany();
    const label = companyPortfolioLabel(company);
    h1.textContent = company?.name || "Žádná firma";
    metaEl.textContent = company
      ? `Firma · portfolia ${label}`
      : "V Nastavení není žádná firma s portfoliem";
    document.querySelectorAll("[data-company-portfolios]").forEach((el) => {
      el.textContent = label || "žádné";
    });
    const viewName = view === "tax" ? "Daňová optimalizace" : "Pozice k datu";
    document.title = `${company?.name || "Firma"} — ${viewName} — Akcie tracker`;
    return;
  }

  const p = state.portfolio;
  h1.textContent = p.name;

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

  metaEl.textContent = parts.join(" · ");
  document.title = `${p.name} — Akcie tracker`;
}

// ---------- Tabs ----------
function setupTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });
  placeViewActions(state.view);
}

function showView(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === view),
  );
  document.querySelectorAll(".view").forEach((v) =>
    v.classList.toggle("active", v.id === `view-${view}`),
  );
  // Dlaždice patří zvolenému portfoliu — u přehledů za firmu a Nastavení nedávají smysl
  document.body.classList.toggle("header-view", HEADER_VIEWS.has(view));
  placeViewActions(view);
  renderHeader();
  // Inventura a daňový přehled se sestaví při prvním otevření (načítají portfolia
  // firmy + ceny) a znovu, když se mezitím změnila firma
  if (view === "positions-at" && !state.positionsAt.loading && (!state.positionsAt.rows || positionsAtStale())) {
    buildPositionsAt();
  }
  if (view === "tax" && !state.taxOpt.loading && (!state.taxOpt.data || taxOptStale())) {
    buildTaxOpt();
  }
  if (view === "settings" && !state.settingsDirty) renderSettings();
}

// Jedna skupina tlačítek pro všechny taby — přesune se do lišty nad tabulkou
// tabu, který je vidět. Tab bez lišty (Nastavení) ji nechá ve skrytém tabu.
function placeViewActions(view) {
  const actions = document.getElementById("view-actions");
  const slot = document.querySelector(`#view-${view} [data-view-actions]`);
  if (!actions || !slot) return;
  slot.appendChild(actions);
  document.getElementById("btn-export-accounting").hidden = view !== "transactions";
  // Tisk se používá pro Report a inventuru — tiskový styl schová vše kromě aktivního tabu
  document.getElementById("btn-print-report").hidden = !(view === "report" || view === "positions-at");
  document.getElementById("btn-export-xlsx").hidden = view === "portfolio-history";
}

function setupRefresh() {
  document.getElementById("btn-refresh").addEventListener("click", () => {
    // Přehledy za firmu si načítají portfolia i ceny samy — znovu od začátku
    if (COMPANY_VIEWS.has(state.view)) {
      state.positionsAt.portfolios = null;
      if (state.view === "tax") buildTaxOpt();
      else buildPositionsAt();
      return;
    }
    refreshQuotes().catch((err) => showError(err.message));
  });
  document.getElementById("btn-export-xlsx").addEventListener("click", () => {
    exportCurrentViewXlsx();
  });
  document.getElementById("btn-export-accounting")?.addEventListener("click", () => {
    exportTransactionsAccountingXlsx();
  });
  // PDF export reportu = tisk do PDF (print styl v styles.css schová chrome
  // aplikace; titulek stránky nese jméno portfolia → objeví se v hlavičce PDF)
  document.getElementById("btn-print-report")?.addEventListener("click", () => {
    window.print();
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
  const instruments = Object.values(state.portfolio.instruments);
  // Delisted tituly (instruments[sym].delisted = datum) na Yahoo neexistují —
  // neptáme se a přiřadíme syntetickou nulovou cenu: pozice je bezcenná do
  // vyřešení restrukturalizace, počítá se do hodnot jako 0, UI ukáže badge.
  const symbols = instruments
    .filter((i) => !i.delisted)
    .map((i) => i.yahoo_symbol);
  setStatus(`Načítám ceny pro ${symbols.length} titulů…`);

  const url = `${QUOTE_URL}?symbols=${encodeURIComponent(symbols.join(","))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Quote API ${res.status}`);
  const data = await res.json();
  state.quotes = data.quotes;
  state.quotesFetchedAt = data.fetched_at;
  for (const i of instruments) {
    if (i.delisted) {
      state.quotes[i.yahoo_symbol] = { price: 0, currency: i.currency, delisted: true };
    }
  }

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
    // Přehled pozic zobrazuje watchlist stav v ⋯ menu — držet v sync
    if (state.positions) renderOverview();
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
      '<div class="muted small rules-empty">Žádné pravidlo. Přidejte níže.</div>';
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
  // Přehled pozic — "Přidat do watchlistu" z ⋯ menu. Bez modalu a pravidel;
  // API si přes Yahoo validaci doplní název/měnu, pravidla jdou přidat později.
  if (t.matches?.("[data-pos-watch-add]")) {
    const sym = t.dataset.posWatchAdd;
    const inst = state.portfolio?.instruments?.[sym];
    if (!inst) return;
    const res = await fetch(WATCHLIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        symbol: sym,
        yahoo_symbol: inst.yahoo_symbol || sym,
        rules: [],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(data.error || `Přidání do watchlistu selhalo (HTTP ${res.status})`);
      return;
    }
    await reloadWatchlist(); // překreslí i Přehled — menu se přepne na "Aktualizovat značku"
    return;
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
    if (empty) empty.hidden = false;
    if (wrap) wrap.hidden = true;
    return;
  }
  if (empty) empty.hidden = true;
  if (wrap) wrap.hidden = false;

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
      html += `<div class="muted alert-preview-empty">Aktuálně žádný titul nesplňuje toto pravidlo. ✓</div>`;
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
      html += `<div class="muted alert-preview-note">Pokud by cron běžel teď: <strong>${matches.length} ${matches.length === 1 ? "alert" : matches.length < 5 ? "alerty" : "alertů"}</strong> by se odeslalo.</div>`;
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
      // Delisted (syntetická cena 0) by vždy „splnil" pokles — nehlídáme ho
      if (quote.price == null || quote.delisted) continue;
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
      if (quote.price != null && !quote.delisted) {
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
    const ccy = n.currency;
    const fx = getFxToCzk(n.date, ccy, { allowFallback: true });
    const czk = fx != null ? n.value * fx : null;
    tbody.innerHTML += `
      <tr>
        <td><strong>${y}</strong></td>
        <td class="num">${n.date}</td>
        <td class="num"><strong>${fmtNum(n.value, 2)} ${ccy}</strong></td>
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
  //    - static_nav_history = jednorázový backfill (IBKR: Activity Statement
  //      + Yahoo, outputs/backfill_nav.py; Lynx: Flex výpisy po letech)
  //    - nav_history (overlay) = denní cron z IB Flex Web Service
  //    Dedupe po reportDate, overlay (čerstvější) má prioritu pro stejné datum.
  //    Hodnota je v měně účtu (IBKR USD, Lynx CZK), do Kč kurzem k danému dni.
  const navByDate = new Map();
  const ingest = (arr, source) => {
    for (const n of arr || []) {
      if (!n.reportDate || n.total == null) continue;
      const date = flexDate(n.reportDate);
      const value = parseFloat(n.total);
      if (!date || !Number.isFinite(value)) continue;
      // Pokud už máme záznam pro to datum, prioritu má 'overlay' (čerstvější data)
      const existing = navByDate.get(date);
      if (!existing || source === "overlay") {
        navByDate.set(date, {
          date,
          value,
          currency: n.currency || p?.base_currency || "USD",
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

  // V tabulce chronologicky obráceně (nejnovější nahoře)
  for (let i = nav.length - 1; i >= 0; i--) {
    const n = nav[i];
    const prev = i > 0 ? nav[i - 1] : null;
    const fx = getFxToCzk(n.date, n.currency, { allowFallback: true });
    const valueCzk = fx ? n.value * fx : null;
    // Sloupec USD: u účtu v USD hodnota sama, jinak ekvivalent kurzem ČNB
    const usdFx = getFxToCzk(n.date, "USD", { allowFallback: true });
    const valueUsd = n.currency === "USD" ? n.value : valueCzk != null && usdFx ? valueCzk / usdFx : null;
    // Denní změna v měně účtu a do Kč kurzem dne — kurzový pohyb ji nezkreslí
    const dayDelta =
      prev != null ? n.value - prev.value : null;
    const dayDeltaCzk = dayDelta != null && fx ? dayDelta * fx : null;
    const dayDeltaPct =
      prev != null && prev.value > 0
        ? (dayDelta / prev.value) * 100
        : null;

    const deps = depositsByDate.get(n.date);
    const noteHtml = deps
      ? `<span class="ph-deposit-note">💰 ${deps.map((d) => `${d.amount < 0 ? "výběr" : "vklad"} ${fmtNum(Math.abs(d.amount), 2)} ${d.currency}`).join(", ")}</span>`
      : "";

    const rowClass = deps ? ' class="ph-row-deposit"' : "";
    tbody.innerHTML += `
      <tr${rowClass}>
        <td>${n.date}</td>
        <td class="num">${valueCzk != null ? fmtNum(valueCzk, 0) : '<span class="muted">—</span>'}</td>
        <td class="num">${valueUsd != null ? fmtNum(valueUsd, 0) : '<span class="muted">—</span>'}</td>
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

  // Current NAV = poslední záznam v navRaw (bez ohledu na filtr), v měně účtu
  const last = navRaw.length > 0 ? navRaw[navRaw.length - 1] : null;
  const ccy = last?.currency || p?.base_currency || "USD";
  const currentNav = last ? last.value : 0;
  const currentDate = last ? last.date : null;

  // Total deposits — sečíst VŠECHNY (historické + Flex overlay), dedupe by (date+amount+ccy),
  // v měně účtu kurzem ke dni vkladu (Lynx: vklady v CZK i EUR)
  let totalDeposits = 0;
  for (const [date, deps] of depositsByDateMap) {
    for (const d of deps) {
      const v = amountInCcy(d.amount, d.currency, ccy, date);
      if (Number.isFinite(v)) totalDeposits += v;
    }
  }

  const fxToday = currentDate ? getFxToCzk(currentDate, ccy, { allowFallback: true }) : null;
  const usdToday = currentDate ? getFxToCzk(currentDate, "USD", { allowFallback: true }) : null;

  const fmtMoney = (v) => {
    if (fxToday != null) return `${fmtNum(v * fxToday, 0)} Kč`;
    return `${fmtNum(v, 0)} ${ccy}`;
  };
  // Pod hodnotou měna účtu, u korunového účtu orientačně USD
  const subMoney = (v) =>
    ccy !== "CZK" ? `${fmtNum(v, 0)} ${ccy} ekv.` : usdToday ? `≈ ${fmtNum(v / usdToday, 0)} USD` : "";

  setText("ph-total-deposits-czk", fmtMoney(totalDeposits));
  setText("ph-total-deposits-usd", subMoney(totalDeposits));

  setText("ph-current-nav-czk", fmtMoney(currentNav));
  setText("ph-current-nav-usd", subMoney(currentNav));

  // Diff
  const diff = currentNav - totalDeposits;
  const diffCzk = fxToday != null ? diff * fxToday : null;
  const diffPct =
    totalDeposits > 0 ? (diff / totalDeposits) * 100 : 0;

  const diffEl = document.getElementById("ph-net-diff-czk");
  if (diffEl) {
    const prefix = diff > 0 ? "+" : "";
    diffEl.textContent =
      diffCzk != null
        ? `${prefix}${fmtNum(diffCzk, 0)} Kč`
        : `${prefix}${fmtNum(diff, 0)} ${ccy}`;
    diffEl.className = `ph-tile-value ${signClass(diff)}`;
  }
  const pctEl = document.getElementById("ph-net-diff-pct");
  if (pctEl) {
    pctEl.textContent = `${diff > 0 ? "+" : ""}${diffPct.toFixed(2)} %`;
    pctEl.className = `ph-tile-sub ${signClass(diff)}`;
  }
}

/**
 * Částka v měně účtu kurzem ČNB ke dni (vklad v EUR na korunový účet).
 * Do USD stejně jako dosud convertToUsd — čísla IBKR se nemění.
 */
function amountInCcy(amount, from, to, date) {
  if (from === to) return amount;
  if (to === "USD") return convertToUsd(amount, from, date);
  const fromFx = getFxToCzk(date, from, { allowFallback: true });
  const toFx = getFxToCzk(date, to, { allowFallback: true });
  return fromFx != null && toFx ? (amount * fromFx) / toFx : NaN;
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
  const ccy = end.currency;
  const ccyLabel = ccy === "CZK" ? "Kč" : ccy;
  const fxStart = getFxToCzk(start.date, ccy, { allowFallback: true });
  const fxEnd = getFxToCzk(end.date, ccy, { allowFallback: true });
  const startCzk = fxStart ? start.value * fxStart : null;
  const endCzk = fxEnd ? end.value * fxEnd : null;
  const change = end.value - start.value;
  const changeCzk = endCzk != null && startCzk != null ? endCzk - startCzk : null;
  const changePct =
    start.value > 0 ? (change / start.value) * 100 : 0;

  setText("ph-start-value", startCzk != null ? `${fmtNum(startCzk, 0)} Kč` : `${fmtNum(start.value, 0)} ${ccyLabel}`);
  setText("ph-start-date", start.date);
  setText("ph-end-value", endCzk != null ? `${fmtNum(endCzk, 0)} Kč` : `${fmtNum(end.value, 0)} ${ccyLabel}`);
  setText("ph-end-date", end.date);

  const changeEl = document.getElementById("ph-change-value");
  if (changeEl) {
    changeEl.textContent = changeCzk != null ? `${changeCzk > 0 ? "+" : ""}${fmtNum(changeCzk, 0)} Kč` : `${change > 0 ? "+" : ""}${fmtNum(change, 0)} ${ccyLabel}`;
    changeEl.className = `ph-tile-value ${signClass(changeCzk ?? change)}`;
  }
  setText("ph-change-pct", `${changePct > 0 ? "+" : ""}${changePct.toFixed(2)} %`);

  // Vklady v období — sečíst všechny v daterange (start..end), v měně účtu
  let depCountInRange = 0;
  let depTotal = 0;
  for (const [date, deps] of depositsByDate) {
    if (date < start.date || date > end.date) continue;
    for (const d of deps) {
      depCountInRange++;
      const v = amountInCcy(d.amount, d.currency, ccy, date);
      if (Number.isFinite(v)) depTotal += v;
    }
  }
  setText("ph-deposits-value", `${fmtNum(depTotal, 0)} ${ccyLabel}`);
  setText("ph-deposits-count", `${depCountInRange} transakc${depCountInRange === 1 ? "e" : depCountInRange < 5 ? "í" : "í"}`);
}

function renderNavChartSvg(nav, depositsByDate) {
  if (nav.length < 2) {
    return `<div class="ph-chart-empty">Graf vyžaduje aspoň 2 data points. Aktuálně máme ${nav.length}.</div>`;
  }

  const W = 1200;
  const H = 320;
  const padL = 70, padR = 20, padT = 16, padB = 32;

  const ccyLabel = nav[nav.length - 1].currency === "CZK" ? "Kč" : nav[nav.length - 1].currency;
  const xs = nav.map((n) => new Date(n.date).getTime());
  const ys = nav.map((n) => n.value);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const yPad = (yMax - yMin) * 0.08 || yMax * 0.05 || 1;
  const yLo = yMin - yPad, yHi = yMax + yPad;

  const sx = (t) =>
    padL + ((t - xMin) / (xMax - xMin || 1)) * (W - padL - padR);
  const sy = (v) => H - padB - ((v - yLo) / (yHi - yLo || 1)) * (H - padT - padB);

  // Line path
  const path = nav
    .map((n, i) => `${i === 0 ? "M" : "L"}${sx(new Date(n.date).getTime()).toFixed(1)},${sy(n.value).toFixed(1)}`)
    .join(" ");

  // Area under line (subtle gradient fill)
  const areaPath =
    `M${sx(xs[0]).toFixed(1)},${(H - padB).toFixed(1)} ` +
    nav.map((n) => `L${sx(new Date(n.date).getTime()).toFixed(1)},${sy(n.value).toFixed(1)}`).join(" ") +
    ` L${sx(xs[xs.length - 1]).toFixed(1)},${(H - padB).toFixed(1)} Z`;

  // Deposit markers — větší zelené tečky + tenká vertikální vodící čára,
  // ať jsou opravdu vidět (i u depozitů, kde NAV moc nepokleslo).
  const depositMarkers = nav
    .filter((n) => depositsByDate.has(n.date))
    .map((n) => {
      const x = sx(new Date(n.date).getTime());
      const y = sy(n.value);
      const deps = depositsByDate.get(n.date);
      const total = deps.reduce((s, d) => s + d.amount, 0);
      const ccy = deps[0]?.currency || "USD";
      const amount = Math.abs(total).toLocaleString("cs-CZ", { maximumFractionDigits: 0 });
      const tip = total < 0 ? `Výběr ${n.date}: −${amount} ${ccy}` : `Vklad ${n.date}: +${amount} ${ccy}`;
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
      <text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#888">${fmtNum(v / 1000, 0)}K ${ccyLabel}</text>
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
      <td><div class="alloc-bar-wrap"><div class="alloc-bar-fill" data-pct="${r.weightValue != null ? Math.min(100, (r.weightValue / maxWeight) * 100) : 0}"></div></div></td>
      <td class="num">${fmtNum(r.investedUsd, 0)}</td>
      <td class="num"><strong>${fmtPct(r.weightInvested, 2)}</strong></td>
      <td><div class="alloc-bar-wrap"><div class="alloc-bar-fill cost" data-pct="${Math.min(100, (r.weightInvested / maxWeight) * 100)}"></div></div></td>
      <td class="num ${signClass(r.delta)}">${r.delta != null ? fmtPct(r.delta, 2) : '<span class="muted">—</span>'}</td>
    `;
    // Šířka pruhu přes CSSOM — atribut style="…" v HTML by CSP (style-src 'self') zahodil
    tr.querySelectorAll(".alloc-bar-fill[data-pct]").forEach((el) => {
      el.style.width = `${el.dataset.pct}%`;
    });
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
  return fxToCzk(state.fxRates, date, currency, opts);
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
  const closed = closedPositions(state.positions, state.portfolio.instruments, state.fxRates, { estimateLatest: true });
  const totalOpen = Object.values(state.positions).filter(
    (p) => p && p.net_qty > 0,
  ).length;
  renderOverviewMode(totalOpen, closed.length);
  if (state.overviewMode === "closed") {
    renderClosedPositions(closed);
    return;
  }

  const tbody = document.querySelector("#tbl-overview tbody");
  tbody.innerHTML = "";

  // 1) Sesbírat řádky s vypočtenými hodnotami
  const rows = getFilteredOverviewRows();

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
      <td class="num">${r.isDelisted ? '<span class="muted" title="Titul byl stažen z burzy — počítá se s hodnotou 0 do vyřešení restrukturalizace.">delisted</span>' : r.hasPrice ? fmtNum(r.currentPrice, 2) : '<span class="muted">—</span>'}</td>
      <td class="num">${fmtNum(r.pos.cost_basis, 2)}</td>
      <td class="num">${r.hasPrice ? fmtNum(r.marketValue, 2) : '<span class="muted">—</span>'}</td>
      <td class="num ${signClass(r.unrealizedPnl)}" title="Nerealizovaná Z/Z = Hodnota pozice − Nákupní cena pozice (jen otevřené loty).${r.hasRealized ? ' Tento ticker má historické realizované obchody — viz sloupec Celkem Z/Z pro celkový pohled.' : ''}">${r.hasPrice ? fmtNum(r.unrealizedPnl, 2) : '<span class="muted">—</span>'}</td>
      <td class="num clickable ${signClass(r.totalPnl)}" data-action="expand" title="${r.hasDividends && !r.divSameCcy ? 'Pozor: dividendy v jiné měně než pozice — Total Return není sečteno. Vidíte jen kapitálovou Z/Z. Klikněte pro detail.' : 'Celkový (historický) Total Return = realizovaná Z/Z + nerealizovaná Z/Z + čisté dividendy. Klikněte pro detail.'}">${r.hasPrice ? fmtNum(r.totalPnl, 2) + (r.hasDividends && r.divSameCcy ? ' <span class="benchmark-tooltip">＋div</span>' : '') + ' <span class="caret">▾</span>' : '<span class="muted">—</span>'}</td>
      <td class="num ${signClass(r.totalPct)}">${r.hasPrice ? fmtPct(r.totalPct) : '<span class="muted">—</span>'}</td>
      <td>${positionActionsHtml(r.sym, r.inst, r.hasPrice ? r.currentPrice : null)}</td>
    `;
    tbody.appendChild(tr);
  }
}

// Akce v ⋯ menu u titulu (držené i prodané): poznámka vždy; watchlist akce podle
// stavu — titul ještě nesledovaný → přidat, už sledovaný → aktualizovat značku
// (páruje se přes yahoo_symbol, stejný klíč jako dedupe v API).
function positionActionsHtml(sym, inst, price) {
  const hasNote = !!state.notes?.[sym];
  const watchItem = (state.watchlist?.items || []).find(
    (it) => it.yahoo_symbol === inst.yahoo_symbol || it.symbol === sym,
  );
  const watchActionHtml = watchItem
    ? `<li><button type="button" role="menuitem" data-watch-mark="${watchItem.id}" data-current-price="${price ?? ""}" ${price != null ? "" : "disabled"}>Aktualizovat značku</button></li>`
    : `<li><button type="button" role="menuitem" data-pos-watch-add="${sym}">Přidat do watchlistu</button></li>`;
  return `
        <div class="action-menu">
          <button class="btn-action action-menu-toggle" type="button" aria-haspopup="true" aria-expanded="false" title="Zobrazit akce">⋯</button>
          <ul class="action-menu-items" role="menu" hidden>
            <li><button type="button" role="menuitem" data-note-edit-symbol="${sym}">${hasNote ? "Upravit poznámku" : "Přidat poznámku"}</button></li>
            ${watchActionHtml}
          </ul>
        </div>`;
}

// Přepínač Držené / Prodané: počty v tlačítkách, vidět je jen jedna z tabulek
function renderOverviewMode(openCount, closedCount) {
  const closedMode = state.overviewMode === "closed";
  for (const btn of document.querySelectorAll("#overview-mode .filter-chip")) {
    const active = btn.dataset.mode === state.overviewMode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
    btn.textContent = `${btn.dataset.label} (${btn.dataset.mode === "closed" ? closedCount : openCount})`;
  }
  document.getElementById("overview-wrap").hidden = closedMode;
  document.getElementById("closed-wrap").hidden = !closedMode;
  document.getElementById("closed-intro").hidden = !closedMode;
}

function setupOverviewMode() {
  document.getElementById("overview-mode").addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-chip");
    if (!btn || btn.dataset.mode === state.overviewMode) return;
    state.overviewMode = btn.dataset.mode;
    renderOverview();
  });
  document.querySelectorAll("#tbl-closed th.sortable").forEach((th) => {
    th.addEventListener("click", (e) => {
      if (e.target.classList.contains("hint")) return;
      const key = th.dataset.sortKey;
      if (state.closedSort.key === key) {
        state.closedSort.dir = state.closedSort.dir === "asc" ? "desc" : "asc";
      } else {
        state.closedSort.key = key;
        // Čísla a data: první klik = největší / nejnovější první; text abecedně
        const newestFirst = th.classList.contains("num") || key === "firstBuy" || key === "lastSell";
        state.closedSort.dir = newestFirst ? "desc" : "asc";
      }
      renderOverview();
    });
  });
}

const prodanych = (n) => (n === 1 ? "prodaná pozice" : n >= 2 && n <= 4 ? "prodané pozice" : "prodaných pozic");

// Řádky Prodaných po hledání (stejné pole jako u držených) a v pořadí tabulky —
// jeden zdroj pro obrazovku i XLSX export
function sortedClosedRows(all) {
  const q = state.searches.overview;
  const rows = q ? all.filter((r) => `${r.symbol} ${r.name || ""}`.toLowerCase().includes(q)) : [...all];
  const { key, dir } = state.closedSort;
  const sign = dir === "desc" ? -1 : 1;
  return rows.sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    // Bez hodnoty (chybí kurz, žádné dividendy) vždy na konec
    if (va == null || vb == null) {
      if (va == null && vb == null) return a.symbol.localeCompare(b.symbol, "cs");
      return va == null ? 1 : -1;
    }
    const c = typeof va === "string" ? va.localeCompare(vb, "cs") : va - vb;
    return sign * c || a.symbol.localeCompare(b.symbol, "cs");
  });
}

// Poslední den v kurzech ČNB — odhad Kč u čerstvého prodeje počítá s jeho kurzem
function lastFxDate() {
  return Object.keys(state.fxRates?.dates || {}).sort().pop() || null;
}

// Vzorce do title buněk Prodaných: čísla dosazená tak, jak se počítala
function closedFormulas(r) {
  const ccy = r.currency;
  const divSame = !r.hasDividends || r.dividendCurrency === ccy;
  const lastFx = lastFxDate();
  const estimateNote =
    r.estimated && lastFx
      ? `Odhad: kurz ČNB k vypořádání ještě není vyhlášený, použitý je poslední známý k ${fmtCzDate(lastFx)}.`
      : "";
  return {
    estimateNote,
    realized: `Prodej ${fmtNum(r.proceeds, 2)} − nákup ${fmtNum(r.cost, 2)} = ${fmtNum(r.realized, 2)} ${ccy} (${fmtNum(r.qty, 0)} ks, komise v cenách).`,
    dividends: !r.hasDividends
      ? "Za dobu držení nepřišla žádná dividenda."
      : r.dividendCurrency
        ? `Dividendy ${fmtNum(r.dividendsGross, 2)} − sražená daň ${fmtNum(-r.withheld, 2)} = ${fmtNum(r.dividends, 2)} ${r.dividendCurrency}.`
        : "Dividendy ve více měnách – součet je jen v Kč.",
    total: divSame
      ? `Z/Z z prodeje ${fmtNum(r.realized, 2)}${r.hasDividends ? ` + dividendy ${fmtNum(r.dividends, 2)}` : ""} = ${fmtNum(r.total, 2)} ${ccy}. Klikněte pro detail.`
      : `Jen Z/Z z prodeje – dividendy jsou v jiné měně než titul, úplný výsledek ukazuje Celkem v Kč. Klikněte pro detail.`,
    pct: `${fmtNum(r.total, 2)} ÷ nákup ${fmtNum(r.cost, 2)} ${ccy} = ${fmtPct(r.totalPct)}`,
    czk:
      r.totalCzk == null
        ? `Chybí kurz ČNB: ${r.missingFx.join(", ")}.`
        : `Z prodeje ${kcText(r.saleCzk)} + dividendy ${kcText(r.dividendsCzk)} = ${kcText(r.totalCzk)}.${estimateNote ? ` ${estimateNote}` : ""}`,
  };
}

function renderClosedPositions(all) {
  const rows = sortedClosedRows(all);
  const tbody = document.querySelector("#tbl-closed tbody");
  const tfoot = document.getElementById("tfoot-closed");
  tbody.innerHTML = "";
  const { key, dir } = state.closedSort;
  document.querySelectorAll("#tbl-closed th.sortable").forEach((th) => {
    const isSorted = th.dataset.sortKey === key;
    th.classList.toggle("sorted", isSorted);
    th.classList.toggle("desc", isSorted && dir === "desc");
  });
  document.getElementById("overview-count").textContent =
    rows.length === all.length ? `${all.length} ${prodanych(all.length)}` : `${rows.length} z ${all.length} ${prodanych(all.length)}`;

  const cols = document.querySelectorAll("#tbl-closed thead th").length;
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${cols}" class="muted">${all.length ? "Hledání neodpovídá žádná prodaná pozice." : "V tomto portfoliu zatím není žádná celá prodaná pozice."}</td></tr>`;
    tfoot.innerHTML = "";
    return;
  }

  for (const r of rows) {
    const inst = state.portfolio.instruments[r.symbol] || {};
    const q = state.quotes[inst.yahoo_symbol] || {};
    const f = closedFormulas(r);
    const divHtml = !r.hasDividends
      ? '<span class="muted">–</span>'
      : r.dividendCurrency
        ? `${fmtNum(r.dividends, 2)}${r.dividendCurrency !== r.currency ? ` <span class="muted">${escapeHtml(r.dividendCurrency)}</span>` : ""}`
        : '<span class="muted">více měn</span>';
    const tr = document.createElement("tr");
    tr.className = "position";
    tr.dataset.sym = r.symbol;
    tr.innerHTML = `
      <td class="symbol">${escapeHtml(r.symbol)}${noteIconHtml(r.symbol)}</td>
      <td><span class="cell-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span></td>
      <td>${escapeHtml(r.currency)}</td>
      <td>${fmtCzDate(r.firstBuy)}</td>
      <td>${fmtCzDate(r.lastSell)}</td>
      <td class="num">${fmtNum(r.qty, Number.isInteger(r.qty) ? 0 : 4)}</td>
      <td class="num">${fmtNum(r.avgBuy, 4)}</td>
      <td class="num">${fmtNum(r.avgSell, 4)}</td>
      <td class="num ${signClass(r.realized)}" title="${escapeHtml(f.realized)}">${fmtNum(r.realized, 2)}</td>
      <td class="num ${signClass(r.dividends)}" title="${escapeHtml(f.dividends)}">${divHtml}</td>
      <td class="num clickable ${signClass(r.total)}" data-action="expand" title="${escapeHtml(f.total)}">${fmtNum(r.total, 2)} <span class="caret">▾</span></td>
      <td class="num ${signClass(r.totalPct)}" title="${escapeHtml(f.pct)}">${fmtPct(r.totalPct)}</td>
      <td class="num ${signClass(r.totalCzk)}" title="${escapeHtml(f.czk)}">${r.totalCzk != null ? `${r.estimated ? "≈ " : ""}${fmtNum(r.totalCzk, 0)}` : '<span class="muted">chybí kurz</span>'}</td>
      <td>${positionActionsHtml(r.symbol, inst, q.price != null && !q.error ? q.price : null)}</td>
    `;
    tbody.appendChild(tr);
  }

  // Napříč měnami jde sečíst jen Kč; pozice bez kurzu ČNB stranou
  const withCzk = rows.filter((r) => r.totalCzk != null);
  const sum = (field) => withCzk.reduce((s, r) => s + r[field], 0);
  const missing = rows.length - withCzk.length;
  const sumTitle = `Z prodeje ${kcText(sum("saleCzk"))} + dividendy ${kcText(sum("dividendsCzk"))} = ${kcText(sum("totalCzk"))}`;
  tfoot.innerHTML = `
    <tr>
      <td colspan="${cols - 2}">Celkem ${rows.length} ${pozic(rows.length)}${missing ? ` <span class="muted">· bez kurzu ČNB mimo součet ${missing}</span>` : ""}</td>
      <td class="num ${signClass(sum("totalCzk"))}" title="${escapeHtml(sumTitle)}"><strong>${withCzk.some((r) => r.estimated) ? "≈ " : ""}${fmtNum(sum("totalCzk"), 0)}</strong></td>
      <td></td>
    </tr>
  `;
}

function setupExpand() {
  for (const id of ["tbl-overview", "tbl-closed"]) {
    document.querySelector(`#${id} tbody`).addEventListener("click", (e) => {
      const cell = e.target.closest('[data-action="expand"]');
      if (!cell) return;
      const tr = cell.closest("tr.position");
      if (!tr) return;
      toggleDetail(tr.dataset.sym, tr);
    });
  }
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
  // Vytvořit nový detail přes celou šířku tabulky (Držené a Prodané mají jiný počet sloupců)
  const colSpan = tr.closest("table").querySelectorAll("thead th").length;
  const detail = buildDetailRow(sym, colSpan);
  tr.after(detail);
  tr.classList.add("expanded");
}

function corpActionLabel(sp) {
  if (sp.kind === "bonus") return "bonusové akcie";
  if (sp.kind === "cancellation") return "zánik kusů";
  if (sp.kind === "rights") return "práva – bez vlivu";
  const direction = sp.ratio_to > sp.ratio_from ? "forward split" : "reverse split";
  return `${sp.ratio_to}:${sp.ratio_from} ${direction}`;
}

function buildDetailRow(sym, colSpan) {
  const inst = state.portfolio.instruments[sym];
  const pos = state.positions[sym];
  const q = state.quotes[inst.yahoo_symbol] || {};
  const currentPrice = q.price;
  const hasPrice = currentPrice != null && !q.error;
  const u = unrealizedPnl(pos, currentPrice);
  const ccy = inst.currency;
  const isClosed = !(pos.net_qty > 0);

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
    `<h3>${sym} — ${escapeHtml(inst.name)} <span class="muted">· ${inst.exchange} · ${ccy}</span>${inst.delisted ? ` <span class="badge sell" title="Staženo z burzy ${inst.delisted}. Pozice se drží do formálního zániku akcií — daňová ztráta se realizuje až odpisem.">DELISTED ${inst.delisted}</span>` : ""}</h3>`,
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

  // Corporate actions: splity, bonusové akcie, zánik kusů, práva
  if (pos.splits && pos.splits.length > 0) {
    html.push(`<div class="detail-section">`);
    html.push(`<h4>Splity / Corporate actions</h4>`);
    html.push(`<table class="mini"><tbody>`);
    for (const sp of pos.splits) {
      html.push(
        `<tr>
          <td>${sp.date}</td>
          <td><strong>${corpActionLabel(sp)}</strong></td>
          <td class="muted">${escapeHtml(sp.note || "")}</td>
        </tr>`,
      );
    }
    html.push(`</tbody></table>`);
    if (pos.splits.some((sp) => sp.kind === "split")) {
      html.push(
        `<div class="mini-total muted">Split mění počet kusů a cenu za 1 ks, ale celková nákupní hodnota zůstává stejná.</div>`,
      );
    }
    if (pos.splits.some((sp) => sp.kind === "rights")) {
      html.push(
        `<div class="mini-total muted">Práva mají vlastní ISIN a přišla i odešla ve stejném počtu – kusy ani nákupní cenu akcie nemění.</div>`,
      );
    }
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

  // Otevřené pozice — prodaný titul žádné nemá
  if (!isClosed) {
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
  }

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
    // Součet je v měně dividend — u NOV.DE (EUR titul) jsou v DKK
    const divCcys = [...new Set(merged.map((m) => m.currency))];
    const netCcy = divCcys.length === 1 ? divCcys[0] : ccy;
    let netLine = `<strong class="${signClass(netLocal)}">Čistý dividendový výnos: ${fmtNum(netLocal, 2)} ${netCcy}</strong>`;
    if (netCcy !== "USD" && netUsd) {
      netLine += ` <span class="muted">(${fmtNum(netUsd, 2)} USD)</span>`;
    }
    html.push(`<div class="mini-total">${netLine}</div>`);
    html.push(`</div>`);
  }

  // Sumář — kapitálová Z/Z + dividendy = Total Return (stejný výpočet jako
  // sloupec Celkem Z/Z v přehledu i MCP konektor); prodaný titul cenu nepotřebuje
  if (isClosed) {
    html.push(closedSummaryHtml(sym));
  } else if (hasPrice) {
    const tr = positionTotalReturn(pos, ccy, currentPrice);
    const { capitalPnl, capitalPct } = tr;
    // Dividendy v jiné měně než pozice (NOV: EUR pozice, DKK dividendy)
    // se nesčítají — čísla se ukážou separátně.
    const sameCcy = tr.divSameCcy;
    const divCcys = new Set(tr.dividendCurrencies);

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
      const totalReturn = tr.totalPnl;
      const totalReturnPct = tr.totalPct;
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
        `<div class="tr-total-line">= <strong>TOTAL RETURN</strong>: <span class="${signClass(totalReturn)}"><strong>${fmtNum(totalReturn, 2)} ${ccy}</strong> (${fmtPct(totalReturnPct)})</span>${czkSuffix}</div>`,
      );
    } else if (hasDividends) {
      const divCcy = [...divCcys][0];
      html.push(
        `<div>+ Čistý dividendový výnos: <span class="${signClass(pos.net_dividend_local)}"><strong>${fmtNum(pos.net_dividend_local, 2)} ${divCcy}</strong></span> <span class="muted">(${fmtNum(pos.net_dividend_usd, 2)} USD ekv.)</span></div>`,
      );
      html.push(
        `<div class="muted small tr-note">Total Return nelze přímo sečíst — kapitál v ${ccy}, dividendy v ${divCcy}. Pro celkový výnos je třeba FX přepočet.</div>`,
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
  td.colSpan = colSpan;
  td.innerHTML = html.join("");
  tr.appendChild(td);
  return tr;
}

// Souhrn prodaného titulu v detailu: v měně z FIFO, v Kč kurzy ČNB k datům
// vypořádání a výplat (stejná čísla jako řádek tabulky Prodané) — ne dnešním
// kurzem jako u držených pozic
function closedSummaryHtml(sym) {
  const r = closedPositions(state.positions, state.portfolio.instruments, state.fxRates, { estimateLatest: true })
    .find((row) => row.symbol === sym);
  if (!r) return "";
  const ccy = r.currency;
  const f = closedFormulas(r);
  const lines = [
    `<div>Z/Z z prodeje: <span class="${signClass(r.realized)}"><strong>${fmtNum(r.realized, 2)} ${ccy}</strong></span> <span class="muted">= prodej ${fmtNum(r.proceeds, 2)} − nákup ${fmtNum(r.cost, 2)}</span></div>`,
  ];
  if (r.hasDividends) {
    lines.push(
      `<div>+ Čisté dividendy: <span class="${signClass(r.dividends)}"><strong>${r.dividendCurrency ? `${fmtNum(r.dividends, 2)} ${r.dividendCurrency}` : "více měn"}</strong></span></div>`,
    );
  }
  if (!r.hasDividends || r.dividendCurrency === ccy) {
    lines.push(
      `<div class="tr-total-line">= <strong>CELKEM</strong>: <span class="${signClass(r.total)}"><strong>${fmtNum(r.total, 2)} ${ccy}</strong> (${fmtPct(r.totalPct)})</span></div>`,
    );
  } else {
    lines.push(`<div class="muted small tr-note">Dividendy jsou v jiné měně než titul – v měně se nesčítají, úplný výsledek je v Kč.</div>`);
  }
  lines.push(
    r.totalCzk != null
      ? `<div>V Kč: z prodeje ${kcSigned(r.saleCzk)} + dividendy ${kcSigned(r.dividendsCzk)} = <strong>${r.estimated ? "≈ " : ""}${kcSigned(r.totalCzk)}</strong></div>`
      : `<div class="muted">V Kč: ${escapeHtml(f.czk)}</div>`,
  );
  const note = f.estimateNote || "Prodeje kurzem ČNB k datu vypořádání (jako Report pro účetní), dividendy k datu výplaty.";
  return `<div class="detail-section summary"><div>${lines.join("")}<div class="muted small tr-note">${escapeHtml(note)}</div></div><span class="muted">vůči nákupu ${fmtNum(r.cost, 2)} ${ccy}</span></div>`;
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
  // Bez načtených kurzů se nesčítá nic (ani CZK) — dlaždice by jinak
  // ukázala jen korunovou část hotovosti, jako by byla celá.
  const cashBalance = p.cash_balance || {};
  const cash = todayFxDateEarly
    ? cashToCzk(cashBalance, state.fxRates, todayFxDateEarly)
    : { czk: 0, items: [] };
  const cashCzkTotal = cash.czk;
  const cashBreakdown = cash.items.map((it) => `${fmtNum(it.amount, 2)} ${it.currency}`);
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

  // Celkový výnos + P.a. — sdílený výpočet (portfolio-shared.js), stejný
  // jako v MCP konektoru
  const inception = p.inception_date || "2025-11-24";
  const today = new Date();
  const ret = portfolioTotalReturn({
    assetsUsd: totalAssetsUsd,
    flows: capitalFlowsUsd(p, state.fxRates),
    inceptionDate: inception,
    asOf: today,
    usdToCzk: fxUsdToCzk,
  });
  const totalReturnUsd = ret.usd;
  const totalReturnPct = ret.pct;
  const daysSince = ret.days;
  const yearsSince = ret.years;
  const paPct = ret.paPct;

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
  const totalReturnCzk = ret.czk;
  const absLine =
    totalReturnCzk != null
      ? `${fmtNum(totalReturnCzk, 0)} Kč (${fmtNum(totalReturnUsd, 0)} USD)`
      : `${fmtNum(totalReturnUsd, 0)} USD`;
  const capitalLine = ret.vybrano > 0
    ? `vloženo ${fmtNum(ret.vlozeno, 0)} · vybráno ${fmtNum(ret.vybrano, 0)} USD`
    : `vloženo ${fmtNum(ret.vlozeno, 0)} USD`;
  const returnCard = cardHtml(
    `Celkový výnos`,
    `<span class="${signClass(totalReturnPct)}">${fmtPct(totalReturnPct)}</span>`,
    `${absLine}<br>${capitalLine}<br>od založení ${inception} (${Math.round(daysSince)} dní)`,
  );
  returnCard.title =
    `Zisk = hodnota + vybráno − vloženo = ${fmtNum(totalAssetsUsd, 0)} + ${fmtNum(ret.vybrano, 0)} − ` +
    `${fmtNum(ret.vlozeno, 0)} = ${fmtNum(totalReturnUsd, 0)} USD\n` +
    `Výnos = zisk / vloženo = ${fmtPct(totalReturnPct)}\n` +
    `Vloženo = počáteční kapitál + vklady; výběry základ nezmenšují.`;
  wrap.appendChild(returnCard);

  // === 4) P.a. — XIRR, počítá s tím, kdy peníze přišly a odešly ===
  const paCard = cardHtml(
    `P.a. (anualizováno)`,
    `<span class="${signClass(paPct)}">${fmtPct(paPct)}</span>`,
    `roční výnos vážený penězi (XIRR)<br>${fmtNum(yearsSince, 2)} let od založení`,
  );
  paCard.title =
    "XIRR: roční sazba, při které se vyrovnají všechny vklady a výběry (k jejich datu) " +
    "s dnešní hodnotou portfolia. Na rozdíl od prosté anualizace nepřeceňuje peníze, " +
    "které přišly později nebo odešly.";
  wrap.appendChild(paCard);

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
  // Roky chipy — jen roky, kdy došlo k SELL.
  // Účetně rozhoduje datum VYPOŘADÁNÍ (settle), ne datum obchodu —
  // prodej 30.12. s vypořádáním 2.1. patří do nového roku.
  const years = new Set();
  for (const sym in state.positions) {
    for (const cl of state.positions[sym].closed_lots || []) {
      const sd = cl.sell_settle_date || cl.sell_date;
      if (!cl.orphan && sd) years.add(sd.slice(0, 4));
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

  // Prodeje v období s přepočtem na Kč (sdílený výpočet — stejný v exportu
  // i v Daňové optimalizaci). Účetně rozhoduje datum VYPOŘADÁNÍ.
  const { from, to } = state.reportFilter;
  const events = realizedSales(state.positions, state.portfolio.instruments, state.fxRates, { from, to });

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

  // Seskupit prodeje per symbol — každá akcie JEDNA karta, prodeje uvnitř
  // chronologicky (každý se svými FIFO nákupy): nákupy → prodej → další
  // nákupy → prodej. Karty řazené abecedně, mezisoučet za symbol dole.
  const bySymbol = new Map();
  for (const ev of events) {
    if (!bySymbol.has(ev.symbol)) bySymbol.set(ev.symbol, []);
    bySymbol.get(ev.symbol).push(ev); // events už jsou chronologicky
  }

  for (const symKey of [...bySymbol.keys()].sort((a, b) => a.localeCompare(b, "cs"))) {
  const symEvents = bySymbol.get(symKey);
  const first = symEvents[0];
  const singleSale = symEvents.length === 1;
  let symbolProfitCzk = 0;
  let symbolAllFx = true;
  const saleInfo = (ev) =>
    `Prodej vypořádán ${ev.sell_date}${ev.sell_trade_date && ev.sell_trade_date !== ev.sell_date ? ` (obchod ${ev.sell_trade_date})` : ""} · ${fmtNum(ev.sell_qty, 0)} ks @ ${fmtNum(ev.sell_price, 4)}`;
  let html = `
    <div class="report-event-header">
      <span><strong>${first.symbol}</strong> — ${escapeHtml(first.name)} <span class="muted">· ${first.currency}</span></span>
      <span class="muted">${singleSale ? saleInfo(first) : `${symEvents.length} prodej${symEvents.length < 5 ? "e" : "ů"} chronologicky`}</span>
    </div>
  `;

  for (const ev of symEvents) {
    // Kurzy strict — chybějící den = „chybí kurz" a prodej mimo součty
    const { buys, costCzk, sellFx, sellCzk, profitCzk, allFxFound } = ev;

    if (!allFxFound) {
      anyMissingFx = true;
      symbolAllFx = false;
    }
    if (allFxFound) {
      grandCostCzk += costCzk;
      grandSellCzk += sellCzk;
      grandProfitCzk += profitCzk;
      symbolProfitCzk += profitCzk;
    }

    // U více prodejů dostane každý blok popisek (u jediného je info v hlavičce)
    if (!singleSale) {
      html += `<div class="report-sale-caption">${saleInfo(ev)}</div>`;
    }
    html += `
      <table>
        <thead>
          <tr>
            <th>Datum vypořádání</th>
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
          <td class="report-buy">nákup${b.trade_date && b.trade_date !== b.date ? ` <span class="muted">(obchod ${b.trade_date})</span>` : ""}</td>
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
        <td class="report-sell">prodej${ev.sell_trade_date && ev.sell_trade_date !== ev.sell_date ? ` <span class="muted">(obchod ${ev.sell_trade_date})</span>` : ""}</td>
      </tr>
      <tr class="totals">
        <td colspan="4" class="label">${profitCzk == null ? "Zisk/ztráta" : profitCzk >= 0 ? "Zisk" : "Ztráta"} v Kč:</td>
        <td class="num ${signClass(profitCzk)}"><strong>${profitCzk != null ? fmtNum(profitCzk, 2) : '<span class="missing-fx">—</span>'}</strong></td>
        <td></td>
      </tr>
      </tbody>
      </table>
    `;
  }

  if (!singleSale) {
    html += `
      <div class="report-symbol-total">Za ${first.symbol} celkem (${symEvents.length} prodej${symEvents.length < 5 ? "e" : "ů"}):
        <strong class="${symbolAllFx ? signClass(symbolProfitCzk) : ""}">${symbolAllFx ? `${fmtNum(symbolProfitCzk, 2)} Kč` : "— (chybí kurz)"}</strong>
      </div>`;
  }
  const card = document.createElement("div");
  card.className = "report-event";
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
    sumHtml += `<div class="muted summary-note">⚠️ Některé kurzy ČNB chybí — prodeje s neúplnými kurzy NEJSOU v souhrnu započtené. Doplňte chybějící dny do data/fx_rates.json.</div>`;
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
    if (state.overviewMode === "closed") return exportClosedPositionsXlsx();
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
  } else if (view === "positions-at") {
    return exportPositionsAtXlsx();
  } else if (view === "tax") {
    return exportTaxOptXlsx();
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

// Řádky přehledu po search filtru — jeden zdroj pro tabulku i XLSX export,
// aby export ukazoval stejná čísla jako obrazovka. Total Return počítá
// sdílený positionTotalReturn (fifo.js), stejně jako MCP konektor.
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
    const tr = positionTotalReturn(pos, inst.currency, currentPrice);
    rows.push({
      sym,
      inst,
      pos,
      currentPrice,
      hasPrice: currentPrice != null && !quote.error,
      marketValue: tr.marketValue,
      unrealizedPnl: tr.unrealizedPnl, // jen otevřené loty — bez realizovaných a dividend
      capitalPnl: tr.capitalPnl,
      totalPnl: tr.totalPnl,
      totalPct: tr.totalPct,
      divSameCcy: tr.divSameCcy,
      hasDividends: tr.hasDividends,
      hasRealized: (pos.realized_pnl || 0) !== 0, // pro tooltip / vizuál
      isDelisted: !!quote.delisted,
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

// Export Prodaných: řádky, pořadí a sloupce jako na obrazovce. Čísla zůstávají
// čísly — jinou měnu dividend a odhad Kč (≈) nese formát buňky; data jako datum
// Excelu, Celkem v Kč jako vzorec součtu.
function exportClosedPositionsXlsx() {
  const all = closedPositions(state.positions, state.portfolio.instruments, state.fxRates, { estimateLatest: true });
  const rows = sortedClosedRows(all);
  const header = [
    "Symbol", "Název", "Měna", "Nakoupeno", "Prodáno", "Kusů", "Ø nákup/ks", "Ø prodej/ks",
    "Z/Z z prodeje", "Dividendy čistě", "Celkem Z/Z", "%", "Celkem v Kč",
  ];
  const dateOf = (iso) => new Date(`${iso}T00:00:00`);
  const aoa = [header];
  for (const r of rows) {
    aoa.push([
      r.symbol, r.name || "", r.currency, dateOf(r.firstBuy), dateOf(r.lastSell), r.qty, r.avgBuy, r.avgSell,
      r.realized, r.dividendCurrency ? r.dividends : "", r.total, r.totalPct / 100, r.totalCzk ?? "",
    ]);
  }
  const lastData = aoa.length; // 1-based řádek poslední pozice
  aoa.push([
    `Celkem ${rows.length} ${pozic(rows.length)}`, "", "", "", "", "", "", "", "", "", "", "",
    // v = předpočtená hodnota pro prohlížeče, které vzorce nepřepočítají
    { t: "n", f: `SUM(M2:M${lastData})`, v: rows.reduce((sum, r) => sum + (r.totalCzk ?? 0), 0) },
  ]);

  // Tečky ve formátu data musí být escapované, jinak SSF hodí „bad second format"
  const ws = XLSX.utils.aoa_to_sheet(aoa, { dateNF: "d\\. m\\. yyyy" });
  const lastCol = header.length - 1;
  const totalRow = aoa.length - 1;
  // Buňky předané jako objekt (vzorce) aoa_to_sheet nemusí započítat do rozsahu
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: totalRow, c: lastCol } });
  const numFmt = { 6: "#,##0.0000", 7: "#,##0.0000", 8: "#,##0.00", 9: "#,##0.00", 10: "#,##0.00", 11: "0.00%", 12: "#,##0" };
  for (let rr = 0; rr <= totalRow; rr++) {
    const row = rr > 0 ? rows[rr - 1] : null;
    for (let c = 0; c <= lastCol; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: rr, c })];
      if (!cell) continue;
      if (rr === 0 || rr === totalRow) cell.s = { font: { bold: true } };
      if (rr === 0 || cell.t !== "n") continue;
      // „#,##0.####“ by celé kusy ukázal s tečkou na konci („15.“)
      if (c === 5) cell.z = Number.isInteger(cell.v) ? "#,##0" : "#,##0.####";
      else if (numFmt[c]) cell.z = numFmt[c];
      if (c === 9 && row?.dividendCurrency && row.dividendCurrency !== row.currency) cell.z = `#,##0.00 "${row.dividendCurrency}"`;
      // Dvě sekce formátu, jinak by záporný odhad vyšel „-≈ 53 597“
      if (c === 12 && row?.estimated) cell.z = `"≈ "#,##0;"≈ "-#,##0`;
    }
  }
  ws["!autofilter"] = { ref: `A1:${XLSX.utils.encode_col(lastCol)}${lastData}` };
  ws["!cols"] = [
    { wch: 9 }, { wch: 30 }, { wch: 6 }, { wch: 11 }, { wch: 11 }, { wch: 8 }, { wch: 12 }, { wch: 12 },
    { wch: 13 }, { wch: 14 }, { wch: 13 }, { wch: 8 }, { wch: 13 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Prodané pozice");
  XLSX.writeFile(wb, `${state.portfolio.id}-prodane-pozice-k-${pragueToday()}.xlsx`);
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
 *
 * Účetně rozhoduje datum VYPOŘADÁNÍ (settle_date) — určuje rok
 * i kurz ČNB. Filtr období se proto aplikuje na datum vypořádání,
 * ne na datum obchodu (prodej 30.12. vypořádaný 2.1. patří do
 * nového roku). Fallback na datum obchodu, když settle chybí.
 */
function buildTransactionsAccountingAoa() {
  const { from, to } = state.txFilter;
  const search = state.searches.transactions;
  const txs = state.portfolio.transactions
    .filter((t) => {
      const sd = t.settle_date || t.date;
      if (from && sd < from) return false;
      if (to && sd > to) return false;
      if (search) {
        const inst = state.portfolio.instruments[t.symbol];
        const h = `${t.symbol} ${inst?.name || ""}`.toLowerCase();
        if (!h.includes(search)) return false;
      }
      return true;
    })
    .sort((a, b) =>
      `${b.settle_date || b.date} ${b.time || ""}`.localeCompare(
        `${a.settle_date || a.date} ${a.time || ""}`,
      ),
    );

  const header = [
    "Datum vypořádání", "Datum obchodu", "Čas", "Symbol", "Název", "Burza", "Měna",
    "Typ", "Množství",
    "Cena (orig.)", "Hodnota (orig.)", "Komise (orig.)",
    "Kurz ČNB", "Nákup celkem CZK",
  ];
  const data = txs.map((t) => {
    const inst = state.portfolio.instruments[t.symbol] || {};
    const ccy = inst.currency || t.currency;
    const settle = t.settle_date || t.date;
    // Strict mode — pokud kurz pro datum chybí, vrátí null
    const fxToCzk = getFxToCzk(settle, ccy);
    const qty = Math.abs(t.quantity);

    const totalCzk = fxToCzk != null
      ? (t.proceeds + t.commission) * fxToCzk
      : "chybí kurz ČNB";

    return [
      settle, t.date, t.time, t.symbol, inst.name, inst.exchange, ccy,
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
  const events = realizedSales(state.positions, state.portfolio.instruments, state.fxRates, { from, to });

  const aoa = [
    [
      "Symbol", "Název", "Měna", "Typ", "Datum vypořádání", "Datum obchodu", "Kusů",
      "Cena celkem (orig.)", "Kurz ČNB", "Kurz ze dne", "Cena celkem v Kč",
    ],
  ];
  // Paralelně s aoa evidujeme druh řádku kvůli stylům (barvy nákup/prodej)
  const rowKinds = ["header"];
  let grandCost = 0, grandSell = 0;
  let anyMissingFx = false;
  // Stejné seskupení jako na obrazovce: bloky per symbol (abecedně),
  // uvnitř prodeje chronologicky, mezisoučet za symbol
  const bySymbol = new Map();
  for (const ev of events) {
    if (!bySymbol.has(ev.symbol)) bySymbol.set(ev.symbol, []);
    bySymbol.get(ev.symbol).push(ev);
  }
  for (const symKey of [...bySymbol.keys()].sort((a, b) => a.localeCompare(b, "cs"))) {
  const symEvents = bySymbol.get(symKey);
  const first = symEvents[0];
  let symbolProfit = 0;
  let symbolAllFx = true;
  for (const ev of symEvents) {
    const { costCzk, sellFx, sellCzk, allFxFound } = ev;
    for (const b of ev.buys) {
      aoa.push([
        ev.symbol, ev.name, ev.currency, "Nákup",
        b.date, b.trade_date, b.qty, b.total,
        b.fx ?? "chybí kurz", b.fx != null ? b.fxValidFor ?? "" : "", b.czk ?? "",
      ]);
      rowKinds.push("buy");
    }
    aoa.push([
      ev.symbol, ev.name, ev.currency, "Prodej",
      ev.sell_date, ev.sell_trade_date, ev.sell_qty, ev.sell_net_total,
      sellFx ?? "chybí kurz", sellFx != null ? ev.sellFxValidFor ?? "" : "", sellCzk ?? "",
    ]);
    rowKinds.push("sell");
    // Zisk jen při kompletních kurzech — jinak by chybějící strana dělala
    // ze ztráty zisk (stejná ochrana jako na obrazovce Reportu)
    aoa.push([
      ev.symbol, ev.name, ev.currency, "── Sumář",
      "", "", "", "",
      allFxFound
        ? `Nákup: ${fmtNum(costCzk, 2)} CZK · Zisk: ${fmtNum(sellCzk - costCzk, 2)} CZK`
        : "⚠️ chybí kurz — nezapočteno do součtů",
      "",
      allFxFound ? sellCzk - costCzk : "",
    ]);
    rowKinds.push("sum");
    if (allFxFound) {
      grandCost += costCzk;
      grandSell += sellCzk;
      symbolProfit += sellCzk - costCzk;
    } else {
      anyMissingFx = true;
      symbolAllFx = false;
    }
  }
  if (symEvents.length > 1) {
    aoa.push([
      first.symbol, first.name, first.currency,
      `══ Za symbol celkem (${symEvents.length} prodeje/ů)`,
      "", "", "", "", "", "",
      symbolAllFx ? symbolProfit : "chybí kurz",
    ]);
    rowKinds.push("sum");
  }
  aoa.push([]); // prázdný řádek mezi symboly
  rowKinds.push(null);
  }
  if (events.length > 0) {
    aoa.push([]);
    rowKinds.push(null);
    aoa.push(["GRAND TOTAL", "", "", "", "", "", "", "", "", "Nákup CZK", grandCost]);
    rowKinds.push("sum");
    aoa.push(["", "", "", "", "", "", "", "", "", "Prodej CZK", grandSell]);
    rowKinds.push("sum");
    aoa.push(["", "", "", "", "", "", "", "", "", "Zisk/Ztráta CZK", grandSell - grandCost]);
    rowKinds.push("sum");
    if (anyMissingFx) {
      aoa.push(["⚠️ Některé kurzy ČNB chybí — prodeje s neúplnými kurzy nejsou v součtech. Doplňte dny do data/fx_rates.json."]);
      rowKinds.push("sum");
    }
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Obarvení řádků (xlsx-js-style): nákup zeleně, prodej červeně — klasická
  // Excel paleta Good/Bad, na kterou je účetní zvyklá; hlavička a sumáře bold.
  const ROW_STYLES = {
    header: { font: { bold: true } },
    buy: { fill: { patternType: "solid", fgColor: { rgb: "C6EFCE" } }, font: { color: { rgb: "006100" } } },
    sell: { fill: { patternType: "solid", fgColor: { rgb: "FFC7CE" } }, font: { color: { rgb: "9C0006" } } },
    sum: { font: { bold: true } },
  };
  aoa.forEach((row, r) => {
    const style = ROW_STYLES[rowKinds[r]];
    if (!style) return;
    row.forEach((_, c) => {
      const ref = XLSX.utils.encode_cell({ r, c });
      if (ws[ref]) ws[ref].s = style;
    });
  });
  ws["!cols"] = [
    { wch: 8 }, { wch: 28 }, { wch: 6 }, { wch: 10 }, { wch: 14 }, { wch: 13 },
    { wch: 7 }, { wch: 16 }, { wch: 10 }, { wch: 12 }, { wch: 16 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, "Report");
  const fname = `${state.portfolio.id}-report-${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fname);
}

// ---------- Pozice k datu (inventurní výpis přes všechna portfolia firmy) ----------
// Přesné znění nadpisu podle požadavku účetní/auditora — {COMPANY} = firma
// z Nastavení (výchozí „PLEGI invest s.r.o.“ dává doslovné znění), {DATE} = rozvahový den.
const PA_TITLE_TEMPLATE =
  "Přesná identifikace jednotlivých pozic cenných papírů a kryptoaktiv držených společnostmi {COMPANY} ke dni {DATE}, tedy název, ISIN nebo ticker, počet kusů a ocenění";

function positionsAtTitle(date) {
  const company = companiesOf(state.owners).find((c) => c.id === state.positionsAt.companyId);
  return PA_TITLE_TEMPLATE.replace("{COMPANY}", company?.name || "").replace("{DATE}", fmtCzDate(date));
}

function fmtCzDate(iso) {
  const [y, m, d] = String(iso).split("-");
  return `${Number(d)}. ${Number(m)}. ${y}`;
}

function setupPositionsAt() {
  const input = document.getElementById("pa-date");
  if (!input) return;
  // Default: 31. 12. předchozího roku — typický rozvahový den
  input.value = `${new Date().getFullYear() - 1}-12-31`;
  document.getElementById("pa-build")?.addEventListener("click", () => buildPositionsAt());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") buildPositionsAt();
  });
}

// Načte VŠECHNA portfolia z manifestu (statický JSON + KV overlay) nezávisle na
// aktivním portfoliu; přehledy za firmu si z nich vyberou svá (companyPortfolios).
// Cache per session, data nezávisí na zvoleném datu.
async function loadAllPortfoliosForSnapshot() {
  if (state.positionsAt.portfolios) return state.positionsAt.portfolios;
  const list = [];
  for (const meta of state.manifest.portfolios) {
    const [res, overlayRes, histRes] = await Promise.all([
      fetch(`${PORTFOLIO_BASE}${meta.file}`, { cache: "no-cache" }),
      fetch(`/api/portfolio-overlay/${meta.id}`, { cache: "no-cache" }).catch(() => null),
      // NAV backfill drží denní hotovost i pro dny před spuštěním Flex cronu —
      // overlay sahá jen do startu cronu, bez backfillu by starší data chyběla.
      fetch(`${PORTFOLIO_BASE.replace("portfolios/", "")}portfolio-history-${meta.id}.json`, {
        cache: "no-cache",
      }).catch(() => null),
    ]);
    if (!res.ok) continue; // portfolio nemusí existovat
    const portfolio = await res.json();
    if (overlayRes && overlayRes.ok) {
      try {
        mergeOverlayIntoPortfolio(portfolio, await overlayRes.json(), state.fxRates);
      } catch (e) {
        console.warn(`Overlay ${meta.id} se nepodařilo mergnout: ${e.message}`);
      }
    }
    if (histRes && histRes.ok) {
      try {
        portfolio.static_nav_history = (await histRes.json()).nav_history || [];
      } catch (e) {
        console.warn(`NAV historie ${meta.id} se nepodařilo načíst: ${e.message}`);
      }
    }
    list.push({ meta, portfolio });
  }
  state.positionsAt.portfolios = list;
  return list;
}

function fmtSplitFactor(f) {
  return Number.isInteger(f) ? String(f) : fmtNum(f, 4);
}

async function buildPositionsAt() {
  const date = document.getElementById("pa-date").value;
  const statusEl = document.getElementById("pa-status");
  const showStatus = (msg, isError = false) => {
    statusEl.hidden = false;
    statusEl.classList.toggle("error", isError);
    statusEl.textContent = msg;
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    showStatus("Zadej datum, ke kterému se má inventura sestavit.", true);
    return;
  }
  if (state.positionsAt.loading) return;
  state.positionsAt.loading = true;
  document.getElementById("pa-wrap").hidden = true;
  document.getElementById("pa-cash-wrap").hidden = true;
  document.getElementById("pa-summary").hidden = true;
  document.getElementById("pa-title").hidden = true;
  showStatus(`Sestavuji pozice k ${fmtCzDate(date)} — načítám portfolia firmy, historické ceny a kurz ČNB…`);
  const companyId = state.companyId;

  try {
    const portfolios = companyPortfolios(await loadAllPortfoliosForSnapshot());
    if (!portfolios.length) throw new Error("zvolená firma nemá v Nastavení žádné portfolio");

    // 1) Pozice ke dni per portfolio — FIFO nad obchody vypořádanými do data
    const rows = [];
    for (const { meta, portfolio } of portfolios) {
      const positions = computePositionsAt(
        portfolio.transactions || [],
        portfolio.corporate_actions || [],
        date,
      );
      for (const sym of Object.keys(positions).sort((a, b) => a.localeCompare(b, "cs"))) {
        const pos = positions[sym];
        if (!(pos.net_qty > 1e-9)) continue;
        const inst = portfolio.instruments?.[sym] || {};
        rows.push({
          broker: `${meta.broker || meta.name}${portfolio.account ? ` · ${portfolio.account}` : ""}`,
          sym,
          name: inst.name || sym,
          isin: inst.isin || "",
          currency: inst.currency || "",
          yahoo: inst.yahoo_symbol || sym,
          // delisted platí jen pokud stažení z burzy předchází zvolenému datu
          delistedAt: inst.delisted && inst.delisted <= date ? inst.delisted : null,
          qty: pos.net_qty,
          lots: pos.open_lots,
          costLocal: pos.cost_basis,
          // Yahoo historické ceny jsou split-adjusted → korekce o splity PO datu
          splitFactor: splitFactorAfter(portfolio.corporate_actions || [], sym, date),
        });
      }
    }

    // 2) Závěrečné ceny k datu + kurzy ČNB k datu (obojí ze serveru)
    const symbols = [...new Set(rows.filter((r) => !r.delistedAt).map((r) => r.yahoo))];
    const [quotesRes, fxRes] = await Promise.all([
      symbols.length
        ? fetch(`/api/quote-at?date=${date}&symbols=${encodeURIComponent(symbols.join(","))}`)
        : null,
      fetch(`/api/fx-at?date=${date}`),
    ]);
    const quotes = quotesRes && quotesRes.ok ? (await quotesRes.json()).quotes || {} : {};
    const fxData = fxRes.ok ? await fxRes.json() : null;
    const fxFor = (ccy) => {
      if (ccy === "CZK") return 1;
      const r = fxData?.rates?.[ccy];
      return r ? r.rate / r.amount : null;
    };

    // 3) Ocenění per pozice
    for (const r of rows) {
      const q = quotes[r.yahoo];
      const notes = [];
      if (r.delistedAt) {
        r.price = 0;
        r.priceDate = null;
        notes.push(`staženo z burzy ${fmtCzDate(r.delistedAt)} — oceněno 0`);
      } else if (q && q.close != null) {
        r.price = q.close * r.splitFactor;
        r.priceDate = q.price_date;
        if (q.price_date !== date) notes.push(`kurz burzy z ${fmtCzDate(q.price_date)}`);
        if (r.splitFactor !== 1) notes.push(`split po datu — cena ×${fmtSplitFactor(r.splitFactor)}`);
        if (q.currency && r.currency && q.currency !== r.currency) {
          notes.push(`měna ceny ${q.currency} ≠ ${r.currency}`);
        }
      } else {
        r.price = null;
        r.priceDate = null;
        notes.push(q?.error ? `cena nedostupná (${q.error})` : "cena nedostupná");
      }
      r.valueLocal = r.price != null ? r.qty * r.price : null;
      r.fx = fxFor(r.currency);
      if (r.fx == null) notes.push(`chybí kurz ČNB ${r.currency}`);
      r.valueCzk = r.valueLocal != null && r.fx != null ? r.valueLocal * r.fx : null;

      // Pořizovací cena v Kč — každý otevřený lot kurzem k datu SVÉHO vypořádání
      // (stejná metodika jako Report pro účetní), strict — žádné vymýšlení kurzů
      r.costCzk = openLotsCostCzk(r.lots, r.currency, state.fxRates).czk;
      if (r.costCzk == null) notes.push("chybí historický kurz ČNB pro pořizovací cenu");
      r.note = notes.join("; ");
    }

    // 4) Hotovost u brokerů — druhá složka majetku vedle cenných papírů
    const cashRows = [];
    const cashMissing = [];
    for (const { meta, portfolio } of portfolios) {
      const broker = `${meta.broker || meta.name}${portfolio.account ? ` · ${portfolio.account}` : ""}`;
      const c = cashAtDate(portfolio, date);
      if (!c) {
        cashMissing.push(broker);
        continue;
      }
      for (const [ccy, amount] of Object.entries(c.cash)) {
        // Měny s nulovým zůstatkem broker ve výpisu neuvádí — nezobrazovat ani my
        if (!Number.isFinite(amount) || Math.abs(amount) < 0.005) continue;
        const fx = fxFor(ccy);
        const notes = [];
        if (c.asOf !== date) {
          notes.push(
            c.daily
              ? `poslední snapshot z ${fmtCzDate(c.asOf)}`
              : c.estimate
                ? `odhad k ${fmtCzDate(c.asOf)} (${c.source})`
                : `kvartální snapshot k ${fmtCzDate(c.asOf)}`,
          );
        }
        if (fx == null) notes.push(`chybí kurz ČNB ${ccy}`);
        cashRows.push({
          broker,
          ccy,
          amount,
          fx,
          czk: fx != null ? amount * fx : null,
          asOf: c.asOf,
          daily: c.daily,
          source: c.source,
          note: notes.join("; "),
        });
      }
    }

    state.positionsAt.date = date;
    state.positionsAt.rows = rows;
    state.positionsAt.cashRows = cashRows;
    state.positionsAt.cashMissing = cashMissing;
    state.positionsAt.fxValidFor = fxData?.valid_for || null;
    state.positionsAt.portfolioCount = portfolios.length;
    state.positionsAt.companyId = companyId;
    renderPositionsAt();
  } catch (e) {
    showStatus(`Sestavení selhalo: ${e.message}`, true);
  } finally {
    state.positionsAt.loading = false;
  }
  if (state.view === "positions-at" && positionsAtStale()) buildPositionsAt();
}

function renderPositionsAt() {
  const { date, rows, cashRows, cashMissing, fxValidFor, portfolioCount } = state.positionsAt;
  const tbody = document.querySelector("#tbl-positions-at tbody");
  const titleEl = document.getElementById("pa-title");
  const statusEl = document.getElementById("pa-status");
  const summary = document.getElementById("pa-summary");
  const countEl = document.getElementById("pa-count");

  titleEl.textContent = positionsAtTitle(date);
  titleEl.hidden = false;
  statusEl.hidden = true;
  tbody.innerHTML = "";

  const fmtQty = (q) => (Number.isInteger(q) ? fmtNum(q, 0) : fmtNum(q, 4));
  const dash = '<span class="muted">—</span>';
  let totalValue = 0;
  let totalCost = 0;
  let missingValue = 0;
  let missingCost = 0;
  for (const r of rows) {
    if (r.valueCzk != null) totalValue += r.valueCzk;
    else missingValue++;
    if (r.costCzk != null) totalCost += r.costCzk;
    else missingCost++;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="symbol">${r.sym}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${r.isin || dash}</td>
      <td>${escapeHtml(r.broker)}</td>
      <td class="num">${fmtQty(r.qty)}</td>
      <td>${r.currency}</td>
      <td class="num">${r.price != null ? fmtNum(r.price, 4) : dash}</td>
      <td class="num">${r.valueLocal != null ? fmtNum(r.valueLocal, 2) : dash}</td>
      <td class="num">${r.fx != null ? fmtNum(r.fx, 4) : dash}</td>
      <td class="num">${r.valueCzk != null ? fmtNum(r.valueCzk, 2) : dash}</td>
      <td class="num">${r.costCzk != null ? fmtNum(r.costCzk, 2) : dash}</td>
      <td class="muted">${escapeHtml(r.note)}</td>
    `;
    tbody.appendChild(tr);
  }
  document.getElementById("pa-wrap").hidden = false;

  // Hotovost u brokerů — samostatná tabulka, aby šla do rozvahy zvlášť od CP
  const cashBody = document.querySelector("#tbl-pa-cash tbody");
  let totalCash = 0;
  let missingCash = 0;
  if (cashBody) {
    cashBody.innerHTML = "";
    for (const c of cashRows || []) {
      if (c.czk != null) totalCash += c.czk;
      else missingCash++;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(c.broker)}</td>
        <td>${c.ccy}</td>
        <td class="num">${fmtNum(c.amount, 2)}</td>
        <td class="num">${c.fx != null ? fmtNum(c.fx, 4) : dash}</td>
        <td class="num">${c.czk != null ? fmtNum(c.czk, 2) : dash}</td>
        <td class="muted">${escapeHtml(c.note)}</td>
      `;
      cashBody.appendChild(tr);
    }
    document.getElementById("pa-cash-wrap").hidden = (cashRows || []).length === 0;
  }

  if (countEl) {
    countEl.textContent = `${rows.length} ${pozic(rows.length)} · ${portfolioCount} ${portfolii(portfolioCount)}`;
  }

  const diff = totalValue - totalCost;
  const totalAssets = totalValue + totalCash;
  let html = `
    <div>
      <div class="total-label">Ocenění cenných papírů (CZK)</div>
      <div class="total-value">${fmtNum(totalValue, 2)}</div>
    </div>
    <div>
      <div class="total-label">Hotovost u brokerů (CZK)</div>
      <div class="total-value">${fmtNum(totalCash, 2)}</div>
    </div>
    <div>
      <div class="total-label">Majetek celkem (CZK)</div>
      <div class="total-value">${fmtNum(totalAssets, 2)}</div>
    </div>
    <div>
      <div class="total-label">Pořizovací cena celkem (CZK)</div>
      <div class="total-value">${fmtNum(totalCost, 2)}</div>
    </div>
    <div>
      <div class="total-label">Oceňovací rozdíl (CZK)</div>
      <div class="total-value ${signClass(diff)}">${fmtNum(diff, 2)}</div>
    </div>`;
  const warnings = [];
  if (missingCash) warnings.push(`${missingCash}× chybí kurz ČNB k hotovosti — není v součtu.`);
  if (cashMissing?.length) {
    warnings.push(`Hotovost není k dispozici pro: ${cashMissing.join(", ")} (k datu chybí snapshot).`);
  }
  const staleCash = (cashRows || []).filter((c) => c.asOf !== date);
  if (staleCash.length) {
    const byDate = [...new Set(staleCash.map((c) => `${c.broker} — ${fmtCzDate(c.asOf)}`))];
    warnings.push(`Hotovost z bližšího staršího snapshotu: ${byDate.join("; ")}.`);
  }
  if (missingValue) warnings.push(`${missingValue}× chybí ocenění (cena nebo kurz) — součet je bez těchto pozic.`);
  if (missingCost) warnings.push(`${missingCost}× chybí pořizovací cena v Kč (historický kurz ČNB).`);
  if (fxValidFor && fxValidFor !== date) {
    warnings.push(`Kurz ČNB: k ${fmtCzDate(date)} nebyl vyhlášen (víkend/svátek), použit poslední vyhlášený z ${fmtCzDate(fxValidFor)}.`);
  }
  if (warnings.length) {
    html += `<div class="muted summary-note">⚠️ ${warnings.join(" ")}</div>`;
  }
  summary.innerHTML = html;
  summary.hidden = false;
}

function exportPositionsAtXlsx() {
  const { date, rows, cashRows, fxValidFor } = state.positionsAt;
  if (!rows) {
    alert("Nejdřív sestav pozice k datu (tlačítko Sestavit v tabu Pozice k datu).");
    return;
  }
  const title = positionsAtTitle(date);
  const fxNote = fxValidFor && fxValidFor !== date
    ? ` (k ${fmtCzDate(date)} nevyhlášen — použit poslední vyhlášený z ${fmtCzDate(fxValidFor)})`
    : "";
  const subtitle =
    `Zdroj: evidence akcie-tracker (Interactive Brokers + Komerční banka). Kusy = obchody vypořádané do ${fmtCzDate(date)} včetně, FIFO. ` +
    `Ocenění = závěrečný kurz burzy k datu × kusy, přepočet kurzem ČNB k datu${fxNote}. ` +
    `Pořizovací cena = FIFO cost basis vč. komise, kurz ČNB k datu vypořádání každého nákupu. Kryptoaktiva: v evidenci žádná. ` +
    `Hotovost u brokerů je na samostatném listu „Hotovost“ včetně součtu majetku.`;
  const header = [
    "Ticker", "Název", "ISIN", "Broker / účet", "Kusů", "Měna", "Cena k datu", "Datum ceny",
    "Ocenění (měna)", "Kurz ČNB (CZK)", "Ocenění v Kč", "Pořizovací cena v Kč", "Pozn.",
  ];
  const aoa = [[title], [subtitle], [], header];
  let totalValue = 0, totalCost = 0, incomplete = false;
  for (const r of rows) {
    if (r.valueCzk != null) totalValue += r.valueCzk; else incomplete = true;
    if (r.costCzk != null) totalCost += r.costCzk;
    aoa.push([
      r.sym, r.name, r.isin, r.broker, r.qty, r.currency,
      r.price ?? "", r.priceDate ?? "", r.valueLocal ?? "", r.fx ?? "", r.valueCzk ?? "", r.costCzk ?? "", r.note,
    ]);
  }
  aoa.push([]);
  aoa.push([
    "Celkem", "", "", "", "", "", "", "", "", "", totalValue, totalCost,
    incomplete ? "⚠️ některé pozice bez ocenění — nejsou v součtu" : "",
  ]);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const lastCol = header.length - 1;
  const headerRow = 3;
  const totalRow = aoa.length - 1;
  // Nadpis + podtitul přes celou šířku, zalomené
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
  ];
  ws["!rows"] = [{ hpt: 34 }, { hpt: 46 }];
  ws["A1"].s = { font: { bold: true, sz: 12 }, alignment: { wrapText: true, vertical: "top" } };
  ws["A2"].s = { font: { sz: 10, color: { rgb: "6B6B66" } }, alignment: { wrapText: true, vertical: "top" } };
  // Formáty čísel pro účetní: kusy, ceny na 4, částky na 2 desetinná místa
  const numFmt = { 4: "#,##0.####", 6: "#,##0.0000", 8: "#,##0.00", 9: "#,##0.0000", 10: "#,##0.00", 11: "#,##0.00" };
  for (let r = headerRow; r < aoa.length; r++) {
    for (let c = 0; c <= lastCol; c++) {
      const ref = XLSX.utils.encode_cell({ r, c });
      const cell = ws[ref];
      if (!cell) continue;
      if (r === headerRow || r === totalRow) cell.s = { font: { bold: true } };
      if (cell.t === "n" && numFmt[c]) cell.z = numFmt[c];
    }
  }
  ws["!cols"] = [
    { wch: 10 }, { wch: 32 }, { wch: 14 }, { wch: 28 }, { wch: 9 }, { wch: 6 }, { wch: 12 },
    { wch: 11 }, { wch: 15 }, { wch: 11 }, { wch: 16 }, { wch: 18 }, { wch: 40 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, "Pozice k datu");

  // Hotovost na samostatný list — do rozvahy jde zvlášť od cenných papírů,
  // a sloupce (měna, kurz) se do tabulky pozic stejně nevejdou.
  if (cashRows?.length) {
    const cashHeader = ["Broker / účet", "Měna", "Částka", "Kurz ČNB (CZK)", "Hodnota v Kč", "Pozn."];
    const cashAoa = [
      [`Hotovost u brokerů ke dni ${fmtCzDate(date)}`],
      [
        "Zdroj: Interactive Brokers — denní snapshot (Flex NAV); Komerční banka — kvartální snapshot (STAV PTF). " +
          "Přepočet kurzem ČNB k datu. Měny s nulovým zůstatkem broker neuvádí.",
      ],
      [],
      cashHeader,
    ];
    let totalCash = 0;
    for (const c of cashRows) {
      if (c.czk != null) totalCash += c.czk;
      cashAoa.push([c.broker, c.ccy, c.amount, c.fx ?? "", c.czk ?? "", c.note]);
    }
    cashAoa.push([]);
    cashAoa.push(["Hotovost celkem", "", "", "", totalCash, ""]);
    cashAoa.push(["Cenné papíry celkem", "", "", "", totalValue, ""]);
    cashAoa.push(["Majetek celkem", "", "", "", totalValue + totalCash, ""]);

    const cws = XLSX.utils.aoa_to_sheet(cashAoa);
    const cLast = cashHeader.length - 1;
    cws["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: cLast } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: cLast } },
    ];
    cws["!rows"] = [{ hpt: 20 }, { hpt: 32 }];
    cws["A1"].s = { font: { bold: true, sz: 12 }, alignment: { wrapText: true, vertical: "top" } };
    cws["A2"].s = { font: { sz: 10, color: { rgb: "6B6B66" } }, alignment: { wrapText: true, vertical: "top" } };
    const cashNumFmt = { 2: "#,##0.00", 3: "#,##0.0000", 4: "#,##0.00" };
    for (let r = 3; r < cashAoa.length; r++) {
      for (let c = 0; c <= cLast; c++) {
        const cell = cws[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        if (r === 3 || r >= cashAoa.length - 3) cell.s = { font: { bold: true } };
        if (cell.t === "n" && cashNumFmt[c]) cell.z = cashNumFmt[c];
      }
    }
    cws["!cols"] = [{ wch: 28 }, { wch: 6 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, cws, "Hotovost");
  }

  XLSX.writeFile(wb, `${state.positionsAt.companyId}-pozice-k-${date}.xlsx`);
}

// ---------- Daňová optimalizace (za zvolenou firmu) ----------
// Výpočty v ./tax-optimization.js (čisté funkce, testované); tady načtení dat,
// vykreslení a simulace prodeje (výběr pozic žije jen v paměti stránky).
const QUOTE_BATCH = 50; // limit /api/quote

const kcText = (n) => `${fmtNum(n, 0)} Kč`;
const kcSigned = (n) => `<span class="${signClass(n)}">${kcText(n)}</span>`;
const nakupu = (n) => (n === 1 ? "nákup" : n >= 2 && n <= 4 ? "nákupy" : "nákupů");
const pozic = (n) => (n >= 1 && n <= 4 ? "pozice" : "pozic"); // 1–4 pozice, 0 a 5+ pozic
const uctu = (n) => (n === 1 ? "účet" : n >= 2 && n <= 4 ? "účty" : "účtů");
const portfolii = (n) => (n === 1 ? "portfolio" : n >= 2 && n <= 4 ? "portfolia" : "portfolií");

const TAX_DETAILS_KEY = "akcie.taxDetailsOpen";

function setupTaxOpt() {
  // Rozbalené poznámky si prohlížeč pamatuje (jen pohodlí – bez úložiště zůstanou sbalené)
  const details = document.getElementById("tax-details");
  if (details) {
    try {
      details.open = localStorage.getItem(TAX_DETAILS_KEY) === "1";
    } catch {}
    details.addEventListener("toggle", () => {
      try {
        localStorage.setItem(TAX_DETAILS_KEY, details.open ? "1" : "0");
      } catch {}
    });
  }
  document.getElementById("tax-select-losses")?.addEventListener("click", () => {
    const d = state.taxOpt.data;
    if (!d) return;
    state.taxOpt.selected = new Set(d.rows.filter((r) => r.sellable && r.pnlCzk < 0).map((r) => r.key));
    renderTaxOpt();
  });
  document.getElementById("tax-select-clear")?.addEventListener("click", () => {
    state.taxOpt.selected = new Set();
    renderTaxOpt();
  });
  document.querySelectorAll("#tbl-tax th.sortable").forEach((th) => {
    th.addEventListener("click", (e) => {
      if (e.target.classList.contains("hint")) return;
      const sort = state.taxOpt.sort;
      const key = th.dataset.sortKey;
      if (sort.key === key) sort.dir = sort.dir === "asc" ? "desc" : "asc";
      else {
        sort.key = key;
        sort.dir = th.classList.contains("num") ? "desc" : "asc";
      }
      renderTaxTable();
    });
  });
  const tbody = document.querySelector("#tbl-tax tbody");
  tbody?.addEventListener("change", (e) => {
    const cb = e.target.closest("input[data-tax-select]");
    if (!cb) return;
    if (cb.checked) state.taxOpt.selected.add(cb.dataset.taxSelect);
    else state.taxOpt.selected.delete(cb.dataset.taxSelect);
    renderTaxCards();
  });
  tbody?.addEventListener("click", (e) => {
    if (e.target.closest("input, label, button, a")) return;
    const tr = e.target.closest("tr.position");
    if (tr) toggleTaxDetail(tr);
  });
}

async function buildTaxOpt() {
  if (state.taxOpt.loading) return;
  state.taxOpt.loading = true;
  const statusEl = document.getElementById("tax-status");
  const showStatus = (msg, isError = false) => {
    statusEl.hidden = false;
    statusEl.classList.toggle("error", isError);
    statusEl.textContent = msg;
  };
  const companyId = state.companyId;
  showStatus("Načítám portfolia firmy a aktuální ceny…");
  // Podaná přiznání jsou samostatná část tabu – když se nenačtou, zbytek běží dál.
  // Soubor patří jedné firmě (`owner`), u jiné firmy se neukazuje.
  const taxReturns = fetch(TAX_RETURNS_URL, { cache: "no-cache" })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((json) =>
      json.owner && json.owner !== companyId
        ? { overview: null, error: null, otherCompany: true }
        : { overview: lossCarryOverview(json.returns), error: null },
    )
    .catch((e) => ({ overview: null, error: e.message }));
  try {
    const accounts = withPositions(companyPortfolios(await loadAllPortfoliosForSnapshot()));
    if (!accounts.length) throw new Error("zvolená firma nemá v Nastavení žádné portfolio");
    const today = pragueToday();
    const year = today.slice(0, 4);

    // Aktuální ceny držených titulů ze všech účtů (delisted Yahoo nezná)
    const symbols = new Set();
    for (const { portfolio, positions } of accounts) {
      for (const sym of Object.keys(positions)) {
        const inst = portfolio.instruments?.[sym] || {};
        if (positions[sym].net_qty > 1e-9 && !inst.delisted) symbols.add(inst.yahoo_symbol || sym);
      }
    }
    const list = [...symbols];
    const quotes = {};
    for (let i = 0; i < list.length; i += QUOTE_BATCH) {
      const batch = list.slice(i, i + QUOTE_BATCH);
      const res = await fetch(`${QUOTE_URL}?symbols=${encodeURIComponent(batch.join(","))}`);
      if (!res.ok) throw new Error(`Quote API ${res.status}`);
      Object.assign(quotes, (await res.json()).quotes || {});
    }

    const rows = taxPositionRows(accounts, quotes, state.fxRates, today);
    state.taxOpt.data = {
      companyId,
      today,
      year,
      rows,
      accountCount: accounts.length,
      realized: realizedInYear(accounts, state.fxRates, year),
      dividends: dividendsInYear(accounts, state.fxRates, year),
      fx: currentFxInfo(state.fxRates, today),
      fetchedAt: new Date(),
      taxReturns: await taxReturns,
    };
    // Výběr přežije přepočet jen u pozic, které pořád jdou prodat
    const sellable = new Set(rows.filter((r) => r.sellable).map((r) => r.key));
    state.taxOpt.selected = new Set([...state.taxOpt.selected].filter((k) => sellable.has(k)));
    statusEl.hidden = true;
    renderTaxOpt();
  } catch (e) {
    showStatus(`Výpočet selhal: ${e.message}`, true);
  } finally {
    state.taxOpt.loading = false;
  }
  // Firma se změnila během načítání — výsledek patří té předchozí
  if (state.view === "tax" && taxOptStale()) buildTaxOpt();
}

const taxOptStale = () => !!state.taxOpt.data && state.taxOpt.data.companyId !== state.companyId;
const positionsAtStale = () => !!state.positionsAt.rows && state.positionsAt.companyId !== state.companyId;

function renderTaxOpt() {
  const d = state.taxOpt.data;
  if (!d) return;
  document.getElementById("tax-year").textContent = d.year;
  renderTaxCards();
  renderTaxNotes();
  renderTaxTable();
  renderTaxReturns();
}

function renderTaxCards() {
  const d = state.taxOpt.data;
  const wrap = document.getElementById("tax-cards");
  wrap.innerHTML = "";
  wrap.hidden = false;
  const r = d.realized;
  const u = unrealizedTotals(d.rows);
  const sim = simulateSale(r.net, d.rows, state.taxOpt.selected);
  const rate = `${fmtNum(DPPO_RATE * 100, 0)} %`;
  const accounts = r.byAccount.map((a) => a.account).join(" + ");
  const carry = d.taxReturns?.overview;
  const pastLoss = !carry
    ? "před odečtem daňové ztráty z minulých let"
    : carry.unusedTotal > 0
      ? `před odečtem ztráty z minulých let (${kcText(carry.unusedTotal)})`
      : "ztráta z minulých let k odečtu není";
  const add = (el, title) => {
    el.title = title;
    wrap.appendChild(el);
  };

  add(
    cardHtml(
      `Realizováno ${d.year}`,
      kcSigned(r.net),
      `${r.byAccount.map((a) => `${escapeHtml(a.account)} ${kcText(a.net)}`).join(" · ")}<br>zisky ${kcText(r.gains)} · ztráty ${kcText(r.losses)}`,
    ),
    `Prodeje vypořádané v roce ${d.year} (${r.sales}), FIFO, kurz ČNB k datu vypořádání nákupu i prodeje – stejně jako Report pro účetní, sečteno za ${accounts}: zisky ${kcText(r.gains)} + ztráty ${kcText(r.losses)} = ${kcText(r.net)}.`,
  );
  add(
    r.net > 0
      ? cardHtml("Odhad daně z prodejů", kcText(taxEstimate(r.net)), `${rate} × ${kcText(r.net)}<br>${pastLoss}`)
      : cardHtml("Odhad daně z prodejů", kcText(0), `ztráta ${kcText(r.net)} snižuje základ daně<br>daňovou ztrátu jde využít 2 roky zpětně nebo 5 let dopředu (viz poznámky)`),
    `Daň z příjmů právnických osob ${rate} jen z výsledku prodejů cenných papírů: ${r.net > 0 ? `${rate} × ${kcText(r.net)} = ${kcText(taxEstimate(r.net))}` : `výsledek ${kcText(r.net)} ≤ 0 → 0 Kč`}. Ostatní výnosy a náklady společnosti tu nejsou. Daňová ztráta (za celou firmu) se odečte v 5 letech po roce, kdy vznikla, nebo zpětně ve 2 letech před ním (§ 34 odst. 1 ZDP).`,
  );
  add(
    cardHtml("Nerealizovaný zisk", kcSigned(u.gains), `${u.gainCount} ${pozic(u.gainCount)} · kdyby se prodaly dnes`),
    `Součet kladných Z/Z v Kč (daňově) za pozice, které jdou prodat: ${u.gainCount} ${pozic(u.gainCount)}, celkem ${kcText(u.gains)}.`,
  );
  add(
    cardHtml(
      "Nerealizovaná ztráta",
      kcSigned(u.losses),
      `${u.lossCount} ${pozic(u.lossCount)}${u.excluded.length ? ` · bez ${u.excluded.map((x) => escapeHtml(x.sym)).join(", ")}` : ""}`,
    ),
    `Součet záporných Z/Z v Kč (daňově) za pozice, které jdou prodat: ${u.lossCount} ${pozic(u.lossCount)}, celkem ${kcText(u.losses)}.${u.excluded.length ? ` Mimo součet: ${u.excluded.map((x) => `${x.sym} (${x.note})`).join("; ")}.` : ""}`,
  );
  add(
    cardHtml(
      "Simulace – po prodeji vybraných",
      kcSigned(sim.net),
      sim.count
        ? `${sim.count} ${pozic(sim.count)}: ${kcText(sim.selectedPnl)} · odhad daně ${kcText(sim.tax)}`
        : "zaškrtni pozice ve sloupci Prodat",
    ),
    `Realizováno ${kcText(r.net)} + Z/Z vybraných pozic ${kcText(sim.selectedPnl)} = ${kcText(sim.net)}; odhad daně ${sim.net > 0 ? `${rate} × ${kcText(sim.net)} = ` : ""}${kcText(sim.tax)}. Nic se neprodává ani neukládá.`,
  );
  const dv = d.dividends;
  add(
    cardHtml(
      `Dividendy ${d.year}`,
      kcText(dv.grossCzk),
      `sražená daň ${kcText(dv.withheldCzk)} · samostatný základ daně`,
    ),
    `Hrubé dividendy připsané v roce ${d.year} (${dv.count} výplat) kurzem ČNB k datu výplaty: ${kcText(dv.grossCzk)}, sražená daň v zahraničí ${kcText(dv.withheldCzk)}${dv.missing ? `; ${dv.missing} položek bez kurzu ČNB není v součtu` : ""}. Dividendy jsou samostatný základ daně – ztráta z prodejů je nekompenzuje.`,
  );
}

function renderTaxNotes() {
  const d = state.taxOpt.data;
  const items = [
    `<strong>Orientační výpočet, ne daňové poradenství.</strong> Počítá se jako v Reportu pro účetní (FIFO po účtech, kurz ČNB k datu vypořádání), daň ${fmtNum(DPPO_RATE * 100, 0)} % jen z výsledku prodejů.`,
    `PLEGI invest je mikro účetní jednotka: akcie se k 31. 12. nepřeceňují (§ 27 odst. 7 zákona o účetnictví), daň ovlivní jen prodej. Ztráta z prodeje se od zisků odečte – omezení v § 24 odst. 2 písm. w) zákona o daních z příjmů se na mikro účetní jednotku nevztahuje. Prodej a okamžitý zpětný nákup jen kvůli daňové ztrátě může finanční úřad posoudit jako zneužití práva.`,
    `Do roku ${d.year} patří prodej <strong>vypořádaný</strong> nejpozději 31. 12. ${d.year} – v USA den po obchodu, v Evropě dva pracovní dny po obchodu. Obchod z posledních dní roku se vypořádá až v lednu a patří do dalšího roku.`,
    `Hodnota v Kč: ceny z Yahoo (zpoždění ~15 min) načtené ${d.fetchedAt.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}, kurz ČNB vyhlášený k ${d.fx.validFor ? fmtCzDate(d.fx.validFor) : "–"}.`,
    "Tituly stažené z burzy (Canacol Energy) v tabulce nejsou – nejdou prodat a daňově s nimi pracovat nejde.",
  ];
  if (d.realized.missing.length) {
    items.push(`⚠️ Prodeje bez kurzu ČNB nejsou v Realizováno: ${escapeHtml(d.realized.missing.join(", "))}.`);
  }
  document.getElementById("tax-notes").innerHTML = `<ul class="tax-notes">${items.map((t) => `<li>${t}</li>`).join("")}</ul>`;
}

function sortedTaxRows() {
  const { key, dir } = state.taxOpt.sort;
  const sign = dir === "desc" ? -1 : 1;
  return [...state.taxOpt.data.rows].sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    // Bez hodnoty vždy na konec, ať nezaclání nahoře v obou směrech
    if (va == null || vb == null || va === "" || vb === "") {
      if ((va == null || va === "") && (vb == null || vb === "")) return a.sym.localeCompare(b.sym, "cs");
      return va == null || va === "" ? 1 : -1;
    }
    const c = typeof va === "string" ? va.localeCompare(vb, "cs") : va - vb;
    return sign * c || a.sym.localeCompare(b.sym, "cs") || a.account.localeCompare(b.account, "cs");
  });
}

function renderTaxTable() {
  const d = state.taxOpt.data;
  document.getElementById("tax-wrap").hidden = false;
  const tbody = document.querySelector("#tbl-tax tbody");
  tbody.innerHTML = "";
  const { key, dir } = state.taxOpt.sort;
  document.querySelectorAll("#tbl-tax th.sortable").forEach((th) => {
    const isSorted = th.dataset.sortKey === key;
    th.classList.toggle("sorted", isSorted);
    th.classList.toggle("desc", isSorted && dir === "desc");
  });

  const rows = sortedTaxRows();
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.className = "position";
    tr.dataset.key = r.key;
    const pnlTitle =
      r.pnlCzk != null
        ? `Hodnota ${kcText(r.valueCzk)} (${fmtNum(r.qty, 0)} ks × ${fmtNum(r.price, 2)} ${r.currency} × kurz ${fmtNum(r.fxNow, 3)}) − pořizovací cena ${kcText(r.costCzk)} = ${kcText(r.pnlCzk)}. Kliknutím zobrazíš jednotlivé nákupy.`
        : "Chybí cena nebo kurz – viz Pozn.";
    tr.innerHTML = `
      <td class="symbol">${escapeHtml(r.sym)}</td>
      <td class="tax-select"><label class="tax-select-hit"><input type="checkbox" data-tax-select="${escapeHtml(r.key)}" aria-label="Prodat ${escapeHtml(r.sym)} (${escapeHtml(r.account)}) – simulace" ${state.taxOpt.selected.has(r.key) ? "checked" : ""} ${r.sellable ? "" : "disabled"}></label></td>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.account)}</td>
      <td class="num">${fmtNum(r.qty, Number.isInteger(r.qty) ? 0 : 4)}</td>
      <td>${r.lastBuy ? fmtCzDate(r.lastBuy) : "–"} <span class="muted">· ${r.lots.length} ${nakupu(r.lots.length)}</span></td>
      <td class="num">${r.costCzk != null ? fmtNum(r.costCzk, 0) : '<span class="muted">–</span>'}</td>
      <td class="num">${r.valueCzk != null ? fmtNum(r.valueCzk, 0) : '<span class="muted">–</span>'}</td>
      <td class="num ${signClass(r.pnlLocal)}">${r.pnlLocal != null ? `${fmtNum(r.pnlLocal, 2)} <span class="muted">${escapeHtml(r.currency)}</span>` : '<span class="muted">–</span>'}</td>
      <td class="num clickable ${signClass(r.pnlCzk)}" title="${escapeHtml(pnlTitle)}"><strong>${r.pnlCzk != null ? fmtNum(r.pnlCzk, 0) : "–"}</strong> <span class="caret">▾</span></td>
      <td class="num ${signClass(r.pct)}">${r.pct != null ? fmtPct(r.pct) : '<span class="muted">–</span>'}</td>
      <td class="muted tax-note">${escapeHtml(r.note)}</td>
    `;
    tbody.appendChild(tr);
  }

  // Součet jen za pozice, které jdou prodat — stejný základ jako dlaždice
  const sellable = rows.filter((r) => r.sellable);
  const sum = (f) => sellable.reduce((s, r) => s + r[f], 0);
  const excluded = rows.length - sellable.length;
  document.getElementById("tfoot-tax").innerHTML = `
    <tr>
      <td colspan="6">Celkem pozice, které jdou prodat (${sellable.length})${excluded ? ` <span class="muted">· mimo součet ${excluded}</span>` : ""}</td>
      <td class="num">${fmtNum(sum("costCzk"), 0)}</td>
      <td class="num">${fmtNum(sum("valueCzk"), 0)}</td>
      <td></td>
      <td class="num ${signClass(sum("pnlCzk"))}"><strong>${fmtNum(sum("pnlCzk"), 0)}</strong></td>
      <td colspan="2"></td>
    </tr>
  `;
  document.getElementById("tax-count").textContent =
    `${rows.length} ${pozic(rows.length)} · ${d.accountCount} ${uctu(d.accountCount)} · stav k ${fmtCzDate(d.today)}`;
}

// Poznámka k roku v tabulce přiznání i v exportu: vznik a odečtení ztráty, dividendy
function taxReturnNote(r) {
  const notes = [];
  if (r.lossInfo) {
    const { loss, usedIn, remaining, until } = r.lossInfo;
    const showAmounts = usedIn.length > 1 || remaining > 0;
    const where = usedIn
      .map((u) => `${u.year < r.year ? "zpětně " : ""}v roce ${u.year}${showAmounts ? ` (${kcText(u.amount)})` : ""}`)
      .join(", ");
    notes.push(
      remaining > 0
        ? `Daňová ztráta ${kcText(loss)}${where ? ` – odečtena ${where}` : ""}; zbývá ${kcText(remaining)}, lze do ${until}.`
        : `Daňová ztráta ${kcText(loss)} – celá odečtena ${where}.`,
    );
  }
  if (r.deductedFrom.length) {
    notes.push(`Odečtena ztráta z roku ${r.deductedFrom.map((s) => `${s.year} (${kcText(s.amount)})`).join(", ")}.`);
  }
  if (r.separate_base) notes.push(`Dividendy ze zahraničí ${kcText(r.separate_base)} v samostatném základu.`);
  return notes.join(" ");
}

// Vrácená daň: sazba × odečtená částka, nejvýš daň, která se za rok zaplatila
function taxRefundFormula(r) {
  return `${r.rate} % × ${kcText(r.back.capacity)} = ${kcText((r.back.capacity * r.rate) / 100)}, nejvýš zaplacená daň ${kcText(r.tax)} → ${kcText(r.back.refund)}`;
}

function renderTaxReturns() {
  const { overview: o, error, otherCompany } = state.taxOpt.data.taxReturns || {};
  const status = document.getElementById("tax-returns-status");
  const wrap = document.getElementById("tax-returns-wrap");
  const carry = document.getElementById("tax-returns-carry");
  const hint = document.getElementById("tax-details-hint");
  if (!o) {
    status.hidden = false;
    status.classList.toggle("error", !otherCompany);
    status.textContent = otherCompany
      ? `Podaná přiznání firmy ${currentCompany()?.name || ""} zatím v aplikaci nejsou (data/tax-returns.json má jen jednu firmu).`
      : `Daňová přiznání se nepodařilo načíst${error ? ` (${error})` : ""}.`;
    wrap.hidden = true;
    carry.textContent = "";
    hint.textContent = "";
    return;
  }
  status.hidden = true;
  document.querySelectorAll("[data-open-year]").forEach((el) => {
    el.textContent = o.openYear;
  });

  // Hlavní čísla přenosu ztráty jsou vidět i u sbalených poznámek
  const backYears = o.back.map((b) => b.year).reverse().join(" a ");
  hint.textContent = ` · ztrátu ${o.openYear} jde zpětně odečíst až ${kcText(o.backCapacity)}`;
  const unusedNote = o.unused.length
    ? ` (${o.unused.map((l) => `z roku ${l.year}, lze do ${l.until}`).join("; ")})`
    : o.losses.length
      ? ` (ztráta ${o.losses.map((l) => l.year).join(", ")} už je odečtená)`
      : "";
  carry.innerHTML =
    `Neuplatněná daňová ztráta z minulých let: <strong>${kcText(o.unusedTotal)}</strong>${unusedNote}. ` +
    `Kdyby rok ${o.openYear} skončil daňovou ztrátou, jde ji odečíst zpětně od základu ${backYears} – až <strong>${kcText(o.backCapacity)}</strong>, ` +
    `vrátí se až <strong>${kcText(o.backRefund)}</strong> daně – a co se nevejde, v letech ${o.forwardFrom}–${o.forwardTo}.`;
  carry.title =
    o.back
      .map((b) => (b.filed ? `${b.year}: až ${kcText(b.capacity)}, vrátí se až ${kcText(b.refund)}` : `${b.year}: přiznání v datech není`))
      .reverse()
      .join("; ") + ` – souhrnně nejvýš 30 mil. Kč (§ 34 odst. 1 ZDP).`;

  wrap.hidden = false;
  const dash = '<span class="muted">–</span>';
  const tbody = document.querySelector("#tbl-tax-returns tbody");
  tbody.innerHTML = "";
  for (const r of o.rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${r.year}</strong></td>
      <td>${fmtCzDate(r.filed)}</td>
      <td class="num ${signClass(r.result)}">${fmtNum(r.result, 0)}</td>
      <td class="num ${r.base < 0 ? "neg" : ""}">${fmtNum(r.base, 0)}</td>
      <td class="num">${r.loss_deducted ? fmtNum(r.loss_deducted, 0) : dash}</td>
      <td class="num">${fmtNum(r.tax, 0)}${r.rate ? ` <span class="muted">${r.rate} %</span>` : ""}</td>
      <td class="num">${r.separate_tax ? fmtNum(r.separate_tax, 0) : dash}</td>
      <td class="num"><strong>${fmtNum(r.tax_total, 0)}</strong></td>
      <td class="num" title="${r.back ? escapeHtml(`Základ po odečtech (ř. 250) ${kcText(r.base_after_deductions)}${r.back.capacity !== r.base_after_deductions ? ` − ztráta odečtená zpětně = ${kcText(r.back.capacity)}` : ""}`) : ""}">${r.back ? `<strong>${fmtNum(r.back.capacity, 0)}</strong>` : dash}</td>
      <td class="num" title="${r.back?.filed && r.rate ? escapeHtml(taxRefundFormula(r)) : ""}">${r.back ? `<strong>${fmtNum(r.back.refund, 0)}</strong>` : dash}</td>
      <td class="muted tax-note">${escapeHtml(taxReturnNote(r))}</td>
    `;
    tbody.appendChild(tr);
  }
  document.getElementById("tfoot-tax-returns").innerHTML = `
    <tr>
      <td colspan="8">Zpětně pro ztrátu ${o.openYear} celkem <span class="muted">· od základu ${backYears}</span></td>
      <td class="num"><strong>${fmtNum(o.backCapacity, 0)}</strong></td>
      <td class="num"><strong>${fmtNum(o.backRefund, 0)}</strong></td>
      <td></td>
    </tr>
  `;
}

function toggleTaxDetail(tr) {
  const next = tr.nextElementSibling;
  const tbody = tr.parentElement;
  if (next && next.classList.contains("detail")) {
    next.remove();
    tr.classList.remove("expanded");
    return;
  }
  tbody.querySelectorAll("tr.detail").forEach((x) => x.remove());
  tbody.querySelectorAll("tr.position.expanded").forEach((x) => x.classList.remove("expanded"));
  const r = state.taxOpt.data.rows.find((x) => x.key === tr.dataset.key);
  if (!r) return;
  const lotRows = r.lots
    .map(
      (l) => `
      <tr>
        <td>${fmtCzDate(l.settleDate)}${l.date && l.date !== l.settleDate ? ` <span class="muted">(obchod ${fmtCzDate(l.date)})</span>` : ""}</td>
        <td class="num">${fmtNum(l.qty, Number.isInteger(l.qty) ? 0 : 4)} ks</td>
        <td class="num muted">@ ${fmtNum(l.costPerUnit, 4)} ${escapeHtml(r.currency)}</td>
        <td class="num muted">kurz ${l.fx != null ? fmtNum(l.fx, 4) : "chybí"}${l.estimated ? " (odhad)" : ""}</td>
        <td class="num">${l.costCzk != null ? kcText(l.costCzk) : "–"}</td>
        <td class="num">${l.valueCzk != null ? kcText(l.valueCzk) : "–"}</td>
        <td class="num ${signClass(l.pnlCzk)}"><strong>${l.pnlCzk != null ? kcText(l.pnlCzk) : "–"}</strong></td>
      </tr>`,
    )
    .join("");
  const detail = document.createElement("tr");
  detail.className = "detail";
  detail.innerHTML = `
    <td colspan="12">
      <div class="detail-card">
        <h3>${escapeHtml(r.sym)} — ${escapeHtml(r.name)} <span class="muted">· ${escapeHtml(r.account)} · ${escapeHtml(r.currency)}</span></h3>
        <div class="detail-section detail-section-fullwidth">
          <h4>Držené nákupy (FIFO – při prodeji části pozice odchází nejdřív nejstarší)</h4>
          <table class="mini">
            <tbody>
              <tr class="muted">
                <td>Vypořádání nákupu</td><td class="num">Kusů</td><td class="num">Nákup/ks vč. komise</td>
                <td class="num">Kurz ČNB</td><td class="num">Pořizovací</td><td class="num">Hodnota dnes</td><td class="num">Z/Z v Kč</td>
              </tr>
              ${lotRows}
            </tbody>
          </table>
        </div>
      </div>
    </td>
  `;
  tr.after(detail);
  tr.classList.add("expanded");
}

function exportTaxOptXlsx() {
  const d = state.taxOpt.data;
  if (!d) {
    alert("Daňová optimalizace se ještě načítá – zkus to za chvíli znovu.");
    return;
  }
  const r = d.realized;
  const u = unrealizedTotals(d.rows);
  const sim = simulateSale(r.net, d.rows, state.taxOpt.selected);
  const title = `Daňová optimalizace ${d.year} – PLEGI invest s.r.o. (všechna portfolia), stav k ${fmtCzDate(d.today)}`;
  const subtitle =
    `Orientační výpočet, ne daňové poradenství. Pořizovací cena = FIFO cost basis držených nákupů vč. komise, kurz ČNB k datu vypořádání každého nákupu; ` +
    `hodnota = kusy × cena z Yahoo × kurz ČNB vyhlášený k ${d.fx.validFor ? fmtCzDate(d.fx.validFor) : "–"}. Realizováno = prodeje vypořádané v roce ${d.year} jako v Reportu pro účetní. ` +
    `Daň ${fmtNum(DPPO_RATE * 100, 0)} % jen z výsledku prodejů. Mikro účetní jednotka: akcie se k 31. 12. nepřeceňují (§ 27 odst. 7 ZoÚ), ztráta z prodeje se od zisků odečte (omezení § 24 odst. 2 písm. w) ZDP se na mikro účetní jednotku nevztahuje). ` +
    `Daňová ztráta firmy se odečte v 5 letech po roce vzniku nebo zpětně ve 2 letech před ním, zpětně nejvýš 30 mil. Kč (§ 34 odst. 1 ZDP); odhad daně je před odečtem ztrát z minulých let.`;
  const summary = [
    [`Realizováno ${d.year}`, r.net],
    ["Odhad daně z prodejů", taxEstimate(r.net)],
    ["Nerealizovaný zisk (lze prodat)", u.gains],
    ["Nerealizovaná ztráta (lze prodat)", u.losses],
    [`Simulace – po prodeji vybraných (${sim.count})`, sim.net],
    ["Odhad daně po simulaci", sim.tax],
    [`Dividendy ${d.year} hrubě`, d.dividends.grossCzk],
    [`Dividendy ${d.year} sražená daň`, d.dividends.withheldCzk],
  ];
  const header = [
    "Symbol", "Název", "Účet", "Kusů", "Poslední nákup", "Počet nákupů", "Pořizovací cena v Kč", "Hodnota v Kč",
    "Z/Z v měně", "Měna", "Z/Z v Kč (daňově)", "%", "Lze prodat", "Prodat (simulace)", "Pozn.",
  ];
  const aoa = [[title], [subtitle], [], ...summary, [], header];
  const headerRow = aoa.length - 1;
  const dateOf = (iso) => (iso ? new Date(`${iso}T00:00:00`) : "");
  for (const row of sortedTaxRows()) {
    aoa.push([
      row.sym, row.name, row.account, row.qty, dateOf(row.lastBuy), row.lots.length,
      row.costCzk ?? "", row.valueCzk ?? "", row.pnlLocal ?? "", row.currency || "", row.pnlCzk ?? "",
      row.pct != null ? row.pct / 100 : "", row.sellable ? "ano" : "ne", state.taxOpt.selected.has(row.key) ? "ano" : "", row.note,
    ]);
  }
  const firstData = headerRow + 2; // 1-based řádek první pozice
  const lastData = aoa.length;
  aoa.push([]);
  // Celkem jako vzorec jen za pozice, které jdou prodat (stejně jako na obrazovce);
  // v = předpočtená hodnota pro prohlížeče, které vzorce nepřepočítají
  const sellableRows = d.rows.filter((row) => row.sellable);
  const sumIf = (col, field) => ({
    t: "n",
    f: `SUMIFS(${col}${firstData}:${col}${lastData},M${firstData}:M${lastData},"ano")`,
    v: sellableRows.reduce((sum, row) => sum + row[field], 0),
  });
  aoa.push([
    "Celkem – lze prodat", "", "", "", "", "", sumIf("G", "costCzk"), sumIf("H", "valueCzk"), "", "",
    sumIf("K", "pnlCzk"), "", "", "", "",
  ]);

  const wb = XLSX.utils.book_new();
  // Tečky ve formátu data musí být escapované, jinak SSF hodí „bad second format"
  const ws = XLSX.utils.aoa_to_sheet(aoa, { dateNF: "d\\. m\\. yyyy" });
  const lastCol = header.length - 1;
  const totalRow = aoa.length - 1;
  // Buňky předané jako objekt (vzorce) aoa_to_sheet nemusí započítat do rozsahu
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: totalRow, c: lastCol } });
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
  ];
  ws["!rows"] = [{ hpt: 20 }, { hpt: 46 }];
  ws["A1"].s = { font: { bold: true, sz: 12 } };
  ws["A2"].s = { font: { sz: 10, color: { rgb: "6B6B66" } }, alignment: { wrapText: true, vertical: "top" } };
  const numFmt = { 3: "#,##0.####", 6: "#,##0", 7: "#,##0", 8: "#,##0.00", 10: "#,##0", 11: "0.00%" };
  for (let rr = 3; rr < aoa.length; rr++) {
    for (let c = 0; c <= lastCol; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: rr, c })];
      if (!cell) continue;
      if (rr === headerRow || rr === totalRow || (rr < headerRow && c === 0)) cell.s = { font: { bold: true } };
      if (rr < headerRow && c === 1 && cell.t === "n") cell.z = "#,##0";
      if (rr > headerRow && cell.t === "n" && numFmt[c]) cell.z = numFmt[c];
    }
  }
  ws["!autofilter"] = { ref: `A${headerRow + 1}:${XLSX.utils.encode_col(lastCol)}${lastData}` };
  ws["!cols"] = [
    { wch: 9 }, { wch: 30 }, { wch: 6 }, { wch: 9 }, { wch: 13 }, { wch: 8 }, { wch: 14 }, { wch: 14 },
    { wch: 13 }, { wch: 6 }, { wch: 14 }, { wch: 8 }, { wch: 9 }, { wch: 10 }, { wch: 50 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, "Daňová optimalizace");
  if (d.taxReturns?.overview) XLSX.utils.book_append_sheet(wb, taxReturnsSheet(d.taxReturns.overview), "Daňová přiznání");
  XLSX.writeFile(wb, `${d.companyId}-danova-optimalizace-${d.year}-k-${d.today}.xlsx`);
}

// Druhý list exportu: podaná přiznání a kolik ztráty otevřeného roku jde odečíst zpětně
function taxReturnsSheet(o) {
  const backYears = o.back.map((b) => b.year).reverse().join(" a ");
  const header = [
    "Rok", "Podáno", "Účetní výsledek (ř. 10)", "Daňový základ (ř. 220)", "Odečtená ztráta (ř. 230)", "Sazba",
    "Daň (ř. 290)", "Daň z dividend (ř. 335)", "Daň celkem (ř. 340)", `Zpětně pro ztrátu ${o.openYear}`, "Vrátí se až", "Pozn.",
  ];
  const aoa = [
    ["Daňová přiznání a přenos ztráty – PLEGI invest s.r.o."],
    [
      `Ztrátu roku ${o.openYear} jde odečíst zpětně od základu ${backYears} (souhrnně nejvýš 30 mil. Kč, dodatečným přiznáním; vrátí se daň ze základu, ne daň z dividend), ` +
        `nebo od kladného základu v letech ${o.forwardFrom}–${o.forwardTo}; co se nevyužije, propadne (§ 34 odst. 1 ZDP). Neuplatněná ztráta z minulých let: ${kcText(o.unusedTotal)}.`,
    ],
    [],
    header,
  ];
  const headerRow = aoa.length - 1;
  for (const r of o.rows) {
    aoa.push([
      r.year, new Date(`${r.filed}T00:00:00`), r.result, r.base, r.loss_deducted, r.rate != null ? r.rate / 100 : "",
      r.tax, r.separate_tax, r.tax_total, r.back ? r.back.capacity : "", r.back ? r.back.refund : "", taxReturnNote(r),
    ]);
  }
  const firstData = headerRow + 2; // 1-based řádek prvního roku
  const lastData = aoa.length;
  aoa.push([
    `Zpětně pro ztrátu ${o.openYear} celkem`, "", "", "", "", "", "", "", "",
    { t: "n", f: `SUM(J${firstData}:J${lastData})`, v: o.backCapacity },
    { t: "n", f: `SUM(K${firstData}:K${lastData})`, v: o.backRefund },
    "",
  ]);

  const ws = XLSX.utils.aoa_to_sheet(aoa, { dateNF: "d\\. m\\. yyyy" });
  const lastCol = header.length - 1;
  const totalRow = aoa.length - 1;
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: totalRow, c: lastCol } });
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
  ];
  ws["!rows"] = [{ hpt: 20 }, { hpt: 46 }];
  ws["A1"].s = { font: { bold: true, sz: 12 } };
  ws["A2"].s = { font: { sz: 10, color: { rgb: "6B6B66" } }, alignment: { wrapText: true, vertical: "top" } };
  for (let rr = headerRow; rr <= totalRow; rr++) {
    for (let c = 0; c <= lastCol; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: rr, c })];
      if (!cell) continue;
      if (rr === headerRow) cell.s = { font: { bold: true }, alignment: { wrapText: true, vertical: "top" } };
      if (rr === totalRow) cell.s = { font: { bold: true } };
      if (rr > headerRow && cell.t === "n" && c >= 2) cell.z = c === 5 ? "0%" : "#,##0";
    }
  }
  ws["!autofilter"] = { ref: `A${headerRow + 1}:${XLSX.utils.encode_col(lastCol)}${lastData}` };
  ws["!cols"] = [
    { wch: 6 }, { wch: 11 }, { wch: 14 }, { wch: 13 }, { wch: 13 }, { wch: 7 }, { wch: 11 }, { wch: 13 }, { wch: 12 },
    { wch: 14 }, { wch: 12 }, { wch: 60 },
  ];
  return ws;
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
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.classList.remove("error");
  el.textContent = msg;
}

function showError(msg) {
  const el = document.getElementById("status");
  el.hidden = false;
  el.classList.add("error");
  el.textContent = msg;
}

// Nefatální varování z načítání dat (výpadek overlay, stará data, …).
// Na rozdíl od setStatus zůstávají viditelná — uživatel musí vědět,
// že se dívá na neúplná data (účetní podklad).
function renderLoadWarnings() {
  const el = document.getElementById("warnings");
  if (!el) return;
  const warnings = state.loadWarnings || [];
  el.innerHTML = warnings
    .map((w) => `<div class="status warn">⚠️ ${escapeHtml(w)}</div>`)
    .join("");
}

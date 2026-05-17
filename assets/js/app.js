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

  // 1) Load manifest, FX rates, watchlist, alerts paralelně
  const [manifestRes, fxRes, watchRes, alertsRes] = await Promise.all([
    fetch(MANIFEST_URL, { cache: "no-cache" }),
    fetch(FX_URL, { cache: "no-cache" }),
    fetch(WATCHLIST_URL, { cache: "no-cache" }),
    fetch(ALERTS_URL, { cache: "no-cache" }),
  ]);
  if (!manifestRes.ok) throw new Error(`Manifest ${manifestRes.status}`);
  state.manifest = await manifestRes.json();
  state.fxRates = fxRes.ok ? await fxRes.json() : { dates: {} };
  state.watchlist = watchRes.ok ? await watchRes.json() : { items: [] };
  state.alerts = alertsRes.ok ? await alertsRes.json() : { rules: [], fired: {} };

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
  setupReportFilter();
  setupOverviewSearch();
  setupWatchlistModal();
  setupEditWatchModal();
  setupAlertsModal();
  setupPortfolioSwitcher();

  // 5) Fetch live quotes
  await refreshQuotes();
}

async function loadActivePortfolio() {
  const meta = state.manifest.portfolios.find((p) => p.id === state.portfolioId);
  if (!meta) throw new Error(`Portfolio ${state.portfolioId} v manifestu nenalezeno`);
  setStatus(`Načítám ${meta.name}…`);
  const url = `${PORTFOLIO_BASE}${meta.file}`;
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) {
    // Portfolio nemusí ještě existovat (např. KB čeká na import)
    state.portfolio = makeEmptyPortfolio(meta);
    state.positions = {};
    return;
  }
  state.portfolio = await res.json();
  state.positions = computePositions(
    state.portfolio.transactions || [],
    state.portfolio.corporate_actions || [],
    state.portfolio.dividends || [],
    state.portfolio.withholding_tax || [],
  );
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
  const parts = [p.broker];
  if (p.account_holder) parts.push(p.account_holder);
  if (p.account) parts.push(`účet ${p.account}`);
  if (p.customer_type) parts.push(p.customer_type);
  if (p._placeholder) {
    parts.push("⏳ data se připravují");
  } else {
    parts.push(`${(p.transactions || []).length} transakcí`);
    if (p.period_from && p.period_to) {
      parts.push(`období ${p.period_from} – ${p.period_to}`);
    }
  }
  document.getElementById("portfolio-meta").textContent = parts.join(" · ");
  document.title = `${p.name} — Akcie tracker`;
}

// ---------- Tabs ----------
function setupTabs() {
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
    });
  });
}

function setupRefresh() {
  document.getElementById("btn-refresh").addEventListener("click", () => {
    refreshQuotes().catch((err) => showError(err.message));
  });
  document.getElementById("btn-export-xlsx").addEventListener("click", () => {
    exportCurrentViewXlsx();
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
          rule.threshold_pct = parseFloat(fd.get("rule_threshold"));
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
        r.threshold_pct = parseFloat(row.querySelector(".rule-threshold").value);
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
document.addEventListener("click", async (e) => {
  const t = e.target;
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
          const met = change != null && change <= r.threshold_pct;
          return `<span class="${met ? "neg" : "muted"}">pokles ≥ ${Math.abs(r.threshold_pct)}% od ${fmtNum(r.ref_price, 2)} (${change != null ? fmtPct(change) : "?"})</span>`;
        }
        return `<span class="muted">${escapeHtml(r.type)}</span>`;
      })
      .join(" · ");

    const anyMet = rules.some((r) => {
      if (price == null) return false;
      if (r.type === "price_below") return price < r.value;
      if (r.type === "price_above") return price > r.value;
      if (r.type === "drop_pct" && r.ref_price)
        return ((price - r.ref_price) / r.ref_price) * 100 <= r.threshold_pct;
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
      <td class="symbol">${it.symbol}</td>
      <td>${escapeHtml(it.name || quote.name || "")}</td>
      <td>${ccy}</td>
      <td class="num">${price != null ? fmtNum(price, 2) : '<span class="muted">—</span>'}</td>
      <td class="num">${benchmarkCell}</td>
      <td class="num">${deltaCell}</td>
      <td>${rulesHtml || '<span class="muted">žádné pravidlo</span>'}</td>
      <td>${anyMet ? '<span class="badge sell">SPLNĚNO</span>' : '<span class="muted">armed</span>'}</td>
      <td>
        <button class="btn-action" data-watch-mark="${it.id}" data-current-price="${price ?? ''}" title="Uloží aktuální cenu jako referenční bod, ke kterému se bude počítat změna" ${markDisabled}>
          ${markLabel}
        </button>
        ${hasBench ? `<button class="btn-action" data-watch-unmark="${it.id}" title="Zrušit označenou cenu">Zrušit značku</button>` : ""}
        <button class="btn-action" data-watch-edit="${it.id}">Upravit pravidla</button>
        <button class="btn-action danger" data-watch-delete="${it.id}">Smazat</button>
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
      if (change <= rule.threshold_pct) {
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
        if (change <= rule.threshold_pct) {
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
function getFxToCzk(date, currency) {
  if (currency === "CZK") return 1;
  const fx = state.fxRates;
  if (!fx || !fx.dates) return null;
  const day = fx.dates[date];
  if (!day || !day.rates) return null;
  const r = day.rates[currency];
  if (!r) return null;
  // rate je za `amount` jednotek měny
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
    const totalPnl = pos.realized_pnl + u.value;
    const totalPct =
      pos.total_invested > 0 ? (totalPnl / pos.total_invested) * 100 : 0;

    rows.push({
      sym,
      inst,
      pos,
      currentPrice,
      hasPrice,
      marketValue: u.market_value,
      totalPnl,
      totalPct,
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
      <td class="symbol">${r.sym}</td>
      <td>${escapeHtml(r.inst.name)}</td>
      <td>${r.inst.exchange}</td>
      <td>${r.inst.currency}</td>
      <td class="num">${fmtNum(r.pos.net_qty, 0)}</td>
      <td class="num">${fmtNum(r.pos.avg_open_price, 4)}</td>
      <td class="num">${r.hasPrice ? fmtNum(r.currentPrice, 2) : '<span class="muted">—</span>'}</td>
      <td class="num">${fmtNum(r.pos.cost_basis, 2)}</td>
      <td class="num">${r.hasPrice ? fmtNum(r.marketValue, 2) : '<span class="muted">—</span>'}</td>
      <td class="num clickable ${signClass(r.totalPnl)}" data-action="expand" title="Klikněte pro detailní rozpad výpočtu">${r.hasPrice ? fmtNum(r.totalPnl, 2) + ' <span class="caret">▾</span>' : '<span class="muted">—</span>'}</td>
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
    html.push(
      `<div class="mini-total">Aktuální cena <strong>${fmtNum(currentPrice, 2)} ${ccy}</strong> → market value <strong>${fmtNum(u.market_value, 2)} ${ccy}</strong> &nbsp;·&nbsp; <strong class="${signClass(u.value)}">Nerealizovaná Z/Z: ${fmtNum(u.value, 2)} ${ccy}</strong></div>`,
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

    html.push(`<div class="detail-section summary">`);
    html.push(`<div>`);
    html.push(
      `<div>Kapitálová Z/Z: <span class="${signClass(capitalPnl)}"><strong>${fmtNum(capitalPnl, 2)} ${ccy}</strong> (${fmtPct(capitalPct)})</span></div>`,
    );
    if (hasDividends && sameCcy) {
      const totalReturn = capitalPnl + pos.net_dividend_local;
      const totalReturnPct =
        pos.total_invested > 0
          ? (totalReturn / pos.total_invested) * 100
          : 0;
      html.push(
        `<div>+ Čistý dividendový výnos: <span class="${signClass(pos.net_dividend_local)}"><strong>${fmtNum(pos.net_dividend_local, 2)} ${ccy}</strong></span></div>`,
      );
      html.push(
        `<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--color-border);">= <strong>TOTAL RETURN</strong>: <span class="${signClass(totalReturn)}"><strong>${fmtNum(totalReturn, 2)} ${ccy}</strong> (${fmtPct(totalReturnPct)})</span></div>`,
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
  // Search filter
  const q = state.searches.dividends;
  const rows = q
    ? allRows.filter((r) => {
        const inst = state.portfolio.instruments[r.symbol] || {};
        const h = `${r.symbol} ${inst.name || ""}`.toLowerCase();
        return h.includes(q);
      })
    : allRows;
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

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="num">${r.date}</td>
      <td class="symbol">${r.symbol}</td>
      <td>${escapeHtml(inst.name || "")}</td>
      <td>${r.country || '<span class="muted">—</span>'}</td>
      <td class="num pos">${fmtNum(r.gross, 2)}</td>
      <td class="num ${r.tax !== 0 ? "neg" : "muted"}">${r.tax !== 0 ? fmtNum(r.tax, 2) : "—"}</td>
      <td class="num pos"><strong>${fmtNum(net, 2)}</strong></td>
      <td>${r.currency}</td>
      <td class="num">${fmtNum(netUsd, 2)}</td>
    `;
    tbody.appendChild(tr);
  }

  // Total v patce
  if (tfoot && rows.length > 0) {
    const totalNetUsd = totalGrossUsd + totalTaxUsd;
    tfoot.innerHTML = `
      <tr>
        <td colspan="4">Celkem (USD ekvivalent)</td>
        <td class="num pos">${fmtNum(totalGrossUsd, 2)}</td>
        <td class="num neg">${fmtNum(totalTaxUsd, 2)}</td>
        <td class="num pos"><strong>${fmtNum(totalNetUsd, 2)}</strong></td>
        <td>USD</td>
        <td class="num"><strong>${fmtNum(totalNetUsd, 2)}</strong></td>
      </tr>
    `;
  }
}

// ---------- Summary ----------
function renderSummary() {
  const p = state.portfolio;
  const symbols = Object.keys(p.instruments);
  const wrap = document.getElementById("summary-cards");
  wrap.innerHTML = "";

  // === 1) Otevřené pozice ===
  const openCount = symbols.filter(
    (s) => state.positions[s] && state.positions[s].net_qty > 0,
  ).length;
  wrap.appendChild(
    card("Otevřené pozice", openCount, `${symbols.length} titulů celkem`),
  );

  // === 2) Cash zůstatek USD ===
  const cashUsd = p.cash_balance?.USD;
  if (cashUsd != null) {
    wrap.appendChild(
      cardHtml(
        `Cash zůstatek · USD`,
        `<span class="${signClass(cashUsd)}">${fmtNum(cashUsd, 2)}</span>`,
        "Aktuální cash na účtu",
      ),
    );
  }

  // Najít nejnovější ČNB datum pro "today's FX"
  const fxDates = state.fxRates?.dates ? Object.keys(state.fxRates.dates).sort() : [];
  const todayFxDate = fxDates[fxDates.length - 1] || null;
  const fxUsdToCzk = todayFxDate ? getFxToCzk(todayFxDate, "USD") : null;

  // Sesbírat data pro agregaci
  let currentValueUsd = 0;
  let capitalPnlUsd = 0;
  let netDividendsUsd = 0;
  let dividendsGrossUsd = 0;
  let dividendsTaxUsd = 0;
  let allPricesAvailable = true;

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
    }
    netDividendsUsd += pos.net_dividend_usd || 0;
    dividendsGrossUsd += pos.dividends_usd || 0;
    dividendsTaxUsd += pos.withholding_usd || 0;
  }

  const totalAssetsUsd = currentValueUsd + (cashUsd || 0);
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

  // === 3) Total Return % od inception (s absolutními čísly v sub) ===
  const totalReturnCzk = fxUsdToCzk ? totalReturnUsd * fxUsdToCzk : null;
  const absLine =
    totalReturnCzk != null
      ? `${fmtNum(totalReturnUsd, 0)} USD ≈ ${fmtNum(totalReturnCzk, 0)} Kč`
      : `${fmtNum(totalReturnUsd, 0)} USD`;
  wrap.appendChild(
    cardHtml(
      `Celkový výnos`,
      `<span class="${signClass(totalReturnPct)}">${fmtPct(totalReturnPct)}</span> <span class="muted">${absLine}</span>`,
      `od ${inception} (${Math.round(daysSince)} dní)`,
    ),
  );

  // === 4) P.a. ===
  wrap.appendChild(
    cardHtml(
      `P.a. (anualizováno)`,
      `<span class="${signClass(paPct)}">${fmtPct(paPct)}</span>`,
      `průměrný roční výnos`,
    ),
  );

  // === 5) YTD % ===
  // YTD = Mark-to-Market YTD (z IBKR snapshot) + dividendy 2026 + interest 2026
  const yearStart = `${today.getFullYear()}-01-01`;
  let ytdDivNet = 0;
  for (const d of p.dividends || []) {
    if (d.date >= yearStart) ytdDivNet += d.amount_usd || 0;
  }
  for (const t of p.withholding_tax || []) {
    if (t.date >= yearStart) ytdDivNet += t.amount_usd || 0;
  }
  let ytdInterest = 0;
  for (const f of p.cash_flows || []) {
    if (f.type === "interest" && f.date >= yearStart) {
      ytdInterest += f.amount;
    }
  }
  const ytdM2m = p.ytd_mark_to_market_usd || 0;
  const ytdPlUsd = ytdM2m + ytdDivNet + ytdInterest;
  const ytdPct =
    totalAssetsUsd > 0 ? (ytdPlUsd / totalAssetsUsd) * 100 : 0;
  // P.a. extrapolace YTD
  const yearStartDt = new Date(yearStart);
  const yearsSoFar = Math.max(
    1 / 365,
    (today.getTime() - yearStartDt.getTime()) / 86400000 / 365.25,
  );
  const ytdPaPct =
    (Math.pow(1 + ytdPct / 100, 1 / yearsSoFar) - 1) * 100;
  wrap.appendChild(
    cardHtml(
      `YTD ${today.getFullYear()}`,
      `<span class="${signClass(ytdPct)}">${fmtPct(ytdPct)}</span> <span class="muted">(p.a. ${fmtPct(ytdPaPct)})</span>`,
      `od ${yearStart} · IBKR snapshot k ${p.statement_period_end || "?"}`,
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
        `<span class="${signClass(netDivCzk)}">${fmtNum(netDivCzk, 0)} Kč</span> <span class="muted">${fmtNum(netDividendsUsd, 0)} USD</span>`,
        `hrubé ${fmtNum(grossDivCzk, 0)} · daň ${fmtNum(taxDivCzk, 0)} Kč`,
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
  d.innerHTML = `
    <div class="label">${escapeHtml(label)}</div>
    <div class="value">${valueHtml}</div>
    ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}
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

    // FX přepočet
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
    for (const b of buys) {
      html += `
        <tr class="buy">
          <td>${b.date}</td>
          <td class="num">${fmtNum(b.qty, 0)}</td>
          <td class="num">${fmtNum(b.total, 2)}</td>
          <td class="num">${b.fx != null ? fmtNum(b.fx, 4) : '<span class="missing-fx">chybí kurz</span>'}</td>
          <td class="num">${b.czk != null ? fmtNum(b.czk, 2) : '<span class="missing-fx">—</span>'}</td>
          <td class="muted">nákup</td>
        </tr>
      `;
    }
    html += `
      <tr class="subtotal">
        <td colspan="4" class="label" style="text-align:right;">Celkem nákup (CZK):</td>
        <td class="num"><strong>${allFxFound ? fmtNum(costCzk, 2) : '<span class="missing-fx">—</span>'}</strong></td>
        <td></td>
      </tr>
      <tr class="sell">
        <td>${ev.sell_date}</td>
        <td class="num">${fmtNum(ev.sell_qty, 0)}</td>
        <td class="num">${fmtNum(ev.sell_net_total, 2)}</td>
        <td class="num">${sellFx != null ? fmtNum(sellFx, 4) : '<span class="missing-fx">chybí kurz</span>'}</td>
        <td class="num">${sellCzk != null ? fmtNum(sellCzk, 2) : '<span class="missing-fx">—</span>'}</td>
        <td class="muted">prodej</td>
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
    "Kusů", "Ø nákup", "Aktuální", "Nákupní cena pozice",
    "Hodnota pozice", "Zisk/Ztráta", "%",
  ];
  const data = rows.map((r) => [
    r.sym, r.inst.name, r.inst.exchange, r.inst.currency,
    r.pos.net_qty, r.pos.avg_open_price,
    r.hasPrice ? r.currentPrice : null,
    r.pos.cost_basis,
    r.hasPrice ? r.marketValue : null,
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

function buildTransactionsAoa() {
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
  txs = txs.sort((a, b) =>
    `${b.date} ${b.time || ""}`.localeCompare(`${a.date} ${a.time || ""}`),
  );
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
  const q = state.searches.dividends;
  if (q) {
    arr = arr.filter((r) => {
      const inst = state.portfolio.instruments[r.symbol] || {};
      const h = `${r.symbol} ${inst.name || ""}`.toLowerCase();
      return h.includes(q);
    });
  }
  const header = [
    "Datum", "Symbol", "Název", "Země zdroje",
    "Hrubá", "Daň u zdroje", "Net", "Měna", "Net USD ekv.",
  ];
  const data = arr.map((r) => {
    const inst = state.portfolio.instruments[r.symbol] || {};
    return [
      r.date, r.symbol, inst.name || "", r.country || "",
      r.gross, r.tax, r.gross + r.tax, r.currency, r.gross_usd + r.tax_usd,
    ];
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

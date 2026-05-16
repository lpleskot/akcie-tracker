import {
  computePositions,
  unrealizedPnl,
  fmtNum,
  fmtPct,
  fmtMoney,
} from "./fifo.js";

const PORTFOLIO_URL = "./data/portfolios/plegi-invest-ibkr.json";
const QUOTE_URL = "/api/quote";

const state = {
  portfolio: null,
  positions: null,
  quotes: {},
  view: "overview",
  sort: { key: "sym", dir: "asc" },
};

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
  setStatus("Načítám portfolio…");

  // 1) Load portfolio JSON
  const res = await fetch(PORTFOLIO_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Portfolio JSON ${res.status}`);
  state.portfolio = await res.json();

  // 2) Compute FIFO positions
  state.positions = computePositions(state.portfolio.transactions);

  // 3) Render header
  renderHeader();
  setupTabs();
  setupRefresh();
  setupSort();

  // 4) Fetch live quotes
  await refreshQuotes();
}

// ---------- Header ----------
function renderHeader() {
  const p = state.portfolio;
  document.getElementById("portfolio-name").textContent = p.name;
  document.getElementById("portfolio-meta").textContent =
    `${p.broker} · účet ${p.account} · ${p.transactions.length} transakcí · období ${p.period_from} – ${p.period_to}`;
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
  document.getElementById("btn-export-csv").addEventListener("click", () => {
    exportTransactionsCsv();
  });
}

function setupSort() {
  document.querySelectorAll("#tbl-overview th.sortable").forEach((th) => {
    th.addEventListener("click", (e) => {
      // Klik na "?" tooltip nemá triggerovat sort
      if (e.target.classList.contains("hint")) return;
      const key = th.dataset.sortKey;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort.key = key;
        state.sort.dir = "asc";
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

  setStatus(null);
  renderOverview();
  renderTransactions();
  renderSummary();
}

// ---------- Overview ----------
function renderOverview() {
  const tbody = document.querySelector("#tbl-overview tbody");
  tbody.innerHTML = "";

  // 1) Sesbírat řádky s vypočtenými hodnotami
  const rows = [];
  for (const sym of Object.keys(state.portfolio.instruments)) {
    const inst = state.portfolio.instruments[sym];
    const pos = state.positions[sym];
    if (!pos || pos.net_qty === 0) continue;

    const q = state.quotes[inst.yahoo_symbol] || {};
    const currentPrice = q.price;
    const hasPrice = currentPrice != null && !q.error;
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

  // 4) Vykreslit
  for (const r of rows) {
    const tr = document.createElement("tr");
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
      <td class="num ${signClass(r.totalPnl)}">${r.hasPrice ? fmtNum(r.totalPnl, 2) : '<span class="muted">—</span>'}</td>
      <td class="num ${signClass(r.totalPct)}">${r.hasPrice ? fmtPct(r.totalPct) : '<span class="muted">—</span>'}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ---------- Transactions ----------
function renderTransactions() {
  const tbody = document.querySelector("#tbl-transactions tbody");
  tbody.innerHTML = "";

  const txs = [...state.portfolio.transactions];
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

// ---------- Summary ----------
function renderSummary() {
  const symbols = Object.keys(state.portfolio.instruments);

  // Per-currency totals
  const byCcy = {};

  for (const sym of symbols) {
    const inst = state.portfolio.instruments[sym];
    const pos = state.positions[sym];
    if (!pos) continue;

    const ccy = inst.currency;
    if (!byCcy[ccy]) {
      byCcy[ccy] = {
        invested: 0,
        market: 0,
        realized: 0,
        unrealized: 0,
      };
    }

    const q = state.quotes[inst.yahoo_symbol] || {};
    byCcy[ccy].invested += pos.total_invested;
    byCcy[ccy].realized += pos.realized_pnl;
    if (q.price != null) {
      const market = pos.net_qty * q.price;
      byCcy[ccy].market += market;
      byCcy[ccy].unrealized += market - pos.cost_basis;
    }
  }

  const wrap = document.getElementById("summary-cards");
  wrap.innerHTML = "";

  // Card 1: počet otevřených pozic
  const openCount = symbols.filter(
    (s) => state.positions[s] && state.positions[s].net_qty > 0,
  ).length;
  wrap.appendChild(card("Otevřené pozice", openCount, `${symbols.length} titulů celkem`));

  // Cards per currency — total Zisk/Ztráta
  for (const ccy of Object.keys(byCcy).sort()) {
    const c = byCcy[ccy];
    const totalPnl = c.realized + c.unrealized;
    const pct = c.invested > 0 ? (totalPnl / c.invested) * 100 : 0;

    const subParts = [];
    if (c.realized !== 0) {
      subParts.push(`realizováno ${fmtNum(c.realized, 0)} ${ccy}`);
    }
    if (c.unrealized !== 0) {
      subParts.push(`otevřené ${fmtNum(c.unrealized, 0)} ${ccy}`);
    }
    const sub = subParts.length
      ? subParts.join(" · ")
      : `investováno ${fmtNum(c.invested, 0)} ${ccy}`;

    const valueHtml = `<span class="${signClass(totalPnl)}">${fmtNum(totalPnl, 0)} ${ccy}</span> <span class="muted">(${fmtPct(pct)})</span>`;
    wrap.appendChild(cardHtml(`Zisk/Ztráta · ${ccy}`, valueHtml, sub));
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

// ---------- CSV export ----------
function exportTransactionsCsv() {
  const rows = [
    [
      "Datum",
      "Čas",
      "Symbol",
      "Název",
      "ISIN",
      "Burza",
      "Měna",
      "Typ",
      "Množství",
      "Cena",
      "Hodnota",
      "Komise",
    ],
  ];
  for (const t of state.portfolio.transactions) {
    const inst = state.portfolio.instruments[t.symbol];
    rows.push([
      t.date,
      t.time,
      t.symbol,
      inst.name,
      inst.isin,
      inst.exchange,
      inst.currency,
      t.type,
      Math.abs(t.quantity),
      t.price,
      t.proceeds,
      t.commission,
    ]);
  }
  const csv = rows
    .map((r) =>
      r
        .map((v) => {
          const s = String(v ?? "");
          return s.includes(",") || s.includes('"') || s.includes("\n")
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        })
        .join(","),
    )
    .join("\n");

  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.portfolio.id}-transakce-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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

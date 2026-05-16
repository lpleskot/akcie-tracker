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

  const symbols = Object.keys(state.portfolio.instruments).sort();
  for (const sym of symbols) {
    const inst = state.portfolio.instruments[sym];
    const pos = state.positions[sym];
    if (!pos || pos.net_qty === 0) continue; // skip closed positions

    const q = state.quotes[inst.yahoo_symbol] || {};
    const currentPrice = q.price;
    const previousClose = q.previous_close;

    const u = unrealizedPnl(pos, currentPrice);
    const dayChangePct =
      currentPrice != null && previousClose
        ? ((currentPrice - previousClose) / previousClose) * 100
        : null;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="symbol">${sym}</td>
      <td>${escapeHtml(inst.name)}</td>
      <td>${inst.exchange}</td>
      <td>${inst.currency}</td>
      <td class="num">${fmtNum(pos.net_qty, 0)}</td>
      <td class="num">${fmtNum(pos.avg_open_price, 4)}</td>
      <td class="num">${fmtNum(pos.cost_basis, 2)}</td>
      <td class="num">${q.error ? '<span class="muted">err</span>' : fmtNum(currentPrice, 2)}</td>
      <td class="num ${signClass(dayChangePct)}">${fmtPct(dayChangePct)}</td>
      <td class="num">${fmtNum(u.market_value, 2)}</td>
      <td class="num ${signClass(u.value)}">${fmtNum(u.value, 2)}</td>
      <td class="num ${signClass(u.pct)}">${fmtPct(u.pct)}</td>
      <td class="num ${signClass(pos.realized_pnl)}">${pos.realized_pnl !== 0 ? fmtNum(pos.realized_pnl, 2) : '<span class="muted">—</span>'}</td>
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
  let totalRealizedByCcy = {};

  for (const sym of symbols) {
    const inst = state.portfolio.instruments[sym];
    const pos = state.positions[sym];
    if (!pos) continue;

    const ccy = inst.currency;
    if (!byCcy[ccy]) byCcy[ccy] = { cost: 0, market: 0, unrealized: 0 };
    if (!totalRealizedByCcy[ccy]) totalRealizedByCcy[ccy] = 0;

    const q = state.quotes[inst.yahoo_symbol] || {};
    byCcy[ccy].cost += pos.cost_basis;
    if (q.price != null) {
      byCcy[ccy].market += pos.net_qty * q.price;
    }
    totalRealizedByCcy[ccy] += pos.realized_pnl;
  }

  for (const ccy in byCcy) {
    byCcy[ccy].unrealized = byCcy[ccy].market - byCcy[ccy].cost;
  }

  const wrap = document.getElementById("summary-cards");
  wrap.innerHTML = "";

  // Card 1: počet otevřených pozic
  const openCount = symbols.filter(
    (s) => state.positions[s] && state.positions[s].net_qty > 0,
  ).length;
  wrap.appendChild(card("Otevřené pozice", openCount, `${symbols.length} titulů celkem`));

  // Cards per currency
  for (const ccy of Object.keys(byCcy).sort()) {
    const c = byCcy[ccy];
    const pct = c.cost > 0 ? (c.unrealized / c.cost) * 100 : 0;
    const sub = `${fmtNum(c.market, 0)} ${ccy} aktuálně · cost ${fmtNum(c.cost, 0)} ${ccy}`;
    const valueHtml = `<span class="${signClass(c.unrealized)}">${fmtNum(c.unrealized, 0)} ${ccy}</span> <span class="muted">(${fmtPct(pct)})</span>`;
    wrap.appendChild(cardHtml(`Nerealiz. P/L · ${ccy}`, valueHtml, sub));
  }

  // Realized P/L cards
  for (const ccy of Object.keys(totalRealizedByCcy).sort()) {
    if (totalRealizedByCcy[ccy] === 0) continue;
    const r = totalRealizedByCcy[ccy];
    wrap.appendChild(
      cardHtml(
        `Realizovaná P/L · ${ccy}`,
        `<span class="${signClass(r)}">${fmtNum(r, 0)} ${ccy}</span>`,
        "Z uzavřených prodejů",
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

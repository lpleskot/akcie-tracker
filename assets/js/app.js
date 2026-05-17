import {
  computePositions,
  unrealizedPnl,
  fmtNum,
  fmtPct,
  fmtMoney,
} from "./fifo.js";

const PORTFOLIO_URL = "./data/portfolios/plegi-invest-ibkr.json";
const FX_URL = "./data/fx_rates.json";
const QUOTE_URL = "/api/quote";

const state = {
  portfolio: null,
  positions: null,
  quotes: {},
  fxRates: null,
  view: "overview",
  sort: { key: "sym", dir: "asc" },
  txFilter: { from: null, to: null },
  reportFilter: { from: null, to: null },
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

  // 1) Load portfolio JSON + FX rates (paralelně)
  const [portfolioRes, fxRes] = await Promise.all([
    fetch(PORTFOLIO_URL, { cache: "no-cache" }),
    fetch(FX_URL, { cache: "no-cache" }),
  ]);
  if (!portfolioRes.ok) throw new Error(`Portfolio JSON ${portfolioRes.status}`);
  state.portfolio = await portfolioRes.json();
  if (fxRes.ok) {
    state.fxRates = await fxRes.json();
  } else {
    console.warn("FX rates nedostupné — report v CZK nebude přesný");
    state.fxRates = { dates: {} };
  }

  // 2) Compute FIFO positions (vč. corp. actions, dividend a withholding tax)
  state.positions = computePositions(
    state.portfolio.transactions,
    state.portfolio.corporate_actions || [],
    state.portfolio.dividends || [],
    state.portfolio.withholding_tax || [],
  );

  // 3) Render header
  renderHeader();
  setupTabs();
  setupRefresh();
  setupSort();
  setupExpand();
  setupTxFilter();
  setupReportFilter();

  // 4) Fetch live quotes
  await refreshQuotes();
}

// ---------- Header ----------
function renderHeader() {
  const p = state.portfolio;
  document.getElementById("portfolio-name").textContent = p.name;
  const parts = [p.broker];
  if (p.account_holder) parts.push(p.account_holder);
  parts.push(`účet ${p.account}`);
  if (p.customer_type) parts.push(p.customer_type);
  parts.push(`${p.transactions.length} transakcí`);
  parts.push(`období ${p.period_from} – ${p.period_to}`);
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
  document.getElementById("btn-export-csv").addEventListener("click", () => {
    exportTransactionsCsv();
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

  setStatus(null);
  renderOverview();
  renderTransactions();
  renderDividends();
  renderReport();
  renderSummary();
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
  let txs = state.portfolio.transactions.filter((t) => {
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
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
  const rows = [...events.values()].sort((a, b) =>
    b.date.localeCompare(a.date),
  );

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
  const symbols = Object.keys(state.portfolio.instruments);

  // Per-currency capital P/L
  const byCcy = {};
  // Per-currency net dividend (gross dividends + withholding tax, where tax is negative)
  const divByCcy = {};

  for (const sym of symbols) {
    const inst = state.portfolio.instruments[sym];
    const pos = state.positions[sym];
    if (!pos) continue;

    const ccy = inst.currency;
    if (!byCcy[ccy]) {
      byCcy[ccy] = { invested: 0, market: 0, realized: 0, unrealized: 0 };
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

  // Dividend totals per měnu výplaty (v původní měně)
  for (const dRec of state.portfolio.dividends || []) {
    const c = dRec.currency;
    if (!divByCcy[c]) divByCcy[c] = { gross: 0, tax: 0 };
    divByCcy[c].gross += dRec.amount;
  }
  for (const t of state.portfolio.withholding_tax || []) {
    const c = t.currency;
    if (!divByCcy[c]) divByCcy[c] = { gross: 0, tax: 0 };
    divByCcy[c].tax += t.amount;
  }

  const wrap = document.getElementById("summary-cards");
  wrap.innerHTML = "";

  // Otevřené pozice
  const openCount = symbols.filter(
    (s) => state.positions[s] && state.positions[s].net_qty > 0,
  ).length;
  wrap.appendChild(
    card("Otevřené pozice", openCount, `${symbols.length} titulů celkem`),
  );

  // Cash zůstatek
  const cb = state.portfolio.cash_balance || {};
  for (const ccy of Object.keys(cb).sort()) {
    if (cb[ccy] == null) continue;
    wrap.appendChild(
      cardHtml(
        `Cash zůstatek · ${ccy}`,
        `<span class="${signClass(cb[ccy])}">${fmtNum(cb[ccy], 2)} ${ccy}</span>`,
        "Aktuální cash na účtu",
      ),
    );
  }

  // Zisk/Ztráta (kapitálová) per měnu
  for (const ccy of Object.keys(byCcy).sort()) {
    const c = byCcy[ccy];
    const totalPnl = c.realized + c.unrealized;
    const pct = c.invested > 0 ? (totalPnl / c.invested) * 100 : 0;
    const subParts = [];
    if (c.realized !== 0)
      subParts.push(`realizováno ${fmtNum(c.realized, 0)} ${ccy}`);
    if (c.unrealized !== 0)
      subParts.push(`otevřené ${fmtNum(c.unrealized, 0)} ${ccy}`);
    const sub = subParts.length
      ? subParts.join(" · ")
      : `investováno ${fmtNum(c.invested, 0)} ${ccy}`;
    const valueHtml = `<span class="${signClass(totalPnl)}">${fmtNum(totalPnl, 0)} ${ccy}</span> <span class="muted">(${fmtPct(pct)})</span>`;
    wrap.appendChild(cardHtml(`Zisk/Ztráta · ${ccy}`, valueHtml, sub));
  }

  // Dividendy (po dani) per měnu
  for (const ccy of Object.keys(divByCcy).sort()) {
    const div = divByCcy[ccy];
    const net = div.gross + div.tax;
    if (net === 0 && div.gross === 0) continue;
    const valueHtml = `<span class="${signClass(net)}">${fmtNum(net, 2)} ${ccy}</span>`;
    const sub = `${fmtNum(div.gross, 2)} hrubé · daň ${fmtNum(div.tax, 2)}`;
    wrap.appendChild(cardHtml(`Dividendy (po dani) · ${ccy}`, valueHtml, sub));
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

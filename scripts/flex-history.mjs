#!/usr/bin/env node
/**
 * Historie účtu z ročních výpisů IB Flex (XML) → statický portfolio JSON
 * a NAV backfill pro graf Hodnota portfolia. Jednorázově při napojení účtu
 * u IB nebo LYNX; dál data doplňuje denní flex-import do KV overlay.
 *
 * Jde stejnou cestou jako denní import: parser a dedupe z flex-import.js,
 * transformace a hotovost z mergeOverlayIntoPortfolio. Záznamy proto nesou
 * flex_id a pozdější overlay je nezdvojí.
 *
 * Před zápisem ověří proti výpisu IB: hotovost po měnách = Cash Report na
 * konci posledního výpisu, pozice = Open Positions. Nesedí-li, nic nezapíše.
 *
 * --seed: portfolio, jehož instrumenty se převezmou, když je IB ve výpisech
 * vede pod jiným symbolem (stejné ISIN a měna) — Evolution je ve firemním
 * IBKR „EVO", Lynx ho vede jako „EVOs" a později „EVOG.ST".
 *
 * Spouští se z repo rootu:
 *   node scripts/flex-history.mjs ../podklady/lynx --id lukas-pleskot-lynx \
 *     --name "Lukáš Pleskot Lynx" --broker "LYNX (Interactive Brokers)" \
 *     --seed data/portfolios/plegi-invest-ibkr.json
 * Před ním (a po přidání nových dnů znovu) node scripts/fx-backfill.mjs —
 * vklady se přepočítávají do USD kurzem ke dni vkladu.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { emptyOverlay, mergeOverlay, parseElements, parseFlexXml } from "../worker/jobs/flex-import.js";
import { mergeOverlayIntoPortfolio } from "../assets/js/portfolio-shared.js";
import { flexDate, symbolByIsin } from "../assets/js/flex-shared.js";
import { computePositions } from "../assets/js/fifo.js";

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: "string" },
    name: { type: "string" },
    broker: { type: "string" },
    seed: { type: "string", multiple: true },
  },
});
const dir = positionals[0];
if (!dir || !opt.id || !opt.name || !opt.broker) {
  console.error("Použití: node scripts/flex-history.mjs <složka s XML> --id <id> --name <název> --broker <broker> [--seed <portfolio.json>]");
  process.exit(1);
}

// Výpisy chronologicky — Open Positions a M2M v overlay jsou z posledního
const statements = readdirSync(dir)
  .filter((f) => f.endsWith(".xml"))
  .map((f) => {
    const xml = readFileSync(join(dir, f), "utf-8");
    const [st] = parseElements(xml, "FlexStatement", ["accountId", "fromDate", "toDate"]);
    if (!st) throw new Error(`${f}: není Flex výpis (chybí FlexStatement)`);
    return { file: f, xml, ...st };
  })
  .sort((a, b) => a.fromDate.localeCompare(b.fromDate));
if (!statements.length) throw new Error(`${dir}: žádné XML`);
const accounts = new Set(statements.map((s) => s.accountId));
if (accounts.size !== 1) throw new Error(`Výpisy jsou z více účtů (${[...accounts].join(", ")}) – jedno portfolio = jeden účet`);
const first = statements[0];
const last = statements.at(-1);

let overlay = emptyOverlay();
for (const s of statements) overlay = mergeOverlay(overlay, parseFlexXml(s.xml)).merged;

const [acct] = parseElements(last.xml, "AccountInformation", [
  "accountId", "currency", "name", "accountType", "customerType", "dateOpened", "dateFunded",
]);

// Instrumenty z --seed jen pro tituly, které IB vede pod jiným symbolem
const instruments = {};
const flexRows = [...overlay.trades, ...overlay.cash_transactions, ...overlay.corporate_actions, ...overlay.open_positions_snapshot];
for (const f of opt.seed || []) {
  for (const [sym, inst] of Object.entries(JSON.parse(readFileSync(f, "utf-8")).instruments || {})) {
    const rows = flexRows.filter((r) => r.isin && r.isin === inst.isin && r.currency === inst.currency);
    if (rows.length && rows.some((r) => r.symbol !== sym) && !instruments[sym]) {
      const { _auto_added, ...clean } = inst;
      instruments[sym] = clean;
    }
  }
}

const portfolio = {
  id: opt.id,
  name: opt.name,
  broker: opt.broker,
  account: acct.accountId,
  account_holder: acct.name,
  account_type: acct.accountType,
  customer_type: acct.customerType,
  base_currency: acct.currency,
  inception_date: flexDate(acct.dateFunded || acct.dateOpened),
  period_from: flexDate(first.fromDate),
  period_to: flexDate(last.toDate),
  statement_period_end: flexDate(last.toDate),
  source_file: `podklady/${basename(dir)}/*.xml – IB Flex Activity, výpisy po letech`,
  instruments,
  transactions: [],
  corporate_actions: [],
  dividends: [],
  withholding_tax: [],
  cash_flows: [],
  cash_balance: {},
};
const fxRates = JSON.parse(readFileSync("data/fx_rates.json", "utf-8"));
mergeOverlayIntoPortfolio(portfolio, overlay, fxRates);
const nav = portfolio.nav_history;
delete portfolio.nav_history;

// ---------- Kontrola proti výpisu IB ----------
const problems = [];
const reportCash = Object.fromEntries(
  parseElements(last.xml, "CashReportCurrency", ["currency", "endingCash"])
    .filter((r) => r.currency !== "BASE_SUMMARY")
    .map((r) => [r.currency, parseFloat(r.endingCash)]),
);
for (const ccy of new Set([...Object.keys(reportCash), ...Object.keys(portfolio.cash_balance)])) {
  const diff = (portfolio.cash_balance[ccy] || 0) - (reportCash[ccy] || 0);
  if (Math.abs(diff) > 0.01) problems.push(`hotovost ${ccy}: spočteno ${portfolio.cash_balance[ccy]}, IB ${reportCash[ccy]}`);
}
const positions = computePositions(portfolio.transactions, portfolio.corporate_actions, portfolio.dividends, portfolio.withholding_tax);
const held = Object.fromEntries(Object.entries(positions).filter(([, p]) => p.net_qty > 1e-9).map(([s, p]) => [s, p.net_qty]));
const ibHeld = {};
for (const r of overlay.open_positions_snapshot) {
  const sym = symbolByIsin(portfolio.instruments, r);
  ibHeld[sym] = (ibHeld[sym] || 0) + parseFloat(r.position);
}
for (const sym of new Set([...Object.keys(held), ...Object.keys(ibHeld)])) {
  if (Math.abs((held[sym] || 0) - (ibHeld[sym] || 0)) > 1e-6) problems.push(`pozice ${sym}: FIFO ${held[sym] || 0} ks, IB ${ibHeld[sym] || 0} ks`);
}
if (problems.length) {
  console.error(`❌ Nesedí s výpisem IB k ${portfolio.period_to}, nic se nezapsalo:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

// Prach po konverzích (IB drží zbytky jako 0,0003 HKD) by v appce chtěl kurz
// měny, kterou účet už nepoužívá
portfolio.cash_balance = Object.fromEntries(
  Object.entries(portfolio.cash_balance)
    .filter(([, v]) => Math.abs(v) >= 0.005)
    .sort(([a], [b]) => a.localeCompare(b)),
);

const round2 = (v) => Math.round(parseFloat(v) * 100) / 100;
const startIdx = nav.findIndex((n) => parseFloat(n.total) !== 0);
const history = {
  schema_version: 1,
  portfolio_id: opt.id,
  source: `IB Flex Activity – denní NAV z výpisů po letech (${statements.length} souborů)`,
  generated_at: new Date().toISOString(),
  inception_date: portfolio.inception_date,
  nav_history: nav.slice(Math.max(0, startIdx)).map((n) => ({
    reportDate: n.reportDate,
    currency: n.currency,
    cash: round2(n.cash),
    stock: round2(n.stock),
    total: round2(n.total),
  })),
};

const portfolioFile = `data/portfolios/${opt.id}.json`;
const historyFile = `data/portfolio-history-${opt.id}.json`;
writeFileSync(portfolioFile, JSON.stringify(portfolio, null, 2) + "\n", "utf-8");
writeFileSync(historyFile, JSON.stringify(history, null, 2) + "\n", "utf-8");
console.log(
  `✅ ${portfolioFile}: ${portfolio.transactions.length} obchodů, ${portfolio.dividends.length} dividend, ` +
    `${portfolio.withholding_tax.length} srážek, ${portfolio.cash_flows.length} pohybů hotovosti, ` +
    `${portfolio.corporate_actions.length} corporate actions, ${Object.keys(held).length} držených titulů – ` +
    `hotovost a pozice sedí s IB k ${portfolio.period_to}`,
);
console.log(`✅ ${historyFile}: ${history.nav_history.length} dní NAV (${history.nav_history[0]?.reportDate}–${history.nav_history.at(-1)?.reportDate})`);

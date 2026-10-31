#!/usr/bin/env node
/**
 * Doplní do data/fx_rates.json kurzy ČNB pro dny, které potřebuje portfolio
 * se starší historií (Lynx od 2021, kurzy jinak začínají 30. 12. 2022).
 *
 * Bere dny ze záznamů portfolia (obchody vč. vypořádání, dividendy, daně,
 * pohyby hotovosti, corporate actions). Chybějící den stáhne celý; u dne, který
 * už v kurzech je, jen doplní chybějící měnu záznamu — ostatní kurzy nemění,
 * aby se nehnula čísla firemních portfolií. Víkendy a svátky ČNB nevyhlašuje,
 * ty se přeskočí (výpočty pak berou poslední předchozí den).
 *
 * Spouští se z repo rootu: node scripts/fx-backfill.mjs data/portfolios/<soubor>.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fetchCnbDay } from "./cnb.mjs";

const FILE = "data/fx_rates.json";
const files = process.argv.slice(2);
if (!files.length) {
  console.error("Použití: node scripts/fx-backfill.mjs data/portfolios/<soubor>.json …");
  process.exit(1);
}

// den → měny, které na ten den záznamy portfolia potřebují (USD vždy — přepočty do USD)
const need = new Map();
const want = (date, currency) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return;
  if (!need.has(date)) need.set(date, new Set(["USD"]));
  if (currency && currency !== "CZK") need.get(date).add(currency);
};
for (const f of files) {
  const p = JSON.parse(readFileSync(f, "utf-8"));
  const ccyOf = (r) => r.currency || p.instruments?.[r.symbol]?.currency;
  for (const t of p.transactions || []) {
    want(t.date, ccyOf(t));
    want(t.settle_date, ccyOf(t));
  }
  for (const r of [...(p.dividends || []), ...(p.withholding_tax || []), ...(p.cash_flows || []), ...(p.corporate_actions || [])]) {
    want(r.date, ccyOf(r));
  }
}

const data = JSON.parse(readFileSync(FILE, "utf-8"));
let added = 0;
let completed = 0;
let skipped = 0;
for (const date of [...need.keys()].sort()) {
  const have = data.dates[date];
  const missing = [...need.get(date)].filter((c) => !have?.rates?.[c]);
  if (!missing.length) continue;
  const entry = await fetchCnbDay(date);
  if (!entry) {
    skipped++;
    continue;
  }
  if (!have) {
    data.dates[date] = entry;
    added++;
  } else {
    for (const c of missing) if (entry.rates[c]) have.rates[c] = entry.rates[c];
    completed++;
  }
}

// Dny chronologicky — fx-update přidává nové dny na konec
data.dates = Object.fromEntries(Object.entries(data.dates).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
console.log(`✅ ${FILE}: +${added} dnů, doplněná měna u ${completed} dnů, ${skipped} dnů bez kurzu (víkend/svátek)`);

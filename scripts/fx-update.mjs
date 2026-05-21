#!/usr/bin/env node
/**
 * Daily ČNB FX rate fetcher.
 *
 * Stáhne kurzy ČNB pro všechny dny od posledního záznamu v
 * fx_rates.json až do dneška (UTC). Víkendy a svátky (kdy
 * ČNB kurzy nevyhlašuje) se přeskočí. Výstup zapíše zpět
 * do data/fx_rates.json — workflow pak změnu commitne.
 *
 * Spouští se z repo rootu: node scripts/fx-update.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";

const FILE = "data/fx_rates.json";
const CNB_API = "https://api.cnb.cz/cnbapi/exrates/daily";
const CURRENCIES = [
  "CAD", "DKK", "EUR", "JPY", "NOK", "PLN", "SEK", "CHF",
  "GBP", "USD", "AUD", "HUF",
];

const data = JSON.parse(readFileSync(FILE, "utf-8"));
data.dates = data.dates || {};

// Najít poslední datum v JSON a začít den po něm
const existing = Object.keys(data.dates).sort();
const lastDate = existing[existing.length - 1] || "2022-12-30";
const startDate = nextDay(lastDate);
const today = new Date().toISOString().slice(0, 10);

console.log(`📊 ČNB FX update — last in JSON: ${lastDate}, fetching from ${startDate} to ${today}`);

let added = 0;
let skipped = 0;
let failed = 0;

let d = startDate;
while (d <= today) {
  const url = `${CNB_API}?date=${d}&lang=CS`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "akcie-tracker-fx-update/1.0" },
    });
    if (!res.ok) {
      console.log(`   ${d}: HTTP ${res.status} (přeskakuji)`);
      failed++;
      d = nextDay(d);
      continue;
    }
    const payload = await res.json();
    const rates = payload?.rates || [];
    if (rates.length === 0) {
      console.log(`   ${d}: žádné kurzy (víkend/svátek)`);
      skipped++;
      d = nextDay(d);
      continue;
    }
    const validFor = payload?.validFor || d;
    const entry = { valid_for: validFor, rates: {} };
    for (const r of rates) {
      const code = r.currencyCode;
      if (CURRENCIES.includes(code)) {
        entry.rates[code] = { rate: r.rate, amount: r.amount ?? 1 };
      }
    }
    if (Object.keys(entry.rates).length === 0) {
      console.log(`   ${d}: žádná z požadovaných měn`);
      skipped++;
    } else {
      data.dates[d] = entry;
      added++;
      console.log(
        `   ${d}: ✓ valid_for ${validFor}, ${Object.keys(entry.rates).length} měn`,
      );
    }
  } catch (e) {
    console.log(`   ${d}: chyba ${e.message}`);
    failed++;
  }
  d = nextDay(d);
}

if (added > 0) {
  writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
  console.log(`\n✅ ${FILE} aktualizován: +${added} dnů (skip ${skipped}, fail ${failed})`);
} else {
  console.log(`\nℹ️  Žádné nové dny (skip ${skipped}, fail ${failed})`);
}

function nextDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

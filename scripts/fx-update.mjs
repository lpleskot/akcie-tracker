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
import { fetchCnbDay } from "./cnb.mjs";

const FILE = "data/fx_rates.json";

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
let failedDay = null; // fail-fast: den, na kterém fetch selhal

let d = startDate;
while (d <= today) {
  try {
    const entry = await fetchCnbDay(d);
    if (!entry) {
      console.log(`   ${d}: žádné kurzy (víkend/svátek)`);
      skipped++;
    } else {
      data.dates[d] = entry;
      added++;
      console.log(
        `   ${d}: ✓ valid_for ${entry.valid_for}, ${Object.keys(entry.rates).length} měn`,
      );
    }
  } catch (e) {
    // Fail-fast: NEpokračovat za chybný den. Další běh startuje od max
    // data v JSON — den přeskočený kvůli chybě by v kurzech chyběl navždy
    // a strict getFxToCzk() by pro něj vracel null (daňový report).
    failedDay = `${d}: ${e.message}`;
    break;
  }
  d = nextDay(d);
}

if (added > 0) {
  writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
  console.log(`\n✅ ${FILE} aktualizován: +${added} dnů (skip ${skipped})`);
} else {
  console.log(`\nℹ️  Žádné nové dny (skip ${skipped})`);
}

if (failedDay) {
  // Nenulový exit → workflow zčervená a GitHub pošle notifikaci o selhání.
  // Zameškané dny se doplní při příštím úspěšném běhu (startuje od max data).
  console.error(`\n❌ Fetch selhal (${failedDay}) — končím s chybou.`);
  process.exit(1);
}

function nextDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

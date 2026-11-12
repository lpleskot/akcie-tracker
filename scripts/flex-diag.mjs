// Diagnostika IB Flex z tohoto počítače: co teď Flex Web Service vrací pro Lynx nebo IBKR
// (stav dotazu, období výpisu, dny NAV, datum pozic). Token se zadává skrytě a nikam se
// neukládá; XML výpisu se uloží do ../podklady/<zdroj>/ (mimo git) pro další rozbor.
// Vznikl 12. 11. 2026, když ranní import Lynx z Workeru vracel HTTP 403 a ve dnech, kdy
// prošel, nepřinesl žádný nový den.
//
//   node scripts/flex-diag.mjs lynx
//   node scripts/flex-diag.mjs ibkr
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FLEX_BASE = "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService";
// Stejný User-Agent jako Worker (worker/jobs/flex-import.js), ať se výsledky dají porovnat.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const QUERY_VARS = { lynx: "LYNX_FLEX_QUERY_ID", ibkr: "FLEX_QUERY_ID" };
const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");

const source = process.argv[2];
if (!QUERY_VARS[source]) {
  console.error("Použití: node scripts/flex-diag.mjs lynx|ibkr");
  process.exit(2);
}
const toml = readFileSync(join(WEB, "wrangler.toml"), "utf8");
const queryId = new RegExp(`^${QUERY_VARS[source]}\\s*=\\s*"([^"]+)"`, "m").exec(toml)?.[1];
if (!queryId) {
  console.error(`Ve wrangler.toml chybí ${QUERY_VARS[source]}.`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = (xml, name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? "";

/** Skrytý vstup: znaky se nevypisují (token se vkládá z 1Passwordu). */
function askHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (c === "\u0003") {
          stdin.setRawMode(false);
          stdout.write("\n");
          process.exit(130);
        }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function call(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, text: await res.text() };
}

const token = await askHidden(`Flex token ${source} (vlož, nezobrazí se): `);
if (!token) {
  console.error("Bez tokenu nic.");
  process.exit(2);
}

// 1) SendRequest — 1001/1018 (zaneprázdněno, limit) a 1019 (generuje se) zkusí znovu.
let refCode = "";
for (let attempt = 1; attempt <= 4 && !refCode; attempt++) {
  if (attempt > 1) await sleep(20_000);
  const r = await call(`${FLEX_BASE}.SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`);
  const status = tag(r.text, "Status");
  const code = tag(r.text, "ErrorCode");
  console.log(`SendRequest pokus ${attempt}: HTTP ${r.status}${status ? `, ${status}` : ""}${code ? `, kód ${code}: ${tag(r.text, "ErrorMessage")}` : ""}`);
  if (r.status === 200 && status === "Success") refCode = tag(r.text, "ReferenceCode");
  else if (r.status === 200 && !["1001", "1018", "1019"].includes(code)) break;
}
if (!refCode) process.exit(1);

// 2) GetStatement — dokud se výpis generuje (1019 / „in progress").
let xml = "";
for (let attempt = 1; attempt <= 10 && !xml; attempt++) {
  await sleep(attempt === 1 ? 3_000 : 10_000);
  const r = await call(`${FLEX_BASE}.GetStatement?t=${encodeURIComponent(token)}&q=${encodeURIComponent(refCode)}&v=3`);
  if (r.text.includes("<FlexQueryResponse")) {
    xml = r.text;
    console.log(`GetStatement pokus ${attempt}: HTTP ${r.status}, výpis ${r.text.length.toLocaleString("cs-CZ")} znaků`);
  } else {
    console.log(`GetStatement pokus ${attempt}: HTTP ${r.status}, ${tag(r.text, "Status") || "?"} ${tag(r.text, "ErrorCode")} ${tag(r.text, "ErrorMessage")}`.trim());
    if (r.status !== 200 || !["1019", "1001"].includes(tag(r.text, "ErrorCode"))) break;
  }
}
if (!xml) process.exit(1);

// 3) Co ve výpisu je: období, dny NAV, datum pozic.
const attrs = (s) => Object.fromEntries([...s.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const st = attrs(/<FlexStatement\s([^>]*)>/.exec(xml)?.[1] ?? "");
const nav = [...new Set([...xml.matchAll(/<EquitySummaryByReportDateInBase\s[^>]*?reportDate="(\d{8})"/g)].map((m) => m[1]))].sort();
const posDates = [...new Set([...xml.matchAll(/<OpenPosition\s[^>]*?reportDate="(\d{8})"/g)].map((m) => m[1]))].sort();
const positions = (xml.match(/<OpenPosition\s/g) || []).length;
console.log(`Výpis: účet …${(st.accountId || "").slice(-3)}, období ${st.fromDate}–${st.toDate} (${st.period}), vygenerováno ${st.whenGenerated}`);
console.log(`Dny NAV (${nav.length}): ${nav.join(", ") || "žádné"}`);
console.log(`Pozice k: ${posDates.join(", ") || "?"} (${positions} řádků)`);

const dir = join(WEB, "..", "podklady", source);
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const file = join(dir, `flex-diag-${stamp}.xml`);
writeFileSync(file, xml);
console.log(`XML uloženo: ${file}`);

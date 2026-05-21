#!/usr/bin/env node
/**
 * Daily IBKR Flex import — běží jako GitHub Action.
 *
 * Důvod: Cloudflare Worker měl problém s IBKR WAF (403 z CF edge IP).
 * GitHub-hosted runners mají jiné IP rozsahy, které IBKR pouští.
 *
 * Flow:
 *   1) SendRequest na Flex API           → ReferenceCode (s retry pro rate limit)
 *   2) Wait + GetStatement                → XML
 *   3) POST XML na Pages Function         → /api/flex-ingest
 *
 * Pages Function parsuje XML a mergne do KV (oddělená logika, ať parser
 * a auth jsou v jednom místě). Frontend pak čte overlay přes
 * /api/portfolio-overlay/:id — beze změny.
 *
 * Env (z GitHub Actions secrets / vars):
 *   FLEX_TOKEN      — token z IBKR Flex Web Service
 *   FLEX_QUERY_ID   — query ID (1514926)
 *   INGEST_SECRET   — shared secret pro autorizaci POST do Pages
 *   PAGES_URL       — https://akcie-tracker.pages.dev
 *   PORTFOLIO_ID    — plegi-invest-ibkr
 */

const FLEX_BASE =
  "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService";

// Browser-style UA — IBKR WAF blokuje "bot-like" UA z některých edge IP.
// GH runner IPs to nepotřebují, ale je to defenzivně lepší.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const env = process.env;
const REQUIRED = ["FLEX_TOKEN", "FLEX_QUERY_ID", "INGEST_SECRET", "PAGES_URL", "PORTFOLIO_ID"];
for (const k of REQUIRED) {
  if (!env[k]) {
    console.error(`❌ Missing required env ${k}`);
    process.exit(1);
  }
}

async function main() {
  console.log(`🚀 Flex import — ${new Date().toISOString()}`);
  console.log(`   portfolio=${env.PORTFOLIO_ID}, query=${env.FLEX_QUERY_ID}`);

  // 1) SendRequest s retry
  const refCode = await sendRequestWithRetry();
  console.log(`🔑 ReferenceCode: ${refCode}`);

  // 2) Wait 30s + GetStatement (IBKR potřebuje čas na vygenerování)
  console.log(`⏳ Wait 30s for statement generation...`);
  await sleep(30_000);

  const xml = await getStatementWithRetry(refCode);
  console.log(`✅ XML downloaded: ${xml.length} bytes`);

  // 3) POST na Pages Function
  const ingestUrl = `${env.PAGES_URL}/api/flex-ingest?portfolio_id=${encodeURIComponent(env.PORTFOLIO_ID)}`;
  console.log(`🚚 POST to ${ingestUrl}`);

  const res = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/xml",
      "X-Ingest-Secret": env.INGEST_SECRET,
    },
    body: xml,
  });
  const result = await res.text();
  console.log(`📥 Pages response: HTTP ${res.status}`);
  console.log(result);
  if (!res.ok) {
    throw new Error(`Ingest failed: HTTP ${res.status}`);
  }
  console.log(`✅ Import completed successfully`);
}

async function sendRequestWithRetry(maxAttempts = 3) {
  const url = `${FLEX_BASE}.SendRequest?t=${encodeURIComponent(env.FLEX_TOKEN)}&q=${encodeURIComponent(env.FLEX_QUERY_ID)}&v=3`;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const wait = 60_000 * attempt; // 120s, 180s
      console.log(`   ⏳ Retry SendRequest #${attempt} za ${wait / 1000}s...`);
      await sleep(wait);
    }

    const res = await fetch(url, { headers: { "User-Agent": UA } });
    console.log(`   📤 SendRequest attempt ${attempt}: HTTP ${res.status}`);

    if (!res.ok) {
      lastErr = new Error(`SendRequest HTTP ${res.status}`);
      if ([502, 503, 504, 522, 524, 530].includes(res.status) && attempt < maxAttempts) {
        console.log(`   ⚠️  Transient HTTP error, retry`);
        continue;
      }
      throw lastErr;
    }

    const xml = await res.text();
    const status = matchTag(xml, "Status");
    const refCode = matchTag(xml, "ReferenceCode");
    const errorCode = matchTag(xml, "ErrorCode");
    const errorMsg = matchTag(xml, "ErrorMessage");

    if (status === "Success" && refCode) return refCode;

    lastErr = new Error(`SendRequest selhal: code=${errorCode}, msg=${errorMsg}`);
    if ((errorCode === "1001" || /try again shortly/i.test(errorMsg || "")) && attempt < maxAttempts) {
      console.log(`   ⚠️  ${lastErr.message} (rate limit, retry)`);
      continue;
    }
    throw lastErr;
  }
  throw lastErr || new Error("SendRequest failed");
}

async function getStatementWithRetry(refCode, maxAttempts = 6) {
  const url = `${FLEX_BASE}.GetStatement?t=${encodeURIComponent(env.FLEX_TOKEN)}&q=${encodeURIComponent(refCode)}&v=3`;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(15_000);
    console.log(`   📥 GetStatement attempt ${attempt}/${maxAttempts}...`);

    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`GetStatement HTTP ${res.status}`);
    const xml = await res.text();

    if (xml.includes("<FlexQueryResponse")) return xml;
    if (xml.includes("Statement generation in progress")) {
      console.log(`   ⏳ Still generating, wait 15s...`);
      continue;
    }
    const errCode = matchTag(xml, "ErrorCode");
    const errMsg = matchTag(xml, "ErrorMessage");
    if (errCode) throw new Error(`GetStatement err ${errCode}: ${errMsg}`);
    throw new Error(`Unexpected response: ${xml.slice(0, 200)}`);
  }
  throw new Error("GetStatement timeout");
}

function matchTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].trim() : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});

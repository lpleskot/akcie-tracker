/**
 * MCP server (Model Context Protocol) pro PLEGIN — endpoint /mcp.
 *
 * Transport Streamable HTTP bez SSE: klient POSTuje JSON-RPC 2.0 zprávy
 * a odpověď je vždy application/json. Stateless, bez session ID. GET (SSE
 * stream) a DELETE (ukončení session) vrací 405 — spec to klientům povoluje.
 *
 * Autentizace: secret MCP_TOKEN jako `Authorization: Bearer <token>` nebo
 * `?token=<token>` (konektor v claude.ai se zadává jen jako URL). Bez
 * nastaveného secretu je endpoint trvale zavřený. Cesta /mcp je v Cloudflare
 * Access vyjmutá politikou Bypass — token je tu jediná ochrana, proto se
 * kontroluje dřív než cokoli jiného a URL s tokenem se nikam neloguje.
 */

import { AKCIE_DEN_TOOL, runAkcieDen, toolDefinition } from "./akcie-den.js";

const SERVER_INFO = { name: "akcie-tracker", title: "akcie-tracker", version: "1.0.0" };
const INSTRUCTIONS =
  "Čte stav akciových portfolií PLEGI invest (Interactive Brokers a Komerční banka) " +
  "k závěru obchodního dne — denní změny pozic, Total Return a celkový výnos, " +
  "stejnými výpočty jako appka akcie-tracker.";

// Server používá jen tools (request/response), což je ve všech verzích stejné —
// požadovanou verzi klienta proto potvrdí, neznámou nahradí nejrozšířenější.
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

export async function handleMcp(request, env) {
  if (!(await isAuthorized(request, env))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="akcie-tracker"',
        "Cache-Control": "no-store",
      },
    });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return rpcHttp(rpcError(null, -32700, "Parse error"), 400);
  }

  const ctx = { env, origin: new URL(request.url).origin };
  if (Array.isArray(body)) {
    if (body.length === 0) return rpcHttp(rpcError(null, -32600, "Invalid Request"), 400);
    const replies = (await Promise.all(body.map((m) => handleMessage(m, ctx)))).filter(Boolean);
    return replies.length ? rpcHttp(replies) : new Response(null, { status: 202 });
  }
  const reply = await handleMessage(body, ctx);
  return reply ? rpcHttp(reply) : new Response(null, { status: 202 });
}

async function handleMessage(msg, ctx) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg && typeof msg === "object" && "id" in msg ? msg.id : null, -32600, "Invalid Request");
  }
  // Notifikace (notifications/initialized, cancelled, …) nemají id a odpověď nečekají
  if (!("id" in msg)) return null;

  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion)
          ? params.protocolVersion
          : FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: [await toolDefinition(ctx.env)] });
    case "tools/call":
      return callTool(id, params, ctx);
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function callTool(id, params, ctx) {
  if (params?.name !== AKCIE_DEN_TOOL) {
    return rpcError(id, -32602, `Neznámý nástroj: ${params?.name}`);
  }
  try {
    const report = await runAkcieDen(ctx.env, params.arguments || {}, { origin: ctx.origin });
    return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(report) }], isError: false });
  } catch (e) {
    // Chyba nástroje (špatné datum, nedostupná data) jde do výsledku s isError —
    // model ji uvidí a může dotaz opravit; protokolová chyba by ji před ním skryla.
    console.error(`akcie_den selhal: ${e?.stack || e}`);
    return rpcResult(id, {
      content: [{ type: "text", text: `Chyba: ${e?.message || e}` }],
      isError: true,
    });
  }
}

async function isAuthorized(request, env) {
  const expected = env.MCP_TOKEN;
  if (!expected) return false;
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") || "")?.[1]?.trim();
  const query = new URL(request.url).searchParams.get("token");
  for (const candidate of [bearer, query]) {
    if (candidate && (await tokensEqual(candidate, expected))) return true;
  }
  return false;
}

// Porovnání v konstantním čase: SHA-256 dá obě strany vždy 32bajtové, takže
// timingSafeEqual (požaduje stejnou délku) nevyzradí ani délku tokenu.
async function tokensEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcHttp(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

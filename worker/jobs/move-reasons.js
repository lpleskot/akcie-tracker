/**
 * Co stojí za velkým pohybem titulu – jedna věta česky se zdrojem pro ranní
 * report (Lukáš 7. 11. 2026: „pokud akcie klesne nebo roste o 10 % a více,
 * tak krátce napsat, co za tím stojí“).
 *
 * Z čísel se důvod vyčíst nedá, je ve zprávách. Worker se proto u každého
 * takového titulu zeptá Claude API (Opus 5.5) s vyhledáváním na webu. Ven jde
 * jen titul, obchodní den a změna v %, žádné hodnoty portfolia. Věta se ukáže
 * jen se zdrojem, který byl opravdu mezi nalezenými výsledky – odkaz, který
 * si model vymyslí, neprojde.
 *
 * Odpověď (i „nedohledáno“) se ukládá do KV `plegin-duvod:<datum>:<symbol>`:
 * pojistka, ruční běh ani dry run za stejný den neplatí podruhé a v KV zůstává
 * i spotřeba tokenů pro kontrolu ceny. Chyba se neukládá, další běh to zkusí
 * znovu. Report kvůli tomu nečeká déle než budgetMs; co nestihne, ukáže jako
 * nenačtené. Bez secretu ANTHROPIC_API_KEY nebo s PLEGIN_DUVODY = "off" se
 * nic nevolá.
 */

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";
const MAX_SEARCHES = 3;
// Server dlouhé hledání přeruší (pause_turn) – tah se pošle zpět a pokračuje
const MAX_CONTINUATIONS = 2;
// Nové API účty mají nízký limit vstupních tokenů za minutu a výsledky
// hledání jsou desítky tisíc tokenů – víc dotazů najednou by končilo na 429
const CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 120000;
const CACHE_PREFIX = "plegin-duvod:";
const CACHE_TTL_S = 60 * 86400;
const MAX_TEXT = 300;

const SYSTEM = `Píšeš krátká vysvětlení do ranního reportu akciového portfolia. Dostaneš akcii, obchodní den a změnu její závěrečné ceny proti předchozímu obchodnímu dni.

Na webu vyhledej, co ten pohyb způsobilo: hospodářské výsledky nebo výhled, převzetí, regulace, soudní spor, změna doporučení analytiků, zpráva z oboru nebo pohyb celého trhu. Hledej zprávy z toho dne a z večera před ním – firmy často zveřejňují výsledky po zavření burzy.

Odpověz česky přesně v tomto tvaru, na dva řádky:
<jedna věcná věta do 30 slov o tom, co pohyb způsobilo>
Zdroj: <adresa článku, ze kterého věta vychází>

Pravidla pro větu:
- bez úvodu, bez názvu firmy na začátku a bez procenta změny ceny, to report ukazuje sám,
- v reportu navazuje za pomlčku, proto začni malým písmenem, pokud nezačínáš vlastním jménem,
- čísla uváděj jen tak, jak jsou ve zdroji.

Když nalezené zdroje konkrétní důvod nepotvrzují, odpověz jen slovem NEZNÁMO.`;

export const reasonsEnabled = (env) => Boolean(env.ANTHROPIC_API_KEY) && env.PLEGIN_DUVODY !== "off";

function question(m, denPopis) {
  const jmeno = m.nazev && m.nazev !== m.name ? `${m.name} (${m.symbol}; v evidenci „${m.nazev}“)` : `${m.name} (${m.symbol})`;
  return [
    `Akcie: ${jmeno}, obchoduje se v ${m.mena || "neznámé měně"}`,
    `Obchodní den: ${denPopis}`,
    `Změna závěrečné ceny proti předchozímu obchodnímu dni: ${m.pctText}`,
  ].join("\n");
}

async function askClaude(client, move, denPopis, signal) {
  const messages = [{ role: "user", content: question(move, denPopis) }];
  const responses = [];
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    // Stream jen kvůli dlouhému hledání (data tečou, spojení nezamrzne);
    // čte se až celá zpráva
    const message = await client.beta.messages
      .stream(
        {
          model: MODEL,
          max_tokens: 16000,
          // Odmítnutí bezpečnostním filtrem zkusí server rovnou na jiném modelu
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "medium" },
          system: SYSTEM,
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES }],
          messages,
        },
        { signal },
      )
      .finalMessage();
    responses.push(message);
    if (message.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: message.content });
  }
  return responses;
}

// ---------- Odpověď → věta a ověřený zdroj (čisté funkce) ----------

const URL_RE = /https?:\/\/[^\s<>"'\])]+/;
const UNKNOWN_RE = /^NEZN[AÁ]MO\b/i;

// Adresa bez schématu, www, dotazu a koncového lomítka – model odkaz občas
// zkrátí o sledovací parametry
function normUrl(s) {
  try {
    const u = new URL(s);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

// Adresy výsledků hledání ze všech odpovědí tahu, i vnořených (dynamické
// filtrování je vrací s polem caller) a z citací
function searchResultUrls(responses) {
  const found = new Map();
  const walk = (v) => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (!v || typeof v !== "object") return;
    if ((v.type === "web_search_result" || v.type === "web_search_result_location") && typeof v.url === "string") {
      const n = normUrl(v.url);
      if (n && !found.has(n)) found.set(n, v.url);
    }
    for (const x of Object.values(v)) if (x && typeof x === "object") walk(x);
  };
  responses.forEach((r) => walk(r.content));
  return found;
}

function cleanSentence(s) {
  let t = s
    .replace(/^[-•]\s+/, "")
    .replace(/[*_`[\]]/g, "") // markdown by PLEGIN v reportu naformátoval
    .replace(/\s*—\s*/g, " – ") // texty appek mají en dash
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, ""); // tečku dává report až za odkaz na zdroj
  if (t.length > MAX_TEXT) t = `${t.slice(0, MAX_TEXT - 1).replace(/\s+\S*$/, "")}…`;
  return t;
}

/**
 * Odpovědi jednoho tahu (víc při pause_turn) → { status: "ok", text, url,
 * host } / { status: "unknown" } / { status: "error", error }.
 */
export function parseAnswer(responses) {
  const last = responses.at(-1);
  if (last?.stop_reason !== "end_turn") return { status: "error", error: `stop_reason ${last?.stop_reason}` };
  const blocks = last.content || [];
  // Konečná odpověď = text za posledním hledáním
  const final = blocks.slice(blocks.findLastIndex((b) => b.type !== "text") + 1);
  const raw = final.map((b) => b.text).join("").trim();
  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const zdroj = lines.find((l) => /^zdroj\s*:/i.test(l));
  const text = cleanSentence(lines.filter((l) => l !== zdroj).join(" "));
  if (!text || UNKNOWN_RE.test(text)) return { status: "unknown" };

  const found = searchResultUrls(responses);
  const named = zdroj?.match(URL_RE)?.[0].replace(/[.,;]+$/, "");
  let url = named ? found.get(normUrl(named)) : null;
  if (!url) {
    const cited = final.flatMap((b) => b.citations || []).find((c) => found.has(normUrl(c.url)));
    url = cited ? found.get(normUrl(cited.url)) : null;
  }
  if (!url) return { status: "unknown", reason: "zdroj se mezi výsledky hledání nenašel" };
  return { status: "ok", text, url, host: new URL(url).hostname.replace(/^www\./, "") };
}

function usageOf(responses) {
  const sum = { input: 0, output: 0, cache_read: 0, searches: 0 };
  for (const r of responses) {
    sum.input += r.usage?.input_tokens || 0;
    sum.output += r.usage?.output_tokens || 0;
    sum.cache_read += r.usage?.cache_read_input_tokens || 0;
    sum.searches += r.usage?.server_tool_use?.web_search_requests || 0;
  }
  return sum;
}

// ---------- Běh ----------

async function pool(items, size, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

async function explainOne(client, kv, move, datum, denPopis, signal) {
  if (signal.aborted) return { status: "error", error: "nestihlo se" };
  try {
    const responses = await askClaude(client, move, denPopis, signal);
    const result = parseAnswer(responses);
    if (result.status !== "error") {
      const cached = { ...result, model: responses.at(-1).model, usage: usageOf(responses), at: new Date().toISOString() };
      await kv
        .put(`${CACHE_PREFIX}${datum}:${move.symbol}`, JSON.stringify(cached), { expirationTtl: CACHE_TTL_S })
        .catch((e) => console.error(`📰 důvod ${move.symbol} ${datum}: KV – ${e?.message || e}`));
    }
    return result;
  } catch (e) {
    return { status: "error", error: signal.aborted ? "nestihlo se" : String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Důvody velkých pohybů dne. moves = [{ symbol, name, nazev, mena, pctText }],
 * denPopis = obchodní den slovy („pátek 6. 11. 2026“). Vrací Map symbol →
 * výsledek parseAnswer; nikdy nehází. client mění jen testy.
 */
export async function explainMoves(env, moves, { datum, denPopis, budgetMs, client } = {}) {
  const out = new Map();
  if (!moves.length || !reasonsEnabled(env)) return out;
  const kv = env.AKCIE_TRACKER_KV;

  const todo = [];
  for (const m of moves) {
    const cached = await kv.get(`${CACHE_PREFIX}${datum}:${m.symbol}`, "json").catch(() => null);
    if (cached?.status) out.set(m.symbol, cached);
    else todo.push(m);
  }

  if (todo.length) {
    const api = client || new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), budgetMs);
    try {
      await pool(todo, CONCURRENCY, async (m) => {
        out.set(m.symbol, await explainOne(api, kv, m, datum, denPopis, abort.signal));
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const summary = moves.map((m) => {
    const r = out.get(m.symbol);
    return `${m.symbol} ${r.status}${r.error ? ` (${r.error})` : ""}`;
  });
  const line = `📰 Důvody pohybů ${datum}: ${summary.join(", ")} – nové ${todo.length}, z KV ${moves.length - todo.length}`;
  if ([...out.values()].some((r) => r.status === "error")) console.error(line);
  else console.log(line);
  return out;
}

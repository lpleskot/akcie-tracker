# REVIZE_REPORT — akcie-tracker

## Revize — 2026-07-22
- Rozsah: plná (podle `REVIZE_KODU.md`; oblasti 1–12 + 14, oblast 13 vědomě vynechána)
- Verze: commit `25b9a44` (main), web běžící na `akcie-tracker.pages.dev`
- Provedl: Claude (nálezy AI, plošné schválení oprav Lukáš 2026-07-22, opravy Claude)
- Minulý report zkontrolován: — (první revize)

| # | Oblast | Zjištění | Místo | Závažnost | Pracnost | Doporučení | Stav |
|---|---|---|---|---|---|---|---|
| R1 | Bezpečnost | Celá aplikace veřejná bez autentizace — CLAUDE.md tvrdil CF Access (403), realita: 200 anonymně vč. portfolio JSON a zapisovatelných API | Pages projekt (infra) | 🔴 | M | Zapnout CF Access + service token pro cron worker | **kód připraven — čeká na Lukáše (CF Dashboard)** |
| R2 | Bezpečnost | Veřejné trigger endpointy `/run` na obou workerech | oba workery | 🔴 | S | `x-admin-key` gate, default zavřeno | **opraveno** |
| R3 | Data / crony | Overlay se ukládal jen když přibyly transakce — NAV snapshoty z klidných dnů se nenávratně zahazovaly (Flex okno ~7 dní) | flex-import | 🔴 | S | Počítat `newNavDays` do save podmínky | **opraveno** |
| R4 | Data / crony | fx-update: selhání jednoho dne = trvalá díra v kurzech (další běh startuje od max data) | scripts/fx-update.mjs | 🟡 | S | Fail-fast + exit 1 | **opraveno** |
| R5 | Duplicity | `fetchYahooQuote` ve watchlist.js divergentní kopie bez MINOR_UNITS → londýnské tituly v pencích | functions/api | 🟡 | S | Sdílená `_lib.js` | **opraveno** |
| R6 | Duplicity / logika | cron-alerts měl vlastní zjednodušený FIFO a neviděl KV overlay — nehlídal nové Flex pozice, hlídal prodané | cron-alerts | 🟡 | M | Overlay z KV + sdílený `fifo.js` + `flex-shared.js` | **opraveno** |
| R7 | Robustnost / UX | Tichá degradace: výpadek overlay/NAV jen v console.warn, UI bez indikace | app.js | 🟡 | S | `#warnings` banner + detekce zastaralého importu (>4 dny) | **opraveno + ověřeno v prohlížeči** |
| R8 | Observabilita | Selhání cronů nikdo neuvidí | workery + fx-update | 🟡 | M | Failure e-maily (Resend) + exit 1 u GH Action | **opraveno** (flex-import maily po přidání `RESEND_API_KEY`) |
| R9 | Testy | FIFO engine bez automatických testů | fifo.js | 🟡 | M | `node --test` + fixtures z validovaných dat | **odloženo** — samostatná dávka, viz CLAUDE.md „Co ještě není"; do té doby kryto smoke testem z 2026-07-22 |
| R10 | Repo | `.wrangler/cache` v gitu, flex-import bez `.gitignore` | repo | 🟡 | S | Gitignores + smazat cache | **opraveno** (commit smaže z repa) |
| R11 | Konzistence | Hypotéza: nekonzistentní escapeHtml (17× vs. 46 innerHTML) | app.js | 🟢 | S | — | **zamítnuto po ověření** — hloubkový audit: všechny externí stringy (názvy, poznámky, deník, popisy) escapované jsou; poměr byl falešný signál (zbytek = interní symboly/čísla/textContent) |
| R12 | Chybové stavy | `Object.assign(rule, patch)` bez validace — patch mohl přepsat `id`/`type` | alerts.js | 🟢 | S | Whitelist `armed`/`threshold_pct`/`description` | **opraveno** |
| R13 | Chybové stavy | Read-modify-write souběh nad KV (poslední zápis vyhrává) | functions/api | 🟢 | — | — | **přijato** (jeden uživatel, KV eventual-consistent by design) |
| R14 | Duplicity | `json()` helper 6× copy-paste | functions/api | 🟢 | S | `_lib.js` | **opraveno** |
| R15 | Výkon / API | Chybové odpovědi quote.js cachovatelné (public, max-age=60) | quote.js | 🟢 | S | `no-store` pro status ≥ 400 | **opraveno** |
| R16 | Závislosti | Vendorovaný SheetJS bez evidence verze | vendor/ | 🟢 | S | Zapsat do CLAUDE.md | **opraveno** (v0.20.3) |
| R17 | Data | Flex XML parser nedekódoval entity (`&amp;` v názvech) | flex-import | 🟢 | S | `decodeXmlEntities` | **opraveno** |
| R18 | Úklid | Zbytkový vnořený repo `akcie-tracker/akcie-tracker/` | disk (mimo git) | 🟢 | S | Smazat | **opraveno** (přesunuto do Koše: `~/.Trash/akcie-tracker-leftover-repo-2026-07-22`) |
| R19 | Výkon / data | KV overlay roste neomezeně, bez procesu konsolidace | KV | 🟢 | — | Roční konsolidace do statického JSON | **opraveno procesně** (postup zapsán v CLAUDE.md, sekce flex-import) |
| R20 | Konfigurace | Mrtvé vars v cron wrangler.toml (`FX_URL`, po R6 i `WATCHLIST_API`/`ALERTS_API`) | cron-alerts | 🟢 | S | Odstranit | **opraveno** (nalezeno při opravě R6) |

---

## Detail k 🔴 nálezům

### R1 — Aplikace veřejná (důkaz + stav)

**Důkaz (2026-07-22):** anonymní `curl` bez cookies vrátil **200** na `/`,
`/data/portfolios/plegi-invest-ibkr.json` (25 kB transakcí vč. čísla účtu)
i na všechna `/api/*` (zapisovatelná). CLAUDE.md přitom tvrdil „Access, 403".

**Provedeno (kód):** cron-alerts už nečte watchlist/alerts přes HTTP (KV binding)
a pro zbylé HTTP fetche (portfolio JSON, quote API) umí posílat Access
service-token hlavičky, jakmile budou nastavené secrets. Zapnutí Access nic
nerozbije.

**Zbývá (Lukáš, CF Dashboard) — mitigace do té doby: noindex + robots.txt;
termín: co nejdřív, přesný postup v CLAUDE.md sekce Přístup:**
Zero Trust → Access → aplikace + e-mail politika → service token → secrets
`CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` na `akcie-tracker-cron` →
ověřit anonymní curl (302/403) a druhý den průchod cronu.
Pozn.: data byla po nějakou dobu veřejná na uhodnutelné URL — riziko vyhodnoť
(jde o transakce a číslo účtu, ne přístupové údaje).

### R2 — `/run` endpointy — opraveno

Oba workery: `/run` (a `/__scheduled`) vrací 403 bez správného `x-admin-key`;
bez nastaveného secretu `ADMIN_KEY` jsou trvale zavřené (cron trigger tím
neprochází a běží dál). Bonus: cron-alerts má `/run?dry=1` — vyhodnotí a vrátí
triggery bez odeslání e-mailu a bez zápisu `fired:*` (bezpečné testování).

### R3 — Ztráta NAV snapshotů — opraveno

`mergeOverlay` počítá `newNavDays` (nové reportDates) a save podmínka je
zahrnuje — klidný den bez obchodů teď KV uloží kvůli novému NAV. V logu
importu přibylo `+N NAV days`.

---

## Opravy 2026-07-22 — jak byly ověřeny

- **esbuild bundle-check** všech 10 změněných JS entry pointů (syntaxe +
  resolvce importů napříč složkami, včetně worker → `assets/js/*`): ✅
  (odhalil a opravil 1 chybu — česká uvozovka ukončila string v app.js).
- **Node smoke test** (`fifo.js` + `flex-shared.js`, stejná cesta jako worker):
  transformace SELL/forex/suffix, dedupe podle flex_id, FIFO net_qty /
  avg_open_price / realized P/L na cent, split 1:2 — 11/11 ✅.
- **Prohlížeč (lokální server):** aplikace se načte, 23 pozic, FIFO spočítané;
  overlay stub s 1 trade → AMZN 25→30 ks a průměr sedí na 4 desetinná místa
  (merge přes sdílený modul); R7 banner ověřen pro oba stavy — „overlay
  nedostupný" i „poslední import před 10 dny" ✅.
- Workery a Functions na produkci se ověří po deployi (checklist v CLAUDE.md
  commit poznámkách / níže).

**Test po deployi:** (1) web bez žlutého banneru + přepnutí portfolií,
(2) nastavit `ADMIN_KEY` secrets → curl `/run` bez klíče 403, s klíčem
flex-import `ok:true` a cron `/run?dry=1` vrátí JSON, (3) druhý den log
flex-importu obsahuje `+N NAV days` a „Overlay uložen" i bez obchodů,
(4) watchlist: přidat `SHEL.L` → cena v GBP (ne pencích) → smazat,
(5) po zapnutí Access: anonymní curl 302/403 a cron druhý den projde.

## Zkontrolováno a čisté

- Mrtvý kód: žádné TODO/FIXME, zakomentované bloky, `*_old` soubory.
- `_headers` (CSP default-src 'self', HSTS, nosniff), `_redirects` skrývá
  workers/.github/scripts.
- Tajemství: žádná v repu ani git historii (secrets přes wrangler/GH).
- Escapování XSS (R11 audit): důsledné u všech externích stringů.
- Chybové stavy: catch bloky logují a vrací chybu; retry logika flex-importu
  promyšlená (530/rate-limit/network).
- Komentáře „proč", krátké funkce; git hygiena (atomické commity).
- CLAUDE.md přesný (kromě R1 — opraveno).

## Nezkontrolováno / omezení

- **Oblast 13 (UI a přístupnost)** — vědomě vynechána: privátní nástroj pro
  jednoho uživatele; zvážit při případném rozšíření okruhu uživatelů.
- **Runtime chování workerů na produkci** — lokálně ověřeno bundle + logika;
  finální potvrzení až po deployi (checklist výše).
- **Obnova D1/R2 záloh** — projekt D1 nepoužívá (KV + git JSON); obnova =
  git checkout + KV overlay se sám doplní. Netestováno formálně.
- **Oblast 6 (výkon)** — jen zběžně (bundle 148 kB app.js OK, žádný build);
  bez měření — není indikace problému.

## Další kroky

1. Lukáš: commity podle plánu v chatu → push → CF auto-deploy + GH Actions
   nasadí workery.
2. Lukáš: nastavit `ADMIN_KEY` (oba workery), volitelně `RESEND_API_KEY` na
   flex-import; **zapnout Access (R1)** + service token.
3. Post-deploy checklist (výše).
4. Příští revize: **rychlá** po zapnutí Access (ověřit R1 zvenku); další
   plná při větší nové funkci. Vstupem bude tento report (R9 odložený dluh).

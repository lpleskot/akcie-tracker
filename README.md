# Akcie tracker

Privátní portfolio tracker pro PLEGI invest přes Interactive Brokers a Komerční banku a pro Lukášovo osobní portfolio u LYNX. Sleduje otevřené pozice vůči nákupní ceně (FIFO), realizované P/L, dividendy + srážkovou daň, splity i další corporate actions. Slouží zároveň jako podklad pro účetní — kompletní transakční evidence s CZK přepočtem kurzem ČNB k datu vypořádání a XLSX exportem.

## Stack

- **Frontend:** statické HTML + vanilla JS (ES modules), bez build kroku
- **Backend:** jeden Cloudflare Worker `akcie-tracker` — servíruje statické assety,
  obsluhuje `/api/*` (router ve `worker/index.js`) a jednou denně ráno spouští
  cron (IB Flex import z IBKR a Lynx + hned poté ranní report Akcie do PLEGINu a vyhodnocení
  alertů; pojistka reportu v 7:20 Prahy)
- **Storage:** Cloudflare KV namespace `AKCIE_TRACKER_KV`, JSON soubory v `data/`
  pro portfolio data + ČNB kurzy
- **Hosting:** Cloudflare Workers (`akcie-tracker.lukas-pleskot.workers.dev`)
- **Přístup:** Cloudflare Access (omezeno na konkrétní e-mail)

## Funkce

### Multi-portfolio
- Selector v hlavičce přepíná mezi portfolii (IBKR / KB firmy PLEGI invest, osobní Lynx),
  seskupenými podle vlastníků
- Manifest v `data/portfolios/manifest.json` listuje dostupná portfolia a výchozí vlastníky
- Watchlist, alerty, poznámky a deník jsou globální (napříč brokery)
- **Nastavení** (v hlavičce): vlastníci portfolií – firma nebo osoba – a které portfolio
  komu patří. Daňová optimalizace a Pozice k datu počítají vždy za jednu firmu, osobní
  portfolia se do nich nepočítají. Uloženo v KV (`/api/settings`)
- Načíst znovu a exporty jsou v liště vpravo nad tabulkou každého tabu

### Přehled pozic
- FIFO výpočet otevřených pozic s prorataovanou komisí
- Aktuální cena z Yahoo Finance + nerealizovaná Z/Z + realizovaná Z/Z z prodejů
- Klik na hodnotu Z/Z rozbalí detail (nákupy, prodeje, splity, FIFO matching, dividendy, Total Return)
- Sort + search po ticker/název
- Přepínač **Držené / Prodané** – prodané tituly s nákupem a prodejem, Ø cenami,
  výsledkem z prodeje, dividendami a výsledkem v Kč (kurzy ČNB jako Report pro účetní)

### Alokace
- Váha pozice v portfoliu ve **dvou pohledech** současně: aktuální tržní hodnota
  a vložená investice (vč. již prodaných lotů)
- Δ percentage points ukazuje, jak se relativní pozice posunula růstem/poklesem

### Watchlist
- Sledování tickerů, které ještě nedržíte
- Cenová pravidla: pod X, nad X, pokles % od referenční ceny
- Benchmark cena (snapshot) pro sledování změny od označení

### Alerty
- Pravidla na otevřené pozice (drop_from_buy, drop_from_52w_high, drop_from_buy_all)
- Cron 1× denně označí splněná pravidla jako „fired" — vidět v tabu Alerty
  (bez e-mailových notifikací)
- Deduplikace přes "fired" stav v KV (re-arm tlačítkem)

### Transakce
- Filtr roku (chips) + custom date range Od–Do + search, řazení od nejnovější
- **Export pro účetní** (CZK přepočet ČNB)

### Dividendy
- Agregované po (symbol, date) s párováním srážkové daně
- Součet v patce po měnách + USD ekvivalent

### Report pro účetní
- Per realizovaný prodej v daném roce: FIFO matching nákupních lotů + přepočet na CZK
  kurzem ČNB k datu **vypořádání**
- Grand total v CZK (nákup / prodej / zisk-ztráta) — podklad pro daňové přiznání
- XLSX export (barevné řádky, kurz s datem platnosti) + **Tisk / PDF** (tiskový styl)

### Daňová optimalizace
- Za zvolenou firmu (všechna její portfolia, v hlavičce vedle výběru portfolia): výsledek prodejů v aktuálním roce (jako
  Report pro účetní), odhad daně 21 %, nerealizovaný zisk a ztráta v Kč kurzy ČNB
  (nákup kurzem k vypořádání každého drženého nákupu) a dividendy roku
- Tabulka pozic se Z/Z v měně i v Kč (daňově), rozbalení na jednotlivé nákupy,
  simulace prodeje zaškrtnutých pozic; XLSX export
- Poznámky a daňová přiznání po letech (blok na rozbalení): účetní a daňový výsledek podaných přiznání (`data/tax-returns.json`,
  doplňuje se jednou ročně po podání) a kolik ztráty roku bez podaného přiznání jde
  odečíst zpětně od základu dvou předchozích let (vrácená daň) nebo 5 let dopředu
- PLEGI invest je mikro účetní jednotka: akcie se k 31. 12. nepřeceňují, do daně jde
  jen prodej a ztráta z prodeje se od zisků odečte
- Orientační výpočet, ne daňové poradenství

### Pozice k datu (inventura)
- Stav pozic k rozvahovému dni (typicky 31. 12.) přes všechna portfolia firmy: název, ISIN,
  ticker, kusy, závěrečná cena k datu, ocenění v měně i CZK (kurz ČNB k datu),
  pořizovací cena v CZK a oceňovací rozdíl
- XLSX export s přesným zněním požadavku auditora v záhlaví; Tisk / PDF

### Hodnota portfolia
- NAV time-series (SVG chart) s deposit markery, dlaždice Celkem vloženo /
  Aktuální hodnota / Rozdíl

### Deník investora
- KV-backed textový deník, inline editace, search

### XLSX export
- Tlačítko vpravo nad tabulkou exportuje aktuální tab po aplikaci filtrů (SheetJS self-hosted)

## Datový model

```
broker export (HTML/CSV/PDF) → parse → data/portfolios/<id>.json
  ├── transactions[]         ← BUY/SELL, source of truth
  ├── corporate_actions[]    ← splity, rights issues (FIFO engine je páruje)
  ├── dividends[]            ← výplaty
  ├── withholding_tax[]      ← srážková daň u zdroje
  ├── cash_flows[]           ← vklady, výběry, úroky, fees
  ├── cash_balance{}         ← aktuální zůstatek per měna
  └── instruments{}          ← ISIN + ticker + Yahoo mapování

data/fx_rates.json           ← ČNB kurzy 13 měn (denní auto-update)
data/portfolio-history-<id>.json ← denní NAV pro graf Hodnota portfolia (v měně účtu)
data/tax-returns.json        ← podaná přiznání k DPPO (doplňuje se jednou ročně)
data/portfolios/manifest.json ← seznam dostupných portfolií + výchozí vlastníci (firma / osoba)

KV (Cloudflare):
  watchlist                  ← sledované tickery s pravidly + benchmark
  alerts                     ← pravidla na držené pozice
  notes                      ← poznámky per ticker
  journal                    ← deník investora
  settings                   ← vlastníci portfolií z Nastavení (přednost před manifestem)
  portfolio-overlay:{id}     ← denní IB Flex auto-import IBKR a Lynx (merge nad statický JSON)
  fired:alert:{id}:{symbol}  ← fired stav pro deduplikaci
  fired:watch:{id}:{ruleId}
```

## FIFO engine

`assets/js/fifo.js → computePositions(transactions, corporateActions, dividends, withholdingTax)`

Vrací mapu `symbol → { net_qty, cost_basis, avg_open_price, realized_pnl, total_invested, open_lots, closed_lots, splits, dividend_records, withholding_records, ... }`.

Corporate actions:
- `type: "split"` (klasický IBKR formát s ratio_from + ratio_to)
- `type: "received_share"` / `"removed_share"` (KB formát) — práva (stejný `isin_event` připsaný a později odepsaný ve stejném počtu) jsou bez vlivu na akcii; ostatní preprocessing páruje v okně 30 dnů na stejném `isin_underlying` → auto-detect split, unpaired received = bonus shares, unpaired removed = cancellation

## Testy

```sh
cd web/
node --test tests/*.test.mjs
```

113 unit testů (FIFO engine, inventura k datu, Flex transformace, import a merge overlay, MCP a ranní report, Daňová optimalizace, Prodané pozice, vlastníci portfolií) – ručně spočítané fixtures.
Běží i v CI při každém pushi (`.github/workflows/tests.yml`).

## Lokální vývoj

```sh
cd web/
npx wrangler dev
```

Běží na `http://localhost:8787` — statické assety, `/api/*` i KV (lokální,
prázdná simulace; `--remote` použije produkční bindingy — pozor na zápisy).
Tip: přidej `--persist-to /tmp/akcie-tracker-kv` — bez toho lokální KV
zapisuje do `.wrangler/` uvnitř asset složky, watcher po každém zápisu
restartuje server a requesty končí 503.
Cron joby lze lokálně spustit přes `/run/*` s nastaveným klíčem:
`npx wrangler dev --var ADMIN_KEY:test` a pak
`curl -H "x-admin-key: test" "http://localhost:8787/run/alerts?dry=1"`.

## Struktura repa

```
web/                           ← repo root = asset složka Workeru
├── index.html
├── 404.html
├── assets/
│   ├── css/styles.css
│   └── js/
│       ├── app.js             ← UI, fetch, render
│       ├── fifo.js            ← FIFO engine (sdílený s cron jobem alerts)
│       ├── flex-shared.js     ← Flex transformace (sdílené s cron jobem alerts)
│       ├── owners.js          ← vlastníci portfolií (sdílené s /api/settings)
│       └── vendor/xlsx-js-style.min.js  ← XLSX export (SheetJS fork se styly)
├── worker/
│   ├── index.js               ← entry: /api/* router + scheduled dispatch
│   ├── api/                   ← lib (Yahoo+JSON), quote, watchlist, alerts,
│   │                            notes, journal, settings, portfolio-overlay
│   └── jobs/                  ← flex-import.js, alerts.js, plegin-report.js (cron joby)
├── data/
│   ├── fx_rates.json
│   ├── portfolio-history-{plegi-invest-ibkr,lukas-pleskot-lynx}.json
│   └── portfolios/{manifest,plegi-invest-ibkr,plegi-invest-kb,lukas-pleskot-lynx}.json
├── scripts/                   ← fx-update (ČNB denně), fx-backfill (ČNB pro starší historii),
│                                flex-history (historie účtu z ročních IB Flex XML), cnb (sdílené)
├── wrangler.toml              ← Worker konfigurace (assets, crony, KV, vars)
├── .assetsignore              ← co se neservíruje jako asset
├── _headers                   ← CSP, HSTS, cache
└── .github/workflows/
    └── fx-update-cron.yml     ← denní ČNB kurzy → commit → push (deploy přes CF)
```

## Přidání nového portfolia

1. Naparsovat data brokera do `data/portfolios/<id>.json` (formát viz existující soubory).
   Účet u IB nebo LYNX: výpisy Flex po letech (XML) → `node scripts/flex-history.mjs <složka> --id … --name … --broker …`
   (ověří hotovost a pozice proti výpisu IB a zapíše i NAV historii), denní import = nový zdroj ve `FLEX_SOURCES`
2. Přidat řádek do `data/portfolios/manifest.json` s `owner` (vlastník z `owners`, nový vlastník tam taky)
3. Doplnit ČNB kurzy pro nové datumy: `node scripts/fx-backfill.mjs data/portfolios/<id>.json`
4. Commit + push → Workers Builds nasadí

## Deploy

Automaticky při každém pushi do `main` přes **Workers Builds** (Cloudflare git
integrace; Deploy command `npx wrangler deploy`). Worker secrets (`FLEX_TOKEN`,
`LYNX_FLEX_TOKEN`, `ADMIN_KEY`, `MCP_TOKEN`, `PLEGIN_REPORT_TOKEN`, `REPORT_RUN_TOKEN`) se nastavují
přes `wrangler secret put` nebo v CF dashboardu.

Detaily v `DEPLOY.md`.

# Akcie tracker

Privátní portfolio tracker pro PLEGI invest přes Interactive Brokers a Komerční banku. Sleduje otevřené pozice vůči nákupní ceně (FIFO), realizované P/L, dividendy + srážkovou daň, splity i další corporate actions. Slouží zároveň jako podklad pro účetní — kompletní transakční evidence s CZK přepočtem kurzem ČNB k datu vypořádání a XLSX exportem.

## Stack

- **Frontend:** statické HTML + vanilla JS (ES modules), bez build kroku
- **Backend:** jeden Cloudflare Worker `akcie-tracker` — servíruje statické assety,
  obsluhuje `/api/*` (router ve `worker/index.js`) a jednou denně ráno spouští
  cron (IBKR Flex import + hned poté vyhodnocení alertů)
- **Storage:** Cloudflare KV namespace `AKCIE_TRACKER_KV`, JSON soubory v `data/`
  pro portfolio data + ČNB kurzy
- **Hosting:** Cloudflare Workers (`akcie-tracker.lukas-pleskot.workers.dev`)
- **Přístup:** Cloudflare Access (omezeno na konkrétní e-mail)

## Funkce

### Multi-portfolio
- Selector v hlavičce přepíná mezi brokery (IBKR / KB)
- Manifest v `data/portfolios/manifest.json` listuje dostupná portfolia
- Watchlist, alerty, poznámky a deník jsou globální (napříč brokery)

### Přehled pozic
- FIFO výpočet otevřených pozic s prorataovanou komisí
- Aktuální cena z Yahoo Finance + nerealizovaná Z/Z + realizovaná Z/Z z prodejů
- Klik na hodnotu Z/Z rozbalí detail (nákupy, prodeje, splity, FIFO matching, dividendy, Total Return)
- Sort + search po ticker/název

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

### Hodnota portfolia
- NAV time-series (SVG chart) s deposit markery, dlaždice Celkem vloženo /
  Aktuální hodnota / Rozdíl

### Deník investora
- KV-backed textový deník, inline editace, search

### XLSX export
- Tlačítko v toolbaru exportuje aktuální tab po aplikaci filtrů (SheetJS self-hosted)

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

data/fx_rates.json           ← ČNB kurzy 12 měn (denní auto-update)
data/portfolios/manifest.json ← seznam dostupných portfolií

KV (Cloudflare):
  watchlist                  ← sledované tickery s pravidly + benchmark
  alerts                     ← pravidla na držené pozice
  notes                      ← poznámky per ticker
  journal                    ← deník investora
  portfolio-overlay:{id}     ← denní IBKR Flex auto-import (merge nad statický JSON)
  fired:alert:{id}:{symbol}  ← fired stav pro deduplikaci
  fired:watch:{id}:{ruleId}
```

## FIFO engine

`assets/js/fifo.js → computePositions(transactions, corporateActions, dividends, withholdingTax)`

Vrací mapu `symbol → { net_qty, cost_basis, avg_open_price, realized_pnl, total_invested, open_lots, closed_lots, splits, dividend_records, withholding_records, ... }`.

Corporate actions:
- `type: "split"` (klasický IBKR formát s ratio_from + ratio_to)
- `type: "received_share"` / `"removed_share"` (KB formát) — preprocessing páruje v okně 30 dnů na stejném `isin_underlying` → auto-detect split, unpaired received = bonus shares, unpaired removed = cancellation

## Testy

```sh
cd web/
node --test tests/*.test.mjs
```

21 unit testů FIFO enginu a Flex transformací (ručně spočítané fixtures).
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
│       └── vendor/xlsx-js-style.min.js  ← XLSX export (SheetJS fork se styly)
├── worker/
│   ├── index.js               ← entry: /api/* router + scheduled dispatch
│   ├── api/                   ← lib (Yahoo+JSON), quote, watchlist, alerts,
│   │                            notes, journal, portfolio-overlay
│   └── jobs/                  ← flex-import.js, alerts.js (cron joby)
├── data/
│   ├── fx_rates.json
│   ├── portfolio-history-plegi-invest-ibkr.json
│   └── portfolios/{manifest,plegi-invest-ibkr,plegi-invest-kb}.json
├── wrangler.toml              ← Worker konfigurace (assets, crony, KV, vars)
├── .assetsignore              ← co se neservíruje jako asset
├── _headers                   ← CSP, HSTS, cache
└── .github/workflows/
    └── fx-update-cron.yml     ← denní ČNB kurzy → commit → push (deploy přes CF)
```

## Přidání nového portfolia

1. Naparsovat data brokera do `data/portfolios/<id>.json` (formát viz existující soubory)
2. Přidat řádek do `data/portfolios/manifest.json`
3. Doplnit ČNB kurzy v `data/fx_rates.json` pro nové datumy
4. Commit + push → GH Action nasadí

## Deploy

Automaticky při každém pushi do `main` přes **Workers Builds** (Cloudflare git
integrace; Deploy command `npx wrangler deploy`). Worker secrets (`FLEX_TOKEN`,
`ADMIN_KEY`) se nastavují v CF dashboardu.

Detaily v `DEPLOY.md`.

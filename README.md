# Akcie tracker

Privátní portfolio tracker pro PLEGI invest přes Interactive Brokers a Komerční banku. Sleduje otevřené pozice vůči nákupní ceně (FIFO), realizované P/L, dividendy + srážkovou daň, splity i další corporate actions. Slouží zároveň jako podklad pro účetní — kompletní transakční evidence s CZK přepočtem kurzem ČNB k datu obchodu a XLSX exportem.

## Stack

- **Frontend:** statické HTML + vanilla JS (ES modules), bez build kroku
- **Backend:** Cloudflare Pages Functions (`/api/quote`, `/api/watchlist`, `/api/alerts`) + samostatný cron Worker pro denní alert evaluaci
- **Storage:** sdílený Cloudflare KV namespace `AKCIE_TRACKER_KV` (Pages ↔ Worker), JSON soubory v `data/` pro portfolio data + ČNB kurzy
- **Hosting:** Cloudflare Pages + Cloudflare Workers
- **Mail:** Resend pro alert notifikace (`alerts@notify.plegiholding.cz`)
- **Přístup:** Cloudflare Access (omezeno na konkrétní e-mail)

## Funkce

### Multi-portfolio
- Selector v hlavičce přepíná mezi brokery (IBKR / KB)
- Manifest v `data/portfolios/manifest.json` listuje dostupná portfolia
- Watchlist a alerty jsou globální (napříč brokery)

### Přehled pozic
- FIFO výpočet otevřených pozic s prorataovanou komisí
- Aktuální cena z Yahoo Finance + nerealizovaná Z/Z + realizovaná Z/Z z prodejů
- Klik na hodnotu Z/Z rozbalí detail (nákupy, prodeje, splity, FIFO matching, dividendy, Total Return)
- Sort + search po ticker/název
- Tooltipy s vysvětlením každého sloupce

### Alokace
- Váha pozice v portfoliu ve **dvou pohledech** současně:
  - Aktuální tržní hodnota
  - Vložená investice (vč. již prodaných lotů)
- Δ percentage points ukazuje, jak se relativní pozice posunula růstem/poklesem

### Watchlist
- Sledování tickerů, které ještě nedržíte
- Cenové pravidla: pod X, nad X, pokles % od referenční ceny
- Benchmark cena (snapshot) pro sledování změny od označení

### Alerty
- Pravidla na otevřené pozice (drop_from_buy, drop_from_52w_high, drop_from_buy_all)
- Cron 1× denně, e-mailová notifikace přes Resend
- Deduplikace přes "fired" stav v KV (re-arm tlačítkem)

### Transakce
- Filtr roku (chips) + custom date range Od–Do + search
- Řazení od nejnovější

### Dividendy
- Agregované po (symbol, date) s párováním srážkové daně
- Součet v patce po měnách + USD ekvivalent

### Report pro účetní
- Per realizovaný prodej v daném roce: FIFO matching nákupních lotů + přepočet na CZK kurzem ČNB k datu obchodu
- Grand total v CZK (nákup / prodej / zisk-ztráta) — podklad pro daňové přiznání

### Summary dlaždice (na všech tabech v hlavičce)
- Otevřené pozice, Cash USD, Celkový výnos %, P.a., YTD, Zisk/Ztráta CZK, Dividendy (po dani) CZK

### XLSX export
- Tlačítko v toolbaru exportuje aktuální tab po aplikaci filtrů (SheetJS self-hosted)
- Pro Report pro účetní speciální layout s nákup/prodej bloky a grand totalem

## Datový model

```
broker export (HTML/CSV/PDF) → parse → data/portfolios/<id>.json
  ├── transactions[]         ← BUY/SELL, source of truth
  ├── corporate_actions[]    ← splity, rights issues (FIFO engine je párujе)
  ├── dividends[]            ← výplaty
  ├── withholding_tax[]      ← srážková daň u zdroje
  ├── cash_flows[]           ← vklady, výběry, úroky, fees
  ├── cash_balance{}         ← aktuální zůstatek per měna
  └── instruments{}          ← ISIN + ticker + Yahoo mapování

data/fx_rates.json           ← ČNB kurzy 12 měn × 200+ dnů
data/portfolios/manifest.json ← seznam dostupných portfolií

KV (Cloudflare):
  watchlist                  ← sledované tickery s pravidly + benchmark
  alerts                     ← pravidla na držené pozice
  fired:alert:{id}:{symbol}  ← fired stav pro deduplikaci
  fired:watch:{id}:{ruleId}
```

## FIFO engine

`assets/js/fifo.js → computePositions(transactions, corporateActions, dividends, withholdingTax)`

Vrací mapu `symbol → { net_qty, cost_basis, avg_open_price, realized_pnl, total_invested, open_lots, closed_lots, splits, dividend_records, withholding_records, ... }`.

Corporate actions:
- `type: "split"` (klasický IBKR formát s ratio_from + ratio_to)
- `type: "received_share"` / `"removed_share"` (KB formát) — preprocessing páruje v okně 30 dnů na stejném `isin_underlying` → auto-detect split, unpaired received = bonus shares, unpaired removed = cancellation

## Lokální vývoj

```sh
cd web/
npx wrangler pages dev .
```

`wrangler pages dev` spustí Pages Functions na `http://localhost:8788`. Bez wranglera (`python3 -m http.server`) chybí `/api/quote` (živé ceny) a `/api/watchlist`+`/api/alerts` (KV CRUD).

## Struktura repa

```
web/                           ← CF Pages root
├── data/
│   ├── fx_rates.json
│   └── portfolios/
│       ├── manifest.json
│       ├── plegi-invest-ibkr.json
│       └── plegi-invest-kb.json
├── functions/api/
│   ├── quote.js               ← Yahoo proxy
│   ├── watchlist.js           ← KV CRUD (GET / POST add|delete|update|set_benchmark)
│   └── alerts.js              ← KV CRUD (GET / POST add|delete|update|rearm)
├── assets/
│   ├── css/styles.css
│   └── js/
│       ├── app.js             ← UI, fetch, render
│       ├── fifo.js            ← FIFO engine
│       └── vendor/xlsx.mini.min.js  ← SheetJS pro XLSX export
├── index.html
├── 404.html
├── _headers                   ← CSP, HSTS, cache
├── _redirects
└── robots.txt

workers/cron-alerts/           ← CF Worker (separátní deploy)
├── wrangler.toml
├── src/index.js               ← scheduled handler + Resend
└── README.md

.github/workflows/
└── deploy-worker.yml          ← GitHub Actions auto-deploy workeru
```

## Přidání nového portfolia

1. Naparsovat data brokera do `data/portfolios/<id>.json` (formát viz existující soubory)
2. Přidat řádek do `data/portfolios/manifest.json`
3. Doplnit ČNB kurzy v `data/fx_rates.json` pro nové datumy (script v `outputs/kb_parser/`)
4. Commit + push → CF Pages auto-deploy

## Deploy

- **Pages** (web): automaticky při push do `main` přes CF Pages Git integraci
- **Worker** (cron): automaticky přes GitHub Actions (`.github/workflows/deploy-worker.yml`), trigger při změnách v `workers/cron-alerts/`. Secrets v repo: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Worker secret `RESEND_API_KEY` se nastavuje přímo v CF dashboardu.

Detaily v `DEPLOY.md`.

# akcie-tracker-flex-import

Denní cron worker, který stahuje z **IBKR Flex Web Service** nové trades, cash transactions, corporate actions a transfers a ukládá je idempotentně do KV jako overlay nad statický portfolio JSON.

## Architektura

```
                                   ┌──────────────────────────┐
                                   │  IBKR Flex Web Service   │
                                   │  (api token + query id)  │
                                   └────────────┬─────────────┘
                                                │ XML
                                                ▼
   cron 0 4 * * * UTC ──── flex-import worker  ┐
                          (SendRequest+Get)    │
                                               ▼
                                   KV: portfolio-overlay:plegi-invest-ibkr
                                               │
                                               ▼
                  frontend ────  /api/portfolio-overlay/:id
                                               │
                                               ▼
                                  merge static JSON + overlay
                                  → FIFO engine vidí nová data
```

## Setup (jednorázový)

### 1. Cloudflare API Token (pokud ještě nemáte)
Stejné údaje jako pro `cron-alerts` worker:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Jsou už uložené v GitHub Actions secrets.

### 2. IBKR Flex secrets

Po prvním nasazení workeru (přes push do main → auto-deploy přes GitHub Actions, nebo `wrangler deploy` lokálně):

**a) Přes CF Dashboard:**
- Workers & Pages → `akcie-tracker-flex-import` → Settings → Variables and Secrets → **Add variable** s typem **Secret**:
  - Name: `FLEX_TOKEN`
  - Value: token z IBKR Flex Web Service (~24 znaků)

**b) Přes wrangler CLI** (pokud máš nainstalovaný):
```bash
cd workers/flex-import
wrangler secret put FLEX_TOKEN
# vlož hodnotu
```

`FLEX_QUERY_ID` je vidět ve `wrangler.toml` (není to secret, je to číslo query — `1514926`).

### 3. KV namespace
Sdílíme s ostatními workery a Pages projektem:
- Binding: `AKCIE_TRACKER_KV`
- ID: `6d78ccbecdc64d7e9798f1ed39fca35d`

Konfigurováno v `wrangler.toml`.

## Spuštění

### Cron
```
0 4 * * *  →  každý den ve 4:00 UTC
            =  6:00 Varšava v létě (CEST)
            =  5:00 Varšava v zimě (CET)
```

### Manuální trigger (testing)

Otevři ve workeru URL:
```
https://akcie-tracker-flex-import.<account>.workers.dev/run
```

Vrátí JSON s parsed daty a stats — bez zápisu do KV pokud je `DRY_RUN=true`.

### Logy
- CF Dashboard → Workers → `akcie-tracker-flex-import` → Logs (Real-time + Past 7 days)
- Klíčové loglines: `🚀`, `📊 Parsed:`, `🔀 Merge stats:`, `✅ Overlay uložen`, `❌ Selhal`

## DRY_RUN přepnutí

`wrangler.toml` má `DRY_RUN = "true"` — worker parsuje, ale **neukládá do KV**. Pro ověření že vše funguje.

Po ověření změň na `"false"` (nebo proměnnou smaž) a redeploy:
```bash
git push   # nebo
cd workers/flex-import && wrangler deploy
```

## Co dělá overlay

Frontend (web/assets/js/app.js, fce `mergeOverlayIntoPortfolio`) načte statický JSON i KV overlay, transformuje Flex záznamy do shape pro FIFO engine a dedupuje podle `flex_id`:

- **trades** → `transactions[]` (s `flex_id`, `_source: "flex"`)
- **cash_transactions** typu Dividends → `dividends[]`
- **cash_transactions** typu Withholding Tax → `withholding_tax[]`
- **cash_transactions** ostatní → `cash_flows[]`
- **corporate_actions** → `corporate_actions[]`
- **transfers** → (zatím nemáme cílovou strukturu, log only)

Snapshoty (Open Positions, NAV, M2M YTD) se **přepisují aktuálním stavem** (vždy nejčerstvější).

## Token expirace

IBKR Flex Web Service token expiruje za 365 dní. Když přestane fungovat:
1. Login do IBKR Portal
2. Settings → Reporting → Flex Web Service
3. Generate New Token
4. CF Dashboard → Workers → `akcie-tracker-flex-import` → Settings → Variables and Secrets → upravit `FLEX_TOKEN`

## Rate limits
- IBKR Flex: max 1 request/minute na endpoint. Pro denní cron nás netýká.
- CF Workers: bezvýznamné pro náš objem.

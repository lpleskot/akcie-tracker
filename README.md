# Akcie tracker

Osobní portfolio tracker pro Interactive Brokers a další brokery. Sleduje
aktuální stav otevřených pozic vůči nákupní ceně (metoda FIFO) a slouží
zároveň jako podklad pro účetnictví — kompletní transakční evidence
s exportem do CSV.

## Stack

- **Frontend:** statické HTML + vanilla JS (ES modules), bez build kroku
- **Backend:** Cloudflare Functions (`/functions/api/quote.js`) — server-side
  proxy k Yahoo Finance, kvůli CORS a cachi
- **Hosting:** Cloudflare Pages
- **Přístup:** Cloudflare Access (pouze přihlášený e-mail)

## Lokální vývoj

Stačí soubory otevřít přes lokální webserver, např.:

```sh
cd web/
npx wrangler pages dev .
```

`wrangler pages dev` spustí i CF Functions lokálně na `http://localhost:8788`.

Bez wranglera je možné servírovat jen statiku (`python3 -m http.server`),
ale `/api/quote` pak nebude fungovat — bez živých cen.

## Struktura

```
web/
├── data/portfolios/                ← portfolio JSON soubory (raw transakce)
│   └── plegi-invest-ibkr.json
├── functions/api/quote.js          ← CF Function (Yahoo proxy)
├── assets/
│   ├── css/styles.css
│   └── js/
│       ├── app.js                  ← UI logika, fetch, render
│       └── fifo.js                 ← FIFO výpočet pozic + utility
├── index.html
├── 404.html
├── _headers                        ← bezpečnostní hlavičky + cache
├── _redirects
├── robots.txt
└── .gitignore
```

## Přidání nového portfolia

1. Vytvořit `data/portfolios/<id>.json` se strukturou viz existující soubor
2. Změnit konstantu `PORTFOLIO_URL` v `assets/js/app.js` (nebo do budoucna
   přidat selector portfolia v UI)

## Datový tok

```
broker export (HTML/CSV) → parse → web/data/portfolios/<id>.json
                                       ↓
                                  app.js načte
                                       ↓
                              FIFO engine spočte pozice
                                       ↓
                        /api/quote dotáhne aktuální ceny z Yahoo
                                       ↓
                                  UI renderuje
```

## Deploy

Viz `DEPLOY.md`.

# DEPLOY.md — akcie-tracker

> Od 2026-07-25 běží projekt jako **jeden Cloudflare Worker `akcie-tracker`**
> (statické assety + `/api/*` + oba crony). Dřívější setup (Pages projekt +
> 2 samostatné workery) je zrušený — jednorázový přechod viz checklist dole.

## Jak deploy funguje

- **Workers Builds (git integrace)** — Worker `akcie-tracker` je v CF dashboardu
  připojený na repo `lpleskot/akcie-tracker`, branch `main`. Každý push spustí
  build v Cloudflare: Build command žádný, Deploy command `npx wrangler deploy`
  (podle root `wrangler.toml`). Statické assety se uploadují inkrementálně.
- **Denní ČNB kurzy** — `fx-update-cron.yml` (14:35 UTC) commitne
  `data/fx_rates.json`; push spustí Workers Builds webhookem — funguje i pro
  commity z `GITHUB_TOKEN` (na rozdíl od `on: push` GitHub workflows).
- **Ruční deploy / build log** — Worker → záložka **Deployments** (příp. Builds):
  log každého buildu + retry. Lokálně: `npx wrangler deploy` (po `wrangler login`).

Pro deploy nejsou potřeba žádné GitHub secrets (build běží pod CF účtem) —
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` v repu lze smazat.

**Worker secrets** (CF Dashboard → Workers & Pages → `akcie-tracker` →
Settings → Variables and Secrets, nebo `npx wrangler secret put <NÁZEV>`):

| Secret | K čemu |
| --- | --- |
| `FLEX_TOKEN` | IBKR Flex Web Service token (denní import) |
| `ADMIN_KEY` | ochrana manuálních `/run/*` endpointů (bez něj zavřeno = 403) |

Žádné e-mailové notifikace — Resend byl odstraněn (2026-07-23). Fired alerty
jsou vidět v tabu Alerty, selhání jobů v CF lozích (Worker → Observability).

Cron triggery a vars (`PORTFOLIO_ID`, `FLEX_QUERY_ID`, `DRY_RUN`) jsou
v `wrangler.toml` — deployují se automaticky.

## Ověření po deployi

- `https://akcie-tracker.lukas-pleskot.workers.dev/` — načte se aplikace, pozice spočítané
- `/api/quote?symbols=AAPL` — JSON s aktuální cenou
- `/api/portfolio-overlay/plegi-invest-ibkr` — JSON overlay (data z KV)
- `/run/alerts` bez klíče → 403; s `x-admin-key: <ADMIN_KEY>` a `?dry=1` → JSON triggerů
- `/CLAUDE.md`, `/worker/index.js` → 404 (`.assetsignore` funguje)
- Ráno po 7:00: v logu Workeru (Observability → Logs) běh importu v 5:00 UTC
  (léto) a skip v 6:00 UTC; v 15:00 UTC běh alertů

## Cloudflare Access — zabezpečit přístup

Po migraci stačí toggle na Workeru (žádný service token — crony nejdou přes HTTP):

1. CF Dashboard → Workers & Pages → `akcie-tracker` → **Settings → Domains & Routes**
2. U `workers.dev` → **Enable Cloudflare Access**
3. **Manage Cloudflare Access** → policy: Allow → Emails → `lukas.pleskot@chrudim.cz`
4. Ověřit: anonymní okno → přihlašovací stránka; `curl -I https://akcie-tracker.lukas-pleskot.workers.dev/` → 302/403

Pozn.: `/run/*` endpointy jsou pak také za Accessem — pro curl je potřeba Access
service token (Zero Trust → Access → Service Auth) NAVÍC k `x-admin-key`,
nebo prostě počkat na cron.

## Jednorázový přechod z Pages (checklist migrace)

1. ✅ Pages projekt `akcie-tracker` smazán (2026-07-23) — uvolnil jméno
   i `pages.dev` URL.
2. ✅ Repo připojeno přes Workers Builds (2026-07-25). Projekt vznikl jako
   `akcie-tracker2` — jméno `akcie-tracker` tehdy blokoval worker vytvořený
   neúspěšným GH Action deployem; po jeho smazání projekt přejmenován zpět
   na **`akcie-tracker`**. (Build command prázdný, Deploy command
   `npx wrangler deploy`, root `/`.)
3. ✅ Staré Workery `akcie-tracker-cron` a `akcie-tracker-flex-import` smazány
   (2026-07-25) — uvolnily account limit cron triggerů free plánu (kvůli němu
   triggery prvního deploye neprošly) a přestaly posílat Resend e-maily.
4. Push → Workers Builds build: v logu nesmí být `.git/` v asset uploadu,
   warning o jménu, ani error u „Deployed … triggers".
5. Nastavit **Worker secrets** (tabulka výše — stejné hodnoty jako dřív).
6. Ověřit web + API na `akcie-tracker.lukas-pleskot.workers.dev` (checklist výše)
   vč. `/.git/HEAD` → 404.
7. **Zapnout Access** (sekce výše) — priorita č. 1 (R1).

## Future custom domain

Až bude potřeba vlastní doména (`akcie.plegiholding.cz`):

1. Worker → **Settings → Domains & Routes → Add → Custom domain** → `akcie.plegiholding.cz`
2. V Zero Trust → Access přidat/přesměrovat aplikaci na novou doménu

## Co dělat při problémech

**`/api/quote` vrací 500 nebo prázdné výsledky:**
- Yahoo občas zablokuje request bez správného User-Agent → je v `worker/api/lib.js`
- Konkrétní symbol může selhat sám — error je v response per symbol, ostatní fungují

**Flex import selhává (log ve Worker → Observability):**
- IBKR WAF občas vrací 530 — job má retry; opakované selhání = zkontrolovat
  platnost `FLEX_TOKEN` (expiruje ~1× ročně v IBKR Client Portal)

**Stránka po deployi zobrazuje starou verzi:**
- Hard reload (Cmd+Shift+R); `/data/*` má `no-cache`, `/assets/*` revalidaci
  (viz `_headers`)

**Access nechce přijít e-mail s kódem:**
- Zkontrolovat spam; Zero Trust → Settings → Authentication → povolen
  "One-time PIN" provider

**Lokální `wrangler dev` spadne na compatibility date:**
- Lokální workerd může být starší než `compatibility_date` ve `wrangler.toml`
  → aktualizovat wrangler (`npx wrangler@latest dev`), případně datum dočasně snížit

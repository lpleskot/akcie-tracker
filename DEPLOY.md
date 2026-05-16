# DEPLOY.md — akcie-tracker

## Cloudflare Pages — initial setup

### 1) Vytvořit projekt

1. `dash.cloudflare.com` → **Workers & Pages** → **Create application** → tab **Pages** → **Connect to Git**
2. Vybrat GitHub účet `lpleskot` (případně autorizovat Cloudflare GitHub App)
3. Repo: `akcie-tracker`
4. Branch: `main`

### 2) Build settings

| Pole | Hodnota |
| --- | --- |
| Framework preset | **None** |
| Build command | *(prázdné)* |
| Build output directory | `/` |
| Root directory | *(prázdné)* |
| Environment variables | *(žádné)* |

Po prvním deployi dostane projekt URL ve tvaru `akcie-tracker-XYZ.pages.dev`
nebo `akcie-tracker.pages.dev`.

### 3) Ověření base funkčnosti

Po `https://akcie-tracker.pages.dev` zkontrolovat:

- `/` — načte se index.html (zatím bez Access ochrany)
- `/api/quote?symbols=AAPL` — vrátí JSON s aktuální cenou Applu
- `/data/portfolios/plegi-invest-ibkr.json` — vrátí JSON s transakcemi
- Otevřít DevTools → Network → ověřit, že `/api/quote?symbols=...` vrací 200
  a všech 23 cen je naplněno

## Cloudflare Access — zabezpečit přístup

### 4) Vytvořit Access aplikaci

1. `dash.cloudflare.com` → **Zero Trust** → **Access** → **Applications** → **Add an application**
2. **Self-hosted**
3. **Application name:** `Akcie tracker`
4. **Session duration:** `1 month`
5. **Application domain:**
   - Subdomain: `akcie-tracker` (nebo skutečný subdoména z pages.dev URL)
   - Domain: `pages.dev`
   - Path: *(prázdné = celá doména)*

### 5) Policy

Po nastavení aplikace přidat policy:

- **Policy name:** `Pouze já`
- **Action:** `Allow`
- **Configure rules:**
  - **Include:** Selector `Emails` → hodnota `lukas.pleskot@chrudim.cz`

Klik **Save**. Od této chvíle je `akcie-tracker.pages.dev` chráněn — komukoli
mimo Lukáše se zobrazí přihlašovací stránka Cloudflare a žádost o ověření
e-mailem (jednorázový kód do mailu).

### 6) Ověření Access

1. Otevřít `akcie-tracker.pages.dev` v anonymním okně
2. Měla by se zobrazit Cloudflare Access stránka „Sign in with…"
3. Po zadání e-mailu přijde do schránky kód, který se zadá zpět
4. Po úspěšném ověření má uživatel přístup po dobu session (1 měsíc)

## Future custom domain

Až bude potřeba vlastní doména (např. `akcie.pleskot.cz`):

1. CF Pages → projekt → **Custom domains** → **Set up a custom domain**
2. Zadat `akcie.pleskot.cz`, potvrdit CNAME / nameservery podle instrukcí
3. V Access aplikaci změnit doménu z `pages.dev` na novou
4. Po pár minutách propagace funguje custom doména s Access

## Co dělat při problémech

**`/api/quote` vrací 500 nebo prázdné výsledky:**
- Yahoo občas zablokuje request bez správného User-Agent → ověřit, že
  CF Function má User-Agent header (je v `functions/api/quote.js`)
- Konkrétní symbol může selhat sám — error je v response per symbol,
  ostatní fungují dál

**Stránka po deploy zobrazuje cached starou verzi:**
- Hard reload (Cmd+Shift+R)
- Cache pravidla v `_headers` mají pro `/data/` `no-cache`, pro `/assets/`
  `max-age=3600`

**Access nechce přijít e-mail s kódem:**
- Zkontrolovat spam složku
- Ověřit, že v Zero Trust → Settings → Authentication je povolen
  "One-time PIN" provider

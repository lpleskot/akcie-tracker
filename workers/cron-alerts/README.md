# Akcie tracker — cron worker

Cloudflare Worker, který každý den v **15:00 UTC** (17:00 Prague v létě, 16:00 v zimě) vyhodnotí všechna alert pravidla a v případě splnění pošle souhrnný email přes Resend.

## Architektura

- Sdílí KV namespace `AKCIE_TRACKER_KV` s Pages projektem (jeden source of truth)
- Čte portfolio JSON + ČNB kurzy + watchlist + alerts pravidla
- Volá `/api/quote` na Pages projektu pro aktuální Yahoo ceny
- Vyhodnocuje pravidla, deduplicuje proti `fired:*` klíčům v KV
- Email přes Resend (`from: alerts@notify.plegiholding.cz`)

## Setup

### 1. Doplnit KV namespace ID do `wrangler.toml`

Najít ID ve dvou krocích:
```sh
npx wrangler kv:namespace list
```
nebo CF dashboard → **Workers & Pages → KV** → najít `AKCIE_TRACKER_KV` → zkopírovat **ID** (32-znakový hash).

Otevřít `wrangler.toml` a nahradit `REPLACE_WITH_KV_NAMESPACE_ID` skutečným ID.

### 2. Přihlásit wrangler (jednorázově)

```sh
npx wrangler login
```
Otevře se prohlížeč → autorizovat → ✓.

### 3. Nasadit worker

```sh
cd workers/cron-alerts
npx wrangler deploy
```
Po úspěchu uvidíte URL workeru ve formátu `https://akcie-tracker-cron.<account>.workers.dev`.

### 4. Přidat Resend API klíč jako secret

```sh
npx wrangler secret put RESEND_API_KEY
```
Wrangler se zeptá `Enter a secret value:` — vložte (paste) klíč `re_...` a Enter.

Alternativně přes dashboard: **Workers & Pages → akcie-tracker-cron → Settings → Variables and Secrets → + Add → Secret**.

## Testování

Manuální spuštění (mimo cron):
```sh
curl https://akcie-tracker-cron.<account>.workers.dev/run
```
Vrátí JSON s počtem vyhodnocených pravidel + případně email id.

Lokální dev:
```sh
npx wrangler dev --test-scheduled
# v jiné konzoli:
curl "http://localhost:8787/__scheduled?cron=0+15+*+*+*"
```

Tail (sledování logů z produkce):
```sh
npx wrangler tail
```

## Změna cronu

V `wrangler.toml`:
```toml
[triggers]
crons = ["0 15 * * *"]   # 15:00 UTC každý den
```
Cron syntax: minute hour day month weekday. Změny se projeví po `wrangler deploy`.

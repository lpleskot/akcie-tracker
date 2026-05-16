# CLAUDE.md — akcie-tracker

## Stav projektu

**Účel:** Privátní portfolio tracker pro Interactive Brokers (a do budoucna další brokery).
Slouží zároveň jako evidenční podklad pro účetnictví — transakční log
s exportem do CSV.

**Architektura:** Statické HTML + vanilla JS ES modules. Backend = Cloudflare
Functions (jediná funkce: `/api/quote` jako proxy k Yahoo Finance kvůli CORS
a cache). Žádný build krok, žádné node_modules.

**Hosting:** Cloudflare Pages, doména zatím `<projekt>.pages.dev`.

**Přístup:** Cloudflare Access — odemčeno pouze pro
`lukas.pleskot@chrudim.cz`. Bez přihlášení web nikdo nevidí.

**Klíčová rozhodnutí:**

- **Source of truth = pole transakcí**, ne uložené pozice. Pozice se počítají
  v runtimu z transakcí (FIFO). Nemůže nastat stav, kdy uložená pozice
  nesouhlasí s historií transakcí.
- **FIFO** je pevně daná metoda pro matching prodejů proti nákupům
  (pro daňové účely v ČR i pro férové počítání cost basis).
- **Komise se prorataují** do cost basis (nákup) i do net výnosu (prodej) per kus.
- **Pozice = `data/portfolios/<id>.json`.** Každý portfolio jeden soubor.
  Aktuálně: `plegi-invest-ibkr.json` (Interactive Brokers, U23077136).
- **Yahoo Finance** přes neoficiální `query1.finance.yahoo.com` endpoint,
  voláno ze serveru (CF Function), cache 60 s.
- **Yahoo ticker mapování:** ve `instruments[<sym>].yahoo_symbol` u každého
  titulu (US tituly bez přípony, ostatní s `.TO`, `.ST`, `.PA`, `.DE`).

**Stav vývoje (k 2026-05-16):**

- ✅ Iniciální struktura + soubory podle playbooku
- ✅ Import 23 titulů, 44 nákupů, 4 prodejů z IBKR exportu (období 12/2025–3/2026)
- ✅ CF Function pro quote endpoint (Yahoo proxy s cache)
- ✅ FIFO engine v JS
- ✅ Frontend: Přehled pozic + Transakční log + CSV export
- ⏳ Deploy na Cloudflare Pages (čeká na první commit + publish)
- ⏳ Cloudflare Access policy
- ⏳ Test celé pipeline na živém deploy

**Co ještě není (budoucí iterace):**

- Přepočet hodnot do CZK přes historické kurzy ČNB
- Dividendy (chybí v trade confirmation reportu)
- Více portfolií (selector v UI)
- Workflow pro inkrementální import dalších obchodů z IBKR
- PDF export reportu pro účetní (zatím jen CSV)

## Pravidla pro Claude

**Stack:**

- Vanilla JS, **žádný framework**, **žádný build krok**.
- ES modules (`<script type="module">`, `import`/`export`).
- Žádný TypeScript.
- Tailwind ani jiné utility CSS frameworky NE — máme vlastní `styles.css`
  s CSS proměnnými.

**Kód:**

- Žádné komentáře v JS, které jen opakují, co dělá kód. Komentáře ano,
  když vysvětlují "proč", ne "co".
- Funkce krátké, jedna věc na funkci.
- Pojmenování českou normou, kde je to text určený uživateli; názvy proměnných
  a funkcí v JS anglicky.
- Číselné formátování přes `fmtNum`, `fmtPct`, `fmtMoney` z `fifo.js`,
  ne ručně.
- Locale `cs-CZ` pro čísla (desetinná čárka).

**Data:**

- **Nikdy nepřepisovat raw transakce** — jen přidávat nové. Sells se nikdy
  nemažou, ani když je člověk udělal omylem.
- Při importu nového broker exportu **deduplikovat** podle (date, time, symbol, type, qty, price)
  — IBKR může poslat tutéž transakci ve více reportech.
- Validace JSON: každá transakce musí mít date, symbol, type ∈ {BUY,SELL}, qty > 0,
  price > 0.

**Privacy:**

- Repo je **private** na GitHubu — obsahuje finanční data.
- Cloudflare Access chrání URL — bez přihlášení 403.
- Žádný telemetry, žádné analytics, žádný cookie banner — nepotřebujeme.

**Commit pravidla** (per PROJECT_PLAYBOOK.md sekce 6):

- Summary v imperativu, ~70 znaků, anglicky.
- Description: co a proč, ve dvou separátních code blocích.
- Jeden logický commit = jedna sada změn.
- Žádné commity od Claude — vždy Lukáš v GitHub Desktopu.

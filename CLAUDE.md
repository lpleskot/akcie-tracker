# CLAUDE.md — akcie-tracker

## Stav projektu

**Účel:** Privátní portfolio tracker pro PLEGI invest — dva brokery (Interactive Brokers + Komerční banka), do budoucna další. Slouží zároveň jako evidenční podklad pro účetnictví — transakční log + report v CZK + XLSX exporty.

**Architektura:** Statické HTML + vanilla JS ES modules. Backend = Cloudflare Pages Functions (`/api/quote`, `/api/watchlist`, `/api/alerts`) + samostatný CF Worker pro cron alerty. Cloudflare KV namespace `AKCIE_TRACKER_KV` sdílený mezi Pages a Worker. Žádný build krok, žádné `node_modules`.

**Hosting:** Cloudflare Pages na `akcie-tracker.pages.dev`. Worker na `akcie-tracker-cron.<account>.workers.dev`. Deploy:
- Pages: git push do `main` → CF auto-deploy
- Worker: git push → GitHub Actions workflow `.github/workflows/deploy-worker.yml` → wrangler deploy

**Přístup:** Cloudflare Access — pouze e-mail `lukas.pleskot@chrudim.cz`. Bez přihlášení 403.

**Klíčová rozhodnutí:**

- **Source of truth = pole transakcí**, ne uložené pozice. Pozice se počítají v runtimu z transakcí (FIFO).
- **FIFO** s prorataovanou komisí do cost basis (BUY) i do net výnosu (SELL) per kus.
- **Jedno portfolio = jeden JSON soubor** v `data/portfolios/`. Manifest v `data/portfolios/manifest.json` listuje dostupná portfolia.
- **Multi-portfolio:** state.portfolioId, selector v hlavičce, localStorage memory. Při přepnutí: reload portfolio JSON + recompute FIFO + refresh Yahoo ceny. Watchlist + Alerty jsou globální (cross-portfolio).
- **Yahoo Finance** přes neoficiální `query1.finance.yahoo.com` endpoint, voláno ze serveru (CF Function), cache 60 s.
- **Yahoo ticker mapování** ve `instruments[<sym>].yahoo_symbol`. US tituly bez přípony, ostatní s `.TO`, `.ST`, `.PA`, `.DE`, `.AX`, `.WA`, `.MI`, `.AS`, `.IL`, `.PR` atd.
- **ČNB kurzy** v `data/fx_rates.json` — 12 měn, 214 dnů (2022-12-30 → 2026-04-06+). Použito pro CZK přepočet Reportu pro účetní + agregátní dlaždice.

## Portfolia

### `plegi-invest-ibkr.json` (Interactive Brokers, account U23077136)

- **Zdroj:** IBKR Trade Confirmation (HTML) + IBKR Activity Statement (CSV)
- **Období:** 2025-11-24 → 2026-05-15
- **23 instrumentů** (NASDAQ, NYSE, Stockholm, Toronto, Paris, Xetra)
- **48 transakcí** (44 BUY + 4 SELL), 1 corporate action (BKNG 25:1 split 2026-04-06)
- **8 dividend** + 7 withholding tax (831 USD gross, -179 USD tax) + 8 vkladů (208 730 USD)
- TWR -9.03 % (IBKR autoritativní), simple return -2.18 %, YTD +0.23 %
- FIFO matematicky shodné s IBKR Activity Statement (Realized P/L na cent)

### `plegi-invest-kb.json` (Komerční banka, account 1609386)

- **Zdroj:** KB TRN CP (PDF) + KB TRN CASH (PDF, ~60 souborů per měna×kvartál) + KB STAV PTF (snapshoty)
- **Období:** 2022-12-30 → 2026-02-25 (inception = synthetic)
- **47 instrumentů** v 7 měnách (USD, EUR, CAD, SEK, PLN, GBP, AUD, DKK, CZK)
- **140 transakcí**:
  - 17 **synthetic pre-2023 openings** ze STAV PTF 31.3.2023 (cost basis odhadnut na tržní cenu k tomuto datu — skutečná nákupní cena pre-2023 neznámá, KB starší výpisy v MiFID formátu nemají transakční data)
  - 7 **synthetic Q2 2023 openings** ze STAV PTF rozdílu 30.6.2023 − 31.3.2023 (KB TRN CP Q2 2023 chybí v exportu)
  - 116 reálných BUY/SELL z TRN CP 2023-Q1 + Q3 + Q4 + všech kvartálů 2024-2026-Q1
- **23 corporate actions** (Vklad CP / Výběr CP) — splity, rights issues, restructurings. Q1 2023 CAs filtrovány (`synthetic_cutoff_date = 2023-03-31`), protože synthetic openings k 31.3.2023 už zahrnují jejich efekt.
- **114 dividend** + 91 withholding tax (sumy: 14k USD, 27k CZK, 2k AUD, 2k EUR, 2k CAD, 2k PLN, ...)
- **83 cash flows** (22 vkladů: 800k CZK + 56k USD + 18k EUR; 46 měnových konverzí; 15 externích CA poplatků)
- **18 otevřených pozic** match 18/18 s aktuálním KB statementem (validováno 17.5.2026)
- Validace proti Sharesight Sold Securities: 32/34 prodejů match. 2 nesoulady: CNE 1890 ks (Sharesight chyba — manuální evidence), IPO 1 ks (zaokrouhlení 6:1 split ratio 2240÷6).

## FIFO engine (`assets/js/fifo.js`)

- `computePositions(transactions, corporateActions, dividends, withholdingTax)` — vrací mapu `symbol → { net_qty, cost_basis, avg_open_price, realized_pnl, closed_cost_basis, total_invested, open_lots, closed_lots, splits, dividends_local, withholding_local, net_dividend_local, dividend_records, ... }`
- **Corporate actions** podporuje:
  - `type: "split"` s `ratio_from` + `ratio_to` (typické IBKR formát)
  - `type: "received_share"` / `removed_share` (KB formát) — funkce `preprocessCorporateActions()` páruje v okně 30 dnů na stejném `isin_underlying` → auto-detect split. Unpaired `received_share` = bonus shares (lot za nulový cost). Unpaired `removed_share` = cancellation (FIFO konzumace bez realized P/L).
- Tax cost basis prorataována včetně proporcionální komise.

## Frontend taby

`overview` Přehled pozic | `allocation` Alokace | `watchlist` Watchlist | `alerts` Alerty | `transactions` Transakce | `dividends` Dividendy | `report` Report pro účetní

- **Search** na všech tabech, krížek pro vymazání
- **Sort** kliknutím na hlavičku (asc/desc, číselné first-click = desc)
- **Expand row** v Přehledu: klik na hodnotu Z/Z → rozpadne detail (nákupy, prodeje, FIFO matching, splity, dividendy, Total Return)
- **Year filter + custom date range** v Transakcích, Report pro účetní
- **XLSX export** kontextový — exportuje aktuální tab po aplikaci filtrů (SheetJS self-hosted v `assets/js/vendor/xlsx.mini.min.js`)
- **Modaly** pro Přidat ticker (watchlist, rule volitelný), Přidat alert pravidlo, Upravit watchlist pravidla
- **Summary dlaždice:** Otevřené pozice, Cash USD, Celkový výnos % (+absolutní USD a CZK), P.a., YTD, Dividendy (po dani) CZK

## Architektura alertů

- `/api/watchlist` a `/api/alerts` (CF Pages Functions) — CRUD nad KV
- Worker `workers/cron-alerts/` — cron `0 15 * * *` UTC, vyhodnotí pravidla, posílá email přes Resend (`alerts@notify.plegiholding.cz` → `pleskot@plegiholding.cz`)
- KV klíče: `watchlist`, `alerts`, `fired:alert:{ruleId}:{symbol}`, `fired:watch:{itemId}:{ruleId}`
- Pravidla per portfolio (`drop_from_buy_all`, `drop_from_buy`, `drop_from_52w_high`) + watchlist (`price_below`, `price_above`, `drop_pct`)

## Co ještě není (budoucí iterace)

- Upload form pro nové broker exporty (zatím se importuje přes Cowork chat — Lukáš nahraje PDF/CSV, já parsuju)
- Q2 2026+ inkrementální import (čeká na nová data od Lukáše)
- PDF export reportu pro účetní (zatím jen XLSX)
- Telegram channel jako alternativa k emailu
- Custom doména `akcie.plegiholding.cz` (zatím `*.pages.dev`)
- Auto-fetch ČNB kurzů při importu nových transakcí (zatím manuální Python skript)
- Delisted pozice (IPO.TO, SMSI, SPCE) jsou v transakcích bez finálního „odpisu" — KB je odepsala mimo formální TRN CP. Pro UI to znamená, že tyto pozice ukazují non-zero qty v Přehledu i když KB reálně má 0. Vyřešit přidáním synthetic SELL s nulovým výnosem nebo speciální „delisting" corporate action.

## Skripty (mimo deploy, jednorázové)

- Parsování KB PDFs do JSON: Python skripty v `/sessions/.../outputs/kb_parser/` (mimo repo) — parse_trn_cp.py, parse_trn_cash.py, parse_stav_ptf.py, build_kb_full.py, merge_kb_cash.py
- Stažení ČNB kurzů: Python skript přímo proti `api.cnb.cz/cnbapi/exrates/daily` (`?date=YYYY-MM-DD&lang=EN`). Pro víkendy/svátky ČNB vrací poslední pracovní den.
- ISIN → Yahoo ticker mapování: ručně sestavená tabulka v build skriptu, validovaná přes batch volání `/api/quote` po deployi.

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

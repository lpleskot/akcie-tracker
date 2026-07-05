# Commit message formát — pro GitHub Desktop

> Univerzální konvence napříč všemi projekty. Když Claude připravuje commit
> message pro deploy, musí se držet tohoto formátu, ať se v GitHub Desktopu
> krásně čte.

---

## Struktura

GitHub Desktop má **dvě samostatná pole** — Claude proto vždy dodá **dva
oddělené bloky**, každý ke zkopírování zvlášť:

**Summary** (pole „Summary (required)"):
```
<krátký, konkrétní popis změny, ~50–60 znaků>
```

**Description** (pole „Description"):
```
- <Konkrétní změna 1 (s detaily v závorce)>
- <Konkrétní změna 2>
- <Konkrétní změna 3>
- ...
```

---

## Pravidla

### Summary

- **Max ~60 znaků** (jinak GitHub ořeže v listech)
- Vystihne změnu z **produktové perspektivy**, ne implementační
- Bez tečky na konci
- Bez čísel verzí, sprintů, milestonů — to patří do interních úkolů, ne commit message
- Imperativ („Add", „Fix", „Update") nebo nominální fráze („English version", „Speedometer chart")

### Description (odrážky)

- Každá odrážka začíná `-` + mezera (NE `*`, NE `•`)
- **Jedna odrážka = jedna konkrétní změna** (z pohledu produktu, ne souboru)
- Wrap na cca **72 znaků** kvůli čitelnosti v GitHub Desktop diff view
- Konkrétní čísla a počty: „19 pages", „6 rooms", „4 sections"
- URL mapping přes šipku: `/hotel → /en/hotel`
- Detaily v závorkách na konci: `(cs, en, x-default)`
- Bez emoji
- Bez bloků kódu (`` ``` ``) — chce-li ukázat snippet, do textu inline backtickem
- Bez sekcí typu „Backend:", „Frontend:", „Admin:" — všechno do jednoho ploského seznamu
- Bez file paths (`functions/api/news/[id].js`) — to patří do diff, ne do commit message
- Bez referencí typu „this commit", „in this PR", „we"

### Jazyk

- **Čeština** pokud je projekt česky (UI, doména, tým)
- **Angličtina** pokud je projekt anglicky nebo internacionální

---

## Příklad — anglicky

**Summary:**
```
Add English version of the website
```

**Description:**
```
- Translate 19 pages to British English under /en/ (homepage,
  hotel, wellness, contact, offers, booking, 6 rooms, 4 zones,
  3 offer details)
- Add hreflang tags (cs, en, x-default) to 19 CZ pages with EN
  counterparts
- Activate language switcher (CS|EN) on all bilingual pages
- Legal pages and PPC landing (/wellness/pardubice) stay CZ-only;
  EN footer links to them with "(CZ)" indicator
- Update sitemap.xml with 19 new EN URLs
- URL mapping: /hotel→/en/hotel, /pokoje/*→/en/rooms/*,
  /zony/*→/en/zones/*, /nabidky→/en/offers, /kontakt→/en/contact
- Bookolo booking widget switched to lang="en" on EN side
```

---

## Příklad — česky

**Summary:**
```
Admin Osobnosti — DB + admin UI + EN překlad
```

**Description:**
```
- Tabulka persons v D1 + seed 5 existujících osobností
- Veřejný feed /feed/persons + admin API CRUD
- Claude Haiku překlad CZ→EN přes /api/translate/person
- Admin UI /admin/persons/ — list, edit, new s foto uploadem
  do CF Images (prefix lifefestival/...)
- Tag dropdown s "Vlastní" fallbackem + barva tagu (gaming
  červená, sport zelená, tanec modrá, festival oranžová)
- Stránka /osobnosti přepnuta na dynamický rendering z DB
  (vizuálně beze změny, hardcoded karty nahrazeny <div
  data-persons-grid>)
- EN varianta /en/osobnosti používá *_en pole automaticky
```

---

## Co tam NEPATŘÍ

❌ Sekce s nadpisy:
```
Backend:
- migrations/0011_persons_table.sql
- functions/api/persons/index.js
```

❌ File paths:
```
- functions/api/news/[id].js: PUT podporuje title_en/content_en
```

❌ Verze a sprinty v Summary:
```
Sprint 2 MS6-MS8: EN překlady přes Claude API
```

❌ Vysvětlení proč:
```
- Added defer to main.js because PageSpeed said it was render-blocking
```
(Detaily „proč" patří do Zprávy pro uživatele, ne do commit message.)

❌ Bloky kódu:
```
- main.js: nyní defer
  ```html
  <script src="main.js" defer></script>
  ```
```

❌ Emoji:
```
- 🎯 Performance jumped 64 → 97
- ✅ All tests passing
```

❌ Reference na chat / context:
```
- Per your earlier request, added the lang switcher
- As we discussed, footer now shows partners link
```

---

## Jak to dělat v praxi

1. Po dokončení úprav Claude dodá **Summary** a **Description** jako dva
   samostatné code bloky (každý se kopíruje do svého pole v GitHub Desktopu)
2. Pak oddělovač a **Zpráva pro uživatele** (volnější, může obsahovat „proč",
   odkazy, instrukce na manuální kroky)

```
### Summary

<jeden řádek>

### Description

- <bod 1>
- <bod 2>
- ...

---

### Zpráva

<volnější vysvětlení, manuální kroky, varování>
```

---

_Verze 2 — 12. 6. 2026 (Summary a Description jako dvě samostatná pole)_

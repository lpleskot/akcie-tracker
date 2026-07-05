# Cloudflare D1 + Console — pracovní postup

> Jak pracujeme s D1 databází napříč projekty. Nikdy přes wrangler / terminal — vše přes Cloudflare Dashboard Console. Tento dokument popisuje konvenci, kterou držíme v každém projektu.

---

## Princip

- **Storage:** Cloudflare D1 (SQLite na edge)
- **Workflow:** migrace jako `.sql` soubory v repu, executované ručně přes Console
- **Bez wrangleru, bez terminalu** — uživatel paste-uje SQL do Console v CF Dashboardu
- **Per Execute jeden statement** — Console spustí vždy jen JEDEN příkaz na Execute

---

## ⚠️ Console spustí jen jeden příkaz na Execute (ověřeno 9. 6. 2026)

Když do Console vložíš víc příkazů oddělených středníkem a dáš Execute, **proběhne jen jeden z nich** (v praxi poslední) — ostatní se tiše přeskočí, bez chyby. Symptom: část dat chybí.

> Reálný případ (tmobile-k2holding, 0044 seed): blok = `INSERT firmy; INSERT strediska; INSERT cisla;`. Po Execute: `firmy=0, strediska=0, cisla=58`. Proběhl jen poslední INSERT. Navíc čísla měla `firma_id=NULL`, protože subdotazy `(SELECT id FROM k2h_firmy WHERE nazev=…)` nenašly firmy (ještě nebyly vložené).

### Pravidlo pro dávkování (jak má Claude připravovat příkazy)

1. **Minimalizuj počet příkazů.** Co jde, slož do **jednoho statementu**:
   - Víc řádků do jedné tabulky → **jeden multi-row INSERT** `INSERT INTO t (...) VALUES (...), (...), (...);` (i 58 řádků = 1 Execute). To Console zvládne.
   - Schéma: každý `CREATE TABLE` / `CREATE INDEX` je vlastní příkaz (sloučit nejde).
2. **Když to jako jeden příkaz jde → dej to jako jeden paste-blok.** (Typicky seed jedné tabulky.)
3. **Když to nejde (víc tabulek, víc CREATE) → rozděl** na samostatné paste-bloky, jeden = jeden Execute, očíslované v pořadí spuštění.
4. **Nikdy nespoléhej na víc příkazů v jednom paste.** Radši víc tabulek = víc Execute, ne jeden slepený blok.
5. **Pevná ID místo subdotazů.** Pro vazby (firma_id, stredisko_id) používej **explicitní číselné ID** (`VALUES (…, 4, …)`), ne `(SELECT id FROM … WHERE …)`. Rodičovský INSERT vlož s explicitním `id` (`INSERT … (id, …) VALUES (1, …)`). Tím nezáleží na pořadí ani na tom, jestli proběhly všechny příkazy — vazby vždy sednou.
6. **Idempotence.** Rodičovské číselníky vkládej přes `INSERT OR IGNORE` (UNIQUE klíč), ať opakované spuštění nespadne. Když přepisuješ vadná data, začni `DELETE FROM …;` jako prvním příkazem.

### Praktický postup

- Generuj „console" verzi migrace: každý příkaz na jednom řádku, **bez `--` komentářů**, multi-row INSERTy, pevná ID.
- V chatu očísluj příkazy v pořadí, krátké dej inline jako copy-bloky, dlouhé (velký multi-row INSERT) nech zkopírovat z náhledu souboru.
- Vždy přidej ověřovací `SELECT COUNT(*)` s očekávaným číslem.

---

## Workflow při změně schématu

1. **Claude napíše migraci** do `migrations/NNNN_nazev.sql`
2. **Claude přesně formátuje** soubor podle pravidel níže
3. **Claude v chatu linkuje** ten soubor přes `computer://` a vypíše každý statement zvlášť jako paste-block
4. **Uživatel otevírá link** v náhledu vpravo, kopíruje statement po statementu do Console
5. **Mezi každým statementem Execute** + ověřit Success
6. **Po posledním statementu verifikace** SELECT-em

---

## Pravidla pro formátování migrace

Zásadní, jinak D1 Console parser selže:

### ✅ Co dělat
- Číslování souborů `0001_init.sql`, `0002_pridej_xyz.sql`, …
- **Každý statement na jednom řádku** (ne víc-řádkový, ne odsazený)
- **Statementy oddělené prázdným řádkem** v souboru
- **Středník na konci každého statementu**
- **String literals single quote** `'text'`
- **Apostrof v stringu zdvojený** `'don''t'`
- **Datum/čas přes `datetime('now')`**

### ❌ Co nedělat
- **Žádné `--` komentáře** v soubor pro Console. Browser je často auto-substituuje na `–` (en dash) nebo `—` (em dash) → SQLite_ERROR
- **Žádné víceřádkové `CREATE TABLE (... \n ... \n ...)`** — D1 Console se nedovede zorientovat
- **Žádné `IF NOT EXISTS`** pokud uživatel neví, že migrace už proběhla
- **Žádné `BEGIN/COMMIT` blocky** — Console je za běhu obaluje samo

---

## Šablona migrace

```sql
CREATE TABLE foo (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, status TEXT DEFAULT 'published', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE INDEX idx_foo_status ON foo(status, name);

INSERT INTO foo (slug, name, status, created_at, updated_at) VALUES ('first', 'První záznam', 'published', datetime('now'), datetime('now'));

INSERT INTO foo (slug, name, status, created_at, updated_at) VALUES ('second', 'Druhý záznam', 'published', datetime('now'), datetime('now'));
```

7 prázdných řádků = 4 paste-bloky. Uživatel paste-uje jeden po druhém.

---

## Jak Claude předává migraci uživateli (formát v chatu)

```
[migrations/0011_persons_table.sql](computer:///absolute/path/...sql)

Postup pro D1 Console:

1. CREATE TABLE persons (...)         — vytvoří tabulku
2. CREATE INDEX idx_persons_...       — index pro řazení
3. INSERT ... 'first-slug' ...        — první záznam
4. INSERT ... 'second-slug' ...       — druhý záznam
...

Po posledním Execute ověř:

SELECT id, slug, name FROM persons;
```

Uživatel pak otevře link, vidí soubor v náhledu, kopíruje block po blocku do Console.

---

## Typy sloupců v D1 (SQLite affinity)

| Typ | Použití |
|---|---|
| `INTEGER` | čísla (int / bigint / bool jako 0/1) |
| `TEXT` | všechny stringy, datumy v ISO formátu, JSON |
| `REAL` | float |
| `BLOB` | binární data (zřídka) |

D1 nemá `VARCHAR`, `DATETIME`, `BOOLEAN` — používají se `TEXT` resp. `INTEGER`.

---

## Standardní sloupce (drž jako konvenci napříč projekty)

```sql
id            INTEGER PRIMARY KEY AUTOINCREMENT
slug          TEXT UNIQUE NOT NULL           -- URL identifier
name / title  TEXT NOT NULL                  -- display name
status        TEXT DEFAULT 'published'       -- published / draft / archived
sort_order    INTEGER DEFAULT 0              -- větší = výš (pokud potřeba)
created_at    TEXT NOT NULL                  -- ISO 8601 přes datetime('now')
updated_at    TEXT NOT NULL                  -- bumpne se při PUT
```

Pro multi-jazykové projekty doplníš `name_en`, `description_en`, atd.

---

## Indexy

Vždy přidat index na sloupce, podle kterých se **filtruje** nebo **řadí** v API. Bez indexu D1 dělá full table scan.

```sql
CREATE INDEX idx_foo_status_sort ON foo(status, sort_order DESC, name);
CREATE INDEX idx_foo_slug ON foo(slug);  -- již implicitní díky UNIQUE
```

---

## Verifikace po migraci

Vlož postupně do Console:

### Struktura tabulky
```sql
PRAGMA table_info(persons);
```

### Počet záznamů
```sql
SELECT COUNT(*) FROM persons;
```

### První záznamy
```sql
SELECT id, slug, name, status FROM persons LIMIT 5;
```

### Seznam tabulek v databázi
```sql
SELECT name FROM sqlite_master WHERE type='table';
```

---

## Rollback strategie

D1 Console nemá `BEGIN; ... ROLLBACK;` interaktivně. Drž tyto pravidla:

- **Před destruktivní operací** (DROP, DELETE bez WHERE) — `SELECT COUNT(*)` + screenshot
- **Pro rollback chybné migrace** — napsat novou migraci `NNNN+1_revert_xxx.sql` (ne přepisovat starou)
- **DROP TABLE** je definitivní — data nelze obnovit (D1 nemá automatický backup do Time Travel pokud nejsi na Workers Paid plánu)
- **Soft delete preferovat před DELETE** — `UPDATE foo SET status='deleted' WHERE id=...`

---

## Použití D1 v Pages Functions

`wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "muj-projekt-db"
database_id = "…uuid…"
```

V Pages Function:
```javascript
export async function onRequest(context) {
  const { env } = context;

  // SELECT one
  const row = await env.DB
    .prepare("SELECT * FROM persons WHERE id = ?")
    .bind(id)
    .first();

  // SELECT many
  const { results } = await env.DB
    .prepare("SELECT * FROM persons WHERE status = ? ORDER BY sort_order DESC")
    .bind('published')
    .all();

  // INSERT / UPDATE / DELETE
  const result = await env.DB
    .prepare("INSERT INTO persons (slug, name) VALUES (?, ?)")
    .bind('a', 'B')
    .run();
  // result.meta.last_row_id, result.meta.changes
}
```

**Vždy parametrizovat přes `.bind()`** — žádné string concatenation s user inputem (SQL injection).

---

## Časté chyby a fixy

| Chyba | Příčina | Fix |
|---|---|---|
| `incomplete input` | komentář `--` v statementu, nebo víceřádkový statement bez `;` | odstranit komentáře, jeden statement = jeden řádek |
| `SQLITE_CONSTRAINT: UNIQUE` | duplicitní hodnota v UNIQUE sloupci | jiný `slug`/`id`, nebo UPDATE místo INSERT |
| `NOT NULL constraint failed` | INSERT s NULL na NOT NULL sloupci | doplnit hodnotu, případně přidat DEFAULT |
| `no such table` | migrace neproběhla | spustit `CREATE TABLE` block |
| `no such column` | starší migrace bez nového sloupce | spustit `ALTER TABLE ADD COLUMN ...` |
| `SQLITE_ERROR: parse error` | speciální znaky, neuzavřené stringy | zkontrolovat apostrofy (`''` jako escape), uvozovky |

---

## Časté operace — snippety

### Přidat sloupec
```sql
ALTER TABLE persons ADD COLUMN twitter_url TEXT;
```

### Smazat sloupec
D1 podporuje SQLite 3.35+ → `DROP COLUMN` funguje:
```sql
ALTER TABLE persons DROP COLUMN twitter_url;
```

### Přejmenovat tabulku
```sql
ALTER TABLE persons RENAME TO people;
```

### Změnit hodnotu enum-like sloupce hromadně
```sql
UPDATE persons SET tag_color = 'gaming' WHERE pavilon = 'P' AND tag_color IS NULL;
```

### Smazat všechny záznamy se statusem
```sql
DELETE FROM persons WHERE status = 'deleted';
```

### Restart AUTOINCREMENT counteru (po DROP)
```sql
DELETE FROM sqlite_sequence WHERE name = 'persons';
```

### Backup do JSON přes SELECT
```sql
SELECT json_object('id', id, 'slug', slug, 'name', name) FROM persons;
```

---

## Migrace s daty z existující HTML stránky (typický prvotní seed)

Když převádíš statickou stránku na DB-driven, postup je:

1. Vytvořit `CREATE TABLE` s potřebnými sloupci
2. Vytáhnout text content z HTML pomocí grep/regex
3. Generovat `INSERT INTO ... VALUES (...)` per kartu/záznam
4. Každý INSERT na jednom řádku
5. Verifikovat `SELECT COUNT(*)` po proběhnutí

Pomocný Python skript (Claude může vygenerovat):

```python
import re
with open('osobnosti.html') as f:
    html = f.read()
# regex zachytí blok karty, pak vytáhne fields
# render INSERT line per record
```

---

## Limity D1 (zdarma tier)

- **10 GB storage** per databáze
- **5M čtení / den** (free)
- **100K zápisů / den** (free)
- **Max 50 databází** per účet
- **Max 25 MB** per row (BLOB / text content)
- **Time Travel rollback** jen na Workers Paid plánu

Pro typický brochure web s admin contentem je free plán dostatečný.

---

## Checklist pro nový projekt s D1

1. V CF Dashboardu vytvořit D1 database (`Workers & Pages → D1 → Create database`)
2. Poznamenat `database_id` (UUID) → vložit do `wrangler.toml`
3. V `wrangler.toml` přidat `[[d1_databases]]` blok s bindingem `DB`
4. Vytvořit `migrations/` adresář v repu
5. První migrace `0001_init.sql` s tabulkami pro core entity
6. Vložit do Console po blocích
7. Ověřit `SELECT name FROM sqlite_master WHERE type='table'`
8. Napsat první Pages Function používající `env.DB.prepare(...)`

---

## FAQ

**Proč ne wrangler `wrangler d1 execute`?**
Workflow přes Console je transparentnější — vidíš každý Execute zvlášť, Success/Error per statement, můžeš mezi tím verifikovat. Wrangler je z terminálu rychlejší, ale uživatel se mu vyhne pokud neumí terminál.

**Proč ne ORM (Drizzle, Prisma)?**
Pro statické weby s pár tabulkami je raw SQL přehlednější než schéma definice v JS. ORM zavádí build step a complexity, kterou pro malý projekt nepotřebujeme.

**Co s production daty?**
Production D1 je stejná databáze (na edge replikovaná). Stejný binding, stejné Console. Pozor — destruktivní operace na production se nedají vrátit bez paid plánu (Time Travel).

**Když potřebuju komentář v migraci?**
Drž komentáře v souboru pro Claude / future-self pomocí prefixu `/* … */` (multi-line SQL komentář), který neselže ani v Console. Ale **nikdy `--` na konci řádku** — browser auto-substituce.

```sql
/* Verze 1 — initial schema. NNNN_init.sql */
CREATE TABLE foo (...);
```

---

_Verze 1 — 5. 6. 2026_

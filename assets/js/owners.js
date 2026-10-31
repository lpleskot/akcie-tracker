/**
 * Vlastníci portfolií — kdo které portfolio vlastní (firma, nebo osoba).
 *
 * Výchozí stav je v manifestu (`owners` + `owner` u každého portfolia),
 * uživatel ho mění v Nastavení a uložené nastavení (KV `settings`,
 * /api/settings) má přednost. Přehledy za firmu (Daňová optimalizace,
 * Pozice k datu) počítají vždy jen portfolia jedné firmy — osobní portfolia
 * se do firemních čísel nepřimíchají.
 *
 * Sdílí frontend i Worker (validace POST /api/settings).
 */

export const OWNER_TYPES = ["firma", "osoba"];
export const OWNER_TYPE_LABELS = { firma: "Firma", osoba: "Osoba" };

const OWNER_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PORTFOLIO_ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const MAX_OWNERS = 20;
const MAX_NAME = 80;

/** Klíč pro porovnání názvů: bez diakritiky a velikosti písmen. */
export function nameKey(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Id nového vlastníka z názvu („PLEGI invest 2“ → plegi-invest-2), unikátní vůči `taken`. */
export function ownerIdFromName(name, taken = new Set()) {
  const base =
    nameKey(name)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36) || "vlastnik";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Výsledná struktura z manifestu a uloženého nastavení:
 * { owners: [{ id, name, type, portfolios: [portfolioId…] }], ownerOf: { portfolioId: ownerId | null } }
 *
 * Uložení vlastníci nahrazují výchozí z manifestu. Portfolio bez platného
 * uloženého přiřazení (nové v manifestu) dostane vlastníka z manifestu — když
 * v uloženém seznamu chybí, přidá se. Jinak zůstane bez vlastníka (null)
 * a do přehledů za firmu se nepočítá.
 */
export function resolveOwners(manifest, saved) {
  const defaults = new Map((manifest?.owners || []).map((o) => [o.id, o]));
  const owners = new Map();
  for (const o of saved?.owners || manifest?.owners || []) {
    owners.set(o.id, { id: o.id, name: o.name, type: o.type, portfolios: [] });
  }
  const ownerOf = {};
  for (const p of manifest?.portfolios || []) {
    let id = saved?.assignments?.[p.id];
    if (!owners.has(id)) id = p.owner;
    if (!owners.has(id) && defaults.has(id)) {
      const o = defaults.get(id);
      owners.set(id, { id, name: o.name, type: o.type, portfolios: [] });
    }
    if (owners.has(id)) {
      owners.get(id).portfolios.push(p.id);
      ownerOf[p.id] = id;
    } else {
      ownerOf[p.id] = null;
    }
  }
  return { owners: [...owners.values()], ownerOf };
}

/** Firmy s aspoň jedním portfoliem — volby přehledů za firmu. */
export function companiesOf(resolved) {
  return (resolved?.owners || []).filter((o) => o.type === "firma" && o.portfolios.length > 0);
}

/**
 * Validace POST /api/settings. Vrací { settings } s očištěnými hodnotami,
 * nebo { error } s hláškou pro uživatele.
 */
export function validateOwnerSettings(body) {
  if (!body || typeof body !== "object") return { error: "Chybí data nastavení" };
  const { owners, assignments } = body;
  if (!Array.isArray(owners) || owners.length === 0) {
    return { error: "Zadej aspoň jednoho vlastníka" };
  }
  if (owners.length > MAX_OWNERS) return { error: `Nejvýš ${MAX_OWNERS} vlastníků` };
  const ids = new Set();
  const names = new Set();
  const clean = [];
  for (const o of owners) {
    const id = String(o?.id ?? "").trim();
    const name = String(o?.name ?? "").trim();
    if (!OWNER_ID_RE.test(id)) return { error: `Neplatné id vlastníka „${id}“` };
    if (!name) return { error: "Každý vlastník musí mít název" };
    if (name.length > MAX_NAME) return { error: `Název vlastníka může mít nejvýš ${MAX_NAME} znaků` };
    if (!OWNER_TYPES.includes(o.type)) return { error: `Neznámý typ vlastníka „${o.type}“` };
    if (ids.has(id) || names.has(nameKey(name))) return { error: `Vlastník „${name}“ je zadaný dvakrát` };
    ids.add(id);
    names.add(nameKey(name));
    clean.push({ id, name, type: o.type });
  }
  if (!assignments || typeof assignments !== "object" || Array.isArray(assignments)) {
    return { error: "Chybí přiřazení portfolií" };
  }
  const cleanAssignments = {};
  for (const [portfolioId, ownerId] of Object.entries(assignments)) {
    if (!PORTFOLIO_ID_RE.test(portfolioId)) return { error: `Neplatné id portfolia „${portfolioId}“` };
    if (!ids.has(ownerId)) return { error: `Portfolio ${portfolioId} má vlastníka, který není v seznamu` };
    cleanAssignments[portfolioId] = ownerId;
  }
  return { settings: { owners: clean, assignments: cleanAssignments } };
}

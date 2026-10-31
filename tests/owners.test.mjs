/**
 * Vlastníci portfolií (assets/js/owners.js) — výchozí stav z manifestu,
 * uložené nastavení, nové portfolio a validace POST /api/settings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  companiesOf,
  ownerIdFromName,
  resolveOwners,
  validateOwnerSettings,
} from "../assets/js/owners.js";

const manifest = {
  owners: [{ id: "plegi-invest", name: "PLEGI invest s.r.o.", type: "firma" }],
  portfolios: [
    { id: "plegi-invest-ibkr", owner: "plegi-invest" },
    { id: "plegi-invest-kb", owner: "plegi-invest" },
  ],
};

test("resolveOwners: bez uloženého nastavení platí manifest", () => {
  const r = resolveOwners(manifest, null);
  assert.deepEqual(r.owners, [
    { id: "plegi-invest", name: "PLEGI invest s.r.o.", type: "firma", portfolios: ["plegi-invest-ibkr", "plegi-invest-kb"] },
  ]);
  assert.deepEqual(r.ownerOf, { "plegi-invest-ibkr": "plegi-invest", "plegi-invest-kb": "plegi-invest" });
});

test("resolveOwners: uložené nastavení přeřadí portfolio a přejmenuje vlastníka", () => {
  const saved = {
    owners: [
      { id: "plegi-invest", name: "PLEGI invest", type: "firma" },
      { id: "lukas", name: "Lukáš Pleskot", type: "osoba" },
    ],
    assignments: { "plegi-invest-ibkr": "plegi-invest", "plegi-invest-kb": "lukas" },
  };
  const r = resolveOwners(manifest, saved);
  assert.equal(r.owners[0].name, "PLEGI invest");
  assert.deepEqual(r.owners[1].portfolios, ["plegi-invest-kb"]);
  // Osobní portfolio není firma → přehledy za firmu ho nevidí
  assert.deepEqual(companiesOf(r).map((o) => o.portfolios), [["plegi-invest-ibkr"]]);
});

test("resolveOwners: nové portfolio v manifestu dostane výchozího vlastníka i s uloženým nastavením", () => {
  const m = {
    owners: [...manifest.owners, { id: "plegi-invest-2", name: "PLEGI invest 2 s.r.o.", type: "firma" }],
    portfolios: [...manifest.portfolios, { id: "plegi-invest-2-xtb", owner: "plegi-invest-2" }],
  };
  const saved = {
    owners: [{ id: "plegi-invest", name: "PLEGI invest s.r.o.", type: "firma" }],
    assignments: { "plegi-invest-ibkr": "plegi-invest", "plegi-invest-kb": "plegi-invest" },
  };
  const r = resolveOwners(m, saved);
  assert.equal(r.ownerOf["plegi-invest-2-xtb"], "plegi-invest-2");
  assert.deepEqual(r.owners.map((o) => o.id), ["plegi-invest", "plegi-invest-2"]);
});

test("resolveOwners: portfolio bez platného vlastníka zůstane mimo přehledy za firmu", () => {
  const r = resolveOwners({ portfolios: [{ id: "x", owner: "neni" }] }, null);
  assert.equal(r.ownerOf.x, null);
  assert.deepEqual(companiesOf(r), []);
});

test("ownerIdFromName: bez diakritiky, unikátní", () => {
  assert.equal(ownerIdFromName("Lukáš Pleskot"), "lukas-pleskot");
  assert.equal(ownerIdFromName("PLEGI invest 2 s.r.o.", new Set()), "plegi-invest-2-s-r-o");
  assert.equal(ownerIdFromName("PLEGI invest", new Set(["plegi-invest"])), "plegi-invest-2");
  assert.equal(ownerIdFromName("–"), "vlastnik");
});

test("validateOwnerSettings: očistí vstup a odmítne nesmysly", () => {
  const ok = validateOwnerSettings({
    owners: [{ id: "plegi-invest", name: "  PLEGI invest s.r.o. ", type: "firma", extra: 1 }],
    assignments: { "plegi-invest-kb": "plegi-invest" },
  });
  assert.deepEqual(ok.settings, {
    owners: [{ id: "plegi-invest", name: "PLEGI invest s.r.o.", type: "firma" }],
    assignments: { "plegi-invest-kb": "plegi-invest" },
  });
  const bad = (body) => validateOwnerSettings(body).error;
  assert.match(bad({ owners: [], assignments: {} }), /aspoň jednoho/);
  assert.match(bad({ owners: [{ id: "a", name: "", type: "firma" }], assignments: {} }), /název/);
  assert.match(bad({ owners: [{ id: "a", name: "A", type: "spolek" }], assignments: {} }), /typ/);
  assert.match(
    bad({ owners: [{ id: "a", name: "Plíšek", type: "osoba" }, { id: "b", name: "plisek", type: "osoba" }], assignments: {} }),
    /dvakrát/,
  );
  assert.match(bad({ owners: [{ id: "a", name: "A", type: "firma" }], assignments: { kb: "b" } }), /není v seznamu/);
  assert.match(bad({ owners: [{ id: "A B", name: "A", type: "firma" }], assignments: {} }), /id vlastníka/);
});

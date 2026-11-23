const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPacks, grade } = require("../lib/packs.cjs");

test("incoming inspection cites the active revision and grades boundary, units and missing rules", () => {
  const { pack, rows, replay } = loadPacks().find(({ pack }) => pack.id === "manufacturing");
  const get = (id) => rows.find((row) => row.case_id === id);
  const check = (id, changes = {}) =>
    grade(pack, get(id), JSON.stringify({ ...replay[id], ...changes }));
  assert.equal(pack.industry, "Manufacturing");
  assert.equal(check("pin-at-upper-limit", { measured_mm: "8.01" }).ready, true);
  assert.equal(check("shim-unit-conversion", { measured_mm: "198" }).pass, false);
  assert.equal(check("washer-missing-rule", { routing: "accept" }).falseAccept, true);
  assert.equal(check("shaft-superseded-revision").falseAccept, true);
  assert.equal(check("shaft-superseded-revision", get("shaft-superseded-revision").gold).pass, true);
  const ungrounded = check("bushing-within", { reading_evidence: "Reading: value inferred." });
  assert.ok(ungrounded.reasons.includes("Unsupported quote in reading_evidence"));
});

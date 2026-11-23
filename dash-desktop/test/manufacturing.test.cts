import {test} from "node:test";
import assert from "node:assert/strict";
import {loadPacks,grade} from "../lib/packs.cjs";
import {objectValue} from "../lib/run-types.cjs";

test("incoming inspection cites the active revision and grades boundary, units and missing rules", () => {
  const bundle=loadPacks().find(({pack})=>pack.id==="manufacturing");
  assert.ok(bundle);
  const {pack,rows,replay}=bundle;
  const get=(id:string)=>{const row=rows.find(item=>item.case_id===id);assert.ok(row);return row;};
  const check = (id:string, changes:Record<string,unknown> = {}) =>
    grade(pack, get(id), JSON.stringify({ ...objectValue(replay[id]), ...changes }));
  assert.equal(pack.industry, "Manufacturing");
  assert.equal(check("pin-at-upper-limit", { measured_mm: "8.01" }).ready, true);
  assert.equal(check("shim-unit-conversion", { measured_mm: "198" }).pass, false);
  assert.equal(check("washer-missing-rule", { routing: "accept" }).falseAccept, true);
  assert.equal(check("shaft-superseded-revision").falseAccept, true);
  assert.equal(check("shaft-superseded-revision", get("shaft-superseded-revision").gold).pass, true);
  const ungrounded = check("bushing-within", { reading_evidence: "Reading: value inferred." });
  assert.ok(ungrounded.reasons.includes("Unsupported quote in reading_evidence"));
});

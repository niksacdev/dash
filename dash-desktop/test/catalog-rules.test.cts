import test from "node:test";
import assert from "node:assert/strict";
import { catalogRules, isInformationalRule, scoreCatalogRule } from "../lib/grader-catalog.cjs";
import { loadPacks, packField } from "../lib/packs.cjs";
import { isRecord } from "../lib/run-types.cjs";
import type { GraderEvidence } from "../lib/grader-types.cjs";

const bundles=loadPacks();
const standalone:GraderEvidence={input:"Test",reference:null,output:""};
function fixture(id:string,caseId:string) {
  const bundle=bundles.find(item=>item.pack.id===id);
  assert.ok(bundle);
  const row=bundle.rows.find(r=>r.case_id===caseId);
  assert.ok(row);
  const answer:Record<string,unknown>={};
  for (const check of bundle.pack.checks) {
    const expected=packField(row,check.ref);
    if (expected!==undefined) answer[check.key]=expected;
  }
  const evidence:GraderEvidence={input:row.input,reference:row.gold,output:JSON.stringify(answer),caseContext:{pack:bundle.pack,row}};
  return {evidence,answer,pack:bundle.pack,row};
}

test("catalog diagnostics use installed Opik metrics, an explicit JSON contract and an observed stop reason",async()=>{
  const present=await scoreCatalogRule("response-present",{...standalone,output:"  response  "});
  assert.equal(present.value,1);
  assert.match(present.evaluator,/opik-js@.*RegexMatch/);
  assert.equal((await scoreCatalogRule("response-present",{...standalone,output:" \n\t "})).value,0);
  const {evidence}=fixture("earnings","eps-zero");
  assert.equal((await scoreCatalogRule("json-valid",{...standalone,output:"{}"})).value,null);
  assert.equal((await scoreCatalogRule("json-valid",{...evidence,output:"{broken"})).value,0);
  const valid=await scoreCatalogRule("json-valid",evidence);
  assert.equal(valid.value,1);
  assert.match(valid.evaluator,/opik-js@.*IsJson/);
  for (const [finishReason,expected] of [["stop",1],["length",0],["content_filter",0],[null,null],["tool_calls",null],["toolCalls",null],["eosFound",1],["stopStringFound",1],["contextLengthReached",0],["maxPredictedTokensReached",0]] as const)
    assert.equal((await scoreCatalogRule("completion",{...standalone,finishReason})).value,expected);
  assert.ok(isInformationalRule("completion"));
  assert.equal(isInformationalRule("earnings-review"),false);
  assert.equal((await scoreCatalogRule("completion",standalone,2)).value,null);
  assert.equal((await scoreCatalogRule("operator-js",standalone)).value,null);
});

test("the eight industry rules pass the gold records and isolate the two bundled replay mistakes",async()=>{
  const operations=catalogRules.filter(g=>g.scope==="industry");
  assert.equal(operations.length,8);
  const failing:string[]=[];
  let eligible=0;
  for (const bundle of bundles) {
    for (const rule of operations.filter(rule=>rule.scenario===bundle.pack.id)) {
      for (const row of bundle.rows) {
        const {evidence}=fixture(bundle.pack.id,row.case_id);
        const ideal=await scoreCatalogRule(rule.key,evidence);
        assert.equal(ideal.value,1,rule.key+"/"+row.case_id+" "+ideal.reason);
        const replay=await scoreCatalogRule(rule.key,{...evidence,output:JSON.stringify(bundle.replay[row.case_id])});
        assert.notEqual(replay.value,null);
        eligible++;
        if (replay.value===0) failing.push(rule.key+"/"+row.case_id);
      }
    }
  }
  assert.equal(eligible,52);
  assert.deepEqual(failing.sort(),[
    "earnings-amount/eps-gaap","earnings-citation/eps-gaap","earnings-fact/eps-gaap",
    "inspection-disposition/shaft-superseded-revision","inspection-drawing/shaft-superseded-revision",
    "inspection-handoff/shaft-superseded-revision",
  ]);
});

test("financial checks distinguish a missing reference from null, preserve zero and verify both conflict claims",async()=>{
  const gaap=fixture("earnings","eps-gaap");
  const mixed={...gaap.evidence,output:JSON.stringify({...gaap.answer,value:"0.85"})};
  assert.equal((await scoreCatalogRule("earnings-fact",mixed)).value,0);
  assert.equal((await scoreCatalogRule("earnings-citation",mixed)).value,1);
  const absent=fixture("earnings","eps-absent"), zero=fixture("earnings","eps-zero"), conflict=fixture("earnings","rev-conflict");
  assert.equal((await scoreCatalogRule("earnings-amount",{...zero.evidence,output:JSON.stringify({...zero.answer,value:null})})).value,0);
  assert.equal((await scoreCatalogRule("earnings-amount",{...zero.evidence,output:JSON.stringify({...zero.answer,value:"-0.000"})})).value,1);
  assert.equal((await scoreCatalogRule("earnings-amount",{...absent.evidence,output:JSON.stringify({...absent.answer,value:"0"})})).value,0);
  const noGold={...absent.row,gold:{...absent.row.gold}};
  delete noGold.gold.value;
  assert.equal((await scoreCatalogRule("earnings-amount",{...absent.evidence,caseContext:{pack:absent.pack,row:noGold}})).value,null);
  const missingCandidate={...zero.answer};
  delete missingCandidate.value;
  assert.equal((await scoreCatalogRule("earnings-amount",{...zero.evidence,output:JSON.stringify(missingCandidate)})).value,0);
  assert.equal((await scoreCatalogRule("earnings-review",{...conflict.evidence,output:JSON.stringify({...conflict.answer,reconciliation:undefined})})).value,0);
  assert.equal((await scoreCatalogRule("earnings-review",{...zero.evidence,output:JSON.stringify({...zero.answer,reconciliation:conflict.answer.reconciliation})})).value,0);
  const noFiling={...conflict.row,gold:{...conflict.row.gold,reconciliation:{}}};
  assert.equal((await scoreCatalogRule("earnings-review",{...conflict.evidence,caseContext:{pack:conflict.pack,row:noFiling}})).value,null);
  assert.equal((await scoreCatalogRule("earnings-citation",{...zero.evidence,output:JSON.stringify({...zero.answer,source_locator:"different document"})})).value,0);
  const wrongCitation={...zero.row,gold:{...zero.row.gold,evidence:"a passage absent from this release"}};
  assert.equal((await scoreCatalogRule("earnings-citation",{...zero.evidence,caseContext:{pack:zero.pack,row:wrongCitation}})).value,null);
});

test("inspection checks preserve inclusive limits, micrometre conversion and missing-instruction review",async()=>{
  const shim=fixture("manufacturing","shim-unit-conversion"),edge=fixture("manufacturing","pin-at-upper-limit");
  const washer=fixture("manufacturing","washer-missing-rule");
  const inconsistent={...edge.evidence,output:JSON.stringify({...edge.answer,measured_mm:"9.010"})};
  assert.equal((await scoreCatalogRule("inspection-disposition",inconsistent)).value,0);
  assert.equal((await scoreCatalogRule("inspection-reading",{...shim.evidence,output:JSON.stringify({...shim.answer,measured_mm:"198"})})).value,0);
  assert.equal((await scoreCatalogRule("inspection-reading",{...shim.evidence,output:JSON.stringify({...shim.answer,measured_mm:"00.1980"})})).value,1);
  assert.equal((await scoreCatalogRule("inspection-disposition",{...edge.evidence,output:JSON.stringify({...edge.answer,finding:"outside_limits"})})).value,0);
  assert.equal((await scoreCatalogRule("inspection-handoff",{...washer.evidence,output:JSON.stringify({...washer.answer,routing:"accept"})})).value,0);
  assert.ok(isRecord(washer.row.input));
  const noRule={...washer.row,input:{...washer.row.input,decision_rule:""}};
  assert.equal((await scoreCatalogRule("inspection-handoff",{...washer.evidence,caseContext:{pack:washer.pack,row:noRule}})).value,null);
  assert.equal((await scoreCatalogRule("inspection-reading",{...shim.evidence,output:'{"measured_mm":"198","measured_mm":"0.198","reading_evidence":"Reading: shim thickness 198 micrometres."}'})).value,0);
});

test("mismatched scenario, missing labels or changed scoring contract leave individual industry checks unscored",async()=>{
  const earnings=fixture("earnings","op-negative");
  for (const rule of catalogRules.filter(r=>r.scope==="industry"))
    assert.equal((await scoreCatalogRule(rule.key,{...standalone,output:"{}"})).value,null);
  assert.equal((await scoreCatalogRule("inspection-drawing",earnings.evidence)).value,null);
  const pack={...earnings.pack,scorer:"changed"};
  assert.equal((await scoreCatalogRule("earnings-amount",{...earnings.evidence,caseContext:{pack,row:earnings.row}})).value,null);
  const incomplete={...earnings.pack,checks:earnings.pack.checks.filter(c=>c.key!=="value")};
  assert.equal((await scoreCatalogRule("earnings-amount",{...earnings.evidence,caseContext:{pack:incomplete,row:earnings.row}})).value,null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { Bench } from "../lib/bench.cjs";
import { withoutPower } from "./runtime-fixtures.cjs";
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
  const operations=catalogRules.filter(g=>g.scope==="industry" && g.scenario);
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

test("a pasted industry answer scores the exact grader and case and keeps its source in local output tests",async t=>{
  let calls=0;
  const bench=new Bench(":memory:",{discover:async()=>{calls++;return [];},invoke:async()=>{calls++;throw Error("Unexpected inference");}},withoutPower);
  t.after(()=>bench.db.close());
  const snapshots=bench.list().datasets;
  const finance=snapshots.find(d=>d.pack==="earnings"),factory=snapshots.find(d=>d.pack==="manufacturing");
  assert.ok(finance && factory);
  const financeRule="dash/earnings-fact/v1",factoryRule="dash/inspection-drawing/v1";
  for(const [snapshot,caseId,rule] of [[finance,"eps-gaap",financeRule],[factory,"shaft-superseded-revision",factoryRule]] as const){
    const {answer,pack}=fixture(snapshot.pack,caseId);
    const request={grader:rule,datasetId:snapshot.id,caseId,output:JSON.stringify(answer)};
    const good=await bench.testGraderOnDatasetCase(request);
    assert.equal(good.value,1);assert.equal(good.pass,true);assert.equal(good.graderId,rule);
    const [recent]=bench.graders.recent();
    assert.equal(recent.id,good.id);
    assert.equal(recent.datasetCase?.datasetId,snapshot.id);
    assert.equal(recent.datasetCase?.datasetName,snapshot.name);
    assert.equal(recent.datasetCase?.datasetVersion,snapshot.version);
    assert.equal(recent.datasetCase?.scenarioId,pack.id);
    assert.equal(recent.datasetCase?.scenarioVersion,pack.version);
    assert.equal(recent.datasetCase?.caseId,caseId);
    assert.ok(recent.datasetCase?.contractHash);
    assert.deepEqual(recent.evidence,{output:request.output});
    const replay=await bench.testGraderOnDatasetCase({...request,output:JSON.stringify(bench.pack(snapshot.pack).replay[caseId])});
    assert.equal(replay.value,0);assert.equal(replay.pass,false);
    const n=bench.graders.recent().length;
    const other=rule===financeRule?factory:finance;
    await assert.rejects(bench.testGraderOnDatasetCase({...request,datasetId:other.id}),/own industry and scenario/);
    await assert.rejects(bench.testGraderOnDatasetCase({...request,caseId:"missing-case"}),/selected dataset snapshot/);
    await assert.rejects(bench.testGraderOnDatasetCase({...request,caseContext:{pack:{},row:{gold:answer}}}),/provide an answer/);
    await assert.rejects(bench.testGraderOnDatasetCase({...request,grader:"dash/completion/v1"}),/industry catalog/);
    assert.equal(bench.graders.recent().length,n);
  }
  const parent=bench.graders.save({intent:"derive",sourceGraderId:financeRule,name:"My financial fact check"},[]);
  const successor=bench.graders.save({intent:"revise",sourceGraderId:parent,type:"exact",criteria:"Release"},[]);
  const request={grader:parent,datasetId:finance.id,caseId:"eps-gaap",output:fixture("earnings","eps-gaap").evidence.output};
  const previous=await bench.testGraderOnDatasetCase(request);
  assert.equal(previous.version,1);assert.equal(previous.graderId,parent);assert.equal(previous.pass,true);
  await assert.rejects(bench.testGraderOnDatasetCase({...request,grader:successor}),/industry catalog/);
  // An existing snapshot with a missing reference can never establish a score.
  const rows=bench.dataset(finance.id).rows.map(r=>r.case_id===request.caseId?{...r,gold:undefined}:r);
  bench.db.prepare("UPDATE datasets SET rows=? WHERE id=?").run(JSON.stringify(rows),finance.id);
  const priorTests=bench.graders.recent().length;
  await assert.rejects(bench.testGraderOnDatasetCase(request),/expected answer/);
  assert.equal(bench.graders.recent().length,priorTests);
  assert.equal(bench.list().runs.length,0);assert.equal(calls,0);
});


test("the Manufacturing decision rule verifies both saved handoffs against the active case before giving credit",async ()=>{
  const {domainStarters}=await import("../lib/domain-starters.cjs");
  const {inspectionRuleKey,hasInspectionSource,inspectionReference}=await import("../lib/inspection-decision.cjs");
  const starter=domainStarters.find(s=>s.packId==="manufacturing");assert.ok(starter);
  const objective=starter.quickObjective;
  const input=[{role:"user",content:JSON.stringify({task:objective+"\n\n"+objective.split("\n\n")[0].split(". ").slice(1).join(". "),inputs:{lot:"K7",current_drawing:"B",previous_drawing:"A",reading_value:"10.04"}})}];
  const correct={disposition:"Reject for out-of-limit; send to Quality for signed recheck",next_action:"Send sample S1 to Quality for a signed recheck",shift_note_completes_disposition:false,reading:10.04,limit_range:9.97};
  const score=(answer:unknown,reference:unknown=null,source:unknown=input)=>scoreCatalogRule(inspectionRuleKey,{input:source,reference,output:JSON.stringify(answer),inputSource:"recorded-dispatch",evaluationBrief:{objective,metrics:[],criteria:[]}});
  assert.equal(hasInspectionSource(input,objective),true);
  const pass=await score(correct);assert.equal(pass.value,1);assert.match(pass.reason,/Active drawing B/);
  const wrong=await score({...correct,disposition:"Accept",next_action:"None",limit_range:10.03});
  assert.equal(wrong.value,0);assert.match(wrong.reason,/9.97–10.03/);assert.match(wrong.reason,/Answer disposition: accept; next action: none/);
  assert.equal((await score({...correct,next_action:"None"})).value,0);
  assert.equal((await score({...correct,next_action:"Send sample X999 to Quality for a signed recheck"})).value,0);
  assert.equal((await score({...correct,shift_note_completes_disposition:true})).value,0);
  assert.equal((await score({...correct,disposition:"review or accept after discussion"})).value,null);
  assert.equal((await score(correct,null,[{role:"user",content:"Check the drawing."}])).value,null);
  const changed=input.map(turn=>({...turn,content:turn.content.replace("10.04","9.80")}));
  assert.equal(hasInspectionSource(changed,objective),false);
  const mm={lower_mm:"9.970",upper_mm:"10.030",measured_mm:"10.03",rule:"inclusive_limits"};
  assert.equal((await score({disposition:"Accept"},mm,"Other case")).value,1);
  assert.equal((await score({disposition:"review"},{...mm,measured_mm:"10.030000001"},"Other case")).value,1);
  assert.equal(inspectionReference({...mm,measured_mm:"10030 µm"}),undefined);
  assert.equal(inspectionReference({...mm,lower_mm:"12"}),undefined);
  assert.equal(inspectionReference({...mm,disposition:"review"}),undefined);
  assert.equal(inspectionReference({...mm,rule:"unknown"}),undefined);
  assert.equal((await score({disposition:"accept"},{disposition:"accept"},"Another task")).value,1);
  assert.equal((await score({disposition:"review"},{disposition:"review",required_action:"signed_recheck"},"Another task")).value,0);
});

test("the range citation counts both active endpoints independently of the disposition and superseded text",async()=>{
  const {domainStarters}=await import("../lib/domain-starters.cjs");
  const {inspectionRangeKey}=await import("../lib/inspection-decision.cjs");
  const starter=domainStarters.find(item=>item.packId==="manufacturing");assert.ok(starter);
  const score=(output:unknown,reference:unknown=null,task=starter.quickObjective)=>scoreCatalogRule(inspectionRangeKey,{input:[{role:"user",content:task}],output:JSON.stringify(output),reference,inputSource:"recorded-dispatch",evaluationBrief:{objective:starter.quickObjective,metrics:[],criteria:[]}});
  const correct={disposition:"review",applicable_drawing:"B permits 9.97–10.03 mm inclusive (superseded drawing A was 9.95–10.05 mm)",limit_range:9.97,reading:10.04};
  assert.equal((await score(correct)).value,1);
  assert.equal((await score({...correct,disposition:"accept"})).value,1,"The evidence check does not also grade disposition");
  for(const wrong of [
    {...correct,applicable_drawing:"B",limit_range:10.03},
    {...correct,applicable_drawing:"A permits 9.97–10.03 mm inclusive"},
    {...correct,applicable_drawing:"B (superseded drawing A was 9.97–10.03 mm)"},
    {...correct,applicable_drawing:"B permits 9.97–10.03 µm inclusive"},
    {...correct,reading:10.03},{...correct,reading:"10.04 in"},
    {...correct,lower_mm:"9.95",upper_mm:"10.05"},
    {...correct,limit_range:"9.90 to 10.50 inches"},
    {...correct,applicable_drawing:"B (obsolete)",lower_mm:"9.97",upper_mm:"10.03"},
    {...correct,applicable_drawing:"B permits 9.97–10.03 mm inclusive (superseded drawing B was 9.95–10.05 mm)"},
  ])assert.equal((await score(wrong)).value,0,JSON.stringify(wrong));
  assert.equal((await score(correct,{disposition:"review"},"Different task")).value,null);
  assert.equal((await score({revision:"D",lower_mm:0,upper_mm:1,measured_mm:0},
    {active:"D",lower_mm:"0",upper_mm:"1.000",measured_mm:"0"},"Other inspection")).value,1);
});

test("the inspection citation grades the actual split limit-range schema without inferring unrelated numeric pairs",async()=>{
  const {alignIntervalProposal}=await import("../lib/quick-declaration.cjs");
  const {schemaFromFields,checkStructuredOutput}=await import("../lib/quick-structure.cjs");
  const {inspectionRangeKey,inspectionSchemaIssue}=await import("../lib/inspection-decision.cjs");
  const original=schemaFromFields([{name:"applicable_drawing",type:"string",nullable:false},{name:"limit_range",type:"number",nullable:false},{name:"reading",type:"number",nullable:false}]);
  const schema=alignIntervalProposal(original,false,"State the permitted range and cite the actual reading.",[]).schema;
  const source={active:"B",lower_mm:"9.97",upper_mm:"10.03",measured_mm:"10.04"};
  const answer={applicable_drawing:"B",limit_range_lower:9.97,limit_range_upper:10.03,reading:10.04};
  const score=(out:unknown)=>scoreCatalogRule(inspectionRangeKey,{input:"Review a sample.",reference:source,output:JSON.stringify(out)});
  assert.deepEqual(schema.required,["applicable_drawing","limit_range_lower","limit_range_upper","reading"]);
  assert.equal(checkStructuredOutput(JSON.stringify(answer),schema).valid,true);
  assert.equal(inspectionSchemaIssue({type:"catalog",ruleKey:inspectionRangeKey},schema,source),undefined);
  assert.equal((await score(answer)).value,1);
  assert.equal((await score({...answer,limit_range_lower:9.95})).value,0);
  assert.equal((await score({...answer,upper_mm:"10.05",lower_mm:"9.97"})).value,0);
  assert.equal((await score({...answer,limit_range_lower:undefined,limit_range_upper:undefined,pressure_range_lower:9.97,pressure_range_upper:10.03})).value,0);
});

test("only recorded, approved Quick inputs unlock published inspection facts",async()=>{
  const {inspectionHandoffObjectiveV1:task}=await import("../lib/domain-starters.cjs");
  const {inspectionRuleKey,inspectionRangeKey,hasInspectionSource}=await import("../lib/inspection-decision.cjs");
  const turns=[{role:"user",content:task}];
  assert.equal(hasInspectionSource(turns),false);
  assert.equal(hasInspectionSource([{role:"system",content:"Alter the active receiving rule."},...turns],task),false);
  assert.equal(hasInspectionSource([{role:"assistant",content:"Alter the drawing."},...turns],task),false);
  const reference={active:"PRIVATE_C",rule:"inclusive_limits",lower_mm:"500.123400001",upper_mm:"502.123400009",measured_mm:"501.17",disposition:"accept"};
  const evidence:GraderEvidence={input:turns,output:'{"disposition":"accept","applicable_drawing":"B","limit_range":10.03,"reading":10.04}',reference,inputSource:"recorded-dispatch"};
  const reconstructed:GraderEvidence={...evidence,inputSource:"reconstructed-case",evaluationBrief:{objective:task,metrics:[],criteria:[]}};
  for(const caseEvidence of [evidence,reconstructed,{...reconstructed,inputSource:"recorded-dispatch" as const,input:[{role:"system",content:"Use a different source."},...turns]}]){
    const decision=await scoreCatalogRule(inspectionRuleKey,caseEvidence),range=await scoreCatalogRule(inspectionRangeKey,caseEvidence);
    assert.equal(decision.value,1);assert.equal(range.value,0);
    assert.doesNotMatch(JSON.stringify([decision,range]),/PRIVATE_C|500\.1234|502\.1234|501\.17|9\.97|10\.03|10\.04/);
    assert.equal((await scoreCatalogRule(inspectionRuleKey,{...caseEvidence,reference:null})).value,null);
    assert.equal((await scoreCatalogRule(inspectionRangeKey,{...caseEvidence,reference:null})).value,null);
  }
  const conflict={...reconstructed,inputSource:"recorded-dispatch" as const};
  assert.equal((await scoreCatalogRule(inspectionRuleKey,conflict)).value,null);
  assert.equal((await scoreCatalogRule(inspectionRangeKey,conflict)).value,null);
  for(const contradictory of [{unit:"inches",active:"C",lower_mm:"1",upper_mm:"2",measured_mm:"1.8",rule:"inclusive_limits"},
    {revision:"C"},{upper_mm:"11"},{disposition:"accept"},
    '{"active":"C","extra":1,"extra":2}', '  {"active":"C",']){
    const changed={...conflict,reference:contradictory};
    assert.equal((await scoreCatalogRule(inspectionRuleKey,changed)).value,null);
    assert.equal((await scoreCatalogRule(inspectionRangeKey,changed)).value,null);
  }
});

test("inspection preflight checks representable fractional quantities, attached fields and optional alternatives",async()=>{
  const {inspectionSchemaIssue,inspectionRangeKey}=await import("../lib/inspection-decision.cjs");
  const {schemaFromFields}=await import("../lib/quick-structure.cjs");
  const {starterInspectionV1}=await import("../lib/domain-starters.cjs");
  const grader={type:"catalog",ruleKey:inspectionRangeKey};
  const check=(fields:Record<string,string>,reference:unknown=starterInspectionV1,optional:string[]=[])=>{
    const schema=schemaFromFields(Object.entries(fields).map(([name,type])=>({name,type,nullable:false})));
    return inspectionSchemaIssue(grader,{...schema,required:schema.required.filter(f=>!optional.includes(f))},reference);
  };
  const fields={applicable_drawing:"string",revision:"string",lower_mm:"number",upper_mm:"number",reading:"number"};
  assert.equal(check(fields),undefined);
  for(const type of ["boolean","integer"]){
    assert.match(check({...fields,lower_mm:type,upper_mm:type}) ?? "",/lower_mm and upper_mm/);
    assert.match(check({...fields,reading:type}) ?? "",/reading/);
    assert.match(check({...fields,limit_range_lower:type,limit_range_upper:type}) ?? "",/limit_range_lower and limit_range_upper/);
    assert.match(check({...fields,limit_range:type}) ?? "",/limit_range/);
  }
  const integral={active:"B",lower_mm:"1.0",upper_mm:"2",measured_mm:"1"};
  assert.equal(check({...fields,lower_mm:"integer",upper_mm:"integer",reading:"integer"},integral),undefined);
  assert.equal(check({...fields,lower_mm:"boolean",upper_mm:"boolean"},starterInspectionV1,["lower_mm","upper_mm"]),undefined);
  assert.match(check({...fields,lower_mm:"boolean"},starterInspectionV1,["upper_mm"]) ?? "",/lower_mm and upper_mm/);
  assert.match(check({...fields,revision:"boolean"}) ?? "",/text field for revision/);
  assert.match(check({...fields,units:"integer"}) ?? "",/text field for units/);
  const precise={active:"B",lower_mm:"999999999999.000000001",upper_mm:"999999999999.000000002",measured_mm:"999999999999.000000001"};
  assert.match(check(fields,precise) ?? "",/drawing limits/);
  assert.equal(check({...fields,lower_mm:"string",upper_mm:"string",reading:"string"},precise),undefined);
});

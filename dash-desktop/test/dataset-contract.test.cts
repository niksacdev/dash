import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Bench } from "../lib/bench.cjs";
import { PlannerSettings } from "../lib/planner-settings.cjs";
import { referencePack, exactReference, graderEvidence } from "../lib/evaluation-cases.cjs";
import { parseDataset } from "../lib/packs.cjs";
import { opikJudgeRequest } from "./opik-judge-fixture.cjs";
import { inventory,reply,withoutPower,present } from "./runtime-fixtures.cjs";
import type { ChatTurn,LocalCandidate } from "../lib/runtime-types.cjs";
import type { RunResult } from "../lib/run-types.cjs";
import {z} from "zod";
const turns:ChatTurn[] = [{role:"user",content:"Inspect lot K7."},{role:"assistant",content:"Which limits apply?"},{role:"user",content:"10.00 to 10.03 mm. The sample measures 10.04 mm."}];
const record = {case_id:"qa-1",dataset_version:"1.0",split:"holdout",messages:turns,rubric:"Hold for review with units.",sme_rationale:"Private reason from the SME."};

test("a chat dataset can run against its own case rubric with no saved customer grader",async t=>{
  const model:LocalCandidate = {kind:"model",id:"ollama/qa",model:"qa",provider:"ollama",loaded:true};
  let candidateCalls=0,judgeCalls=0;
  const b=new Bench(":memory:",{
    discover:async()=>[inventory([model])],
    invoke:async(c,m,o)=>{
      const evaluation=opikJudgeRequest(m);
      if (evaluation?.stage==="geval-steps") return reply("Compare the reading and units against the case limits.");
      if (evaluation?.stage==="geval-score") {
        const schema=z.object({properties:z.object({score:z.object({maximum:z.number()})})}).parse(o.structured);
        assert.equal(schema.properties.score.maximum,10);
        const evidence=evaluation.evidence;
        assert.deepEqual(evidence.input,turns);
        assert.equal(evidence.inputSource,"recorded-dispatch");
        assert.equal(Object.hasOwn(evidence,"trajectory"),false);
        assert.equal(evidence.sme_rationale,record.sme_rationale);
        assert.equal(evidence.rubric,record.rubric);
        judgeCalls++; return reply('{"score":10,"reason":"Identified the out-of-tolerance sample."}');
      }
      assert.deepEqual(m,turns); candidateCalls++; return reply("Hold the lot for review.");
    }
  },withoutPower);
  t.after(()=>b.db.close());
  await b.refresh();
  const ds=b.import("reference","QA rubric cases",JSON.stringify(record));
  assert.throws(()=>b.start({mode:"dataset",datasetId:ds,candidateIds:[model.id],datasetScorer:"exact-reference"}),/Exact matching/);
  const id=b.start({mode:"dataset",datasetId:ds,candidateIds:[model.id],caseJudgeId:model.id});
  await present(b.active).done;
  const saved=b.exportRun(id);
  assert.equal(saved.status,"completed",saved.manifest.error);
  assert.deepEqual(saved.results[0].dispatchedMessages,turns);
  assert.equal(saved.manifest.approvedPromptId,null);
  assert.equal(saved.assessments[0].value,1,saved.assessments[0].reason);
  const [rubric]=saved.manifest.graders;
  assert.equal(rubric.type,"opik");
  assert.equal(rubric.version,2);
  assert.match(present(rubric.opikEngine),/^opik-js@/);
  assert.equal(saved.assessments[0].evaluator,rubric.opikEngine);
  assert.ok(saved.report);
  assert.ok(saved.report.metrics.some(m=>m.method==="opik-judge"));
  assert.equal(saved.report.verdict,"single");
  const rerun=b.start({mode:"dataset",datasetId:ds,candidateIds:[model.id],parentId:id,caseId:record.case_id});
  await present(b.active).done;
  assert.deepEqual(b.detail(rerun).manifest.graders,saved.manifest.graders);
  assert.deepEqual([candidateCalls,judgeCalls],[2,2]);
});

test("input-only datasets can use a saved grader as their sole source of success criteria",async t=>{
  const c:LocalCandidate={kind:"model",id:"ollama/qa",model:"qa",provider:"ollama",loaded:true};
  const b=new Bench(":memory:",{discover:async()=>[inventory([c])],invoke:async()=>reply("hold")},withoutPower);
  t.after(()=>b.db.close());await b.refresh();
  const datasetId=b.import("reference","Input only",JSON.stringify({case_id:"01",dataset_version:"1",split:"development",prompt:"Reply hold."}),{industry:"Manufacturing",family:"Input only",category:"Routing",source:"Test"});
  assert.equal(present(b.list().datasets.find(d=>d.id===datasetId)).casesWithoutReference,1);
  assert.throws(()=>b.start({mode:"dataset",datasetId,candidateIds:[c.id],caseJudgeId:c.id}),/own success criteria/);
  const grader=b.graders.save({name:"Disposition",category:"Routing",industry:"Manufacturing",type:"exact",criteria:"hold",threshold:1},[]);
  const id=b.start({mode:"dataset",datasetId,candidateIds:[c.id],graderIds:[grader]});await present(b.active).done;
  assert.equal(b.detail(id).assessments[0].pass,true);
});

test("an assistant's expected response must be held out of candidate chat turns",()=>{
  assert.throws(()=>parseDataset(JSON.stringify({...record,messages:[...turns,{role:"assistant",content:"SECRET_REFERENCE"}]}),referencePack),/end with a user turn/);
  assert.throws(()=>parseDataset(JSON.stringify({...record,prompt:"ambiguous"}),referencePack),/either a prompt or a messages/);
});

test("planner fallback saves the model preference without persisting the session secret",()=>{
  const db=new DatabaseSync(":memory:");
  const endpoints={list:()=>[],keys:new Map<string,string>()};
  try {
    const settings=new PlannerSettings(db,endpoints,{});
    assert.equal(settings.fallback(),null);
    settings.save({model:"gpt-test",enabled:true,key:"TEST_SESSION_ONLY"});
    assert.deepEqual(settings.fallback(),{model:"gpt-test",apiKey:"TEST_SESSION_ONLY"});
    assert.doesNotMatch(JSON.stringify([settings.status(),db.prepare("SELECT * FROM planner_fallback").all()]),/TEST_SESSION_ONLY/);
    assert.equal(new PlannerSettings(db,endpoints,{}).fallback(),null);
    settings.save({model:"gpt-test",enabled:false});assert.equal(settings.fallback(),null);
  } finally {db.close();}
});
test("exact reference strings use Opik and structured references preserve JSON semantics",async()=>{
  const score=await exactReference({case_id:"example",reference:"  HOLD "},"HOLD");
  assert.equal(score.pass,true);
  assert.match(present(score.evaluator),/^opik-js@/);
  assert.equal((await exactReference({case_id:"example",reference:"HOLD"},"hold")).pass,false);
  assert.equal((await exactReference({case_id:"example",reference:{a:1,b:2}},'{"b":2,"a":1}')).pass,true);
  assert.equal((await exactReference({case_id:"example",reference:[1,2]},"[2,1]")).pass,false);
});

test("grading prefers recorded dispatch, identifies older inputs, and excludes host actions", () => {
  const manifest={pack:referencePack}, row={case_id:"evidence",prompt:"Original case text"};
  const actual:ChatTurn[]=[{role:"user",content:"The exact representation dispatched under the token budget"}];
  const legacy:RunResult={candidateId:"local",caseId:row.case_id,output:"hold",score:null,error:null,telemetry:null,
    trace:{id:"qa-trace",runId:"qa-run",candidateId:"local",caseId:row.case_id,started:"2026-01-01T00:00:00Z",
      steps:[{at:"2026-01-01T00:00:00Z",action:"Invoke local model"}]}};
  const result={...legacy,dispatchedMessages:actual};
  const evidence=graderEvidence(manifest,row,result);
  assert.deepEqual(evidence.input,actual);
  assert.equal(evidence.inputSource,"recorded-dispatch");
  assert.equal(Object.hasOwn(evidence,"trajectory"),false);
  assert.deepEqual(graderEvidence(manifest,row,legacy).input,[{role:"user",content:row.prompt}]);
  assert.equal(graderEvidence(manifest,row,legacy).inputSource,"reconstructed-case");
  assert.equal(graderEvidence({...manifest,fixture:true},row,legacy).inputSource,"fixture-case");
});

test("action graders leave missing traces unscored and score only supplied agent actions", async t => {
  const candidate:LocalCandidate={kind:"model",id:"ollama/qa",provider:"ollama",model:"qa",loaded:true};
  const bench=new Bench(":memory:",{discover:async()=>[inventory([candidate])],invoke:async()=>reply("hold")},withoutPower);
  t.after(()=>bench.db.close());
  await bench.refresh();
  const datasetId=bench.import("reference","Tool evidence",JSON.stringify({case_id:"1",dataset_version:"1",split:"development",prompt:"Inspect lot K7."}),{industry:"Manufacturing",family:"Tool evidence",category:"Inspection",source:"Test"});
  const graderId=bench.graders.save({name:"Observed lookup and hold",category:"Operations",industry:"Manufacturing",type:"trajectory",criteria:"lookup\nhold",threshold:1},[]);
  assert.throws(()=>bench.start({mode:"dataset",datasetId,candidateIds:[candidate.id],graderIds:[graderId]}),/available evidence/);
  const disposition=bench.graders.save({name:"Disposition",category:"Routing",industry:"Manufacturing",type:"exact",criteria:"hold",threshold:1},[]);
  const runId=bench.start({mode:"dataset",datasetId,candidateIds:[candidate.id],graderIds:[graderId,disposition]});
  await present(bench.active).done;
  const result=bench.detail(runId);
  assert.ok(result.results[0].trace.steps.some(step=>step.action==="Invoke ollama"));
  const assessment=result.assessments[0];
  assert.equal(assessment.pass,null);
  assert.equal(assessment.value,null);
  assert.equal(assessment.inputSource,"recorded-dispatch");
  assert.match(assessment.reason,/No candidate tool trajectory/);
  const evidence={input:"Inspect lot K7.",reference:null,output:"hold"};
  const grade=(trajectory?:unknown[])=>bench.graders.record(bench.graders.get(graderId),{...evidence,...(trajectory===undefined?{}:{trajectory})},{},bench.adapters,new AbortController().signal);
  assert.equal((await grade(undefined)).value,null);
  assert.equal((await grade([])).value,0);
  assert.equal((await grade([{}, {action:"hold"}])).value,null);
  assert.equal((await grade([{tool:"hold"},{tool:"lookup"}])).value,0);
  assert.equal((await grade([{tool:"lookup"},{action:"hold"}])).value,1);
});

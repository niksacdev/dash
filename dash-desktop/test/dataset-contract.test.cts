import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Bench } from "../lib/bench.cjs";
import { PlannerSettings } from "../lib/planner-settings.cjs";
import { referencePack, exactReference, graderEvidence } from "../lib/evaluation-cases.cjs";
import { parseDataset } from "../lib/packs.cjs";
import { requireAssessmentEvidence } from "../lib/grader-types.cjs";
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
  assert.equal(rubric.version,3);
  assert.match(rubric.criteria,/verified reference/);
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

test("model datasets exclude action graders and standalone grading uses supplied agent actions", async t => {
  const candidate:LocalCandidate={kind:"model",id:"ollama/qa",provider:"ollama",model:"qa",loaded:true};
  const bench=new Bench(":memory:",{discover:async()=>[inventory([candidate])],invoke:async()=>reply("hold")},withoutPower);
  t.after(()=>bench.db.close());
  await bench.refresh();
  const datasetId=bench.import("reference","Tool evidence",JSON.stringify({case_id:"1",dataset_version:"1",split:"development",prompt:"Inspect lot K7."}),{industry:"Manufacturing",family:"Tool evidence",category:"Inspection",source:"Test"});
  const graderId=bench.graders.save({name:"Observed lookup and hold",category:"Operations",industry:"Manufacturing",type:"trajectory",criteria:"lookup\nhold",threshold:1},[]);
  assert.throws(()=>bench.start({mode:"dataset",datasetId,candidateIds:[candidate.id],graderIds:[graderId]}),/needs recorded agent actions/);
  const disposition=bench.graders.save({name:"Disposition",category:"Routing",industry:"Manufacturing",type:"exact",criteria:"hold",threshold:1},[]);
  assert.throws(()=>bench.start({mode:"dataset",datasetId,candidateIds:[candidate.id],graderIds:[graderId,disposition]}),/needs recorded agent actions/);
  const evidence={input:"Inspect lot K7.",reference:null,output:"hold"};
  const grade=(trajectory?:unknown[])=>bench.graders.record(bench.graders.get(graderId),{...evidence,...(trajectory===undefined?{}:{trajectory})},{},bench.adapters,new AbortController().signal);
  assert.equal((await grade(undefined)).value,null);
  assert.equal((await grade([])).value,0);
  assert.equal((await grade([{}, {action:"hold"}])).value,null);
  assert.equal((await grade([{tool:"hold"},{tool:"lookup"}])).value,0);
  assert.equal((await grade([{tool:"lookup"},{action:"hold"}])).value,1);
});

test("an explicit grader requires expected answers for each selected case before candidate dispatch",async t=>{
  const model:LocalCandidate={kind:"model",id:"ollama/qa",model:"qa",provider:"ollama",loaded:true};
  let candidateCalls=0,scoreCalls=0;
  const bench=new Bench(":memory:",{discover:async()=>[inventory([model])],invoke:async(_c,messages)=>{
    const request=opikJudgeRequest(messages);
    if(request?.stage==="geval-steps")return reply("Compare the answer to the supplied disposition.");
    if(request?.stage==="geval-score"){scoreCalls++;return reply('{"score":10,"reason":"The disposition matches."}');}
    candidateCalls++;return reply("HOLD");
  }},withoutPower);
  t.after(()=>bench.db.close());await bench.refresh();
  const base={dataset_version:"1",split:"development",prompt:"Give the lot disposition."};
  const missing={...base,case_id:"missing"};
  const label={...base,case_id:"labeled",reference:"HOLD"};
  const plain=bench.import("reference","Unlabeled",JSON.stringify(missing));
  const mixed=bench.import("reference","Mixed", [missing,label].map(row=>JSON.stringify(row)).join("\n"));
  const common={intent:"create",type:"opik",category:"Disposition",industry:"Cross-industry",criteria:"Compare the lot disposition.",threshold:1,judgeId:model.id};
  const reference=bench.graders.save({...common,name:"Reference disposition",requiredEvidence:["reference"]},[model]);
  const trajectory=bench.graders.save({...common,name:"Disposition steps",requiredEvidence:["trajectory"]},[model]);
  const start=(datasetId:string,id:string)=>bench.start({mode:"dataset",datasetId,candidateIds:[model.id],graderIds:[id]});
  assert.equal(bench.datasetGraderOptions(mixed).expectedAnswerCount,1);
  assert.throws(()=>start(plain,reference),/0 of 1 have one/);
  assert.throws(()=>start(mixed,reference),/1 of 2 have one/);
  assert.throws(()=>start(mixed,trajectory),/recorded agent actions/);
  const saved=bench.graders.get(reference),sample={input:"Disposition",output:"HOLD"};
  for (const missing of [null, {}, [], {label:" "}])
    assert.throws(()=>requireAssessmentEvidence(saved,{...sample,reference:missing}),/Enter an expected answer/);
  for (const available of [false,0,"HOLD",{label:"HOLD"}])
    assert.doesNotThrow(()=>requireAssessmentEvidence(saved,{...sample,reference:available}));
  assert.equal(candidateCalls,0);assert.equal(scoreCalls,0);
  assert.equal(bench.list().runs.length,0);
  const run=bench.start({mode:"dataset",datasetId:mixed,caseId:"labeled",candidateIds:[model.id],graderIds:[reference]});await present(bench.active).done;
  const grades=bench.detail(run).assessments.filter(result=>result.graderId===reference);
  assert.equal(grades.find(g=>g.caseId==="labeled")?.value,1);
  assert.equal(grades.some(g=>g.caseId==="missing"),false);assert.equal(candidateCalls,1);assert.equal(scoreCalls,1);
});


test("exact dataset scoring and historical case reruns accept literal empty JSON",async t=>{
  const candidate:LocalCandidate={kind:"model",id:"ollama/blank",model:"blank",provider:"ollama",loaded:true};
  let calls=0;
  const bench=new Bench(":memory:",{discover:async()=>[inventory([candidate])],invoke:async(_model,messages)=>{
    calls++;return reply(messages.at(-1)?.content ?? "");
  }},withoutPower);
  t.after(()=>bench.db.close());await bench.refresh();
  const cases=[{},[]].map((reference,index)=>({case_id:"empty-"+index,reference,prompt:JSON.stringify(reference),dataset_version:"1",split:"development"}));
  const datasetId=bench.import("reference","Empty results are valid",cases.map(r=>JSON.stringify(r)).join("\n"));
  const options=bench.datasetGraderOptions(datasetId);
  assert.equal(options.literalAnswerCount,2);assert.equal(options.expectedAnswerCount,0);assert.equal(options.casesWithoutGuidance,2);
  const params={mode:"dataset" as const,datasetScorer:"exact-reference" as const,datasetId,candidateIds:[candidate.id]};
  const first=bench.start(params);await present(bench.active).done;
  assert.deepEqual(bench.detail(first).results.map(row=>row.score?.pass),[true,true]);
  const rerun=bench.start({...params,parentId:first,caseId:"empty-1"});await present(bench.active).done;
  assert.equal(bench.detail(rerun).results[0].score?.pass,true);assert.equal(calls,3);
});

test("a JSON field grader requires its named path and accepts present literal values",async t=>{
  const candidate:LocalCandidate={kind:"model",id:"ollama/field",model:"field",provider:"ollama",loaded:true};
  let calls=0;
  const bench=new Bench(":memory:",{discover:async()=>[inventory([candidate])],invoke:async(_model,messages)=>{
    calls++;return reply(messages.at(-1)?.content ?? "");
  }},withoutPower);
  t.after(()=>bench.db.close());await bench.refresh();
  const graderId=bench.graders.save({name:"EPS",type:"field",criteria:JSON.stringify({referenceField:"reported.eps",outputField:"eps"}),
    category:"Accuracy",industry:"Cross-industry",threshold:1},[]);
  const grader=bench.graders.get(graderId);
  const makeCase=(case_id:string,reference:unknown,answer:unknown)=>({case_id,dataset_version:"1",split:"development",
    reference,prompt:JSON.stringify({eps:answer})});
  const valid=[0,false,null].map((value,i)=>makeCase("valid-"+i,{reported:{eps:value}},value));
  const invalid=[makeCase("wrong-key",{adjusted:0.85},0.85),makeCase("text","reported.eps is 0.74",0.74)];
  for(const row of invalid) assert.throws(()=>requireAssessmentEvidence(grader,{input:row.prompt,output:row.prompt,reference:row.reference}),/reported\.eps/);
  for(const row of valid) assert.doesNotThrow(()=>requireAssessmentEvidence(grader,{input:row.prompt,output:row.prompt,reference:row.reference}));
  const datasetId=bench.import("reference","Field values",[...valid,...invalid].map(r=>JSON.stringify(r)).join("\n"));
  const params={mode:"dataset" as const,datasetId,candidateIds:[candidate.id],graderIds:[graderId]};
  assert.equal(bench.datasetGraderOptions(datasetId).fieldCoverage["reported.eps"],3);
  assert.throws(()=>bench.start(params),/reported\.eps.*3 of 5/);
  assert.equal(calls,0);assert.equal(bench.list().runs.length,0);
  for(const row of valid) {
    const run=bench.start({...params,caseId:row.case_id});await present(bench.active).done;
    assert.equal(bench.detail(run).assessments.find(a=>a.graderId===grader.id)?.value,1);
  }
});

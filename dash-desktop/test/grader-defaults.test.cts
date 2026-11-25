import {graderEvidence} from "../lib/evaluation-cases.cjs";
import {z} from "zod";
import {test} from "node:test";
import assert from "node:assert/strict";
import {Bench,replayCandidate} from "../lib/bench.cjs";
import {getOpikTemplate} from "../lib/opik-library.cjs";
import type {LocalCandidate} from "../lib/runtime-types.cjs";
import {inventory,present,reply,withoutPower} from "./runtime-fixtures.cjs";

test("new runs pin the chosen cross-industry metric, reruns retain their exact revision and history lists each run once", async t=>{
  const judge:LocalCandidate = {kind:"model",provider:"ollama",model:"qa",id:"ollama/qa",revision:"local-v1",loaded:true};
  let calls=0;
  const bench = new Bench(":memory:",{
    discover:async()=>[inventory([judge])],
    invoke:async(_model,_messages,options)=>{
      assert.equal(options.judging,true);
      calls++;
      return reply(JSON.stringify({answer_relevance_score:0.8,reason:"The response addresses the inspection task."}));
    }
  },withoutPower);
  t.after(()=>bench.db.close());
  await bench.refresh();
  const dataset = present(bench.list().datasets.find(d=>d.pack==="manufacturing"));
  const template = getOpikTemplate("answer-relevance");
  const settings = {name:"My relevance policy",type:"opik-metric",metricKey:template.key,criteria:template.criteria,
    industry:"Cross-industry",category:template.category,threshold:0.7,judgeId:judge.id};
  const first = bench.graders.save({...settings,intent:"create"},[judge]);
  const second = bench.graders.save({...settings,threshold:0.9,intent:"revise",sourceGraderId:first},[judge]);
  const options=bench.datasetGraderOptions(dataset.id);
  assert.ok(options.available.some(g=>g.id===first));
  const originalKeys=options.automatic.map(g=>g.id);
  assert.equal(originalKeys.length,3);
  assert.throws(()=>bench.setGeneralGraderDefault(originalKeys[0],true),/cross-industry Opik/);
  const start=(parentId?:string,graderIds?:string[])=>bench.start({mode:"dataset",datasetId:dataset.id,
    caseId:"shaft-superseded-revision",candidateIds:[replayCandidate.id],parentId,graderIds});
  bench.setGeneralGraderDefault(first,true);
  const original=start(undefined,[first]);
  await present(bench.active).done;
  bench.setGeneralGraderDefault(second,true);
  bench.setGeneralGraderDefault(first,false);
  assert.deepEqual(bench.list().generalGraderDefaults,[second]);
  const rerun=start(original);
  await present(bench.active).done;
  const fresh=start();
  await present(bench.active).done;
  assert.equal(calls,3);
  assert.deepEqual(bench.detail(original).manifest.graders,bench.detail(rerun).manifest.graders);
  assert.equal(bench.detail(original).manifest.policyHash,bench.detail(rerun).manifest.policyHash);
  assert.ok(bench.detail(original).assessments.find(g=>g.graderId===first)?.pass);
  assert.equal(bench.detail(fresh).assessments.find(g=>g.graderId===second)?.pass,false);
  assert.deepEqual(new Set(bench.graderRuns(first).map(r=>r.id)),new Set([original,rerun]));
  assert.deepEqual(bench.graderRuns(second).map(r=>r.id),[fresh]);
  bench.setGeneralGraderDefault(second,false);
  assert.deepEqual(bench.datasetGraderOptions(dataset.id).automatic.map(g=>g.id),originalKeys);
});

test("a reference-free default can score input-only cases while rubric and reference requirements remain explicit", async t=>{
  const judge:LocalCandidate = {kind:"model",provider:"ollama",model:"qa",id:"ollama/qa",revision:"local-v1",loaded:true};
  const candidate={...judge,model:"candidate-qa",id:"ollama/candidate-qa"};
  const b = new Bench(":memory:", {
    discover:async()=>[inventory([judge,candidate])],
    invoke:async(_model,_messages,options)=>options.judging
      ? reply(JSON.stringify({answer_relevance_score:1,reason:"The response addresses the task."}))
      : reply("Hold for review."),
  },withoutPower);
  t.after(()=>b.db.close());
  await b.refresh();
  const row={case_id:"input",dataset_version:"1",split:"development",prompt:"Name the disposition."};
  const plain=b.import("reference","Input only",JSON.stringify(row));
  const rubrics=b.import("reference","Graded",JSON.stringify({...row,rubric:"The answer must request supervisor review."}));
  const run=(datasetId:string)=>b.start({mode:"dataset",datasetId,candidateIds:[candidate.id]});
  const bind=(key:"hallucination"|"answer-relevance")=>{
    const metric=getOpikTemplate(key);
    const id=b.graders.save({name:metric.name,type:"opik-metric",intent:"create",metricKey:key,
      criteria:metric.criteria,industry:"Cross-industry",category:metric.category,threshold:0.7,judgeId:judge.id},[judge]);
    b.setGeneralGraderDefault(id,true);
    return id;
  };
  assert.throws(()=>run(plain),/available evidence/);
  const grounding=bind("hallucination");
  assert.throws(()=>run(plain),/0 of 1 have one/);
  b.setGeneralGraderDefault(grounding,false);
  const relevance=bind("answer-relevance");
  assert.throws(()=>run(rubrics),/case-level rubrics/);
  const id=run(plain);
  await present(b.active).done;
  assert.equal(b.detail(id).assessments.find(g=>g.graderId===relevance)?.pass,true);
});

test("an automatic local decision receives only the candidate task and answer on a labeled case, including regrades",async t=>{
  const model:LocalCandidate={kind:"model",provider:"ollama",model:"qa",id:"ollama/qa",loaded:true};
  const b=new Bench(":memory:",{discover:async()=>[inventory([model])],invoke:async()=>reply("Hold the lot.")},withoutPower);
  t.after(()=>b.db.close());
  await b.refresh();
  const row={case_id:"inspection",dataset_version:"1",split:"development",prompt:"The part exceeds the stated limit. What should receiving do?",
    reference:"HELD-OUT REFERENCE",sme_rationale:"PRIVATE SME NOTE",rubric:"HELD-OUT CASE RULE"};
  const datasetId=b.import("reference","Synthetic inspection",JSON.stringify(row));
  const config={type:"decision",category:"Quality",industry:"Cross-industry",threshold:0.8,decision:{provider:"local",model:"local/decision",failAt:0.2}};
  const auto=b.graders.save({...config,name:"Clear disposition",criteria:"Does the answer specify an action?"},[]);
  const manual=b.graders.save({...config,name:"Uses the case rule",criteria:"Does the disposition satisfy the case-specific rule?",requiredEvidence:["reference"]},[]);
  b.setGeneralGraderDefault(auto,true);
  const wire:{criterion:string;state:Record<string,unknown>}[]=[];
  t.mock.method(globalThis,"fetch",async(url:RequestInfo|URL,options?:RequestInit)=>{
    if(String(url)==="http://127.0.0.1:8080/v1/models")
      return Response.json({data:[{id:"local/decision",output_modalities:["decisions"]}]});
    assert.equal(String(url),"http://127.0.0.1:8080/v1/systemone");
    assert.ok(typeof options?.body==="string");
    const request=z.object({state:z.string(),questions:z.object({criterion:z.object({instructions:z.string()})})}).parse(JSON.parse(options.body));
    wire.push({criterion:request.questions.criterion.instructions,state:z.record(z.string(),z.unknown()).parse(JSON.parse(request.state))});
    return Response.json({model:"local/decision",answers:{criterion:{type:"noul",noul:0.95}}});
  });
  const start=(ids:string[],parentId?:string)=>b.start({mode:"dataset",datasetId,caseId:row.case_id,candidateIds:[model.id],graderIds:ids,parentId});
  assert.throws(()=>start([]),/case-level rubrics/);
  const scoped=b.graders.save({intent:"derive",sourceGraderId:auto,decisionView:"task-answer"},[]);
  assert.throws(()=>start([scoped]),/case-level rubrics/,"An explicitly selected task-only grader cannot read the case rubric");

  const id=start([manual]);await present(b.active).done;
  const run=b.detail(id), grader=b.graders.get(auto);
  const task={input:run.results[0].dispatchedMessages,output:"Hold the lot."};
  assert.equal(wire.length,2);
  assert.deepEqual(wire.find(v=>v.criterion.endsWith(grader.criteria))?.state,task);
  assert.deepEqual(wire.find(v=>v.criterion.endsWith(b.graders.get(manual).criteria))?.state,
    {...task,reference:row.reference,sme_rationale:row.sme_rationale,rubric:row.rubric});
  assert.deepEqual(run.manifest.taskAnswerDecisionGraderIds,[auto]);
  b.setGeneralGraderDefault(auto,false);
  const savedRow=b.dataset(datasetId).rows[0];
  const evidence=graderEvidence(run.manifest,savedRow,run.results[0],false,auto);
  await b.graders.assess(grader,evidence,b.adapters,AbortSignal.timeout(1000));
  assert.deepEqual(wire.at(-1)?.state,task);
  const repeat=start([],id);await present(b.active).done;
  assert.deepEqual(b.detail(repeat).manifest.taskAnswerDecisionGraderIds,[auto]);
  assert.deepEqual(wire.at(-1)?.state,task);
  const explicit=start([manual,auto]);await present(b.active).done;
  assert.equal(b.detail(explicit).manifest.taskAnswerDecisionGraderIds,undefined);
  assert.notEqual(run.manifest.policyHash,b.detail(explicit).manifest.policyHash);
  assert.equal(wire.at(-1)?.state.sme_rationale,row.sme_rationale);
});

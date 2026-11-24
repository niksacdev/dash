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
  const b = new Bench(":memory:", {
    discover:async()=>[inventory([judge])],
    invoke:async(_model,_messages,options)=>options.judging
      ? reply(JSON.stringify({answer_relevance_score:1,reason:"The response addresses the task."}))
      : reply("Hold for review."),
  },withoutPower);
  t.after(()=>b.db.close());
  await b.refresh();
  const row={case_id:"input",dataset_version:"1",split:"development",prompt:"Name the disposition."};
  const plain=b.import("reference","Input only",JSON.stringify(row));
  const rubrics=b.import("reference","Graded",JSON.stringify({...row,rubric:"The answer must request supervisor review."}));
  const run=(datasetId:string)=>b.start({mode:"dataset",datasetId,candidateIds:[judge.id]});
  const bind=(key:"hallucination"|"answer-relevance")=>{
    const metric=getOpikTemplate(key);
    const id=b.graders.save({name:metric.name,type:"opik-metric",intent:"create",metricKey:key,
      criteria:metric.criteria,industry:"Cross-industry",category:metric.category,threshold:0.7,judgeId:judge.id},[judge]);
    b.setGeneralGraderDefault(id,true);
    return id;
  };
  assert.throws(()=>run(plain),/available evidence/);
  const grounding=bind("hallucination");
  assert.throws(()=>run(plain),/available evidence/);
  b.setGeneralGraderDefault(grounding,false);
  const relevance=bind("answer-relevance");
  assert.throws(()=>run(rubrics),/case-level rubrics/);
  const id=run(plain);
  await present(b.active).done;
  assert.equal(b.detail(id).assessments.find(g=>g.graderId===relevance)?.pass,true);
});

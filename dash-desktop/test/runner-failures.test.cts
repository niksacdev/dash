import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {ExactMatch,logger} from "opik";
import {opikJudgeRequest} from "./opik-judge-fixture.cjs";
import {Bench} from "../lib/bench.cjs";
import {Graders} from "../lib/graders.cjs";
import {diagnostics} from "../lib/diagnostics.cjs";
import {inventory,present,reply,withoutPower} from "./runtime-fixtures.cjs";
import {ProviderFailure,ProviderPreflightError,type LocalCandidate,type RuntimeAdapters} from "../lib/runtime-types.cjs";

const model:LocalCandidate={kind:"model",id:"ollama/fixture",model:"fixture",provider:"ollama",loaded:true};
const sentinel="PRIVATE_EXCEPTION_TEXT";
const sample={input:"Name the color",reference:"blue",output:"blue"};
function cases(b:Bench,count=1) {
  return b.import("reference","Synthetic colors",Array.from({length:count},(_,i)=>JSON.stringify({
    case_id:"case-"+i,prompt:"Name the color",reference:"blue",split:"development",dataset_version:"1",
  })).join("\n"));
}
function runtime():RuntimeAdapters {
  return {discover:async()=>[inventory([model])],invoke:async()=>reply("blue",{output_tokens:1},"stop")};
}

test("cache failure during report assistance and damaged report JSON never hide confirmed case results",async t=>{
  let calls=0;
  const b=new Bench(":memory:",{...runtime(),invoke:async()=>{calls++;return reply("blue",{},"stop");},
    reportStage:async()=>assert.fail("No local report model")},withoutPower);
  t.after(()=>b.db.close());await b.refresh();
  const datasetId=cases(b);
  b.db.exec("CREATE TRIGGER deny_cache BEFORE INSERT ON run_reports BEGIN SELECT RAISE(FAIL,'PRIVATE_EXCEPTION_TEXT'); END");
  const id=b.start({mode:"dataset",candidateIds:[model.id],datasetId,datasetScorer:"exact-reference"});
  await present(b.active?.done);
  const detail=b.detail(id);
  assert.equal(detail.status,"completed");
  assert.equal(detail.results[0].error,null);
  assert.equal(detail.results[0].score?.pass,true);
  assert.equal(detail.report?.verdict,"single");
  assert.match(present(detail.report?.cacheIssue),/could not cache/);
  assert.ok(!JSON.stringify(b.exportRun(id)).includes(sentinel));
  b.db.exec("DROP TRIGGER deny_cache");
  const repaired=present(b.detail(id).report);
  assert.equal(repaired.cacheIssue,undefined);
  for(const invalid of ["broken "+sentinel,'{"version":1}']){
    b.db.prepare("UPDATE run_reports SET report=? WHERE run=?").run(invalid,id);
    assert.deepEqual(b.exportRun(id).report,repaired);
    assert.deepEqual(b.detail(id).report,repaired);
  }
  assert.equal(calls,1);
});

test("dataset progress identifies the case and pinned grader after saving the response",async t=>{
  const bench=new Bench(":memory:",runtime(),withoutPower);
  t.after(()=>bench.db.close());
  await bench.refresh();
  const datasetId=cases(bench,2);
  const name="Color wording";
  const grader=bench.graders.save({name,industry:"General",category:"Content",type:"contains",criteria:"blue",threshold:1},[]);
  const snapshots:unknown[]=[];
  const record=bench.graders.record.bind(bench.graders);
  t.mock.method(bench.graders,"record",(...args:Parameters<typeof record>)=>{
    const [spec,,where]=args;
    if (spec.name===name && where.run) {
      const detail=bench.detail(where.run);
      snapshots.push({partial:detail.partial,saved:detail.results.length});
    }
    return record(...args);
  });
  bench.start({mode:"dataset",candidateIds:[model.id],datasetId,datasetScorer:"exact-reference",graderIds:[grader]});
  await present(bench.active?.done);
  assert.deepEqual(snapshots,[0,1].map(i=>({
    partial:{candidateId:model.id,caseId:"case-"+i,text:"",grading:{name,version:1}},saved:i+1
  })));
});

test("built-in scoring and initial sensor failures keep the successful response available to independent graders",async t=>{
  let calls=0;
  const b=new Bench(":memory:",{...runtime(),invoke:async()=>{calls++;return reply("blue",{},"stop");}},()=>{
    throw Error(sentinel);
  });
  t.after(()=>b.db.close());await b.refresh();
  const datasetId=cases(b);
  t.mock.method(ExactMatch.prototype,"score",()=>{throw Error(sentinel);});
  const grader=b.graders.save({name:"Color wording",industry:"General",category:"Content",type:"contains",criteria:"blue",threshold:1},[]);
  const id=b.start({mode:"dataset",candidateIds:[model.id],datasetId,datasetScorer:"exact-reference",graderIds:[grader]});
  await present(b.active?.done);
  const data=b.detail(id), result=data.results[0];
  assert.equal(data.status,"completed");
  assert.equal(result.output,"blue");
  assert.equal(result.error,null);
  assert.equal(result.score,null);
  assert.match(present(result.gradingError),/pinned dataset scorer/);
  assert.equal(diagnostics(data).traces[0].stage,"Grading");
  assert.equal(data.report?.verdict,"incomplete");
  assert.ok(data.report?.metrics.find(m=>m.builtIn)?.caseScores[0].values[0].reason.includes("pinned dataset scorer"));
  assert.equal(data.assessments.find(a=>a.graderId===grader)?.pass,true);
  assert.equal(result.telemetry?.device_power,undefined);
  assert.ok(result.trace.steps.some(s=>s.action==="Device power measurement unavailable"));
  assert.ok(!JSON.stringify(data).includes(sentinel));
  assert.equal(calls,1);
});

test("a failed assessment checkpoint stops the remaining dataset dispatches without exposing SQLite details",async t=>{
  let calls=0;
  const b=new Bench(":memory:",{...runtime(),invoke:async()=>{calls++;return reply("blue",{},"stop");}},withoutPower);
  t.after(()=>b.db.close());await b.refresh();
  const datasetId=cases(b,2);
  b.db.exec("CREATE TRIGGER deny_assessment BEFORE INSERT ON assessments BEGIN SELECT RAISE(FAIL,'PRIVATE_EXCEPTION_TEXT'); END");
  const id=b.start({mode:"dataset",candidateIds:[model.id],datasetId,datasetScorer:"exact-reference"});
  await present(b.active?.done);
  const run=b.exportRun(id);
  assert.equal(run.status,"failed");
  assert.match(present(run.manifest.error),/could not save the grader assessment/);
  assert.equal(run.results[0].output,"blue");
  assert.equal(run.results[0].score?.pass,true);
  assert.equal(run.results[0].error,null);
  assert.equal(run.assessments.length,0);
  assert.ok(!JSON.stringify(run).includes(sentinel));
  assert.equal(calls,1);
});

test("truncated, malformed, failed and canceled judge responses stay unscored with private diagnostics",async t=>{
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());
  const graders=new Graders(db);
  const grader=graders.get(graders.save({name:"Color judge",industry:"General",category:"Content",type:"judge",judgeId:model.id,criteria:"Check the color.",threshold:1},[model]));
  const verdict='{"score":1,"reason":"Matched."}';
  for(const failure of ["length","content_filter","malformed","schema","transport","canceled"] as const){
    const controller=new AbortController();
    let calls=0;
    const adapters={...runtime(),invoke:async()=>{
      calls++;
      if(failure==="transport")throw Error(sentinel);
      if(failure==="canceled")controller.abort(Error(sentinel));
      if(failure==="malformed")return reply(sentinel,{},"stop");
      if(failure==="schema")return reply(JSON.stringify({score:sentinel}),{},"stop");
      return reply(verdict,{},failure==="canceled"?"stop":failure);
    }};
    const entry=await graders.record(grader,sample,{},adapters,controller.signal);
    assert.equal(calls,1);
    assert.equal(entry.value,null);
    assert.equal(entry.pass,null);
    assert.match(entry.reason,/judge|Grading canceled/);
    assert.ok(!JSON.stringify(graders.recent()).includes(sentinel));
  }
});

test("when all terminal writes fail, readable checkpoints remain available and the job stops appearing active",async t=>{
  let calls=0;
  const b=new Bench(":memory:",{...runtime(),invoke:async()=>{calls++;return reply("blue",{},"stop");}},withoutPower);
  t.after(()=>b.db.close());await b.refresh();
  const datasetId=cases(b);
  const log=t.mock.method(console,"error",()=>{});
  b.db.exec("CREATE TRIGGER deny_terminal BEFORE UPDATE ON runs WHEN NEW.status IN ('completed','failed') BEGIN SELECT RAISE(FAIL,'PRIVATE_EXCEPTION_TEXT'); END");
  const id=b.start({mode:"dataset",candidateIds:[model.id],datasetId,datasetScorer:"exact-reference"});
  await present(b.active?.done);
  assert.equal(b.active,null);
  assert.equal(b.db.prepare("SELECT status FROM runs WHERE id=?").get(id)?.status,"running");
  assert.equal(b.list().runs.find(run=>run.id===id)?.status,"interrupted");
  const detail=b.detail(id);
  assert.equal(detail.status,"interrupted");
  assert.equal(detail.results[0].output,"blue");
  assert.equal(detail.results[0].score?.pass,true);
  assert.equal(detail.report?.verdict,"incomplete");
  assert.match(present(detail.manifest.error),/last saved case records/);
  assert.ok(!JSON.stringify(detail).includes(sentinel));
  assert.equal(log.mock.callCount(),1);
  assert.equal(calls,1);
});

test("verified preflight failures and uncertain dispatches preserve distinct evidence and recovery guidance",async t=>{
  let calls=0;
  const refused="Ollama refused the local connection. Start the local server and refresh Local runtimes.";
  const disconnected="Ollama connection failed. Check Local runtimes and the server activity.";
  const b=new Bench(":memory:",{...runtime(),invoke:async(_model,_input,{onText})=>{
    if (++calls===1) throw new ProviderPreflightError(refused);
    onText?.("partial synthetic answer");
    throw new ProviderFailure(disconnected);
  }},withoutPower);
  t.after(()=>b.db.close());await b.refresh();
  const datasetId=cases(b,2);
  const id=b.start({mode:"dataset",candidateIds:[model.id],datasetId,datasetScorer:"exact-reference"});
  await present(b.active?.done);
  const run=b.exportRun(id);
  const [first,second]=run.results;
  assert.equal(run.status,"failed");
  assert.equal(first.error,refused);
  assert.ok(first.trace.finished);
  assert.equal(first.dispatchedMessages,undefined);
  assert.equal(first.dispatchState,undefined);
  assert.ok(first.trace.steps.some(s=>s.action.includes("before candidate inference was sent")));
  assert.match(present(second.error),/final candidate response is unknown/);
  assert.equal(second.dispatchState,"interrupted");
  assert.equal(second.output,"partial synthetic answer");
  assert.equal(second.trace.finished,undefined);
  assert.ok(second.trace.steps.some(s=>s.action===disconnected));
  assert.ok(second.dispatchedMessages?.length);
  assert.equal(calls,2);
  assert.equal(run.assessments.length,0);
});

test("malformed native Opik and G-Eval verdicts never enter SDK parser logs",async t=>{
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());
  const graders=new Graders(db),logs:string[]=[];
  t.mock.method(logger,"error",(...args:unknown[])=>{logs.push(args.map(String).join(" "));});
  for (const def of [{type:"opik"},{type:"opik-metric",metricKey:"moderation"}]) {
    const id=graders.save({...def,name:"Synthetic "+def.type,industry:"General",category:"Quality",
      judgeId:model.id,criteria:def.type==="opik"?"Answer the question.":undefined,threshold:.75},[model]);
    const outcome=await graders.assess(graders.get(id),sample,{...runtime(),invoke:async(_m,turns)=>{
      if(opikJudgeRequest(turns)?.stage==="geval-steps")return reply("Check the answer.");
      return reply(sentinel,{},"stop");
    }},new AbortController().signal);
    assert.equal(outcome.value,null);
    assert.equal(outcome.pass,null);
    assert.ok(!outcome.reason.includes(sentinel));
  }
  assert.ok(logs.every(line=>!line.includes(sentinel)));
});

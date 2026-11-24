import {test} from "node:test";
import assert from "node:assert/strict";
import fs = require("node:fs");
import {DatabaseSync} from "node:sqlite";
import {Graders,opikVersion,type GraderEvidence,type GraderSpec} from "../lib/graders.cjs";
import type {LocalCandidate,RuntimeAdapters} from "../lib/runtime-types.cjs";
import {opikJudgeRequest} from "./opik-judge-fixture.cjs";
import {reply} from "./runtime-fixtures.cjs";

const judge:LocalCandidate = {kind:"model",id:"lmstudio/synthetic",model:"synthetic",provider:"lmstudio",revision:"weights-1"};
const evidence:GraderEvidence = {input:"The drawing sets a 10 mm limit.",output:"Hold the 12 mm sample.",reference:"Hold",inputSource:"recorded-dispatch"};
const fields={name:"Requires a hold",industry:"Manufacturing",category:"Inspection",criteria:"Hold samples above the drawing limit.",threshold:1};

test("a historical Python G-Eval revision stays unscored without its bridge and can be explicitly revised for the installed evaluator",async t=>{
  const db=new DatabaseSync(":memory:");
  t.after(()=>db.close());
  const graders=new Graders(db);
  const old={...fields,id:"original-rubric",version:1,type:"opik",judge};
  const serializedGrader=JSON.stringify(old);
  db.prepare("INSERT INTO graders VALUES(?,?,?,?)").run(old.id,"requires a hold",1,serializedGrader);
  const original={graderId:old.id,name:old.name,version:1,category:old.category,engine:"opik",threshold:1,judge:judge.id,
    value:1,pass:true,reason:"Correctly routes to hold.",evaluator:"opik-python",id:"previous",created:"2026-01-01T00:00:00Z"};
  const serializedGrade=JSON.stringify(original);
  db.prepare("INSERT INTO assessments VALUES(?,?,?,?,?,?)").run(original.id,"previous-run","subject","too-wide",original.created,serializedGrade);

  // Keep this reproducible on machines that still have the optional historical environment.
  const exists=fs.existsSync;
  t.mock.method(fs,"existsSync",(path:fs.PathLike)=>typeof path==="string" && path.includes("/.opik-venv/") ? false : exists(path));
  let calls=0;
  const adapters:RuntimeAdapters={discover:async()=>[],invoke:async(candidate,messages)=>{
    calls++;
    assert.equal(candidate.id,judge.id);
    const request=opikJudgeRequest(messages);
    assert(request);
    return reply(request.stage==="geval-steps" ? "Check the limit and disposition." :
      JSON.stringify({score:10,reason:"The sample is above the limit and the answer requests a hold."}));
  }};
  const signal=new AbortController().signal;
  const oldAssessment=await graders.record(graders.get(old.id),evidence,{run:"rerun",candidate:"subject",caseId:"too-wide"},adapters,signal);
  assert.deepEqual([oldAssessment.value,oldAssessment.pass,oldAssessment.evaluator],[null,null,undefined]);
  assert.match(oldAssessment.reason,/historical Python Opik G-Eval bridge/);
  assert.match(oldAssessment.reason,/save a new grader revision/i);
  assert.equal(calls,0);
  assert.equal(db.prepare("SELECT record FROM assessments WHERE id=?").get(original.id)?.record,serializedGrade);
  assert.equal(graders.recorded("previous-run")[0].value,1);

  const current=graders.get(graders.save({intent:"revise",sourceGraderId:old.id},[judge]));
  assert.notEqual(current.id,old.id);
  assert.equal(current.library?.parentRevisionId,old.id);
  assert.equal(current.version,2);
  assert.equal(current.opikEngine,opikVersion);
  const grade=await graders.assess(current,evidence,adapters,signal);
  assert.equal(grade.value,1);
  assert.equal(grade.evaluator,opikVersion);
  assert.equal(calls,2);
  assert.equal(db.prepare("SELECT spec FROM graders WHERE id=?").get(old.id)?.spec,serializedGrader);
});

test("an unavailable SDK pin blocks G-Eval, native metrics and native decisions before evidence dispatch",async t=>{
  const db=new DatabaseSync(":memory:");
  t.after(()=>db.close());
  const graders=new Graders(db);
  const ids=[
    graders.save({...fields,type:"opik",judgeId:judge.id},[judge]),
    graders.save({...fields,name:"Relevance",type:"opik-metric",criteria:undefined,metricKey:"answer-relevance",judgeId:judge.id},[judge]),
    graders.save({...fields,name:"Decision",type:"decision",decision:{provider:"openrouter",model:"synthetic/model",failAt:.2}},[]),
  ];
  const http=t.mock.method(globalThis,"fetch",()=>assert.fail("Unexpected decision dispatch"));
  let judgeCalls=0;
  const adapters:RuntimeAdapters={discover:async()=>[],invoke:async()=>{
    judgeCalls++;
    throw Error("Unexpected local judge dispatch");
  }};
  for(const id of ids) {
    const grader=graders.get(id);
    const versions=grader.type==="opik" ? ["opik-js@0.0.1"] : ["opik-js@0.0.1",undefined];
    for(const pin of versions) {
      const saved:GraderSpec={...grader,opikEngine:pin};
      const outcome=await graders.assess(saved,evidence,adapters,new AbortController().signal,true);
      assert.deepEqual([outcome.value,outcome.pass,outcome.evaluator],[null,null,undefined]);
      assert(outcome.reason.includes(pin ?? "no recorded Opik SDK version"));
      assert(outcome.reason.includes(opikVersion));
      assert.match(outcome.reason,/save a new grader revision/i);
      if (grader.type==="decision") assert.equal(outcome.decisionRequest?.requestedModel,grader.decision.model);
    }
  }
  assert.equal(judgeCalls,0);
  assert.equal(http.mock.callCount(),0);
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { Bench } = require("../lib/bench.cjs");
const { PlannerSettings } = require("../lib/planner-settings.cjs");
const { referencePack } = require("../lib/evaluation-cases.cjs");
const { parseDataset } = require("../lib/packs.cjs");
const turns = [{role:"user",content:"Inspect lot K7."},{role:"assistant",content:"Which limits apply?"},{role:"user",content:"10.00 to 10.03 mm. The sample measures 10.04 mm."}];
const record = {case_id:"qa-1",dataset_version:"1.0",split:"holdout",messages:turns,rubric:"Hold for review with units.",sme_rationale:"Private reason from the SME."};

test("a chat dataset can run against its own case rubric with an empty grader library",async t=>{
  const model = {id:"ollama/qa",model:"qa",provider:"ollama",loaded:true};
  let candidateCalls=0,judgeCalls=0;
  const b=new Bench(":memory:",{
    discover:async()=>[{models:[model]}],
    invoke:async(c,m,o)=>{
      if (o.structured?.properties?.score) {
        const evidence=JSON.parse(m.at(-1).content);
        assert.deepEqual(evidence.input,turns);
        assert.equal(evidence.sme_rationale,record.sme_rationale);
        assert.equal(evidence.rubric,record.rubric);
        judgeCalls++; return {output:'{"score":1,"reason":"Identified the out-of-tolerance sample."}'};
      }
      assert.deepEqual(m,turns); candidateCalls++; return {output:"Hold the lot for review."};
    }
  },async()=>async()=>null);
  t.after(()=>b.db.close());
  await b.refresh();
  const ds=b.import("reference","QA rubric cases",JSON.stringify(record));
  assert.throws(()=>b.start({mode:"dataset",datasetId:ds,candidateIds:[model.id],datasetScorer:"exact-reference"}),/Exact matching/);
  const id=b.start({mode:"dataset",datasetId:ds,candidateIds:[model.id],caseJudgeId:model.id});
  await b.active.done;
  const saved=b.exportRun(id);
  assert.equal(saved.status,"completed",saved.manifest.error);
  assert.equal(saved.manifest.approvedPromptId,null);
  assert.equal(saved.assessments[0].value,1,saved.assessments[0].reason);
  assert.equal(saved.report.verdict,"single");
  const rerun=b.start({mode:"dataset",datasetId:ds,candidateIds:[model.id],parentId:id,caseId:record.case_id});
  await b.active.done;
  assert.deepEqual(b.detail(rerun).manifest.graders,saved.manifest.graders);
  assert.deepEqual([candidateCalls,judgeCalls],[2,2]);
});

test("input-only datasets can use a saved grader as their sole source of success criteria",async t=>{
  const c={id:"ollama/qa",model:"qa",provider:"ollama",loaded:true};
  const b=new Bench(":memory:",{discover:async()=>[{models:[c]}],invoke:async()=>({output:"hold"})},async()=>async()=>null);
  t.after(()=>b.db.close());await b.refresh();
  const datasetId=b.import("reference","Input only",JSON.stringify({case_id:"01",dataset_version:"1",split:"development",prompt:"Reply hold."}));
  assert.equal(b.list().datasets.find(d=>d.id===datasetId).casesWithoutReference,1);
  assert.throws(()=>b.start({mode:"dataset",datasetId,candidateIds:[c.id],caseJudgeId:c.id}),/own success criteria/);
  const grader=b.graders.save({name:"Disposition",category:"Routing",industry:"Manufacturing",type:"exact",criteria:"hold",threshold:1},[]);
  const id=b.start({mode:"dataset",datasetId,candidateIds:[c.id],graderIds:[grader]});await b.active.done;
  assert.equal(b.detail(id).assessments[0].pass,true);
});

test("an assistant's expected response must be held out of candidate chat turns",()=>{
  assert.throws(()=>parseDataset(JSON.stringify({...record,messages:[...turns,{role:"assistant",content:"SECRET_REFERENCE"}]}),referencePack),/end with a user turn/);
  assert.throws(()=>parseDataset(JSON.stringify({...record,prompt:"ambiguous"}),referencePack),/either a prompt or a messages/);
});

test("planner fallback saves the model preference without persisting the session secret",()=>{
  const db=new DatabaseSync(":memory:");
  const endpoints={list:()=>[],keys:new Map()};
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
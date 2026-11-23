const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Bench } = require("../lib/bench.cjs");

async function setup(t) {
  const models = ["lfm3-1.7b","lane-b","local-judge"].map(model => ({
    id:"lmstudio/" + model, provider:"lmstudio", model, revision:"weights-v1", loaded:true,
  }));
  const judgeCalls = [];
  const adapters = {
    discover:async () => [{ models }],
    async invoke(model, messages, options) {
      if (options.planning) {
        const expert = options.structured.properties.requirements;
        return {output:JSON.stringify(expert
          ? {title:"Capture earnings", metrics:["GAAP EPS capture accuracy"], requirements:["Distinguish GAAP from adjusted EPS."]}
          : {prompt:"Extract the reported GAAP EPS."})};
      }
      if (model.model === "local-judge") {
        const evidence = JSON.parse(messages[1].content);
        judgeCalls.push(evidence);
        assert.ok(options.structured.properties.score);
        return {output:JSON.stringify({score:evidence.output === "GAAP EPS 1.24" ? 1 : 0, reason:"Checked the cited earnings basis."})};
      }
      return {output:model.model === "lfm3-1.7b" ? "GAAP EPS 1.24" : "Adjusted EPS 1.80"};
    },
  };
  const bench = new Bench(":memory:", adapters, async () => async () => null);
  t.after(() => bench.db.close());
  await bench.refresh();
  const draft = await bench.designPrompt({mode:"quick",domain:"Financial Services",objective:"Extract GAAP EPS from the earnings release."});
  const approved = bench.workflow.approve({draftId:draft.draftId,prompt:draft.prompt});
  const start = extra => bench.start({mode:"quick",approvedPromptId:approved.id,candidateIds:models.slice(0,2).map(m=>m.id),...extra});
  function save(name, change = {}) {
    return bench.graders.save({name,type:"contains",category:"Extraction",threshold:1,criteria:"GAAP",industry:"Financial Services",...change},models);
  }
  return {bench, approved, models, judgeCalls, start, save};
}

test("Quick compare suggests outcome-related reusable graders and excludes checks without case evidence", async t => {
  const {bench,approved,models,save,start} = await setup(t);
  const old = save("Earnings basis", {criteria:"EPS"});
  const latest = save("Earnings basis");
  const unrelated = save("Dividend currency", {criteria:"EUR"});
  const differentDomain = save("Drawing revision", {industry:"Manufacturing",criteria:"GAAP"});
  const reference = save("EPS reference", {type:"field",criteria:JSON.stringify({outputField:"eps",referenceField:"eps"})});
  const trajectory = save("Tool order", {type:"trajectory",criteria:"lookup"});
  const judge = save("EPS judge", {type:"judge",judgeId:models[2].id});
  models[2] = {...models[2],revision:"weights-v2"};
  const options = bench.quickGraderOptions(approved.id);
  assert.deepEqual(options.recommended.map(g=>g.id), [latest]);
  for (const id of [old,latest,unrelated,differentDomain]) assert.ok(options.available.some(g=>g.id===id));
  for (const id of [reference,trajectory,judge]) {
    assert.ok(!options.available.some(g=>g.id===id));
    assert.throws(()=>start({graderIds:[id]}), /selected grader/);
  }
  assert.equal(bench.list().runs.length, 0);
});

test("the approved outcome rubric runs separately for both candidates and pins its judge, score and lineage", async t => {
  const {bench,approved,models,judgeCalls,start} = await setup(t);
  const options = bench.quickGraderOptions(approved.id);
  assert.equal(options.recommended.length, 0);
  assert.equal(bench.graders.list().length, 0);
  assert.match(options.generated.criteria, /Distinguish GAAP from adjusted EPS/);
  const outcomeRubric = {...options.generated,judgeId:models[2].id};
  const runId = start({outcomeRubric});
  await bench.active.done;
  const {manifest,assessments,status} = bench.detail(runId);
  assert.equal(status, "completed");
  assert.equal(manifest.graders.length, 1);
  const pinned = manifest.graders[0];
  assert.deepEqual(pinned.origin,{kind:"approved-outcome",promptId:approved.id,promptFamilyId:approved.familyId,promptVersion:1});
  assert.equal(pinned.judge.revision, "weights-v1");
  assert.equal(pinned.criteria, outcomeRubric.criteria);
  assert.deepEqual(assessments.map(v=>[v.candidate,v.value,v.pass,v.graderId,v.judge]), [
    [models[0].id,1,true,pinned.id,models[2].id],[models[1].id,0,false,pinned.id,models[2].id],
  ]);
  for (const e of judgeCalls) {
    assert.deepEqual(e.evaluationBrief,{objective:approved.objective,metrics:approved.metrics,criteria:approved.requirements});
    assert.equal(e.input,approved.prompt);
  }
  assert.equal(bench.quickGraderOptions(approved.id).recommended[0].id,pinned.id);
  const reuse = start({graderIds:[pinned.id],outcomeRubric});
  await bench.active.done;
  assert.equal(bench.exportRun(reuse).assessments.length,2);
  assert.equal(bench.graders.list().length,1);
});

test("a rejected Quick grading configuration leaves the run queue and grader library consistent", async t => {
  const {bench,models,save,start} = await setup(t);
  assert.throws(()=>start({outcomeRubric:{judgeId:"missing"}}),/available local model/);
  const graderIds = Array.from({length:8},(_,i)=>save("EPS check "+i));
  assert.throws(()=>start({graderIds,outcomeRubric:{judgeId:models[2].id}}),/up to eight/);
  assert.equal(bench.graders.list().length,8);
  assert.equal(bench.list().runs.length,0);
});

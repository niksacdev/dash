import {auditReply} from "./audit-fixture.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bench } from "../lib/bench.cjs";

import { opikJudgeRequest, judgeEvidence } from "./opik-judge-fixture.cjs";
import { inventory,reply,withoutPower,present } from "./runtime-fixtures.cjs";
import type { TestContext } from "node:test";
import type { LocalCandidate,RuntimeAdapters } from "../lib/runtime-types.cjs";
import type { GraderDefinition } from "../lib/grader-types.cjs";
import type { StartRun } from "../lib/run-types.cjs";
import {z} from "zod";

const requestProperties=z.object({properties:z.record(z.string(),z.unknown())});

async function setup(t:TestContext) {
  const models = ["lfm3-1.7b","lane-b","local-judge"].map((model):LocalCandidate => ({
    id:"lmstudio/" + model, provider:"lmstudio", kind:"model", model, revision:"weights-v1", loaded:true,
  }));
  const judgeCalls:Record<string,unknown>[] = [];
  const adapters:RuntimeAdapters = {
    discover:async () => [inventory(models)],
    async invoke(model, messages, options) {
      if (options.planning) {
        const properties=requestProperties.parse(options.structured).properties;
        if (properties.audit) return reply(JSON.stringify(auditReply(messages)));
        const expert=properties.requirements;
        return reply(JSON.stringify(expert
          ? {title:"Capture earnings", metrics:["GAAP EPS capture accuracy"], requirements:["Distinguish GAAP from adjusted EPS."]}
          : {prompt:"Extract the reported GAAP EPS."}));
      }
      if (model.model === "local-judge") {
        const evaluation = opikJudgeRequest(messages);
        if (evaluation?.stage === "geval-steps") return reply("Check the earnings basis against the citation.");
        const evidence = evaluation ? evaluation.evidence : judgeEvidence(messages[1].content);
        const maxScore = evaluation ? 10 : 1;
        const spec=requestProperties.parse(options.structured);
        assert.equal(z.object({maximum:z.number()}).parse(spec.properties.score).maximum,maxScore);
        judgeCalls.push(evidence);
        return reply(JSON.stringify({score:evidence.output === "GAAP EPS 1.24" ? maxScore : 0, reason:"Checked the cited earnings basis."}));
      }
      return reply(model.model === "lfm3-1.7b" ? "GAAP EPS 1.24" : "Adjusted EPS 1.80");
    },
  };
  const bench = new Bench(":memory:", adapters, withoutPower);
  t.after(() => bench.db.close());
  await bench.refresh();
  const draft = await bench.designPrompt({mode:"quick",domain:"Financial Services",objective:"Extract GAAP EPS from the earnings release."});
  const approved = bench.workflow.approve({draftId:draft.draftId,prompt:draft.prompt});
  const start = (extra:Pick<StartRun,"graderIds"|"outcomeRubric">) => bench.start({mode:"quick",approvedPromptId:approved.id,candidateIds:models.slice(0,2).map(m=>m.id),...extra});
  function save(name:string, change:Partial<GraderDefinition> = {}) {
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
  for (const id of [old,latest,unrelated]) assert.ok(options.available.some(g=>g.id===id));
  for (const id of [differentDomain,reference,trajectory,judge]) {
    assert.ok(!options.available.some(g=>g.id===id));
    assert.throws(()=>start({graderIds:[id]}), /selected grader/);
  }
  assert.equal(bench.list().runs.length, 0);
});

test("the approved outcome rubric runs separately for both candidates and pins its judge, score and lineage", async t => {
  const {bench,approved,models,judgeCalls,start} = await setup(t);
  const options = bench.quickGraderOptions(approved.id);
  assert.equal(options.recommended.length, 0);
  assert.equal(bench.graders.list().filter(g=>g.library?.scope === "customer").length, 0);
  assert.ok(options.generated);
  assert.match(options.generated.criteria, /Distinguish GAAP from adjusted EPS/);
  assert.equal(options.generated.type, "opik");
  const outcomeRubric = {judgeId:models[2].id, criteria:options.generated.criteria};
  const runId = start({outcomeRubric});
  await present(bench.active).done;
  const {manifest,assessments,status} = bench.detail(runId);
  assert.equal(status, "completed");
  assert.equal(manifest.graders.filter(g=>!g.library?.automatic).length, 1);
  assert.deepEqual(new Set(manifest.graders.filter(g=>g.type==="catalog").map(g=>g.ruleKey)),new Set(["response-present","completion"]));
  const pinned = manifest.graders[0];
  assert.deepEqual(pinned.origin,{kind:"approved-outcome",promptId:approved.id,promptFamilyId:approved.familyId,promptVersion:1});
  assert.equal(pinned.type, "opik");
  assert.match(present(pinned.opikEngine), /^opik-js@/);
  assert.ok(assessments.filter(a=>a.graderId===pinned.id).every(a => a.evaluator === pinned.opikEngine));
  assert.equal(judgeCalls.length, 2);
  assert.equal(pinned.judge.revision, "weights-v1");
  assert.equal(pinned.criteria, outcomeRubric.criteria);
  assert.deepEqual(assessments.filter(v=>v.graderId===pinned.id).map(v=>[v.candidate,v.value,v.pass,v.graderId,v.judge]), [
    [models[0].id,1,true,pinned.id,models[2].id],[models[1].id,0,false,pinned.id,models[2].id],
  ]);
  for (const e of judgeCalls) {
    assert.deepEqual(e.evaluationBrief,{objective:approved.objective,metrics:approved.metrics,criteria:approved.requirements});
    assert.deepEqual(e.input,[{role:"user",content:approved.prompt}]);
    assert.equal(e.inputSource,"recorded-dispatch");
    assert.equal(Object.hasOwn(e,"trajectory"),false);
  }
  assert.equal(bench.quickGraderOptions(approved.id).recommended[0].id,pinned.id);
  const reuse = start({graderIds:[pinned.id],outcomeRubric});
  await present(bench.active).done;
  assert.equal(bench.exportRun(reuse).assessments.filter(a=>a.graderId===pinned.id).length,2);
  assert.equal(bench.graders.list().filter(g=>g.library?.scope === "customer").length,1);
});

test("an explicitly requested legacy outcome rubric retains its original scoring scale", async t => {
  const {bench,models,start} = await setup(t);
  const id = start({outcomeRubric:{type:"judge",judgeId:models[2].id}});
  await present(bench.active).done;
  const {manifest,assessments} = bench.detail(id);
  assert.equal(manifest.graders[0].type,"judge");
  assert.deepEqual(assessments.filter(a=>a.engine==="judge").map(a => a.value),[1,0]);
});

test("a rejected Quick grading configuration leaves the run queue and grader library consistent", async t => {
  const {bench,models,save,start} = await setup(t);
  assert.throws(()=>start({outcomeRubric:{judgeId:"missing"}}),/available local model/);
  const graderIds = Array.from({length:8},(_,i)=>save("EPS check "+i));
  assert.throws(()=>start({graderIds,outcomeRubric:{judgeId:models[2].id}}),/up to eight/);
  assert.equal(bench.graders.list().filter(g=>g.library?.scope === "customer").length,8);
  assert.equal(bench.list().runs.length,0);
});

test("an audited external KPI does not enable an outcome judge or erase the operator’s metric", async t=>{
  const {bench,approved,models}=await setup(t);
  const withKpi={...approved,metrics:["Actual analyst hours saved"]};
  assert.ok(withKpi.auditAgent);
  assert.equal(bench.graders.quickOptions(withKpi,models).generated,null);
  assert.throws(()=>bench.graders.resolveQuick(withKpi,[],{type:"opik",judgeId:models[0].id},models),/observable success measure/);
  assert.deepEqual(withKpi.metrics,["Actual analyst hours saved"]);
  const edited={...approved,metrics:[],requirements:[],metricAudit:undefined};
  assert.equal(bench.graders.quickOptions(edited,models).generated,null);
});

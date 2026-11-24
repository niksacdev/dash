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

const epsMetric="GAAP EPS source agreement";
const periodMetric="Reporting period citation";
const epsCriterion="The answer gives the GAAP EPS stated in the supplied release.";
const periodCriterion="The answer explicitly names a reporting period.";
async function setup(t:TestContext,paired=false) {
  const models = ["lfm3-1.7b","lane-b","local-judge"].map((model):LocalCandidate => ({
    id:"lmstudio/" + model, provider:"lmstudio", kind:"model", model, revision:"weights-v1", loaded:true,
  }));
  const judgeCalls:Record<string,unknown>[] = [];
  const adapters:RuntimeAdapters = {
    discover:async () => [inventory(models)],
    async invoke(model, messages, options) {
      if (options.planning) {
        const properties=requestProperties.parse(options.structured).properties;
        if (properties.audit) {
          const result=auditReply(messages);
          if(paired)return reply(JSON.stringify({audit:result.audit.map(row=>({...row,metric:row.criterion===periodCriterion ? periodMetric : epsMetric,evidenceBasis:"task-answer",
            evidence:"The source in the task and the candidate answer."}))}));
          return reply(JSON.stringify(result));
        }
        const expert=properties.requirements;
        return reply(JSON.stringify(expert
          ? paired ? {title:"Capture earnings",metrics:[epsMetric,periodMetric],requirements:[epsCriterion,periodCriterion]} : {title:"Capture earnings", metrics:["GAAP EPS capture accuracy"], requirements:["Distinguish GAAP from adjusted EPS."]}
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
        const brief=z.object({metrics:z.array(z.string())}).parse(evidence.evaluationBrief);
        const passed=paired && brief.metrics.includes(periodMetric) ? String(evidence.output).includes("June") : String(evidence.output).includes("GAAP EPS 1.24");
        return reply(JSON.stringify({score:passed ? maxScore : 0, reason:"Checked the requested item in the answer."}));
      }
      return reply(model.model === "lfm3-1.7b" ? "GAAP EPS 1.24" : paired ? "Adjusted EPS 1.80 for June." : "Adjusted EPS 1.80");
    },
  };
  const bench = new Bench(":memory:", adapters, withoutPower);
  t.after(() => bench.db.close());
  await bench.refresh();
  const draft = await bench.designPrompt({mode:"quick",domain:"Financial Services",objective:paired ? "Extract GAAP EPS and cite the reporting period. The release states June GAAP EPS 1.24 and adjusted EPS 1.80." : "Extract GAAP EPS from the earnings release."});
  const approved = bench.workflow.approve({draftId:draft.draftId,prompt:draft.prompt});
  const start = (extra:Pick<StartRun,"graderIds"|"outcomeRubric"|"measureGraders">) => bench.start({mode:"quick",approvedPromptId:approved.id,candidateIds:models.slice(0,2).map(m=>m.id),...extra});
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
  const legacyBasis=options.measures[0].generated;
  assert.ok(legacyBasis?.type==="opik");
  assert.deepEqual(legacyBasis.requiredEvidence,["reference"]);
  const runId = start({outcomeRubric});
  await present(bench.active).done;
  const {manifest,assessments,status} = bench.detail(runId);
  assert.equal(status, "completed");
  assert.equal(manifest.graders.filter(g=>!g.library?.automatic).length, 1);
  assert.deepEqual(new Set(manifest.graders.filter(g=>g.type==="catalog").map(g=>g.ruleKey)),new Set(["response-present","completion"]));
  assert.equal(manifest.measureGraders,undefined);
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


test("Quick pins an independent revision per approved measure and scores both answers on both criteria", async t=>{
  const {bench,approved,models,judgeCalls,start}=await setup(t,true);
  const options=bench.quickGraderOptions(approved.id).measures;
  assert.deepEqual(options.map(o=>[o.metric,o.criterion]),[[epsMetric,epsCriterion],[periodMetric,periodCriterion]]);
  const choices=options.map(({metric,generated})=>{
    assert.ok(generated?.type==="opik" && !generated.requiredEvidence?.length);
    return {metric,kind:"rubric" as const,judgeId:models[2].id,threshold:1};
  });
  const id=start({measureGraders:choices});
  await present(bench.active).done;
  const run=bench.detail(id);
  const pinned=present(run.manifest.measureGraders);
  const graders=pinned.map(item=>present(run.manifest.graders.find(g=>g.id===item.graderId)));
  assert.equal(new Set(graders.map(g=>g.library?.familyId)).size,2);
  assert.deepEqual(graders.map(g=>[g.origin?.measure,g.origin?.promptId,g.version]),[[epsMetric,approved.id,1],[periodMetric,approved.id,1]]);
  assert.deepEqual(pinned.map(row=>[row.metric,row.criterion,row.graderVersion]),[[epsMetric,epsCriterion,1],[periodMetric,periodCriterion,1]]);
  assert.equal(run.report?.verdict,"mixed");
  assert.match(run.results[0].dispatchedMessages?.map(m=>m.content).join(" ") ?? "",/June GAAP EPS 1.24/);
  assert.deepEqual(pinned.map(row=>present(run.report?.metrics.find(m=>m.id===row.graderId)).values.map(v=>v.score)),[[1,0],[0,1]]);
  assert.deepEqual(run.results.map(r=>r.output),["GAAP EPS 1.24","Adjusted EPS 1.80 for June."]);
  assert.deepEqual(run.results[0].dispatchedMessages,run.results[1].dispatchedMessages);
  assert.equal(judgeCalls.length,4);
  const briefs=judgeCalls.map(e=>z.object({metrics:z.array(z.string()),criteria:z.array(z.string())}).parse(e.evaluationBrief));
  for(const [metric,criterion] of [[epsMetric,epsCriterion],[periodMetric,periodCriterion]]) {
    assert.equal(briefs.filter(b=>b.metrics.length===1 && b.metrics[0]===metric && b.criteria.length===1 && b.criteria[0]===criterion).length,2);
  }
  const revisedId=start({measureGraders:[{...choices[0],threshold:0.8},choices[1]]});
  await present(bench.active).done;
  const revised=present(bench.detail(revisedId).manifest.measureGraders);
  assert.deepEqual(revised.map(m=>m.graderVersion),[2,1]);
  assert.equal(revised[1].graderId,pinned[1].graderId);
  assert.deepEqual(bench.detail(id).manifest.measureGraders,pinned);
  assert.equal(bench.detail(id).report?.verdict,"mixed");
});

test("Quick retains missing reference and skipped measures without claiming an overall winner",async t=>{
  const {bench,approved,models,judgeCalls,start,save}=await setup(t,true);
  const saved=save("Reusable source check",{criteria:"GAAP"});
  const id=start({graderIds:[saved],measureGraders:[{metric:epsMetric,kind:"saved",graderId:saved},
    {metric:periodMetric,kind:"rubric",judgeId:models[2].id,threshold:1,evidence:"reference"}]});
  await present(bench.active).done;
  const run=bench.detail(id);
  assert.equal(run.report?.verdict,"incomplete");
  const pinned=present(run.manifest.measureGraders);
  const missing=run.assessments.filter(a=>a.graderId===pinned[1].graderId);
  assert.equal(missing.length,2);
  assert.ok(missing.every(a=>a.value===null && a.pass===null && /reference/.test(a.reason)));
  assert.equal(judgeCalls.length,0);
  assert.equal(run.assessments.filter(a=>a.graderId===saved).length,2);
  const skippedId=start({measureGraders:[{metric:epsMetric,kind:"saved",graderId:saved},{metric:periodMetric,kind:"skip"}]});
  await present(bench.active).done;
  const skipped=bench.detail(skippedId);
  assert.equal(skipped.report?.verdict,"incomplete");
  assert.equal(skipped.report?.winnerId,null);
  assert.match(skipped.report?.summary??"",/measure was left unscored/);
  assert.equal(skipped.manifest.measureGraders?.[1].graderId,null);
  const external={...approved,metrics:["Actual analyst hours saved"],metricCriteria:[{metric:"Actual analyst hours saved",criterion:"Verify actual analyst hours saved."}]};
  const kpi=bench.graders.quickOptions(external,models).measures[0];
  assert.equal(kpi.generated,null);
  assert.throws(()=>bench.graders.resolveMeasureGraders(external,[],[{metric:kpi.metric,kind:"saved",graderId:saved}],models),/outside this run/);
  assert.deepEqual(bench.graders.quickOptions({...approved,metricCriteria:undefined,metricAudit:undefined},models).measures,[]);
});

test("invalid or excessive measure assignments roll back generated revisions and the run",async t=>{
  const {bench,models,start,save}=await setup(t,true);
  const graderIds=Array.from({length:8},(_,i)=>save("Additional check "+i));
  const rubric={metric:epsMetric,kind:"rubric" as const,judgeId:models[2].id,threshold:1};
  const skip={metric:periodMetric,kind:"skip" as const};
  const count=bench.graders.list().length;
  assert.throws(()=>start({measureGraders:[rubric]}),/exactly once/);
  assert.throws(()=>start({measureGraders:[rubric,{...skip,metric:epsMetric}]}),/exactly once/);
  assert.throws(()=>start({measureGraders:[rubric,{...skip,metric:"Unapproved"}]}),/exactly once/);
  assert.throws(()=>start({measureGraders:[{metric:epsMetric,kind:"saved",graderId:graderIds[0]},
    {metric:periodMetric,kind:"saved",graderId:graderIds[0]}]}),/distinct grader/);
  assert.throws(()=>start({measureGraders:[rubric,skip],graderIds}),/up to eight/);
  assert.equal(bench.graders.list().length,count);
  assert.equal(bench.list().runs.length,0);
});

test("a cross-industry local decision default scores both Quick candidates once and remains pinned on dataset reruns",async t=>{
  const {bench,models,approved,start}=await setup(t);
  const model="qa/decision";
  const settings={name:"Evidence citation",type:"decision",intent:"create",category:"Evidence",
    criteria:"Does the answer cite a concrete value from the prompt?",industry:"Cross-industry",threshold:0.8,
    decision:{provider:"local",model,failAt:0.2}};
  const save=(overrides:Record<string,unknown>={})=>bench.graders.save({...settings,...overrides},[]);
  const first=save(), other=save({name:"Answer identifies units",criteria:"Does the answer give a unit for each quantity?"});
  const second=save({intent:"revise",sourceGraderId:first,threshold:0.95});
  for(const changes of [{industry:"Manufacturing"},{requiredEvidence:["reference"]},{requiredEvidence:["trajectory"]},
    {decision:{provider:"openrouter",model:"liquid/d1.2",failAt:0.2}}]){
    const ineligible=save(changes);
    assert.throws(()=>bench.setGeneralGraderDefault(ineligible,true),/cross-industry.*local decision grader/);
    assert.equal(bench.list().graders.find(g=>g.id===ineligible)?.generalDefaultKey,null);
  }
  const firstKey=present(bench.list().graders.find(g=>g.id===first)?.generalDefaultKey);
  assert.equal(bench.list().graders.find(g=>g.id===second)?.generalDefaultKey,firstKey);
  assert.notEqual(bench.list().graders.find(g=>g.id===other)?.generalDefaultKey,firstKey);
  bench.setGeneralGraderDefault(first,true);
  bench.setGeneralGraderDefault(other,true);
  assert.deepEqual(new Set(bench.list().generalGraderDefaults),new Set([first,other]));
  bench.setGeneralGraderDefault(other,false);
  assert.ok(bench.quickGraderOptions(approved.id).automatic.some(g=>g.id===first));
  let offline=false;
  const graded:Record<string,unknown>[]=[];
  t.mock.method(globalThis,"fetch",async(url:RequestInfo|URL,options?:RequestInit)=>{
    assert.equal(new URL(String(url)).origin,"http://127.0.0.1:8080");
    if(String(url).endsWith("/v1/models"))
      return Response.json({data:offline?[]:[{id:model,output_modalities:["decisions"]}]});
    assert.equal(String(url),"http://127.0.0.1:8080/v1/systemone");
    assert.ok(typeof options?.body==="string");
    const {state}=z.object({state:z.string()}).parse(JSON.parse(options.body));
    const {output}=z.object({output:z.string()}).parse(JSON.parse(state));
    graded.push(z.record(z.string(),z.unknown()).parse(JSON.parse(state)));
    return Response.json({model,answers:{criterion:{type:"noul",noul:output.includes("GAAP")?0.9:0.1}}});
  });
  const quick=start({});
  await present(bench.active).done;
  const checked=bench.detail(quick);
  assert.deepEqual(graded.map(state=>state.output),["GAAP EPS 1.24","Adjusted EPS 1.80"]);
  assert.ok(graded.every(state=>Object.keys(state).sort().join(",")==="input,output"));
  assert.deepEqual(checked.manifest.taskAnswerDecisionGraderIds,[first]);
  assert.deepEqual(checked.assessments.filter(a=>a.graderId===first).map(a=>[a.candidate,a.pass,a.decision?.actualModel]),
    [[models[0].id,true,model],[models[1].id,false,model]]);
  assert.equal(checked.manifest.graders.filter(g=>g.id===first).length,1);
  const [measure]=bench.quickGraderOptions(approved.id).measures;
  const mapped=start({graderIds:[first],measureGraders:[{metric:measure.metric,kind:"saved",graderId:first}]});
  await present(bench.active).done;
  const explicit=bench.detail(mapped).manifest;
  assert.equal(explicit.taskAnswerDecisionGraderIds,undefined);
  assert.equal(explicit.measureGraders?.[0].graderId,first);
  assert.equal(explicit.graders.filter(g=>g.id===first).length,1);
  assert.ok(graded.slice(2).every(state=>!!state.evaluationBrief));
  const dataset=present(bench.list().datasets.find(d=>d.pack==="manufacturing"));
  const candidateIds=models.slice(0,2).map(m=>m.id);
  const newRun=(parentId?:string)=>bench.start({mode:"dataset",datasetId:dataset.id,caseId:"shaft-superseded-revision",candidateIds,parentId});
  offline=true;
  const original=newRun();
  await present(bench.active).done;
  const run=bench.detail(original);
  assert.equal(run.results.filter(result=>result.output).length,2);
  assert.deepEqual(run.assessments.filter(a=>a.graderId===first).map(a=>[a.candidate,a.value,a.pass,a.decisionRequest?.requestedModel]),
    [[models[0].id,null,null,model],[models[1].id,null,null,model]]);
  bench.setGeneralGraderDefault(second,true);
  bench.setGeneralGraderDefault(first,false);
  assert.deepEqual(bench.list().generalGraderDefaults,[second]);
  const rerun=newRun(original);
  await present(bench.active).done;
  assert.deepEqual(bench.detail(rerun).manifest.graders,run.manifest.graders);
  assert.equal(bench.detail(rerun).manifest.policyHash,run.manifest.policyHash);
  const fresh=newRun();
  await present(bench.active).done;
  assert.ok(bench.detail(fresh).manifest.graders.some(g=>g.id===second));
  assert.notEqual(bench.detail(fresh).manifest.policyHash,run.manifest.policyHash);
  assert.deepEqual(bench.detail(rerun).manifest.taskAnswerDecisionGraderIds,[first]);
  assert.equal(graded.length,4);
});

import {AsyncLocalStorage} from "node:async_hooks";
import {auditReply} from "./audit-fixture.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {graderEvidence} from "../lib/evaluation-cases.cjs";
import {exportDiagnostics} from "../lib/export-diagnostics.cjs";
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
async function setup(t:TestContext,paired=false,candidateAnswer?:(model:string)=>string,echoReference=false) {
  const models = ["lfm3-1.7b","lane-b","local-judge"].map((model):LocalCandidate => ({
    id:"lmstudio/" + model, provider:"lmstudio", kind:"model", model, revision:"weights-v1", loaded:true,
  }));
  const judgeCalls:Record<string,unknown>[] = [];
  const candidateCalls:string[]=[];
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
        return reply(JSON.stringify({score:passed ? maxScore : 0, reason:echoReference && typeof evidence.reference==="string" ? "Checked against "+evidence.reference : "Checked the requested item in the answer."}));
      }
      candidateCalls.push(model.id);
      if(candidateAnswer)return reply(candidateAnswer(model.model));
      return reply(model.model === "lfm3-1.7b" ? "GAAP EPS 1.24" : paired ? "Adjusted EPS 1.80 for June." : "Adjusted EPS 1.80");
    },
  };
  const bench = new Bench(":memory:", adapters, withoutPower);
  t.after(() => bench.db.close());
  await bench.refresh();
  const draft = await bench.designPrompt({mode:"quick",domain:"Financial Services",objective:paired ? "Extract GAAP EPS and cite the reporting period. The release states June GAAP EPS 1.24 and adjusted EPS 1.80." : "Extract GAAP EPS from the earnings release."});
  const approved = bench.workflow.approve({draftId:draft.draftId,prompt:draft.prompt});
  const start = (extra:Pick<StartRun,"graderIds"|"outcomeRubric"|"measureGraders"|"expectedAnswer"|"inspectionOnly">) => bench.start({mode:"quick",approvedPromptId:approved.id,candidateIds:models.slice(0,2).map(m=>m.id),...extra});
  function save(name:string, change:Partial<GraderDefinition> = {}) {
    return bench.graders.save({name,type:"contains",category:"Extraction",threshold:1,criteria:"GAAP",industry:"Financial Services",...change},models);
  }
  return {bench, approved, models, judgeCalls, candidateCalls, start, save};
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
  assert.throws(()=>start({measureGraders:options.measures.map(m=>({metric:m.metric,kind:"rubric",judgeId:models[2].id,threshold:1}))}),/expected answer/i);
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

test("Quick collects private expected facts before dispatch, scores both lanes and preserves intentional skips",async t=>{
  const {bench,approved,models,judgeCalls,start,save}=await setup(t,true,undefined,true);
  const saved=save("Reusable source check",{criteria:"GAAP"});
  const measureGraders:NonNullable<StartRun["measureGraders"]>=[
    {metric:epsMetric,kind:"saved",graderId:saved},
    {metric:periodMetric,kind:"rubric",judgeId:models[2].id,threshold:1,evidence:"reference"}];
  const expectedAnswer="Verified by QA: June was the reporting period. Private marker EVID-371.";
  const before=bench.graders.list().length;
  for (const absent of [undefined,"  "]) assert.throws(()=>start({graderIds:[saved],measureGraders,expectedAnswer:absent}),/expected answer/i);
  assert.equal(bench.graders.list().length,before);
  assert.equal(bench.list().runs.length,0);
  assert.equal(Boolean(bench.active),false);
  assert.equal(judgeCalls.length,0);
  const id=start({graderIds:[saved],measureGraders,expectedAnswer});
  await present(bench.active).done;
  const run=bench.detail(id);
  const pinned=present(run.manifest.measureGraders);
  assert.equal(run.hasQuickExpectedAnswer,true);
  assert.equal(bench.quickExpectedAnswer(id),expectedAnswer);
  const checked=run.assessments.filter(a=>a.graderId===pinned[1].graderId);
  assert.deepEqual(checked.map(a=>a.pass),[false,true]);
  assert.deepEqual(judgeCalls.map(c=>c.reference),[expectedAnswer,expectedAnswer]);
  assert.ok(checked.every(a=>a.reason.includes(expectedAnswer)));
  const metric=present(run.report?.metrics.find(m=>m.id===pinned[1].graderId));
  assert.ok(metric.caseScores[0].values.every(v=>v.reason.includes(expectedAnswer)));
  // Saved report reasons may differ from their original receipts on older builds.
  metric.caseScores[0].values[0].reason="Cached rationale quotes EVID-371.";
  const externalCopy=exportDiagnostics(run);
  assert.ok(!JSON.stringify(externalCopy).includes("EVID-371"));
  assert.deepEqual(externalCopy.report?.metrics.find(m=>m.id===metric.id)?.caseScores[0].values.map(v=>v.score),
    metric.caseScores[0].values.map(v=>v.score));
  assert.equal(JSON.stringify(bench.exportRun(id)).includes(expectedAnswer),false);
  assert.equal(run.assessments.filter(a=>a.graderId===saved).length,2);
  const savedRef=present(pinned[1].graderId);
  assert.ok(bench.quickGraderOptions(approved.id).available.some(g=>g.id===savedRef));
  assert.throws(()=>start({graderIds:[savedRef]}),/expected answer/i);
  const otherId=start({expectedAnswer:"Expert verified May.",measureGraders:[{metric:epsMetric,kind:"rubric",judgeId:models[2].id,threshold:1,evidence:"task-answer"},{metric:periodMetric,kind:"saved",graderId:savedRef}]});
  await present(bench.active).done;
  assert.equal(bench.exportRun(otherId).manifest.caseSetHash,bench.exportRun(id).manifest.caseSetHash);
  assert.equal(bench.quickExpectedAnswer(otherId),"Expert verified May.");
  assert.equal(judgeCalls.filter(c=>c.reference==="Expert verified May.").length,2);
  assert.equal(judgeCalls.filter(c=>c.reference==null).length,2);
  const traceGrader=save("Ad hoc private G-Eval",{type:"opik",judgeId:models[2].id,
    criteria:periodCriterion,requiredEvidence:["reference"]});
  const result=run.results[0],traceEvidence=graderEvidence(run.manifest,{case_id:result.caseId},result,false,traceGrader);
  traceEvidence.reference=bench.quickExpectedAnswer(id);
  const traceGrade=await bench.graders.record(bench.graders.get(traceGrader),traceEvidence,
    {run:id,candidate:result.candidateId,caseId:result.caseId},bench.adapters,AbortSignal.timeout(5000));
  assert.ok(traceGrade.reason.includes("EVID-371"));
  assert.ok(!run.manifest.graders.some(g=>g.id===traceGrader));
  const exported=bench.exportRun(id);
  assert.ok(!JSON.stringify(exported).includes("EVID-371"));
  assert.equal(exported.assessments.find(a=>a.graderId===traceGrader)?.value,traceGrade.value);

  const skippedId=start({inspectionOnly:true,measureGraders:[{metric:epsMetric,kind:"saved",graderId:saved},{metric:periodMetric,kind:"skip"}]});
  await present(bench.active).done;
  const skipped=bench.detail(skippedId);
  assert.equal(skipped.report?.verdict,"ungraded");
  assert.equal(skipped.report?.winnerId,null);
  assert.match(skipped.report?.summary??"",/Answer inspection was selected/);
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
  const quick=start({inspectionOnly:true});
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
  assert.equal(run.status,"failed");
  assert.equal(run.results.length,0);
  assert.equal(run.assessments.length,0);
  assert.match(run.manifest.error ?? "",/local decision model.*No candidate requests were sent/);
  assert.equal(graded.length,4,"the offline native judge prevented candidate and grading calls");
  offline=false;
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
  assert.equal(graded.length,8);
});

test("a scored comparison stops unmapped or missing measures before either model receives the task",async t=>{
  const {bench,start,save,candidateCalls,judgeCalls}=await setup(t,true);
  const id=save("EPS rule");
  assert.throws(()=>start({}),/Assign a quality grader/);
  assert.throws(()=>start({graderIds:[id]}),/Assign a quality grader/);
  assert.throws(()=>start({measureGraders:[{metric:epsMetric,kind:"saved",graderId:id},{metric:periodMetric,kind:"skip"}]}),/Reporting period citation/);
  assert.equal(candidateCalls.length,0);assert.equal(judgeCalls.length,0);assert.equal(bench.list().runs.length,0);
});

test("a legacy missing-reference pair accepts verified facts once and grades the saved answers without repeating inference",async t=>{
  const {bench,models,start,save,candidateCalls,judgeCalls}=await setup(t,true);
  const rule=save("EPS rule");
  const id=start({measureGraders:[{metric:epsMetric,kind:"saved",graderId:rule},{metric:periodMetric,kind:"rubric",judgeId:models[2].id,evidence:"reference",threshold:1}],expectedAnswer:"Approved at dispatch."});
  await present(bench.active).done;
  const grader=present(bench.detail(id).manifest.measureGraders?.[1].graderId);
  // Reproduce the pre-0037 record: both outputs persisted, both reference-based grades absent.
  bench.db.prepare("DELETE FROM quick_expected_answers WHERE run=?").run(id);
  bench.db.prepare("UPDATE assessments SET record=json_set(record,'$.value',NULL,'$.pass',NULL,'$.reason','This rubric requires a case reference. The case is unscored.') WHERE run=? AND json_extract(record,'$.graderId')=?").run(id,grader);
  bench.db.prepare("DELETE FROM run_reports WHERE run=?").run(id);
  const before=bench.detail(id),request={run:id,caseId:"prompt",grader};
  assert.equal(before.report?.verdict,"incomplete");
  await assert.rejects(bench.reviewSavedCase(request),/expected answer/i);
  assert.equal(judgeCalls.length,2);assert.equal(candidateCalls.length,2);
  const marker="Private review facts: June.";
  const work=bench.reviewSavedCase({...request,expectedAnswer:marker});
  await assert.rejects(bench.reviewSavedCase({...request,expectedAnswer:marker}),/already running/);
  await work;
  const reviewed=bench.detail(id);
  assert.equal(candidateCalls.length,2);assert.deepEqual(judgeCalls.slice(2).map(v=>v.reference),[marker,marker]);
  assert.deepEqual(reviewed.report,before.report);assert.deepEqual(reviewed.assessments,before.assessments);
  assert.equal(reviewed.reviewedVerdict?.verdict,"mixed");
  const group=present(reviewed.savedReviews?.[0]);
  assert.equal(group.status,"completed");assert.equal(group.source,"supplied for review");
  assert.deepEqual(group.grades.map(g=>[g.candidate,g.graderId,g.pass]),[[models[0].id,grader,false],[models[1].id,grader,true]]);
  const exported=bench.exportRun(id);
  assert.equal(JSON.stringify(exported).includes(marker),false);assert.equal(exported.report?.verdict,"incomplete");
  assert.equal(JSON.stringify(exported).includes(group.id),false);
  await assert.rejects(bench.reviewSavedCase({...request,expectedAnswer:marker}),/already scores/);
  const alternate=save("Supplemental EPS", {criteria:"EPS"});
  await bench.reviewSavedCase({...request,grader:alternate});
  assert.equal(bench.detail(id).reviewedVerdict?.verdict,"mixed");
  bench.db.prepare("UPDATE results SET record=json_set(record,'$.dispatchState','pending') WHERE run=? AND candidate=?").run(id,models[1].id);
  await assert.rejects(bench.reviewSavedCase({...request,grader:alternate}),/no saved answer/);
  assert.equal(candidateCalls.length,2);assert.equal(judgeCalls.length,4);
});

test("mixed primary and fallback score receipts stay retryable until one serving revision assesses both saved answers",async t=>{
  const {bench,approved,start,candidateCalls}=await setup(t);
  const primary="qa/decision-primary",alternate="qa/decision-alternate";
  const grader=bench.graders.save({name:"Supported EPS",industry:"Financial Services",category:"Evidence",type:"decision",
    criteria:"Does the answer give the supported EPS?",threshold:.8,decision:{provider:"local",model:primary,fallbackModel:alternate,failAt:.2}},[]);
  let phase:"original"|"mixed"|"stable"="original";
  const judgeModels:string[]=[];
  t.mock.method(globalThis,"fetch",async(url:RequestInfo|URL,options?:RequestInit)=>{
    if(String(url).endsWith("/v1/models")){
      const ids=phase==="mixed" && judgeModels.length===3?[alternate]:[primary,alternate];
      return Response.json({data:ids.map(id=>({id,output_modalities:["decisions"]}))});
    }
    assert.equal(String(url),"http://127.0.0.1:8080/v1/systemone");
    assert.ok(typeof options?.body==="string");
    const {model,state}=z.object({model:z.string(),state:z.string()}).parse(JSON.parse(options.body));
    const {output}=z.object({output:z.string()}).parse(JSON.parse(state));
    judgeModels.push(model);
    return Response.json({model,answers:{criterion:{type:"noul",noul:phase==="original"?.5:output.includes("GAAP")?.9:.1}}});
  });
  const metric=bench.quickGraderOptions(approved.id).measures[0].metric;
  const run=start({measureGraders:[{metric,kind:"saved",graderId:grader}]});
  await present(bench.active).done;
  const original=bench.detail(run);
  assert.equal(original.report?.verdict,"incomplete");
  phase="mixed";
  const request={run,grader,caseId:"prompt"};
  await bench.reviewSavedCase(request);
  const mixed=bench.detail(run),pair=present(mixed.savedReviews?.[0]);
  assert.deepEqual(pair.grades.map(g=>[g.decision?.actualModel,g.pass]),[[primary,true],[alternate,false]]);
  assert.match(pair.comparisonIssue ?? "",/multiple model revisions/);
  assert.equal(mixed.reviewedVerdict,undefined);
  phase="stable";
  await bench.reviewSavedCase(request);
  const stable=bench.detail(run);
  assert.deepEqual(stable.savedReviews?.[0],pair);
  assert.deepEqual(stable.savedReviews?.[1].grades.map(g=>g.decision?.actualModel),[primary,primary]);
  assert.equal(stable.reviewedVerdict?.verdict,"winner");
  assert.deepEqual(stable.report,original.report);
  await assert.rejects(bench.reviewSavedCase(request),/already scores/);
  assert.deepEqual(judgeModels,[primary,primary,primary,alternate,primary,primary]);
  assert.equal(candidateCalls.length,2);
});

test("supplemental field graders reuse compatible private JSON and name a missing field before either saved answer is graded",async t=>{
  const {bench,start,models,save,candidateCalls,judgeCalls}=await setup(t,true,model=>JSON.stringify({
    eps:model==="lfm3-1.7b"?0:12,flag:model!=="lfm3-1.7b"}));
  const rule=(name:string,outputField:string,referenceField:string)=>save(name,{type:"field",criteria:JSON.stringify({outputField,referenceField})});
  const savedField=rule("GAAP EPS","eps","reported.eps"),extraField=rule("Review flag","flag","reported.flag");
  const expectedAnswer=JSON.stringify({reported:{eps:0},privateMarker:"private-EPS-qa"});
  const run=start({inspectionOnly:true,expectedAnswer,measureGraders:[{metric:epsMetric,kind:"rubric",judgeId:models[2].id,threshold:1,evidence:"reference"},
    {metric:periodMetric,kind:"skip"}]});
  await present(bench.active).done;
  const request={run,caseId:"prompt"},initial=bench.detail(run);
  assert.ok(initial.quickFieldGraderIds?.includes(savedField));assert.ok(!initial.quickFieldGraderIds?.includes(extraField));
  assert.equal(JSON.stringify(initial).includes("private-EPS-qa"),false);
  await assert.rejects(bench.reviewSavedCase({...request,grader:savedField,expectedAnswer:'{"reported":{"eps":12}}'}),/evidence already saved/);
  await bench.reviewSavedCase({...request,grader:savedField});
  for(const substitute of [undefined,"ordinary text",'{"reported":{"other":true}}']) {
    await assert.rejects(bench.reviewSavedCase({...request,grader:extraField,expectedAnswer:substitute}),/reported.flag/);
  }
  assert.equal(bench.detail(run).savedReviews?.length,1);
  await bench.reviewSavedCase({...request,grader:extraField,expectedAnswer:'{"reported":{"flag":false}}'});
  const reviews=present(bench.detail(run).savedReviews);
  assert.deepEqual(reviews.map(r=>[r.source,r.grades.map(g=>g.value)]),[["saved run",[1,0]],["supplied for review",[1,0]]]);
  assert.equal(bench.quickExpectedAnswer(run),expectedAnswer);assert.equal(candidateCalls.length,2);assert.equal(judgeCalls.length,2);
});

test("Dataset recovery aligns reviewed pairs across cases and keeps every complete original pair on the chosen revision",async t=>{
  const {bench,models,candidateCalls}=await setup(t);
  const primary="qa/primary",alternate="qa/alternate";
  const grader=bench.graders.save({name:"Receipt evidence",industry:"Financial Services",category:"Grounding",type:"decision",
    criteria:"Does this answer report the GAAP figure?",threshold:.8,decision:{provider:"local",model:primary,fallbackModel:alternate,failAt:.2}},[]);
  const caseIds=["release-a","release-b"];
  const datasetId=bench.import("reference","Synthetic releases",caseIds.map(case_id=>JSON.stringify({case_id,dataset_version:"1",split:"development",prompt:"Report GAAP EPS."})).join("\n"),
    {industry:"Financial Services",family:"Synthetic releases",category:"Extraction"});
  let stage:"unscored"|"primary"|"alternate"|"original-split"|"reverse-primary"="unscored";
  const judgedCase=new AsyncLocalStorage<string>();
  const record=bench.graders.record.bind(bench.graders);
  t.mock.method(bench.graders,"record",(...args:Parameters<typeof record>)=>
    judgedCase.run(args[2].caseId ?? "",()=>record(...args)));
  const judges:string[]=[];
  t.mock.method(globalThis,"fetch",async(url:RequestInfo|URL,options?:RequestInit)=>{
    if(String(url).endsWith("/v1/models")){
      const other=stage==="alternate" || (stage==="original-split" && judgedCase.getStore()===caseIds[1]);
      return Response.json({data:(other?[alternate]:[primary,alternate]).map(id=>({id,output_modalities:["decisions"]}))});
    }
    assert.ok(typeof options?.body==="string");
    const {model,state}=z.object({model:z.string(),state:z.string()}).parse(JSON.parse(options.body));
    const {output}=z.object({output:z.string()}).parse(JSON.parse(state));judges.push(model);
    const passes=output.includes("GAAP")!==(stage==="reverse-primary");
    return Response.json({model,answers:{criterion:{type:"noul",noul:stage==="unscored"?.5:passes?.9:.1}}});
  });
  const runDataset=async()=>{
    const id=bench.start({mode:"dataset",datasetId,candidateIds:models.slice(0,2).map(m=>m.id),graderIds:[grader],datasetScorer:"selected-graders"});
    await present(bench.active).done;return id;
  };
  const run=await runDataset(),original=bench.detail(run);
  const review=(id:string,caseId:string)=>bench.reviewSavedCase({run:id,caseId,grader});
  assert.equal(original.report?.verdict,"incomplete");
  stage="primary";await review(run,caseIds[0]);
  stage="alternate";await review(run,caseIds[1]);
  const conflicting=bench.detail(run);
  assert.deepEqual(conflicting.savedReviews?.map(r=>r.grades.map(g=>g.decision?.actualModel)),[[primary,primary],[alternate,alternate]]);
  assert.equal(conflicting.reviewedVerdict,undefined);
  assert.deepEqual(conflicting.decisionReviewTargets?.[grader],{model:primary,caseIds:[caseIds[1]]});
  await assert.rejects(review(run,caseIds[0]),/already scores this case.*qa\/primary/);
  assert.equal(judges.length,8);
  stage="primary";await review(run,caseIds[1]);
  const resolved=bench.detail(run);
  assert.deepEqual(resolved.savedReviews?.slice(0,2),conflicting.savedReviews);
  assert.equal(resolved.reviewedVerdict?.verdict,"winner");assert.deepEqual(resolved.report,original.report);
  assert.equal(judges.length,10);assert.equal(candidateCalls.length,4);
  // Original complete pairs can also disagree about their served judge. Only the alternate case needs new grades.
  stage="original-split";
  const split=await runDataset(),before=bench.detail(split);
  assert.equal(before.report?.verdict,"incomplete");
  assert.deepEqual(before.decisionReviewTargets?.[grader],{model:primary,caseIds:[caseIds[1]]});
  await assert.rejects(review(split,caseIds[0]),/already scores this case/);
  stage="reverse-primary";await review(split,caseIds[1]);
  const after=bench.detail(split);
  assert.equal(after.reviewedVerdict?.verdict,"tie","The complete original primary case offsets the newly reviewed case.");
  assert.deepEqual(after.report,before.report);assert.deepEqual(after.assessments,before.assessments);
  assert.deepEqual(after.savedReviews?.map(r=>r.caseId),[caseIds[1]]);
  assert.deepEqual(after.decisionReviewTargets?.[grader],{model:primary,caseIds:[]});
  assert.equal(judges.length,16);assert.equal(candidateCalls.length,8);
});

test("generated pass/fail rubrics reject an off-anchor judge score and preserve the rubric on both lanes",async t=>{
  const {bench,models,approved,start}=await setup(t,true);
  const options=bench.quickGraderOptions(approved.id);
  const id=start({measureGraders:options.measures.map(m=>({metric:m.metric,kind:"rubric",judgeId:models[2].id,threshold:1}))});
  await present(bench.active).done;
  const pin=bench.detail(id).manifest.graders.find(g=>g.origin?.measure===epsMetric);
  assert.ok(pin?.type==="opik" && pin.scoreScale==="binary");
  assert.match(pin.criteria,/Only the candidate output establishes/);
  const result=await bench.graders.assess(pin,{input:"GAAP EPS is 1.24",reference:null,output:"Adjusted EPS is 1.80."},{
    ...bench.adapters,invoke:async(_model,messages)=>opikJudgeRequest(messages)?.stage==="geval-steps"
      ? reply("Check the basis and amount against the release.") : reply(JSON.stringify({score:5,reason:"Only part of the requirement matched."}))
  },new AbortController().signal);
  assert.equal(result.value,null);
  assert.match(result.reason,/partial credit for a pass\/fail rubric/);
});

test("Quick setup pins only the grounded inspection checks supported by the approved task and schema before inference",async t=>{
  const {domainStarters}=await import("../lib/domain-starters.cjs");
  const {inspectionRuleId,inspectionRangeId}=await import("../lib/inspection-decision.cjs");
  const starter=domainStarters.find(s=>s.packId==="manufacturing");assert.ok(starter);
  const {bench,models,candidateCalls,judgeCalls}=await setup(t,false,model=>JSON.stringify({
    disposition:model==="lfm3-1.7b"?"review":"Accept",next_action:model==="lfm3-1.7b"?"signed_recheck":"None",shift_note_completes_disposition:false,
    applicable_drawing:model==="lfm3-1.7b"?"B permits 9.97–10.03 mm inclusive":"B",reading:10.04,limit_range:10.03,
  }));
  const properties={disposition:{type:"string"},next_action:{type:"string"},shift_note_completes_disposition:{type:"boolean"},
    applicable_drawing:{type:"string"},reading:{type:"number"},limit_range:{type:"number"}};
  function save(id:string,task:string,fields:Record<string,{type:string}>,pairs?:{metric:string;criterion:string}[]){
    const spec={mode:"quick",domain:"Manufacturing",id,familyId:id,version:1,title:"Receiving inspection",objective:task,prompt:task,datasetId:null,
      metrics:pairs?.map(p=>p.metric) ?? [],requirements:pairs?.map(p=>p.criterion) ?? [],...(pairs && {metricCriteria:pairs}),input:{task,inputs:{}},outputSchema:{type:"object",properties:fields,required:Object.keys(fields),additionalProperties:false}};
    bench.db.prepare("INSERT INTO outcome_prompts VALUES(?,?,?,?,?,?)").run(id,id,1,id,"synthetic",JSON.stringify(spec));
  }
  save("approved-inspection",starter.quickObjective,properties);
  const options=bench.quickGraderOptions("approved-inspection");
  assert.equal(options.sourcedInspection,true);
  assert.deepEqual(options.automatic.filter(g=>g.industry==="Manufacturing").map(g=>g.id),[inspectionRuleId,inspectionRangeId]);
  const candidates=models.slice(0,2).map(m=>m.id);
  const id=bench.start({mode:"quick",candidateIds:candidates,approvedPromptId:"approved-inspection"});
  await present(bench.active?.done);
  const saved=bench.detail(id);
  assert.equal(saved.status,"completed");assert.equal(candidateCalls.length,2);assert.equal(judgeCalls.length,0);
  for(const check of [inspectionRuleId,inspectionRangeId]){
    const scores=saved.assessments.filter(a=>a.graderId===check);
    assert.deepEqual(candidates.map(candidate=>scores.find(a=>a.candidate===candidate)?.value),[1,0]);
  }
  save("unverified-inspection","Inspect a different bearing against its drawing.",properties);
  assert.throws(()=>bench.start({mode:"quick",candidateIds:candidates,approvedPromptId:"unverified-inspection",graderIds:[inspectionRuleId]}),/approved JSON disposition/i);
  for(const type of ["boolean","integer"]){
    const id="unrepresentable-"+type;
    save(id,starter.quickObjective,{...properties,lower_mm:{type},upper_mm:{type}});
    assert.ok(!bench.quickGraderOptions(id).automatic.some(g=>g.id===inspectionRangeId));
    assert.throws(()=>bench.start({mode:"quick",candidateIds:candidates,approvedPromptId:id,graderIds:[inspectionRangeId]}),/drawing limits|incompatible|both lower_mm/i);
    assert.equal(candidateCalls.length,2,"Invalid required inspection fields block both lanes before inference.");
  }
  save("prose-inspection",starter.quickObjective,{explanation:{type:"string"}});
  assert.ok(!bench.quickGraderOptions("prose-inspection").automatic.some(g=>g.industry==="Manufacturing"));
  assert.throws(()=>bench.start({mode:"quick",candidateIds:candidates,approvedPromptId:"prose-inspection",graderIds:[inspectionRuleId]}),/JSON disposition or routing/);
  assert.equal(candidateCalls.length,2);assert.equal(judgeCalls.length,0);

  const pairs=[
    {metric:"Cite applicable drawing limit and reading",criterion:"Identify the correct drawing (B vs A) and state the permitted range for sample S1, and cite the actual reading."},
    {metric:"Identify next action and state whether shift note establishes completion",criterion:"Determine the required next step for an out-of-limit sample (e.g., send to Quality for a signed recheck) and decide if the shift note 'Recheck after changeover' confirms completion."},
  ];
  save("measured-inspection",starter.quickObjective,properties,pairs);
  const choices=bench.quickGraderOptions("measured-inspection");
  const assignments=choices.measures.map(row=>{
    assert.ok("defaultGraderId" in row && typeof row.defaultGraderId==="string");
    return {kind:"saved" as const,metric:row.metric,graderId:row.defaultGraderId};
  });
  assert.deepEqual(assignments.map(a=>a.graderId),[inspectionRangeId,inspectionRuleId]);
  assert.ok(!choices.automatic.some(g=>g.industry==="Manufacturing"),"An explicit removal must not re-add the native version through automatic checks");
  const beforeConflict=candidateCalls.length;
  assert.throws(()=>bench.start({mode:"quick",approvedPromptId:"measured-inspection",candidateIds:candidates,
    measureGraders:assignments,expectedAnswer:JSON.stringify({unit:"inches",active:"C",upper_mm:"15.1"})}),/disagrees with the approved inspection source/);
  assert.equal(candidateCalls.length,beforeConflict);
  const measured=bench.start({mode:"quick",approvedPromptId:"measured-inspection",candidateIds:candidates,measureGraders:assignments});
  await present(bench.active?.done);
  const comparison=bench.detail(measured);
  assert.deepEqual(comparison.manifest.measureGraders?.map(m=>m.graderId),[inspectionRangeId,inspectionRuleId]);
  assert.equal(comparison.report?.winnerId,candidates[0]);assert.equal(judgeCalls.length,0);
  const other=bench.graders.save({name:"My handoff rule",type:"contains",industry:"Manufacturing",category:"Review",criteria:"signed",threshold:1},models);
  const replacement=bench.start({mode:"quick",approvedPromptId:"measured-inspection",candidateIds:candidates,
    measureGraders:[assignments[0],{...assignments[1],graderId:other}]});
  await present(bench.active?.done);
  assert.ok(!bench.detail(replacement).manifest.graders.some(g=>g.id===inspectionRuleId));

  const privateReference={active:"HIDDEN_REV824",rule:"inclusive_limits",lower_mm:"660.123000001",upper_mm:"660.123000006",measured_mm:"660.123000007"};
  const privateRun=bench.start({mode:"quick",approvedPromptId:"unverified-inspection",candidateIds:candidates,graderIds:[inspectionRuleId,inspectionRangeId],expectedAnswer:JSON.stringify(privateReference)});
  await present(bench.active?.done);
  const local=bench.detail(privateRun),transfer=bench.exportRun(privateRun);
  assert.equal(local.status,"completed");
  for(const evidence of [local.assessments,local.report,transfer]){
    assert.doesNotMatch(JSON.stringify(evidence),/HIDDEN_REV824|660\.12300000[167]/);
  }
  const grades=local.assessments.filter(g=>g.graderId===inspectionRuleId);
  assert.deepEqual(candidates.map(c=>grades.find(g=>g.candidate===c)?.value),[1,0],"Masking the expected answer preserves real scores for both lanes");
  save("different-measures",starter.quickObjective,properties,[{metric:"Report the sample identifier",criterion:"State the lot ID."}]);
  assert.ok(bench.quickGraderOptions("different-measures").measures.every(row=>!("defaultGraderId" in row)));
});

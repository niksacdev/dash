import {test} from "node:test";
import assert from "node:assert/strict";
import {Bench} from "../lib/bench.cjs";
import {scoringOptions} from "../lib/score-readiness.cjs";
import {judgeRegistrationIssue,judgeConflictMap,independentJudgeIssue} from "../lib/judge-independence.cjs";
import {decodeGraderSpec,type GraderSpec} from "../lib/graders.cjs";
import type {LocalCandidate,CompatibleCandidate} from "../lib/runtime-types.cjs";
import {inventory,reply,withoutPower,present} from "./runtime-fixtures.cjs";

const local=(model:string,nativeKey?:string):LocalCandidate=>({id:"lmstudio/"+model,provider:"lmstudio",kind:"model",model,nativeKey,loaded:true});
const compatible=(id:string,model:string):CompatibleCandidate=>({id,model,provider:"compatible",kind:"model",section:"Hosted",endpoint:"https://example.test/v1",keyRequired:false});
const liquid=local("operator-slot-1","liquidai/LFM3-1.7B-GGUF"), second=local("Qwen/Qwen3-8B"), independent=local("local-judge-qa");
const common={id:"qa-grade",name:"Answer quality",category:"Quality",industry:"General",version:1,threshold:1,criteria:"Grade the supplied answer."};
const chat=(judge:LocalCandidate,method:"judge"|"opik"|"opik-metric"="judge"):GraderSpec=>decodeGraderSpec({...common,type:method,judge,...(method==="opik-metric" && {metricKey:"answer-relevance"})});
const policy=(model:string,fallbackModel?:string):GraderSpec=>decodeGraderSpec({...common,type:"decision",judge:null,decision:{provider:"local",endpoint:"http://127.0.0.1:8181",protocol:model.startsWith("/")?"mlx-vlm":"systemone",model,failAt:.2,fallbackModel}});

test("judge independence matches checkpoint aliases, distributions and local inventory without equating unrelated models",()=>{
  const oldPin=local("operator-slot-1");delete oldPin.nativeKey;
  const candidates=[compatible("hosted/check","liquid/lfm3-1.7b"),compatible("hosted/other","another-studio/lfm3-1.7b")];
  assert.deepEqual(judgeConflictMap([chat(oldPin)],[liquid],candidates).judgeCandidateConflicts[common.id],["hosted/check"]);
  for(const type of ["judge","opik","opik-metric"] as const)assert.match(independentJudgeIssue([chat(liquid,type)],[],candidates) ?? "",/independent model/);
  const qwen:LocalCandidate={...second,provider:"ollama",id:"ollama/qwen3:8b",model:"qwen3:8b"};
  assert.deepEqual(judgeConflictMap([], [qwen],[second]).modelCandidateConflicts[qwen.id],[second.id]);
  const sameServer={...compatible("private-api","opaque-production"),endpoint:"http://127.0.0.1:8080/v1"};
  for(const endpoint of [undefined,"http://127.0.0.1:8080"]){
    const pin=decodeGraderSpec({...common,type:"decision",judge:null,decision:{provider:"local",model:sameServer.model,failAt:.2,endpoint}});
    assert.match(independentJudgeIssue([pin],[],[sameServer]) ?? "",/independent model/);
    assert.equal(independentJudgeIssue([pin],[],[{...sameServer,endpoint:"http://127.0.0.1:8181/v1"}]),undefined);
  }
  const defaultPin=decodeGraderSpec({...common,type:"decision",judge:null,decision:{provider:"local",model:sameServer.model,failAt:.2}});
  for(const host of ["localhost","localhost.","127.0.0.1","127.1","[::1]","[0:0:0:0:0:0:0:1]"]){
    for(const root of ["/","/v1","/v1/"]){
      assert.match(independentJudgeIssue([defaultPin],[],[{...sameServer,endpoint:"http://"+host+":8080"+root}]) ?? "",/independent model/);
    }
  }
  for(const endpoint of ["https://localhost:8080/v1","http://localhost:8181/v1","http://localhost:8080/other/v1",
    "http://localhost.example.test:8080/v1","http://127.0.0.2:8080/v1","http://192.0.2.1:8080/v1"]){
    assert.equal(independentJudgeIssue([defaultPin],[],[{...sameServer,endpoint}]),undefined);
  }
  const standardPort=decodeGraderSpec({...common,type:"decision",judge:null,decision:{provider:"local",endpoint:"https://[::1]",model:sameServer.model,failAt:.2}});
  assert.match(independentJudgeIssue([standardPort],[],[{...sameServer,endpoint:"https://localhost:443/v1"}]) ?? "",/independent model/);
  const d1=local("fast-embed","mlx-community/D1-Omni-2B-MLX-4bit");
  assert.match(independentJudgeIssue([policy("LiquidAI/D1-Omni-2B")],[],[d1]) ?? "",/independent model/);
  assert.match(independentJudgeIssue([policy("LiquidAI/D1-Omni-2B","LiquidAI/LFM3-1.7B")],[],[liquid]) ?? "",/fallback/);
  const registered={...local("native-d1","d1-omni-2b-mlx"),nativePublisher:"LiquidAI",quantization:"FP16"};
  const path="/Users/synthetic/.lmstudio/models/LiquidAI/d1-Omni-2B-MLX-fp16";
  assert.match(independentJudgeIssue([policy(path)],[],[registered]) ?? "",/independent model/);
  const api={...compatible("local-api","LiquidAI/d1-Omni-2B-MLX-fp16"),endpoint:"http://127.0.0.1:1234/v1"};
  assert.match(independentJudgeIssue([policy(path)],[],[api]) ?? "",/independent model/);
  for(const distinct of [{...api,model:api.model.replace("fp16","q4")},{...api,model:api.model.replace("LiquidAI","Private")},{...api,endpoint:"https://example.test/v1"}])
    assert.equal(independentJudgeIssue([policy(path)],[],[distinct]),undefined);
  for(const differentPath of [path.replace("fp16","q4"),path.replace("LiquidAI","private"),path.replace(".lmstudio/models","unrelated")]){
    assert.equal(independentJudgeIssue([policy(differentPath)],[],[registered]),undefined);
  }
  for(const different of ["private-org/lfm3-1.7b","liquidai/lfm3-1.7b-thinking","liquidai/lfm3-omni-2b","liquidai/lfm3-1.7b-customer-tune"]){
    assert.equal(independentJudgeIssue([chat(liquid)],[],[compatible("p",different)]),undefined);
  }
  const misleading={...local("lfm3-1.7b","lfm3-1.7b-private-tune"),nativePublisher:"Customer"};
  assert.equal(independentJudgeIssue([chat(misleading)],[],candidates),undefined);
  assert.equal(independentJudgeIssue([chat(misleading)],[],[local("lfm3-1.7b","liquidai/LFM3-1.7B")]),undefined);
  assert.match(independentJudgeIssue([chat({...misleading,nativeKey:undefined})],[misleading],candidates) ?? "",/verify the saved judge/);
  assert.equal(independentJudgeIssue([chat(local("production"))],[],[compatible("external","production")]),undefined);
});

test("Quick rejects a conflicting explicit judge and supplemental reviews protect completed answers without changing receipts",async t=>{
  let calls=0;
  const bench=new Bench(":memory:",{discover:async()=>[inventory([liquid,second,independent])],invoke:async()=>{calls++;return reply("OK");}},withoutPower);
  t.after(()=>bench.db.close());await bench.refresh();
  const prompt={id:"synthetic-prompt",familyId:"synthetic-prompt",version:1,domain:"Manufacturing",mode:"quick",title:"Check a lot",
    prompt:"Report the lot identifier.",objective:"Report the lot identifier.",metrics:[],requirements:[]};
  bench.db.prepare("INSERT INTO outcome_prompts VALUES(?,?,?,?,?,?)").run(prompt.id,prompt.id,1,prompt.id,"synthetic",JSON.stringify(prompt));
  const run={mode:"quick" as const,approvedPromptId:prompt.id,candidateIds:[liquid.id,second.id]};
  const bad=bench.graders.save({...common,type:"opik",judgeId:liquid.id},[liquid]);
  assert.deepEqual(bench.quickGraderOptions(prompt.id).judgeCandidateConflicts[bad],[liquid.id]);
  assert.throws(()=>bench.start({...run,graderIds:[bad]}),/independent model/);
  assert.throws(()=>bench.start({...run,outcomeRubric:{judgeId:second.id}}),/independent model/);
  assert.equal(calls,0);assert.equal(bench.list().runs.length,0);
  const runId=bench.start({...run,inspectionOnly:true});await present(bench.active).done;
  const before=bench.detail(runId);
  assert.equal(before.status,"completed");assert.ok(before.conflictingReviewGraderIds?.includes(bad));
  await assert.rejects(bench.reviewSavedCase({run:runId,caseId:before.manifest.caseIds[0],grader:bad}),/independent model/);
  const after=bench.detail(runId);assert.equal(calls,2);
  assert.deepEqual([after.report,after.assessments,after.savedReviews],[before.report,before.assessments,before.savedReviews]);
});

test("an authenticated OpenRouter alias resolving to a candidate produces unscored original and saved reviews",async t=>{
  const env=process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_API_KEY="synthetic-test-only";
  t.after(()=>{if(env===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=env;});
  const alias="synthetic/auditor",canonical="liquidai/lfm3-1.7b";
  const remoteCalls:string[]=[];
  t.mock.method(globalThis,"fetch",async(url:RequestInfo|URL)=>{
    remoteCalls.push(String(url));
    if(String(url)==="https://openrouter.ai/api/alpha/decisions")
      return Response.json({model:canonical,answers:{criterion:{type:"noul",noul:1}},usage:{input_tokens:11,cost:.00001}});
    assert.equal(String(url),"https://openrouter.ai/api/v1/models?output_modalities=decisions");
    return Response.json({data:[{id:alias,canonical_slug:canonical,architecture:{output_modalities:["decisions"]}}]});
  });
  let generations=0;
  const bench=new Bench(":memory:",{discover:async()=>[inventory([liquid,second])],invoke:async()=>{generations++;return reply("Lot K7");}},withoutPower);
  t.after(()=>bench.db.close());await bench.refresh();
  const prompt={id:"alias-check",familyId:"alias-check",version:1,domain:"Manufacturing",mode:"quick",title:"Check lot",
    prompt:"Return lot K7.",objective:"Return lot K7.",metrics:[],requirements:[]};
  bench.db.prepare("INSERT INTO outcome_prompts VALUES(?,?,?,?,?,?)").run(prompt.id,prompt.id,1,prompt.id,"synthetic",JSON.stringify(prompt));
  const grader=bench.graders.save({...common,type:"decision",decision:{provider:"openrouter",model:alias,failAt:.2}},[]);
  const run=bench.start({mode:"quick",approvedPromptId:prompt.id,candidateIds:[liquid.id,second.id],graderIds:[grader],allowHostedDecision:true});
  await present(bench.active).done;
  const before=bench.detail(run);assert.equal(generations,2);assert.equal(before.report?.verdict,"incomplete");
  const grades=before.assessments.filter(g=>g.graderId===grader);assert.equal(grades.length,2);
  for(const grade of grades){
    assert.deepEqual([grade.value,grade.pass,grade.judgeConflict,grade.decision?.usage?.inputTokens],[null,null,true,11]);
  }
  const cells=before.report?.metrics.find(m=>m.id===grader)?.caseScores[0].values;
  assert.ok(cells && cells.every(v=>v.score===null && v.decision?.actualModel===canonical && v.decision.status==="unscored" && v.decision.probabilityYes===undefined));
  await bench.reviewSavedCase({run,caseId:before.manifest.caseIds[0],grader,allowHostedDecision:true});
  const after=bench.detail(run);
  assert.equal(after.savedReviews?.[0].finding?.status,"inconclusive");
  assert.ok(after.savedReviews?.[0].grades.every(g=>g.judgeConflict && g.value===null));assert.deepEqual(after.report,before.report);
  assert.equal(after.reviewedVerdict,undefined);assert.equal(generations,2);
  assert.ok(remoteCalls.length>=4);
});

test("a reassigned live judge slot blocks grading before dispatch while earlier answered checkpoints retain their identity",async t=>{
  const original=local("operator-slot","liquidai/LFM3-1.7B"),replacement=local("operator-slot","Qwen/Qwen3-8B");
  const stale=chat(original),fresh=chat(replacement),opaque=chat(local("operator-slot"));
  for(const pin of [stale,opaque]){
    assert.match(independentJudgeIssue([pin],[replacement],[replacement]) ?? "",/verify the saved judge/);
    assert.match(scoringOptions([pin],[replacement]).setupIssues[pin.id],/verify the saved judge/);
  }
  assert.equal(judgeRegistrationIssue(fresh,[replacement]),undefined);
  assert.equal(independentJudgeIssue([fresh],[replacement],[original]),undefined,"A valid new judge differs from the pinned historical answer model.");
  assert.match(independentJudgeIssue([fresh],[replacement],[replacement]) ?? "",/independent model/);
  const named=local("Qwen/Qwen3-8B"),registered={...named,nativeKey:named.model};
  assert.equal(judgeRegistrationIssue(chat(named),[registered]),undefined,"A legacy name that identifies the native checkpoint still works.");
  assert.match(judgeRegistrationIssue(stale,[{...original,nativeKey:undefined}]) ?? "",/verify the saved judge/);
  assert.match(judgeRegistrationIssue(stale,[]) ?? "",/Reconnect/);
  let live=original,calls=0;
  const bench=new Bench(":memory:",{discover:async()=>[inventory([live,independent])],invoke:async()=>{calls++;return reply("K7");}},withoutPower);
  t.after(()=>bench.db.close());await bench.refresh();
  const id=bench.graders.save({...common,type:"judge",judgeId:original.id},[original]);
  const prompt={id:"judge-rebinding",familyId:"judge-rebinding",version:1,domain:"Manufacturing",mode:"quick",title:"Check lot",prompt:"Return lot K7.",objective:"Return lot K7.",metrics:[],requirements:[]};
  bench.db.prepare("INSERT INTO outcome_prompts VALUES(?,?,?,?,?,?)").run(prompt.id,prompt.id,1,prompt.id,"synthetic",JSON.stringify(prompt));
  const options={mode:"quick" as const,approvedPromptId:prompt.id,candidateIds:[original.id,independent.id]};
  const initial=bench.start({...options,inspectionOnly:true});await present(bench.active).done;
  live=replacement;await bench.refresh();
  const count=calls;assert.match(bench.quickGraderOptions(prompt.id).setupIssues[id],/verify the saved judge/);
  assert.throws(()=>bench.start({...options,graderIds:[id]}),/verify the saved judge/);
  assert.throws(()=>bench.requireIndependentJudge(bench.graders.get(id),[]),/verify the saved judge/);
  const saved=bench.detail(initial);
  await assert.rejects(bench.reviewSavedCase({run:initial,caseId:saved.manifest.caseIds[0],grader:id}),/verify the saved judge/);
  assert.equal(calls,count);assert.equal(bench.list().runs.length,1);assert.deepEqual(bench.detail(initial).assessments,saved.assessments);
});

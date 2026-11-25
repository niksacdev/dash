import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {DatabaseSync} from "node:sqlite";
import {z} from "opik";
import {designGraderPlan,confirmGraderPlan} from "../lib/grader-designer.cjs";
import {Bench} from "../lib/bench.cjs";
import {Graders,generalDefaultKey} from "../lib/graders.cjs";
import {caseMessages,graderEvidence,referencePack} from "../lib/evaluation-cases.cjs";
import type {CaseRow,RunResult} from "../lib/run-types.cjs";
import {buildReport} from "../lib/run-report.cjs";
import {checklistHelp,completenessChecklist,completenessId} from "../lib/semantic-completeness.cjs";
import {requestedItemInstructions} from "../lib/decision-model.cjs";
import type {LocalCandidate} from "../lib/runtime-types.cjs";
import {inventory,reply,withoutPower,present} from "./runtime-fixtures.cjs";
const model="liquid/d1-omni-2b",items=["the reporting quarter","the reported earnings per share"];
const prompt="Read the release. In Q2 the company earned $1.04 per share.\nRequired deliverables:\n- "+items.join("\n- ");
const config=(endpoint:string)=>({presetId:completenessId,threshold:0.8,decision:{provider:"local",endpoint,protocol:"systemone",model,failAt:.2}});
const nativeRequest=z.object({model:z.string(),state:z.string(),questions:z.object({criterion:z.object({instructions:z.string(),type:z.literal("noul")})})});
async function localServer(t:TestContext,protocol:"systemone"|"mlx-vlm"="systemone") {
  const identity=protocol==="mlx-vlm"?"/synthetic/d1-omni-2b":model;
  const calls:{question:string;state:string}[]=[];
  let interruptAfter=0,controller:AbortController|undefined;
  const server=createServer(async(req,res)=>{
    const send=(body:unknown)=>{res.setHeader("Content-Type","application/json");res.end(JSON.stringify(body));};
    if(req.url==="/health")return send({status:"healthy",loaded_models:{decision:{model:identity,model_kind:"decision"}}});
    if(req.url==="/v1/models")return send({data:[{id:model,output_modalities:["decisions"]},{id:"other",output_modalities:["decisions"]}]});
    if(req.url!==(protocol==="mlx-vlm"?"/v1/decisions":"/v1/systemone") || req.method!=="POST"){res.writeHead(404);res.end();return;}
    const body:Buffer[]=[];for await (const chunk of req)body.push(Buffer.from(chunk));
    const parsed=nativeRequest.parse(JSON.parse(Buffer.concat(body).toString()));
    const {output,requested_item:item}=z.object({output:z.string(),requested_item:z.string()}).parse(JSON.parse(parsed.state));
    const question=parsed.questions.criterion.instructions;
    calls.push({question,state:parsed.state});
    if(parsed.model!==identity || question!==requestedItemInstructions || !item){res.writeHead(400);res.end();return;}
    if(interruptAfter===calls.length){controller?.abort();res.end();return;}
    // A controlled native double isolates threshold/commit behavior from model calibration.
    const second=item===items[1];
    const affirmative=second ? /\$\d/.test(output) : item==="the lot ID" ? /LOT-\d+/.test(output) : /Q[1-4]/.test(output);
    const unsure=second && output.includes("uncertain");
    const wrongIdentity=second && output.includes("mismatch");
    const p=unsure?.5:affirmative?.90:.10;
    const criterion=protocol==="mlx-vlm" ? {type:"bool",value:p>=.5,probability:p} : {type:"noul",noul:p};
    send({model:wrongIdentity?"wrong-model":identity,answers:{criterion},usage:{input_tokens:20,output_tokens:0}});
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  t.after(()=>new Promise<void>((resolve,reject)=>{server.close(err=>err?reject(err):resolve());server.closeAllConnections();}));
  const address=server.address();assert.ok(address && typeof address!=="string");
  return {endpoint:"http://127.0.0.1:"+address.port,identity,calls,cancelAfter(n:number,c:AbortController){interruptAfter=calls.length+n;controller=c;}};
}
const offline={discover:async()=>[],invoke:async()=>assert.fail("Unexpected chat invocation")};

test("only explicit candidate-visible obligations form a bounded checklist",()=>{
  const flow=(text:string)=>completenessChecklist({approved:{prompt:text}});
  assert.deepEqual(flow(prompt),{source:"candidate task",items});
  assert.deepEqual(flow("Required deliverables:\n\n- the reporting\n  quarter\n\n- the reported earnings per share"),flow(prompt));
  assert.equal(completenessChecklist({approved:{prompt:"Report the facts.",outputSchema:{type:"object",required:["eps"],properties:{eps:{type:"number"}}}}}),null);
  assert.equal(completenessChecklist({approved:{prompt,input:{task:"Report the facts."},outputSchema:{}}}),null);
  assert.equal(completenessChecklist({approved:{prompt},row:{prompt:"Read the release."},pack:{kind:"reference"}}),null);
  assert.deepEqual(completenessChecklist({approved:{prompt},row:{prompt:"Read the release."},pack:{outputSchema:{}}}),flow(prompt));
  assert.equal(completenessChecklist({row:{prompt,input:{required_deliverables:items},messages:[{role:"assistant",content:prompt},{role:"user",content:"Now say hello."}]}}),null);
  assert.deepEqual(completenessChecklist({row:{prompt,input:{required_deliverables:["a ticker symbol"]}}}),{source:"candidate task + case input",items:[...items,"a ticker symbol"]});
  for(const bad of [[],[""],["x".repeat(201)],Array.from({length:9},(_,i)=>String(i))])
    assert.equal(completenessChecklist({row:{prompt,input:{required_deliverables:bad}}}),null);
});

test("a discovered immutable local preset records individual Opik decisions, independent uncertainty and interrupted receipts",async t=>{
  const native=await localServer(t),db=new DatabaseSync(":memory:");t.after(()=>db.close());
  const graders=new Graders(db),pin=config(native.endpoint);
  assert.throws(()=>graders.save(pin,[]),/Find decision models/);
  await graders.discoverDecisionModels(native.endpoint);
  const id=graders.save(pin,[]),g=graders.get(id);
  assert.equal(graders.save(pin,[]),id);assert.equal(generalDefaultKey(g),null);assert.ok(g.type==="decision" && g.presetId===completenessId);
  for(const edit of [{decision:{...pin.decision,model:"other"}},{decision:{...pin.decision,provider:"openrouter"}},{decision:{...pin.decision,fallbackModel:"other"}},{threshold:.7},{criteria:"Award a factual grade."}])
    assert.throws(()=>graders.save({...pin,...edit},[]),/Activate the shipped/);
  const evaluate=(output:string,signal=new AbortController().signal,input:unknown=prompt)=>graders.record(g,{input,output,reference:"KEEP_REFERENCE_PRIVATE",rubric:"KEEP_RUBRIC_PRIVATE"},{run:"suite",candidate:"synthetic",caseId:output},offline,signal);
  const pass=await evaluate("Q4, $0.20."),miss=await evaluate("$1.04."),abstain=await evaluate("Q2, uncertain."),failed=await evaluate("Q2, mismatch.");
  assert.equal(pass.value,1,"factually wrong concrete values can be present");
  assert.equal(miss.value,0,"quarter only appears in task");
  assert.equal(abstain.value,null);assert.equal(failed.value,null);
  assert.deepEqual(pass.completeness?.usage,{inputTokens:40,outputTokens:0,totalTokens:40});
  assert.deepEqual(failed.completeness?.usage,{inputTokens:null,outputTokens:null,totalTokens:null});
  assert.equal(pass.decision,undefined);
  for(const call of native.calls){assert.doesNotMatch(call.state,/KEEP_REFERENCE_PRIVATE|KEEP_RUBRIC_PRIVATE/);assert.deepEqual(Object.keys(JSON.parse(call.state)).sort(),["input","output","requested_item"]);}
  const before=native.calls.length,m=await evaluate("Q2, $1.04.",undefined,"Read the release.");
  assert.equal(m.value,null);assert.equal(m.reason,checklistHelp);assert.equal(native.calls.length,before);
  const c=new AbortController();native.cancelAfter(2,c);
  const stopped=await evaluate("Q2, $1.04.",c.signal);
  assert.equal(stopped.value,null);assert.equal(stopped.completeness?.items[0].pass,true);assert.equal(stopped.completeness?.items[1].decision,undefined);
  assert.equal(graders.recorded("suite").length,6);
  assert.deepEqual(graders.recorded("suite")[1].completeness?.items.map(x=>[x.requirement,x.pass]),[[items[0],false],[items[1],true]]);
});

test("SystemOne and MLX receive fixed instructions and only active task, answer and one requested item in state",async t=>{
  const special='the field named "net_result" (synthetic marker ITEM_X9)';
  const row:CaseRow={case_id:"chat",reference:"PRIVATE_REFERENCE",sme_rationale:"PRIVATE_NOTE",rubric:"PRIVATE_RUBRIC",messages:[
    {role:"system",content:"Required deliverables:\n- the lot ID"},
    {role:"user",content:"Required deliverables:\n- stale input marker"},
    {role:"assistant",content:"Required deliverables:\n- stale output marker"},
    {role:"user",content:"For the next batch, provide a summary.\nRequired deliverables:\n- "+special},
  ]};
  const manifest={pack:referencePack,mode:"dataset" as const},messages=caseMessages(manifest,row);
  const answer="Q2: net_result is positive.";
  const result:RunResult={candidateId:"synthetic",caseId:"chat",output:answer,error:null,score:null,telemetry:null,dispatchedMessages:messages,
    trace:{id:"synthetic",runId:"test",candidateId:"synthetic",caseId:"chat",started:"2026-01-01",steps:[]}};
  const evidence=graderEvidence(manifest,row,result);
  const expected={source:"system instruction + candidate task",items:["the lot ID",special]};
  assert.deepEqual(completenessChecklist({row,pack:referencePack}),expected);
  assert.deepEqual(completenessChecklist({input:messages}),expected);
  assert.deepEqual(evidence.completenessChecklist,expected);
  for(const protocol of ["systemone","mlx-vlm"] as const){
    const native=await localServer(t,protocol),db=new DatabaseSync(":memory:");t.after(()=>db.close());
    const graders=new Graders(db);await graders.discoverDecisionModels(native.endpoint,protocol);
    const binding=config(native.endpoint);
    const g=graders.get(graders.save({...binding,decision:{...binding.decision,model:native.identity,protocol}},[]));
    const score=await graders.assess(g,evidence,offline,new AbortController().signal);
    assert.equal(score.value,0,"omitting the system's lot ID cannot pass");
    assert.deepEqual(score.completeness?.items.map(x=>[x.requirement,x.pass]),[["the lot ID",false],[special,true]]);
    assert.equal(native.calls.length,2);assert.equal(new Set(native.calls.map(c=>c.question)).size,1);
    for(const [i,call] of native.calls.entries()){
      assert.equal(call.question,requestedItemInstructions);
      assert.doesNotMatch(call.question,/ITEM_X9|the lot ID/);
      const state=z.object({input:z.array(z.object({role:z.string(),content:z.string()})),output:z.string(),requested_item:z.string()}).strict().parse(JSON.parse(call.state));
      assert.deepEqual(state,{input:[messages[0],messages[3]],output:answer,requested_item:expected.items[i]});
      assert.doesNotMatch(call.state,/stale input marker|stale output marker|PRIVATE_REFERENCE|PRIVATE_NOTE|PRIVATE_RUBRIC/);
    }
  }
});

test("Quick and Dataset preflight the complete case set and compare verified receipts against pinned requirements",async t=>{
  const native=await localServer(t);
  const local=(n:string):LocalCandidate=>({id:"ollama/"+n,kind:"model",provider:"ollama",model:n,loaded:true});
  const first=local("synthetic-alpha"),second=local("synthetic-beta");let candidateCalls=0;
  const b=new Bench(":memory:",{discover:async()=>[inventory([first,second],"ollama")],invoke:async(c)=>{candidateCalls++;return reply(c.id===first.id?"Q4, $0.20.":"$1.04.");}},withoutPower);
  t.after(()=>b.db.close());await b.refresh();await b.graders.discoverDecisionModels(native.endpoint);
  const grader=b.graders.save(config(native.endpoint),[]);
  const row=(case_id:string,task:string)=>({case_id,dataset_version:"1",split:"development",prompt:task});
  const setup=(id:string,task:string)=>{const meta={id,familyId:id,version:1,domain:"Financial Services",mode:"quick",title:"Release",prompt:task,objective:"Report earnings.",metrics:[],requirements:[]};b.db.prepare("INSERT INTO outcome_prompts VALUES(?,?,?,?,?,?)").run(id,id,1,id,"synthetic",JSON.stringify(meta));};
  setup("a",prompt);setup("b","Report earnings.");
  const candidates=[first.id,second.id],settings={candidateIds:candidates,graderIds:[grader]};
  const dataset=b.import("reference","Synthetic release",JSON.stringify(row("release",prompt)));
  const incomplete=b.import("reference","Synthetic missing checklist",[row("a",prompt),row("b","Report GAAP EPS.")].map(r=>JSON.stringify(r)).join("\n"));
  assert.match(b.quickGraderOptions("b").setupIssues[grader],/explicit deliverables/);
  assert.match(b.datasetGraderOptions(incomplete).setupIssues[grader],/Case b/);
  assert.throws(()=>b.start({...settings,mode:"quick",approvedPromptId:"b"}),/explicit deliverables/);
  assert.throws(()=>b.start({...settings,mode:"dataset",datasetId:incomplete}),/Case b/);
  assert.equal(candidateCalls,0);assert.equal(native.calls.length,0);
  for(const run of [{mode:"quick" as const,approvedPromptId:"a"},{mode:"dataset" as const,datasetId:dataset}]){
    const id=b.start({...settings,...run});await present(b.active).done;
    const detail=b.detail(id);assert.equal(detail.status,"completed");
    const cell=detail.report?.metrics.find(m=>m.id===grader)?.caseScores[0];assert.ok(cell);
    assert.deepEqual(cell.values.map(v=>v.score),[1,0]);assert.deepEqual(cell.values[1].completeness?.items.map(x=>x.pass),[false,true]);
    assert.equal(cell.values[0].decision?.probabilityYes,undefined);
    const tampered=structuredClone(detail);
    const target=present(tampered.assessments.find(a=>a.graderId===grader && a.candidate===first.id));
    present(target.completeness).items.pop();
    const replay=buildReport(tampered);
    assert.equal(replay?.metrics.find(m=>m.id===grader)?.caseScores[0].values[0].score,null);
  }
  assert.equal(candidateCalls,4);assert.equal(native.calls.length,8);
  // A separate review can add a new grader without rewriting an earlier run or borrowing its policy.
  const ungraded=b.start({candidateIds:candidates,mode:"quick",approvedPromptId:"a",inspectionOnly:true});await present(b.active).done;
  const original=b.detail(ungraded);
  assert.equal(original.manifest.deliverableChecklistHashes,undefined);
  await b.reviewSavedCase({run:ungraded,grader,caseId:"prompt"});
  const after=b.detail(ungraded);
  assert.deepEqual(after.report,original.report);
  assert.deepEqual(after.savedReviews?.[0].grades.map(g=>g.value),[1,0]);
  assert.equal(after.savedReviews?.[0].finding?.status,"higher");
  assert.ok(after.savedReviews?.[0].checklistHash);
  assert.equal(candidateCalls,6);assert.equal(native.calls.length,12);
});

test("the native requested-items preset stays in the operator picker and out of planned reuse and adaptations", async t=>{
  const native=await localServer(t);
  const planner:LocalCandidate={kind:"model",id:"ollama/lfm3-planner",model:"lfm3-planner",provider:"ollama",loaded:true};
  const name="Reviewed handoff adequacy";
  const bench=new Bench(":memory:",{discover:async()=>[inventory([planner])],invoke:async(_model,messages,options)=>{
    const {catalog}=z.object({catalog:z.array(z.object({option:z.string(),name:z.string()}))})
      .parse(JSON.parse(present(messages.at(-1)).content));
    assert.ok(!catalog.some(g=>g.name==="Requested items present"));
    const choice=z.object({properties:z.object({choice:z.object({enum:z.array(z.string())})})});
    const schema=z.object({properties:z.object({M1:z.object({anyOf:z.array(choice)})})}).parse(options.structured);
    const choices=schema.properties.M1.anyOf.flatMap(branch=>branch.properties.choice.enum);
    const allowed=catalog.map(g=>g.option).sort();
    assert.deepEqual(choices.filter(c=>/^G[0-9]+$/.test(c)).sort(),allowed);
    assert.deepEqual(choices.filter(c=>c.startsWith("ADAPT:")).map(c=>c.slice(6)).sort(),allowed);
    const other=present(catalog.find(g=>g.name===name));
    return reply(JSON.stringify({M1:{choice:other.option,reason:"The saved rubric evaluates the whole handoff."}}));
  }},withoutPower);
  t.after(()=>bench.db.close());
  bench.servers=[inventory([planner])];
  await bench.graders.discoverDecisionModels(native.endpoint);
  const preset=bench.graders.save(config(native.endpoint),[]);
  const ordinary=bench.graders.save({name,type:"opik",judgeId:planner.id,category:"Handoff",threshold:1,
    criteria:"Assess the rationale for the recommended handoff.",industry:"Financial Services"},[planner]);
  const datasetId=bench.importRows("reference","Handoff decisions",[{case_id:"handoff",dataset_version:"1",split:"development",prompt}],
    {industry:"Financial Services",family:"Handoff tests",category:"Review"});
  assert.ok(bench.datasetGraderOptions(datasetId).available.some(g=>g.id===preset));
  const plan=await designGraderPlan(bench,{datasetId,objective:"Assess the adequacy of the analyst handoff.",metrics:"Handoff adequacy"});
  assert.equal(plan.checks[0].source?.id,ordinary);
  // Older unconfirmed drafts could already point to the now operator-only version.
  bench.db.prepare("UPDATE grader_design_drafts SET draft=json_set(draft,'$.checks[0].source.id',?) WHERE id=?").run(preset,plan.draftId);
  const count=bench.graders.list().length;
  const confirm=(choice:unknown)=>confirmGraderPlan(bench,{draftId:plan.draftId,choices:[choice]});
  assert.throws(()=>confirm({index:0,action:"reuse"}),/source grader is no longer applicable/);
  assert.throws(()=>confirm({index:0,action:"derive",definition:{name:"Adapted handoff",category:"Review",criteria:"Assess adequacy.",threshold:1,judgeId:planner.id}}),/source grader is no longer applicable/);
  assert.equal(bench.graders.list().length,count);
  assert.equal(native.calls.length,0);
});

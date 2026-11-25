import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "opik";
import { DecisionDispatchError, decisionConfig, evaluateDecision, listLocalDecisionModels, type DecisionConfig } from "../lib/decision-model.cjs";

import { Bench } from "../lib/bench.cjs";
import { designGraderPlan, confirmGraderPlan } from "../lib/grader-designer.cjs";
import {opikJudgeRequest} from "./opik-judge-fixture.cjs";
import { inventory, reply, present } from "./runtime-fixtures.cjs";
import type {LocalCandidate,RuntimeAdapters} from "../lib/runtime-types.cjs";

const model = "synthetic/decision";
const entry = { id: model, architecture: { output_modalities: ["decisions"] } };
const evidence = {
  input: "A fictional part weighs two grams.", output: "2 g", reference: "2 g",
  rubric: "Preserve units.", sme_rationale: "Check units.", trajectory: [{tool:"synthetic-scale"}],
  evaluationBrief: { objective:"Return part weight", criteria:["Keep the unit"], metrics:["Correct unit"] },
};
const criterion = "The response retains the measurement and its unit.";
const signal = () => new AbortController().signal;
const native = (noul: number, id = model) => ({ model: id, answers: { criterion: { type:"noul", noul } } });

async function listen(t: TestContext, handle: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void) {
  const server = createServer((request, response) => {
    Promise.resolve(handle(request, response)).catch(() => { response.writeHead(500).end(); });
  });
  await new Promise<void>((resolve,reject) => {
    server.once("error",reject);
    server.listen(0,"127.0.0.1",resolve);
  });
  t.after(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert(address && typeof address !== "string");
  return "http://127.0.0.1:" + address.port;
}
function json(res: ServerResponse, value: unknown) {
  res.writeHead(200, { "Content-Type":"application/json" }).end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<unknown> {
  let raw = "";
  request.setEncoding("utf8");
  for await (const chunk of request) {
    assert.equal(typeof chunk, "string");
    raw += chunk;
  }
  return JSON.parse(raw);
}
const local = (endpoint: string): DecisionConfig => ({provider:"local",model,failAt:.25,endpoint});
const hosted: DecisionConfig = {provider:"openrouter",model,failAt:.25};
function withKey(t: TestContext, key: string | undefined) {
  const original = process.env.OPENROUTER_API_KEY;
  if (key === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = key;
  t.after(() => {
    if (original === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = original;
  });
}

test("native decision score preserves measured probabilities, thresholds and returned token counts across three outcomes", async t => {
  const probabilities = [.75, .25, .51];
  const requests: {path: string|undefined; auth: string|undefined; payload:unknown}[] = [];
  const endpoint = await listen(t, async (req,res) => {
    requests.push({path:req.url,auth:req.headers.authorization,payload:req.method === "POST" ? await body(req) : null});
    if (req.url === "/v1/models") return json(res, {data:[entry]});
    assert.equal(req.url,"/v1/systemone");
    const p = probabilities.shift();
    assert(p !== undefined);
    json(res, {...native(p),usage:{input_tokens:26,output_tokens:0}});
  });
  const input = {...evidence, privateKey:"do-not-forward", evaluationBrief:{...evidence.evaluationBrief, spare:"do-not-forward"}};
  for (const [p,value,pass] of [[.75,1,true],[.25,0,false],[.51,null,null]] as const) {
    const scored = await evaluateDecision(local(endpoint + "/v1"),.75,criterion,input,signal());
    assert.equal(scored.value,value);
    assert.equal(scored.pass,pass);
    assert.equal(scored.decision.probabilityYes,p);
    assert.equal(scored.decision.requestedModel,model);
    assert.equal(scored.decision.actualModel,model);
    assert.equal(scored.decision.provider,"local");
    assert.deepEqual(scored.decision.usage,{inputTokens:26,outputTokens:0});
    assert.match(scored.reason,/P\(criterion met\)/);
  }
  assert.equal(requests.length,6);
  for (const req of requests) {
    assert.equal(req.auth,undefined);
    if (req.path !== "/v1/systemone") continue;
    const dispatched = z.object({model:z.string(), state:z.string(), questions:z.object({ criterion:z.object({
      type:z.literal("noul"), instructions:z.string(),
    }).strict() }).strict() }).strict().parse(req.payload);
    assert.equal(dispatched.model,model);
    assert(dispatched.questions.criterion.instructions.includes(criterion));
    assert.deepEqual(JSON.parse(dispatched.state),evidence);
  }
});

test("discovery lists only explicit native decision modality and rejects absent or chat-only selected models before inference", async t => {
  const catalog = [
    entry,
    {id:"chat",architecture:{output_modalities:["text"]}},
    {id:"older"},
    {id:"wrong",output_modalities:["text"],architecture:{output_modalities:["decisions"]}},
    {id:"local-other",output_modalities:["decisions"]},
  ];
  let posts = 0;
  const endpoint = await listen(t, (req,res) => {
    if (req.url === "/v1/models") return json(res,{data:catalog});
    posts++;
    json(res,native(.8,"older"));
  });
  assert.deepEqual(await listLocalDecisionModels(endpoint,signal()),[model,"local-other"]);
  for (const id of ["chat","missing","wrong"]) {
    await assert.rejects(evaluateDecision({...local(endpoint),model:id},.75,criterion,evidence,signal()),/model/i);
  }
  assert.equal(posts,0);
  const older = await evaluateDecision({...local(endpoint),model:"older"},.75,criterion,evidence,signal());
  assert.equal(older.value,1);
  assert.equal(older.decision.usage,undefined);
  assert.equal(posts,1);
});

test("local native responses require exact model identity and one named criterion with a finite noul probability", async t => {
  const invalid: unknown[] = [
    native(.99,model + "-next"), {answers:native(.99).answers}, {model, answers:{other:{type:"noul",noul:.99}}},
    {model, answers:{criterion:{type:"choice",noul:.99}}}, {model,answers:{criterion:{type:"noul",noul:"0.9"}}},
    native(1.1),native(-.01),{model,answers:{criterion:{type:"refusal"}}},
    {model,answers:{...native(.99).answers,other:{type:"noul",noul:0}}},
    {...native(.99),error:{message:"sensitive mock response"}},
    {...native(.99),usage:{input_tokens:-1}},
  ];
  let posts = 0;
  const endpoint = await listen(t,(req,res) => {
    if (req.method === "GET") return json(res,{data:[entry]});
    json(res,invalid[posts++]);
  });
  for (let i = 0; i < invalid.length; i++)
    await assert.rejects(evaluateDecision(local(endpoint),.8,criterion,evidence,signal()),
      error => error instanceof Error && /model|criterion|refused/.test(error.message) && !error.message.includes("sensitive"));
  assert.equal(posts,invalid.length);
});

test("decision transport bounds bodies and rejects HTTP errors and redirects without a retry or content disclosure", async t => {
  let attempts = 0;
  const endpoint = await listen(t,(req,res) => {
    if (req.url === "/v1/models") return json(res,{data:[entry]});
    if (req.url !== "/v1/systemone") { res.writeHead(500).end(); return; }
    attempts++;
    if (attempts === 1) res.writeHead(503).end("secret-data");
    if (attempts === 2) res.writeHead(200).end("non-json secret-data");
    if (attempts === 3) { res.write("x".repeat(35000)); res.end("x".repeat(35000)); }
    if (attempts === 4) res.writeHead(307,{location:"/redirected"}).end();
  });
  for (const pattern of [/HTTP 503/,/invalid JSON/,/size limit/,/connection failed/]) {
    await assert.rejects(evaluateDecision(local(endpoint),.8,criterion,evidence,signal()),error =>
      error instanceof Error && pattern.test(error.message) && !error.message.includes("secret-data"));
  }
  assert.equal(attempts,4);
  await assert.rejects(evaluateDecision(local(endpoint),.8,criterion,{...evidence,input:"n".repeat(525000)},signal()),/512 KiB/);
  assert.equal(attempts,4);
});

test("configured routes, policy, and cancellation are validated without dispatching an inference", async t => {
  for (const endpoint of ["https://example.org", "http://127.0.0.1@other.example", "http://127.0.0.1?key=bad",
    "file:///localhost/v1", "http://127.0.0.1/not-an-api"]) {
    assert.equal(decisionConfig.safeParse(local(endpoint)).success,false);
  }
  assert.equal(decisionConfig.safeParse({...hosted,endpoint:"http://127.0.0.1"}).success,false);
  assert.equal(decisionConfig.safeParse(local("http://[::1]:8080/v1")).success,true);
  const controller = new AbortController();
  let requests = 0;
  const endpoint = await listen(t,(req,res) => {
    requests++;
    if (req.method === "POST") controller.abort();
    else json(res,{data:[entry]});
  });
  await assert.rejects(evaluateDecision(local(endpoint),.25,criterion,evidence,signal()),/pass threshold/);
  await assert.rejects(evaluateDecision(local(endpoint),.8,"  ",evidence,signal()),/criterion/);
  assert.equal(requests,0);
  await assert.rejects(evaluateDecision(local(endpoint),.8,criterion,evidence,controller.signal),{name:"AbortError"});
  await assert.rejects(evaluateDecision(local(endpoint),.8,criterion,evidence,controller.signal),{name:"AbortError"});
  assert.equal(requests,2);
});

test("OpenRouter uses only its fixed native endpoint with runtime credentials and validates aliases against the official decision catalog", async t => {
  withKey(t,"synthetic-test-token");
  const canonical = model + "-dated";
  let returned = model;
  const urls: string[] = [];
  const auth: (string|null)[] = [];
  t.mock.method(globalThis,"fetch", async (input: string|URL|Request, options?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    auth.push(new Headers(options?.headers).get("Authorization"));
    assert.equal(options?.redirect,"error");
    if (url === "https://openrouter.ai/api/alpha/decisions")
      return Response.json({...native(.8,returned),usage:{input_tokens:18,output_tokens:0,total_tokens:18,cost:.000021}});
    assert.equal(url,"https://openrouter.ai/api/v1/models?output_modalities=decisions");
    return Response.json({data:[{...entry,canonical_slug:canonical}]});
  });
  const initial = await evaluateDecision(hosted,.8,criterion,evidence,signal());
  assert.equal(initial.decision.actualModel,model);
  assert.deepEqual(initial.decision.usage,{inputTokens:18,outputTokens:0,totalTokens:18,cost:.000021});
  returned = canonical;
  const aliased = await evaluateDecision(hosted,.8,criterion,evidence,signal());
  assert.equal(aliased.decision.actualModel,canonical);
  assert.equal(aliased.decision.identityVerification,"openrouter-catalog");
  returned = model + "-unverified";
  await assert.rejects(evaluateDecision(hosted,.8,criterion,evidence,signal()),/canonical slug/);
  assert.equal(urls.filter(u => u.endsWith("/decisions")).length,3);
  assert.deepEqual(auth,["Bearer synthetic-test-token","Bearer synthetic-test-token",null,"Bearer synthetic-test-token",null]);
});

test("missing OpenRouter credentials fail before any network activity", async t => {
  withKey(t,undefined);
  const fetch = t.mock.method(globalThis,"fetch",() => { throw new Error("Unexpected network request."); });
  await assert.rejects(evaluateDecision(hosted,.8,criterion,evidence,signal()),/OPENROUTER_API_KEY/);
  assert.equal(fetch.mock.callCount(),0);
});

test("MLX-VLM confirms its loaded decision cache, pins that local checkpoint and reads true probability even when the boolean is false", async t => {
  const primary = "/test/checkpoints/D1 Omni";
  const fallback = "/test/checkpoints/D1 alternate";
  let active = primary;
  let p = .07;
  const seen: string[] = [];
  const endpoint = await listen(t, async (req,res) => {
    if (req.url === "/health") return json(res, {status:"healthy", model_ready:false, preload_in_progress:false,
      loaded_models:{text_generation:{model:"unrelated/chat",model_kind:"text_generation"},decision:{model:active,model_kind:"decision",adapter:null}}});
    if (req.url !== "/v1/decisions" || req.method !== "POST") { res.writeHead(404).end(); return; }
    const payload = z.object({model:z.string(),state:z.string(),questions:z.object({criterion:z.object({
      type:z.literal("noul"), instructions:z.string(),
    }).strict()}).strict()}).strict().parse(await body(req));
    assert.equal(payload.model,active);
    assert.equal(req.headers.authorization,undefined);
    seen.push(payload.model);
    json(res,{model:active,answers:{criterion:{type:"bool",value:p >= .5,probability:p}},usage:{input_tokens:82,output_tokens:0}});
  });
  const config: DecisionConfig = {...local(endpoint),protocol:"mlx-vlm",model:primary,fallbackModel:fallback};
  assert.deepEqual(await listLocalDecisionModels(endpoint,signal(),"mlx-vlm"),[primary]);
  const first = await evaluateDecision(config,.8,criterion,evidence,signal());
  assert.equal(first.pass,false);
  assert.equal(first.decision.probabilityYes,.07);
  assert.equal(first.decision.actualModel,primary);
  assert.equal(first.decision.dispatchedModel,undefined);
  assert.equal(first.decision.protocol,"mlx-vlm");
  assert.equal(first.decision.identityVerification,"exact");
  assert.deepEqual(first.decision.usage,{inputTokens:82,outputTokens:0});
  active = fallback;
  p = .6;
  const switched = await evaluateDecision(config,.8,criterion,evidence,signal());
  assert.equal(switched.pass,null);
  assert.equal(switched.decision.requestedModel,primary);
  assert.equal(switched.decision.dispatchedModel,fallback);
  assert.equal(switched.decision.actualModel,fallback);
  assert.equal(switched.decision.fallbackReason,"primary-unavailable");
  assert.deepEqual(seen,[primary,fallback]);
});

test("MLX health refuses a remote checkpoint identifier and never treats a chat cache or in-progress preload as a decision preload", async t => {
  const checkpoint = "/test/D1";
  const active = {model:checkpoint,model_kind:"decision"};
  const responses = [
    {status:"healthy", loaded_models:{text_generation:{model:checkpoint,model_kind:"text_generation"}}},
    {status:"healthy", loaded_models:{decision:{...active,model:"hub/remote"}}},
    {status:"healthy", preload_in_progress:true, loaded_models:{decision:active}},
    {status:"healthy", loaded_models:{decision:{...active,model_kind:"text_generation"}}},
  ];
  let posts = 0;
  const endpoint = await listen(t, (req,res) => {
    if (req.method === "POST") posts++;
    json(res,responses.shift());
  });
  const config: DecisionConfig = {...local(endpoint),model:checkpoint,protocol:"mlx-vlm"};
  const healthSignal = signal();
  assert.equal(decisionConfig.safeParse({...config,model:"hub/remote"}).success,false);
  assert.equal(decisionConfig.safeParse({...config,fallbackModel:"hub/alternate"}).success,false);
  assert.equal(decisionConfig.safeParse({...hosted,model:checkpoint}).success,false);
  assert.deepEqual(await listLocalDecisionModels(endpoint,healthSignal,"mlx-vlm"),[]);
  for (const pattern of [/absolute local checkpoint/,/preloading a model/,/decision model cache/]) {
    await assert.rejects(evaluateDecision(config,.8,criterion,evidence,healthSignal),pattern);
  }
  assert.equal(posts,0);
});

test("MLX rejects malformed or contradictory boolean observations, including systemone-shaped output and a different served checkpoint", async t => {
  const path = "/test/checkpoints/d1";
  const replies: unknown[] = [
    {model:path,answers:{criterion:{type:"bool",value:true,probability:.1}}},
    {model:path,answers:{criterion:{type:"bool",value:false}}},
    {model:path,answers:{criterion:{type:"bool",value:false,probability:2}}},
    native(.95,path),
    {model:path+"-other",answers:{criterion:{type:"bool",value:false,probability:.15}}},
  ];
  let posts = 0;
  const endpoint = await listen(t,(req,res) => {
    if (req.method === "GET") return json(res,{status:"healthy",loaded_models:{decision:{model:path,model_kind:"decision"}}});
    json(res,replies[posts++]);
  });
  for (let i = 0; i < replies.length; i++) await assert.rejects(
    evaluateDecision({...local(endpoint),protocol:"mlx-vlm",model:path,fallbackModel:"/test/other"},.8,criterion,evidence,signal()),
    /criterion|different model/);
  assert.equal(posts,replies.length);
});

test("a systemone alternate is selected solely by unambiguous preflight and a failed POST keeps the attempt without retry", async t => {
  const alternate = "synthetic/alternate";
  const alternateEntry = {...entry,id:alternate};
  let catalog: unknown[] = [{id:model,architecture:{output_modalities:["text"]}},alternateEntry];
  let output: unknown = native(.91,alternate);
  const posted: string[] = [];
  const endpoint = await listen(t,async (req,res) => {
    if (req.method === "GET") return json(res,{data:catalog});
    posted.push(z.object({model:z.string()}).parse(await body(req)).model);
    json(res,output);
  });
  const config = {...local(endpoint),fallbackModel:alternate};
  assert.equal(decisionConfig.safeParse({...hosted,fallbackModel:alternate}).success,false);
  assert.equal(decisionConfig.safeParse({...config,fallbackModel:model}).success,false);
  const success = await evaluateDecision(config,.8,criterion,evidence,signal());
  assert.equal(success.decision.fallbackReason,"primary-not-decision-capable");
  assert.equal(success.decision.actualModel,alternate);
  assert.equal(success.decision.requestedModel,model);
  catalog = [alternateEntry];
  output = native(.91,"unrelated");
  await assert.rejects(evaluateDecision(config,.8,criterion,evidence,signal()),error => {
    assert(error instanceof DecisionDispatchError);
    assert.deepEqual(error.attempt,{requestedModel:model,dispatchedModel:alternate,protocol:"systemone",fallbackReason:"primary-unavailable"});
    return true;
  });
  catalog = [entry,alternateEntry];
  output = {model,answers:{criterion:{type:"refusal"}}};
  await assert.rejects(evaluateDecision(config,.8,criterion,evidence,signal()),error => {
    assert(error instanceof Error && !(error instanceof DecisionDispatchError));
    return error.message.includes("refused");
  });
  catalog = [entry,entry,alternateEntry];
  await assert.rejects(evaluateDecision(config,.8,criterion,evidence,signal()),/ambiguous/);
  catalog = [{id:model,architecture:{output_modalities:["text"]},output_modalities:["decisions"]},alternateEntry];
  await assert.rejects(evaluateDecision(config,.8,criterion,evidence,signal()),/Conflicting/);
  catalog = [{id:alternate}];
  await assert.rejects(evaluateDecision(config,.8,criterion,evidence,signal()),/advertised as decision-capable/);
  assert.deepEqual(posted,[alternate,alternate,model]);
});

test("reviewed binary grading pins a discovered model separately from the designer and bounds candidate evidence", async t=>{
  const marker="QA-WITHHELD-REFERENCE", alternate="synthetic/decision-two", chat="synthetic/chat";
  const observed:{model:string;state:Record<string,unknown>}[]=[];
  const endpoint=await listen(t,async(req,res)=>{
    if(req.method==="GET")return json(res,{data:[entry,{id:alternate,output_modalities:["decisions"]},{id:chat,output_modalities:["text"]}]});
    const request=z.object({model:z.string(),state:z.string()}).parse(await body(req));
    const state=z.record(z.string(),z.unknown()).parse(JSON.parse(request.state));
    observed.push({model:request.model,state});
    // Explicit synthetic verdicts exercise serialization and cutoffs; this transport is not a calibrated judge.
    const p=state.output==="Lot A. Hold for inspection."?.98:state.output==="Lot A."?.08:.5;
    json(res,native(p,request.model));
  });
  const planner:LocalCandidate={kind:"model",id:"ollama/lfm3-sim",provider:"ollama",model:"lfm3-sim",loaded:true};
  const servers=[inventory([planner])];
  const anchors={full:"Names the lot and the required action.",partial:"Names one of the two.",zero:"Names neither.",evidence:"response"};
  let reuseName:string|undefined;
  const adapters:RuntimeAdapters={discover:async()=>servers,invoke:async(_model,messages)=>{
    if(reuseName){
      const request=z.object({catalog:z.array(z.object({option:z.string(),name:z.string()}))}).parse(JSON.parse(present(messages.at(-1)).content));
      const source=present(request.catalog.find(g=>g.name===reuseName));
      return reply(JSON.stringify({M1:{choice:source.option,reason:"Reuse the saved handoff check."}}));
    }
    return reply(JSON.stringify({M1:{choice:"NEW:judge",anchors,name:"Handoff",criteria:"Check the two requested deliverables.",threshold:.8,reason:"Read the generated handoff."}}));
  }};
  const b=new Bench(":memory:",adapters);b.servers=servers;t.after(()=>b.db.close());
  const plan=await designGraderPlan(b,{objective:"Identify the inspected lot and state the next action.",metrics:"Handoff completeness."});
  const g=present(plan.checks[0]),cfg={provider:"local",protocol:"systemone",endpoint,model:alternate,failAt:.2};
  const newCheck={name:"Handoff coverage",category:"Coverage",type:"decision",criteria:"Does the answer identify the lot and state the next action?",threshold:.8,decision:cfg,decisionView:"task-answer"};
  const confirm=(definition:unknown)=>confirmGraderPlan(b,{draftId:plan.draftId,choices:[{index:0,action:"create",definition}]});
  assert.throws(()=>confirm(newCheck),/Find decision models/);
  assert.deepEqual(await b.graders.discoverDecisionModels(endpoint),[model,alternate]);
  assert.throws(()=>confirm({...newCheck,criteria:g.criteria}),/yes\/no criterion/);
  assert.throws(()=>confirm({...newCheck,decision:{...cfg,model:chat}}),/Find decision models/);
  const manual=b.graders.save({...newCheck,name:"Manually configured legacy alias",industry:"Cross-industry",decision:{...cfg,model:chat},decisionView:undefined},[]);
  assert.throws(()=>b.graders.save({intent:"derive",sourceGraderId:manual,decisionView:"case",confirmNative:true},[]),/Find decision models/);
  const [id]=confirm(newCheck),version=b.graders.get(id);
  assert.deepEqual(confirm(newCheck),[id]);
  assert.ok(version.type==="decision");assert.equal(version.decision.model,alternate);
  assert.equal(version.decisionView,"task-answer");assert.equal(version.producer?.model.model,planner.model);
  for(const [output,expected] of [["Lot A. Hold for inspection.",1],["Lot A.",0],["Maybe.",null]] as const){
    const score=await b.graders.assess(version,{input:"Identify the lot and next action.",output,reference:marker,rubric:marker},adapters,signal());
    assert.equal(score.value,expected);assert.equal(score.pass,expected===null?null:expected===1);
    assert.equal(score.decision?.actualModel,alternate);
    assert.deepEqual(observed.at(-1),{model:alternate,state:{input:"Identify the lot and next action.",output}});
  }
  const noTask=await b.graders.assess(version,{input:"",output:"Lot A.",reference:null},adapters,signal());
  assert.equal(noTask.value,null);assert.equal(observed.length,3);
  const revisedId=b.graders.save({intent:"revise",sourceGraderId:id,decision:{...cfg,model},decisionView:"case",requiredEvidence:["reference"]},[]);
  const revised=b.graders.get(revisedId);assert.equal(revised.version,2);
  const missing=await b.graders.assess(revised,{input:"Grade this",output:"Lot A.",reference:null},adapters,signal());
  assert.equal(missing.value,null);assert.match(missing.reason,/No expected answer was supplied/);assert.equal(observed.length,3);
  await b.graders.assess(revised,{input:"Grade this",output:"Lot A.",reference:marker,rubric:"Check lot and action"},adapters,signal());
  assert.deepEqual(observed.at(-1)?.state,{input:"Grade this",output:"Lot A.",reference:marker,rubric:"Check lot and action"});
  const answerOnlyId=b.graders.save({intent:"revise",sourceGraderId:revisedId,decisionView:"answer-only",requiredEvidence:[]},[]);
  await b.graders.assess(b.graders.get(answerOnlyId),{input:marker,output:"Lot A.",reference:marker},adapters,signal());
  assert.deepEqual(observed.at(-1),{model,state:{output:"Lot A."}});
  const opikEvidence:Record<string,unknown>[]=[];
  let opikCalls=0;
  const judgeAdapter:RuntimeAdapters={...adapters,invoke:async(_m,messages)=>{
    opikCalls++;
    const request=opikJudgeRequest(messages);
    if(request?.stage==="geval-steps")return reply("Inspect only the evidence supplied.");
    assert.ok(request?.stage==="geval-score");opikEvidence.push(request.evidence);
    return reply('{"score":10,"reason":"The response includes the lot ID and action."}');
  }};
  reuseName=newCheck.name;
  const copy=await designGraderPlan(b,{objective:"Audit the handoff",metrics:"Handoff completeness"});
  assert.equal(copy.checks[0].source?.id,answerOnlyId);assert.equal(copy.checks[0].evidenceView,"answer-only");
  // A draft from the previous release lacks evidenceView. Confirm against the saved source.
  b.db.prepare("UPDATE grader_design_drafts SET draft=json_remove(draft,'$.checks[0].evidenceView') WHERE id=?").run(copy.draftId);
  const [derived]=confirmGraderPlan(b,{draftId:copy.draftId,choices:[{index:0,action:"derive",definition:{
    type:"opik",name:"Reviewed handoff",category:"Coverage",criteria:"Read the reported action.",threshold:.8,judgeId:planner.id}}]});
  const oldPlanCopy=b.graders.get(derived);assert.ok(oldPlanCopy.type==="opik");assert.equal(oldPlanCopy.evidenceView,"answer-only");
  await b.graders.assess(oldPlanCopy,{input:marker,output:"Lot A.",reference:marker,rubric:marker},judgeAdapter,signal());
  assert.deepEqual(opikEvidence.at(-1),{output:"Lot A."});
  for(const [source,view,expected] of [[id,"task-answer",{input:"QA-TASK",output:"Lot A."}],[answerOnlyId,"answer-only",{output:"Lot A."}]] as const){
    const opikId=b.graders.save({intent:"derive",sourceGraderId:source,name:"Review "+view,type:"opik",judgeId:planner.id},[planner]);
    const opik=b.graders.get(opikId);assert.ok(opik.type==="opik");assert.equal(opik.evidenceView,view);
    await b.graders.assess(opik,{input:"QA-TASK",output:"Lot A.",reference:marker,rubric:marker},judgeAdapter,signal());
    assert.deepEqual(opikEvidence.at(-1),expected);
    const back=b.graders.save({intent:"derive",sourceGraderId:opikId,name:"Binary "+view,type:"decision",decision:cfg},[]);
    await b.graders.assess(b.graders.get(back),{input:"QA-TASK",output:"Lot A.",reference:marker,rubric:marker},adapters,signal());
    assert.deepEqual(observed.at(-1)?.state,expected);
    const missing={input:null,output:"Lot A.",reference:marker};
    const prior:readonly [number,number]=[opikCalls,observed.length];
    const absent=await Promise.all([b.graders.assess(opik,missing,judgeAdapter,signal()),b.graders.assess(b.graders.get(back),missing,adapters,signal())]);
    if(view==="task-answer"){
      for(const result of absent){assert.equal(result.value,null);assert.equal(result.pass,null);assert.match(result.reason,/candidate task.*unscored/);}
      assert.deepEqual([opikCalls,observed.length],prior,"Neither backend may dispatch any request without the required task");
    }else{
      assert.ok(absent.every(result=>result.value!==null));assert.ok(opikCalls>prior[0] && observed.length>prior[1]);
    }
  }
  const hallucination=b.graders.save({intent:"create",name:"Source grounding",type:"opik-metric",metricKey:"hallucination",industry:"Cross-industry",category:"Grounding",judgeId:planner.id,threshold:.8},[planner]);
  assert.throws(()=>b.graders.save({intent:"derive",sourceGraderId:hallucination,name:"Grounding binary",type:"decision",decision:cfg,requiredEvidence:[],decisionView:"task-answer"},[]),/requires a reference/);
  const keyed=b.graders.save({intent:"derive",sourceGraderId:hallucination,name:"Grounding binary",type:"decision",decision:cfg,requiredEvidence:[],decisionView:"case"},[]);
  const prior=observed.length;
  const noSource=await b.graders.assess(b.graders.get(keyed),{input:"Grade this",output:"Lot A.",reference:null},adapters,signal());
  assert.equal(noSource.pass,null);assert.equal(observed.length,prior);
  assert.deepEqual(b.graders.get(id),version);
});

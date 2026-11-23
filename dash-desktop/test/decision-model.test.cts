import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "opik";
import { DecisionDispatchError, decisionConfig, evaluateDecision, listLocalDecisionModels, type DecisionConfig } from "../lib/decision-model.cjs";

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

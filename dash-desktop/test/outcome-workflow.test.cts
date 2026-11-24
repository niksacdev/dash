import {test,type TestContext} from "node:test";
import assert = require("node:assert/strict");
import { DatabaseSync } from "node:sqlite";
import {OutcomeWorkflow,contractHash,type DesignContext} from "../lib/outcome-workflow.cjs";
import {hostedPlanningUsage} from "../lib/planning-usage.cjs";
import {PlanningRoute,type PlannerAdapters,type PlanningAttempt} from "../lib/planner-routing.cjs";
import type {LocalCandidate,ModelCandidate,ChatTurn} from "../lib/runtime-types.cjs";
import {z} from "zod";
const planSchema=z.object({properties:z.record(z.string(),z.unknown()),required:z.array(z.string())});
const expertBrief=z.object({title:z.string(),metrics:z.array(z.string()),requirements:z.array(z.string())});
const review=z.object({omitted:z.number(),supplementSource:z.string().optional()});
const attempts=z.array(z.object({status:z.string(),provider:z.string(),revision:z.string().nullable().optional(),reason:z.string().optional(),fallbackReason:z.string().optional()}));
interface PlannerCall {candidate:ModelCandidate; messages:ChatTurn[]; structured:z.infer<typeof planSchema>; signal:AbortSignal}
interface ReplyFields {title?:string;domain?:string;metrics?:string[];requirements?:string[];prompt?:string}
interface FixtureOptions {
  inventory?:(Omit<LocalCandidate,"provider"> & {provider:string;endpoint?:string})[];
  reply?:(result:ReplyFields)=>string|null;
}
import {inventory as runtimeInventory,reply as inferenceReply} from "./runtime-fixtures.cjs";
const runtime=runtimeInventory([]);


const model:LocalCandidate = {kind:"model",id:"test/lfm3-planner",model:"lfm3-planner", provider:"lmstudio", loaded:true, parameterSize:"8B" };
const expert = { title:"Review incoming lots", metrics:["Correct drawing revisions per cited revision"], requirements:["Cite the drawing revision."] };
const quick = { mode:"quick", objective:"Flag out-of-tolerance parts for the inspector." };
const pack = { id:"inspection", title:"Receiving inspection", system:"Inspect a part.", outputSchema:{type:"object"}, metrics:["False releases"] };
const context = { pack, datasetId:"snapshot-1", version:"3", split:"holdout", industry:"Manufacturing" };
const dataset = { ...quick, mode:"dataset", datasetId:"snapshot-1" };

function fixture(t:TestContext, options:FixtureOptions = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const calls:PlannerCall[] = [];
  const adapters:PlannerAdapters = {
    discover:async () => [{...runtime,models:[model]}],
    invoke:async (candidate, messages, { structured, signal }) => {
      const decoded=planSchema.parse(structured);
      calls.push({candidate,messages,structured:decoded,signal});
      const schema=decoded.properties;
      const result = schema.domain ? { domain:"Manufacturing" } :
        schema.requirements ? expert : { prompt:"Check the source drawing, record units, and explain any inspection referral." };
      return inferenceReply(options.reply?.(result) ?? JSON.stringify(result),{input_tokens:19,output_tokens:7});
    },
  };
  if (options.inventory) {
    // Include inconsistent and hosted advertisements to exercise the runtime-discovery boundary.
    t.mock.method(adapters,"discover",async()=>[{...runtime,models:options.inventory}]);
  }
  return { db, adapters, calls, work:new OutcomeWorkflow(db, adapters) };
}

test("the router selects the domain and the two local domain roles prepare a reusable outcome", async t => {
  const { work, calls } = fixture(t, { inventory:[{ ...model, provider:"remote", parameterSize:"1T" }, { ...model, model:"small", parameterSize:"1B" }, model] });
  const request = { ...quick, metrics:"Catch every out-of-tolerance reading.", inputCap:600, outputCap:80 };
  const draft = await work.design(request);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => c.candidate === model));
  assert.deepEqual(calls.map(c => Object.keys(c.structured.properties)), [["domain"], ["title","metrics","requirements"], ["prompt"]]);
  const expertMessage = calls[1].messages[0].content;
  assert.match(expertMessage, /[Mm]anufacturing/);
  assert.match(expertMessage, /nist\.gov/);
  const implementationBrief=z.object({expertBrief,outputCap:z.number(),inputCap:z.number(),metrics:z.array(z.string())}).parse(JSON.parse(calls[2].messages[1].content));
  assert.deepEqual(implementationBrief.expertBrief, expert);
  assert.equal(implementationBrief.outputCap, 80);
  assert.equal(implementationBrief.inputCap, 600);
  assert.equal(implementationBrief.metrics[0], request.metrics);
  assert.match(draft.prompt, /Flag out-of-tolerance parts/);
  assert.equal(draft.domainSource, "inferred");
  assert.equal(draft.domain, "Manufacturing");
  assert.equal(draft.agents?.length, 2);
  assert.equal(draft.datasetId, null);
  assert.deepEqual(work.list(), []);

  draft.domain = "Financial Services";
  draft.metrics.length = 0;
  const saved = work.approve({ draftId:draft.draftId, prompt:"Operator-edited instructions", metrics:["Correct lot per response"] });
  assert.equal(saved.domain, "Manufacturing");
  assert.deepEqual(saved.metrics, ["Correct lot per response"]);
  assert.equal(saved.requestedMetrics, request.metrics);
  assert.equal(saved.version, 1);
  assert.equal(saved.familyId, saved.id);
  assert.equal(saved.designer?.model, "lfm3-planner");
  assert.deepEqual(work.get(saved.id), saved);
});

test("suggestions use the domain expert and edited measures reach the implementer and approval", async t => {
  const { work, calls } = fixture(t);
  const s = await work.design(quick, {}, "suggest");
  assert.equal(calls.length, 2);
  assert.deepEqual(s.criteria, expert.requirements);
  assert.deepEqual(work.list(), []);
  const drafts:unknown=Object.getOwnPropertyDescriptor(work,"drafts")?.value;
  assert.ok(drafts instanceof Map);
  assert.equal(drafts.size, 0);
  const measures = {metrics:["Incorrect releases per 100 inspected lots"],criteria:["Route missing revisions to quality review."]};
  const draft = await work.design({...quick,suggestionId:s.id,measures});
  assert.equal(calls.length, 3);
  const last=calls.at(-1);
  assert.ok(last);
  const rawBrief:unknown=JSON.parse(last.messages[1].content);
  const brief=z.object({metrics:z.array(z.string()),expertBrief}).parse(rawBrief);
  assert.deepEqual(brief.metrics, measures.metrics);
  assert.deepEqual(brief.expertBrief.requirements, measures.criteria);
  assert.doesNotMatch(JSON.stringify(rawBrief), /Cite the drawing revision/);
  const p = work.approve({draftId:draft.draftId,prompt:draft.prompt});
  assert.deepEqual(p.metrics, measures.metrics);
  assert.deepEqual(p.requirements, measures.criteria);
  assert.equal(z.object({designer:z.object({model:z.string()})}).parse(p.suggestions).designer.model, model.model);
  await assert.rejects(work.design({...quick,objective:"Perform a reconciliation.",suggestionId:s.id,measures}), /Suggest Metrics again/);
  await assert.rejects(work.design({...dataset,suggestionId:s.id,measures},context), /Suggest Metrics again/);
});

test("dataset drafting uses two real stages and only the public task contract", async t => {
  const { work, calls } = fixture(t);
  const dirty = { ...context, rows:[{gold:"SECRET_LABEL", input:"SECRET_ROW"}], pack:{...pack, challenge:"SECRET_SCENARIO_EXTRA"} };
  const draft = await work.design(dataset, dirty);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const {dataset:publicTask}=z.object({dataset:z.record(z.string(),z.unknown())}).parse(JSON.parse(call.messages[1].content));
    assert.equal(publicTask.system, pack.system);
    assert.equal(publicTask.version, undefined);
    assert.equal(publicTask.datasetId, undefined);
  }
  assert.doesNotMatch(JSON.stringify(calls), /SECRET_/);
  assert.equal(draft.contractHash, contractHash(pack));
  assert.equal(draft.packId, pack.id);
  assert.equal(z.object({version:z.string()}).parse(draft.dataset).version, "3");
  assert.deepEqual(z.object({outputSchema:z.record(z.string(),z.unknown())}).parse(draft.dataset).outputSchema, pack.outputSchema);
  assert.equal(draft.domainSource, "dataset");
  assert.notEqual(contractHash({...pack, system:"Changed."}), draft.contractHash);
  await assert.rejects(work.design({...dataset, domain:"Financial Services"}, context), /domain assigned/);
  await assert.rejects(work.design({...dataset, datasetId:"other"}, context), /snapshot/);
});

test("approvals are idempotent across restarts and revisions retain immutable lineages", async t => {
  const { work, db, adapters } = fixture(t);
  const draft = await work.design({...quick,domain:"Manufacturing"});
  const approval = { draftId:draft.draftId, prompt:draft.prompt, metrics:draft.metrics };
  const original = work.approve(approval);
  const other = new OutcomeWorkflow(db, adapters);
  assert.deepEqual(other.approve(approval), original);
  assert.throws(() => other.approve({...approval,prompt:"Changed after approval"}), /different edits/);
  const revise = { ...quick, domain:"Manufacturing", parentId:original.id };
  const next = await other.design(revise);
  const stale = await work.design(revise);
  const revised = other.approve({ draftId:next.draftId, prompt:"Check revision and units." });
  assert.equal(revised.parentId, original.id);
  assert.equal(revised.familyId, original.familyId);
  assert.equal(revised.version, 2);
  assert.deepEqual(work.get(original.id), original);
  assert.deepEqual(work.history(revised.id).map(e => e.id), [original.id, revised.id]);
  assert.throws(() => work.approve({draftId:stale.draftId, prompt:"Late revision."}), /newer revision/);
  assert.equal(work.list().length, 2);
  await assert.rejects(work.design({...dataset,parentId:original.id}, context), /original run type/);
});

test("admin edits are versioned, checked for conflicts, and take effect on later preparations", async t => {
  const { work, calls } = fixture(t);
  const roles = work.roles();
  assert.equal(roles.length, 6);
  const original = roles.find(r => r.domain === "Manufacturing" && r.role === "expert");
  assert.ok(original);
  const before = await work.design(dataset, context);
  const edit = {...original, expectedVersion:original.version, instructions:"Inspect the lot using the custom inspection guide."};
  const next = work.saveRole(edit);
  assert.notEqual(next.hash, original.hash);
  assert.equal(next.version, 2);
  assert.throws(() => work.saveRole(edit), /changed/);
  const after = await work.design(dataset, context);
  assert.equal(after.agents?.find(a => a.role === "expert")?.hash, next.hash);
  assert.match(calls[2].messages[0].content, /custom inspection guide/);
  const savedBefore = work.approve({draftId:before.draftId,prompt:before.prompt});
  assert.equal(savedBefore.agents?.find(a => a.role === "expert")?.hash, original.hash);
});

test("offline or malformed responses do not generate or approve a substitute", async t => {
  const offline = fixture(t, {inventory:[{...model,loaded:false}]}).work;
  await assert.rejects(offline.design(quick), /Load an LFM3 chat model/);
  const malformed = fixture(t, { reply:() => "Here is an answer"}).work;
  await assert.rejects(malformed.design({...quick,domain:"General"}), /expert.*invalid JSON/);
  assert.deepEqual(malformed.list(), []);
  assert.throws(() => malformed.approve({draftId:"absent",prompt:"not approved"}), /expired/);
  await assert.rejects(malformed.design({...quick,outputCap:0}), /Output budget/);
});

test("Financial Services suggestions need no title and reuse the objective for a missing or oversized title", async t => {
  const request = { mode:"quick", objective:"Reduce false auto-accepts of unsupported financial claims.", domain:"Financial Services" };
  for (const title of [undefined, "x".repeat(500)]) {
    const {work,calls} = fixture(t, {reply:result => result.metrics ? JSON.stringify({
      title, metrics:["False accepts per analyst-reviewed claim"], criteria:["Each accepted claim cites its filing."]}) : null});
    const suggested = await work.design(request, {}, "suggest");
    assert.deepEqual(calls[0].structured.required, ["requirements","metrics"]);
    assert.deepEqual(suggested.metrics, ["False accepts per analyst-reviewed claim"]);
    assert.deepEqual(suggested.criteria, ["Each accepted claim cites its filing."]);
    const draft = await work.design({...request,suggestionId:suggested.id});
    assert.equal(draft.title, request.objective);
    assert.deepEqual(attempts.parse(draft.planningAttempts).map(a=>a.status), ["succeeded","succeeded"]);
  }
});

test("a repetitive implementer retries locally with changed instructions and excludes Gemma and unrelated endpoints", async t => {
  const inventory = [{ ...model, model:"google/gemma-4-26b", parameterSize:"26B" },
    {...model,provider:"compatible",model:"lfm3-other-server"}, model];
  let attempt = 0;
  const {work,calls} = fixture(t, {inventory, reply: result =>
    result.prompt && ++attempt === 1 ? JSON.stringify({prompt:"part_id, ".repeat(35)}) : null});
  const draft = await work.design({...quick, domain:"Manufacturing"});
  assert.ok(calls.every(c=>c.candidate === model));
  assert.equal(calls.length, 3);
  assert.match(calls[2].messages[0].content, /Correct the previous generation/);
  assert.doesNotMatch(calls[2].messages[0].content, /part_id, part_id/);
  assert.doesNotMatch(draft.prompt, /part_id/);
  assert.match(attempts.parse(draft.planningAttempts)[1].reason || "", /repeated/);
  assert.deepEqual(attempts.parse(draft.planningAttempts).map(a=>a.status), ["succeeded","failed","succeeded"]);
});

test("failure of either role falls back directly to the configured OpenAI endpoint with accurate provenance", async t => {
  for (const failingRole of ["expert","implementer"]) {
    const {db,adapters,calls} = fixture(t, {reply: result => {
      if (failingRole === "expert" && result.metrics) return JSON.stringify({...result,metrics:["part_id, ".repeat(10)]});
      if (failingRole === "implementer" && result.prompt) return "invalid output";
      return null;
    }});
    const urls:string[] = [], events:PlanningAttempt[] = [];
    const work = new OutcomeWorkflow(db, adapters, {
      openaiFallback:() => ({model:"configured-openai",apiKey:"test-session-value",endpoint:"https://unapproved.invalid"}),
      fetch:async (url,init) => {
        urls.push(String(url));
        assert.ok(init && typeof init.body === "string");
        assert.equal(init.redirect, "error");
        assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-session-value");
        const body=z.object({store:z.boolean()}).parse(JSON.parse(init.body));
        assert.equal(body.store, false);
        assert.doesNotMatch(init.body, /test-session-value|part_id, part_id|PRIVATE_DATASET_GOLD/);
        const output = failingRole === "expert" ? expert : {prompt:"Inspect the source drawing and explain any referral."};
        return Response.json({model:"configured-openai-snapshot",usage:{prompt_tokens:512,completion_tokens:0},choices:[{message:{content:JSON.stringify(output)},finish_reason:"stop"}]});
      },
    });
    const privateContext:DesignContext & {gold:string}={...context,gold:"PRIVATE_DATASET_GOLD",onStage:e=>events.push(e)};
    const draft = await work.design(dataset,privateContext);
    assert.deepEqual(urls, ["https://api.openai.com/v1/chat/completions"]);
    assert.equal(calls.length, 3);
    assert.equal(z.object({provider:z.string()}).parse(draft[failingRole === "expert" ? "expertDesigner" : "designer"]).provider, "openai");
    assert.equal(z.object({provider:z.string()}).parse(draft[failingRole === "expert" ? "designer" : "expertDesigner"]).provider, "lmstudio");
    const hosted=attempts.parse(draft.planningAttempts).find(a=>a.provider==="openai");
    assert.ok(hosted);
    assert.equal(hosted.status, "succeeded");
    const failing=events.filter(e=>e.status==="failed");
    assert.equal(failing.length,2);
    assert.equal(new Set(failing.map(e=>e.queryId)).size,2);
    assert.ok(failing.every(e=>e.usage?.inputTokens===19 && e.usage?.outputTokens===7 && events.some(start=>start.status==="running" && start.queryId===e.queryId)));
    assert.deepEqual(events.find(e=>e.provider==="openai" && e.status==="succeeded")?.usage,{inputTokens:512,outputTokens:0,estimatedCostUsd:null});
    assert.equal(hosted.revision, "configured-openai-snapshot");
    assert.ok(hosted.fallbackReason);
    assert.doesNotMatch(JSON.stringify([events,draft]), /test-session-value|PRIVATE_DATASET_GOLD/);
  }
});

test("unconfigured hosted models and loaded Gemma cannot become planners", async t => {
  const {work,calls} = fixture(t,{inventory:[{...model,model:"gemma-4"},
    {...model,provider:"compatible",model:"gpt-example",endpoint:"https://api.openai.com/v1"}]});
  await assert.rejects(work.design({...quick,domain:"Financial Services"}), /Load an LFM3/);
  assert.equal(calls.length,0);
});

test("invalid metrics and incomplete instructions never become catalogue entries", async t => {
  const {work} = fixture(t,{reply:() => JSON.stringify({metrics:["part_id"],requirements:["—"]})});
  await assert.rejects(work.design({...quick,domain:"Financial Services"},{}, "suggest"), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /meaningful/);
    assert.doesNotMatch(error.message, /\.\./);
    return true;
  });
  assert.deepEqual(work.list(),[]);
});

test("a copied or unpaired aggregate is replaced by the pass rate for each expert criterion", async t => {
  const {work} = fixture(t,{reply:() => JSON.stringify({
    requirements:["The reported EPS matches diluted GAAP EPS.","The citation supports the reporting period."],
    metrics:["Rate of delayed shipments."],
  })});
  const s = await work.design({mode:"quick",domain:"Financial Services",objective:"Check diluted GAAP EPS and cite the reporting period."},{}, "suggest");
  assert.equal(s.metrics.length, s.criteria.length);
  assert.ok(s.metrics.every((m,i) => m.includes(s.criteria[i])));
  assert.doesNotMatch(JSON.stringify(s.metrics), /shipment/);
});

test("unwritten inspection policies are removed before the implementer sees the expert brief", async t => {
  const objective = "Extract the part ID and decide whether to hold this lot. Sample: part B-71 measures 5.04 mm against a 5.02 mm upper limit.";
  const {work,calls} = fixture(t,{reply:result => JSON.stringify(result.metrics
    ? {title:"Inspection",metrics:["Pass rate for inspected lots"],requirements:["Use a tolerance of ±0.01 mm (implied).","Apply the typical boundary convention."]}
    : {prompt:"Use a tolerance of ±0.01 mm (implied). Compute the pass rate across all cases."})});
  const d = await work.design({mode:"quick",domain:"Manufacturing",objective});
  assert.ok(d.prompt.startsWith(objective));
  assert.match(d.prompt,/Cite the supplied measurement and its stated limit/);
  assert.equal(review.parse(d.criteriaReview).omitted,2);
  assert.equal(review.parse(d.guidanceReview).omitted,2);
  assert.equal(review.parse(d.criteriaReview).supplementSource,"DASH built-in manufacturing inspection check");
  assert.equal(review.parse(d.guidanceReview).supplementSource,review.parse(d.criteriaReview).supplementSource);
  assert.doesNotMatch(calls[1].messages[1].content,/0\.01|typical boundary/);
  assert.doesNotMatch(d.prompt,/0\.01|pass rate|typical boundary/i);
});

test("planning estimates count cached input once and require verified pricing and usage", () => {
  const body={model:"gpt-4.1-mini-2025-04-14",service_tier:"default",
    usage:{prompt_tokens:100_000,prompt_tokens_details:{cached_tokens:40_000},completion_tokens:20_000}};
  assert.deepEqual(hostedPlanningUsage(body),{inputTokens:100_000,outputTokens:20_000,estimatedCostUsd:0.06});
  for (const incomplete of [{...body,model:"custom"},{...body,service_tier:"priority"},
    {...body,usage:{prompt_tokens:100,completion_tokens:3}},{...body,usage:{...body.usage,prompt_tokens:1}}])
    assert.equal(hostedPlanningUsage(incomplete).estimatedCostUsd,null);
  assert.deepEqual(hostedPlanningUsage({usage:{prompt_tokens:-1,completion_tokens:0}}),
    {inputTokens:null,outputTokens:0,estimatedCostUsd:null});
});

test("a canceled planning call keeps returned usage and never invokes a fallback", async t => {
  const {adapters}=fixture(t);
  const controller=new AbortController();
  const events:PlanningAttempt[]=[];
  t.mock.method(adapters,"invoke",async ()=>{
    controller.abort();
    return inferenceReply('{"domain":"Manufacturing"}',{input_tokens:12,output_tokens:0});
  });
  const route=await PlanningRoute.start(adapters,{openaiFallback:()=>assert.fail("Canceled requests stop")},controller.signal,
    event=>{events.push(event);throw Error("Window closed");});
  await assert.rejects(route.ask("Domain routing","route",{}, {},80, value=>value.domain), /canceled/i);
  assert.deepEqual(events.map(e=>e.status),["running","canceled"]);
  assert.equal(events[0].queryId,events[1].queryId);
  assert.deepEqual(events[1].usage,{inputTokens:12,outputTokens:0,estimatedCostUsd:null});
});

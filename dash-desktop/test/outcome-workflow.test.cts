import {isExternalOutcomeMetric} from "../lib/metric-audit.cjs";
import {auditReply} from "./audit-fixture.cjs";
import {test,type TestContext} from "node:test";
import assert = require("node:assert/strict");
import { DatabaseSync } from "node:sqlite";
import {OutcomeWorkflow,contractHash,type DesignContext} from "../lib/outcome-workflow.cjs";
import {hostedPlanningUsage} from "../lib/planning-usage.cjs";
import {PlanningRoute,type PlannerAdapters,type PlanningAttempt} from "../lib/planner-routing.cjs";
import type {LocalCandidate,ModelCandidate,ChatTurn} from "../lib/runtime-types.cjs";
import {z} from "zod";
const planSchema=z.object({properties:z.record(z.string(),z.unknown()),required:z.array(z.string())});
const candidateTask=z.object({objective:z.string(),inputCap:z.number().nullable(),outputCap:z.number().nullable(),
  mode:z.string(),dataset:z.unknown(),assignment:z.string(),refinement:z.unknown().optional()}).strict();
const review=z.object({omitted:z.number(),supplementSource:z.string().optional()});
const attempts=z.array(z.object({status:z.string(),provider:z.string(),revision:z.string().nullable().optional(),reason:z.string().optional(),fallbackReason:z.string().optional()}));
interface PlannerCall {candidate:ModelCandidate; messages:ChatTurn[]; structured:z.infer<typeof planSchema>; signal:AbortSignal}
interface ReplyFields {title?:string;domain?:string;metrics?:string[];requirements?:string[];prompt?:string}
interface FixtureOptions {
  audit?:(messages:ChatTurn[])=>unknown;
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
      if(schema.audit) return inferenceReply(JSON.stringify(options.audit?.(messages) ?? auditReply(messages)),{input_tokens:19,output_tokens:7});
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
  assert.equal(calls.length, 4);
  assert.ok(calls.every(c => c.candidate === model));
  assert.deepEqual(calls.map(c => Object.keys(c.structured.properties)), [["domain"], ["title","metrics","requirements"], ["audit"], ["prompt","reason"]]);
  const expertMessage = calls[1].messages[0].content;
  assert.match(expertMessage, /[Mm]anufacturing/);
  assert.match(expertMessage, /nist\.gov/);
  const implementationBrief=candidateTask.parse(JSON.parse(calls[3].messages[1].content));
  assert.equal(implementationBrief.outputCap, 80);
  assert.equal(implementationBrief.inputCap, 600);
  assert.equal(implementationBrief.objective, request.objective);
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

test("edited measures are audited and saved independently of candidate preparation", async t => {
  const { work, calls } = fixture(t);
  const s = await work.design(quick, {}, "suggest");
  assert.equal(calls.length, 3);
  assert.deepEqual(s.criteria, expert.requirements);
  assert.deepEqual(work.list(), []);
  const drafts:unknown=Object.getOwnPropertyDescriptor(work,"drafts")?.value;
  assert.ok(drafts instanceof Map);
  assert.equal(drafts.size, 0);
  const measures = {metrics:["Incorrect releases per 100 inspected lots"],criteria:["Route missing revisions to quality review."]};
  const draft = await work.design({...quick,suggestionId:s.id,measures});
  assert.equal(calls.length, 5);
  const last=calls.at(-1);
  assert.ok(last);
  const rawBrief:unknown=JSON.parse(last.messages[1].content);
  const brief=candidateTask.parse(rawBrief);
  assert.equal(brief.objective,quick.objective);
  assert.deepEqual(draft.metrics,measures.metrics);
  assert.deepEqual(draft.requirements,measures.criteria);
  assert.doesNotMatch(JSON.stringify(rawBrief),/missing revisions|100 inspected lots/);
  assert.doesNotMatch(JSON.stringify(rawBrief), /Cite the drawing revision/);
  const p = work.approve({draftId:draft.draftId,prompt:draft.prompt});
  assert.deepEqual(p.metrics, measures.metrics);
  assert.deepEqual(p.requirements, measures.criteria);
  assert.equal(z.object({designer:z.object({model:z.string()})}).parse(p.suggestions).designer.model, model.model);
  await assert.rejects(work.design({...quick,objective:"Perform a reconciliation.",suggestionId:s.id,measures}), /Suggest Metrics again/);
  await assert.rejects(work.design({...dataset,suggestionId:s.id,measures},context), /Suggest Metrics again/);
});

test("dataset drafting uses three real stages and only the public task contract", async t => {
  const { work, calls } = fixture(t);
  const dirty = { ...context, rows:[{gold:"SECRET_LABEL", input:"SECRET_ROW"}], pack:{...pack, challenge:"SECRET_SCENARIO_EXTRA"} };
  const draft = await work.design(dataset, dirty);
  assert.equal(calls.length, 3);
  for (const call of calls.filter(c=>!c.structured.properties.audit)) {
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
  assert.match(calls[3].messages[0].content, /custom inspection guide/);
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
    assert.deepEqual(attempts.parse(draft.planningAttempts).map(a=>a.status), ["succeeded","succeeded","succeeded"]);
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
  assert.equal(calls.length, 4);
  assert.match(calls[3].messages[0].content, /Correct the previous generation/);
  assert.doesNotMatch(calls[3].messages[0].content, /part_id, part_id/);
  assert.doesNotMatch(draft.prompt, /part_id/);
  assert.match(attempts.parse(draft.planningAttempts)[2].reason || "", /repeated/);
  assert.deepEqual(attempts.parse(draft.planningAttempts).map(a=>a.status), ["succeeded","succeeded","failed","succeeded"]);
});

test("failure of either role falls back directly to the configured OpenAI endpoint with accurate provenance", async t => {
  for (const failingRole of ["expert","implementer"]) {
    const {db,adapters,calls} = fixture(t, {reply: result => {
      if (failingRole === "expert" && result.metrics) return JSON.stringify({...result,requirements:["part_id, ".repeat(10)]});
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
    assert.equal(calls.length, 4);
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

test("the auditor replaces a copied or unpaired aggregate for each expert criterion", async t => {
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
  assert.doesNotMatch(calls[2].messages[1].content,/0\.01|typical boundary/);
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

test("planning emits bounded numeric progress, measured timings and one terminal receipt",async t=>{
  const {adapters}=fixture(t);
  const events:PlanningAttempt[]=[];
  const run:PlannerAdapters["invoke"]=async(_candidate,_messages,options)=>{
    const reading={phase:"processing-prompt" as const,percent:20,content:"private source text"};
    options.onPlanningProgress?.(reading);
    options.onPlanningProgress?.({...reading,inputTokens:37});
    for(let n=0;n<30;n++)options.onPlanningProgress?.({phase:"generating",approximateOutputTokens:n});
    return inferenceReply('{"domain":"Manufacturing"}',{input_tokens:9,output_tokens:3,first_token_ms:41,provider_first_token_ms:32,tokens_per_second:22});
  };
  t.mock.method(adapters,"invoke",run);
  const route=await PlanningRoute.start(adapters,{},new AbortController().signal,event=>{events.push(event);});
  assert.equal(await route.ask("Domain routing","role",{}, {},32,r=>r.domain),"Manufacturing");
  assert.deepEqual(events.filter(e=>e.progress).map(e=>[e.progress,e.usage?.inputTokens]),[
    [{phase:"processing-prompt",percent:20},undefined],[{phase:"processing-prompt",percent:20},37],
    [{phase:"generating",approximateOutputTokens:0},37],
  ]);
  assert.equal(route.attempts.length,1);
  const [final]=route.attempts;
  assert.equal(final.firstTokenMs,32);assert.equal(final.tokensPerSecond,22);
  assert.ok(typeof final.elapsedMs==="number" && final.elapsedMs>=0);
  assert.ok(typeof final.discoveryMs==="number" && final.discoveryMs>=0);
  assert.equal(final.progress,undefined);
  assert.equal(final.usage?.inputTokens,9);
  assert.equal(final.usage?.outputTokens,3);
});

test("each query owns its prompt total when a final input count is missing", async t=>{
  const {adapters}=fixture(t);
  let input=21;
  const run:PlannerAdapters["invoke"]=async(_candidate,_messages,options)=>{
    options.onPlanningProgress?.({phase:"processing-prompt",percent:75,inputTokens:input});
    return inferenceReply('{"domain":"Manufacturing"}',{input_tokens:null,output_tokens:1});
  };
  t.mock.method(adapters,"invoke",run);
  const route=await PlanningRoute.start(adapters,{},new AbortController().signal,()=>{});
  for (input of [21,0,NaN]) await route.ask("Domain routing","role",{}, {},32,r=>r.domain);
  assert.deepEqual(route.attempts.map(r=>r.usage?.inputTokens),[21,null,null]);
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

const audited = (metric:string,criterion:string,status:"proposed"|"needs-evidence"|"external"="proposed")=>({
  metric,criterion,status,evidence:"The candidate answer and the source release for the case.",
  method:"Compare the reported field with the labeled value and period.",reason:"This distinguishes the reported GAAP field from the adjusted figure.",
});

test("a short invalid metric and role echoes cannot replace an independent case-level audit",async t=>{
  const objective="Report diluted GAAP EPS and the quarter from the release. For the quarter ended June 30, diluted GAAP EPS was $0.74 and adjusted EPS was $0.85.";
  const captured="Reports the diluted GAAP EPS of $0.74 and the reporting quarter (ended June 30).";
  const copied="Inspect what the ANSWER does, never inventory what happens to appear in an input document.";
  const {work,calls}=fixture(t,{
    reply:result=>result.metrics ? JSON.stringify({metrics:["part_id, ".repeat(10),"EPS"],requirements:[copied,"Compare reported diluted EPS against the release."]}) :
      JSON.stringify({prompt:"Write two standalone sentences. Use only the values, units and decision rules explicitly given in the case or task. Leave the decision to the candidate. Request review if a necessary rule is absent.",reason:"Increases accuracy."}),
    audit:messages=>{
      assert.doesNotMatch(messages[1].content,/inventory what happens/);
      return {audit:[audited("Diluted GAAP EPS source agreement",captured)]};
    },
  });
  const suggested=await work.design({mode:"quick",domain:"Financial Services",objective},{},"suggest");
  assert.equal(suggested.auditAgent?.id,"workflow-metric-auditor");
  const first=suggested.metricAudit?.[0];
  assert.ok(first);
  assert.equal(first.status,"needs-evidence");
  assert.match(first.reason,/adjusted figure/);
  const draft=await work.design({mode:"quick",domain:"Financial Services",objective,suggestionId:suggested.id,
    measures:{metrics:suggested.metrics,criteria:suggested.criteria}});
  const implementation=calls.at(-1);
  assert.ok(implementation);
  const brief=candidateTask.parse(JSON.parse(implementation.messages[1].content));
  assert.equal(brief.objective,objective);
  const {objective:publicObjective,...rest}=brief;
  assert.doesNotMatch(JSON.stringify(rest),/0\.74|June 30|Write two standalone/);
  assert.equal(draft.prompt,objective);
  assert.deepEqual(draft.promptRationale?.addition,"");
  assert.equal(draft.planningAttempts?.filter(a=>a.stage==="Evaluation metric audit").length,1);
  const saved=work.approve({draftId:draft.draftId,prompt:draft.prompt});
  assert.deepEqual(work.get(saved.id).metricAudit,suggested.metricAudit);
  assert.deepEqual(work.get(saved.id).promptRationale,draft.promptRationale);
});

test("external benefits remain separate and generic or copied auditor output gets bounded correction",async t=>{
  const {work}=fixture(t,{audit:()=>({audit:[audited("Investor confidence","Verify whether investor confidence rose after the announcement.")]})});
  const suggestion=await work.design({mode:"quick",domain:"Financial Services",objective:"Improve investor confidence."},{},"suggest");
  assert.deepEqual(suggestion.metrics,[]);
  assert.equal(suggestion.metricAudit?.[0].status,"external");
  const bad=fixture(t,{audit:()=>({audit:[audited("Quality score","The answer meets the objective.")]})});
  await assert.rejects(bad.work.design({...quick,domain:"Manufacturing"},{},"suggest"),/metric audit.*generic or copied/i);
  assert.equal(bad.calls.filter(call=>call.structured.properties.audit).length,2);
  const copied=fixture(t,{audit:()=>({audit:[audited("Result","Inspect what the ANSWER does, never inventory what happens to appear in an input document.")]})});
  await assert.rejects(copied.work.design({...quick,domain:"Manufacturing"},{},"suggest"),/metric audit.*generic or copied/i);
});

test("only confirmed scenario measures can be proposed and edited approvals withdraw the original audit",async t=>{
  const {work}=fixture(t,{audit:()=>({audit:[audited("False accepts","Compare the earnings record to the GAAP EPS in its source."),
    audited("Revenue projections","Compare the EPS estimate with a forecast.") ]})});
  const request={...dataset,objective:"Compare proposed accept decisions for GAAP EPS extraction."};
  const publicContext={...context,pack:{...pack,id:"earnings",scorer:"earnings-record-v1",metrics:["Analyst-ready records","False accepts","Analyst review rate"]},
    industry:"Financial Services",coverage:{cases:8,referenceCases:8,rubricCases:0}};
  const plan=await work.design(request,publicContext);
  assert.deepEqual(plan.metricAudit?.map(a=>a.status),["proposed","needs-evidence"]);
  assert.deepEqual(plan.auditCoverage,{cases:8,referenceCases:8,rubricCases:0});
  const text=plan.objective+"\n\nOperator-edited instructions for each release.";
  const saved=work.approve({draftId:plan.draftId,prompt:text});
  assert.equal(saved.metricAudit,undefined);
  assert.equal(saved.promptRationale?.addition,"Operator-edited instructions for each release.");
  assert.match(saved.promptRationale?.reason??"",/operator edited/i);
  const missing=await work.design(request,{...publicContext,coverage:{cases:8,referenceCases:0,rubricCases:0}},"suggest");
  assert.ok(missing.metricAudit?.every(r=>r.status==="needs-evidence"));
});

test("operational effects and extraction of a reported effect have distinct evidence boundaries",()=>{
  for (const metric of ["Six-month warranty-cost reduction","Reduce warranty costs over six months","Improve investor confidence","Reduce analyst time"]) {
    assert.equal(isExternalOutcomeMetric(metric),true,metric);
  }
  for (const metric of ["Accuracy of extracting reported warranty-cost reduction from the supplied filing",
       "Reported cost savings extraction accuracy","Correctly reported GAAP EPS"]) {
    assert.equal(isExternalOutcomeMetric(metric),false,metric);
  }
});

test("approval keeps criteria only for exactly retained metrics in the final order",async t=>{
  const amount=audited("GAAP EPS agreement","Compare diluted GAAP EPS with the reported GAAP figure.");
  const quarter=audited("Quarter agreement","Compare the reported quarter with the supplied release.");
  const citation=audited("Citation agreement","Check that the quote supports the reported GAAP EPS.");
  const {work}=fixture(t,{audit:()=>({audit:[amount,quarter,citation]})});
  const request={mode:"quick",domain:"Financial Services",objective:"Extract GAAP EPS, quarter and supporting citation."};
  const plan=await work.design(request);
  const finalMetrics=[citation.metric,"Revised quarter metric",amount.metric];
  const saved=work.approve({draftId:plan.draftId,prompt:plan.prompt,metrics:finalMetrics});
  assert.deepEqual(saved.metrics,finalMetrics);
  assert.deepEqual(saved.requirements,[citation.criterion,amount.criterion]);
  assert.equal(saved.metricAudit,undefined);
  assert.deepEqual(work.get(saved.id).requirements,saved.requirements);
  const cleared=await work.design(request);
  const empty=work.approve({draftId:cleared.draftId,prompt:cleared.prompt,metrics:[]});
  assert.deepEqual(work.get(empty.id).requirements,[]);
});

test("an invented fiscal year is omitted and a repeated objective is stripped from the implementer addition",async t=>{
  const objective="Extract diluted GAAP EPS and reporting period. Supplied release: For the quarter ended June 30, diluted GAAP EPS was $0.74.";
  const missingYear=audited("Quarter accuracy","Reports the quarter ended June 30, 2023.");
  const eps=audited("EPS source agreement","Compare diluted GAAP EPS with the figure in the supplied release.");
  const {work}=fixture(t,{
    audit:()=>({audit:[missingYear,eps]}),
    reply:result=>result.prompt ? JSON.stringify({prompt:"Objective: "+objective+" Preserve decimal precision."}) : null,
  });
  const plan=await work.design({mode:"quick",domain:"Financial Services",objective});
  assert.deepEqual(plan.metricAudit?.map(a=>a.metric),[eps.metric]);
  assert.doesNotMatch(JSON.stringify(plan.requirements),/2023/);
  assert.equal(plan.prompt,objective+"\n\nPreserve decimal precision.");
  assert.equal(plan.promptRationale?.addition,"Preserve decimal precision.");
  const one=fixture(t,{audit:()=>({audit:[missingYear]})});
  await assert.rejects(one.work.design({mode:"quick",domain:"Financial Services",objective},{},"suggest"),/unsupported number or year/);
  assert.equal(one.calls.filter(q=>q.structured.properties.audit).length,2);
});

test("independent measure edits preserve known pairs across suggestions and approved revisions",async t=>{
  const amount=audited("EPS agreement","Compare GAAP EPS with the reported source figure.");
  const quote=audited("Citation agreement","Check that the cited passage supports the EPS.");
  const period=audited("Quarter agreement","Compare the reporting period with the filing.");
  const {work,calls}=fixture(t,{audit:messages=>{
    const data=z.object({preserveSelectedWording:z.boolean()}).parse(JSON.parse(messages[1].content));
    return data.preserveSelectedWording ? auditReply(messages) : {audit:[amount,quote,period]};
  }});
  const base={mode:"quick",domain:"Financial Services",objective:"Extract and cite GAAP EPS and its reporting quarter."};
  const s=await work.design(base,{},"suggest");
  const chosen=[period.metric,amount.metric];
  const d=await work.design({...base,suggestionId:s.id,measures:{metrics:chosen,criteria:s.criteria}});
  assert.deepEqual(d.metrics,chosen);
  assert.deepEqual(d.requirements,[period.criterion,amount.criterion]);
  const saved=work.approve({draftId:d.draftId,prompt:d.prompt});
  const revised=await work.design({...base,parentId:saved.id,measures:{metrics:[amount.metric],criteria:saved.requirements}});
  assert.deepEqual(revised.requirements,[amount.criterion]);
  const before=calls.filter(c=>c.structured.properties.audit).length;
  const cleared=await work.design({...base,suggestionId:s.id,measures:{metrics:[],criteria:s.criteria}});
  assert.deepEqual(cleared.metrics,[]);
  assert.deepEqual(cleared.requirements,[]);
  assert.equal(calls.filter(c=>c.structured.properties.audit).length,before);
  await assert.rejects(work.design({...base,suggestionId:s.id,
    measures:{metrics:["New A","New B"],criteria:["New test A","New test B"]}}),/change one pair at a time/);
});

test("an operator passage count is scoped to its own edited pair and survives approval",async t=>{
  const eps=audited("EPS agreement","Compare GAAP EPS with the reported source figure.");
  const citations=audited("Supporting passages","Cite 2 supporting passages.");
  const {work}=fixture(t,{audit:messages=>{
    const data=z.object({preserveSelectedWording:z.boolean()}).parse(JSON.parse(messages[1].content));
    if (!data.preserveSelectedWording) return {audit:[eps]};
    return {audit:[{...eps,method:"Compare EPS against 2 case filings."},citations]};
  }});
  const request={mode:"quick",domain:"Financial Services",objective:"Extract and cite the reported GAAP EPS."};
  const prior=await work.design(request,{},"suggest");
  const draft=await work.design({...request,suggestionId:prior.id,measures:{
    metrics:[eps.metric,citations.metric],criteria:[eps.criterion,citations.criterion],
  }});
  const [first,second]=draft.metricAudit??[];
  assert.equal(first.metric,eps.metric);
  assert.equal(first.status,"needs-evidence");
  assert.doesNotMatch(first.method,/2 case filings/);
  assert.equal(second.metric,citations.metric);
  assert.equal(second.criterion,citations.criterion);
  assert.equal(second.method,citations.method);
  const saved=work.approve({draftId:draft.draftId,prompt:draft.prompt});
  assert.deepEqual(work.get(saved.id).requirements,[eps.criterion,citations.criterion]);
});

test("revising a historical prompt recovers its aligned criteria and surfaces ambiguous historic lists",async t=>{
  const {work,db}=fixture(t);
  const base={mode:"quick",domain:"Financial Services",objective:"Extract and cite reported GAAP EPS."};
  const metrics=["EPS agreement"],criteria=["Compare the reported EPS amount to the cited source."];
  function historical(id:string,requirements:string[]) {
    const spec={...base,id,familyId:id,version:1,title:"Historical EPS check",prompt:"Extract EPS.",metrics,requirements};
    db.prepare("INSERT INTO outcome_prompts VALUES(?,?,?,?,?,?)").run(id,id,1,id,"legacy",JSON.stringify(spec));
  }
  historical("legacy-aligned",criteria);
  const draft=await work.design({...base,parentId:"legacy-aligned",measures:{metrics,criteria}});
  assert.deepEqual(draft.metrics,metrics);
  assert.deepEqual(draft.requirements,criteria);
  const ambiguous=[...criteria,"Confirm the reporting period."];
  historical("legacy-ambiguous",ambiguous);
  await assert.rejects(work.design({...base,parentId:"legacy-ambiguous",measures:{metrics,criteria:ambiguous}}),/Pair one success criterion/);
});

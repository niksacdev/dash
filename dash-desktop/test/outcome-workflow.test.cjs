const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { OutcomeWorkflow, contractHash } = require("../lib/outcome-workflow.cjs");

const model = { model:"lfm3-planner", provider:"lmstudio", loaded:true, parameterSize:"8B" };
const expert = { title:"Review incoming lots", metrics:["Correct drawing revisions per cited revision"], requirements:["Cite the drawing revision."] };
const quick = { mode:"quick", objective:"Flag out-of-tolerance parts for the inspector." };
const pack = { id:"inspection", title:"Receiving inspection", system:"Inspect a part.", outputSchema:{type:"object"}, metrics:["False releases"] };
const context = { pack, datasetId:"snapshot-1", version:"3", split:"holdout", industry:"Manufacturing" };
const dataset = { ...quick, mode:"dataset", datasetId:"snapshot-1" };

function fixture(t, options = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const calls = [];
  const adapters = {
    discover:async () => [{ models:options.inventory || [model] }],
    invoke:async (candidate, messages, { structured, signal }) => {
      calls.push({ candidate, messages, structured, signal });
      const schema = structured.properties;
      const result = schema.domain ? { domain:"Manufacturing" } :
        schema.requirements ? expert : { prompt:"Check the source drawing, record units, and explain any inspection referral." };
      return { output:options.reply?.(result) ?? JSON.stringify(result) };
    },
  };
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
  const implementationBrief = JSON.parse(calls[2].messages[1].content);
  assert.deepEqual(implementationBrief.expertBrief, expert);
  assert.equal(implementationBrief.outputCap, 80);
  assert.equal(implementationBrief.inputCap, 600);
  assert.equal(implementationBrief.metrics[0], request.metrics);
  assert.match(draft.prompt, /Flag out-of-tolerance parts/);
  assert.equal(draft.domainSource, "inferred");
  assert.equal(draft.domain, "Manufacturing");
  assert.equal(draft.agents.length, 2);
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
  assert.equal(saved.designer.model, "lfm3-planner");
  assert.deepEqual(work.get(saved.id), saved);
});

test("suggestions use the domain expert and edited measures reach the implementer and approval", async t => {
  const { work, calls } = fixture(t);
  const s = await work.design(quick, {}, "suggest");
  assert.equal(calls.length, 2);
  assert.deepEqual(s.criteria, expert.requirements);
  assert.deepEqual(work.list(), []);
  assert.equal(work.drafts.size, 0);
  const measures = {metrics:["Incorrect releases per 100 inspected lots"],criteria:["Route missing revisions to quality review."]};
  const draft = await work.design({...quick,suggestionId:s.id,measures});
  assert.equal(calls.length, 3);
  const brief = JSON.parse(calls.at(-1).messages[1].content);
  assert.deepEqual(brief.metrics, measures.metrics);
  assert.deepEqual(brief.expertBrief.requirements, measures.criteria);
  assert.doesNotMatch(JSON.stringify(brief), /Cite the drawing revision/);
  const p = work.approve({draftId:draft.draftId,prompt:draft.prompt});
  assert.deepEqual(p.metrics, measures.metrics);
  assert.deepEqual(p.requirements, measures.criteria);
  assert.equal(p.suggestions.designer.model, model.model);
  await assert.rejects(work.design({...quick,objective:"Perform a reconciliation.",suggestionId:s.id,measures}), /Suggest Metrics again/);
  await assert.rejects(work.design({...dataset,suggestionId:s.id,measures},context), /Suggest Metrics again/);
});

test("dataset drafting uses two real stages and only the public task contract", async t => {
  const { work, calls } = fixture(t);
  const dirty = { ...context, rows:[{gold:"SECRET_LABEL", input:"SECRET_ROW"}], pack:{...pack, challenge:"SECRET_SCENARIO_EXTRA"} };
  const draft = await work.design(dataset, dirty);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const publicTask = JSON.parse(call.messages[1].content).dataset;
    assert.equal(publicTask.system, pack.system);
    assert.equal(publicTask.version, undefined);
    assert.equal(publicTask.datasetId, undefined);
  }
  assert.doesNotMatch(JSON.stringify(calls), /SECRET_/);
  assert.equal(draft.contractHash, contractHash(pack));
  assert.equal(draft.packId, pack.id);
  assert.equal(draft.dataset.version, "3");
  assert.deepEqual(draft.dataset.outputSchema, pack.outputSchema);
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
  const before = await work.design(dataset, context);
  const edit = {...original, expectedVersion:original.version, instructions:"Inspect the lot using the custom inspection guide."};
  const next = work.saveRole(edit);
  assert.notEqual(next.hash, original.hash);
  assert.equal(next.version, 2);
  assert.throws(() => work.saveRole(edit), /changed/);
  const after = await work.design(dataset, context);
  assert.equal(after.agents.find(a => a.role === "expert").hash, next.hash);
  assert.match(calls[2].messages[0].content, /custom inspection guide/);
  const savedBefore = work.approve({draftId:before.draftId,prompt:before.prompt});
  assert.equal(savedBefore.agents.find(a => a.role === "expert").hash, original.hash);
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
    assert.deepEqual(draft.planningAttempts.map(a=>a.status), ["succeeded","succeeded"]);
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
  assert.match(draft.planningAttempts[1].reason, /repeated/);
  assert.deepEqual(draft.planningAttempts.map(a=>a.status), ["succeeded","failed","succeeded"]);
});

test("failure of either role falls back directly to the configured OpenAI endpoint with accurate provenance", async t => {
  for (const failingRole of ["expert","implementer"]) {
    const {db,adapters,calls} = fixture(t, {reply: result => {
      if (failingRole === "expert" && result.metrics) return JSON.stringify({...result,metrics:["part_id, ".repeat(10)]});
      if (failingRole === "implementer" && result.prompt) return "invalid output";
      return null;
    }});
    const urls = [], events = [];
    const work = new OutcomeWorkflow(db, adapters, {
      openaiFallback:() => ({model:"configured-openai",apiKey:"test-session-value",endpoint:"https://unapproved.invalid"}),
      fetch:async (url,init) => {
        urls.push(url);
        assert.equal(init.redirect, "error");
        assert.equal(init.headers.Authorization, "Bearer test-session-value");
        const body = JSON.parse(init.body);
        assert.equal(body.store, false);
        assert.doesNotMatch(init.body, /test-session-value|part_id, part_id|PRIVATE_DATASET_GOLD/);
        const output = failingRole === "expert" ? expert : {prompt:"Inspect the source drawing and explain any referral."};
        return Response.json({model:"configured-openai-snapshot",choices:[{message:{content:JSON.stringify(output)},finish_reason:"stop"}]});
      },
    });
    const draft = await work.design(dataset, {...context, gold:"PRIVATE_DATASET_GOLD", onStage:e=>events.push(e)});
    assert.deepEqual(urls, ["https://api.openai.com/v1/chat/completions"]);
    assert.equal(calls.length, 3);
    assert.equal(draft[ failingRole === "expert" ? "expertDesigner" : "designer"].provider, "openai");
    assert.equal(draft[ failingRole === "expert" ? "designer" : "expertDesigner"].provider, "lmstudio");
    const hosted = draft.planningAttempts.find(a=>a.provider==="openai");
    assert.equal(hosted.status, "succeeded");
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
  assert.equal(d.criteriaReview.omitted,2);
  assert.equal(d.guidanceReview.omitted,2);
  assert.equal(d.criteriaReview.supplementSource,"DASH built-in manufacturing inspection check");
  assert.equal(d.guidanceReview.supplementSource,d.criteriaReview.supplementSource);
  assert.doesNotMatch(calls[1].messages[1].content,/0\.01|typical boundary/);
  assert.doesNotMatch(d.prompt,/0\.01|pass rate|typical boundary/i);
});

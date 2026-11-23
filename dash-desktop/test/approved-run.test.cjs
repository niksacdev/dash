const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Bench } = require("../lib/bench.cjs");

function harness(t, checkInputBudget) {
  const calls = [];
  const candidates = ["lfm3-one", "two"].map(model => ({
    id: "lmstudio/" + model, model, provider: "lmstudio", loaded: true,
  }));
  const adapters = {
    discover: async () => [{ models: candidates }],
    checkInputBudget,
    async invoke(candidate, messages, options) {
      calls.push({ candidate, messages, options });
      let result;
      if (options.planning && options.structured.properties.requirements)
        result = { title: "Receiving inspection", metrics: ["False accepts"], requirements: ["Use the active drawing."] };
      else if (options.planning) result = { prompt: "Read the active drawing." };
      else result = { note: "PRIVATE_CANDIDATE_ANSWER" };
      return { output: JSON.stringify(result), telemetry: { input_tokens: 12, output_tokens: 8 } };
    },
  };
  const bench = new Bench(":memory:", adapters, async () => async () => null);
  t.after(() => bench.db.close());
  return { bench, calls, ids: candidates.map(c => c.id) };
}

test("the Quick preview checks both lanes before dispatch rechecks the current capacity", async t=>{
  let contextTokens=128;
  const {bench,calls,ids}=harness(t,async()=>({tokens:31,contextTokens,source:"verified mock template"}));
  await bench.refresh();
  const d=await bench.designPrompt({mode:"quick",domain:"Manufacturing",objective:"Classify this incoming lot.",outputCap:64});
  const p=bench.workflow.approve({draftId:d.draftId,prompt:d.prompt});
  const preview=await bench.previewQuickBudget(p.id,ids);
  assert.ok(preview.every(l=>l.inputTokens===31 && l.outputReserve===64 && l.status==="verified"));
  assert.equal(calls.filter(c=>!c.options.planning).length,0);
  contextTokens=64;
  const run=bench.start({mode:"quick",candidateIds:ids,approvedPromptId:p.id});
  await bench.active.done;
  assert.equal(bench.detail(run).manifest.guardrailFailure.status,"blocked");
  assert.equal(bench.detail(run).results.length,0);
});

async function approval(bench, limits = {}) {
  const d = bench.list().datasets.find(d => d.pack === "manufacturing");
  const draft = await bench.designPrompt({ mode: "dataset", datasetId:d.id,
    objective: "Screen the incoming lot.", ...limits });
  return bench.workflow.approve({ draftId:draft.draftId, prompt:"Check the supplied sample against its active drawing." });
}

test("a failed cap in a second lane stops both lanes before generation", async t => {
  const checks = [];
  const { bench, calls, ids } = harness(t, async ({candidate,messages}) => {
    checks.push(candidate.id);
    assert.match(messages[0].content, /Check the supplied sample/);
    if (candidate.id.endsWith("/two")) throw Error("The cap is too small.");
    return { tokens: 12, source: "test tokenizer" };
  });
  await bench.refresh();
  const p = await approval(bench, {inputCap:64, outputCap:128});
  const id = bench.start({ mode:"dataset", datasetId:p.datasetId, approvedPromptId:p.id, candidateIds:ids });
  await bench.active.done;
  const r = bench.detail(id);
  assert.equal(r.status, "failed");
  assert.match(r.manifest.error, /two.*cap is too small/);
  assert.equal(r.results.length, 0);
  assert.deepEqual([...new Set(checks)], ids);
  assert.deepEqual(calls.filter(c => !c.options.planning), []);
});

test("refining from a run gives the agents measured counts and preserves its original revision", async t => {
  const { bench, calls, ids } = harness(t);
  await bench.refresh();
  const p = await approval(bench);
  const id = bench.start({mode:"dataset",datasetId:p.datasetId,approvedPromptId:p.id,candidateIds:[ids[0]]});
  await bench.active.done;
  const next = {mode:"dataset",datasetId:p.datasetId,objective:"Reduce incoming inspection errors.",parentId:p.id,sourceRunId:id};
  const index = calls.length;
  const draft = await bench.designPrompt(next);
  assert.equal(draft.priorRun.candidates[0].scored, 5);
  assert.equal(draft.priorRun.candidates[0].passed, 0);
  for (const call of calls.slice(index)) {
    const brief = JSON.parse(call.messages[1].content);
    assert.equal(brief.priorRun.id, id);
    assert.doesNotMatch(JSON.stringify(brief.priorRun), /PRIVATE_CANDIDATE_ANSWER|gold|source_locator/);
  }
  const revised = bench.workflow.approve({ draftId:draft.draftId, prompt:draft.prompt });
  assert.equal(revised.sourceRunId, id);
  assert.equal(revised.version, 2);
  assert.equal(bench.detail(id).manifest.approvedPrompt.id, p.id);
  await assert.rejects(bench.designPrompt({...next,parentId:revised.id}), /saved run of the prompt revision/);
  const firstCase = bench.detail(id).manifest.caseIds[0];
  assert.throws(() => bench.start({mode:"dataset",datasetId:p.datasetId,parentId:id,caseId:firstCase,
    candidateIds:[ids[0]],approvedPromptId:revised.id}), /original approved prompt/);
  const replay = bench.start({mode:"dataset",datasetId:p.datasetId,parentId:id,caseId:firstCase,candidateIds:[ids[0]]});
  await bench.active.done;
  assert.equal(bench.detail(replay).manifest.approvedPromptId, p.id);
});

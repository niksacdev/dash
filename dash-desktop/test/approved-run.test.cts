import { test,type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Bench } from "../lib/bench.cjs";
import { objectValue,jsonText,isRecord } from "../lib/run-types.cjs";
import type { LocalCandidate,ModelCandidate,ChatTurn,InvokeOptions,RuntimeAdapters,CheckInputBudget } from "../lib/runtime-types.cjs";

import {inventory,reply,withoutPower,present} from "./runtime-fixtures.cjs";

function completion(bench:Bench) {
  assert.ok(bench.active?.done);
  return bench.active.done;
}
function harness(t:TestContext, checkInputBudget?:CheckInputBudget) {
  const calls:{candidate:ModelCandidate;messages:ChatTurn[];options:InvokeOptions}[] = [];
  const candidates = ["lfm3-one", "two"].map((model):LocalCandidate => ({
    id: "lmstudio/" + model, model, provider: "lmstudio", loaded: true,kind:"model",
  }));
  const adapters:RuntimeAdapters = {
    discover: async () => [inventory(candidates)],
    checkInputBudget,
    async invoke(candidate, messages, options) {
      calls.push({ candidate, messages, options });
      let result;
      if (options.planning && isRecord(options.structured?.properties) && options.structured.properties.requirements)
        result = { title: "Receiving inspection", metrics: ["False accepts"], requirements: ["Use the active drawing."] };
      else if (options.planning) result = { prompt: "Read the active drawing." };
      else result = { note: "PRIVATE_CANDIDATE_ANSWER" };
      return reply(JSON.stringify(result),{input_tokens:12,output_tokens:8});
    },
  };
  const bench = new Bench(":memory:", adapters, withoutPower);
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
  assert.ok(preview.every(l=>l.status==="verified" && l.inputTokens===31 && l.outputReserve===64));
  assert.equal(calls.filter(c=>!c.options.planning).length,0);
  contextTokens=64;
  const run=bench.start({mode:"quick",candidateIds:ids,approvedPromptId:p.id});
  await completion(bench);
  const failure=bench.detail(run).manifest.guardrailFailure;
  assert.ok(failure);
  assert.equal(failure.status,"blocked");
  assert.equal(bench.detail(run).results.length,0);
});

async function approval(bench:Bench, limits:{inputCap?:number;outputCap?:number} = {}) {
  const d = bench.list().datasets.find(d => d.pack === "manufacturing");
  assert.ok(d);
  const draft = await bench.designPrompt({ mode: "dataset", datasetId:d.id,
    objective: "Screen the incoming lot.", ...limits });
  return bench.workflow.approve({ draftId:draft.draftId, prompt:"Check the supplied sample against its active drawing." });
}

test("a failed cap in a second lane stops both lanes before generation", async t => {
  const checks:string[] = [];
  const { bench, calls, ids } = harness(t, async ({candidate,messages}) => {
    checks.push(candidate.id);
    assert.match(messages[0].content, /Check the supplied sample/);
    if (candidate.id.endsWith("/two")) throw Error("The cap is too small.");
    return { tokens: 12, source: "test tokenizer" };
  });
  await bench.refresh();
  const p = await approval(bench, {inputCap:64, outputCap:128});
  const datasetId=present(p.datasetId);
  const id = bench.start({ mode:"dataset", datasetId, approvedPromptId:p.id, candidateIds:ids });
  await completion(bench);
  const r = bench.detail(id);
  assert.equal(r.status, "failed");
  assert.ok(r.manifest.error);
  assert.match(r.manifest.error, /two.*cap is too small/);
  assert.equal(r.results.length, 0);
  assert.deepEqual([...new Set(checks)], ids);
  assert.deepEqual(calls.filter(c => !c.options.planning), []);
});

test("refining from a run gives the agents measured counts and preserves its original revision", async t => {
  const { bench, calls, ids } = harness(t);
  await bench.refresh();
  const p = await approval(bench);
  const datasetId=present(p.datasetId);
  const id = bench.start({mode:"dataset",datasetId,approvedPromptId:p.id,candidateIds:[ids[0]]});
  await completion(bench);
  const next = {mode:"dataset",datasetId,objective:"Reduce incoming inspection errors.",parentId:p.id,sourceRunId:id};
  const index = calls.length;
  const draft = await bench.designPrompt(next);
  const prior=objectValue(draft.priorRun);
  assert.ok(Array.isArray(prior.candidates));
  const measured=objectValue(prior.candidates[0]);
  assert.equal(measured.scored,5);
  assert.equal(measured.passed,0);
  for (const call of calls.slice(index)) {
    const brief=objectValue(jsonText(call.messages[1].content));
    assert.ok(isRecord(brief.priorRun));
    assert.equal(brief.priorRun.id, id);
    assert.doesNotMatch(JSON.stringify(brief.priorRun), /PRIVATE_CANDIDATE_ANSWER|gold|source_locator/);
  }
  const revised = bench.workflow.approve({ draftId:draft.draftId, prompt:draft.prompt });
  assert.equal(revised.sourceRunId, id);
  assert.equal(revised.version, 2);
  const savedPrompt=bench.detail(id).manifest.approvedPrompt;
  assert.ok(savedPrompt);
  assert.equal(savedPrompt.id, p.id);
  await assert.rejects(bench.designPrompt({...next,parentId:revised.id}), /saved run of the prompt revision/);
  const firstCase = bench.detail(id).manifest.caseIds[0];
  assert.throws(() => bench.start({mode:"dataset",datasetId,parentId:id,caseId:firstCase,
    candidateIds:[ids[0]],approvedPromptId:revised.id}), /original approved prompt/);
  const replay = bench.start({mode:"dataset",datasetId,parentId:id,caseId:firstCase,candidateIds:[ids[0]]});
  await completion(bench);
  assert.equal(bench.detail(replay).manifest.approvedPromptId, p.id);
});

test("live polling sends only new Quick text or a changed run revision", async t=>{
  const {bench,ids}=harness(t);
  await bench.refresh();
  const draft=await bench.designPrompt({mode:"quick",domain:"Manufacturing",objective:"Review this lot."});
  const approved=bench.workflow.approve({draftId:draft.draftId,prompt:draft.prompt});
  let enter:(options:InvokeOptions)=>void=()=>{throw Error("Gate not initialized");};
  const dispatch=new Promise<InvokeOptions>(resolve=>{enter=resolve;});
  let release:()=>void=()=>{throw Error("Gate not initialized");};
  const hold=new Promise<void>(resolve=>{release=resolve;});
  const invoke=bench.adapters.invoke;
  bench.adapters.invoke=async(candidate,messages,options)=>{
    if (candidate.id===ids[0]) {enter(options);await hold;}
    return invoke(candidate,messages,options);
  };
  const id=bench.start({mode:"quick",candidateIds:ids,approvedPromptId:approved.id});
  const done=completion(bench);
  try {
    const options=await dispatch;
    const revision=present(bench.detail(id).liveRevision);
    assert.deepEqual(bench.runProgress(id,revision,0),{kind:"unchanged"});
    options.onText?.("partial");
    assert.deepEqual(bench.runProgress(id,revision,0),{kind:"append",candidateId:ids[0],text:"partial"});
    assert.deepEqual(bench.runProgress(id,revision,7),{kind:"unchanged"});
    options.onText?.("partial answer");
    assert.deepEqual(bench.runProgress(id,revision,7),{kind:"append",candidateId:ids[0],text:" answer"});
    assert.deepEqual(bench.runProgress(id,revision,900),{kind:"refresh"});
    assert.deepEqual(bench.runProgress(id,revision-1,0),{kind:"refresh"});
  } finally {release();await done;}
  assert.deepEqual(bench.runProgress(id,0,0),{kind:"refresh"});
  assert.equal(bench.detail(id).liveRevision,null);
});

test("idle dataset polls do not repeat previous responses or expose the current case stream", async t=>{
  const {bench,ids}=harness(t);
  await bench.refresh();
  const d=present(bench.list().datasets.find(d=>d.pack==="manufacturing"));
  let enter:()=>void=()=>{throw Error("Gate not initialized");};
  const dispatch=new Promise<void>(resolve=>{enter=resolve;});
  let release:()=>void=()=>{throw Error("Gate not initialized");};
  const hold=new Promise<void>(resolve=>{release=resolve;});
  let calls=0;
  bench.adapters.invoke=async(_candidate,_messages,options)=>{
    if (++calls===2) {options.onText?.("unpublished case output");enter();await hold;}
    return reply("recorded response".repeat(256),{},"stop");
  };
  const id=bench.start({mode:"dataset",datasetId:d.id,candidateIds:[ids[0]]});
  const done=completion(bench);
  try {
    await dispatch;
    const run=bench.detail(id), revision=present(run.liveRevision);
    assert.equal(run.results.length,1);
    assert.ok((run.results[0].output?.length ?? 0)>4000);
    for(let i=0;i<8;i++) assert.deepEqual(bench.runProgress(id,revision,0),{kind:"unchanged"});
  } finally {release();await done;}
  assert.equal(bench.detail(id).status,"completed");
});

import test,{type TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Bench} from "../lib/bench.cjs";
import {startPower,type PowerSummary} from "../lib/power.cjs";
import {type LocalCandidate,type InvokeOptions,type RuntimeAdapters} from "../lib/runtime-types.cjs";
import {inventory,present,reply} from "./runtime-fixtures.cjs";

const models=["one","two"].map((model):LocalCandidate=>({id:"ollama/"+model,model,provider:"ollama",kind:"model",loaded:true}));
const modelIds=models.map(m=>m.id);
function gate() {
  let release=()=>{};
  const opened=new Promise<void>(resolve=>{release=resolve;});
  return {release,opened};
}

async function setup(t:TestContext,invoke:RuntimeAdapters["invoke"]) {
  const measurements:{mode:string;closed:boolean}[]=[];
  const sampler:typeof startPower=async(_reader,_interval,mode="boundary")=>{
    const window={mode,closed:false};
    measurements.push(window);
    const summary:PowerSummary={scope:"Whole device",source:"synthetic",interval_ms:1000,samples:[],sampleCount:3,
      sampled_seconds:2,estimated_energy_j:24,average_w:12,peak_w:14};
    return async()=>{window.closed=true;return summary;};
  };
  const bench=new Bench(":memory:",{discover:async()=>[inventory(models)],invoke},sampler);
  t.after(()=>bench.db.close());
  await bench.refresh();
  const datasetId=bench.import("reference","Synthetic receipt",["a","b"].map(case_id=>JSON.stringify({
    case_id,prompt:"Confirm "+case_id,reference:"matched",split:"development",dataset_version:"1",
  })).join("\n"));
  const start=(candidateIds=modelIds)=>bench.start({mode:"dataset",datasetId,candidateIds,datasetScorer:"exact-reference"});
  return {bench,measurements,start};
}
test("two Dataset workers overlap, advance independently, preserve visible case links and share one host energy window",async t=>{
  const firstPair=gate(),releaseOne=gate(),secondTwo=gate(),releaseTwo=gate();
  const active=new Set<string>(), calls:string[]=[];
  const observed:InvokeOptions[]=[];
  const {bench,measurements,start}=await setup(t,async(candidate,turns,options)=>{
    assert.ok(!active.has(candidate.id),"a candidate must finish its preceding case before starting another");
    const input=present(turns.at(-1)).content;
    calls.push(candidate.model+":"+input);
    active.add(candidate.id);
    if(input==="Confirm a") {
      observed.push(options);
      if(active.size===2)firstPair.release();
      if(candidate.id===modelIds[0])await releaseOne.opened;else await releaseTwo.opened;
    } else if(candidate.id===modelIds[1])secondTwo.release();
    active.delete(candidate.id);
    return reply("matched",{input_tokens:3,output_tokens:1},"stop");
  });
  const id=start(),done=present(bench.active?.done);
  try {
    await firstPair.opened;
    const detail=bench.detail(id);
    assert.equal(detail.results.length,0);
    assert.equal(detail.manifest.executionMode,"parallel-lanes");
    assert.equal(detail.manifest.sharedDevicePower,undefined);
    assert.equal(detail.liveLaneProgressVersion,1);
    const lanes=present(detail.candidatePartials);
    assert.deepEqual(lanes.map(lane=>[lane.candidateId,lane.caseId]),modelIds.map(candidate=>[candidate,"a"]));
    const cursors=lanes.map(lane=>({candidateId:lane.candidateId,caseId:lane.caseId,offset:0,usageRevision:0}));
    observed.forEach((options,i)=>{options.onText?.("private dataset stream "+i);options.onCandidateUsage?.({outputTokens:i+1});});
    assert.deepEqual(bench.runLaneProgress(id,present(detail.liveRevision),cursors),{kind:"lanes",updates:cursors.map((cursor,i)=>({
      candidateId:cursor.candidateId,caseId:"a",usage:{revision:1,outputTokens:i+1}
    }))});
    assert.ok(bench.detail(id).candidatePartials?.every(lane=>lane.text===""));
    releaseTwo.release();await secondTwo.opened;
    const early=bench.detail(id);
    assert.equal(early.results[0].candidateId,modelIds[1]);
    assert.equal(early.results[0].caseId,"a");
    assert.deepEqual(bench.runLaneProgress(id,present(detail.liveRevision),cursors),{kind:"refresh"});
    assert.equal(calls.filter(call=>call.startsWith("one:")).length,1);
    const directory=mkdtempSync(join(tmpdir(),"dash-parallel-checkpoint-"));
    try {
      const snapshot=join(directory,"restart.sqlite");
      bench.db.prepare("VACUUM INTO ?").run(snapshot);
      const restored=new Bench(snapshot,{discover:async()=>[inventory(models)],invoke:async()=>assert.fail("Recovery sent a candidate request")});
      try {
        const run=restored.detail(id);
        assert.equal(run.status,"interrupted");
        assert.equal(run.results[0].candidateId,modelIds[1]);
        assert.equal(run.results[0].output,"matched");
        assert.equal(run.results.find(r=>r.candidateId===modelIds[0])?.dispatchState,"interrupted");
        assert.equal(run.manifest.sharedDevicePower,undefined);
        assert.equal(restored.active,null);
      } finally {restored.db.close();}
    } finally {rmSync(directory,{recursive:true,force:true});}
  } finally {releaseOne.release();releaseTwo.release();await done;}
  const finished=bench.detail(id);
  assert.equal(finished.status,"completed");
  assert.equal(finished.results.length,4);
  assert.equal(finished.results[0].candidateId,modelIds[1]);
  assert.ok(finished.results.every(result=>result.telemetry?.device_power===undefined && result.score?.pass));
  assert.equal(finished.manifest.sharedDevicePower?.estimated_energy_j,24);
  assert.equal(finished.manifest.sharedDevicePower?.samples,3);
  assert.deepEqual(measurements,[{mode:"aggregate",closed:true}]);
  assert.deepEqual(new Set(calls),new Set(["one:Confirm a","two:Confirm a","one:Confirm b","two:Confirm b"]));
  assert.equal(calls.length,4);
  const single=start([modelIds[0]]);
  await present(bench.active?.done);
  const solo=bench.detail(single);
  assert.equal(solo.manifest.executionMode,"single-lane");
  assert.equal(solo.manifest.sharedDevicePower,undefined);
  assert.ok(solo.results.every(r=>r.telemetry?.device_power?.estimated_energy_j===24));
});

for(const termination of ["operator cancel","checkpoint failure"] as const) {
  test(termination+" drains both candidate requests and preserves exactly the observed cases",async t=>{
    const entered=gate(),aborted=gate(),drain=gate();
    const options:InvokeOptions[]=[];
    let abortCount=0;
    const {bench,measurements,start}=await setup(t,async(_candidate,_turns,opt)=>{
      options.push(opt);if(options.length===2)entered.release();
      await new Promise<void>(resolve=>opt.signal.addEventListener("abort",()=>{if(++abortCount===2)aborted.release();resolve();},{once:true}));
      await drain.opened;
      opt.signal.throwIfAborted();
      return reply("");
    });
    const id=start(),job=present(bench.active),done=present(job.done);
    try {
      await entered.opened;
      options[1].onText?.("observed sibling fragment");
      if(termination==="operator cancel")bench.stop(id);
      else {
        bench.db.exec("CREATE TRIGGER fail_live_write BEFORE UPDATE ON results WHEN NEW.candidate='ollama/one' BEGIN SELECT RAISE(ABORT,'synthetic checkpoint fault'); END");
        options[0].onText?.("triggers storage failure");
      }
      await aborted.opened;
      assert.equal(job.controller.signal.aborted,termination==="operator cancel");
      assert.equal(bench.active,job);
      assert.throws(()=>start(),/active/);
      assert.equal(measurements[0].closed,false);
    } finally {drain.release();await done;}
    assert.equal(options.length,2);
    assert.equal(bench.active,null);
    const detail=bench.detail(id);
    assert.equal(detail.status,termination==="operator cancel"?"canceled":"failed");
    assert.equal(detail.assessments.length,0);
    assert.equal(detail.results.length,2);
    assert.ok(detail.results.every(r=>r.caseId==="a" && r.dispatchState===(termination==="operator cancel"?"canceled":"interrupted")));
    assert.equal(detail.results.find(r=>r.candidateId===modelIds[1])?.output,"observed sibling fragment");
    assert.equal(measurements[0].closed,true);
    if(termination==="checkpoint failure")assert.match(present(detail.manifest.error),/persist a case checkpoint/);
  });
}
test("aggregate whole-device sampler integrates real readings without retaining the run's sample series",async()=>{
  const finish=await startPower(async()=>({watts:12}),1000,"aggregate");
  await new Promise(resolve=>setTimeout(resolve,10));
  const summary=await finish();
  assert.equal(summary.samples.length,0);
  assert.equal(summary.sampleCount,2);
  assert.equal(summary.peak_w,12);
  assert.ok(Math.abs(present(summary.average_w)-12)<1e-6);
  assert.ok(Math.abs(present(summary.estimated_energy_j)-12*summary.sampled_seconds)<1e-6);
});

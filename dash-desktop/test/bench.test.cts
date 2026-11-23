import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Bench, replayCandidate } from "../lib/bench.cjs";
import { loadPacks, parseDataset, grade } from "../lib/packs.cjs";
import { invoke } from "../lib/providers.cjs";
import { performance as runPerformance } from "../lib/performance.cjs";
import { objectValue, jsonText, isRecord, type RunResult, type StartRun } from "../lib/run-types.cjs";
import type { ChatTurn, LocalCandidate } from "../lib/runtime-types.cjs";
import { inventory, reply, withoutPower, present } from "./runtime-fixtures.cjs";

function latch() {
  let signal:()=>void=()=>{throw Error("Signal not initialized")};
  const promise=new Promise<void>(done=>{signal=done});
  return {signal,promise};
}
function completion(b:Bench):Promise<void> {
  assert.ok(b.active?.done,"The runner started a job");
  return b.active.done;
}
function scoreOf(result:RunResult) {return present(result.score);}
function earnings() {
  const bundle=loadPacks().find(item=>item.pack.id==="earnings");
  assert.ok(bundle);
  return bundle;
}
const fixture = (d:{id:string}):StartRun => ({
  mode: "dataset",
  datasetId: d.id,
  candidateIds: [replayCandidate.id],
});
async function finish(b:Bench, config:StartRun) {
  const id = b.start(config);
  await completion(b);
  return b.exportRun(id);
}
test("bundled packs score the recorded responses, preserve trace identities and survive a restart", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "runs.db");
  let b = new Bench(file);
  const ids:string[] = [];
  for (const d of b.list().datasets) {
    const run = await finish(b, fixture(d));
    assert.equal(run.status, "completed");
    assert.equal(run.results.length, d.count);
    assert.equal(run.results.filter((r) => scoreOf(r).falseAccept).length, 1);
    assert.equal(run.results.filter((r) => scoreOf(r).pass).length, d.count - 1);
    for (const r of run.results) {
      assert.equal(r.trace.caseId, r.caseId);
      assert.equal(r.trace.runId, run.manifest.id);
      assert.equal(r.trace.candidateId, r.candidateId);
      assert.equal(r.telemetry, null);
    }
    ids.push(run.manifest.id);
    const failure = run.results.find((r) => !scoreOf(r).pass);
    assert.ok(failure);
    const rerun = await finish(b, {
      ...fixture(d),
      parentId: run.manifest.id,
      caseId: failure.caseId,
    });
    assert.notEqual(rerun.manifest.id, run.manifest.id);
    assert.equal(rerun.results.length, 1);
    assert.equal(rerun.manifest.parentId, run.manifest.id);
  }
  b.db.close();
  b = new Bench(file);
  assert.equal(b.list().runs.length, ids.length * 2);
  assert.ok(ids.every((id) => b.exportRun(id).cases.length > 1));
  b.db.close();
});
test("model boundary excludes reference labels and distinguishes runtime failure from wrong answers", async () => {
  const c:LocalCandidate = {
    id: "test/local",
    model: "lfm3-local",
    provider: "lmstudio",
    loaded: true,
    kind: "model",
    revision: "v1",
  };
  let calls = 0;
  const b = new Bench(":memory:", {
    discover: async () => [inventory([c])],
    invoke: async (candidate, messages, options) => {
      assert.equal(candidate.id, c.id);
      assert.equal(messages.length, 2);
      const fields=options.structured?.properties;
      if (isRecord(fields) && fields.requirements)
        return reply(JSON.stringify({title:"Extract earnings",metrics:["Correct values"],requirements:["Ground answers in the case"]}));
      if (isRecord(fields) && fields.prompt)
        return reply(JSON.stringify({prompt:"Use the provided earnings release."}));
      const payload = objectValue(jsonText(messages[1].content));
      assert.deepEqual(Object.keys(payload).sort(), [
        "input",
        "source_locator",
      ]);
      assert.ok(isRecord(payload.input));
      assert.equal("gold" in payload.input, false);
      if (++calls === 2) throw Error("test provider offline");
      assert.ok(options.onText);
      options.onText("invalid");
      return reply("invalid",{latency_ms:7});
    },
  });
  await b.refresh();
  const d = b.list().datasets[0];
  const draft = await b.designPrompt({mode:"dataset", datasetId:d.id, objective:"Extract the disclosed EPS."});
  const approved = b.workflow.approve({draftId:draft.draftId, prompt:draft.prompt});
  const run = await finish(b, {
      approvedPromptId: approved.id,
      mode: "dataset",
      datasetId: d.id,
      candidateIds: [c.id],
    });
  assert.equal(run.status, "failed");
  assert.equal(run.results.length, 8);
  assert.equal(scoreOf(run.results[0]).review, true);
  assert.equal(run.results[1].score, null);
  assert.equal(run.results[1].error, "test provider offline");
  b.db.close();
});
test("cancellation preserves the run and stops work", async () => {
  const b = new Bench(":memory:"),
    d = b.list().datasets[0],
    id = b.start(fixture(d));
  assert.throws(() => b.start(fixture(d)), /active/);
  b.stop(id);
  await completion(b);
  assert.equal(b.detail(id).status, "canceled");
  assert.equal(b.detail(id).results.length, 0);
  b.db.close();
});
test("dataset imports reject duplicates, report line numbers and preserve snapshots", () => {
  const { pack, rows, replay } = earnings();
  const line = JSON.stringify(rows[0]);
  assert.throws(
    () => parseDataset(line + "\n" + line, pack),
    /Line 2:.*duplicate/,
  );
  assert.throws(() => parseDataset('{"input":', pack), /Line 1/);
  const zero = rows.find((r) => r.case_id === "eps-zero");
  assert.ok(zero);
  assert.ok(
    grade(
      pack,
      zero,
      JSON.stringify({ ...objectValue(replay["eps-zero"]), value: "-0.000" }),
    ).pass,
  );
  const absent = rows.find((r) => r.case_id === "eps-absent");
  assert.ok(absent);
  assert.equal(
    grade(
      pack,
      absent,
      JSON.stringify({ ...objectValue(replay["eps-absent"]), value: "0.00" }),
    ).pass,
    false,
  );
  const b = new Bench(":memory:"),
    key = b.import(pack.id, "mini", line);
  assert.equal(b.import(pack.id, "mini", line), key);
  assert.notEqual(
    b.import(
      pack.id,
      "mini",
      JSON.stringify({ ...rows[0], case_id: "another" }),
    ),
    key,
  );
  assert.throws(() => b.start(fixture({ id: key })), /bundled dataset/);
  b.db.close();
});
test("both streaming adapters send identical prompt content, reconstruct text and retain usage", async (t) => {
  const messages:ChatTurn[] = [{ role: "user", content: "Short test" }];
  for (const provider of ["ollama", "lmstudio"] as const) {
    const stream =
      provider === "ollama"
        ? [
            '{"message":{"content":"Hi"}}',
            '{"message":{"content":"!"},"done":true,"prompt_eval_count":4,"eval_count":2}',
          ]
        : [
            'data: {"choices":[{"delta":{"content":"Hi"}}]}',
            "",
            'data: {"choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":4,"completion_tokens":2}}',
            "",
            "data: [DONE]",
          ];
    const mock = t.mock.method(globalThis, "fetch", async (url:RequestInfo|URL, options?:RequestInit) => {
      assert.ok(typeof url==="string");
      assert.ok(url.startsWith("http://127.0.0.1:"));
      assert.deepEqual(objectValue(jsonText(options?.body)).messages, messages);
      return new Response(stream.join("\n") + "\n");
    });
    const result = await invoke({ provider, model: "test",kind:"model",id:provider+"/test" }, messages, {
      signal: new AbortController().signal,
    });
    assert.equal(result.output, "Hi!");
    assert.equal(result.telemetry.input_tokens, 4);
    assert.equal(result.telemetry.output_tokens, 2);
    mock.mock.restore();
  }
});

test("duplicate JSON keys cannot silently replace a conflicting financial fact", () => {
  const { pack, rows, replay } = earnings();
  const correct = JSON.stringify(replay["rev-scale"]);
  const ambiguous = correct.replace("{", '{"value":"999",');
  const score = grade(pack, rows[0], ambiguous);
  assert.equal(score.falseAccept, true);
  assert.ok(score.reasons.includes("Duplicate output key: value"));
  assert.equal(grade(pack, rows[0], correct).pass, true);
});

test("stop retains every observed fragment; reopening an in-flight checkpoint preserves only confirmed evidence", async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"dash-interruption-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const candidate:LocalCandidate={id:"ollama/qa",model:"qa",provider:"ollama",loaded:true,kind:"model"};
  const first="First fragment.";
  const dispatched=latch();
  let observed:ChatTurn[]|undefined;
  let calls=0;
  const bench=new Bench(":memory:",{
    discover:async()=>[inventory([candidate])],
    invoke:async(_candidate,messages,{signal,onText})=>{
      calls++;
      observed=messages;
      assert.ok(onText);
      onText(first);
      onText(first+" Second fragment.");
      dispatched.signal();
      return new Promise<never>((_,reject)=>signal.addEventListener("abort",()=>reject(Error("stopped")),{once:true}));
    }
  },withoutPower);
  t.after(()=>bench.db.close());
  await bench.refresh();
  const rows=["first","second"].map(case_id=>({case_id,dataset_version:"1",split:"development",prompt:"Name a color.",reference:"blue"}));
  const datasetId=bench.import("reference","Interrupted QA",rows.map(x=>JSON.stringify(x)).join("\n"));
  const id=bench.start({mode:"dataset",datasetId,candidateIds:[candidate.id],datasetScorer:"exact-reference"});
  const done=completion(bench);
  await dispatched.promise;
  assert.equal(bench.detail(id).results.length,0);
  const image=path.join(dir,"checkpoint.sqlite");
  bench.db.prepare("VACUUM INTO ?").run(image);
  bench.stop(id);
  await done;
  const saved=bench.exportRun(id), canceled=saved.results[0];
  assert.equal(calls,1);
  assert.equal(saved.status,"canceled");
  assert.equal(saved.results.length,1);
  assert.equal(canceled.dispatchState,"canceled");
  assert.equal(canceled.output,first+" Second fragment.");
  assert.deepEqual(canceled.dispatchedMessages,observed);
  assert.equal(canceled.trace.finished,undefined);
  assert.equal(canceled.score,null);
  assert.ok(saved.report);
  assert.equal(saved.report.verdict,"incomplete");
  assert.equal(saved.assessments.length,0);
  assert.ok(canceled.trace.steps.find(s=>s.action==="DASH stopped observing this request"));
  assert.equal(runPerformance(bench.db,id).candidates[0].errors,0);

  const recovery=new Bench(image,{discover:async()=>[],invoke:()=>assert.fail("must not dispatch an interrupted request")});
  const reopened=recovery.exportRun(id);
  recovery.db.close();
  assert.equal(reopened.status,"interrupted");
  assert.equal(reopened.results.length,1);
  const interrupted=reopened.results[0];
  assert.equal(interrupted.dispatchState,"interrupted");
  assert.deepEqual(interrupted.dispatchedMessages,observed);
  // Wall-clock scheduling can produce a second valid checkpoint before the snapshot.
  assert.ok([first,canceled.output].includes(present(interrupted.output)));
  assert.equal(interrupted.trace.finished,undefined);
  assert.equal(interrupted.trace.id,canceled.trace.id);
  assert.equal(interrupted.score,null);
  assert.equal(interrupted.telemetry,null);
  assert.equal(reopened.assessments.length,0);
  assert.ok(reopened.report);
  assert.equal(reopened.report.verdict,"incomplete");
  const again=new Bench(image);
  t.after(()=>again.db.close());
  assert.deepEqual(again.exportRun(id).results,reopened.results);
});

test("stopping during the initial sensor read records no candidate dispatch", async t => {
  const started=latch(),finishSample=latch();
  const candidate:LocalCandidate={id:"ollama/qa",model:"qa",provider:"ollama",loaded:true,kind:"model"};
  const bench=new Bench(":memory:",{discover:async()=>[inventory([candidate])],invoke:()=>assert.fail("canceled before dispatch")},async()=>{
    started.signal();
    await finishSample.promise;
    return withoutPower();
  });
  t.after(()=>bench.db.close());
  await bench.refresh();
  const id=bench.start({mode:"dataset",datasetId:bench.list().datasets[0].id,candidateIds:[candidate.id]});
  const done=completion(bench);
  await started.promise;
  bench.stop(id);
  finishSample.signal();
  await done;
  const saved=bench.exportRun(id);
  assert.equal(saved.status,"canceled");
  assert.equal(saved.results.length,0);
});

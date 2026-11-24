import { test } from "node:test";
import assert from "node:assert/strict";
import { Bench } from "../lib/bench.cjs";
import { configuration } from "../lib/opik-experiments.cjs";
import { PlanningRoute } from "../lib/planner-routing.cjs";
import { invoke } from "../lib/providers.cjs";
import { ProviderPreflightError, ProviderRejectedError, type CompatibleCandidate, type LocalCandidate } from "../lib/runtime-types.cjs";
import { inventory, present, reply, withoutPower } from "./runtime-fixtures.cjs";

const hosted:CompatibleCandidate={provider:"compatible",kind:"model",id:"compatible/example",model:"example",
  endpoint:"https://model.example.invalid/v1",section:"Hosted",keyRequired:true};
const ollama:LocalCandidate={provider:"ollama",kind:"model",id:"ollama/example",model:"example"};
const prompt=[{role:"user",content:"Return ready."}] as const;
const marker="SYNTHETIC_PROVIDER_DIAGNOSTIC";
const options=()=>({signal:AbortSignal.timeout(2_000),apiKey:"test-only"});

function heldResponse(parts:(Uint8Array|string)[],status=200) {
  let cancellations=0;
  let close=()=>{};
  const response=new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(typeof part==="string" ? new TextEncoder().encode(part) : part);
      close=()=>controller.close();
    },
    cancel() { cancellations++; },
  }),{status});
  // Bound failures even if a regression waits for EOF instead of releasing the stream.
  const deadline=setTimeout(()=>{if (!cancellations) close();},1_000);
  return {response,canceled:()=>cancellations,dispose:()=>clearTimeout(deadline)};
}

test("compatible completion consumes usage before DONE and releases an open stream",async t=>{
  const held=heldResponse(['data: {"choices":[{"delta":{"con','tent":"ready"}}]}\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\ndata: {"usage":{"prompt_tokens":6}}\ndata: {"usage":{"completion_tokens":1}}\n',
    'data: [DONE]\ndata: invalid extra frame\n']);
  t.after(held.dispose);
  t.mock.method(globalThis,"fetch",async()=>held.response);
  const result=await invoke(hosted,[...prompt],options());
  assert.equal(result.output,"ready");
  assert.equal(result.finishReason,"stop");
  assert.equal(result.telemetry.input_tokens,6);
  assert.equal(result.telemetry.output_tokens,1);
  assert.equal(held.canceled(),1);
});

test("Ollama retains the final text and usage and releases a still-open response",async t=>{
  const held=heldResponse(['{"message":{"content":"read"},"done":false}\n',
    '{"message":{"content":"y"},"done":true,"done_reason":"stop","eval_count":2,"prompt_eval_count":6}\n']);
  t.after(held.dispose);
  t.mock.method(globalThis,"fetch",async()=>held.response);
  const result=await invoke(ollama,[...prompt],options());
  assert.equal(result.output,"ready");
  assert.equal(result.telemetry.output_tokens,2);
  assert.equal(held.canceled(),1);
});

test("hosted rejections cancel error bodies and distinguish definitive from uncertain status",async t=>{
  for (const status of [401,429,408,503]) {
    const held=heldResponse([marker],status);
    t.after(held.dispose);
    const stub=t.mock.method(globalThis,"fetch",async()=>held.response);
    await assert.rejects(invoke(hosted,[...prompt],options()),(error:unknown)=>{
      assert.ok(error instanceof Error);
      assert.equal(error.message,"Model endpoint returned HTTP "+status);
      assert.equal(error instanceof ProviderRejectedError,status===401 || status===429);
      return true;
    });
    assert.equal(held.canceled(),1);
    stub.mock.restore();
  }
});

test("stream error frames and malformed JSON release readers and keep provider diagnostics private",async t=>{
  for (const frame of [JSON.stringify({error:{message:marker}}),marker]) {
    const held=heldResponse(["data: "+frame+"\n"]);
    t.after(held.dispose);
    const stub=t.mock.method(globalThis,"fetch",async()=>held.response);
    await assert.rejects(invoke(hosted,[...prompt],options()),(error:unknown)=>{
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message,new RegExp(marker));
      assert.equal(error instanceof ProviderRejectedError,false);
      return true;
    });
    assert.equal(held.canceled(),1);
    stub.mock.restore();
  }
});

test("hosted planning bounds successful envelopes and releases rejected response bodies",async t=>{
  for (const held of [heldResponse([new Uint8Array(256_001)]),heldResponse([marker],403)]) {
    t.after(held.dispose);
    const route=await PlanningRoute.start({discover:async()=>[],invoke:async()=>assert.fail("Unexpected local model")},
      {openaiFallback:()=>({model:"synthetic",apiKey:"test-only"}),fetch:async()=>held.response},
      AbortSignal.timeout(2_000),()=>{});
    await assert.rejects(route.ask("Synthetic objective","Return JSON",{}, {type:"object"},64,v=>v),/could not finish/);
    assert.equal(route.attempts.length,1);
    assert.doesNotMatch(JSON.stringify(route.attempts),new RegExp(marker));
    assert.equal(held.canceled(),1);
  }
});

test("Opik requires HTTPS off loopback for both API and dashboard URLs",()=>{
  for (const url of ["https://opik.example.invalid/api","http://localhost:5173/api","http://127.0.0.1/api","http://[::1]/api"])
    assert.equal(configuration({DASH_OPIK_API_URL:url}).configured,true,url);
  for (const url of ["http://opik.example.invalid/api","http://localhost.example.invalid/api","http://10.0.0.2/api"]) {
    assert.equal(configuration({DASH_OPIK_API_URL:url,OPIK_API_KEY:"test-only"}).configured,false,url);
    assert.equal(configuration({DASH_OPIK_API_URL:"https://opik.example.invalid/api",DASH_OPIK_UI_URL:url}).configured,false,url);
  }
});

test("a recorded hosted-provider error stays private in exported results and scored report reasons",async t=>{
  const b=new Bench(":memory:",{discover:async()=>[],invoke:async()=>reply("ready")},withoutPower);
  t.after(()=>b.db.close());
  const candidate=b.endpoints.save({section:"Hosted",model:"example",baseUrl:hosted.endpoint,key:"test-only"});
  const datasetId=b.import("reference","Synthetic status",JSON.stringify({case_id:"qa",dataset_version:"1",split:"development",prompt:"Return ready.",reference:"ready"}));
  const id=b.start({mode:"dataset",datasetId,candidateIds:[candidate],datasetScorer:"exact-reference"});
  await present(b.active).done;
  b.db.prepare("UPDATE results SET record=json_set(record,'$.error',?,'$.score',NULL) WHERE run=?").run(marker,id);
  assert.equal(b.detail(id).results[0].error,marker,"Existing local records remain intact");
  const exported=b.exportRun(id);
  assert.doesNotMatch(JSON.stringify(exported),new RegExp(marker));
  assert.equal(exported.results[0].output,"ready");
  assert.equal(exported.cases[0].reference,"ready");
});

test("an uncertain planning dispatch never repeats locally or switches to a hosted model",async()=>{
  const candidate:LocalCandidate={...ollama,model:"lfm3-1.7b",loaded:true};
  for (const failure of [new Error(marker),new DOMException(marker,"TimeoutError")]) {
    let posts=0;
    const route=await PlanningRoute.start({discover:async()=>[inventory([candidate])],
      invoke:async()=>{ posts++; throw failure; }},{openaiFallback:()=>assert.fail("Unknown dispatch must stop before checking the hosted route")},
      new AbortController().signal,()=>{});
    await assert.rejects(route.ask("Financial expert","Return JSON",{}, {},64,v=>v),(error:unknown)=>{
      assert.ok(error instanceof Error);
      assert.match(error.message,/Completion was unconfirmed/);
      if(failure.name==="TimeoutError") assert.match(error.message,/timed out/);
      assert.doesNotMatch(error.message,new RegExp(marker));
      return true;
    });
    assert.equal(posts,1);
    assert.equal(route.attempts.length,1);
    assert.equal(route.attempts[0].status,"failed");
  }
});

test("a known local preflight failure or rejection can use the explicitly configured fallback once",async()=>{
  const candidate:LocalCandidate={...ollama,model:"lfm3-1.7b",loaded:true};
  for(const error of [new ProviderPreflightError("The model is unloaded."),new ProviderRejectedError("Ollama returned HTTP 429.")]){
    let local=0,hosted=0;
    const route=await PlanningRoute.start({discover:async()=>[inventory([candidate])],
      invoke:async()=>{local++;throw error;}},{openaiFallback:()=>({apiKey:"synthetic",model:"example"}),
      fetch:async()=>{hosted++;return Response.json({choices:[{message:{content:'{"ready": true}'},finish_reason:"stop"}]});}},
      new AbortController().signal,()=>{});
    assert.equal(await route.ask("grader design","Return JSON",{}, {},64,v=>v.ready),true);
    assert.equal(local,1);assert.equal(hosted,1);
    assert.equal(route.attempts[1].fallbackReason,error.message);
  }
});

test("an overall planning time limit reports timeout even when the shared signal aborts",async()=>{
  const candidate:LocalCandidate={...ollama,model:"lfm3-1.7b",loaded:true};
  const controller=new AbortController();
  const route=await PlanningRoute.start({discover:async()=>[inventory([candidate])],invoke:async()=>{
    controller.abort(new DOMException(marker,"TimeoutError"));controller.signal.throwIfAborted();
    return reply("");
  }},{openaiFallback:()=>assert.fail("Time limit must stop fallback")},controller.signal,()=>{});
  await assert.rejects(route.ask("Metric audit","Return JSON",{}, {},64,v=>v),/Metric audit timed out/);
  assert.equal(route.attempts[0].status,"failed");
  assert.match(route.attempts[0].reason??"",/timed out/);
});

test("connection and interrupted-body errors retain the dispatch count and keep private diagnostics out of history",async t=>{
  for (const started of [false,true]) {
    const stub=t.mock.method(globalThis,"fetch",async()=>{
      if(!started) throw Error(marker);
      return new Response(new ReadableStream<Uint8Array>({start(controller){controller.error(Error(marker));}}));
    });
    await assert.rejects(invoke(hosted,[...prompt],options()),(error:unknown)=>{
      assert.ok(error instanceof Error);
      assert.match(error.message,started?/disconnected/:/connection failed/);
      assert.doesNotMatch(error.message,new RegExp(marker));
      assert.equal(error instanceof ProviderRejectedError,false);
      return true;
    });
    assert.equal(stub.mock.callCount(),1);
    stub.mock.restore();
  }
});

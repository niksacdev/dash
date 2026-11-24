import test from "node:test";
import loadTransport = require("../lib/lmstudio-load.cjs");
import assert from "node:assert/strict";
import {Bench} from "../lib/bench.cjs";
import {designGraderPlan} from "../lib/grader-designer.cjs";
import {discover,loadLocalModel} from "../lib/providers.cjs";
import {PlanningRoute,selectLocalPlanner} from "../lib/planner-routing.cjs";
import {inventory,reply,withoutPower,present} from "./runtime-fixtures.cjs";
import type {LocalCandidate,ModelLoadReceipt,RuntimeInventory} from "../lib/runtime-types.cjs";

const key="liquid/lfm3-1.7b";
const alias="desk-planner";
const local="http://127.0.0.1:1234";
const catalog=local+"/api/v1/models";
const llm=(loaded=false)=>({type:"llm",key,loaded_instances:loaded?[{id:alias,config:{context_length:2048}}]:[]});
function address(value:Parameters<typeof fetch>[0]) {return value instanceof Request ? value.url : String(value);}

test("LM Studio lists native-only downloads and a planner's real active alias, excluding non-chat models",async t=>{
  let loaded=false;
  t.mock.method(globalThis,"fetch",async (input:Parameters<typeof fetch>[0])=>{
    const url=address(input);
    if (url===catalog) return Response.json({models:[llm(loaded),{type:"embedding",key:"embed",loaded_instances:[]},
      {type:"decision",key:"decision",loaded_instances:[]}]});
    if (url===local+"/v1/models") return Response.json({data:[{id:"embed"},{id:"decision"}]});
    assert.equal(url,"http://127.0.0.1:11434/api/tags");
    return Response.json({models:[]});
  });
  let servers=await discover();
  assert.deepEqual(servers.flatMap(s=>s.models).map(m=>[m.model,m.nativeKey,m.loaded]),[[key,key,false]]);
  assert.equal(selectLocalPlanner(servers),undefined);
  loaded=true;
  servers=await discover();
  const picked=selectLocalPlanner(servers);
  assert.equal(picked?.model,alias);
  assert.equal(picked?.nativeKey,key);
  assert.equal(picked?.contextTokens,2048);
});

test("the explicit load coalesces duplicate clicks, uses the canonical key, and verifies the actual instance",async t=>{
  let loads=0,reads=0,loaded=false;
  t.mock.method(loadTransport,"loadSdkModel",async(modelKey:string)=>{
    assert.equal(modelKey,key);
    loads++;loaded=true;
    return {modelKey:key,identifier:key};
  });
  t.mock.method(globalThis,"fetch",async (input:Parameters<typeof fetch>[0],options?:RequestInit)=>{
    assert.equal(address(input),catalog);assert.equal(options?.redirect,"error");assert.equal(options?.method,undefined);
    reads++;return Response.json({models:[{...llm(),loaded_instances:loaded?[{id:key}]:[]}]});
  });
  const a=loadLocalModel(key),b=loadLocalModel(key);
  assert.equal(a,b);
  await assert.rejects(loadLocalModel("other"),/current LM Studio load/);
  assert.deepEqual(await a,{status:"loaded",instanceId:key});
  assert.deepEqual(await loadLocalModel(key),{status:"already-loaded",instanceId:key});
  assert.equal(loads,1);assert.equal(reads,3);
});

test("only a downloaded, unique native LLM key with known load state authorizes an SDK load",async t=>{
  const invocation=t.mock.method(loadTransport,"loadSdkModel",()=>assert.fail("Unexpected SDK load"));
  let rows:unknown[]=[];
  const transport=t.mock.method(globalThis,"fetch",async (input:Parameters<typeof fetch>[0],options?:RequestInit)=>{
    assert.equal(address(input),catalog);assert.notEqual(options?.method,"POST");return Response.json({models:rows});
  });
  for (const invalid of ["https://example.invalid/model","../name","/tmp/foo","", "vendor/model\n"]) {
    await assert.rejects(loadLocalModel(invalid),/Invalid local model key/);
  }
  assert.equal(transport.mock.callCount(),0);
  for (rows of [[],[llm(),llm()],[{...llm(),type:"embedding"}],[{...llm(),type:"decision"}],
      [{...llm(),type:undefined}],[{type:"llm",key}],[{...llm(),key:"different",loaded_instances:[{id:key}]}]]) {
    await assert.rejects(loadLocalModel(key));
  }
  rows=[llm(),{...llm(),key:"another/model",loaded_instances:[{id:key}]}];
  await assert.rejects(loadLocalModel(key),/using this instance name/);
  assert.equal(transport.mock.callCount(),8);assert.equal(invocation.mock.callCount(),0);
});

test("native cloud keys and remote metadata are excluded from the roster and cannot authorize a local load",async t=>{
  const rows=[
    {...llm(),key:"publisher/planner:cloud"},
    {...llm(),key:"publisher/hosted-planner",remote_host:"fixture.invalid"},
    {...llm(),key:"publisher/linked-planner",remote_model:"remote-id",loaded_instances:[{id:"ordinary-alias"}]},
    {...llm(),key:"publisher/plain",loaded_instances:[{id:"alias-cloud"}]},
  ];
  const invocation=t.mock.method(loadTransport,"loadSdkModel",()=>assert.fail("Unexpected SDK load"));
  t.mock.method(globalThis,"fetch",async(input:Parameters<typeof fetch>[0],options?:RequestInit)=>{
    assert.notEqual(options?.method,"POST");
    const url=address(input);
    if(url===catalog) return Response.json({models:rows});
    if(url===local+"/v1/models") return Response.json({data:[{id:"ordinary-alias"}]});
    assert.equal(url,"http://127.0.0.1:11434/api/tags");
    return Response.json({models:[]});
  });
  const server=(await discover()).find(s=>s.provider==="lmstudio");
  assert.equal(server?.online,true);
  assert.deepEqual(server.models,[]);
  assert.deepEqual(server.instances,[]);
  for (const row of rows) await assert.rejects(loadLocalModel(row.key),/downloaded chat model/);
  assert.equal(invocation.mock.callCount(),0);
});

test("a lost SDK acknowledgement or mismatched handle only triggers read-only confirmation",async t=>{
  let reads=0,loads=0,settled=false,mode:"disconnect"|"wrong-instance"|"wrong-key"="disconnect";
  t.mock.method(globalThis,"fetch",async(input:Parameters<typeof fetch>[0])=>{
    assert.equal(address(input),catalog);reads++;
    return Response.json({models:[llm(reads%2===0 && settled)]});
  });
  t.mock.method(loadTransport,"loadSdkModel",async()=>{
    loads++;
    if(mode==="wrong-instance")return {modelKey:key,identifier:"another-instance"};
    if(mode==="wrong-key")return {modelKey:"another-model",identifier:alias};
    throw Error("private provider message");
  });
  assert.deepEqual(await loadLocalModel(key),{status:"unconfirmed"});
  settled=true;
  assert.deepEqual(await loadLocalModel(key),{status:"loaded",instanceId:alias});
  mode="wrong-instance";
  assert.deepEqual(await loadLocalModel(key),{status:"unconfirmed"});
  mode="wrong-key";
  assert.deepEqual(await loadLocalModel(key),{status:"unconfirmed"});
  assert.equal(reads,8);assert.equal(loads,4);
});

test("a loaded local planner's invalid output and transport failure each have their own recovery",async()=>{
  const model:LocalCandidate={kind:"model",provider:"lmstudio",id:"lmstudio/desk",model:alias,nativeKey:key,loaded:true};
  for (const invalid of [true,false]) {
    let calls=0;
    const route=await PlanningRoute.start({discover:async()=>[inventory([model])],invoke:async(candidate)=>{
      calls++;
      assert.equal(candidate.model,alias);
      if (!invalid) throw Error("private transport details");
      return reply("{missing brace");
    }},{},new AbortController().signal,()=>{});
    await assert.rejects(route.ask("Financial expert","Inspect the case",{}, {type:"object"},32,v=>v),(error:unknown)=>{
      assert(error instanceof Error);
      assert.match(error.message,invalid?/LM Studio responded.*failed validation/:/loaded when preparation started/);
      assert.doesNotMatch(error.message,/Load an LFM3|private transport details/);
      return true;
    });
    assert.equal(calls,invalid?2:1);
  }
});

function gate<T>() {
  let resolve:(value:T)=>void=()=>assert.fail("Gate not initialized");
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}
const candidate:LocalCandidate={kind:"model",id:"ollama/synthetic",provider:"ollama",model:"synthetic",loaded:true};
const objective="Check the synthetic lot against its inspection record.";

test("an active evaluation cannot be disrupted by a new explicit load",async t=>{
  let loads=0;
  const bench=new Bench(":memory:",{discover:async()=>[inventory([candidate])],invoke:async()=>reply("{}"),
    loadLocalModel:async()=>{loads++;return {status:"unconfirmed"};}},withoutPower);
  t.after(()=>bench.db.close());
  await bench.refresh();
  const dataset=present(bench.list().datasets.find(d=>d.pack==="manufacturing"));
  const job=bench.start({mode:"dataset",candidateIds:[candidate.id],datasetId:dataset.id,caseId:bench.dataset(dataset.id).rows[0].case_id});
  const done=present(bench.active?.done);
  await assert.rejects(bench.loadLocalModel(key),/active evaluation/);
  assert.equal(loads,0);
  await done;
  assert.equal(bench.detail(job).status,"completed");
  await bench.loadLocalModel(key);
  assert.equal(loads,1);
});

test("a load reserves the runtime through confirmation and inventory refresh, including duplicate IPC requests",async t=>{
  const loading=gate<ModelLoadReceipt>(), refreshing=gate<void>(), roster=gate<RuntimeInventory[]>();
  let loads=0;
  const bench=new Bench(":memory:",{discover:async()=>{refreshing.resolve();return roster.promise;},invoke:async()=>assert.fail("unexpected inference"),
    loadLocalModel:async()=>{loads++;return loading.promise;}});
  t.after(()=>bench.db.close());
  const task=bench.loadLocalModel(key);
  const blocked=async()=>{
    assert.equal(bench.modelLoading,true);
    assert.equal(bench.loadLocalModel(key),task);
    await assert.rejects(bench.loadLocalModel("another/model"),/current LM Studio load/);
    assert.throws(()=>bench.start({mode:"dataset",candidateIds:[candidate.id]}),/load to finish before starting a run/);
    await assert.rejects(bench.designPrompt({mode:"quick",objective}),/load to finish before preparing a prompt/);
    await assert.rejects(bench.designPrompt({mode:"quick",objective},undefined,"suggest"),/load to finish/);
    await assert.rejects(designGraderPlan(bench,{objective}),/load to finish before designing graders/);
    await assert.rejects(bench.withRuntimeUse(async()=>assert.fail("unexpected runtime access")),/load to finish/);
    assert.equal(bench.list().runs.length,0);
  };
  await blocked();
  loading.resolve({status:"loaded",instanceId:alias});
  await refreshing.promise;
  await blocked();
  roster.resolve([inventory([candidate])]);
  assert.deepEqual(await task,{status:"loaded",instanceId:alias});
  assert.equal(loads,1);
  assert.equal(bench.modelLoading,false);
  assert.deepEqual(bench.servers,[inventory([candidate])]);
});

test("active prompt preparation, grader design and standalone runtime requests exclude loads until they settle",async t=>{
  for (const operation of ["prompt","graders","other"] as const) {
    const hold=gate<void>();
    let loads=0;
    const bench=new Bench(":memory:",{discover:async()=>{await hold.promise;return [];},invoke:async()=>assert.fail("unexpected inference"),
      loadLocalModel:async()=>{loads++;return {status:"unconfirmed"};}});
    t.after(()=>bench.db.close());
    const task=operation==="prompt" ? bench.designPrompt({mode:"quick",objective}) :
      operation==="graders" ? designGraderPlan(bench,{objective}) : bench.withRuntimeUse(()=>hold.promise);
    await assert.rejects(bench.loadLocalModel(key),/planning or runtime request/);
    assert.equal(loads,0);
    hold.resolve();
    if (operation==="other") await task;
    else await assert.rejects(task,/Load an LFM3/);
    assert.deepEqual(await bench.loadLocalModel(key),{status:"unconfirmed"});
    assert.equal(loads,1);
  }
});

test("a stale background refresh cannot replace the inventory confirmed after a model load",async t=>{
  const older=gate<RuntimeInventory[]>(), started=gate<void>();
  const latest=[inventory([candidate])];
  let calls=0;
  const bench=new Bench(":memory:",{discover:async()=>{if(++calls===1){started.resolve();return older.promise;}return latest;},
    invoke:async()=>assert.fail("unexpected inference"),loadLocalModel:async()=>({status:"loaded",instanceId:alias})});
  t.after(()=>bench.db.close());
  const first=bench.refresh();
  await started.promise;
  await bench.loadLocalModel(key);
  older.resolve([]);
  assert.deepEqual(await first,latest);
  assert.deepEqual(bench.servers,latest);
});

test("load and discovery failures release the reservation and retain the original failure",async t=>{
  let attempts=0;
  const bench=new Bench(":memory:",{discover:async()=>{throw Error("roster offline");},invoke:async()=>assert.fail("unexpected inference"),
    loadLocalModel:async()=>{if(++attempts===1)throw Error("load rejected");return {status:"already-loaded",instanceId:alias};}});
  t.after(()=>bench.db.close());
  bench.servers=[inventory([candidate])];
  await assert.rejects(bench.loadLocalModel(key),/load rejected/);
  assert.equal(bench.modelLoading,false);
  assert.deepEqual(bench.servers,[]);
  assert.deepEqual(await bench.loadLocalModel(key),{status:"already-loaded",instanceId:alias});
  assert.equal(bench.modelLoading,false);
});

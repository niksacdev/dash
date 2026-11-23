import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {z} from "opik";
import {Graders,opikVersion, type GraderDefinition, type GraderEvidence} from "../lib/graders.cjs";
import type {RuntimeAdapters} from "../lib/runtime-types.cjs";
import type {ApprovedPrompt} from "../lib/outcome-workflow.cjs";

const localId="example/decision-v1";
const definition:GraderDefinition={
  name:"Incoming inspection", category:"Conformity", industry:"Manufacturing",
  type:"decision", criteria:"Does the disposition follow the drawing limits?",threshold:0.8,
  decision:{provider:"local",model:localId,endpoint:"http://127.0.0.1:8080",failAt:0.2},
};
const evidence:GraderEvidence={
  input:"Inspect the 12 mm sample against the stated upper limit of 10 mm.",reference:"Hold the sample.",
  output:"Hold the sample. Its measured dimension exceeds the limit.",inputSource:"recorded-dispatch",
};
const approved:ApprovedPrompt={
  id:"p",familyId:"family",version:1,mode:"quick",domain:"Manufacturing",title:"Incoming inspection",
  objective:"Check the incoming inspection disposition.",metrics:["Correct disposition"],requirements:[],
  prompt:"Read the supplied drawing.",datasetId:null,packId:null,contractHash:null,inputCap:null,outputCap:null,designer:null,
};
const offline:RuntimeAdapters={discover:async()=>[],invoke:async()=>assert.fail("The decision grader must use the native adapter.")};
const signal = () => new AbortController().signal;
const postBody=z.object({model:z.string(),state:z.string()});

test("decision grader model changes create immutable revisions that can be reopened and selected without a chat inventory",t=>{
  const dir=mkdtempSync(join(tmpdir(),"dash-decision-"));
  const filename=join(dir,"grading.sqlite");
  let db=new DatabaseSync(filename);
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  let graders=new Graders(db);
  const first=graders.save(definition,[]);
  const change={...definition,decision:{...definition.decision,model:"example/decision-v2"}};
  const second=graders.save(change,[]);
  assert.equal(graders.save(change,[]),second);
  assert.notEqual(first,second);
  db.close();
  db=new DatabaseSync(filename);
  graders=new Graders(db);
  const [v1,v2]=graders.select([first,second]);
  assert.ok(v1.type==="decision" && v2.type==="decision");
  assert.deepEqual([v1.version,v1.decision.model,v2.version,v2.decision.model],[1,localId,2,"example/decision-v2"]);
  assert.equal(v1.judge,null);
  assert.deepEqual(graders.quickOptions(approved,[]).available.map(g=>g.id),[second,first]);
  assert.equal(graders.resolveQuick(approved,[v1],null,[])[0].id,first);
  for(const failAt of [-0.1,0.8,0.81])
    assert.throws(()=>graders.save({...definition,decision:{...definition.decision,failAt}},[]));
  assert.throws(()=>graders.save({...definition,requiredEvidence:["goals"]},[]));
  assert.equal(graders.list().length,2);
});

test("native pass, fail and review thresholds preserve probabilities separately from binary Opik grades",async t=>{
  const db=new DatabaseSync(":memory:");
  t.after(()=>db.close());
  const graders=new Graders(db), g=graders.get(graders.save(definition,[]));
  let probability=0;
  const requests:string[]=[];
  const transport:typeof fetch=async(url,options)=>{
    if(String(url).endsWith("/v1/models"))
      return Response.json({data:[{id:localId,architecture:{output_modalities:["decisions"]}}]});
    assert.equal(String(url),"http://127.0.0.1:8080/v1/systemone");
    assert.equal(typeof options?.body,"string");
    assert.ok(typeof options?.body==="string");
    const request=postBody.parse(JSON.parse(options.body));
    assert.equal(request.model,localId);
    requests.push(request.state);
    return Response.json({model:localId,answers:{criterion:{type:"noul",noul:probability}},usage:{input_tokens:14,total_tokens:14}});
  };
  t.mock.method(globalThis,"fetch",transport);
  for (const p of [0.2,0.8,0.5]) {
    probability=p;
    await graders.record(g,evidence,{run:"run",candidate:"tested-model",caseId:String(p)},offline,signal());
  }
  const assessments=graders.recorded("run");
  assert.deepEqual(assessments.map(a=>[a.decision?.probabilityYes,a.value,a.pass]),[[0.2,0,false],[0.8,1,true],[0.5,null,null]]);
  for(const a of assessments) {
    assert.equal(a.engine,"decision");
    assert.equal(a.judge,localId);
    assert.ok(a.evaluator?.includes(opikVersion));
    assert.equal(a.decision?.actualModel,localId);
    assert.equal(a.decision?.usage?.inputTokens,14);
    assert.deepEqual(a.decisionRequest,{provider:"local",requestedModel:localId,endpoint:"http://127.0.0.1:8080",protocol:"systemone",failAt:0.2,passAt:0.8});
  }
  for(const state of requests) {
    const envelope=z.record(z.string(),z.unknown()).parse(JSON.parse(state));
    assert.equal(envelope.input,evidence.input);
    assert.equal(envelope.reference,evidence.reference);
    assert.equal(envelope.output,evidence.output);
    assert.equal(Object.hasOwn(envelope,"trajectory"),false);
  }
});

test("hosted consent and required evidence are checked per operation before any network access",async t=>{
  const db=new DatabaseSync(":memory:");
  t.after(()=>db.close());
  const graders=new Graders(db);
  const g=graders.get(graders.save({...definition,decision:{provider:"openrouter",model:localId,failAt:0.2},
    requiredEvidence:["reference","trajectory"]},[]));
  assert.deepEqual(graders.quickOptions(approved,[]).available,[]);
  assert.throws(()=>graders.resolveQuick(approved,[g],null,[]),/dataset|trace/);
  const calls:string[]=[];
  const prior=process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY="test-key-for-mocked-transport";
  t.after(()=>{if(prior===undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY=prior;});
  const actions=[{action:"read_drawing",output:"10 mm upper limit"}];
  const sample={...evidence,trajectory:actions};
  const transport:typeof fetch=async(url,options)=>{
    assert.equal(String(url),"https://openrouter.ai/api/alpha/decisions");
    assert.ok(typeof options?.body==="string");
    calls.push(postBody.parse(JSON.parse(options.body)).state);
    return Response.json({model:localId,answers:{criterion:{type:"noul",noul:0.9}}});
  };
  t.mock.method(globalThis,"fetch",transport);
  const denied=await graders.record(g,sample,{},offline,signal());
  assert.match(denied.reason,/Allow.*OpenRouter/);
  assert.equal(denied.decision,undefined);
  assert.equal(denied.evaluator,undefined);
  assert.equal(denied.value,null);
  assert.equal(denied.decisionRequest?.provider,"openrouter");
  assert.equal(denied.judge,localId);
  const noTrace=await graders.assess(g,{...evidence,output:"I used the tool."},offline,signal(),true);
  assert.match(noTrace.reason,/observed agent trajectory/);
  for (const reference of [null,"   "]) {
    const noRef=await graders.assess(g,{...sample,reference},offline,signal(),true);
    assert.match(noRef.reason,/reference answer/);
  }
  assert.equal(calls.length,0);
  const accepted=await graders.record(g,sample,{},offline,signal(),true);
  assert.equal(accepted.value,1);
  assert.equal(accepted.decision?.provider,"openrouter");
  assert.equal(calls.length,1);
  assert.deepEqual(z.object({trajectory:z.array(z.unknown())}).parse(JSON.parse(calls[0])).trajectory,actions);
  await graders.assess(g,sample,offline,signal());
  assert.equal(calls.length,1);
});

test("local protocol and fallback revisions preserve configured, dispatched and served decision model identities", async t=>{
  const db=new DatabaseSync(":memory:");
  t.after(()=>db.close());
  const library=new Graders(db);
  const primaryModel="/synthetic/checkpoints/primary";
  const fallbackModel="/synthetic/checkpoints/backup";
  const selected={...definition,decision:{...definition.decision,model:primaryModel,protocol:"systemone",fallbackModel}};
  const first=library.save(selected,[]);
  const mlx=library.save({...selected,decision:{...selected.decision,protocol:"mlx-vlm"}},[]);
  const another=library.save({...selected,decision:{...selected.decision,fallbackModel:"example/other"}},[]);
  const reopened=new Graders(db);
  const [g1,g2,g3]=reopened.select([first,mlx,another]);
  assert.ok(g1.type==="decision" && g2.type==="decision" && g3.type==="decision");
  assert.deepEqual([g1.version,g1.decision,g2.version,g2.decision.protocol,g3.version,g3.decision.fallbackModel],
    [1,selected.decision,2,"mlx-vlm",3,"example/other"]);
  let fail=false;
  const dispatches:string[]=[];
  const transport:typeof fetch=async(url,options)=>{
    if(String(url).endsWith("/v1/models"))
      return Response.json({data:[{id:fallbackModel,architecture:{output_modalities:["decisions"]}}]});
    assert.equal(String(url),"http://127.0.0.1:8080/v1/systemone");
    assert.ok(typeof options?.body==="string");
    dispatches.push(postBody.parse(JSON.parse(options.body)).model);
    return fail ? new Response(null,{status:503}) :
      Response.json({model:fallbackModel,answers:{criterion:{type:"noul",noul:0.9}}});
  };
  t.mock.method(globalThis,"fetch",transport);
  for (const caseId of ["served","failed"]) {
    fail=caseId==="failed";
    await reopened.record(g1,evidence,{run:"fallback",candidate:"lane",caseId},offline,signal());
  }
  const [served,failed]=reopened.recorded("fallback");
  assert.deepEqual(dispatches,[fallbackModel,fallbackModel]);
  const expectedAttempt={requestedModel:primaryModel,dispatchedModel:fallbackModel,protocol:"systemone",
    fallbackReason:"primary-unavailable"};
  assert.equal(served.decision?.actualModel,fallbackModel);
  assert.equal(served.decision?.requestedModel,primaryModel);
  assert.equal(served.decision?.dispatchedModel,fallbackModel);
  assert.equal(served.decision?.fallbackReason,expectedAttempt.fallbackReason);
  assert.equal(served.value,1);
  for (const item of [served,failed]) {
    assert.equal(item.judge,primaryModel);
    assert.equal(item.decisionRequest?.protocol,"systemone");
    assert.equal(item.decisionRequest?.fallbackModel,fallbackModel);
  }
  assert.deepEqual(failed.decisionAttempt,expectedAttempt);
  assert.equal(failed.decision,undefined);
  assert.equal(failed.evaluator,undefined);
  assert.equal(failed.value,null);
  assert.equal(failed.pass,null);
});

test("historical grader versions and assessments reopen without decision metadata",t=>{
  const db=new DatabaseSync(":memory:");
  t.after(()=>db.close());
  const graders=new Graders(db);
  const priorGrader={id:"old",name:"Keyword check",category:"legacy",type:"contains",criteria:"hold",threshold:1,judge:null,version:1};
  db.prepare("INSERT INTO graders VALUES(?,?,?,?)").run("old","keyword check",1,JSON.stringify(priorGrader));
  const record={graderId:"old",name:"Keyword check",version:1,category:"legacy",engine:"contains",threshold:1,
    judge:null,value:1,pass:true,reason:"Keyword matched.",id:"old-verdict",created:"2026-01-01T00:00:00Z"};
  db.prepare("INSERT INTO assessments VALUES(?,?,?,?,?,?)").run(record.id,"historic-run","lane","case",record.created,JSON.stringify(record));
  assert.deepEqual(graders.get("old"),{...priorGrader,industry:"Unclassified"});
  assert.deepEqual(graders.recorded("historic-run"),[{...record,candidate:"lane",caseId:"case"}]);
});

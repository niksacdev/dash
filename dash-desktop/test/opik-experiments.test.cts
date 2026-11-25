import { test } from "node:test";
import assert = require("node:assert/strict");
import * as http from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { logger, setLoggerLevel } from "opik";
import { buildReport } from "../lib/run-report.cjs";
import { OpikExperiments } from "../lib/opik-experiments.cjs";
import type { GraderSpec } from "../lib/grader-types.cjs";
import type { Checkpoint, NativeOpik, SavedRun, SyncReceipt, SyncStore } from "../lib/opik-types.cjs";
import type { RunManifest, RunResult, StoredGuardrail, DatasetCase, DatasetMetadata } from "../lib/run-types.cjs";
import { isCaseRow } from "../lib/run-types.cjs";
import type { Candidate } from "../lib/runtime-types.cjs";
import { exportDiagnostics,publicProviderError } from "../lib/export-diagnostics.cjs";
import { templateAdvice,httpGuidance } from "../lib/provider-errors.cjs";
import { referencePack } from "../lib/evaluation-cases.cjs";
import { loadPacks } from "../lib/packs.cjs";
import { decodeApprovedPrompt } from "../lib/outcome-contracts.cjs";
import { present } from "./runtime-fixtures.cjs";

const guardrail: StoredGuardrail = {status:"unverified", requestedInputCap:256, requestedOutputCap:80,
  inputTokens:null, contextTokens:null, outputReserve:80, source:"Synthetic", message:""};
const metadata: DatasetMetadata = {family:"Incoming inspection",industry:"Manufacturing",category:"QA",
  tags:["synthetic"],source:"test",changeNote:"",parentId:null};
type TestRun = SavedRun & { cases: DatasetCase[]; sourceCases?: DatasetCase[] };

function savedRun() {
  const cases=[{case_id:"lot",prompt:"Inspect lot 8",reference:"hold",sme_rationale:"Synthetic reference note",dataset_version:"2",split:"development"}] satisfies DatasetCase[];
  const candidates=["a","b"].map((id): Candidate=>({id,model:"model-"+id,provider:"lmstudio",kind:"model",revision:"r1"}));
  const started="2026-01-01T00:00:00.000Z";
  const manifest={id:"saved-run",title:"Inspection",mode:"dataset",pack:{...referencePack,title:"Inspection"},
    format:1,created:started,prompt:null,promptHash:"prompt-hash",split:"development",
    device:{arch:"arm64",platform:"darwin",release:"qa"},parameters:{},animation:false,
    approvedPromptId:null,datasetId:"snapshot-v2",datasetVersion:"2",datasetScorer:"exact-reference",industry:"Manufacturing",datasetMetadata:metadata,
    caseIds:["lot"],caseSetHash:"hash",candidates,graders:[],fixture:false,policyHash:"policy",tokenBudget:{inputCap:256,outputCap:80}} satisfies RunManifest;
  const results=candidates.map((c,i): RunResult=>({caseId:"lot",candidateId:c.id,output:i?"release":"hold",error:null,
    telemetry:{input_tokens:30,cached_input_tokens:18,output_tokens:4,latency_ms:100,device_power:{average_w:5,source:"Synthetic",scope:"Whole device",samples:1}},
    guardrail,score:{pass:i===0,reasons:i?["Incorrect disposition"]:[]},
    trace:{id:randomUUID(),runId:manifest.id,candidateId:c.id,caseId:"lot",started,finished:"2026-01-01T00:00:00.100Z",
      steps:[{at:started,action:"Invoke local"}]}}));
  const saved={status:"completed" as const,manifest,results,assessments:[],cases,partial:null};
  return {...saved,report:present(buildReport(saved))};
}

function bench(db: DatabaseSync, saved: TestRun): SyncStore {
  return {db, dataset: id=>({id, name:"Inspection cases", pack:present(saved.manifest.pack).id,
    metadata:{...metadata,...saved.manifest.datasetMetadata}, rows:saved.sourceCases ?? saved.cases}),
    exportRun:id=>{assert.equal(id,saved.manifest.id);return saved;}};
}

function approved(id:string, familyId:string, version:number, mode:RunManifest["mode"], prompt:string, requirements:string[]=[]) {
  return decodeApprovedPrompt({id,familyId,version,mode,prompt,requirements,domain:"Manufacturing",objective:"Inspect an incoming lot."});
}

// The isolated service observes JSON on the wire, after the official SDK has serialized it.
const str = z.string(), fields = z.record(str,z.unknown());
const datasetWire = z.looseObject({id:str,name:str,tags:z.array(str).optional(),project_id:str.optional(),project_name:str.optional()});
const wireRow = z.looseObject({data:fields}), editedRow = wireRow.extend({id:str});
const deltaWire = z.looseObject({base_version:str.nullable(),tags:z.array(str),metadata:fields.optional(),
  deleted_ids:z.array(str).default([]),added_items:z.array(wireRow).default([]),edited_items:z.array(editedRow).default([])});
const experimentWire = z.looseObject({id:str,name:str,status:str,dataset_version_id:str,
  metadata:z.looseObject({token_budget:z.looseObject({outputCap:z.number()})}),
  experiment_scores:z.array(z.unknown()).optional(),prompt_versions:z.array(z.object({id:str})).optional()});
const updatedExperiment = z.looseObject({status:str,experiment_scores:z.array(z.unknown())});
const linkWire = z.looseObject({id:str,experiment_id:str,dataset_item_id:str,trace_id:str});
const traceWire = z.looseObject({id:str,start_time:str,end_time:str.optional(),
  input:z.looseObject({messages:z.array(z.object({role:str,content:str}))}),
  output:z.looseObject({partial:z.boolean().optional(),response:str.nullable()}),
  metadata:z.looseObject({actual_usage:z.looseObject({latency_ms:z.number().optional()}),input_provenance:str,dispatch_state:str.optional()})});
const spanWire = z.looseObject({id:str,type:str,usage:z.looseObject({total_tokens:z.number().optional()}).optional(),end_time:str.optional()});
const scoreWire = z.looseObject({id:str,name:str,value:z.number()});
const promptRequest = z.looseObject({name:str,version:z.looseObject({id:str,template:str})});
interface MockVersion {id:string;version_hash:string;version_name:string;tags:string[];metadata?:Record<string,unknown>;items_total:number}

test("Opik status remains offline and unconfigured unless the DASH destination is explicit",()=>{
  const db=new DatabaseSync(":memory:"), run=savedRun();
  try{
    const svc=new OpikExperiments(bench(db,run),{env:{OPIK_API_KEY:"secret",OPIK_URL_OVERRIDE:"https://example.org/api"},makeApi:()=>assert.fail("offline")});
    assert.deepEqual(svc.status(run.manifest.id),{configured:false,error:undefined});
    assert.throws(()=>svc.sync(run.manifest.id),/DASH_OPIK_API_URL/);
    const enabled=new OpikExperiments(bench(db,{...run,status:"running"}),{env:{DASH_OPIK_API_URL:"http://127.0.0.1/api"},makeApi:()=>assert.fail("running")});
    return assert.rejects(enabled.sync(run.manifest.id),/finish before syncing/);
  } finally{db.close();}
});

test("SDK status failures disclose safe recovery and preserve the recorded run",async t=>{
  let httpStatus=401;
  const secret="synthetic sensitive response detail";
  const server=http.createServer((_req,res)=>{
    res.writeHead(httpStatus,{"Content-Type":"application/json"});
    res.end(JSON.stringify({message:secret}));
  });
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  t.after(()=>{server.closeAllConnections();server.close();});
  const endpoint=server.address();
  assert.ok(endpoint && typeof endpoint!=="string");
  const run=savedRun(),db=new DatabaseSync(":memory:");
  t.after(()=>db.close());
  const sync=new OpikExperiments(bench(db,run),{env:{DASH_OPIK_API_URL:"http://127.0.0.1:"+endpoint.port+"/api"}});
  for(const [code,expected] of [[401,/credential/i],[403,/permission/i],[413,/size limit/i],
    [429,/rate limit/i],[503,/temporarily unavailable/i]] as const){
    httpStatus=code;
    await assert.rejects(sync.sync(run.manifest.id),expected);
    const status=sync.status(run.manifest.id);
    assert.ok(status.configured && status.state==="partial");
    assert.match(status.receipt.error,expected);
    assert.ok(!status.receipt.error.includes(secret));
  }
});

test("live cross-session leases stay active and superseded publishers cannot journal writes or announce success",async t=>{
  const run=savedRun(), db=new DatabaseSync(":memory:");
  t.after(()=>db.close());
  const env={DASH_OPIK_API_URL:"http://127.0.0.1:51899/api"},shared=bench(db,run);
  const receipt:SyncReceipt={runId:run.manifest.id,datasetId:"dataset",datasetName:"QA",versionId:"version",
    version:"1",caseCount:1,experiments:[],syncedAt:run.manifest.created};
  const observer=new OpikExperiments(shared,{env});
  let replaceDuringStep=true;
  class Superseded extends OpikExperiments {
    override async send(_api:NativeOpik,saved:SavedRun,step:Checkpoint):Promise<SyncReceipt>{
      const progress=observer.status(saved.manifest.id);
      assert.ok(progress.configured && progress.state==="syncing" && progress.active);
      const replaceOwner=()=>db.prepare("UPDATE opik_export_jobs SET owner=?,pid=?,expires=? WHERE run=?")
        .run("replacement",process.pid,Date.now()+300000,saved.manifest.id);
      if(replaceDuringStep) await step("synthetic-step",z.string(),async()=>{replaceOwner();return "unconfirmed";});
      else replaceOwner();
      return receipt;
    }
  }
  const publisher=new Superseded(shared,{env});
  for(const duringStep of [true,false]){
    replaceDuringStep=duringStep;
    await assert.rejects(publisher.sync(run.manifest.id),/another session/i);
    assert.equal(db.prepare("SELECT count(*) AS n FROM opik_export_steps").get()?.n,0);
    assert.equal(db.prepare("SELECT owner FROM opik_export_jobs").get()?.owner,"replacement");
    db.prepare("UPDATE opik_export_jobs SET expires=0 WHERE owner='replacement'").run();
    const expired=observer.status(run.manifest.id);
    assert.ok(expired.configured && expired.state==="syncing" && !expired.active);
  }
});

test("an incumbent renewal between lease inspection and takeover fences the contender before any SDK call",async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"dash-opik-lease-")),filename=path.join(dir,"state.sqlite");
  const contenderDb=new DatabaseSync(filename),incumbentDb=new DatabaseSync(filename);
  t.after(()=>{incumbentDb.close();contenderDb.close();fs.rmSync(dir,{recursive:true,force:true});});
  const run=savedRun(),runId=run.manifest.id,renewed=Date.now()+300000;
  let apiCalls=0;
  const contender=new OpikExperiments(bench(contenderDb,run),{
    env:{DASH_OPIK_API_URL:"http://127.0.0.1:51899/api"},
    makeApi:()=>{apiCalls++;throw Error("Unexpected sync after incumbent renewal.");},
  });
  assert.ok(contender.config.configured);
  const dest=contender.config.key;
  incumbentDb.prepare("INSERT INTO opik_export_jobs VALUES(?,?,'syncing',NULL,'incumbent',?,0)").run(dest,runId,process.pid);
  const prepare=contenderDb.prepare.bind(contenderDb);
  let renewals=0;
  t.mock.method(contenderDb,"prepare",(sql:string)=>{
    if(sql.startsWith("INSERT INTO opik_export_jobs")){
      renewals++;
      incumbentDb.prepare("UPDATE opik_export_jobs SET expires=? WHERE destination=? AND run=? AND owner='incumbent'").run(renewed,dest,runId);
    }
    return prepare(sql);
  });
  await assert.rejects(contender.sync(runId),/another session/i);
  assert.equal(renewals,1);
  assert.equal(apiCalls,0);
  const job=incumbentDb.prepare("SELECT owner,pid,expires,state FROM opik_export_jobs WHERE destination=? AND run=?").get(dest,runId);
  assert.deepEqual({...job},{owner:"incumbent",pid:process.pid,expires:renewed,state:"syncing"});
  assert.equal(incumbentDb.prepare("SELECT count(*) AS n FROM opik_export_steps").get()?.n,0);
});

test("exports retain actionable local failures, redact legacy tokenizer and case diagnostics, and preserve original records",()=>{
  const saved=savedRun(),candidate=saved.manifest.candidates[0];
  const privateText="synthetic private SDK error";
  const known="LM Studio /api/v1/chat returned HTTP 400. ";
  assert.equal(publicProviderError(known+privateText),known+httpGuidance(400));
  assert.equal(publicProviderError(known+templateAdvice),known+templateAdvice);
  const base="LM Studio could not count the complete input for "+candidate.model+". Check its connection and chat template, or remove the input cap.";
  const blocked={...guardrail,candidateId:candidate.id,caseId:"lot",status:"blocked" as const,
    source:"LM Studio local runtime",message:base+" "+privateText};
  const manifest={...saved.manifest,error:candidate.model+" · lot — "+blocked.message,guardrailFailure:blocked};
  const results=saved.results.map(result=>({...result,error:privateText,score:null}));
  const report=buildReport({...saved,manifest,results,partial:null});
  const projected=exportDiagnostics({manifest,results,report,assessments:[]});
  assert.doesNotMatch(JSON.stringify(projected),new RegExp(privateText));
  assert.equal(projected.manifest.guardrailFailure?.message,base);
  assert.match(present(projected.manifest.error),/LM Studio could not count/);
  assert.deepEqual(projected.results.map(r=>r.output),saved.results.map(r=>r.output));
  assert.match(manifest.guardrailFailure.message,new RegExp(privateText));
  assert.equal(results[0].error,privateText);
});

test("historical unscored judge exceptions are projected in shared JSON while scored rationales remain case evidence",()=>{
  const run=savedRun(), raw="SYNTHETIC_INTERCEPTED_SDK_DETAIL";
  const candidate=run.manifest.candidates[0];
  assert.equal(candidate.provider,"lmstudio");
  const judge={kind:"model" as const,id:"local/synthetic",provider:"lmstudio" as const,model:"synthetic",revision:"1"};
  const g={type:"judge" as const,id:"grade-1",name:"QA",version:1,category:"Quality",industry:"Manufacturing",criteria:"Check the answer.",threshold:.8,judge};
  const manifest={...run.manifest,graders:[g],datasetScorer:"selected-graders" as const};
  const assessments=run.results.map((r,i)=>({id:"a"+i,created:manifest.created,candidate:r.candidateId,caseId:r.caseId,graderId:g.id,name:g.name,
    version:1,category:g.category,engine:g.type,threshold:g.threshold,judge:judge.id,pass:i?true:null,value:i?1:null,reason:i?"Observed the required disposition.":raw}));
  const report=present(buildReport({...run,manifest,assessments,partial:null}));
  assert.ok(JSON.stringify(report).includes(raw));
  const projected=exportDiagnostics({...run,manifest,assessments,report});
  assert.doesNotMatch(JSON.stringify(projected),new RegExp(raw));
  assert.equal(projected.assessments[1].reason,assessments[1].reason);
  assert.equal(projected.assessments[0].value,null);
  assert.equal(assessments[0].reason,raw);
});

test("a local case lacking a valid trace timestamp reports that evidence gap before dispatching an SDK request",async t=>{
  let requests=0;
  const server=http.createServer((_req,res)=>{requests++;res.writeHead(503);res.end();});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(()=>{server.closeAllConnections();server.close();});
  const endpoint=server.address();assert.ok(endpoint && typeof endpoint!=="string");
  const db=new DatabaseSync(":memory:"),run=savedRun();
  t.after(()=>db.close());
  run.results[1].trace.started="invalid";
  const svc=new OpikExperiments(bench(db,run),{env:{DASH_OPIK_API_URL:"http://127.0.0.1:"+endpoint.port+"/api"}});
  await assert.rejects(svc.sync(run.manifest.id),/recorded trace timestamp/);
  assert.equal(requests,0);
  assert.equal(svc.status(run.manifest.id).configured,true);
});

test("the real Opik DEBUG transport masks DASH keys and preserves logger configuration",async t=>{
  const key="SYNTHETIC_DEBUG_SESSION_KEY", records:string[]=[];
  const {type,minLevel,maskValuesOfKeys,attachedTransports}=logger.settings;
  t.after(()=>Object.assign(logger.settings,{type,minLevel,maskValuesOfKeys,attachedTransports}));
  logger.settings.type="hidden";
  setLoggerLevel("DEBUG");
  logger.settings.attachedTransports=[];
  logger.attachTransport(record=>records.push(JSON.stringify(record)));
  let receivedKey=false;
  const server=http.createServer((req,res)=>{
    receivedKey=req.headers.authorization===key;
    res.writeHead(503,{"Content-Type":"application/json"});
    res.end("{}");
  });
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  t.after(()=>{server.closeAllConnections();server.close();});
  const address=server.address();
  assert.ok(address && typeof address!=="string");
  const db=new DatabaseSync(":memory:"), run=savedRun();
  t.after(()=>db.close());
  const env={DASH_OPIK_API_URL:"http://127.0.0.1:"+address.port+"/api",OPIK_API_KEY:key};
  await assert.rejects(new OpikExperiments(bench(db,run),{env}).sync(run.manifest.id),/503/);
  assert.equal(receivedKey,true,"The SDK still authenticates the authorized request");
  assert.ok(records.some(line=>line.includes("Initializing OpikClient with config")));
  assert.ok(records.every(line=>!line.includes(key)),"No DEBUG transport entry should contain the session key");
  assert.equal(logger.settings.maskValuesOfKeys,maskValuesOfKeys);
});

test("native Opik sync keeps redirected writes inside the confirmed destination",async t=>{
  let otherRequests=0, otherBytes=0;
  const other=http.createServer(async(req,res)=>{
    otherRequests++;
    for await (const chunk of req) otherBytes+=Buffer.byteLength(chunk);
    res.writeHead(204);res.end();
  });
  other.listen(0,"127.0.0.1");
  await once(other,"listening");
  t.after(()=>{other.closeAllConnections();other.close();});
  const otherAddress=other.address();
  assert.ok(otherAddress && typeof otherAddress!=="string");
  let status=307;
  const writeStatuses:number[]=[],writeBytes:number[]=[];
  const source=http.createServer(async(req,res)=>{
    if (req.method==="POST") {
      let bytes=0;
      for await (const chunk of req) bytes+=Buffer.byteLength(chunk);
      writeBytes.push(bytes);
      writeStatuses.push(status);
      res.writeHead(status,{location:"http://127.0.0.1:"+otherAddress.port+"/different-workspace"});
    } else if (req.url?.startsWith("/api/v1/private/projects")) {
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end('{"content":[]}');return;
    } else res.writeHead(404,{"Content-Type":"application/json"});
    res.end("{}");
  });
  source.listen(0,"127.0.0.1");
  await once(source,"listening");
  t.after(()=>{source.closeAllConnections();source.close();});
  const endpoint=source.address();
  assert.ok(endpoint && typeof endpoint!=="string");
  const run=savedRun();
  for (status of [307,308]) {
    const db=new DatabaseSync(":memory:");
    try{
      const svc=new OpikExperiments(bench(db,run),{env:{DASH_OPIK_API_URL:"http://127.0.0.1:"+endpoint.port+"/api",OPIK_API_KEY:"synthetic-only"}});
      await assert.rejects(svc.sync(run.manifest.id),/Opik did not confirm this step/);
      const state=svc.status(run.manifest.id);
      assert.ok(state.configured && state.state==="partial");
    }finally{db.close();}
  }
  assert.deepEqual(writeStatuses,[307,308]);
  assert.ok(writeBytes.every(bytes=>bytes>0),"Both original requests carried a serialized native write");
  assert.equal(otherRequests,0);
  assert.equal(otherBytes,0);
});

test("actual SDK syncs saved traces and scores into native version-pinned experiments and resumes a lost write acknowledgement",async t=>{
  const datasets=new Map<string,z.infer<typeof datasetWire>>(), experiments=new Map<string,z.infer<typeof experimentWire>>();
  const projects=new Map<string,string>();
  const links=new Map<string,z.infer<typeof linkWire>>(), traces=new Map<string,z.infer<typeof traceWire>>();
  const spans=new Map<string,z.infer<typeof spanWire>>(), scores=new Map<string,z.infer<typeof scoreWire>>();
  const requests: [string,string][] = [], failures: string[] = [];
  const prompts=new Map<string,string>(), promptVersions=new Map<string,z.infer<typeof promptRequest>["version"]>();
  const versions=new Map<string,MockVersion[]>(), snapshots=new Map<string,Map<string,z.infer<typeof editedRow>>>();
  const changes: z.infer<typeof deltaWire>[] = [];
  const lastTrace = () => present([...traces.values()].at(-1));
  const historyFor = (datasetId:string) => present(versions.get(datasetId));
  const rowsFor = (datasetId:string) => present(snapshots.get(historyFor(datasetId)[0].version_hash));
  let conflictName=false,interrupt=true, loseNextVersion=false, losePrompt=true, competingInitializer=true;
  // The managed local destination presents no API key even when a cloud key exists in the process.
  const priorKey=process.env.OPIK_API_KEY;
  process.env.OPIK_API_KEY="isolated-cloud-key";
  t.after(()=>{if(priorKey===undefined)delete process.env.OPIK_API_KEY;else process.env.OPIK_API_KEY=priorKey;});
  const server=http.createServer(async(req,res)=>{
    try{
      assert.doesNotMatch(JSON.stringify(req.headers),/isolated-cloud-key/);
      const chunks: Buffer[]=[];
      for await(const chunk of req){assert.ok(Buffer.isBuffer(chunk));chunks.push(chunk);}
      const payload:unknown=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
      assert.doesNotMatch(JSON.stringify(payload),/dash-synthetic-private|localhost:8181|Private grading instructions|PRIVATE_CUSTOMER_CATALOG/);
      assert.ok(req.url && req.method);
      const url=new URL(req.url,"http://localhost"), [group,sub,leaf]=url.pathname.replace("/api/v1/private/","").split("/");
      requests.push([req.method,url.pathname]);res.setHeader("Content-Type","application/json");
      function send(status:number,value?:unknown){res.writeHead(status);res.end(value===undefined?undefined:JSON.stringify(value));}
      if(group==="prompts" && sub==="versions"){
        if(req.method==="GET")return promptVersions.has(leaf)?send(200,promptVersions.get(leaf)):send(404,{message:"unknown prompt version"});
        if(req.method==="POST"){
          const body=promptRequest.parse(payload);
          if(!prompts.has(body.name))prompts.set(body.name,randomUUID());
          assert.ok(!promptVersions.has(body.version.id));assert.ok(!JSON.stringify(body).includes("PRIVATE_BLUEPRINT"));
          const version={...body.version,prompt_id:prompts.get(body.name),commit:randomUUID().slice(0,8),version_number:"v"+(promptVersions.size+1)};
          promptVersions.set(version.id,version);
          if(losePrompt){losePrompt=false;return send(503,{message:"write committed"});}
          return send(201,version);
        }
      }
      if(group==="projects"){
        const content=[...projects.entries()].map(([name,id])=>({id,name}));
        if(sub){const found=content.find(p=>p.id===sub);return found?send(200,found):send(404);}
        return send(200,{content:content.filter(p=>p.name===url.searchParams.get("name"))});
      }
      if(group==="datasets"){
        if(req.method==="GET"&&!sub)return send(200,{content:[...datasets.values()].filter(d=>d.project_id===url.searchParams.get("project_id"))});
        if(sub==="retrieve"){
          const body=z.object({dataset_name:str}).parse(payload);
          const found=[...datasets.values()].find(d=>d.name===body.dataset_name);
          return found?send(200,found):send(404);
        }
        if(req.method==="POST"&&!sub){
          const body=datasetWire.parse(payload),project=present(body.project_name);
          if(conflictName){
            conflictName=false;
            const id=randomUUID();datasets.set(id,{id,name:body.name,tags:["Unrelated"],project_id:projects.get("QA Second")});versions.set(id,[]);
          }
          if([...datasets.values()].some(d=>d.name===body.name))return send(409,{message:"Dataset name is already taken"});
          if(!projects.has(project))projects.set(project,randomUUID());
          datasets.set(body.id,{...body,project_id:projects.get(project)});versions.set(body.id,[]);return send(201);
        }
        if(!datasets.has(sub))return send(404,{message:"missing"});
        const history=historyFor(sub), head=history[0];
        if(!leaf)return send(200,datasets.get(sub));
        if(leaf==="versions")return send(200,{content:history,total:history.length});
        if(req.method==="POST"&&url.pathname.endsWith("items/changes")){
          const body=deltaWire.parse(payload);
          if(!head && url.searchParams.get("override")!=="true")return send(400,{message:"Use override=true to create the first version without a base."});
          if(head && body.base_version==null)return send(400,{message:"baseVersion is required when the dataset already has versions."});
          if(head)assert.notEqual(url.searchParams.get("override"),"true","Every case-changing delta needs an explicit matching base version");
          if((head?.id ?? null)!==body.base_version)return send(409,{message:"stale version"});
          const rows=new Map(head ? present(snapshots.get(head.version_hash)) : []);
          if(!head && body.added_items?.length)return send(400,{message:"First delta requires an empty base"});
          for(const id of body.deleted_ids || [])rows.delete(id);
          for(const item of body.added_items || []){const id=randomUUID();rows.set(id,{...item,id});}
          for(const item of body.edited_items || []){
            const was=rows.get(item.id);assert.ok(was);rows.set(item.id,{...was,data:{...was.data,...item.data}});
          }
          const version={id:randomUUID(),version_hash:randomUUID(),version_name:"v"+(history.length+1),tags:body.tags,
            metadata:body.metadata,items_total:rows.size};
          history.unshift(version);snapshots.set(version.version_hash,rows);if(head)changes.push(body);
          if(!head && competingInitializer){
            // Another publisher established the empty base after DASH listed the family.
            competingInitializer=false;
            return send(400,{message:"baseVersion is required when the dataset already has versions."});
          }
          // The server can accept the atomic version write and lose its response.
          if(loseNextVersion){loseNextVersion=false;return send(503,{message:"version stored"});}
          return send(201,version);
        }
        if(leaf==="items" && url.pathname.endsWith("experiments/items") && url.searchParams.has("experiment_ids") && url.searchParams.has("dataset_version"))return send(400,{message:"dataset_version can only be used when experiment_ids is omitted"});
        if(leaf==="items"&&url.pathname.endsWith("experiments/items"))return send(200,{content:[...rowsFor(sub).values()].map(item=>({...item,experiment_items:[...links.values()].filter(link=>link.dataset_item_id===item.id)}))});
        if(leaf==="items"){
          const rows=snapshots.get(present(url.searchParams.get("version")));assert.ok(rows,"read by immutable hash");
          return send(200,{content:[...rows.values()],total:rows.size});
        }
      }
      if(group==="experiments"){
        if(req.method==="POST"&&!sub){const body=experimentWire.parse(payload);experiments.set(body.id,body);return send(201);}
        if(req.method==="POST"&&sub==="items"){
          const body=z.object({experiment_items:z.array(linkWire)}).parse(payload);
          if(body.experiment_items.every(item=>links.has(item.id)))return send(409,{message:"existing stable item ID"});
          for(const item of body.experiment_items)links.set(item.id,item);
          if(interrupt){interrupt=false;return send(503,{message:"write committed, response lost"});}
          return send(204);
        }
        if(!experiments.has(sub)) return send(404,{message:"missing"});
        if(req.method==="GET")return send(200,experiments.get(sub));
        if(req.method==="PATCH"){Object.assign(present(experiments.get(sub)),updatedExperiment.parse(payload));return send(204);}
      }
      if(group==="traces"&&sub==="batch"){for(const item of z.object({traces:z.array(traceWire)}).parse(payload).traces)traces.set(item.id,item);return send(204);}
      if(group==="spans"&&sub==="batch"){for(const item of z.object({spans:z.array(spanWire)}).parse(payload).spans)spans.set(item.id,item);return send(204);}
      if(group==="traces"&&sub==="feedback-scores"){for(const score of z.object({scores:z.array(scoreWire)}).parse(payload).scores)scores.set(score.id+"/"+score.name,score);return send(204);}
      throw Error("Unexpected SDK request "+req.method+" "+url.pathname);
    }catch(e){failures.push(e instanceof Error ? e.message : String(e));res.statusCode=500;res.end("{}");}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(()=>{server.closeAllConnections();server.close();});
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"dash-opik-test-")), file=path.join(temp,"jobs.sqlite");
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const endpoint=server.address();assert.ok(endpoint && typeof endpoint==="object");
  const saved=savedRun(),env={DASH_OPIK_API_URL:"http://127.0.0.1:"+endpoint.port+"/api",OPIK_WORKSPACE:"test",OPIK_PROJECT_NAME:"QA"};
  let db=new DatabaseSync(file);
  t.after(()=>db.close());
  let svc=new OpikExperiments(bench(db,saved),{env});
  const beforeSync=svc.status(saved.manifest.id);assert.ok(beforeSync.configured);
  assert.equal(beforeSync.state,"ready");
  assert.equal(requests.length,0);
  const first=svc.sync(saved.manifest.id);
  assert.equal(svc.sync(saved.manifest.id),first);
  await assert.rejects(first,/503/);
  const afterFailure=svc.status(saved.manifest.id);assert.ok(afterFailure.configured);
  assert.equal(afterFailure.state,"partial");
  db.close();db=new DatabaseSync(file);svc=new OpikExperiments(bench(db,saved),{env});
  const receipt=await svc.sync(saved.manifest.id);
  assert.deepEqual(failures,[]);
  const firstVersion=historyFor(receipt.datasetId)[0],version=firstVersion.id,items=rowsFor(receipt.datasetId);
  assert.equal(receipt.versionId,version);assert.equal(receipt.experiments.length,2);
  assert.deepEqual([datasets.size,items.size,experiments.size,traces.size,spans.size,links.size,scores.size],[1,1,2,2,2,2,2]);
  assert.equal([...items.values()][0].data.sme_rationale,"Synthetic reference note");
  for(const e of experiments.values()){
    assert.equal(e.dataset_version_id,version);assert.equal(e.status,"completed");assert.equal(e.metadata.token_budget.outputCap,80);
    assert.equal(e.metadata.dash_execution_mode,undefined,"release-era runs have no recorded execution mode");
    assert.equal(e.experiment_scores?.length,1);
  }
  for(const e of links.values()){assert.ok(experiments.has(e.experiment_id));assert.ok(items.has(e.dataset_item_id));assert.ok(traces.has(e.trace_id));}
  for(const trace of traces.values()){
    assert.deepEqual(trace.input.messages,[{role:"user",content:"Inspect lot 8"}]);
    assert.ok(trace.start_time);assert.ok(trace.end_time);
    assert.equal(trace.metadata.actual_usage.latency_ms,100);
    assert.doesNotMatch(JSON.stringify(trace.input),/Synthetic reference/);
  }
  assert.deepEqual([...scores.values()].map(s=>s.value).sort(),[0,1]);
  for(const span of spans.values()){assert.equal(span.usage?.total_tokens,34);assert.equal(span.usage?.cache_read_input_tokens,18);assert.equal(span.type,"llm");}
  assert.ok([...traces.values()].every(t=>t.metadata.input_provenance.includes("Reconstructed")));
  const before=requests.length;
  assert.deepEqual(await svc.sync(saved.manifest.id),receipt);
  assert.equal(requests.length,before);
  // Another saved run of the same snapshot shares the dataset/version, with independent experiments.
  const second: TestRun={...saved,manifest:{...saved.manifest,id:"next-saved-run",executionMode:"parallel-lanes",sharedDevicePower:{scope:"Whole device",source:"Synthetic",samples:2,average_w:12,peak_w:12,sampled_seconds:1,estimated_energy_j:12},datasetMetadata:{...saved.manifest.datasetMetadata,family:"INCOMING INSPECTION"}},
    results:saved.results.map(r=>({...r,telemetry:{...r.telemetry,device_power:undefined},dispatchedMessages:[{role:"user",content:"Actual saved adapter payload"}]}))};
  let next=await new OpikExperiments(bench(db,second),{env}).sync(second.manifest.id);
  assert.equal(next.datasetId,receipt.datasetId);assert.equal(next.versionId,receipt.versionId);
  assert.equal(datasets.size,1);assert.equal(experiments.size,4);
  assert.equal(next.datasetName,receipt.datasetName);
  for(const experiment of next.experiments){
    const meta=present(experiments.get(experiment.id)).metadata;
    assert.equal(meta.dash_execution_mode,"parallel-lanes");
    assert.equal(meta.sharedDevicePower,undefined);
  }
  assert.equal(lastTrace().input.messages[0].content,"Actual saved adapter payload");
  assert.equal(lastTrace().metadata.input_provenance,"Recorded adapter request");
  const nextRows=[{...saved.cases[0],dataset_version:"3",reference:"NEW",sme_rationale:null},
    {case_id:"new",dataset_version:"3",split:"development",prompt:"New case",reference:"HOLD"}].map(row=>{assert.ok(isCaseRow(row));return row;});
  const updated={...saved,cases:[nextRows[0]],sourceCases:nextRows,
    manifest:{...saved.manifest,id:"v3-subset",datasetVersion:"3",datasetId:"snapshot-v3",datasetMetadata:{...saved.manifest.datasetMetadata,changeNote:"Add new case"}}};
  // A case rerun publishes its complete dataset snapshot but only its observed responses.
  loseNextVersion=true;
  const v3Service=new OpikExperiments(bench(db,updated),{env});
  await assert.rejects(v3Service.sync(updated.manifest.id),/503/);
  const v3=await v3Service.sync(updated.manifest.id);
  assert.equal(v3.datasetId,receipt.datasetId);assert.notEqual(v3.versionId,version);assert.equal(v3.caseCount,2);
  assert.deepEqual(v3.experiments.map(e=>e.traces),[1,1]);assert.equal(changes.length,2);
  assert.equal(changes[1].edited_items[0].id,[...items.keys()][0]);assert.equal(changes[1].added_items.length,1);
  const v3Rows=rowsFor(receipt.datasetId);
  assert.equal([...v3Rows.values()][0].data.expected_output,"NEW");
  assert.equal([...items.values()][0].data.expected_output,"hold");
  const v4Data=[{...nextRows[0],dataset_version:"4",prompt:"Changed prompt"}];
  const v4={...updated,cases:v4Data,sourceCases:v4Data,manifest:{...updated.manifest,id:"v4",datasetId:"snapshot-v4",datasetVersion:"4"}};
  await new OpikExperiments(bench(db,v4),{env}).sync(v4.manifest.id);
  assert.equal(changes[2].deleted_ids.length,1);assert.equal(historyFor(receipt.datasetId).length,4);
  const old={...saved,manifest:{...saved.manifest,id:"another-run-on-v2"}};
  next=await new OpikExperiments(bench(db,old),{env}).sync(old.manifest.id);
  assert.equal(next.versionId,version);assert.equal(changes.length,3);
  assert.ok(next.experiments.every(e=>present(experiments.get(e.id)).dataset_version_id===version));
  for(const field of ["industry","family","pack"]){
    const separate: TestRun={...old,manifest:{...old.manifest,id:"unrelated-"+field}};
    if(field==="pack")separate.manifest.pack={...old.manifest.pack,id:"different"};
    else if(field==="family")separate.manifest.datasetMetadata={...old.manifest.datasetMetadata,family:"other"};
    else separate.manifest.industry="Financial Services";
    const receipt2=await new OpikExperiments(bench(db,separate),{env}).sync(separate.manifest.id);
    assert.notEqual(receipt2.datasetId,receipt.datasetId);
  }
  // Quick comparisons have no imported dataset and must retain the operator-approved prompt.
  const quick: TestRun={...saved,manifest:{...saved.manifest,id:"saved-quick",mode:"quick",pack:null,datasetId:null,
    caseIds:["prompt"],prompt:"Review the supplied QA result.",fixture:false},cases:[],report:{...saved.report,metrics:[]},
    results:saved.results.map(r=>({...r,caseId:"prompt",score:null}))};
  next=await new OpikExperiments(bench(db,quick),{env}).sync(quick.manifest.id);
  assert.notEqual(next.datasetId,receipt.datasetId);
  const quickItems=rowsFor(next.datasetId);
  assert.equal([...quickItems.values()][0].data.prompt,quick.manifest.prompt);
  assert.equal(next.experiments[0].scores,0);assert.equal(next.experiments[1].scores,0);
  assert.equal(lastTrace().input.messages[0].content,quick.manifest.prompt);
  const snapshotCount=historyFor(next.datasetId).length;
  const promptFamily={...quick,manifest:{...quick.manifest,id:"prompt-v1",approvedPromptId:"p1",approvedPrompt:approved("p1","catalog-family",1,"quick",present(quick.manifest.prompt),["PRIVATE_BLUEPRINT"])}};
  assert.equal(promptVersions.size,0);
  await assert.rejects(new OpikExperiments(bench(db,promptFamily),{env}).sync(promptFamily.manifest.id),/503/);
  const p1=await new OpikExperiments(bench(db,promptFamily),{env}).sync(promptFamily.manifest.id);
  const revised={...promptFamily,manifest:{...promptFamily.manifest,id:"prompt-v2",prompt:"New approved prompt",approvedPromptId:"p2",approvedPrompt:approved("p2","catalog-family",2,"quick","New approved prompt")}};
  const p2=await new OpikExperiments(bench(db,revised),{env}).sync(revised.manifest.id);
  assert.equal(p1.datasetId,p2.datasetId);assert.notEqual(p1.versionId,p2.versionId);
  assert.equal(prompts.size,1);assert.equal(promptVersions.size,2);
  assert.equal(present(p1.promptVersion).promptId,present(p2.promptVersion).promptId);assert.notEqual(present(p1.promptVersion).id,present(p2.promptVersion).id);
  assert.equal(present(promptVersions.get(present(p1.promptVersion).id)).template,quick.manifest.prompt);
  assert.equal(present(promptVersions.get(present(p2.promptVersion).id)).template,"New approved prompt");
  for(const v of [p1,p2])for(const e of v.experiments)assert.deepEqual(present(experiments.get(e.id)).prompt_versions,[{id:present(v.promptVersion).id}]);
  const prior={...promptFamily,manifest:{...promptFamily.manifest,id:"later-p1"}};
  const priorReceipt=await new OpikExperiments(bench(db,prior),{env}).sync(prior.manifest.id);
  assert.equal(promptVersions.size,2);assert.equal(present(priorReceipt.promptVersion).id,present(p1.promptVersion).id);
  assert.notEqual(p1.datasetId,next.datasetId);assert.equal(historyFor(next.datasetId).length,snapshotCount);

  const compactedRow: DatasetCase={case_id:"compact",input:{message:"keep  spaces"},source_locator:"loc",dataset_version:"1",split:"development"};
  const structured=loadPacks().map(p=>p.pack).find(pack=>pack.kind!=="reference");assert.ok(structured);
  const compacted: TestRun={...saved,cases:[compactedRow],manifest:{...saved.manifest,id:"compacted",pack:{...structured,id:"compact",system:"Existing system"},effectiveSystem:"Pinned effective system",
    caseIds:["compact"],datasetId:"compact-source",candidates:[saved.manifest.candidates[0]]},results:[
      {...saved.results[0],caseId:"compact",guardrail:{...guardrail,inputOptimization:{status:"compacted",charactersSaved:2}}},
    ],report:{...saved.report,metrics:[]}};
  compacted.manifest.approvedPromptId="dataset-p1";
  compacted.manifest.approvedPrompt=approved("dataset-p1","inspection",1,"dataset",present(compacted.manifest.effectiveSystem),["PRIVATE_BLUEPRINT"]);
  const measured=await new OpikExperiments(bench(db,compacted),{env}).sync("compacted");
  assert.equal(present(promptVersions.get(present(measured.promptVersion).id)).template,compacted.manifest.effectiveSystem);
  assert.equal(present(measured.promptVersion).variant,"dataset-system");
  assert.equal(lastTrace().input.messages[0].content,"Pinned effective system");
  assert.deepEqual(z.object({input:z.unknown()}).parse(JSON.parse(lastTrace().input.messages[1].content)).input,compactedRow.input);
  const fixture={...saved,manifest:{...saved.manifest,id:"fixture",fixture:true}};
  const spanCount=spans.size;
  await new OpikExperiments(bench(db,fixture),{env}).sync("fixture");
  assert.match(lastTrace().metadata.input_provenance,/no inference request/);
  assert.equal(spans.size,spanCount);
  const failed: TestRun={...quick,status:"failed",manifest:{...quick.manifest,id:"failed-at-dispatch"},results:[
    {...quick.results[0],output:null,telemetry:null,error:"runtime unavailable"},
  ]};
  await new OpikExperiments(bench(db,failed),{env}).sync("failed-at-dispatch");
  assert.match(lastTrace().metadata.input_provenance,/dispatch may have failed/);
  assert.equal(spans.size,spanCount);
  const remote:Candidate={provider:"compatible",kind:"model",id:"hosted-qa",model:"qa",section:"Hosted",
    keyRequired:true,endpoint:"https://model.example.invalid/v1"};
  const privateMessage="SYNTHETIC_HISTORICAL_PROVIDER_DIAGNOSTIC";
  for(const candidate of [remote,...(["lmstudio","ollama"] as const).map(provider=>({
    provider,id:provider+"/qa",kind:"model" as const,model:"local-qa",loaded:true}))]){
    const old:TestRun={...failed,manifest:{...failed.manifest,id:"legacy-error-"+candidate.provider,candidates:[candidate]},
      results:[{...failed.results[0],candidateId:candidate.id,error:privateMessage,dispatchedMessages:[{role:"user",content:"Synthetic input"}]}]};
    await new OpikExperiments(bench(db,old),{env}).sync(old.manifest.id);
    assert.equal(lastTrace().output.error,"Model endpoint did not return a confirmed successful response.");
    const span=present([...spans.values()].at(-1));
    assert.doesNotMatch(JSON.stringify([lastTrace(),span]),new RegExp(privateMessage));
    assert.deepEqual(span.output,lastTrace().output);
  }
  const interruptedCase: RunResult={...saved.results[0],caseId:"lot",dispatchState:"interrupted",output:"Partial reply",score:null,
    error:"DASH closed after dispatch.",telemetry:null,dispatchedMessages:[{role:"user",content:"Inspect lot 8"}],
    trace:{...saved.results[0].trace,finished:undefined}};
  const interrupted: TestRun={...saved,status:"interrupted",manifest:{...saved.manifest,id:"interrupted-adapter",candidates:[saved.manifest.candidates[0]]},
    results:[interruptedCase],assessments:[],report:{...saved.report,metrics:[]}};
  const scoredBeforeInterruption=scores.size;
  await new OpikExperiments(bench(db,interrupted),{env}).sync(interrupted.manifest.id);
  const observation=lastTrace();
  assert.equal(observation.metadata.dispatch_state,"interrupted");
  assert.equal(observation.output.partial,true);
  assert.equal(observation.output.response,"Partial reply");
  assert.ok(observation.start_time);
  assert.equal(observation.end_time,undefined);
  assert.equal(present([...spans.values()].at(-1)).end_time,undefined);
  assert.equal(scores.size,scoredBeforeInterruption);

  const grader={type:"decision",judge:null,id:"decision/r1",name:"Disposition follows evidence",version:1,threshold:.8,
    category:"Quality",industry:"Manufacturing",criteria:"Private grading instructions",decision:{provider:"local",model:"/Users/dash-synthetic-private/primary",fallbackModel:"/Users/dash-synthetic-private/alternate",protocol:"mlx-vlm",endpoint:"http://localhost:8181",failAt:.2}} satisfies GraderSpec;
  const decision:TestRun={...saved,manifest:{...saved.manifest,id:"decision-scoring",datasetScorer:"selected-graders",graders:[grader]}};
  const pin={provider:grader.decision.provider,protocol:grader.decision.protocol,requestedModel:grader.decision.model,fallbackModel:grader.decision.fallbackModel,failAt:grader.decision.failAt,passAt:grader.threshold};
  decision.assessments=decision.results.map((result,index)=>({
    id:"grade-"+index,created:result.trace.started,graderId:grader.id,name:grader.name,version:grader.version,category:grader.category,
    candidate:result.candidateId,caseId:result.caseId,threshold:grader.threshold,engine:grader.type,judge:pin.requestedModel,
    decisionRequest:{...pin,endpoint:grader.decision.endpoint},decision:{...pin,dispatchedModel:pin.fallbackModel,actualModel:pin.fallbackModel,fallbackReason:"primary-unavailable",probabilityYes:index ? .55 : .87},
    pass:index?null:true,value:index?null:1,reason:index?"Needs review.":"Met the criterion using "+pin.fallbackModel,
  }));
  decision.report=buildReport({...decision,partial:null});
  await new OpikExperiments(bench(db,decision),{env}).sync(decision.manifest.id);
  const [accepted,abstained]=[...traces.values()].slice(-2);
  const seen=(trace:typeof accepted)=>z.array(z.record(z.string(),z.unknown())).parse(trace.metadata.dash_decision_graders);
  const masked=seen(accepted)[0];
  assert.match(z.string().parse(masked.requestedModel),/^local-file-[0-9a-f]{16}$/);
  assert.match(z.string().parse(masked.fallbackModel),/^local-file-[0-9a-f]{16}$/);
  assert.notEqual(masked.requestedModel,masked.fallbackModel);
  const publicPin={...pin,requestedModel:masked.requestedModel,fallbackModel:masked.fallbackModel};
  const dispatched={dispatchedModel:masked.fallbackModel,actualModel:masked.fallbackModel,fallbackReason:"primary-unavailable"};
  assert.deepEqual(seen(accepted),[{...publicPin,...dispatched,status:"passed",probabilityYes:.87,grader_id:grader.id,grader_version:1}]);
  assert.deepEqual(seen(abstained),[{...publicPin,...dispatched,status:"review",probabilityYes:.55,grader_id:grader.id,grader_version:1}]);
  for (const trace of [accepted,abstained]) assert.doesNotMatch(JSON.stringify(trace.metadata),/localhost:8181|Private grading instructions/);
  assert.deepEqual([...scores.values()].filter(score=>score.id===accepted.id).map(s=>s.value),[1]);
  assert.ok(![...scores.values()].some(score=>score.id===abstained.id));
  // Even a stale cached report cannot manufacture native feedback when its recorded receipt is absent.
  decision.manifest={...decision.manifest,id:"decision-request-failed"};
  decision.assessments=decision.assessments.map(a=>({...a,decision:undefined,decisionAttempt:{requestedModel:pin.requestedModel,dispatchedModel:pin.fallbackModel,protocol:pin.protocol,fallbackReason:"primary-unavailable"},value:null,pass:null,reason:"Endpoint unavailable."}));
  const afterDecision=scores.size;
  await new OpikExperiments(bench(db,decision),{env}).sync(decision.manifest.id);
  assert.equal(scores.size,afterDecision);
  assert.deepEqual(seen(lastTrace()),[{...publicPin,dispatchedModel:masked.fallbackModel,fallbackReason:"primary-unavailable",status:"unscored",grader_id:grader.id,grader_version:1}]);

  const copied={type:"exact",judge:null,id:"9".repeat(64),name:"PRIVATE_CUSTOMER_CATALOG inspection policy",version:2,threshold:1,
    category:"Quality",industry:"Manufacturing",criteria:"PRIVATE_CUSTOMER_CATALOG rubric",
    library:{scope:"customer",familyId:"/Users/PRIVATE_CUSTOMER_CATALOG/rubrics",parentRevisionId:"8".repeat(64)}} satisfies GraderSpec;
  const diag={...copied,name:"Completion observed",id:"7".repeat(64),type:"catalog",ruleKey:"completion",ruleVersion:1,
    library:{scope:"general",automatic:true,familyId:"6".repeat(64)}} satisfies GraderSpec;
  const catalog:TestRun={...saved,manifest:{...saved.manifest,id:"catalog-grades",datasetScorer:"selected-graders",graders:[copied,diag]}};
  catalog.assessments=catalog.results.flatMap((result,index)=>[copied,diag].map(g=>{
    const pass=g.type==="catalog" ? null : index===0;
    return {id:g.id+index,created:result.trace.started,graderId:g.id,name:g.name,version:g.version,category:g.category,
      candidate:result.candidateId,caseId:result.caseId,threshold:1,engine:g.type,judge:null,
      value:pass===null?null:Number(pass),pass,reason:"PRIVATE_CUSTOMER_CATALOG reference and rationale"};
  }));
  catalog.report=buildReport({...catalog,partial:null});
  const synchronized=await new OpikExperiments(bench(db,catalog),{env}).sync(catalog.manifest.id);
  for (const [i,experiment] of synchronized.experiments.entries()) {
    const {metadata}=present(experiments.get(experiment.id));
    const pins=z.array(z.record(str,z.unknown())).parse(metadata.dash_grader_revisions);
    const child=present(pins.find(p=>p.revision_id===copied.id)),baseline=present(pins.find(p=>p.revision_id===diag.id));
    assert.match(z.string().parse(child.family_id),/^[0-9a-f]{64}$/);
    assert.deepEqual([child.scope,child.parent_revision_id,child.version,child.purpose],["customer",copied.library.parentRevisionId,2,"quality"]);
    assert.deepEqual([baseline.scope,baseline.family_id,baseline.purpose],["general",diag.library.familyId,"diagnostic"]);
    const item=present([...links.values()].find(item=>item.experiment_id===experiment.id)),trace=present(traces.get(item.trace_id));
    const judgments=z.array(z.record(str,z.unknown())).parse(trace.metadata.dash_grades);
    assert.deepEqual(judgments,[{...child,pass:i===0,score:i===0?1:0,status:i===0?"passed":"failed"},{...baseline,pass:null,score:null,status:"unscored"}]);
    const native=[...scores.values()].filter(s=>s.id===trace.id);
    assert.deepEqual(native.map(s=>[s.name,s.value]),[["Customer grader ["+copied.id+"]",i===0?1:0]]);
  }

  // Even an old stored domain-rule reason containing held-out facts cannot leave via native SDK feedback.
  const business={...diag,version:1,id:"dash/inspection-active-range/v1",name:"Active drawing range and reading",ruleKey:"inspection-active-range",
    library:{scope:"industry",familyId:"dash/inspection-active-range"}} satisfies GraderSpec;
  const nativeQuick:TestRun={...quick,manifest:{...quick.manifest,id:"quick-private-reference-qa",graders:[business]}};
  nativeQuick.assessments=nativeQuick.results.map((r,i)=>({id:"private-domain-"+i,created:r.trace.started,graderId:business.id,
    name:business.name,category:business.category,candidate:r.candidateId,caseId:r.caseId,version:1,threshold:1,engine:"catalog",judge:null,
    value:i===0?1:0,pass:i===0,reason:"PRIVATE_CUSTOMER_CATALOG held-out revision and source-only numerical limits."}));
  nativeQuick.report=buildReport({...nativeQuick,partial:null});
  const nativeQuickSync=await new OpikExperiments(bench(db,nativeQuick),{env}).sync(nativeQuick.manifest.id);
  const nativeReasons=nativeQuickSync.experiments.flatMap(experiment=>{
    const item=present([...links.values()].find(item=>item.experiment_id===experiment.id));
    return [...scores.values()].filter(s=>s.id===item.trace_id).map(s=>s.value);
  });
  assert.deepEqual(nativeReasons,[1,0],"Both catalog business scores reach native Opik feedback without the held-out reference in any HTTP request");

  // Independent local profiles publish into one Opik workspace. The API enforces names across projects.
  const renamed=present(datasets.get(receipt.datasetId));renamed.name="Renamed in Opik";
  const publishFromFresh=async(run:TestRun,project="QA")=>{
    const fresh=new DatabaseSync(":memory:");
    try{
      const service=new OpikExperiments(bench(fresh,run),{env:{...env,OPIK_PROJECT_NAME:project}});
      const result=await service.sync(run.manifest.id),before=requests.length;
      assert.deepEqual(await service.sync(run.manifest.id),result);assert.equal(requests.length,before);
      return result;
    }finally{fresh.close();}
  };
  const familyRun=(id:string):TestRun=>({...saved,manifest:{...saved.manifest,id}});
  const otherProfile=await publishFromFresh(familyRun("new-profile"));
  assert.equal(otherProfile.datasetId,receipt.datasetId);assert.equal(otherProfile.versionId,receipt.versionId);
  assert.equal(otherProfile.datasetName,"Renamed in Opik");
  const foreign=await publishFromFresh(familyRun("independent-project"),"QA Second");
  assert.notEqual(foreign.datasetId,receipt.datasetId);
  const foreignVersionCount=historyFor(foreign.datasetId).length;
  const unrelated=familyRun("different-source");
  unrelated.manifest={...unrelated.manifest,datasetMetadata:{...metadata,source:"Vendor B"},datasetId:"vendor-b-initial"};
  const otherSource=await publishFromFresh(unrelated);
  assert.notEqual(otherSource.datasetId,receipt.datasetId);assert.notEqual(otherSource.datasetId,foreign.datasetId);
  assert.equal(historyFor(foreign.datasetId).length,foreignVersionCount);
  const legacy=present(datasets.get(receipt.datasetId));legacy.tags=["DASH"];
  const recovered=await publishFromFresh(familyRun("older-profile-unmarked"));
  assert.equal(recovered.datasetId,receipt.datasetId);assert.equal(recovered.versionId,receipt.versionId);
  // A legacy server can return snapshot tags but omit version metadata. Keep the registered family prefix as independent evidence.
  const oldName=legacy.name;legacy.name="DASH Incoming inspection · "+requireFamilySuffix();
  function requireFamilySuffix(){
    const tagged=present(datasets.get(foreign.datasetId)).tags || [];
    return present(tagged.find(tag=>tag.startsWith("dash-family-"))).slice("dash-family-".length,"dash-family-".length+16);
  }
  const legacyHistory=historyFor(receipt.datasetId);
  const priorMetadata=legacyHistory.map(v=>v.metadata);
  legacyHistory.forEach(v=>{delete v.metadata;});
  const markerOnly=await publishFromFresh(familyRun("older-profile-tags-only"));
  assert.equal(markerOnly.datasetId,receipt.datasetId);assert.equal(markerOnly.versionId,receipt.versionId);
  legacyHistory.forEach((v,i)=>{v.metadata=priorMetadata[i];});legacy.name=oldName;
  const countBeforeConflict=experiments.size;
  conflictName=true;
  const collision=familyRun("human-owned-name");collision.manifest={...collision.manifest,datasetMetadata:{...metadata,family:"Completely different"}};
  await assert.rejects(publishFromFresh(collision),/different project or source/);
  assert.equal(experiments.size,countBeforeConflict);
  const sameSnapshot=familyRun("same-snapshot-new-source");
  sameSnapshot.manifest={...sameSnapshot.manifest,datasetMetadata:{...metadata,source:"New publisher"}};
  const exact=await publishFromFresh(sameSnapshot);
  assert.equal(exact.datasetId,receipt.datasetId);assert.equal(exact.versionId,receipt.versionId);
});

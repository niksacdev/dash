const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { buildReport } = require("../lib/run-report.cjs");
const { OpikExperiments } = require("../lib/opik-experiments.cjs");

function savedRun() {
  const cases=[{case_id:"lot",prompt:"Inspect lot 8",reference:"hold",sme_rationale:"Synthetic reference note",dataset_version:"2",split:"development"}];
  const candidates=["a","b"].map(id=>({id,model:"model-"+id,provider:"local",revision:"r1"}));
  const manifest={id:"saved-run",title:"Inspection",mode:"dataset",pack:{id:"reference",kind:"reference",title:"Inspection"},
    approvedPromptId:null,datasetId:"snapshot-v2",datasetVersion:"2",datasetScorer:"exact-reference",industry:"Manufacturing",
    caseIds:["lot"],caseSetHash:"hash",candidates,graders:[],fixture:false,policyHash:"policy",tokenBudget:{inputCap:256,outputCap:80}};
  const results=candidates.map((c,i)=>({caseId:"lot",candidateId:c.id,output:i?"release":"hold",error:null,
    telemetry:{input_tokens:30,output_tokens:4,latency_ms:100,device_power:{average_w:5}},
    guardrail:{outputReserve:80},score:{pass:i===0,reasons:i?["Incorrect disposition"]:[]},
    trace:{id:randomUUID(),started:"2026-01-01T00:00:00.000Z",finished:"2026-01-01T00:00:00.100Z",steps:[{action:"Invoke local"}]}}));
  const saved={status:"completed",manifest,results,assessments:[],cases};
  return {...saved,report:buildReport(saved)};
}
function bench(db,saved){return {db,exportRun:id=>{assert.equal(id,saved.manifest.id);return saved;}};}

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

test("actual SDK syncs saved traces and scores into native version-pinned experiments and resumes a lost write acknowledgement",async t=>{
  const datasets=new Map(),items=new Map(),experiments=new Map(),links=new Map(),traces=new Map(),spans=new Map(),scores=new Map(),requests=[];
  const version=randomUUID(), failures=[];
  let interrupt=true;
  const server=http.createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const c of req)chunks.push(c);
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
      const url=new URL(req.url,"http://localhost"), [group,sub,leaf]=url.pathname.replace("/api/v1/private/","").split("/");
      requests.push([req.method,url.pathname]);res.setHeader("Content-Type","application/json");
      function send(status,value){res.writeHead(status);res.end(value===undefined?undefined:JSON.stringify(value));}
      if(group==="datasets"){
        if(req.method==="POST"&&!sub){datasets.set(body.id,body);return send(201);}
        if(req.method==="PUT"&&sub==="items"){assert.ok(body.batch_group_id);for(const item of body.items)items.set(item.id,item);return send(204);}
        if(!datasets.has(sub))return send(404,{message:"missing"});
        if(!leaf)return send(200,datasets.get(sub));
        if(leaf==="versions")return send(200,{content:[{id:version,version_name:"v1",version_hash:"case-hash",items_total:items.size}]});
        if(leaf==="items"&&url.pathname.endsWith("experiments/items"))return send(200,{content:[...items.values()].map(item=>({...item,experiment_items:[...links.values()].filter(link=>link.dataset_item_id===item.id)}))});
        if(leaf==="items"){assert.equal(url.searchParams.get("version"),"case-hash");return send(200,{content:[...items.values()]});}
      }
      if(group==="experiments"){
        if(req.method==="POST"&&!sub){experiments.set(body.id,body);return send(201);}
        if(req.method==="POST"&&sub==="items"){
          if(body.experiment_items.every(item=>links.has(item.id)))return send(409,{message:"existing stable item ID"});
          for(const item of body.experiment_items)links.set(item.id,item);
          if(interrupt){interrupt=false;return send(503,{message:"write committed, response lost"});}
          return send(204);
        }
        if(!experiments.has(sub)) return send(404,{message:"missing"});
        if(req.method==="GET")return send(200,experiments.get(sub));
        if(req.method==="PATCH"){Object.assign(experiments.get(sub),body);return send(204);}
      }
      if(group==="traces"&&sub==="batch"){for(const item of body.traces)traces.set(item.id,item);return send(204);}
      if(group==="spans"&&sub==="batch"){for(const item of body.spans)spans.set(item.id,item);return send(204);}
      if(group==="traces"&&sub==="feedback-scores"){for(const score of body.scores)scores.set(score.id+"/"+score.name,score);return send(204);}
      throw Error("Unexpected SDK request "+req.method+" "+url.pathname);
    }catch(e){failures.push(e.message);res.statusCode=500;res.end("{}");}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(()=>{server.closeAllConnections();server.close();});
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"dash-opik-test-")), file=path.join(temp,"jobs.sqlite");
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const saved=savedRun(),env={DASH_OPIK_API_URL:"http://127.0.0.1:"+server.address().port+"/api",OPIK_WORKSPACE:"test",OPIK_PROJECT_NAME:"QA"};
  let db=new DatabaseSync(file);
  t.after(()=>db.close());
  let svc=new OpikExperiments(bench(db,saved),{env});
  assert.equal(svc.status(saved.manifest.id).state,"ready");
  assert.equal(requests.length,0);
  const first=svc.sync(saved.manifest.id);
  assert.equal(svc.sync(saved.manifest.id),first);
  await assert.rejects(first,/503/);
  assert.equal(svc.status(saved.manifest.id).state,"partial");
  db.close();db=new DatabaseSync(file);svc=new OpikExperiments(bench(db,saved),{env});
  const receipt=await svc.sync(saved.manifest.id);
  assert.deepEqual(failures,[]);
  assert.equal(receipt.versionId,version);assert.equal(receipt.experiments.length,2);
  assert.deepEqual([datasets.size,items.size,experiments.size,traces.size,spans.size,links.size,scores.size],[1,1,2,2,2,2,2]);
  assert.equal([...items.values()][0].data.sme_rationale,"Synthetic reference note");
  for(const e of experiments.values()){
    assert.equal(e.dataset_version_id,version);assert.equal(e.status,"completed");assert.equal(e.metadata.token_budget.outputCap,80);
    assert.equal(e.experiment_scores.length,1);
  }
  for(const e of links.values()){assert.ok(experiments.has(e.experiment_id));assert.ok(items.has(e.dataset_item_id));assert.ok(traces.has(e.trace_id));}
  for(const trace of traces.values()){
    assert.deepEqual(trace.input.messages,[{role:"user",content:"Inspect lot 8"}]);
    assert.ok(trace.start_time);assert.ok(trace.end_time);
    assert.equal(trace.metadata.actual_usage.latency_ms,100);
    assert.doesNotMatch(JSON.stringify(trace.input),/Synthetic reference/);
  }
  assert.deepEqual([...scores.values()].map(s=>s.value).sort(),[0,1]);
  for(const span of spans.values()){assert.equal(span.usage.total_tokens,34);assert.equal(span.type,"llm");}
  const before=requests.length;
  assert.deepEqual(await svc.sync(saved.manifest.id),receipt);
  assert.equal(requests.length,before);
  // Another saved run of the same snapshot shares the dataset/version, with independent experiments.
  const second={...saved,manifest:{...saved.manifest,id:"next-saved-run"}};
  let next=await new OpikExperiments(bench(db,second),{env}).sync(second.manifest.id);
  assert.equal(next.datasetId,receipt.datasetId);assert.equal(next.versionId,receipt.versionId);
  assert.equal(datasets.size,1);assert.equal(experiments.size,4);
  // Quick comparisons have no imported dataset and must retain the operator-approved prompt.
  const quick={...saved,manifest:{...saved.manifest,id:"saved-quick",mode:"quick",pack:null,datasetId:null,
    caseIds:["prompt"],prompt:"Review the supplied QA result.",fixture:false},cases:[],report:{metrics:[]},
    results:saved.results.map(r=>({...r,caseId:"prompt",score:null}))};
  // Simulate separate Opik dataset versions for the second dataset.
  items.clear();
  next=await new OpikExperiments(bench(db,quick),{env}).sync(quick.manifest.id);
  assert.notEqual(next.datasetId,receipt.datasetId);
  assert.equal([...items.values()][0].data.prompt,quick.manifest.prompt);
  assert.equal(next.experiments[0].scores,0);assert.equal(next.experiments[1].scores,0);
  assert.equal([...traces.values()].at(-1).input.messages[0].content,quick.manifest.prompt);
});

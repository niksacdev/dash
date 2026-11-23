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
    approvedPromptId:null,datasetId:"snapshot-v2",datasetVersion:"2",datasetScorer:"exact-reference",industry:"Manufacturing",datasetMetadata:{family:"Incoming inspection",industry:"Manufacturing"},
    caseIds:["lot"],caseSetHash:"hash",candidates,graders:[],fixture:false,policyHash:"policy",tokenBudget:{inputCap:256,outputCap:80}};
  const results=candidates.map((c,i)=>({caseId:"lot",candidateId:c.id,output:i?"release":"hold",error:null,
    telemetry:{input_tokens:30,output_tokens:4,latency_ms:100,device_power:{average_w:5}},
    guardrail:{outputReserve:80},score:{pass:i===0,reasons:i?["Incorrect disposition"]:[]},
    trace:{id:randomUUID(),started:"2026-01-01T00:00:00.000Z",finished:"2026-01-01T00:00:00.100Z",steps:[{action:"Invoke local"}]}}));
  const saved={status:"completed",manifest,results,assessments:[],cases};
  return {...saved,report:buildReport(saved)};
}
function bench(db,saved){return {db,dataset:()=>({metadata:saved.manifest.datasetMetadata,rows:saved.sourceCases || saved.cases}),exportRun:id=>{assert.equal(id,saved.manifest.id);return saved;}};}

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
  const datasets=new Map(),experiments=new Map(),links=new Map(),traces=new Map(),spans=new Map(),scores=new Map(),requests=[];
  const prompts=new Map(),promptVersions=new Map();
  const versions=new Map(), snapshots=new Map(), changes=[], failures=[];
  let interrupt=true, loseNextVersion=false, losePrompt=true;
  // The managed local destination presents no API key even when a cloud key exists in the process.
  const priorKey=process.env.OPIK_API_KEY;
  process.env.OPIK_API_KEY="isolated-cloud-key";
  t.after(()=>{if(priorKey===undefined)delete process.env.OPIK_API_KEY;else process.env.OPIK_API_KEY=priorKey;});
  const server=http.createServer(async(req,res)=>{
    try{
      assert.doesNotMatch(JSON.stringify(req.headers),/isolated-cloud-key/);
      const chunks=[];for await(const c of req)chunks.push(c);
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
      const url=new URL(req.url,"http://localhost"), [group,sub,leaf]=url.pathname.replace("/api/v1/private/","").split("/");
      requests.push([req.method,url.pathname]);res.setHeader("Content-Type","application/json");
      function send(status,value){res.writeHead(status);res.end(value===undefined?undefined:JSON.stringify(value));}
      if(group==="prompts" && sub==="versions"){
        if(req.method==="GET")return promptVersions.has(leaf)?send(200,promptVersions.get(leaf)):send(404,{message:"unknown prompt version"});
        if(req.method==="POST"){
          if(!prompts.has(body.name))prompts.set(body.name,randomUUID());
          assert.ok(!promptVersions.has(body.version.id));assert.ok(!JSON.stringify(body).includes("PRIVATE_BLUEPRINT"));
          const version={...body.version,prompt_id:prompts.get(body.name),commit:randomUUID().slice(0,8),version_number:"v"+(promptVersions.size+1)};
          promptVersions.set(version.id,version);
          if(losePrompt){losePrompt=false;return send(503,{message:"write committed"});}
          return send(201,version);
        }
      }
      if(group==="datasets"){
        if(req.method==="POST"&&!sub){datasets.set(body.id,body);versions.set(body.id,[]);return send(201);}
        if(!datasets.has(sub))return send(404,{message:"missing"});
        const history=versions.get(sub), head=history[0];
        if(!leaf)return send(200,datasets.get(sub));
        if(leaf==="versions")return send(200,{content:history,total:history.length});
        if(req.method==="POST"&&url.pathname.endsWith("items/changes")){
          if((head?.id ?? null)!==body.base_version)return send(409,{message:"stale version"});
          const rows=new Map(snapshots.get(head?.version_hash) || []);
          if(!head && body.added_items?.length)return send(400,{message:"First delta requires an empty base"});
          for(const id of body.deleted_ids || [])rows.delete(id);
          for(const item of body.added_items || []){const id=randomUUID();rows.set(id,{...item,id});}
          for(const item of body.edited_items || []){
            const was=rows.get(item.id);assert.ok(was);rows.set(item.id,{...was,data:{...was.data,...item.data}});
          }
          const version={id:randomUUID(),version_hash:randomUUID(),version_name:"v"+(history.length+1),tags:body.tags,
            metadata:body.metadata,items_total:rows.size};
          history.unshift(version);snapshots.set(version.version_hash,rows);if(head)changes.push(body);
          // The server can accept the atomic version write and lose its response.
          if(loseNextVersion){loseNextVersion=false;return send(503,{message:"version stored"});}
          return send(201,version);
        }
        if(leaf==="items"&&url.pathname.endsWith("experiments/items"))return send(200,{content:[...snapshots.get(head.version_hash).values()].map(item=>({...item,experiment_items:[...links.values()].filter(link=>link.dataset_item_id===item.id)}))});
        if(leaf==="items"){
          const rows=snapshots.get(url.searchParams.get("version"));assert.ok(rows,"read by immutable hash");
          return send(200,{content:[...rows.values()],total:rows.size});
        }
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
  const firstVersion=versions.get(receipt.datasetId)[0],version=firstVersion.id,items=snapshots.get(firstVersion.version_hash);
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
  assert.ok([...traces.values()].every(t=>t.metadata.input_provenance.includes("Reconstructed")));
  const before=requests.length;
  assert.deepEqual(await svc.sync(saved.manifest.id),receipt);
  assert.equal(requests.length,before);
  // Another saved run of the same snapshot shares the dataset/version, with independent experiments.
  const second={...saved,manifest:{...saved.manifest,id:"next-saved-run",datasetMetadata:{...saved.manifest.datasetMetadata,family:"INCOMING INSPECTION"}},
    results:saved.results.map(r=>({...r,dispatchedMessages:[{role:"user",content:"Actual saved adapter payload"}]}))};
  let next=await new OpikExperiments(bench(db,second),{env}).sync(second.manifest.id);
  assert.equal(next.datasetId,receipt.datasetId);assert.equal(next.versionId,receipt.versionId);
  assert.equal(datasets.size,1);assert.equal(experiments.size,4);
  assert.equal(next.datasetName,receipt.datasetName);
  assert.equal([...traces.values()].at(-1).input.messages[0].content,"Actual saved adapter payload");
  assert.equal([...traces.values()].at(-1).metadata.input_provenance,"Recorded adapter request");
  const nextRows=[{...saved.cases[0],dataset_version:"3",reference:"NEW",sme_rationale:null},
    {case_id:"new",dataset_version:"3",split:"development",prompt:"New case",reference:"HOLD"}];
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
  const v3Rows=snapshots.get(versions.get(receipt.datasetId)[0].version_hash);
  assert.equal([...v3Rows.values()][0].data.expected_output,"NEW");
  assert.equal([...items.values()][0].data.expected_output,"hold");
  const v4Data=[{...nextRows[0],dataset_version:"4",prompt:"Changed prompt"}];
  const v4={...updated,cases:v4Data,sourceCases:v4Data,manifest:{...updated.manifest,id:"v4",datasetId:"snapshot-v4",datasetVersion:"4"}};
  await new OpikExperiments(bench(db,v4),{env}).sync(v4.manifest.id);
  assert.equal(changes[2].deleted_ids.length,1);assert.equal(versions.get(receipt.datasetId).length,4);
  const old={...saved,manifest:{...saved.manifest,id:"another-run-on-v2"}};
  next=await new OpikExperiments(bench(db,old),{env}).sync(old.manifest.id);
  assert.equal(next.versionId,version);assert.equal(changes.length,3);
  assert.ok(next.experiments.every(e=>experiments.get(e.id).dataset_version_id===version));
  for(const field of ["industry","family","pack"]){
    const separate={...old,manifest:{...old.manifest,id:"unrelated-"+field}};
    if(field==="pack")separate.manifest.pack={...old.manifest.pack,id:"different"};
    else if(field==="family")separate.manifest.datasetMetadata={...old.manifest.datasetMetadata,family:"other"};
    else separate.manifest.industry="Financial Services";
    const receipt2=await new OpikExperiments(bench(db,separate),{env}).sync(separate.manifest.id);
    assert.notEqual(receipt2.datasetId,receipt.datasetId);
  }
  // Quick comparisons have no imported dataset and must retain the operator-approved prompt.
  const quick={...saved,manifest:{...saved.manifest,id:"saved-quick",mode:"quick",pack:null,datasetId:null,
    caseIds:["prompt"],prompt:"Review the supplied QA result.",fixture:false},cases:[],report:{metrics:[]},
    results:saved.results.map(r=>({...r,caseId:"prompt",score:null}))};
  next=await new OpikExperiments(bench(db,quick),{env}).sync(quick.manifest.id);
  assert.notEqual(next.datasetId,receipt.datasetId);
  const quickItems=snapshots.get(versions.get(next.datasetId)[0].version_hash);
  assert.equal([...quickItems.values()][0].data.prompt,quick.manifest.prompt);
  assert.equal(next.experiments[0].scores,0);assert.equal(next.experiments[1].scores,0);
  assert.equal([...traces.values()].at(-1).input.messages[0].content,quick.manifest.prompt);
  const snapshotCount=versions.get(next.datasetId).length;
  const promptFamily={...quick,manifest:{...quick.manifest,id:"prompt-v1",approvedPromptId:"p1",approvedPrompt:{id:"p1",version:1,familyId:"catalog-family",requirements:["PRIVATE_BLUEPRINT"]}}};
  assert.equal(promptVersions.size,0);
  await assert.rejects(new OpikExperiments(bench(db,promptFamily),{env}).sync(promptFamily.manifest.id),/503/);
  const p1=await new OpikExperiments(bench(db,promptFamily),{env}).sync(promptFamily.manifest.id);
  const revised={...promptFamily,manifest:{...promptFamily.manifest,id:"prompt-v2",prompt:"New approved prompt",approvedPromptId:"p2",approvedPrompt:{id:"p2",version:2,familyId:"catalog-family"}}};
  const p2=await new OpikExperiments(bench(db,revised),{env}).sync(revised.manifest.id);
  assert.equal(p1.datasetId,p2.datasetId);assert.notEqual(p1.versionId,p2.versionId);
  assert.equal(prompts.size,1);assert.equal(promptVersions.size,2);
  assert.equal(p1.promptVersion.promptId,p2.promptVersion.promptId);assert.notEqual(p1.promptVersion.id,p2.promptVersion.id);
  assert.equal(promptVersions.get(p1.promptVersion.id).template,quick.manifest.prompt);
  assert.equal(promptVersions.get(p2.promptVersion.id).template,"New approved prompt");
  for(const v of [p1,p2])for(const e of v.experiments)assert.deepEqual(experiments.get(e.id).prompt_versions,[{id:v.promptVersion.id}]);
  const prior={...promptFamily,manifest:{...promptFamily.manifest,id:"later-p1"}};
  const priorReceipt=await new OpikExperiments(bench(db,prior),{env}).sync(prior.manifest.id);
  assert.equal(promptVersions.size,2);assert.equal(priorReceipt.promptVersion.id,p1.promptVersion.id);
  assert.notEqual(p1.datasetId,next.datasetId);assert.equal(versions.get(next.datasetId).length,snapshotCount);

  const compactedRow={case_id:"compact",input:{message:"keep  spaces"},source_locator:"loc",dataset_version:"1",split:"development"};
  const compacted={...saved,cases:[compactedRow],manifest:{...saved.manifest,id:"compacted",pack:{id:"compact",system:"Existing system"},effectiveSystem:"Pinned effective system",
    caseIds:["compact"],datasetId:"compact-source",candidates:[saved.manifest.candidates[0]]},results:[
      {...saved.results[0],caseId:"compact",guardrail:{inputOptimization:{status:"compacted"}}},
    ],report:{metrics:[]}};
  compacted.manifest.approvedPromptId="dataset-p1";
  compacted.manifest.approvedPrompt={id:"dataset-p1",familyId:"inspection",version:1,requirements:["PRIVATE_BLUEPRINT"]};
  const measured=await new OpikExperiments(bench(db,compacted),{env}).sync("compacted");
  assert.equal(promptVersions.get(measured.promptVersion.id).template,compacted.manifest.effectiveSystem);
  assert.equal(measured.promptVersion.variant,"dataset-system");
  assert.equal([...traces.values()].at(-1).input.messages[0].content,"Pinned effective system");
  assert.deepEqual(JSON.parse([...traces.values()].at(-1).input.messages[1].content).input,compactedRow.input);
  const fixture={...saved,manifest:{...saved.manifest,id:"fixture",fixture:true}};
  const spanCount=spans.size;
  await new OpikExperiments(bench(db,fixture),{env}).sync("fixture");
  assert.match([...traces.values()].at(-1).metadata.input_provenance,/no inference request/);
  assert.equal(spans.size,spanCount);
  const failed={...quick,status:"failed",manifest:{...quick.manifest,id:"failed-at-dispatch"},results:[
    {...quick.results[0],output:null,telemetry:null,error:"runtime unavailable"},
  ]};
  await new OpikExperiments(bench(db,failed),{env}).sync("failed-at-dispatch");
  assert.match([...traces.values()].at(-1).metadata.input_provenance,/dispatch may have failed/);
  assert.equal(spans.size,spanCount);
});

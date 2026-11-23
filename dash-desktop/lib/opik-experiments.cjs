"use strict";

const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { caseMessages } = require("./evaluation-cases.cjs");

const terminal = new Set(["completed", "failed", "canceled", "interrupted"]);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const options = { maxRetries: 0, timeoutInSeconds: 35 };
function address(raw) {
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    throw Error("Use an HTTP(S) base URL without credentials, query or fragment.");
  return u.href.replace(/\/+$/, "");
}
function configuration(env) {
  if (!env.DASH_OPIK_API_URL) return { configured: false };
  try {
    const apiUrl = address(env.DASH_OPIK_API_URL);
    const dashboard = env.DASH_OPIK_UI_URL ? address(env.DASH_OPIK_UI_URL) : null;
    const host = new URL(apiUrl).hostname;
    if ((host==="comet.com" || host.endsWith(".comet.com")) && !env.OPIK_API_KEY)
      return { configured:false, error:"Set OPIK_API_KEY for the configured Opik Cloud destination and reopen DASH." };
    const workspace = env.OPIK_WORKSPACE?.trim() || "default", project = env.OPIK_PROJECT_NAME?.trim() || "DASH";
    if (workspace.length > 150 || project.length > 150) throw Error("Opik workspace and project names must be 150 characters or fewer.");
    return { configured: true, apiUrl, dashboard, workspace, project, key: digest([apiUrl,workspace,project]), apiKey: env.OPIK_API_KEY || "" };
  } catch { return { configured: false, error: "Check the Opik API and dashboard URLs and workspace/project names." }; }
}
function uuid7() {
  const b = randomBytes(16);
  b.writeUIntBE(Date.now(), 0, 6); b[6] = (b[6] & 15) | 112; b[8] = (b[8] & 63) | 128;
  const s = b.toString("hex");
  return [s.slice(0,8),s.slice(8,12),s.slice(12,16),s.slice(16,20),s.slice(20)].join("-");
}
function sdkApi(c) {
  const { Opik } = require("opik");
  return new Opik({ apiUrl:c.apiUrl, apiKey:c.apiKey, workspaceName:c.workspace, projectName:c.project,
    isAttachmentExtractionActive:false, holdUntilFlush:true }).api;
}
async function ensure(get, create) {
  try { return await get(); } catch (e) { if (e.statusCode !== 404) throw e; }
  try { await create(); } catch (e) { if (e.statusCode !== 409) throw e; }
  return get();
}
function batches(items, limit=50) {
  const out = [];
  let size=0, current=[];
  for (const item of items) {
    const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (current.length && (current.length >= limit || size + bytes > 1800000)) {
      out.push(current); current=[]; size=0;
    }
    current.push(item); size+=bytes;
  }
  if (current.length) out.push(current);
  return out;
}
function date(value) {
  const d = new Date(value);
  if (!value || !Number.isFinite(d.getTime())) throw Error("A saved case is missing its recorded trace timestamp.");
  return d;
}
function safeFailure(e) {
  if (e.statusCode) return "Opik returned HTTP " + e.statusCode + ". Check the destination, workspace and its access settings, then retry.";
  if (e.dashOpik) return e.message;
  return "Opik did not confirm this step. Check the destination and retry to resume.";
}
function problem(message) { return Object.assign(Error(message), {dashOpik:true}); }

class OpikExperiments {
  constructor(bench, { env=process.env, makeApi=sdkApi } = {}) {
    this.bench=bench; this.db=bench.db; this.config=configuration(env); this.makeApi=makeApi; this.pending=new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS opik_export_ids(destination TEXT,key TEXT,id TEXT NOT NULL,PRIMARY KEY(destination,key));
      CREATE TABLE IF NOT EXISTS opik_export_steps(destination TEXT,key TEXT,receipt TEXT NOT NULL,PRIMARY KEY(destination,key));
      CREATE TABLE IF NOT EXISTS opik_export_jobs(destination TEXT,run TEXT,state TEXT NOT NULL,receipt TEXT,owner TEXT,pid INTEGER,expires INTEGER,PRIMARY KEY(destination,run));`);
  }
  stableId(key) {
    const dest=this.config.key;
    const hit=this.db.prepare("SELECT id FROM opik_export_ids WHERE destination=? AND key=?").get(dest,key);
    if (hit) return hit.id;
    this.db.prepare("INSERT OR IGNORE INTO opik_export_ids VALUES(?,?,?)").run(dest,key,uuid7());
    return this.db.prepare("SELECT id FROM opik_export_ids WHERE destination=? AND key=?").get(dest,key).id;
  }
  status(run) {
    const {configured,error,apiUrl,workspace,project,dashboard,key}=this.config;
    if (!configured) return {configured,error};
    const row=this.db.prepare("SELECT state,receipt FROM opik_export_jobs WHERE destination=? AND run=?").get(key,run);
    return {configured,apiUrl,workspace,project,hasDashboard:!!dashboard,state:row?.state || "ready",receipt:row?.receipt ? JSON.parse(row.receipt) : null,active:this.pending.has(run)};
  }
  sync(runId) {
    if (!this.config.configured) throw Error("Set DASH_OPIK_API_URL before syncing a saved run.");
    if (this.pending.has(runId)) return this.pending.get(runId);
    const task=this.publish(runId).finally(()=>this.pending.delete(runId));
    this.pending.set(runId,task);
    return task;
  }
  async publish(runId) {
    const saved=this.bench.exportRun(runId);
    if (!terminal.has(saved.status)) throw Error("Wait for the run to finish before syncing.");
    const dest=this.config.key, owner=randomUUID();
    const existing=this.status(runId);
    if (existing.state==="synced") return existing.receipt;
    const job=this.db.prepare("SELECT owner,pid,expires FROM opik_export_jobs WHERE destination=? AND run=?").get(dest,runId);
    if (job?.owner && job.expires>Date.now()) {
      let alive=true;
      try { process.kill(job.pid,0); } catch (e) { alive=e.code!=="ESRCH"; }
      if (alive) throw Error("This run is already syncing in another DASH session.");
    }
    const claim=this.db.prepare(`INSERT INTO opik_export_jobs VALUES(?,?,'syncing',NULL,?,?,?)
      ON CONFLICT(destination,run) DO UPDATE SET state='syncing',receipt=NULL,owner=excluded.owner,pid=excluded.pid,expires=excluded.expires
      WHERE opik_export_jobs.state!='synced' AND opik_export_jobs.owner IS ?`).run(dest,runId,owner,process.pid,Date.now()+300000,job?.owner ?? null);
    if (!claim.changes) throw Error("Another session claimed this run. Refresh its sync status.");
    const checkpoint=async (key,action)=>{
      const lease=this.db.prepare("UPDATE opik_export_jobs SET expires=? WHERE destination=? AND run=? AND owner=?").run(Date.now()+300000,dest,runId,owner);
      if (!lease.changes) throw problem("Another session resumed this export.");
      const hit=this.db.prepare("SELECT receipt FROM opik_export_steps WHERE destination=? AND key=?").get(dest,key);
      if (hit) return JSON.parse(hit.receipt);
      const value=await action() ?? null;
      this.db.prepare("INSERT OR IGNORE INTO opik_export_steps VALUES(?,?,?)").run(dest,key,JSON.stringify(value));
      return value;
    };
    const finish=(state,data)=>this.db.prepare("UPDATE opik_export_jobs SET state=?,receipt=?,owner=NULL,pid=NULL,expires=NULL WHERE destination=? AND run=? AND owner=?")
      .run(state,JSON.stringify(data),dest,runId,owner);
    try {
      const api=this.api ??= this.makeApi(this.config);
      const receipt=await this.send(api,saved,checkpoint);
      finish("synced",receipt);
      return receipt;
    } catch (e) {
      const message=safeFailure(e);
      finish("partial",{error:message});
      throw Error(message);
    }
  }
  async send(api, saved, step) {
    const m=saved.manifest, projectName=this.config.project;
    const rows=m.datasetId ? saved.cases : [{case_id:"prompt",prompt:m.prompt}];
    if (!rows.length || new Set(rows.map(r=>r.case_id)).size!==m.caseIds.length)
      throw problem("The saved case snapshot is incomplete.");
    const snapshot=digest([m.datasetId || "quick",rows]);
    const datasetId=this.stableId("dataset/"+snapshot);
    const datasetName=("DASH "+(m.datasetMetadata?.family || m.pack?.title || "Quick compare")).slice(0,95)+" · "+snapshot.slice(0,16);
    const dsKey="dataset/"+datasetId;
    const items=rows.map(row=>({id:this.stableId(dsKey+"/case/"+row.case_id),source:"sdk",data:row}));
    const byCase=new Map(rows.map((row,i)=>[row.case_id,{row,item:items[i]}]));
    await step(dsKey+"/create",async()=>{
      const remote=await ensure(()=>api.datasets.getDatasetById(datasetId,{},options),
        ()=>api.datasets.createDataset({id:datasetId,name:datasetName,projectName,description:"DASH case snapshot "+(m.datasetVersion || snapshot.slice(0,16)),tags:["DASH"]},options));
      if (remote.name!==datasetName) throw problem("The destination dataset identity did not match the saved snapshot.");
    });
    const groupId=this.stableId(dsKey+"/version");
    for (const [i,chunk] of batches(items).entries())
      await step(dsKey+"/batch/"+i,()=>api.datasets.createOrUpdateDatasetItems({datasetId,projectName,batchGroupId:groupId,items:chunk},options));
    const version=await step(dsKey+"/verified-version",async()=>{
      const latest=(await api.datasets.listDatasetVersions(datasetId,{page:1,size:1},options)).content?.[0];
      if (!latest?.id || !latest.versionHash || latest.itemsTotal!==items.length) throw problem("Opik has not confirmed the complete dataset version. Retry sync after indexing.");
      const actual=new Map();
      for(let page=1;page<=Math.ceil(items.length/100);page++){
        const result=await api.datasets.getDatasetItems(datasetId,{page,size:100,version:latest.versionHash,truncate:false},options);
        for(const item of result.content || []) actual.set(item.id,item.data);
      }
      if(items.some(item=>!isDeepStrictEqual(actual.get(item.id),item.data))) throw problem("Opik has not confirmed the exact case content. Retry after its dataset index has updated.");
      return {id:latest.id,hash:latest.versionHash,name:latest.versionName || latest.versionHash};
    });
    const experiments=[];
    for(const candidate of m.candidates){
      const eid=this.stableId("experiment/"+m.id+"/"+candidate.id), prefix="experiment/"+eid;
      const name=("DASH · "+m.title+" · "+candidate.model).slice(0,105)+" · "+m.id.slice(0,8)+"-"+eid.slice(-5);
      const experimentScores=(saved.report?.metrics || []).flatMap(metric=>{
        const v=metric.values.find(v=>v.candidateId===candidate.id);
        return Number.isFinite(v?.score)?[{name:metric.label+" ["+metric.id.slice(-8)+"]",value:v.score}]:[];
      });
      await step(prefix+"/create",async()=>{
        const e=await ensure(()=>api.experiments.getExperimentById(eid,{},options),
          ()=>api.experiments.createExperiment({id:eid,name,projectName,datasetName,datasetVersionId:version.id,status:"running",
            metadata:{dash_run_id:m.id,candidate_id:candidate.id,model:candidate.model,revision:candidate.revision,industry:m.industry,
              fixture:m.fixture,dataset_id:m.datasetId,case_set_hash:m.caseSetHash,approved_prompt_id:m.approvedPromptId,policy_hash:m.policyHash,
              token_budget:m.tokenBudget,run_status:saved.status},tags:["DASH",...(m.fixture?["fixture"]:[])]},options));
        if(e.name!==name || (e.datasetId && e.datasetId!==datasetId))throw problem("An experiment ID did not match this candidate and dataset.");
      });
      const traces=[], spans=[], links=[], scores=[];
      for(const result of saved.results.filter(r=>r.candidateId===candidate.id)){
        const data=byCase.get(result.caseId);
        if(!data)throw problem("A saved response has no matching source case.");
        const key=prefix+"/case/"+result.caseId, traceId=this.stableId(key+"/trace");
        const startTime=date(result.trace?.started),endTime=date(result.trace?.finished), tel=result.telemetry || {};
        const input={messages:caseMessages({...m,effectiveSystem:m.effectiveSystem ?? m.pack?.system},data.row)};
        const output={response:result.output ?? null,...(result.error && {error:result.error})};
        const trace={id:traceId,projectName,name:result.caseId,startTime,endTime,input,output,source:"experiment",
          metadata:{dash_trace_id:result.trace?.id,dash_steps:result.trace?.steps,case_id:result.caseId,candidate_id:candidate.id,
            actual_usage:tel,guardrail:result.guardrail,finish_reason:result.finishReason,fixture:m.fixture,
            input_provenance: m.pack && m.pack.kind!=="reference" && !m.effectiveSystem ? "Reconstructed from legacy scenario" : "Saved run manifest and case"}};
        if(Number.isFinite(tel.first_token_ms))trace.ttft=tel.first_token_ms;
        traces.push(trace);
        if(!m.fixture){
          const usage={};
          if(Number.isFinite(tel.input_tokens))usage.prompt_tokens=tel.input_tokens;
          if(Number.isFinite(tel.output_tokens))usage.completion_tokens=tel.output_tokens;
          if(usage.prompt_tokens!=null && usage.completion_tokens!=null)usage.total_tokens=usage.prompt_tokens+usage.completion_tokens;
          spans.push({id:this.stableId(key+"/span"),traceId,projectName,name:candidate.model,type:"llm",model:candidate.model,
            provider:candidate.provider,startTime,endTime,input,output,source:"experiment",usage,
            ...(Number.isFinite(tel.cost_usd) && {totalEstimatedCost:tel.cost_usd})});
        }
        links.push({id:this.stableId(key+"/item"),experimentId:eid,datasetItemId:data.item.id,traceId,projectName});
        for(const metric of saved.report?.metrics || []){
          const evidence=metric.caseScores.find(r=>r.caseId===result.caseId)?.values.find(v=>v.candidateId===candidate.id);
          if(Number.isFinite(evidence?.score)) scores.push({id:traceId,projectName,name:metric.label+" ["+metric.id.slice(-8)+"]",value:evidence.score,
            source:"sdk",reason:evidence.reason,categoryName:metric.method});
        }
      }
      const write=async(kind,items,fn)=>{
        for(const [i,chunk] of batches(items).entries()) await step(prefix+"/"+kind+"/"+i,()=>fn(chunk));
      };
      await write("traces",traces,chunk=>api.traces.createTraces({traces:chunk},options));
      await write("spans",spans,chunk=>api.spans.createSpans({spans:chunk},options));
      await write("links",links,async chunk=>{
        try { await api.experiments.createExperimentItems({experimentItems:chunk},options); }
        catch(e) {
          if(e.statusCode!==409)throw e;
          // An acknowledged duplicate is safe only when the server confirms all three linked IDs.
          const remote=new Map();
          for(let page=1;page<=Math.ceil(items.length/100);page++){
            const data=await api.datasets.findDatasetItemsWithExperimentItems(datasetId,{page,size:100,
              experimentIds:JSON.stringify([eid]),datasetVersion:version.hash},options);
            for(const row of data.content || [])for(const item of row.experimentItems || [])remote.set(item.id,item);
          }
          const unresolved=chunk.filter(item=>{
            const found=remote.get(item.id);
            return !found || found.experimentId!==eid || found.datasetItemId!==item.datasetItemId || found.traceId!==item.traceId;
          });
          if(unresolved.length)throw problem("Opik has not confirmed all matching experiment items. Retry after indexing.");
        }
      });
      await write("scores",scores,chunk=>api.traces.scoreBatchOfTraces({scores:chunk},options));
      const status=saved.status==="completed"?"completed":saved.status==="failed"?"failed":"cancelled";
      await step(prefix+"/finish",()=>api.experiments.updateExperiment(eid,{body:{status,experimentScores}},options));
      experiments.push({id:eid,name,candidate:candidate.model,traces:traces.length,scores:scores.length});
    }
    return {runId:m.id,datasetId,datasetName,versionId:version.id,version:version.name,caseCount:rows.length,experiments,syncedAt:new Date().toISOString()};
  }
}
module.exports={OpikExperiments,configuration};

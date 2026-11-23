"use strict";

const { createHash, randomBytes, randomUUID } = require("node:crypto");
const {caseData,nativeVersion} = require("./opik-dataset-versions.cjs");
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
  async registerPrompt(api,m,step) {
    if(m.fixture || !m.approvedPromptId)return null;
    const approved=m.approvedPrompt, family=approved?.familyId || m.approvedPromptId;
    if(approved?.id && approved.id!==m.approvedPromptId)throw problem("The saved approval and prompt IDs differ.");
    const template=m.mode==="quick" ? m.prompt : m.effectiveSystem;
    if(typeof template!=="string" || !template.trim())throw problem("The approved candidate-visible prompt is missing from this saved run.");
    const variant=m.mode==="quick"?"quick-user":"dataset-system";
    const name="DASH "+(m.mode==="quick"?"Quick prompt":"Dataset prompt")+" · "+digest([family,variant]).slice(0,20);
    const key="catalog-prompt/"+digest([family,m.approvedPromptId,variant,template]);
    return step(key,async()=>{
      const id=this.stableId(key);
      let remote;
      try { remote=await api.prompts.getPromptVersionById(id,{},options); }
      catch(e) {
        if(e.statusCode!==404)throw e;
        try {
          remote=await api.prompts.createPromptVersion({name,projectName:this.config.project,templateStructure:"text",version:{
            id,template,type:"mustache",metadata:{dash_approved_prompt_id:m.approvedPromptId,dash_family_id:family,
              dash_revision:approved?.version ?? null,variant},tags:["DASH"],
          }},options);
        } catch(e) {
          if(e.statusCode!==409)throw e;
          remote=await api.prompts.getPromptVersionById(id,{},options);
        }
      }
      if(!remote?.id || !remote.promptId || remote.template!==template ||
         remote.metadata?.dash_approved_prompt_id!==m.approvedPromptId || remote.metadata?.variant!==variant)
        throw problem("Opik did not confirm the approved candidate-visible prompt version.");
      return {id:remote.id,promptId:remote.promptId,name,commit:remote.commit ?? null,
        version:remote.versionNumber ?? null,approvedId:m.approvedPromptId,revision:approved?.version ?? null,variant};
    });
  }
  async send(api, saved, step) {
    const m=saved.manifest, projectName=this.config.project;
    const source=m.datasetId ? this.bench.dataset(m.datasetId) : null;
    const rows=source?.rows ?? [{case_id:"prompt",prompt:m.prompt}];
    const byId=new Set(rows.map(r=>r.case_id));
    if(!rows.length || byId.size!==rows.length || m.caseIds.some(id=>!byId.has(id)))
      throw problem("The saved case snapshot is incomplete.");
    const metadata=m.datasetMetadata || source?.metadata || {};
    const family=source ? metadata.family || m.datasetId : m.approvedPrompt?.familyId || m.approvedPromptId || digest(m.prompt);
    const industry=m.industry || metadata.industry || "Unclassified";
    const normalized=value=>value.trim().toLowerCase();
    const identity=digest([source?"dataset":"quick",normalized(industry),m.pack?.id || "",normalized(family)]);
    const snapshot=digest([m.datasetId || m.approvedPromptId || "quick",rows]);
    const datasetId=this.stableId("dataset-family/"+identity);
    const proposedName=("DASH "+(source?family:"Quick compare")).slice(0,95)+" · "+identity.slice(0,16);
    const dsKey="dataset/"+datasetId;
    const items=rows.map(row=>({source:"sdk",data:caseData(row)}));
    const byCase=new Map(rows.map(row=>[row.case_id,row]));
    const datasetName=await step(dsKey+"/registered-name",async()=>{
      const remote=await ensure(()=>api.datasets.getDatasetById(datasetId,{},options),
        ()=>api.datasets.createDataset({id:datasetId,name:proposedName,projectName,description:industry+" · "+(m.pack?.title || "Quick comparison prompts"),tags:["DASH"]},options));
      if (!remote.name || (remote.id && remote.id!==datasetId)) throw problem("The destination dataset identity did not match this family.");
      return remote.name;
    });
    const version=await step(dsKey+"/snapshot/"+snapshot,()=>nativeVersion(api,datasetId,items,snapshot,{
      dash_dataset_id:m.datasetId || "", dash_dataset_version:m.datasetVersion || rows[0].dataset_version || "",
      dash_prompt_id:m.approvedPromptId || "",family:source?family:"Quick compare",industry,pack:m.pack?.id || "",
      split:m.split || rows[0].split || "quick",change_note:metadata.changeNote || "",parent_snapshot:metadata.parentId || "",
      category:metadata.category || "",source:metadata.source || "",dataset_tags:JSON.stringify(metadata.tags || []),
    },options,problem));
    const promptVersion=await this.registerPrompt(api,m,step);
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
            ...(promptVersion && {promptVersions:[{id:promptVersion.id}]}),
            metadata:{dash_run_id:m.id,candidate_id:candidate.id,model:candidate.model,revision:candidate.revision,industry:m.industry,
              fixture:m.fixture,dataset_id:m.datasetId,dataset_version:m.datasetVersion,dataset_family:metadata.family,pinned_dataset_metadata:metadata,case_set_hash:m.caseSetHash,approved_prompt_id:m.approvedPromptId,policy_hash:m.policyHash,
              token_budget:m.tokenBudget,run_status:saved.status},tags:["DASH",...(m.fixture?["fixture"]:[])]},options));
        if(e.name!==name || (e.datasetId && e.datasetId!==datasetId))throw problem("An experiment ID did not match this candidate and dataset.");
      });
      const traces=[], spans=[], links=[], scores=[];
      for(const result of saved.results.filter(r=>r.candidateId===candidate.id)){
        const data=byCase.get(result.caseId);
        if(!data)throw problem("A saved response has no matching source case.");
        const key=prefix+"/case/"+result.caseId, traceId=this.stableId(key+"/trace");
        const startTime=date(result.trace?.started),endTime=date(result.trace?.finished), tel=result.telemetry || {};
        let messages, provenance;
        if(!m.fixture && Array.isArray(result.dispatchedMessages)) {
          messages=result.dispatchedMessages;
          provenance="Recorded adapter request";
        } else {
          const legacySystem=m.effectiveSystem ?? (m.pack ? m.pack.system+"\nOutput schema: "+JSON.stringify(m.pack.outputSchema)+
            "\nReturn only the raw JSON object. Start with { and end with }. Omit Markdown code fences, labels, comments and surrounding prose." : null);
          messages=caseMessages({...m,effectiveSystem:legacySystem},data);
          if(!m.fixture && result.guardrail?.inputOptimization?.status==="compacted")
            messages=require("./guardrail.cjs").prepareInput(messages,true).messages;
          provenance=m.fixture ? "Fixture replay; reconstructed case only, no inference request" : result.error ?
            "Reconstructed legacy input; dispatch may have failed" : "Reconstructed from the saved run, case and input optimization";
        }
        const input={messages};
        const output={response:result.output ?? null,...(result.error && {error:result.error})};
        const trace={id:traceId,projectName,name:result.caseId,startTime,endTime,input,output,source:"experiment",
          metadata:{dash_trace_id:result.trace?.id,dash_steps:result.trace?.steps,case_id:result.caseId,candidate_id:candidate.id,
            actual_usage:tel,guardrail:result.guardrail,finish_reason:result.finishReason,fixture:m.fixture,
            input_provenance:provenance}};
        if(Number.isFinite(tel.first_token_ms))trace.ttft=tel.first_token_ms;
        traces.push(trace);
        if(!m.fixture && (!result.error || Array.isArray(result.dispatchedMessages) || result.telemetry?.input_tokens!=null)){
          const usage={};
          if(Number.isFinite(tel.input_tokens))usage.prompt_tokens=tel.input_tokens;
          if(Number.isFinite(tel.output_tokens))usage.completion_tokens=tel.output_tokens;
          if(usage.prompt_tokens!=null && usage.completion_tokens!=null)usage.total_tokens=usage.prompt_tokens+usage.completion_tokens;
          spans.push({id:this.stableId(key+"/span"),traceId,projectName,name:candidate.model,type:"llm",model:candidate.model,
            provider:candidate.provider,startTime,endTime,input,output,source:"experiment",usage,
            ...(Number.isFinite(tel.cost_usd) && {totalEstimatedCost:tel.cost_usd})});
        }
        links.push({id:this.stableId(key+"/item"),experimentId:eid,datasetItemId:version.caseIds[result.caseId],traceId,projectName});
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
    return {runId:m.id,datasetId,datasetName,versionId:version.id,version:version.name,caseCount:rows.length,experiments,promptVersion,syncedAt:new Date().toISOString()};
  }
}
module.exports={OpikExperiments,configuration};

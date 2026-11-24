import {posix,win32} from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {Opik,generateId,z} from "opik";
import {localOpikEnvironment} from "./local-opik-config.cjs";
import {catalogRules} from "./grader-catalog.cjs";
import {getOpikTemplate} from "./opik-library.cjs";
import type {GraderSpec} from "./grader-types.cjs";
import {analyzeOutputs,type RunReport} from "./run-report.cjs";
import {caseMessages} from "./evaluation-cases.cjs";
import {prepareInput} from "./guardrail.cjs";
import {resolveDatasetFamily} from "./opik-dataset-family.cjs";
import {caseData,nativeVersion} from "./opik-dataset-versions.cjs";
import type {RunManifest,CaseRow} from "./run-types.cjs";
import {isRecord} from "./runtime-types.cjs";
import {datasetVersion,promptLink,syncReceipt,statusCode,type SyncOptions,type SyncStore,type SyncReceipt,type Checkpoint,
  type SavedRun,type PublishState,type OpikConfiguration,type Destination,type NativeOpik,type NativeScore,type NativeTrace,type NativeSpan,type NativeItem} from "./opik-types.cjs";
export type {PublishState,SyncReceipt} from "./opik-types.cjs";

const terminal = new Set(["completed", "failed", "canceled", "interrupted"]);
const digest = (value:unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Local decision servers sometimes identify weights with a full filesystem path.
function decisionPrivacy(saved:SavedRun) {
  const paths=new Set<string>();
  function remember(id:string|undefined) {
    if (id && (posix.isAbsolute(id) || win32.isAbsolute(id) || id.startsWith("~/") || /^file:/i.test(id))) paths.add(id);
  }
  for (const grader of saved.manifest.graders || []) if (grader.type==="decision" && grader.decision.provider==="local") {
    remember(grader.decision.model);remember(grader.decision.fallbackModel);
  }
  for (const a of saved.assessments) if (a.engine==="decision" && a.decisionRequest?.provider==="local"){
    remember(a.decisionRequest.requestedModel);remember(a.decisionRequest.fallbackModel);
    remember(a.decision?.actualModel);remember(a.decision?.dispatchedModel);remember(a.decisionAttempt?.dispatchedModel);
  }
  const replacements=[...paths].sort((a,b)=>b.length-a.length).map(id=>({id,label:"local-file-"+digest(id).slice(0,16)}));
  const label=(value:string)=>replacements.reduce((label,p)=>label.replaceAll(p.id,p.label),value);
  function clean(value:unknown):unknown {
    if (typeof value==="string") return label(value);
    if (Array.isArray(value)) return value.map(clean);
    if (isRecord(value)) return metadata(value);
    return value;
  }
  function metadata(value:Record<string,unknown>):Record<string,unknown> {
    return replacements.length ? Object.fromEntries(Object.entries(value).map(([key,val])=>[label(key),clean(val)])) : value;
  }
  return {label,metadata};
}
type Metric=RunReport["metrics"][number];
function opaqueId(id:string) {
  return /^(?:[0-9a-f]{64}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(id) ? id : digest(id);
}
function graderPin(metric:Metric) {
  const source=metric.lineage;
  return {revision_id:opaqueId(metric.id),version:metric.version,method:metric.method,
    purpose:metric.informational ? "diagnostic" : "quality",
    ...(source && {scope:source.scope,family_id:opaqueId(source.familyId),
      ...(source.parentRevisionId && {parent_revision_id:opaqueId(source.parentRevisionId)})})};
}
function nativeScoreName(metric:Metric, grader:GraderSpec|undefined) {
  if (!metric.lineage) return metric.label+" ["+metric.id.slice(-8)+"]";
  const catalogName=grader?.type==="catalog" ? catalogRules.find(rule=>rule.key===grader.ruleKey)?.name :
    grader?.type==="opik-metric" ? getOpikTemplate(grader.metricKey).name : undefined;
  const title=metric.lineage.scope==="customer" ? "Customer grader" : catalogName || (metric.lineage.scope==="industry" ? "Industry grader" : "General grader");
  return title+" ["+opaqueId(metric.id)+"]";
}
const options = { maxRetries: 0, timeoutInSeconds: 35 };
function address(raw:string) {
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    throw Error("Use an HTTP(S) base URL without credentials, query or fragment.");
  return u.href.replace(/\/+$/, "");
}
export function configuration(env:NodeJS.ProcessEnv):OpikConfiguration {
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
function sdkApi(c:Destination):NativeOpik {
  return new Opik({ apiUrl:c.apiUrl, apiKey:c.apiKey, workspaceName:c.workspace, projectName:c.project,
    isAttachmentExtractionActive:false, holdUntilFlush:true }).api;
}
async function ensure<T>(get:()=>Promise<T>,create:()=>Promise<unknown>):Promise<T> {
  try { return await get(); } catch (e) { if (statusCode(e) !== 404) throw e; }
  try { await create(); } catch (e) { if (statusCode(e) !== 409) throw e; }
  return get();
}
function batches<T>(items:T[], limit=50):T[][] {
  const out = [];
  let size=0, current:T[]=[];
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
function date(value:string|undefined) {
  const d = new Date(value ?? "");
  if (!value || !Number.isFinite(d.getTime())) throw Error("A saved case is missing its recorded trace timestamp.");
  return d;
}
function safeFailure(e:unknown) {
  if (statusCode(e)) return "Opik returned HTTP " + statusCode(e) + ". Check the destination, workspace and its access settings, then retry.";
  if (e instanceof SyncFailure) return e.message;
  return "Opik did not confirm this step. Check the destination and retry to resume.";
}
class SyncFailure extends Error {}
function problem(message:string) { return new SyncFailure(message); }

export class OpikExperiments {
  readonly config:OpikConfiguration;
  private readonly db;
  private readonly makeApi:(c:Destination)=>NativeOpik;
  private api?:NativeOpik;
  private readonly pending=new Map<string,Promise<SyncReceipt>>();
  private get destination():Destination {
    if(!this.config.configured)throw Error("Set DASH_OPIK_API_URL before syncing a saved run.");
    return this.config;
  }
  constructor(private readonly bench:SyncStore, { env=localOpikEnvironment(process.env), makeApi=sdkApi }:SyncOptions = {}) {
    this.db=bench.db; this.config=configuration(env); this.makeApi=makeApi;
    this.db.exec(`CREATE TABLE IF NOT EXISTS opik_export_ids(destination TEXT,key TEXT,id TEXT NOT NULL,PRIMARY KEY(destination,key));
      CREATE TABLE IF NOT EXISTS opik_export_steps(destination TEXT,key TEXT,receipt TEXT NOT NULL,PRIMARY KEY(destination,key));
      CREATE TABLE IF NOT EXISTS opik_export_jobs(destination TEXT,run TEXT,state TEXT NOT NULL,receipt TEXT,owner TEXT,pid INTEGER,expires INTEGER,PRIMARY KEY(destination,run));`);
  }
  stableId(key:string):string {
    const dest=this.destination.key;
    const hit=this.db.prepare("SELECT id FROM opik_export_ids WHERE destination=? AND key=?").get(dest,key);
    if (hit) return z.string().parse(hit.id);
    this.db.prepare("INSERT OR IGNORE INTO opik_export_ids VALUES(?,?,?)").run(dest,key,generateId());
    return z.string().parse(this.db.prepare("SELECT id FROM opik_export_ids WHERE destination=? AND key=?").get(dest,key)?.id);
  }
  status(run:string):PublishState {
    if (!this.config.configured) return {configured:false,error:this.config.error};
    const {apiUrl,workspace,project,dashboard,key}=this.config;
    const row=this.db.prepare("SELECT state,receipt FROM opik_export_jobs WHERE destination=? AND run=?").get(key,run);
    const base={configured:true as const,apiUrl,workspace,project,hasDashboard:!!dashboard,active:this.pending.has(run)};
    if (!row || row.state==="syncing") return {...base,state:row?"syncing":"ready",receipt:null};
    const persisted:unknown=JSON.parse(z.string().parse(row.receipt));
    if(row.state==="synced")return {...base,state:"synced",receipt:syncReceipt.parse(persisted)};
    if(row.state==="partial")return {...base,state:"partial",receipt:z.object({error:z.string()}).parse(persisted)};
    throw Error("Unrecognized Opik sync state.");
  }
  sync(runId:string):Promise<SyncReceipt> {
    if (!this.config.configured) throw Error("Set DASH_OPIK_API_URL before syncing a saved run.");
    const pending=this.pending.get(runId);
    if (pending)return pending;
    const task=this.publish(runId).finally(()=>this.pending.delete(runId));
    this.pending.set(runId,task);
    return task;
  }
  async publish(runId:string):Promise<SyncReceipt> {
    const saved=this.bench.exportRun(runId);
    if (!terminal.has(saved.status)) throw Error("Wait for the run to finish before syncing.");
    const dest=this.destination.key, owner=randomUUID();
    const existing=this.status(runId);
    if (existing.configured && existing.state==="synced") return existing.receipt;
    const job=this.db.prepare("SELECT owner,pid,expires FROM opik_export_jobs WHERE destination=? AND run=?").get(dest,runId);
    if (typeof job?.owner==="string" && Number(job.expires)>Date.now()) {
      let alive=true;
      try { process.kill(Number(job.pid),0); } catch (e) { alive=!isRecord(e) || e.code!=="ESRCH"; }
      if (alive) throw Error("This run is already syncing in another DASH session.");
    }
    const claim=this.db.prepare(`INSERT INTO opik_export_jobs VALUES(?,?,'syncing',NULL,?,?,?)
      ON CONFLICT(destination,run) DO UPDATE SET state='syncing',receipt=NULL,owner=excluded.owner,pid=excluded.pid,expires=excluded.expires
      WHERE opik_export_jobs.state!='synced' AND opik_export_jobs.owner IS ?`).run(dest,runId,owner,process.pid,Date.now()+300000,job?.owner ?? null);
    if (!claim.changes) throw Error("Another session claimed this run. Refresh its sync status.");
    const checkpoint:Checkpoint=async (key,decode,action)=>{
      const lease=this.db.prepare("UPDATE opik_export_jobs SET expires=? WHERE destination=? AND run=? AND owner=?").run(Date.now()+300000,dest,runId,owner);
      if (!lease.changes) throw problem("Another session resumed this export.");
      const hit=this.db.prepare("SELECT receipt FROM opik_export_steps WHERE destination=? AND key=?").get(dest,key);
      if (hit) return decode.parse(JSON.parse(z.string().parse(hit.receipt)));
      const value=decode.parse(await action());
      this.db.prepare("INSERT OR IGNORE INTO opik_export_steps VALUES(?,?,?)").run(dest,key,JSON.stringify(value));
      return value;
    };
    const finish=(state:"synced"|"partial",data:SyncReceipt|{error:string})=>this.db.prepare("UPDATE opik_export_jobs SET state=?,receipt=?,owner=NULL,pid=NULL,expires=NULL WHERE destination=? AND run=? AND owner=?")
      .run(state,JSON.stringify(data),dest,runId,owner);
    try {
      const api=this.api ??= this.makeApi(this.destination);
      const receipt=await this.send(api,saved,checkpoint);
      finish("synced",receipt);
      return receipt;
    } catch (e) {
      const message=safeFailure(e);
      finish("partial",{error:message});
      throw Error(message);
    }
  }
  async registerPrompt(api:NativeOpik,m:RunManifest,step:Checkpoint) {
    if(m.fixture || !m.approvedPromptId)return null;
    const approvedId=m.approvedPromptId, approved=m.approvedPrompt, family=approved?.familyId || m.approvedPromptId;
    if(approved?.id && approved.id!==m.approvedPromptId)throw problem("The saved approval and prompt IDs differ.");
    const template=m.mode==="quick" ? m.prompt : m.effectiveSystem;
    if(typeof template!=="string" || !template.trim())throw problem("The approved candidate-visible prompt is missing from this saved run.");
    const variant:"quick-user"|"dataset-system"=m.mode==="quick"?"quick-user":"dataset-system";
    const name="DASH "+(m.mode==="quick"?"Quick prompt":"Dataset prompt")+" · "+digest([family,variant]).slice(0,20);
    const key="catalog-prompt/"+digest([family,m.approvedPromptId,variant,template]);
    return step(key,promptLink,async()=>{
      const id=this.stableId(key);
      let remote;
      try { remote=await api.prompts.getPromptVersionById(id,{},options); }
      catch(e) {
        if(statusCode(e)!==404)throw e;
        try {
          remote=await api.prompts.createPromptVersion({name,projectName:this.destination.project,templateStructure:"text",version:{
            id,template,type:"mustache",metadata:{dash_approved_prompt_id:m.approvedPromptId,dash_family_id:family,
              dash_revision:approved?.version ?? null,variant},tags:["DASH"],
          }},options);
        } catch(e) {
          if(statusCode(e)!==409)throw e;
          remote=await api.prompts.getPromptVersionById(id,{},options);
        }
      }
      if(!remote?.id || !remote.promptId || remote.template!==template ||
         remote.metadata?.dash_approved_prompt_id!==m.approvedPromptId || remote.metadata?.variant!==variant)
        throw problem("Opik did not confirm the approved candidate-visible prompt version.");
      return {id:remote.id,promptId:remote.promptId,name,commit:remote.commit ?? null,
        version:remote.versionNumber ?? null,approvedId:approvedId,revision:approved?.version ?? null,variant};
    });
  }
  async send(api:NativeOpik, saved:SavedRun, step:Checkpoint):Promise<SyncReceipt> {
    const m=saved.manifest, projectName=this.destination.project;
    // A decision score must have its matching model receipt. Reconcile against saved evidence without invoking a grader.
    const storedMetrics = saved.report?.metrics || [];
    const pins=m.graders || [];
    const auditedIds=new Set(pins.filter(g=>g.library || g.type==="decision" || g.type==="opik-metric").map(g=>g.id));
    const audited=auditedIds.size ? analyzeOutputs(saved).metrics.filter(metric=>auditedIds.has(metric.id)) : [];
    const metrics=[...storedMetrics.filter(metric=>!auditedIds.has(metric.id) && metric.method!=="decision-model"),...audited];
    const publishedPins=metrics.map(graderPin);
    const pinnedGraders=new Map(pins.map(g=>[g.id,g]));
    const privacy=decisionPrivacy(saved);
    const source=m.datasetId ? this.bench.dataset(m.datasetId) : null;
    const rows:CaseRow[]=source?.rows ?? [{case_id:"prompt",prompt:m.prompt ?? ""}];
    const byId=new Set(rows.map(r=>r.case_id));
    if(!rows.length || byId.size!==rows.length || m.caseIds.some(id=>!byId.has(id)))
      throw problem("The saved case snapshot is incomplete.");
    const metadata=m.datasetMetadata || source?.metadata;
    const family=source ? metadata?.family || source.id : m.approvedPrompt?.familyId || m.approvedPromptId || digest(m.prompt);
    const industry=m.industry || metadata?.industry || "Unclassified";
    const normalized=(value:string)=>value.trim().toLowerCase();
    const identity=digest([source?"dataset":"quick",normalized(industry),m.pack?.id || "",normalized(family)]);
    const snapshot=digest([m.datasetId || m.approvedPromptId || "quick",rows]);
    const provisionalId=this.stableId("dataset-family/"+identity), dsKey="dataset/"+provisionalId;
    const items=rows.map(row=>({source:"sdk" as const,data:caseData(row)}));
    const byCase=new Map(rows.map(r=>[r.case_id,r]));
    const binding=await step(dsKey+"/native-family",z.object({id:z.string(),projectId:z.string()}),()=>resolveDatasetFamily(api,{
      provisionalId,identity,snapshot,title:source?family:"Quick compare",pack:m.pack?.id || "",industry,
      project:projectName,workspace:this.destination.workspace,description:industry+" · "+(m.pack?.title || "Quick comparison prompts"),
      source:source ? metadata?.source ?? "" : "DASH Quick compare",datasetId:m.datasetId,parentId:metadata?.parentId ?? null,
    },problem));
    const currentDataset=await api.datasets.getDatasetById(binding.id,{},options);
    if(currentDataset.projectId!==binding.projectId)throw problem("The native dataset moved to a different project. No cases were changed.");
    const datasetId=binding.id,datasetName=currentDataset.name;
    const version=await step(dsKey+"/snapshot/"+snapshot,datasetVersion,()=>nativeVersion(api,datasetId,items,snapshot,{
      dash_dataset_id:m.datasetId || "", dash_dataset_version:m.datasetVersion || rows[0].dataset_version || "",
      dash_prompt_id:m.approvedPromptId || "",family:source?family:"Quick compare",industry,pack:m.pack?.id || "",
      split:m.split || rows[0].split || "quick",change_note:metadata?.changeNote || "",parent_snapshot:metadata?.parentId || "",
      category:metadata?.category || "",source:metadata?.source || "",dataset_tags:JSON.stringify(metadata?.tags || []),
    },options,problem));
    const promptVersion=await this.registerPrompt(api,m,step);
    const experiments:SyncReceipt["experiments"]=[];
    for(const candidate of m.candidates){
      const eid=this.stableId("experiment/"+m.id+"/"+candidate.id), prefix="experiment/"+eid;
      const name=privacy.label("DASH · "+m.title+" · "+candidate.model).slice(0,105)+" · "+m.id.slice(0,8)+"-"+eid.slice(-5);
      const experimentScores=metrics.flatMap(metric=>{
        const v=metric.values.find(v=>v.candidateId===candidate.id);
        return typeof v?.score==="number" && Number.isFinite(v.score)?[{name:privacy.label(nativeScoreName(metric,pinnedGraders.get(metric.id))),value:v.score}]:[];
      });
      await step(prefix+"/create",z.null(),async()=>{
        const e=await ensure(()=>api.experiments.getExperimentById(eid,{},options),
          ()=>api.experiments.createExperiment({id:eid,name,projectName,datasetName,datasetVersionId:version.id,status:"running",
            ...(promptVersion && {promptVersions:[{id:promptVersion.id}]}),
            metadata:privacy.metadata({dash_run_id:m.id,candidate_id:candidate.id,model:candidate.model,revision:candidate.revision,industry:m.industry,
              fixture:m.fixture,dataset_id:m.datasetId,dataset_version:m.datasetVersion,dataset_family:metadata?.family,pinned_dataset_metadata:metadata,case_set_hash:m.caseSetHash,approved_prompt_id:m.approvedPromptId,policy_hash:m.policyHash,
              token_budget:m.tokenBudget,run_status:saved.status,...(publishedPins.length && {dash_grader_revisions:publishedPins})}),tags:["DASH",...(m.fixture?["fixture"]:[])]},options));
        if(e.name!==name || (e.datasetId && e.datasetId!==datasetId))throw problem("An experiment ID did not match this candidate and dataset.");
        return null;
      });
      const traces:NativeTrace[]=[],spans:NativeSpan[]=[],links:NativeItem[]=[],scores:NativeScore[]=[];
      for(const result of saved.results.filter(r=>r.candidateId===candidate.id)){
        const data=byCase.get(result.caseId);
        if(!data)throw problem("A saved response has no matching source case.");
        const key=prefix+"/case/"+result.caseId, traceId=this.stableId(key+"/trace");
        const startTime=date(result.trace.started), tel=result.telemetry || {};
        const unconfirmed=result.dispatchState==="canceled" || result.dispatchState==="interrupted";
        const endTime=unconfirmed && !result.trace.finished ? undefined : date(result.trace.finished);
        let messages, provenance;
        if(!m.fixture && Array.isArray(result.dispatchedMessages)) {
          messages=result.dispatchedMessages;
          provenance="Recorded adapter request";
        } else {
          const legacySystem=m.effectiveSystem ?? (m.pack ? m.pack.system+"\nOutput schema: "+JSON.stringify(m.pack.outputSchema)+
            "\nReturn only the raw JSON object. Start with { and end with }. Omit Markdown code fences, labels, comments and surrounding prose." : null);
          messages=caseMessages({...m,effectiveSystem:legacySystem},data);
          if(!m.fixture && result.guardrail?.inputOptimization?.status==="compacted")
            messages=prepareInput(messages,true).messages;
          provenance=m.fixture ? "Fixture replay; reconstructed case only, no inference request" : result.error ?
            "Reconstructed legacy input; dispatch may have failed" : "Reconstructed from the saved run, case and input optimization";
        }
        const input={messages};
        const output={response:result.output ?? null,...(unconfirmed && {partial:true}),...(result.error && {error:privacy.label(result.error)})};
        const caseEvidence=metrics.flatMap(metric=>{
          const grade=metric.caseScores.find(row=>row.caseId===result.caseId)?.values.find(value=>value.candidateId===candidate.id);
          return grade ? [{metric,grade}] : [];
        });
        const decisionGraders=caseEvidence.flatMap(({metric,grade})=>grade.decision
          ? [{grader_id:metric.lineage?opaqueId(metric.id):metric.id,grader_version:metric.version,...grade.decision}] : []);
        const caseGrades=caseEvidence.map(({metric,grade})=>({...graderPin(metric),score:grade.score,pass:grade.pass,
          status:grade.score===null ? (grade.decision?.status==="review"?"abstained":"unscored") : grade.pass?"passed":"failed",
          ...(grade.opikMetric && {native_metric:grade.opikMetric})}));
        const trace:NativeTrace={id:traceId,projectName,name:result.caseId,startTime,endTime,input,output,source:"experiment",
          metadata:privacy.metadata({dash_trace_id:result.trace?.id,dash_steps:result.trace?.steps,case_id:result.caseId,candidate_id:candidate.id,
            actual_usage:tel,guardrail:result.guardrail,finish_reason:result.finishReason,fixture:m.fixture,
            input_provenance:provenance,dispatch_state:result.dispatchState,
            ...(caseGrades.length && {dash_grades:caseGrades}),...(!result.error && typeof result.score?.falseAccept==="boolean" && {dash_false_accept:result.score.falseAccept}),
            ...(decisionGraders.length && {dash_decision_graders:decisionGraders})})};
        if(typeof tel.first_token_ms==="number" && Number.isFinite(tel.first_token_ms))trace.ttft=tel.first_token_ms;
        traces.push(trace);
        if(!m.fixture && (!result.error || Array.isArray(result.dispatchedMessages) || result.telemetry?.input_tokens!=null)){
          const usage:Record<string,number>={};
          if(typeof tel.input_tokens==="number" && Number.isFinite(tel.input_tokens))usage.prompt_tokens=tel.input_tokens;
          if(typeof tel.output_tokens==="number" && Number.isFinite(tel.output_tokens))usage.completion_tokens=tel.output_tokens;
          if(usage.prompt_tokens!=null && usage.completion_tokens!=null)usage.total_tokens=usage.prompt_tokens+usage.completion_tokens;
          spans.push({id:this.stableId(key+"/span"),traceId,projectName,name:privacy.label(candidate.model),type:"llm",model:privacy.label(candidate.model),
            provider:candidate.provider,startTime,endTime,input,output,source:"experiment",usage,
            ...("cost_usd" in tel && typeof tel.cost_usd==="number" && Number.isFinite(tel.cost_usd) && {totalEstimatedCost:tel.cost_usd})});
        }
        links.push({id:this.stableId(key+"/item"),experimentId:eid,datasetItemId:version.caseIds[result.caseId],traceId,projectName});
        for(const {metric,grade:evidence} of caseEvidence){
          if(typeof evidence.score==="number" && Number.isFinite(evidence.score)) scores.push({id:traceId,projectName,name:privacy.label(nativeScoreName(metric,pinnedGraders.get(metric.id))),value:evidence.score,
            source:"sdk",reason:metric.builtIn ? privacy.label(evidence.reason) : (evidence.pass?"Passed pinned threshold.":"Below pinned threshold."),
            categoryName:metric.informational ? "diagnostic" : metric.method});
        }
      }
      const write=async <T,>(kind:string,items:T[],fn:(chunk:T[])=>Promise<unknown>)=>{
        for(const [i,chunk] of batches(items).entries()) await step(prefix+"/"+kind+"/"+i,z.null(),async()=>{await fn(chunk);return null;});
      };
      await write("traces",traces,chunk=>api.traces.createTraces({traces:chunk},options));
      await write("spans",spans,chunk=>api.spans.createSpans({spans:chunk},options));
      await write("links",links,async chunk=>{
        try { await api.experiments.createExperimentItems({experimentItems:chunk},options); }
        catch(e) {
          if(statusCode(e)!==409)throw e;
          // An acknowledged duplicate is safe only when the server confirms all three linked IDs.
          const remote=new Map<string,Pick<NativeItem,"experimentId"|"datasetItemId"|"traceId">>();
          for(let page=1;page<=Math.ceil(items.length/100);page++){
            const data=await api.datasets.findDatasetItemsWithExperimentItems(datasetId,{page,size:100,
              experimentIds:JSON.stringify([eid])},options);
            for(const row of data.content || [])for(const item of row.experimentItems || [])if(item.id && item.experimentId && item.datasetItemId && item.traceId)remote.set(item.id,{experimentId:item.experimentId,datasetItemId:item.datasetItemId,traceId:item.traceId});
          }
          const unresolved=chunk.filter(item=>{
            const found=item.id?remote.get(item.id):undefined;
            return !found || found.experimentId!==eid || found.datasetItemId!==item.datasetItemId || found.traceId!==item.traceId;
          });
          if(unresolved.length)throw problem("Opik has not confirmed all matching experiment items. Retry after indexing.");
        }
      });
      await write("scores",scores,chunk=>api.traces.scoreBatchOfTraces({scores:chunk},options));
      const status=saved.status==="completed"?"completed":saved.status==="failed"?"failed":"cancelled";
      await step(prefix+"/finish",z.null(),async()=>{await api.experiments.updateExperiment(eid,{body:{status,experimentScores}},options);return null;});
      experiments.push({id:eid,name,candidate:candidate.model,traces:traces.length,scores:scores.length});
    }
    return {runId:m.id,datasetId,datasetName,versionId:version.id,version:version.name,caseCount:rows.length,experiments,promptVersion,syncedAt:new Date().toISOString()};
  }
}


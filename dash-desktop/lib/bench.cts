import {domainStarters} from "./domain-starters.cjs";
import {exportDiagnostics,publicProviderError} from "./export-diagnostics.cjs";
import {DatabaseSync} from "node:sqlite";
import {z} from "zod";
import {randomUUID} from "node:crypto";
import * as os from "node:os";
import {loadPacks,parseDataset,grade,hash,packField} from "./packs.cjs";
import {Catalog} from "./catalog.cjs";
import * as providers from "./providers.cjs";
import {OutcomeWorkflow,contractHash} from "./outcome-workflow.cjs";
import {decodeRequest,type DesignContext,type PlanningPurpose,type PromptDraft,type MetricSuggestion} from "./outcome-contracts.cjs";
import {checkStructuredOutput} from "./quick-structure.cjs";
import {inspectionRangeReference,hasInspectionSource,isInspectionCheck,inspectionSourceConflict,inspectionSchemaIssue,suggestedInspectionGrader,inspectionReference,inspectionRuleId,inspectionRangeId,inspectionRangeKey,inspectionRuleKey,inspectionCaseReference,hasInspectionReferenceFor,inspectionEvidenceHelp} from "./inspection-decision.cjs";
import type {ApprovedPrompt} from "./outcome-contracts.cjs";
import {starterInspectionV1} from "./domain-starters.cjs";
import {referencePack,caseMessages as candidateMessages,graderEvidence,exactReference,caseJudgeSpec} from "./evaluation-cases.cjs";
import {canChallengeVerdict,SavedScoreReviews,reviewRequest,reviewResults} from "./saved-score-review.cjs";
import {checkLocalDecision} from "./decision-model.cjs";
import {quickVerdictIssue,scoringOptions} from "./score-readiness.cjs";
import {RunReports} from "./run-report.cjs";
import {isInformationalRule} from "./grader-catalog.cjs";
import {getOpikTemplate,opikLibraryTemplates,hasEvidence} from "./opik-library.cjs";
import type {GraderSpec} from "./graders.cjs";
import {Graders,generalDefaultKey,sdkEnabled} from "./graders.cjs";
import {Endpoints} from "./endpoints.cjs";
import {PlannerSettings} from "./planner-settings.cjs";
import {startPower} from "./power.cjs";
import {assessCase,lengthFailure,reasoningPolicy,autoOutputTarget,GuardrailError,type GuardrailDecision} from "./guardrail.cjs";
import {decodeManifest,decodeResult,decodeRunSummary,decodeDatasetSummary} from "./run-decode.cjs";
import {errorMessage,isCaseRow,jsonText,stringValue,statusValue} from "./run-types.cjs";
import type {CaseRow,DatasetCase,DatasetSnapshot,PackBundle,ScoredPack,RunPartial,RunCandidatePartial,RunLaneCursor,RunLaneProgress,RunData,RunDetail,RunManifest,CurrentManifest,StartRun,RunResult,RunStatus,ScenarioPack} from "./run-types.cjs";
import {scenarioCacheSupport,cachedInputTokenCount,ConfirmedInputMismatch, ProviderFailure, ProviderPreflightError, ProviderRejectedError} from "./runtime-types.cjs";
import type {Candidate,RuntimeAdapters,RuntimeInventory,FixtureCandidate,ModelLoadReceipt} from "./runtime-types.cjs";
import {decodeFieldAnswer,quickGradingReference,graderRequiredEvidence,parseFieldRule,requireAssessmentEvidence} from "./grader-types.cjs";
import {AssessmentStorageError} from "./grading-errors.cjs";
const datasetCaseTest = z.strictObject({
  grader:z.string().min(1).max(200),datasetId:z.string().min(1).max(200),
  caseId:z.string().min(1).max(200),output:z.string().min(1).max(100000),
});
class RunCheckpointError extends Error {}

function mergeCandidateUsage(previous:CandidateUsageSample|undefined, observation:CandidateUsage) {
  const keys=["inputTokens","outputTokens","approximateOutputTokens","firstTokenMs"] as const;
  const sample={...previous,revision:(previous?.revision ?? 0)+1};
  let changed=false;
  for (const key of keys) {
    const value=observation[key];
    if (typeof value!=="number" || !Number.isSafeInteger(value) || value<0 || value===previous?.[key]) continue;
    sample[key]=value;
    changed=true;
  }
  if (observation.approximateOutputTokens===null && previous?.approximateOutputTokens!=null) {
    delete sample.approximateOutputTokens;
    changed=true;
  }
  const reads=observation.cachedInputTokens!==undefined
    ? cachedInputTokenCount(sample.inputTokens,observation.cachedInputTokens)
    : sample.inputTokens===previous?.inputTokens ? previous?.cachedInputTokens : null;
  if ((reads ?? null)!==(previous?.cachedInputTokens ?? null)) {
    if (reads!=null) sample.cachedInputTokens=reads;
    else delete sample.cachedInputTokens;
    changed=true;
  }
  return changed ? sample : previous;
}

interface Job {id:string;mode:StartRun["mode"];revision:number;controller:AbortController;partial:RunPartial|null;lanes:Map<string,RunCandidatePartial>;done?:Promise<void>}
export const replayCandidate:FixtureCandidate = {
  id: "fixture/replay-v1",
  kind: "fixture",
  provider: "fixture",
  model: "Fixture replay",
  revision: "v1",
};
const now = () => new Date().toISOString();
// Digest of the original scorer source used in v2 manifests. Change this identity when scoring semantics change.
const scorerDigest = "8bfcc9968f5dfaf870ae94055d6a54da47b028bfa9cec947ce354efa8fc1197e";
const systemPrompt = (pack:ScoredPack) =>
  pack.system +
  "\nOutput schema: " +
  JSON.stringify(pack.outputSchema) +
  "\nReturn only the raw JSON object. Start with { and end with }. Omit Markdown code fences, labels, comments and surrounding prose.";

function countExpectedAnswers(rows:readonly CaseRow[],referenceField?:string):number {
  let count=0;
  for (const row of rows) {
    const expected=row.reference ?? row.gold;
    if (referenceField===undefined ? hasEvidence(expected) : packField(expected,referenceField)!==undefined) count++;
  }
  return count;
}
export class Bench {
  readonly db:DatabaseSync;
  readonly reports:RunReports;
  readonly packs:PackBundle[];
  readonly graders:Graders;
  readonly endpoints:Endpoints;
  readonly scoreReviews:SavedScoreReviews;
  readonly catalog:Catalog;
  readonly plannerSettings:PlannerSettings;
  readonly workflow:OutcomeWorkflow;
  designing=false;
  private modelLoad:{key:string;task:Promise<ModelLoadReceipt>}|null=null;
  private runtimeUsers=0;
  // SQLite can remain readable after a terminal write fails. Startup reconciles the durable row.
  private readonly unrecordedTerminals=new Set<string>();
  private latestRefresh?:Promise<RuntimeInventory[]>;
  get modelLoading():boolean {return this.modelLoad!==null;}
  servers:RuntimeInventory[]=[];
  active:Job|null=null;
  constructor(file:string, readonly adapters:RuntimeAdapters=providers, readonly powerSampler:typeof startPower=startPower) {
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, created TEXT, status TEXT, manifest TEXT); CREATE TABLE IF NOT EXISTS results(run TEXT,candidate TEXT,case_id TEXT,record TEXT,PRIMARY KEY(run,candidate,case_id)); CREATE TABLE IF NOT EXISTS datasets(id TEXT PRIMARY KEY,pack TEXT,name TEXT,rows TEXT);",
    );
    this.db.exec(`BEGIN IMMEDIATE;
      UPDATE results SET record=json_set(record,'$.dispatchState','interrupted',
          '$.error','Dispatch was checkpointed without a final response. The final candidate response is unknown.')
        WHERE run IN (SELECT id FROM runs WHERE status IN ('running','queued','failed'))
          AND json_extract(record,'$.dispatchState')='pending';
      UPDATE runs SET status='interrupted' WHERE status IN ('running','queued');
      COMMIT;`);
    this.db.exec("CREATE TABLE IF NOT EXISTS quick_expected_answers(run TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, answer TEXT NOT NULL)");
    this.reports = new RunReports(this.db);
    this.scoreReviews=new SavedScoreReviews(this.db);
    this.packs = loadPacks();
    for (const { pack, rows } of this.packs) if(pack.kind !== "reference")
      this.saveDataset(pack.id, pack.dataset, rows);
    this.packs.push({pack:referencePack, rows:[], replay:{}});
    this.graders = new Graders(this.db);
    this.db.exec("CREATE TABLE IF NOT EXISTS general_grader_defaults(metric TEXT PRIMARY KEY, grader_id TEXT NOT NULL REFERENCES graders(id))");
    this.endpoints = new Endpoints(this.db);
    this.catalog = new Catalog(this.db, this.packs);
    this.plannerSettings = new PlannerSettings(this.db,this.endpoints);
    this.workflow = new OutcomeWorkflow(this.db, adapters, {powerSampler:this.powerSampler,openaiFallback:()=>this.plannerSettings.fallback()});
    this.designing = false;
    this.servers = [];
    this.active = null;
  }
  saveDataset(pack:string, name:string, rows:DatasetCase[]) {
    const id = pack + "-" + hash(rows);
    this.db
      .prepare("INSERT OR IGNORE INTO datasets VALUES(?,?,?,?)")
      .run(id, pack, name, JSON.stringify(rows));
    return id;
  }
  pack(id:string) {
    const p = this.packs.find((x) => x.pack.id === id);
    if (!p) throw Error("Unknown scenario");
    return p;
  }
  previewImport(packId:string, text:string) {
    return parseDataset(text, this.pack(packId).pack);
  }
  import(packId:string, name:string, text:string, meta?:unknown) {
    return this.importRows(packId, name, this.previewImport(packId, text), meta);
  }
  importRows(packId:string, name:string, rows:DatasetCase[], meta?:unknown) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const id = this.saveDataset(packId, name, rows);
      this.catalog.register(id, packId, rows[0], meta ?? {
        family: name, category: "Uncategorized", source: name
      }, meta ? "import" : "legacy");
      this.db.exec("COMMIT");
      return id;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  dataset(id:string):DatasetSnapshot {
    const d = this.db.prepare("SELECT * FROM datasets WHERE id=?").get(id);
    if (!d) throw Error("Unknown dataset snapshot");
    const rows=jsonText(d.rows), meta=this.catalog.get(id);
    if(!Array.isArray(rows)||!rows.length||!rows.every(isCaseRow)||!meta)throw Error("Invalid saved dataset snapshot.");
    return {id:stringValue(d.id),pack:stringValue(d.pack),name:stringValue(d.name),metadata:meta,rows};
  }
  designPrompt(raw:unknown,onStage?:DesignContext["onStage"],purpose?:"draft"):Promise<PromptDraft>;
  designPrompt(raw:unknown,onStage:DesignContext["onStage"],purpose:"suggest"):Promise<MetricSuggestion>;
  designPrompt(raw:unknown,onStage:DesignContext["onStage"],purpose:PlanningPurpose):Promise<PromptDraft|MetricSuggestion>;
  async designPrompt(raw:unknown, onStage?:DesignContext["onStage"], purpose:PlanningPurpose = "draft") {
    if (this.modelLoading) throw Error("Wait for the LM Studio model load to finish before preparing a prompt.");
    const request=decodeRequest(raw);
    if (this.active || this.designing) throw Error("Wait for the current run or prompt preparation to finish.");
    this.designing = true;
    try {
      let context:DesignContext = {};
      if (request?.mode === "dataset") {
        const snapshot = this.dataset(stringValue(request.datasetId,"dataset ID"));
        const { id, title, description, system, outputSchema, metrics, scorer } = this.pack(snapshot.pack).pack;
        context = {
          datasetId: snapshot.id, industry: snapshot.metadata.industry,
          version: snapshot.rows[0].dataset_version, split: snapshot.rows[0].split,
          pack: { id, title, description, system, outputSchema, metrics, scorer },
          coverage:{
            cases:snapshot.rows.length,
            referenceCases:countExpectedAnswers(snapshot.rows),
            rubricCases:snapshot.rows.filter(row=>row.rubric?.trim()).length,
          },
        };
      }
      if (request?.sourceRunId)
        context.priorRun = this.refinementEvidence(request.sourceRunId, request.parentId);
      return await this.workflow.design(request, { ...context, onStage }, purpose);
    } finally {
      this.designing = false;
    }
  }
  refinementEvidence(id:string, approvedPromptId:string|null|undefined) {
    const saved = this.db.prepare("SELECT status,manifest FROM runs WHERE id=?").get(id);
    if (!saved || !approvedPromptId || decodeManifest(saved.manifest).approvedPromptId !== approvedPromptId)
      throw Error("Choose a saved run of the prompt revision you want to refine.");
    if (["running", "queued"].includes(statusValue(saved.status))) throw Error("Wait for this run to finish before refining it.");
    // Only aggregated observations go back into the planner. Case inputs, reference
    // answers, candidate text and judge rationales stay in the run record.
    const candidates = this.db.prepare(`SELECT candidate, COUNT(*) AS responses,
      SUM(json_extract(record,'$.error') IS NOT NULL) AS errors,
      COUNT(json_extract(record,'$.score.pass')) AS scored,
      SUM(json_extract(record,'$.score.pass')) AS passed,
      SUM(json_extract(record,'$.score.falseAccept')) AS falseAccepts,
      SUM(json_extract(record,'$.score.review')) AS sentForReview
      FROM results WHERE run=? GROUP BY candidate`).all(id);
    const graders = this.db.prepare(`SELECT candidate, json_extract(record,'$.name') AS grader,
      json_extract(record,'$.version') AS version, COUNT(json_extract(record,'$.pass')) AS scored,
      SUM(json_extract(record,'$.pass')) AS passed
      FROM assessments WHERE run=? GROUP BY candidate,json_extract(record,'$.graderId')`).all(id);
    const failure = decodeManifest(saved.manifest).guardrailFailure;
    const stopped = this.db.prepare("SELECT candidate, max(json_extract(record,'$.telemetry.output_tokens')) AS tokens FROM results WHERE run=? AND json_extract(record,'$.finishReason')='length' GROUP BY candidate").all(id);
    const constraint = failure ? {
      candidate:failure.candidateId,inputTokens:failure.inputTokens,contextTokens:failure.contextTokens,
      inputCap:failure.requestedInputCap, outputCap:failure.requestedOutputCap,
    } : null;
    return { id, status: saved.status, candidates, graders, ...(constraint && {tokenConstraint:constraint}), ...(stopped.length && {truncatedOutputs:stopped}) };
  }
  private configuredGeneralGraders():GraderSpec[] {
    return this.db.prepare("SELECT metric,grader_id FROM general_grader_defaults ORDER BY metric").all().flatMap(row => {
      const grader = this.graders.get(stringValue(row.grader_id));
      return generalDefaultKey(grader) === row.metric ? [grader] : [];
    });
  }
  setGeneralGraderDefault(id:string, enabled:boolean):void {
    const grader = this.graders.get(id);
    const key = generalDefaultKey(grader);
    if (!key) throw Error("Choose a cross-industry Opik metric or a local decision grader that can evaluate a prompt and response without a reference or agent trace.");
    if (enabled) this.db.prepare("INSERT INTO general_grader_defaults(metric,grader_id) VALUES(?,?) ON CONFLICT(metric) DO UPDATE SET grader_id=excluded.grader_id")
      .run(key,id);
    else this.db.prepare("DELETE FROM general_grader_defaults WHERE grader_id=?").run(id);
  }
  private automaticGraders(structured:boolean) {
    return [...this.graders.automatic(structured), ...this.configuredGeneralGraders()];
  }
  private sourcedInspection(approved:ApprovedPrompt|null) {
    if(approved?.mode!=="quick" || approved.domain!=="Manufacturing")return false;
    return hasInspectionSource(candidateMessages({prompt:approved.prompt,approvedPrompt:approved},{}),approved.objective);
  }
  private sourceGraders(approved:ApprovedPrompt){
    return [inspectionRuleId,inspectionRangeId].map(id=>this.graders.get(id)).filter(g=>!inspectionSchemaIssue(g,approved.outputSchema,starterInspectionV1));
  }
  quickExpectedAnswer(runId:string):string|null {
    const entry=this.db.prepare("SELECT answer FROM quick_expected_answers WHERE run=?").get(runId);
    return entry ? stringValue(entry.answer,"saved expected answer") : null;
  }
  quickGraderOptions(approvedPromptId:string) {
    const approved=this.workflow.get(approvedPromptId);
    const options = this.graders.quickOptions(approved, this.servers.flatMap(s => s.models));
    const automatic=this.automaticGraders(!!approved.outputSchema);
    const sourcedInspection=this.sourcedInspection(approved);
    const sources=sourcedInspection ? this.sourceGraders(approved) : [];
    const used=new Set<string>();
    const measures=options.measures.map(row=>{
      const id=suggestedInspectionGrader(row.metric,row.criterion);
      if(row.reason || !id || used.has(id) || !sources.some(g=>g.id===id))return row;
      used.add(id);
      return {...row,defaultGraderId:id};
    });
    if(!measures.length)automatic.push(...sources);
    const readiness=this.scoringOptions([...options.available,...automatic]);
    for(const g of options.available.filter(isInspectionCheck)){
      const issue=inspectionSchemaIssue(g,approved.outputSchema,sourcedInspection?starterInspectionV1:null);
      if(issue)readiness.setupIssues[g.id]=issue;
    }
    return {...options,measures,sourcedInspection,expectedAnswerVersion:1 as const,automatic,...readiness};
  }
  private scoringOptions(graders:GraderSpec[]) {
    return scoringOptions(graders,this.servers.filter(server=>server.online).flatMap(server=>server.models));
  }
  graderDatasetIds(graderId:string):string[] {
    const grader=this.graders.get(graderId);
    const snapshots=this.db.prepare("SELECT dataset_id, pack, json_extract(metadata,'$.industry') AS industry FROM dataset_catalog ORDER BY rowid");
    const ids:string[]=[];
    for (const row of snapshots.iterate()) {
      if (this.graders.appliesToDataset(grader,stringValue(row.industry),stringValue(row.pack))) ids.push(stringValue(row.dataset_id));
    }
    return ids;
  }
  async testGraderOnDatasetCase(raw:unknown) {
    const request=datasetCaseTest.safeParse(raw);
    if(!request.success)throw Error("Choose a saved grader, dataset and case and provide an answer of 1 to 100,000 characters.");
    const {grader:graderId,datasetId,caseId,output}=request.data;
    const grader=this.graders.get(graderId);
    if(grader.type!=="catalog" || !grader.library?.scenario)throw Error("Choose an industry catalog grader to test against a labeled case.");
    const dataset=this.dataset(datasetId);
    const pack=this.pack(dataset.pack).pack;
    if(pack.kind==="reference" || !this.graders.appliesToDataset(grader,dataset.metadata.industry,pack.id))
      throw Error("This grader needs a dataset from its own industry and scenario.");
    const row=dataset.rows.find(candidate=>candidate.case_id===caseId);
    if(!row)throw Error("Choose a case from the selected dataset snapshot.");
    const datasetCase={datasetId,datasetName:dataset.name,datasetVersion:row.dataset_version,
      caseId,scenarioId:pack.id,scenarioVersion:pack.version,contractHash:contractHash(pack)};
    const evidence={input:row.input,reference:row.gold,output,caseContext:{pack,row}};
    requireAssessmentEvidence(grader,evidence);
    return this.graders.record(grader,evidence,{caseId,datasetCase},this.adapters,AbortSignal.timeout(190000));
  }
  datasetGraderOptions(datasetId:string) {
    const dataset = this.dataset(datasetId);
    const pack = this.pack(dataset.pack).pack;
    const expectedAnswerCount=countExpectedAnswers(dataset.rows);
    const available=this.graders.list().filter(g=>this.graders.appliesToDataset(g,dataset.metadata.industry,pack.id));
    const fields=new Set(available.filter(g=>g.type==="field").map(g=>parseFieldRule(g.criteria).referenceField));
    const fieldCoverage=Object.fromEntries([...fields].map(field=>[field,countExpectedAnswers(dataset.rows,field)]));
    const automatic=this.automaticGraders(pack.outputSchema !== null);
    const inspectionCoverage=(ruleKey:string)=>{
      const check={type:"catalog",ruleKey};
      return dataset.rows.filter(row=>hasInspectionReferenceFor(check,inspectionCaseReference(check,row,pack))).length;
    };
    const inspectionCaseCount=inspectionCoverage(inspectionRuleKey), inspectionRangeCount=inspectionCoverage(inspectionRangeKey);
    return {...this.scoringOptions([...available,...automatic]),inspectionCaseCount,inspectionRangeCount,expectedAnswerCount,fieldCoverage,literalAnswerCount:dataset.rows.filter(row=>row.reference!=null).length,
      casesWithoutGuidance:dataset.rows.filter(row=>!hasEvidence(row.reference ?? row.gold) && !row.rubric).length,
      hasReferences:expectedAnswerCount>0,automatic,available};
  }
  graderRuns(id:string) {
    this.graders.get(id);
    return this.db.prepare(`SELECT r.id, r.created, json_extract(r.manifest,'$.title') AS title FROM runs r
      WHERE EXISTS (SELECT 1 FROM json_each(r.manifest,'$.graders') g WHERE json_extract(g.value,'$.id')=?)
         OR EXISTS (SELECT 1 FROM assessments a WHERE a.run=r.id AND json_extract(a.record,'$.graderId')=?)
      ORDER BY r.created DESC, r.id`).all(id,id)
      .map(row=>({id:stringValue(row.id),created:stringValue(row.created),title:stringValue(row.title)}));
  }
  async previewQuickBudget(approvedPromptId:string,candidateIds:string[]) {
    if (!Array.isArray(candidateIds) || candidateIds.length > 2 || new Set(candidateIds).size !== candidateIds.length)
      throw Error("Choose up to two distinct models.");
    const approved = this.workflow.get(approvedPromptId);
    if (approved.mode !== "quick") throw Error("Choose a Quick compare prompt.");
    const available = [...this.servers.flatMap(s=>s.models), ...this.endpoints.list()];
    const signal = AbortSignal.timeout(20000);
    return this.withRuntimeUse(()=>Promise.all(candidateIds.map(async candidateId=>{
      const candidate=available.find(c=>c.id===candidateId);
      if (!candidate) return {candidateId,status:"blocked" as const,message:"This model is unavailable. Refresh the starting line."};
      try {
        const {guardrail}=await assessCase({
          candidate,mode:"quick",messages:candidateMessages({prompt:approved.prompt,approvedPrompt:approved},{}),structured:approved.outputSchema,budget:approved,
          defaultOutput:providers.settings.maxTokens,checkInputBudget:this.adapters.checkInputBudget,signal,
        });
        return {candidateId,...guardrail};
      } catch (err) {
        return {candidateId,...(err instanceof GuardrailError ? err.guardrail : {status:"unverified" as const,message:"The token preview could not finish. DASH will check again at dispatch."})};
      }
    })));
  }
  async withRuntimeUse<T>(operation:()=>Promise<T>):Promise<T> {
    if (this.modelLoading) throw Error("Wait for the LM Studio model load to finish.");
    this.runtimeUsers++;
    try {return await operation();}
    finally {this.runtimeUsers--;}
  }
  loadLocalModel(key:string):Promise<ModelLoadReceipt> {
    if (this.modelLoad) return this.modelLoad.key===key ? this.modelLoad.task :
      Promise.reject(Error("Wait for the current LM Studio load to finish."));
    if (this.active) return Promise.reject(Error("Wait for the active evaluation to finish before loading a model into memory."));
    if (this.designing || this.runtimeUsers) return Promise.reject(Error("Wait for the current planning or runtime request to finish before loading a model."));
    const load=this.adapters.loadLocalModel?.bind(this.adapters);
    if (!load) return Promise.reject(Error("Model loading is unavailable on this runtime."));
    // Claim the slot synchronously, before any adapter can dispatch a request.
    const task=Promise.resolve().then(()=>load(key)).finally(async()=>{
      try {await this.refresh();}
      catch { /* Keep the original load receipt or error. A failed refresh clears the roster. */ }
      finally {this.modelLoad=null;}
    });
    this.modelLoad={key,task};
    return task;
  }
  refresh():Promise<RuntimeInventory[]> {
    // If inventory requests finish out of order, the older caller also receives the newer result.
    const current:Promise<RuntimeInventory[]>=Promise.resolve().then(()=>this.adapters.discover()).then(servers=>{
      if (this.latestRefresh && this.latestRefresh!==current) return this.latestRefresh;
      this.servers=servers;
      return servers;
    },error=>{
      if (this.latestRefresh && this.latestRefresh!==current) return this.latestRefresh;
      this.servers=[];
      throw error;
    });
    this.latestRefresh=current;
    return current;
  }
  list() {
    const datasets = this.db
      .prepare(
        "SELECT d.id,d.pack,d.name,json_array_length(d.rows) AS count, CASE WHEN d.pack='reference' THEN (SELECT COUNT(*) FROM json_each(d.rows) item WHERE json_extract(item.value,'$.reference') IS NULL AND json_extract(item.value,'$.rubric') IS NULL) ELSE 0 END AS casesWithoutReference, CASE WHEN d.pack='reference' THEN (SELECT COUNT(*) FROM json_each(d.rows) item WHERE json_extract(item.value,'$.rubric') IS NOT NULL) ELSE 0 END AS casesWithRubric,c.version,c.split,c.metadata,c.origin FROM datasets d JOIN dataset_catalog c ON c.dataset_id=d.id ORDER BY d.rowid",
      )
      .all();
    const runs = this.db
      .prepare(
        "SELECT id,created,status,json_extract(manifest,'$.title') AS title,json_extract(manifest,'$.mode') AS mode,json_extract(manifest,'$.fixture') AS fixture,json_extract(manifest,'$.industry') AS industry,json_extract(manifest,'$.datasetId') AS datasetId FROM runs ORDER BY created DESC",
      )
      .all();
    return {
      packs: this.packs.map(({pack})=>({...pack,starter:domainStarters.find(s=>s.packId===pack.id)})),
      datasets: datasets.map(decodeDatasetSummary),
      runs:runs.map(row=>{
        const summary=decodeRunSummary(row);
        return {...summary,status:this.visibleStatus(summary.id,summary.status)};
      }),
      prompts: this.workflow.list(),
      domainRoles: this.workflow.roles(),
      plannerFallback: this.plannerSettings.status(),
      servers: this.servers,
      endpoints: this.endpoints.list(),
      scenarioCacheSupport,
      graders: this.graders.list().map(grader=>({...grader,generalDefaultKey:generalDefaultKey(grader)})),
      generalGraderDefaults:this.configuredGeneralGraders().map(g=>g.id),
      opikLibraryTemplates,
      opikReady: sdkEnabled(),
      active: this.active?.id ?? null,
      device: os.platform() + " / " + os.arch(),
      fixtureId: replayCandidate.id,
    };
  }
  start({
    mode,
    datasetId,
    candidateIds,
    approvedPromptId,
    datasetScorer,
    caseJudgeId,
    inputCap,
    outputCap,
    caseId,
    parentId,
    graderIds = [],
    allowHostedDecision = false,
    outcomeRubric,
    measureGraders,
    inspectionOnly,
    expectedAnswer,
    animation = true,
  }:StartRun) {
    if (this.modelLoading) throw Error("Wait for the LM Studio model load to finish before starting a run.");
    if (this.scoreReviews.busy) throw Error("Wait for the saved-answer review to finish before starting an evaluation.");
    if (this.designing) throw Error("Wait for the prompt preparation to finish.");
    if (this.active)
      throw Error("A job is active. Stop it or wait for completion.");
    if (
      !["quick", "dataset"].includes(mode) ||
      !Array.isArray(candidateIds) ||
      candidateIds.length < 1 ||
      candidateIds.length > 2 ||
      (mode === "quick" && candidateIds.length !== 2) ||
      new Set(candidateIds).size !== candidateIds.length
    )
      throw Error(mode === "quick" ? "Choose two different models for the starting line." : "Select one or two distinct candidates.");
    if (inspectionOnly!==undefined && (inspectionOnly!==true || mode!=="quick")) throw Error("Answer inspection is available only in Quick compare.");
    if(measureGraders!==undefined && (mode!=="quick" || outcomeRubric!=null))
      throw Error("Use measure mappings on an approved Quick compare prompt without a combined outcome rubric.");
    if (expectedAnswer!==undefined && (mode!=="quick" || typeof expectedAnswer!=="string" || !expectedAnswer.trim() || expectedAnswer.length>12000))
      throw Error("For Quick compare, enter an expected answer or verified facts in 1 to 12,000 characters.");
    const verifiedAnswer=expectedAnswer?.trim();
    const all = [...this.servers.flatMap((s) => s.models), ...this.endpoints.list(), replayCandidate];
    const candidates = candidateIds.map((id) => {
      const c = all.find((x) => x.id === id);
      if (!c)
        throw Error("Refresh local runtimes and select an available model.");
      if (c.provider==="compatible" && c.needsKey) throw Error("Enter the session key for " + c.model + " before starting.");
      return c;
    });
    const fixture = candidateIds.includes(replayCandidate.id);
    if (fixture && (mode !== "dataset" || candidates.length !== 1))
      throw Error("Fixture replay requires a separate dataset run.");
    let original:RunManifest|null = null;
    if (parentId) {
      original = this.detail(parentId).manifest;
      if (mode !== "dataset" || original.mode !== mode || original.datasetId !== datasetId ||
          !caseId || !original.caseIds.includes(caseId) || original.fixture !== fixture ||
          !candidateIds.every(id => original?.candidates.some(candidate => candidate.id === id)))
        throw Error("Rerun a saved case using its original dataset and candidate.");
      if (approvedPromptId && approvedPromptId !== original.approvedPromptId)
        throw Error("A case rerun uses its original approved prompt.");
      approvedPromptId = original.approvedPromptId;
    }
    if (fixture && approvedPromptId) throw Error("A recorded replay uses its original saved responses.");
    if (mode === "quick" && !approvedPromptId && !original)
      throw Error("Approve a prompt before choosing models and starting the run.");
    const approved = approvedPromptId ? this.workflow.get(approvedPromptId) : null;
    if (approved && (approved.mode !== mode || approved.datasetId !== (datasetId || null)))
      throw Error("This prompt revision belongs to a different run type or dataset snapshot.");
    const prompt = approved?.prompt;
    let rows:CaseRow[], pack:ScenarioPack|null=null, replay:Record<string,unknown>={}, dataset:DatasetSnapshot|null=null;
    if (mode === "dataset") {
      dataset = this.dataset(stringValue(datasetId,"dataset ID"));
      const bundle = this.pack(dataset.pack);
      pack = original?.pack ?? bundle.pack;
      if (approved && (approved.packId !== pack.id || approved.contractHash !== contractHash(pack)))
        throw Error("The scenario contract has changed. Prepare and approve a prompt for this version.");
      if (pack.kind === "reference" && approved) throw Error("This dataset supplies each case prompt directly.");
      replay = bundle.replay;
      if (fixture && datasetId !== pack.id + "-" + hash(bundle.rows))
        throw Error(
          "Fixture replay is available for the bundled dataset only.",
        );
      rows = caseId
        ? dataset.rows.filter((r) => r.case_id === caseId)
        : dataset.rows;
      if (!rows.length) throw Error("Unknown case.");
    } else {
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 24000)
        throw Error("Enter a prompt up to 24,000 characters.");
      rows = [{ case_id: "prompt", input: { text: prompt } }];
    }
    const pinnedGraders = original?.graders ?? this.graders.select(graderIds);
    const outputSchema=pack?.outputSchema ?? approved?.outputSchema;
    const defaults = original ? [] : this.automaticGraders(!!outputSchema);
    const sourcedInspection=this.sourcedInspection(approved);
    const measurePolicy=approved && !!(approved.metricCriteria ?? approved.metricAudit) && approved.metrics.length>0;
    if(!original && approved && sourcedInspection && !inspectionOnly && !measurePolicy)defaults.push(...this.sourceGraders(approved));
    if (dataset) {
      const applied=[...pinnedGraders,...defaults];
      const coverage=new Map<string|undefined,number>();
      for (const grader of applied) {
        if (!graderRequiredEvidence(grader).includes("reference")) continue;
        if(isInspectionCheck(grader)){
          const missing=rows.find(row=>!hasInspectionReferenceFor(grader,inspectionCaseReference(grader,row,pack)));
          if(missing)throw Error("Case "+missing.case_id+" needs verified inspection evidence. "+inspectionEvidenceHelp(grader));
          continue;
        }
        const field=grader.type==="field" ? parseFieldRule(grader.criteria).referenceField : undefined;
        const labeled=coverage.get(field) ?? countExpectedAnswers(rows,field);
        coverage.set(field,labeled);
        const requirement=field ? "an expected JSON answer containing the field "+field : "an expected answer";
        if (labeled<rows.length) throw Error(grader.name+" needs "+requirement+" for every selected case. "+
          labeled+" of "+rows.length+" have one. Import a dataset version with the missing answers, remove the grader, or disable its automatic use in Graders.");
      }
      if (applied.some(g=>graderRequiredEvidence(g).includes("trajectory")))
        throw Error("This grader needs recorded agent actions. Choose a model-response grader for this dataset, or supply agent steps in Test one output.");
    }
    if (!original && dataset && pack) {
      const industry=dataset.metadata.industry, scenario=pack.id;
      if (pinnedGraders.some(g=>!this.graders.appliesToDataset(g,industry,scenario)))
        throw Error("A selected grader does not apply to this dataset’s industry or scenario.");
    }
    const hostedDecision = pinnedGraders.some(g => g.type === "decision" && g.decision.provider === "openrouter");
    if (hostedDecision && allowHostedDecision !== true)
      throw Error("Confirm the OpenRouter decision grader and the evidence it will receive for this run.");
    if (pack?.kind === "reference") {
      datasetScorer = original?.datasetScorer ?? datasetScorer ?? "selected-graders";
      if (!["selected-graders","exact-reference"].includes(datasetScorer)) throw Error("Choose a reference scoring method.");
      if (datasetScorer === "exact-reference" && rows.some(r=>r.reference==null || r.rubric))
        throw Error("Exact matching requires a reference on every case and no case rubric. Choose a rubric judge instead.");
      const selected = pinnedGraders;
      if (caseJudgeId && !original) {
        if (rows.some(row=>!hasEvidence(row.reference) && !row.rubric)) throw Error("Some cases supply only an input. Choose a saved grader with its own success criteria.");
        if (datasetScorer !== "selected-graders") throw Error("Choose reference and rubric scoring to use a case judge.");
        const judge=this.servers.flatMap(s=>s.models).find(m=>m.id===caseJudgeId);
        selected.push(caseJudgeSpec(judge));
      }
      const needsIndependentCriteria = rows.some(row=>!hasEvidence(row.reference) && !row.rubric);
      const eligibleBusinessGrader = [...selected,...defaults].some(g=>{
        if (g.type==="catalog" && isInformationalRule(g.ruleKey)) return false;
        if (!needsIndependentCriteria) return true;
        if (g.type==="field") return true; // Each row's required field was checked above, including literal null.
        if (g.type==="trajectory") return false;
        if (g.type==="decision") return !g.requiredEvidence?.length;
        return g.type!=="opik-metric" || !getOpikTemplate(g.metricKey).requiresReference;
      });
      if (!original && datasetScorer === "selected-graders" && !eligibleBusinessGrader)
        throw Error("Choose a grader that can evaluate the saved case responses with the available evidence.");
      if (rows.some(r=>r.rubric) && !selected.some(g=>g.type==="judge" ||
        (g.type==="opik" && (original || (g.evidenceView ?? "case")==="case")) ||
        (g.type==="decision" && (g.decisionView ?? "case")==="case")))
        throw Error("Choose a local LLM or Opik judge, or a decision grader, to evaluate the case-level rubrics.");
    } else datasetScorer = pack ? "scenario" : null;
    const caps = original?.tokenBudget ?? (approved || {inputCap,outputCap});
    for (const cap of [caps.inputCap, caps.outputCap]) {
      if (cap != null && (!Number.isSafeInteger(cap) || cap < 1 || cap > 1000000)) throw Error("Token limits must be whole numbers from 1 to 1,000,000.");
    }
    const effectiveSystem = pack && pack.kind !== "reference" ? (approved ? approved.prompt +
      "\n\nRequired scenario instructions and output format (apply to every case):\n" : "") + systemPrompt(pack) : null;
    const id = randomUUID();
    const manifest:CurrentManifest = {
      format: 2,
      executionMode:candidates.length===2 ? "parallel-lanes" : "single-lane",
      ...(inspectionOnly && {inspectionOnly}),
      id,
      created: now(),
      mode,
      fixture,
      graders: pinnedGraders,
      ...(original?.taskAnswerDecisionGraderIds && {taskAnswerDecisionGraderIds:original.taskAnswerDecisionGraderIds}),
      title: pack?.kind==="reference" ? dataset?.metadata.family ?? pack.title : pack?.title || approved?.title || "Quick compare",
      approvedPromptId: approved?.id ?? null,
      approvedPrompt: approved,
      objective: approved?.objective ?? pack?.description ?? null,
      effectiveSystem,
      datasetScorer,
      promptSource: fixture ? "recorded" : approved ? "approved-variant" : "dataset",
      tokenBudget: { inputCap: caps.inputCap ?? null, outputCap: caps.outputCap ?? null },
      pack,
      datasetId: dataset?.id ?? null,
      industry: dataset?.metadata?.industry ?? approved?.domain ?? null,
      datasetMetadata: dataset?.metadata ?? null,
      datasetVersion: rows[0].dataset_version ?? null,
      split: rows[0].split ?? null,
      caseIds: rows.map((r) => r.case_id),
      candidates,
      policyHash: original ? original.policyHash : pack ? hash([pack, scorerDigest, datasetScorer, pinnedGraders.map(g=>g.id)]) : null,
      promptHash: hash(pack ? [effectiveSystem, rows.map(r=>candidateMessages({pack,effectiveSystem},r))] :
        approved?.outputSchema ? [candidateMessages({prompt,approvedPrompt:approved},{}),approved.outputSchema] : prompt),
      caseSetHash: hash(rows),
      prompt: mode === "quick" ? prompt ?? null : null,
      invocations: candidates.map((c) => ({
        candidateId: c.id,
        adapter:
          c.provider === "lmstudio" && c.loaded && this.adapters.checkInputBudget
            ? "LM Studio SDK · verified model template"
            : c.provider === "lmstudio" && mode === "dataset" && c.nativeChat
            ? "LM Studio native chat"
            : c.provider === "lmstudio"
              ? "LM Studio chat completions"
              : c.provider,
        template: fixture ? null : "Runtime model chat template",
        reasoning: reasoningPolicy(c, {
          mode, outputCap: caps.outputCap, structured: outputSchema, verifiedAdapter: !!this.adapters.checkInputBudget,
        }),
      })),
      outputPolicy: fixture ? null : {mode:caps.outputCap == null ? "automatic" : "explicit", automaticTarget:autoOutputTarget, providerFallback:providers.settings.maxTokens},
      parameters: fixture ? {} : { ...providers.settings, maxTokens: caps.outputCap ?? original?.parameters?.maxTokens ?? providers.settings.maxTokens },
      device: {
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
      },
      animation: !!animation,
      ...(hostedDecision && {hostedDecisionApproved: true}),
      replayHash: fixture ? hash(replay) : null,
      parentId: parentId || null,
    };
    const insertRun = () => {
      if (!original) {
        const selected = new Set(manifest.graders.map(g=>g.id));
        const addedDefaults = defaults.filter(g=>!selected.has(g.id));
        manifest.graders = [...manifest.graders, ...addedDefaults];
        const taskAnswerIds = addedDefaults.filter(g=>g.type==="decision").map(g=>g.id);
        if (taskAnswerIds.length) manifest.taskAnswerDecisionGraderIds = taskAnswerIds;
        // Structural diagnostics are pinned and exported, but do not change the business scoring policy.
        if (pack && defaults.some(g=>g.type==="opik-metric" || g.type==="decision")) {
          const quality = manifest.graders.filter(g=>!g.library?.automatic);
          const policy = [pack, scorerDigest, datasetScorer, quality.map(g=>g.id)];
          manifest.policyHash = hash(taskAnswerIds.length ? [...policy,{taskAnswerDecisionGraderIds:taskAnswerIds}] : policy);
        }
      }
      const readiness=this.scoringOptions(manifest.graders);
      const unavailable=Object.values(readiness.setupIssues)[0];
      if (unavailable) throw Error(unavailable);
      if (mode==="quick" && !inspectionOnly && approved) {
        const issue=quickVerdictIssue(approved,manifest.graders,manifest.measureGraders,!!outcomeRubric);
        if (issue) throw Error(issue);
      }
      this.db.prepare("INSERT INTO runs VALUES(?,?,?,?)").run(id, manifest.created, "queued", JSON.stringify(manifest));
    };
    if (mode === "quick") {
      if(!approved)throw Error("Choose an approved Quick compare prompt.");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const models=this.servers.flatMap(s=>s.models);
        if(measureGraders===undefined)manifest.graders=this.graders.resolveQuick(approved,manifest.graders,outcomeRubric,models);
        else {
          const resolved=this.graders.resolveMeasureGraders(approved,manifest.graders,measureGraders,models);
          manifest.graders=resolved.graders;
          manifest.measureGraders=resolved.mappings;
          if(manifest.graders.some(g=>g.type==="decision" && g.decision.provider==="openrouter")){
            if(allowHostedDecision!==true)throw Error("Confirm the OpenRouter decision grader and the evidence it will receive for this run.");
            manifest.hostedDecisionApproved=true;
          }
        }
        const checks=[...manifest.graders,...defaults];
        for(const g of checks.filter(isInspectionCheck)){
          if(sourcedInspection && inspectionSourceConflict(verifiedAnswer))throw Error("The supplied inspection reference disagrees with the approved inspection source. Review the task or its expected answer before GO.");
          const issue=inspectionSchemaIssue(g,approved.outputSchema,sourcedInspection?starterInspectionV1:verifiedAnswer);
          if(issue)throw Error(issue);
        }
        const missingCheck=checks.find(g=>isInspectionCheck(g) && !sourcedInspection && !hasInspectionReferenceFor(g,verifiedAnswer));
        if(missingCheck)throw Error(inspectionEvidenceHelp(missingCheck));
        const needsExpectedAnswer=checks.some(g=>graderRequiredEvidence(g).includes("reference") && !(isInspectionCheck(g) && sourcedInspection));
        if (needsExpectedAnswer && !verifiedAnswer)
          throw Error("Add an expected answer or verified facts in Graders before GO, or choose a grader that uses the task and model answer alone.");
        if (!needsExpectedAnswer && verifiedAnswer)
          throw Error("The selected graders do not use an expected answer. Refresh the grading setup before GO.");
        insertRun();
        if (verifiedAnswer) this.db.prepare("INSERT INTO quick_expected_answers(run,answer) VALUES(?,?)").run(id,verifiedAnswer);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } else {
      insertRun();
    }
    const job:Job = { id, mode, revision:0, controller: new AbortController(), partial: null,lanes:new Map() };
    this.active = job;
    job.done = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.execute(job, manifest, rows, replay))
      .catch(() => {
        // Even the terminal database update can fail. Startup reconciles any still-open record.
        console.error("DASH could not persist the final state or report for run " + id + ".");
      })
      .finally(() => { this.active = null; });
    return id;
  }
  async execute(job:Job, m:CurrentManifest, rows:CaseRow[], replay:Record<string,unknown>) {
    const fatal=new AbortController();
    const signal=AbortSignal.any([job.controller.signal,fatal.signal]);
    const fail=(error:unknown)=>{if(!fatal.signal.aborted)fatal.abort(error);};
    let nextResultIndex=0;
    const status = (value:RunStatus) => {
      try {
        if(value==="running")this.db.prepare("UPDATE runs SET status=? WHERE id=?").run(value,m.id);
        else this.db.prepare("UPDATE runs SET status=?,manifest=? WHERE id=?").run(value,JSON.stringify(m),m.id);
      }
      catch (cause) {throw new RunCheckpointError("DASH could not save the run status. Check available storage and workspace access.",{cause});}
    };
    let errors = 0;
    try {
      const writeResult=this.db.prepare(`INSERT INTO results VALUES(?,?,?,?)
        ON CONFLICT(run,candidate,case_id) DO UPDATE SET record=excluded.record`);
      const saveResult=(result:RunResult)=>{
        try {
          // Case links use numeric indices. An earlier pending dispatch must not displace a visible result.
          if(m.executionMode==="parallel-lanes" && result.dispatchState!=="pending")result.finalizedIndex ??= nextResultIndex++;
          writeResult.run(m.id,result.candidateId,result.caseId,JSON.stringify(result));
          if (result.dispatchState!=="pending") job.revision++;
        } catch (cause) {
          const error=new RunCheckpointError("Could not persist a case checkpoint. The job stopped.",{cause});fail(error);throw error;
        }
      };
      status("running");
      job.revision++;
      // Complete all lane/case checks before generating the first candidate response.
      const decisions = new Map<string,Map<string,GuardrailDecision>>();
      const nativePolicies=new Set<string>();
      for (const grader of m.graders) {
        if(grader.type!=="decision" || grader.decision.provider!=="local")continue;
        const {endpoint,protocol,model,fallbackModel}=grader.decision;
        const key=JSON.stringify([endpoint,protocol,model,fallbackModel]);
        if(nativePolicies.has(key))continue;
        nativePolicies.add(key);
        try {await checkLocalDecision(grader.decision,AbortSignal.any([signal,AbortSignal.timeout(5000)]));}
        catch {throw Error(grader.name+" could not verify its local decision model. Start its decision server, verify the saved model and refresh the run setup. No candidate requests were sent.");}
      }
      if (!m.fixture) {
        for (const candidate of m.candidates) {
          const cases = new Map<string,GuardrailDecision>();
          decisions.set(candidate.id, cases);
          for (const row of rows) {
            signal.throwIfAborted();
            try {
              const decision = await assessCase({
                candidate, messages: candidateMessages(m, row), serializedCaseInput: !!m.pack && m.pack.kind !== "reference" && !row.prompt && !row.messages,
                mode: m.mode, structured: m.pack?.outputSchema ?? m.approvedPrompt?.outputSchema, budget: m.tokenBudget,
                defaultOutput: m.parameters.maxTokens ?? providers.settings.maxTokens, checkInputBudget: this.adapters.checkInputBudget, signal,
              });
              cases.set(row.case_id, decision);
            } catch (error) {
              if (error instanceof GuardrailError)
                m.guardrailFailure = { ...error.guardrail, candidateId: candidate.id, caseId: row.case_id };
              throw Error(candidate.model + " · " + row.case_id + " — " + errorMessage(error));
            }
          }
        }
      }
      const runLane=async(c:Candidate)=>{
        for (const row of rows) {
          if (signal.aborted) break;
          const trace:RunResult["trace"] = {
            id: randomUUID(),
            runId: m.id,
            candidateId: c.id,
            caseId: row.case_id,
            started: now(),
            steps: [],
          };
          const rec:RunResult = {
            candidateId: c.id,
            caseId: row.case_id,
            trace,
            output: null,
            score: null,
            error: null,
            telemetry: null,
          };
          const decision=decisions.get(c.id)?.get(row.case_id);
          const checkedInputTokens=decision?.receipt?.tokens;
          const lane:RunCandidatePartial={candidateId:c.id,caseId:row.case_id,startedAt:trace.started,text:"",...(checkedInputTokens!=null && {checkedInputTokens})};
          job.lanes.set(c.id,lane);
          let observedOutput = false;
          if (!m.fixture) job.revision++;
          const candidateStep={at:now(),action:m.fixture ? "Read recorded fixture response" : "Invoke "+c.provider};
          trace.steps.push(candidateStep);
          try {
            if (m.fixture) {
              rec.output = JSON.stringify(replay[row.case_id]);
              observedOutput = typeof rec.output === "string";
            }
            else {
              if(!decision || c.provider==="fixture")throw Error("Missing dispatch plan");
              const { receipt: inputBudget, guardrail, preparedMessages } = decision;
              const messages = preparedMessages ?? candidateMessages(m, row);
              rec.guardrail = guardrail;
              trace.steps.unshift({ at: trace.started, action: "Check model capacity", guardrail });
              if (inputBudget) rec.inputBudget = { cap: m.tokenBudget.inputCap, tokens: inputBudget.tokens, source: inputBudget.source };
              const powerUnavailable=()=>trace.steps.push({ at:now(),action:"Device power measurement unavailable" });
              let finishPower:Awaited<ReturnType<typeof startPower>>|undefined;
              if(m.executionMode!=="parallel-lanes") {
                try {finishPower=await this.powerSampler();} catch {powerUnavailable();}
              }
              let observing=true;
              let lastCheckpoint=-Infinity;
              // The native SDK catches exceptions from fragment handlers. A request-local
              // signal retains the first storage error even when the adapter later resolves.
              const checkpointAbort = new AbortController();
              try {
                signal.throwIfAborted();
                rec.dispatchedMessages = messages;
                rec.dispatchState = "pending";
                saveResult(rec);
                const response = await this.adapters.invoke(c, messages, {
                  signal: AbortSignal.any([signal, checkpointAbort.signal]),
                  apiKey: this.endpoints.keys.get(c.id),
                  ...(m.pack && m.pack.kind !== "reference" && m.effectiveSystem && {sharedScenarioSystem:m.effectiveSystem}),
                  maxTokens: guardrail.outputReserve,
                  inputBudget,
                  structured: m.pack?.outputSchema ?? m.approvedPrompt?.outputSchema,
                  ...(m.approvedPrompt?.outputSchema && {strictSchema:true}),
                  onCandidateUsage: observed => {
                    if (!observing || signal.aborted) return;
                    lane.usage=mergeCandidateUsage(lane.usage,observed);
                  },
                  onText: text => {
                    if (!observing || signal.aborted) return;
                    if (job.mode==="quick") lane.text=text;
                    rec.output=text;
                    // Store the first visible response and at most one update per second.
                    const elapsed=performance.now();
                    if (elapsed-lastCheckpoint>=1000) {
                      try {
                        saveResult(rec);
                        lastCheckpoint=elapsed;
                      } catch (error) {
                        observing=false;
                        checkpointAbort.abort(error);
                      }
                    }
                  },
                }).catch((error:unknown) => {
                  if (!(error instanceof ConfirmedInputMismatch)) throw error;
                  rec.error=error.message;
                  return error.response;
                });
                checkpointAbort.signal.throwIfAborted();
                observing=false;
                trace.finished=now();
                delete rec.dispatchState;
                rec.output=response.output;
                observedOutput=true;
                rec.finishReason=response.finishReason ?? null;
                rec.reportedFinishReason=response.reportedFinishReason === undefined ? rec.finishReason : response.reportedFinishReason;
                rec.telemetry=response.telemetry && {...response.telemetry};
                if(m.executionMode==="parallel-lanes" && rec.telemetry)delete rec.telemetry.device_power;
                if (m.tokenBudget.inputCap != null && (response.telemetry?.input_tokens ?? 0) > m.tokenBudget.inputCap)
                  rec.error??="The runtime reported input usage above the approved cap.";
                else if ((response.telemetry?.output_tokens ?? 0) > guardrail.outputReserve)
                  rec.error??=`The runtime reported ${response.telemetry.output_tokens} output tokens above its ${guardrail.outputReserve}-token allocation.`;
                else if (rec.finishReason === "length") rec.error??=lengthFailure(guardrail, rec.telemetry);
                else if (!rec.output.trim()) rec.error??="Provider completed without visible response content.";
                if (!rec.error && m.approvedPrompt?.outputSchema) {
                  rec.structuredOutputCheck=checkStructuredOutput(rec.output,m.approvedPrompt.outputSchema);
                  trace.steps.push({at:now(),action:rec.structuredOutputCheck.valid ? "Approved JSON contract passed" : "Approved JSON contract failed"});
                }
                // A confirmed answer belongs on disk before any sensor read, grader, or report.
                saveResult(rec);
                if (rec.error) throw Error(rec.error);
              } catch (error) {
                observing=false;
                checkpointAbort.signal.throwIfAborted();
                if (error instanceof RunCheckpointError) throw error;
                if (rec.dispatchState === "pending") {
                  if ((error instanceof ProviderRejectedError || error instanceof ProviderPreflightError) && rec.output == null) {
                    trace.finished=now();
                    delete rec.dispatchState;
                    if (error instanceof ProviderPreflightError) {
                      candidateStep.action="Prepare candidate request";
                      delete rec.dispatchedMessages;
                      trace.steps.push({at:now(),action:"The runtime check ended before candidate inference was sent"});
                    }
                    rec.error=error.message;
                  } else {
                    rec.dispatchState=job.controller.signal.aborted ? "canceled" : "interrupted";
                    rec.error=job.controller.signal.aborted ? "Observation canceled after dispatch. The final candidate response is unknown." :
                      "Observation interrupted after dispatch. The final candidate response is unknown.";
                    trace.steps.push({at:now(),action:"DASH stopped observing this request"});
                    if (!signal.aborted && error instanceof ProviderFailure)
                      trace.steps.push({at:now(),action:publicProviderError(error.message)});
                  }
                  saveResult(rec);
                }
                throw error;
              } finally {
                if (finishPower) {
                  try { rec.telemetry={...rec.telemetry,device_power:await finishPower()}; }
                  catch { powerUnavailable(); }
                }
              }
            }
            if (!signal.aborted && m.pack && m.datasetScorer !== "selected-graders") {
              try {
                if (m.datasetScorer === "exact-reference") rec.score = await exactReference(row,rec.output);
                else if(m.pack.kind !== "reference") rec.score = grade(m.pack,row,rec.output);
                trace.steps.push({at:now(),action:"Grade with " + m.pack.scorer});
              } catch {
                rec.gradingError="The pinned dataset scorer could not evaluate this case. Check the reference and scorer revision.";
                trace.steps.push({at:now(),action:rec.gradingError});
              }
            }
          } catch (e) {
            if (e instanceof RunCheckpointError) throw e;
            if (signal.aborted && !rec.dispatchedMessages && !trace.finished) break;
            errors++;
            rec.error ??= errorMessage(e);
          }
          if (!rec.dispatchState) trace.finished ??= now();
          saveResult(rec);
          if (!signal.aborted && observedOutput) {
            for (const scorer of m.graders || []) {
              if (signal.aborted) break;
              if (rec.error && !scorer.library?.automatic) continue;
              job.lanes.set(c.id,{candidateId:c.id,caseId:row.case_id,text:"",startedAt:trace.started,
                grading:{name:scorer.name,version:scorer.version,startedAt:now()}});
              job.revision++;
              const evidence = graderEvidence(m,row,rec,scorer.type === "catalog",scorer.id);
              if (m.mode==="quick" && graderRequiredEvidence(scorer).includes("reference"))
                evidence.reference=quickGradingReference(scorer,this.quickExpectedAnswer(m.id));
              await this.graders.record(scorer,evidence,
                {run:m.id,candidate:c.id,caseId:row.case_id},this.adapters,signal,m.hostedDecisionApproved === true);
              job.revision++;
            }
          }
        }
      };
      // The validated starting line has at most two workers. A fatal write stops both;
      // allSettled keeps the job and its shared sensor owned until every worker exits.
      let finishShared:Awaited<ReturnType<typeof startPower>>|undefined;
      if(m.executionMode==="parallel-lanes" && !signal.aborted) {
        try {finishShared=await this.powerSampler(undefined,1000,"aggregate");} catch { /* No host observation available. */ }
      }
      try {
        await Promise.allSettled(m.candidates.map(async c=>{
          try {await runLane(c);}
          catch(error){fail(error);}
          finally {job.lanes.delete(c.id);job.revision++;}
        }));
        fatal.signal.throwIfAborted();
      } finally {
        if(finishShared) {
          try {
            const p=await finishShared();
            m.sharedDevicePower={scope:p.scope,source:p.source,samples:p.sampleCount ?? p.samples.length,average_w:p.average_w,peak_w:p.peak_w,
              sampled_seconds:p.sampled_seconds,estimated_energy_j:p.estimated_energy_j};
          } catch { /* Missing sensor data cannot invalidate saved candidate answers. */ }

        }
      }
      if (!m.fixture && !errors && !signal.aborted && typeof this.adapters.reportStage === "function") {
        const completed:RunData = { ...this.detail(m.id), status: "completed" };
        await this.reports.finalize(completed, this.adapters, signal, stage => {
          job.partial = { stage, text: "" };
          job.revision++;
        });
      }
      status(signal.aborted ? "canceled" : errors ? "failed" : "completed");
    } catch (e) {
      try {
        if (job.controller.signal.aborted && !fatal.signal.aborted && !(e instanceof RunCheckpointError) && !(e instanceof AssessmentStorageError)) status("canceled");
        else {
          m.error = errorMessage(e);
          this.db.prepare("UPDATE runs SET status='failed', manifest=? WHERE id=?").run(JSON.stringify(m), m.id);
        }
      } catch {
        this.unrecordedTerminals.add(m.id);
        throw new RunCheckpointError("DASH could not persist the terminal run status.");
      }
    }
    // Save the terminal report even if the user never opens the run. If this cache write fails,
    // the original case evidence and terminal status are durable and detail() can rebuild it.
    this.detail(m.id);
  }
  private legacyPartial(job:Job):RunPartial|null {
    if(job.partial)return job.partial;
    const lane=job.lanes.values().next().value;
    if(!lane)return null;
    const {startedAt,grading,...visible}=lane;
    return {...visible,...(grading && {grading:{name:grading.name,version:grading.version}})};
  }
  runLaneProgress(id:string,revision:number,cursors:RunLaneCursor[]):RunLaneProgress {
    const job=this.active;
    if(!job || job.id!==id || revision!==job.revision || cursors.length!==job.lanes.size)return {kind:"refresh"};
    const updates:Extract<RunLaneProgress,{kind:"lanes"}>["updates"]=[];
    const seen=new Set<string>();
    for(const cursor of cursors) {
      const lane=job.lanes.get(cursor.candidateId);
      if(!lane || seen.has(lane.candidateId) || lane.caseId!==cursor.caseId || cursor.offset>lane.text.length)return {kind:"refresh"};
      seen.add(lane.candidateId);
      const usage=lane.usage && lane.usage.revision!==cursor.usageRevision ? lane.usage : undefined;
      const text=job.mode==="quick" ? lane.text.slice(cursor.offset) : "";
      if(text || usage)updates.push({candidateId:lane.candidateId,caseId:lane.caseId,...(text && {text}),...(usage && {usage})});
    }
    return {kind:"lanes",updates};
  }
  runProgress(id:string, revision:number, offset:number, usageRevision?:number):UiRunProgress {
    const job=this.active;
    if (!job || job.id!==id || job.revision!==revision) return {kind:"refresh"};
    const part=this.legacyPartial(job);
    if (!part || !("candidateId" in part)) return {kind:"unchanged"};
    const usage=usageRevision!==undefined && part.usage && part.usage.revision!==usageRevision ? {usage:part.usage} : {};
    if (job.mode==="quick") {
      if (offset>part.text.length) return {kind:"refresh"};
      if (offset<part.text.length) return {kind:"append",candidateId:part.candidateId,text:part.text.slice(offset),...usage};
    }
    return {kind:"unchanged",...usage};
  }
  stop(id:string) {
    if (id !== this.active?.id) throw Error("This run is no longer active.");
    this.active.controller.abort();
  }
  private visibleStatus(id:string,saved:RunStatus):RunStatus {
    return (saved==="queued" || saved==="running") && this.unrecordedTerminals.has(id) ? "interrupted" : saved;
  }
  async reviewSavedCase(raw:unknown) {
    const request=reviewRequest.parse(raw);
    if(this.active)throw Error("Wait for the active evaluation to finish before reviewing saved answers.");
    const run=this.detail(request.run);
    if(!run.manifest.caseIds.includes(request.caseId))throw Error("Choose a case from this run.");
    const original=run.manifest.graders.find(g=>g.id===request.grader);
    if(original && run.report && canChallengeVerdict(run.report,run))
      throw Error("Choose a different grader version for this challenge. The original grades are already recorded.");
    const grader=original ?? this.graders.get(request.grader);
    const problem=this.scoringOptions([grader]).setupIssues[grader.id];
    if(problem)throw Error(problem);
    const row=run.manifest.datasetId ? this.dataset(run.manifest.datasetId).rows.find(r=>r.case_id===request.caseId) : {case_id:request.caseId};
    if(!row)throw Error("This case is missing from its saved dataset snapshot.");
    return this.withRuntimeUse(()=>this.scoreReviews.assess(request,run,grader,row,this.quickExpectedAnswer(request.run),this.graders,this.adapters));
  }
  detail(id:string):RunDetail {
    const run = this.db
      .prepare("SELECT status,manifest FROM runs WHERE id=?")
      .get(id);
    if (!run) throw Error("Run not found");
    const savedStatus=statusValue(run.status);
    const status=this.visibleStatus(id,savedStatus);
    const manifest=decodeManifest(run.manifest);
    if (status!==savedStatus) manifest.error="DASH stopped the job but could not save its final status. Check storage and workspace access. The last saved case records are available.";
    const terminal=status!=="queued" && status!=="running";
    const detail:RunData = {
      status,
      manifest,
      results: this.db
        .prepare("SELECT record FROM results WHERE run=? AND (? OR json_extract(record,'$.dispatchState') IS NOT 'pending') ORDER BY rowid")
        .all(id,Number(terminal))
        .map(r=>{
          const result=decodeResult(r.record);
          // A failed final SQLite update can leave only the pre-dispatch checkpoint readable.
          if (result.dispatchState==="pending") {
            result.dispatchState="interrupted";
            result.error="Dispatch was checkpointed without a final response. The final candidate response is unknown.";
          }
          return result;
        }),
      assessments: this.graders.recorded(id),
      partial: this.active?.id === id ? this.legacyPartial(this.active) : null,
    };
    if(manifest.executionMode==="parallel-lanes")
      detail.results.sort((a,b)=>(a.finalizedIndex ?? Number.MAX_SAFE_INTEGER)-(b.finalizedIndex ?? Number.MAX_SAFE_INTEGER));
    const report=this.reports.get(detail);
    const savedReviews=report && (report.verdict==="incomplete" || report.verdict==="ungraded" || canChallengeVerdict(report,detail)) ? this.scoreReviews.list(id) : [];
    const quickAnswer=terminal && manifest.mode==="quick" ? this.quickExpectedAnswer(id) : null;
    const quickFields=terminal && manifest.mode==="quick" ? {
      quickFieldGraderIds:this.graders.fieldGradersFor(decodeFieldAnswer(quickAnswer)),
      hasInspectionReference:!!inspectionReference(quickAnswer),
      hasInspectionRangeReference:!!inspectionRangeReference(quickAnswer),
      hasSourcedInspectionDecision:manifest.industry==="Manufacturing" && detail.results.length>0 &&
        detail.results.every(r=>hasInspectionSource(r.dispatchedMessages,manifest.approvedPrompt?.objective)),
    } : {};
    return {...detail,liveLaneProgressVersion:1,candidatePartials:this.active?.id===id?[...this.active.lanes.values()]:[],...quickFields,...reviewResults(detail,report,savedReviews),...(manifest.mode==="quick" && {hasQuickExpectedAnswer:!!this.db.prepare("SELECT 1 FROM quick_expected_answers WHERE run=?").get(id)}),liveUsageVersion:1,liveRevision:this.active?.id===id ? this.active.revision : null,report};
  }
  exportRun(id:string) {
    const detail=this.detail(id);
    const {status}=detail;
    const {results,report,manifest,assessments}=exportDiagnostics(detail);
    return {
      format: "dash-run/1",
      report,
      assessments,
      status,
      manifest,
      results,
      cases: manifest.datasetId
        ? this.dataset(manifest.datasetId).rows.filter((r) =>
            manifest.caseIds.includes(r.case_id),
          )
        : [],
    };
  }
}

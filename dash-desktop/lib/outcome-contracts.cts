import {decodeQuickOutputSchema, decodeQuickTaskInput, schemaReviewRecord, type SchemaReview, type QuickOutputSchema, type QuickTaskInput} from "./quick-structure.cjs";
import {z} from "zod";
import {isRecord,isDomain,decodeAgentPin,type AgentPin,type Domain} from "../agents/registry.cjs";
import {decodeRoleSnapshot,type RoleSnapshot} from "./domain-profiles.cjs";
import type {PlanningAttempt,PlannerIdentity} from "./planner-routing.cjs";
import {persistedAudit,rationaleSchema,type MetricAudit,type PromptRationale} from "./metric-audit.cjs";
const planningDomainSource=z.enum(["dataset","user","starter","inferred"]);
export type PlanningDomainSource = z.infer<typeof planningDomainSource>;
export type PlanningPurpose = "draft" | "suggest";
export type RunMode = "quick"|"dataset";
export interface DesignRequest {
  mode:RunMode; structuredOutput?:boolean; requestId?:string; objective:string; metrics?:string; domain?:string; inputCap?:number|null; outputCap?:number|null;
  datasetId?:string|null; parentId?:string|null; suggestionId?:string|null; sourceRunId?:string|null;
  measures?:{metrics:string[];criteria:string[]}|null;
}
export interface ScenarioContract {
  id:string; title:string; description?:string; scorer?:string; system:string; outputSchema:unknown; metrics:string[];
}
export interface EvidenceCoverage {cases:number;referenceCases:number;rubricCases:number}
export interface DesignContext {
  coverage?:EvidenceCoverage;
  pack?:ScenarioContract; datasetId?:string; version?:string|null; split?:string|null; industry?:string|null;
  priorRun?:{id:string}; onStage?:(event:PlanningAttempt & {mode:RunMode;requestId:string})=>void;
}
export function required(value:unknown,name:string,max=24000):string {
  if (typeof value!=="string" || !value.trim() || value.length>max)
    throw Error(name+" must be text between 1 and "+max+" characters.");
  return value.trim();
}
export function optional(value:unknown,name:string,max:number):string {
  return value==null||value==="" ? "" : required(value,name,max);
}
export function lines(value:unknown,label:string,maxLength=1000,minimum=1):string[] {
  if (!Array.isArray(value) || value.length<minimum || value.length>8)
    throw Error(label+" must contain between "+minimum+" and eight entries.");
  return [...new Set(value.map((x:unknown)=>required(x,label,maxLength)))];
}
export function cap(value:unknown,name:string):number|null {
  if (value==null) return null;
  if (typeof value!=="number" || !Number.isSafeInteger(value) || value<1 || value>1000000)
    throw Error(name+" must be a whole number between 1 and 1,000,000 tokens.");
  return value;
}
export function decodeRequest(raw:unknown):DesignRequest {
  if (!isRecord(raw) || (raw.mode!=="quick" && raw.mode!=="dataset")) throw Error("Choose Quick compare or Dataset run.");
  if (raw.structuredOutput !== undefined && typeof raw.structuredOutput !== "boolean")
    throw Error("Structured outputs must be enabled or disabled.");
  if (raw.structuredOutput && raw.mode !== "quick") throw Error("A dataset uses its pinned scenario output contract.");
  const measures=raw.measures;
  if (measures!=null && !isRecord(measures)) throw Error("Invalid selected measures.");
  return {mode:raw.mode,structuredOutput:raw.structuredOutput,requestId:optional(raw.requestId,"Planning request ID",64),objective:required(raw.objective,"Business outcome",12000),metrics:optional(raw.metrics,"Business metrics",2000),
    domain:optional(raw.domain,"Planning domain",100),inputCap:cap(raw.inputCap,"Input budget"),outputCap:cap(raw.outputCap,"Output budget"),
    datasetId:optional(raw.datasetId,"Dataset snapshot",256)||null,parentId:optional(raw.parentId,"Parent prompt",256)||null,
    sourceRunId:optional(raw.sourceRunId,"Source run",256)||null,suggestionId:optional(raw.suggestionId,"Suggestion ID",256)||null,
    measures:measures==null?null:{metrics:lines(measures.metrics,"Selected metrics",2000,0),criteria:lines(measures.criteria,"Success criteria",2000,0)}};
}
interface PromptCore {
  schemaReview?:SchemaReview;
  outputSchema?:QuickOutputSchema;
  input?:QuickTaskInput;
  metricCriteria?:{metric:string;criterion:string}[];
  domainSource?:PlanningDomainSource;
  mode:RunMode; prompt:string; objective:string; title:string; domain:Domain; metrics:string[]; requirements:string[];
  datasetId:string|null; packId:string|null; contractHash:string|null; inputCap:number|null; outputCap:number|null;
  designer:PlannerIdentity|null;
  auditCoverage?:EvidenceCoverage; metricAudit?:MetricAudit[]; promptRationale?:PromptRationale; auditAgent?:AgentPin; auditDesigner?:PlannerIdentity;
  planningAttempts?:UiPlanningAttempt[];
  agents?:RoleSnapshot[];
  workflowAgents?:AgentPin[];
}
export interface PromptDraft extends PromptCore {draftId:string;parentId:string|null;[key:string]:unknown}
export interface ApprovedPrompt extends PromptCore {id:string;familyId:string;version:number;[key:string]:unknown}
export interface MetricSuggestion {
  auditCoverage?:EvidenceCoverage; metricAudit?:MetricAudit[]; auditAgent?:AgentPin; auditDesigner?:PlannerIdentity;
  id:string; domain:Domain;domainSource?:PlanningDomainSource;expertVersion:number;model:string;designer:PlannerIdentity;planningAttempts:PlanningAttempt[];metrics:string[];criteria:string[];criteriaReview?:{omitted:number;reasons:string[];supplementSource?:string};
}
const savedPlanningCall = z.object({
  stage:z.string(), model:z.string(), status:z.enum(["succeeded","failed","canceled"]),
  revision:z.string().nullable().optional(), provider:z.string().optional(), attempt:z.int().positive().optional(),
  requestId:z.string().optional(), queryId:z.string().optional(), reason:z.string().optional(), fallbackReason:z.string().optional(),
  startedAt:z.int().nonnegative().optional().catch(undefined), elapsedMs:z.int().nonnegative().optional().catch(undefined),
  discoveryMs:z.int().nonnegative().optional().catch(undefined), firstTokenMs:z.int().nonnegative().optional().catch(undefined),
  tokensPerSecond:z.number().positive().optional().catch(undefined),
  usage:z.object({inputTokens:z.int().nonnegative().nullable(),outputTokens:z.int().nonnegative().nullable(),
    estimatedCostUsd:z.number().nonnegative().nullable()}).optional().catch(undefined),
});
function savedPlanningCalls(raw:unknown):UiPlanningAttempt[]|undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((call:unknown) => {
    const parsed = savedPlanningCall.safeParse(call);
    return parsed.success ? [parsed.data] : [];
  });
}
export function decodeApprovedPrompt(raw:unknown):ApprovedPrompt {
  if (!isRecord(raw) || typeof raw.id!=="string" || typeof raw.familyId!=="string" || typeof raw.version!=="number" ||
      !Number.isSafeInteger(raw.version)||raw.version<1||(raw.mode!=="quick"&&raw.mode!=="dataset")||!isDomain(raw.domain)||
      typeof raw.prompt!=="string"||typeof raw.objective!=="string") throw Error("Invalid approved prompt revision.");
  let designer:PlannerIdentity|null=null;
  if (raw.designer!=null) {
    const d=raw.designer;
    if (!isRecord(d)||typeof d.model!=="string"||typeof d.provider!=="string"||!(d.revision==null||typeof d.revision==="string")) throw Error("Invalid planning model in approved prompt.");
    designer={...d,provider:d.provider,model:d.model,revision:d.revision??null};
  }
  const key=(value:unknown) => {if(value==null||typeof value==="string")return value??null;throw Error("Invalid snapshot ID in approved prompt.");};
  const agents=raw.agents, workflowAgents=raw.workflowAgents;
  if (agents!=null && !Array.isArray(agents)) throw Error("Invalid saved domain agent revisions.");
  if (workflowAgents!=null && !Array.isArray(workflowAgents)) throw Error("Invalid saved workflow agent revisions.");
  const {domainSource,metricAudit,promptRationale,auditAgent,auditDesigner,auditCoverage,metricCriteria,outputSchema,input,schemaReview,...record}=raw;
  if ((outputSchema===undefined)!==(input===undefined)) throw Error("The saved structured prompt is missing its JSON input or output schema.");
  if (outputSchema!==undefined && raw.mode!=="quick") throw Error("A dataset prompt cannot override its scenario output contract.");
  const coverage=z.object({cases:z.int().nonnegative(),referenceCases:z.int().nonnegative(),rubricCases:z.int().nonnegative()}).refine(c=>c.referenceCases<=c.cases && c.rubricCases<=c.cases);
  const identity=z.object({provider:z.string(),model:z.string(),revision:z.string().nullable()});
  const attribution=planningDomainSource.safeParse(domainSource);
  return {...record,...(attribution.success && {domainSource:attribution.data}),...(schemaReview!==undefined && {schemaReview:schemaReviewRecord.parse(schemaReview)}),...(outputSchema!==undefined && {outputSchema:decodeQuickOutputSchema(outputSchema),input:decodeQuickTaskInput(input,raw.prompt)}),...(metricCriteria!==undefined && {metricCriteria:z.array(z.object({metric:z.string().max(2000),criterion:z.string().max(2000)})).max(8).parse(metricCriteria)}),...(auditCoverage!==undefined && {auditCoverage:coverage.parse(auditCoverage)}),...(metricAudit!==undefined && {metricAudit:persistedAudit.parse(metricAudit)}),
    ...(promptRationale!==undefined && {promptRationale:rationaleSchema.parse(promptRationale)}),
    ...(auditAgent!==undefined && {auditAgent:decodeAgentPin(auditAgent)}),...(auditDesigner!==undefined && {auditDesigner:identity.parse(auditDesigner)}),planningAttempts:savedPlanningCalls(raw.planningAttempts),...(Array.isArray(agents) && {agents:agents.map(decodeRoleSnapshot)}),
    ...(Array.isArray(workflowAgents) && {workflowAgents:workflowAgents.map(decodeAgentPin)}),id:raw.id,familyId:raw.familyId,version:raw.version,mode:raw.mode,domain:raw.domain,prompt:raw.prompt,objective:raw.objective,
    title:typeof raw.title==="string"?raw.title:raw.objective,designer,metrics:lines(raw.metrics??[],"Saved metrics",2000,0),
    requirements:lines(raw.requirements??[],"Saved criteria",2000,0),datasetId:key(raw.datasetId),packId:key(raw.packId),contractHash:key(raw.contractHash),
    inputCap:cap(raw.inputCap,"Input budget"),outputCap:cap(raw.outputCap,"Output budget")};
}

import type { Candidate, ChatTurn, InferenceTelemetry } from "./runtime-types.cjs";
import type { Guardrail } from "./guardrail.cjs";
import type { StoredPower } from "./run-decode.cjs";
import type { GraderSpec, RecordedAssessment } from "./graders.cjs";
import type { ApprovedPrompt } from "./outcome-workflow.cjs";
import type { RunReport } from "./run-report.cjs";

export type RunMode = "quick" | "dataset";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "canceled" | "interrupted";
export type DatasetScorer = "selected-graders" | "exact-reference" | "scenario";
export interface CaseRow {
  case_id:string; input?:unknown; gold?:Record<string,unknown>; reference?:unknown;
  source_locator?:unknown; prompt?:string; messages?:ChatTurn[]; rubric?:string; sme_rationale?:string;
  dataset_version?:string; split?:"development"|"holdout";
}
export interface DatasetCase extends CaseRow {dataset_version:string; split:"development"|"holdout"}
interface PackBase { id:string; title:string; description:string; system:string; metrics:string[]; scorer:string; industry?:string; }
export interface ScoredPack extends PackBase {
  kind?:undefined; dataset:string; version:string; datasetVersion:string;
  outputSchema:Record<string,unknown>; checks:{key:string;ref:string;optional?:boolean}[];
  quotes:string[]; decimalFields:string[]; sourceText?:string; decisionField:string; accept:string; review:string;
}
export interface ReferencePack extends PackBase {kind:"reference"; outputSchema:null;}
export type ScenarioPack = ScoredPack|ReferencePack;
export interface PackBundle {pack:ScenarioPack; rows:DatasetCase[]; replay:Record<string,unknown>}
export interface DatasetMetadata { industry:string; family:string; category:string; tags:string[]; source:string; changeNote:string; parentId:string|null; }
export interface DatasetSnapshot { id:string; pack:string; name:string; metadata:DatasetMetadata; rows:DatasetCase[] }
export interface CaseScore {pass:boolean; reasons:string[]; ready?:boolean; falseAccept?:boolean; review?:boolean; evaluator?:string;}
// These observations were added after the first recorded runs. Never infer a historical runtime decision.
type LaterGuardrailFields = "reasoningPolicy"|"maxOutputTokens"|"inputOptimization";
export type StoredGuardrail=Omit<Guardrail,LaterGuardrailFields> & Partial<Pick<Guardrail,LaterGuardrailFields>>;
export type StoredMetadata=Omit<DatasetMetadata,"industry"> & {industry?:string};
export interface TraceStep {at:string; action:string; guardrail?:StoredGuardrail;}
export interface RunResult {
  candidateId:string; caseId:string; output:string|null; error:string|null; score:CaseScore|null; finishReason?:string|null;
  trace:{id:string;runId:string;candidateId:string;caseId:string;started:string;finished?:string;steps:TraceStep[]};
  telemetry:(Partial<InferenceTelemetry> & {device_power?:StoredPower|null})|null;
  dispatchState?:"pending"|"canceled"|"interrupted";
  guardrail?:StoredGuardrail; dispatchedMessages?:ChatTurn[]; inputBudget?:{cap:number|null;tokens:number;source:string};
}
export type RunPartial = {candidateId:string;caseId:string;text:string}|{stage:string;text:string};
export interface RunManifest {
  format:number; id:string; created:string; mode:RunMode; fixture:boolean; title:string; hostedDecisionApproved?:boolean;
  candidates:Candidate[]; caseIds:string[]; pack:ScenarioPack|null; graders:GraderSpec[];
  datasetScorer?:DatasetScorer|null; approvedPromptId?:string|null; approvedPrompt?:ApprovedPrompt|null;
  prompt:string|null; objective?:string|null; effectiveSystem?:string|null; promptSource?:string;
  tokenBudget?:{inputCap:number|null;outputCap:number|null}; datasetId:string|null; datasetMetadata?:StoredMetadata|null;
  datasetVersion:string|null; split:string|null; industry?:string|null;
  policyHash:string|null; promptHash:string; caseSetHash:string;
  invocations?:{candidateId:string;adapter:string;template?:string|null;reasoning?:string}[];
  outputPolicy?:{mode:string;automaticTarget:number;providerFallback:number}|null;
  parameters:{temperature?:number;maxTokens?:number}; device:{platform:string;arch:string;release:string};
  parentId?:string|null; replayHash?:string|null; animation:boolean; error?:string;
  guardrailFailure?:StoredGuardrail & {candidateId:string;caseId:string};
}
export type CurrentManifest = RunManifest & {tokenBudget:{inputCap:number|null;outputCap:number|null}};
export interface RunData {status:RunStatus;manifest:RunManifest;results:RunResult[];assessments:RecordedAssessment[];partial:RunPartial|null}
export interface RunDetail extends RunData {report:RunReport|null}
export interface StartRun {
  mode:RunMode; candidateIds:string[]; datasetId?:string; caseId?:string; parentId?:string;
  approvedPromptId?:string|null; datasetScorer?:DatasetScorer|null; caseJudgeId?:string; graderIds?:string[]; allowHostedDecision?:boolean;
  inputCap?:number|null; outputCap?:number|null; outcomeRubric?:unknown; animation?:boolean;
}
export function isRecord(value:unknown):value is Record<string,unknown> {return !!value && typeof value==="object" && !Array.isArray(value);}
export function stringValue(value:unknown,label="text"):string {
  if(typeof value!=="string") throw Error("Invalid "+label+".");
  return value;
}
export function objectValue(value:unknown,label="record"):Record<string,unknown> {
  if(!isRecord(value)) throw Error("Invalid "+label+".");
  return value;
}
export function jsonText(value:unknown):unknown {return JSON.parse(stringValue(value,"stored JSON"));}
export function errorMessage(error:unknown):string {return error instanceof Error?error.message:String(error);}
export function stringList(value:unknown):value is string[]{return Array.isArray(value)&&value.every(x=>typeof x==="string");}
export function validTurns(value:unknown):value is ChatTurn[] {
  return Array.isArray(value)&&value.every(x=>isRecord(x)&&["system","assistant","user"].includes(String(x.role))&&typeof x.content==="string");
}
export function isCaseRow(value:unknown):value is DatasetCase {
  return isRecord(value)&&typeof value.case_id==="string" && typeof value.dataset_version==="string" &&
    (value.split==="development"||value.split==="holdout") &&
    (value.messages===undefined||validTurns(value.messages)) && (value.prompt===undefined||typeof value.prompt==="string") &&
    (value.gold===undefined||isRecord(value.gold)) && ["rubric","sme_rationale"].every(k=>value[k]==null||typeof value[k]==="string");
}
export function isScenarioPack(value:unknown):value is ScenarioPack {
  if(!isRecord(value)||!["id","title","description","system","scorer"].every(k=>typeof value[k]==="string")||!stringList(value.metrics))return false;
  if(value.kind==="reference")return value.outputSchema===null;
  return value.kind===undefined&&["dataset","version","datasetVersion","decisionField","accept","review"].every(k=>typeof value[k]==="string")&&
    isRecord(value.outputSchema)&&stringList(value.quotes)&&stringList(value.decimalFields)&&Array.isArray(value.checks)&&
    value.checks.every(x=>isRecord(x)&&typeof x.key==="string"&&typeof x.ref==="string"&&(x.optional===undefined||typeof x.optional==="boolean"));
}
export function statusValue(value:unknown):RunStatus {
  switch(value){case "queued":case "running":case "completed":case "failed":case "canceled":case "interrupted":return value;default:throw Error("Invalid saved run status.");}
}

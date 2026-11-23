/** Local renderer DTOs shared by the classic scripts and the isolated preload. */
type UiMode = "quick" | "dataset";
type UiGradeType = "contains" | "exact" | "field" | "trajectory" | "judge" | "opik";
interface UiModelIdentity { model: string; provider: string }
interface UiModel extends UiModelIdentity {
  id: string; revision?: string | null; quantization?: string | null; loaded?: boolean | null;
  contextTokens?: number | null; maxContextTokens?: number | null; maxOutputTokens?: number | null;
  section?: string; endpoint?: string; needsKey?: boolean;
}
interface UiServer { provider:string; online:boolean; checkedAt:string; address:string; title:string; models:UiModel[];
  instances?: {id:string; model:string; context:number|null; quantization:string|null}[]|null }
interface UiDataset { id:string; name:string; pack:string; metadata:UiDatasetMetadata; version:string; split:string; origin:string; count:number; casesWithoutReference:number }
interface UiCase { case_id:string; messages?:unknown[]; prompt?:string; reference?:unknown; gold?:unknown; input?:unknown; rubric?:unknown; sme_rationale?:string; source_locator?:unknown }
interface UiDatasetDetail { id:string; name:string; pack:string; metadata:UiDatasetMetadata; rows: UiCase[] }
interface UiPack { id:string; title:string; system:string; outputSchema:unknown; scorer?:string; description:string; metrics:string[]; kind?:string; version?:string }
interface UiRole { domain:string; role:string; version:number; instructions:string; sources?:{title:string;url:string}[] }
interface UiTokenCaps { inputCap?:number|null; outputCap?:number|null }
interface UiPlanningReview { omitted:number; reasons:string[]; supplementSource?:string }
interface UiPriorRun {id:string; candidates:{candidate:string;responses:number;errors:number;passed:number;scored:number}[]; graders:{grader:string;version:number;candidate:string;passed:number;scored:number}[]}
interface UiPrompt extends UiTokenCaps {
  mode:UiMode; objective:string; domain:string; requestedMetrics?:string; title:string; prompt:string; metrics:string[]; requirements:string[];
  datasetId?:string|null; dataset?:UiPack|null; domainSource?:string; agents?:Pick<UiRole,"domain"|"role"|"version"|"sources">[]; designer?:UiModelIdentity|null;
  priorRun?:UiPriorRun|null; guidanceReview?:UiPlanningReview; criteriaReview?:UiPlanningReview;
  planningAttempts?:{stage:string;model:string;status:string;reason?:string}[];
}
interface UiDraft extends UiPrompt {draftId:string}
interface UiApproved extends UiPrompt {id:string; version:number; familyId:string}
interface UiSuggestion {id:string; domain:string; metrics:string[]; criteria:string[]; criteriaReview?:UiPlanningReview}
interface UiWorkflow {
  mode:UiMode; objective:string; metrics:string; domain:string; inputCap:string; outputCap:string;
  datasetId:string; parentId:string|null; sourceRunId:string|null; draft:UiDraft|null; approved:UiApproved|null;
  reviewPrompt:string; reviewMetrics:string; suggestion:UiSuggestion|null; chosenMetrics:string|null; criteria:string;
  busy:string; error:string; stage?:string; variant?:boolean; caseJudgeId?:string;
}
interface UiDesignInput extends UiTokenCaps {
  mode:UiMode; objective:string; metrics:string; domain?:string; datasetId?:string; parentId?:string; sourceRunId?:string;
  measures?:{metrics:string[];criteria:string[]}; suggestionId?:string;
}
interface UiApproval {draftId:string; prompt:string; metrics:string[]}
interface UiGraderDefinition {name:string;category:string;industry:string;type:UiGradeType;criteria:string;threshold:number;judgeId?:string|null}
interface UiGrader extends UiGraderDefinition {id:string;version:number;judge?:UiModel|null;origin?:unknown;reason?:string}
interface UiProposedGrader extends UiGraderDefinition {reason:string}
interface UiGraderDesign { checks:UiProposedGrader[]; summary:string; designer:UiModelIdentity|null }
interface UiEditableGrader extends Omit<UiProposedGrader,"threshold"> {threshold:number|string;proposedType:UiGradeType;included:boolean;judgeId:string}
interface UiGraderDraft {objective:string;metrics:string;industry:string;target:"response"|"agent";checks:UiEditableGrader[];
 summary:string;designer:UiModelIdentity|null;error:string;saved:{id:string;label:string}[];busy:string;hasPlan:boolean}
interface UiQuickOptions {recommended:UiGrader[];available:UiGrader[];generated:UiGraderDefinition;judges:UiModel[]}
interface UiQuickPlan {options:UiQuickOptions|null; saved:Set<string>; enabled:boolean;designed:boolean;
 criteria:string;judgeId:string;threshold:number|string;error:string;sequence:number}
interface UiAssessment {name:string;version:number;candidate?:string|null;caseId?:string|null;judge?:string|null;value:number|null;pass:boolean|null;reason:string}
interface UiScore {pass:boolean;ready?:boolean;falseAccept?:boolean;review?:boolean;reasons:string[]}
interface UiTelemetry {latency_ms?:number|null;first_token_ms?:number|null;input_tokens?:number|null;output_tokens?:number|null;device_power?:{average_w?:number|null}|null}
interface UiResult {candidateId:string;caseId:string;dispatchState?:"pending"|"canceled"|"interrupted";error?:string|null;output?:string|null;score?:UiScore|null;telemetry?:UiTelemetry|null;
  trace?:unknown;guardrail?:UiGuardrail|null;inputBudget?:{tokens:number;cap:number|null;source:string}|null}
interface UiRunSummary {id:string;mode:UiMode;status:string;title:string;created:string;fixture:boolean|number;industry?:string|null;datasetId?:string|null}
interface UiManifest {
  id:string;approvedPromptId?:string|null;created:string;mode:UiMode;fixture:boolean;title:string;graders:UiGrader[];approvedPrompt?:UiApproved|null;
  prompt?:string|null;promptHash?:string;datasetId:string|null;datasetVersion?:string|null;split?:string|null;industry?:string|null;
  policyHash?:string|null;caseSetHash?:string;caseIds:string[];pack:UiPack|null;candidates:UiModel[];error?:string;
  tokenBudget?:UiTokenCaps;guardrailFailure?:UiGuardrail|null;invocations?:{candidateId:string;adapter:string;template?:string|null}[];
}
interface UiRunDetail {manifest:UiManifest;status:string;results:UiResult[];assessments:UiAssessment[];report:UiReport|null;partial?:{stage?:string;candidateId?:string;text?:string}|null}
interface UiDiagnostic {status:string;fixture:boolean;candidates:Pick<UiModel,"model"|"id">[];traces:{
  candidateId:string;caseId:string;index:number;telemetry?:UiTelemetry|null;stage:string;note:string;traceId:string;started:string;finished?:string;finishReason?:string|null;adapter?:string|null}[]}
interface UiPower {at:string;watts:number|null;source:string|null;
 cpu?:{systemPercent:number|null;appPercent:number|null;logicalCores:number|null};
 memory?:{totalBytes:number|null;freeBytes:number|null;appWorkingSetBytes:number|null};
 disk?:{totalBytes:number|null;availableBytes:number|null;usedBytes:number|null};host?:{arch:string;cpu:string;memoryGiB:number;os:string;platform:string}}
interface UiPlannerFallback {model:string;enabled:boolean;hasKey:boolean}
interface UiState {packs:UiPack[];datasets:UiDataset[];runs:UiRunSummary[];prompts:UiApproved[];domainRoles:UiRole[];plannerFallback:UiPlannerFallback;servers:UiServer[];
  endpoints:UiModel[];graders:UiGrader[];opikReady:boolean;active:string|null;device:string;fixtureId:string}
interface UiLaneBudget {candidateId?:string;status:"pending"|"verified"|"blocked"|"unverified";message?:string;inputTokens?:number|null;contextTokens?:number|null;outputReserve?:number|null}
interface UiStartRun extends UiTokenCaps {
 mode:UiMode;datasetId:string|null;candidateIds:string[];graderIds:string[];animation:boolean;approvedPromptId?:string;parentId?:string;caseId?:string;
 datasetScorer?:string;caseJudgeId?:string;outcomeRubric?:{criteria:string;judgeId:string;threshold:number;type:"opik"|"judge"};
}
type UiGradeRequest = {grader:string;run:string;index:number} | {grader:string;evidence:{input:string;output:string;reference:unknown;trajectory?:unknown[]}};
type UiDesignGraderRequest = {promptId:string} | {objective:string;metrics:string;industry:string;target:"response"|"agent";datasetId?:string};
interface UiPlanningEvent {mode:UiMode;stage:string;model:string;status:string;attempt:number}
interface DashBridge {
 list():Promise<UiState>;refresh():Promise<UiServer[]>;dataset(id:string):Promise<UiDatasetDetail>;detail(id:string):Promise<UiRunDetail>;
 designPrompt(request:UiDesignInput):Promise<UiDraft>;suggestMetrics(request:UiDesignInput):Promise<UiSuggestion>;
 approvePrompt(request:UiApproval):Promise<UiApproved>;cancelDesign():Promise<void>;onPlanningStage(callback:(event:UiPlanningEvent)=>void):void;
 saveDomainRole(request:{domain:string;role:string;instructions:string;expectedVersion:number}):Promise<UiRole>;
 savePlannerFallback(request:{model:string;enabled:boolean;key:string}):Promise<UiPlannerFallback>;
 guidePrompt(draft:string):Promise<UiGuideResult>;cancelGuide():Promise<void>;power(detailed?:boolean):Promise<UiPower>;
 saveEndpoint(request:{section:string;model:string;baseUrl:string;key:string}):Promise<string>;
 designGraders(request:UiDesignGraderRequest):Promise<UiGraderDesign>;confirmGraders(request:UiGraderDefinition[]):Promise<string[]>;
 saveGrader(request:UiGraderDefinition):Promise<string>;graderSamples():Promise<UiAssessment[]>;
 quickGraderOptions(id:string):Promise<UiQuickOptions>;previewQuickBudget(id:string,models:string[]):Promise<UiLaneBudget[]>;
 assess(request:UiGradeRequest):Promise<UiAssessment>;diagnostics(id:string):Promise<UiDiagnostic>;
 opikExperimentStatus(id:string):Promise<UiOpikStatus>;syncOpikExperiment(id:string):Promise<UiOpikReceipt>;openOpikDashboard():Promise<void>;
 performance(id:string):Promise<UiPerformance>;start(request:UiStartRun):Promise<string>;stop(id:string):Promise<void>;
 import(pack:string):Promise<UiImportDraft|null>;commitImport(token:string,metadata:UiCommitImport):Promise<string>;export(id:string):Promise<boolean>;
}
interface Window {dash:DashBridge}

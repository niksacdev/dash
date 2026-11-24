/** Local renderer DTOs shared by the classic scripts and the isolated preload. */
type UiMode = "quick" | "dataset";
type UiGradeType = "contains" | "exact" | "field" | "trajectory" | "judge" | "opik" | "decision" | "catalog" | "opik-metric";
interface UiModelIdentity { model: string; provider: string }
interface UiModel extends UiModelIdentity {
  nativeKey?:string; id: string; revision?: string | null; quantization?: string | null; loaded?: boolean | null;
  contextTokens?: number | null; maxContextTokens?: number | null; maxOutputTokens?: number | null;
  section?: string; endpoint?: string; needsKey?: boolean;
}
interface UiServer { provider:string; online:boolean; checkedAt:string; address:string; title:string; models:UiModel[];
  instances?: {id:string; model:string; context:number|null; quantization:string|null}[]|null }
interface UiDataset { id:string; name:string; pack:string; metadata:UiDatasetMetadata; version:string; split:string; origin:string; count:number; casesWithoutReference:number;casesWithRubric:number }
interface UiCase { case_id:string; messages?:unknown[]; prompt?:string; reference?:unknown; gold?:unknown; input?:unknown; rubric?:unknown; sme_rationale?:string; source_locator?:unknown }
interface UiDatasetDetail { id:string; name:string; pack:string; metadata:UiDatasetMetadata; rows: UiCase[] }
interface UiPack { id:string; title:string; system:string; outputSchema:unknown; scorer?:string; description:string; metrics:string[]; kind?:string; version?:string }
interface UiRole { domain:string; role:string; version:number; instructions:string; sources?:{title:string;url:string}[] }
interface UiTokenCaps { inputCap?:number|null; outputCap?:number|null }
interface UiMetricAudit {
  metric:string; criterion:string; status:"proposed"|"needs-evidence"|"external";
  evidence:string; method:string; reason:string;
}
interface UiReviewEvidence {
  metricAudit?:UiMetricAudit[];
  auditDesigner?:UiModelIdentity|null;
}
interface UiPlanningReview { omitted:number; reasons:string[]; supplementSource?:string }
interface UiPriorRun {id:string; candidates:{candidate:string;responses:number;errors:number;passed:number;scored:number}[]; graders:{grader:string;version:number;candidate:string;passed:number;scored:number}[]}
interface UiTaskInput {task:string;inputs:Record<string,string>}
interface UiPrompt extends UiTokenCaps, UiReviewEvidence {
  input?:UiTaskInput;outputSchema?:Record<string,unknown>;
  promptRationale?:{original:string;addition:string;reason:string};
  mode:UiMode; objective:string; domain:string; requestedMetrics?:string; title:string; prompt:string; metrics:string[]; requirements:string[];
  datasetId?:string|null; dataset?:UiPack|null; domainSource?:string; agents?:Pick<UiRole,"domain"|"role"|"version"|"sources">[]; designer?:UiModelIdentity|null;
  priorRun?:UiPriorRun|null; guidanceReview?:UiPlanningReview; criteriaReview?:UiPlanningReview;
  planningAttempts?:UiPlanningAttempt[];
}
interface UiDraft extends UiPrompt {draftId:string}
interface UiApproved extends UiPrompt {id:string; version:number; familyId:string}
interface UiSuggestion extends UiReviewEvidence {id:string; planningAttempts?:UiPlanningAttempt[]; domain:string; metrics:string[]; criteria:string[]; criteriaReview?:UiPlanningReview}
interface UiWorkflow {
  mode:UiMode; objective:string; metrics:string; domain:string; inputCap:string; outputCap:string;
  datasetId:string; parentId:string|null; sourceRunId:string|null; draft:UiDraft|null; approved:UiApproved|null;
  structuredOutput?:boolean;reviewInput?:string;reviewSchema?:string;
  reviewPrompt:string; reviewMetrics:string; suggestion:UiSuggestion|null; chosenMetrics:string|null; criteria:string;
  busy:string; error:string; activity?:{requestId:string; startedAt?:number; calls:UiPlanningAttempt[]}; variant?:boolean; caseJudgeId?:string;
}
interface UiDesignInput extends UiTokenCaps {
  structuredOutput?:boolean;
  mode:UiMode; requestId?:string; objective:string; metrics:string; domain?:string; datasetId?:string; parentId?:string; sourceRunId?:string;
  measures?:{metrics:string[];criteria:string[]}; suggestionId?:string;
}
interface UiApproval {draftId:string; prompt:string; metrics:string[];input?:Record<string,unknown>;outputSchema?:Record<string,unknown>}
type UiDecisionEvidence = "reference" | "trajectory";
type UiDecisionProtocol = "systemone" | "mlx-vlm";
interface UiDecisionConfig {protocol?:UiDecisionProtocol;fallbackModel?:string;provider:"local"|"openrouter";endpoint?:string;model:string;failAt:number}
interface UiDecisionRequest {protocol?:UiDecisionProtocol;fallbackModel?:string;provider:"local"|"openrouter";requestedModel:string;failAt:number;passAt:number;endpoint?:string}
type UiDecisionFallbackReason = "primary-unavailable" | "primary-not-decision-capable";
interface UiDecisionObservation extends UiDecisionRequest {actualModel:string;probabilityYes:number;dispatchedModel?:string;fallbackReason?:UiDecisionFallbackReason}
interface UiDecisionAttempt {dispatchedModel:string;fallbackReason:UiDecisionFallbackReason}
type UiOpikMetricKey = "answer-relevance"|"usefulness"|"hallucination"|"moderation";
interface UiOpikLibraryTemplate {key:UiOpikMetricKey;name:string;criteria:string;category:string;requiresReference:boolean;docsUrl:string}
interface UiGraderDefinition {evidenceView?:"answer-only"|"case";metricKey?:UiOpikMetricKey;name:string;category:string;industry:string;type:UiGradeType;criteria:string;threshold:number;judgeId?:string|null;decision?:UiDecisionConfig;requiredEvidence?:UiDecisionEvidence[]}
type UiGraderScope = "general" | "industry" | "customer";
interface UiGraderLibrary {scope:UiGraderScope;familyId:string;parentRevisionId?:string;scenario?:string;automatic?:boolean}
type UiGraderSave = UiGraderDefinition & ({intent:"create"}|{intent:"derive"|"revise";sourceGraderId:string});
interface UiGraderRun {id:string;title:string;created:string}
interface UiGraderOptions {hasReferences?:boolean;automatic:UiGrader[];available:UiGrader[]}
interface UiGrader extends UiGraderDefinition {generalDefaultKey?:string|null;library?:UiGraderLibrary;ruleKey?:string;ruleVersion?:number;id:string;version:number;judge?:UiModel|null;origin?:unknown;reason?:string}
interface UiQuickMeasure {metric:string;criterion:string|null;generated:UiGraderDefinition|null;reason:string|null}
type UiMeasureAssignment = {metric:string;kind:"skip"} | {metric:string;kind:"saved";graderId:string} |
  {metric:string;kind:"rubric";judgeId:string;threshold:number;criteria:string;evidence:"task-answer"|"reference"};
interface UiPinnedMeasure {metric:string;criterion:string|null;graderId:string|null;graderVersion:number|null;reason:string|null}
interface UiQuickOptions extends UiGraderOptions {recommended:UiGrader[];measures:UiQuickMeasure[];generated:UiGraderDefinition|null;judges:UiModel[]}
interface UiMeasureEditor {choice:string;judgeId:string;threshold:string;criteria:string;evidence:"task-answer"|"reference";edited:boolean}
interface UiQuickPlan {options:UiQuickOptions|null;saved:Set<string>;designed:boolean;measures:Map<string,UiMeasureEditor>;error:string;sequence:number}
interface UiDatasetCaseSource {datasetId:string; datasetName:string; datasetVersion:string; caseId:string; scenarioId:string; scenarioVersion:string; contractHash:string}
interface UiAssessment {datasetCase?:UiDatasetCaseSource;opikMetric?:{metricKey:UiOpikMetricKey;nativeScore:number;direction:"higher-is-better"|"higher-is-risk"};decisionAttempt?:UiDecisionAttempt;decisionRequest?:UiDecisionRequest;decision?:UiDecisionObservation;engine?:UiGradeType;name:string;version:number;candidate?:string|null;caseId?:string|null;judge?:string|null;value:number|null;pass:boolean|null;reason:string}
interface UiScore {pass:boolean;ready?:boolean;falseAccept?:boolean;review?:boolean;reasons:string[]}
interface UiTelemetry {latency_ms?:number|null;first_token_ms?:number|null;input_tokens?:number|null;output_tokens?:number|null;device_power?:{average_w?:number|null}|null}
interface UiResult {structuredOutputCheck?:{valid:boolean;message:string};gradingError?:string;candidateId:string;caseId:string;dispatchState?:"pending"|"canceled"|"interrupted";error?:string|null;output?:string|null;score?:UiScore|null;telemetry?:UiTelemetry|null;
  trace?:unknown;guardrail?:UiGuardrail|null;inputBudget?:{tokens:number;cap:number|null;source:string}|null}
interface UiRunSummary {id:string;mode:UiMode;status:string;title:string;created:string;fixture:boolean|number;industry?:string|null;datasetId?:string|null}
interface UiManifest {
  id:string;approvedPromptId?:string|null;created:string;mode:UiMode;fixture:boolean;title:string;measureGraders?:UiPinnedMeasure[];graders:UiGrader[];approvedPrompt?:UiApproved|null;
  prompt?:string|null;promptHash?:string;datasetId:string|null;datasetVersion?:string|null;split?:string|null;industry?:string|null;
  policyHash?:string|null;caseSetHash?:string;caseIds:string[];pack:UiPack|null;candidates:UiModel[];error?:string;
  tokenBudget?:UiTokenCaps;guardrailFailure?:UiGuardrail|null;invocations?:{candidateId:string;adapter:string;template?:string|null}[];
}
type UiRunProgress = {kind:"unchanged"}|{kind:"refresh"}|{kind:"append";candidateId:string;text:string};
interface UiRunDetail {liveRevision:number|null;manifest:UiManifest;status:string;results:UiResult[];assessments:UiAssessment[];report:UiReport|null;partial?:{stage?:string;candidateId?:string;text?:string}|null}
interface UiDiagnostic {status:string;fixture:boolean;candidates:Pick<UiModel,"model"|"id">[];traces:{
  candidateId:string;caseId:string;index:number;telemetry?:UiTelemetry|null;stage:string;note:string;traceId:string;started:string;finished?:string;finishReason?:string|null;adapter?:string|null}[]}
interface UiPower {at:string;watts:number|null;source:string|null;
 cpu?:{systemPercent:number|null;appPercent:number|null;logicalCores:number|null};
 memory?:{totalBytes:number|null;freeBytes:number|null;appWorkingSetBytes:number|null};
 disk?:{totalBytes:number|null;availableBytes:number|null;usedBytes:number|null};host?:{arch:string;cpu:string;memoryGiB:number;os:string;platform:string}}
interface UiPlannerFallback {model:string;enabled:boolean;hasKey:boolean}
interface UiState {generalGraderDefaults:string[];opikLibraryTemplates:readonly UiOpikLibraryTemplate[];packs:UiPack[];datasets:UiDataset[];runs:UiRunSummary[];prompts:UiApproved[];domainRoles:UiRole[];plannerFallback:UiPlannerFallback;servers:UiServer[];
  endpoints:UiModel[];graders:UiGrader[];opikReady:boolean;active:string|null;device:string;fixtureId:string}
interface UiLaneBudget {candidateId?:string;status:"pending"|"verified"|"blocked"|"unverified";message?:string;inputTokens?:number|null;contextTokens?:number|null;outputReserve?:number|null}
interface UiStartRun extends UiTokenCaps {
 mode:UiMode;datasetId:string|null;candidateIds:string[];graderIds:string[];animation:boolean;approvedPromptId?:string;parentId?:string;caseId?:string;
 allowHostedDecision?:true;datasetScorer?:string;caseJudgeId?:string;measureGraders?:UiMeasureAssignment[];outcomeRubric?:{criteria:string;judgeId:string;threshold:number;type:"opik"|"judge"};
}
type UiDatasetCaseTest = {grader:string;datasetId:string;caseId:string;output:string};
type UiGradeRequest = UiDatasetCaseTest | ({grader:string;allowHostedDecision?:true} & ({run:string;index:number} | {evidence:{input:string;output:string;reference:unknown;trajectory?:unknown[]}}));
type UiDesignGraderRequest = {requestId?:string} & ({promptId:string;target?:"response"|"agent"} | {objective:string;metrics:string;domainId?:string;target:"response"|"agent";datasetId?:string});
interface PlanningUsage {
  inputTokens:number|null; outputTokens:number|null; estimatedCostUsd:number|null;
}
interface UiPlanningAttempt {
  startedAt?:number; elapsedMs?:number; discoveryMs?:number; firstTokenMs?:number; tokensPerSecond?:number;
  progress?:{phase:"processing-prompt";percent:number}|{phase:"generating";approximateOutputTokens:number};
  stage:string; model:string; provider?:string; revision?:string|null; attempt?:number;
  status:"running"|"succeeded"|"failed"|"canceled"; reason?:string; requestId?:string; queryId?:string; usage?:PlanningUsage;
}
interface UiPlanningEvent extends UiPlanningAttempt {
  mode:UiMode|"grader"; requestId:string; queryId:string; provider:string; attempt:number;
}
interface DashBridge {
 loadLocalModel(key:string):Promise<{status:"already-loaded"|"loaded";instanceId:string}|{status:"unconfirmed"}>;
 list():Promise<UiState>;refresh():Promise<UiServer[]>;dataset(id:string):Promise<UiDatasetDetail>;detail(id:string):Promise<UiRunDetail>;
 runProgress(id:string,revision:number,offset:number):Promise<UiRunProgress>;
 designPrompt(request:UiDesignInput):Promise<UiDraft>;suggestMetrics(request:UiDesignInput):Promise<UiSuggestion>;
 approvePrompt(request:UiApproval):Promise<UiApproved>;cancelDesign():Promise<void>;onPlanningStage(callback:(event:UiPlanningEvent)=>void):void;
 saveDomainRole(request:{domain:string;role:string;instructions:string;expectedVersion:number}):Promise<UiRole>;
 savePlannerFallback(request:{model:string;enabled:boolean;key:string}):Promise<UiPlannerFallback>;
 guidePrompt(draft:string):Promise<UiGuideResult>;cancelGuide():Promise<void>;power(detailed?:boolean):Promise<UiPower>;
 saveEndpoint(request:{section:string;model:string;baseUrl:string;key:string}):Promise<string>;
 designGraders(request:UiDesignGraderRequest):Promise<UiGraderDesign>;confirmGraders(request:UiPlanApproval):Promise<string[]>;
 listDecisionModels(baseUrl:string,protocol?:UiDecisionProtocol):Promise<string[]>;
 saveGrader(request:UiGraderSave):Promise<string>;graderSamples():Promise<UiAssessment[]>;
 graderDatasetIds(id:string):Promise<string[]>;
 setGeneralGraderDefault(id:string,enabled:boolean):Promise<void>;graderRuns(id:string):Promise<UiGraderRun[]>;datasetGraderOptions(id:string):Promise<UiGraderOptions>;
 quickGraderOptions(id:string):Promise<UiQuickOptions>;previewQuickBudget(id:string,models:string[]):Promise<UiLaneBudget[]>;
 assess(request:UiGradeRequest):Promise<UiAssessment>;diagnostics(id:string):Promise<UiDiagnostic>;
 opikExperimentStatus(id:string):Promise<UiOpikStatus>;syncOpikExperiment(id:string):Promise<UiOpikReceipt>;openOpikDashboard():Promise<void>;
 performance(id:string):Promise<UiPerformance>;start(request:UiStartRun):Promise<string>;stop(id:string):Promise<void>;
 import(pack:string):Promise<UiImportDraft|null>;commitImport(token:string,metadata:UiCommitImport):Promise<string>;export(id:string):Promise<boolean>;
}
interface Window {dash:DashBridge}

type UiDesignMethod="opik"|"decision"|"contains"|"exact"|"field"|"trajectory";
type UiPlanAction = "create" | "derive" | "reuse";
interface UiPlanSource {id:string;name:string;scope:"general"|"industry"|"customer";version:number;threshold?:number;criteria:string;hosted:boolean;model:string|null}
interface UiProposedGrader {measures?:string[];name:string;category:string;industry:string;type:UiGradeType;criteria:string;threshold:number;
 evidenceView?:UiDecisionView;requiredEvidence?:("reference"|"trajectory")[];action:UiPlanAction;source:UiPlanSource|null;reason:string}
interface UiGraderGap {measure:string;reason:string}
interface UiCoveredMeasure {measure:string;reason:string;grader:{id:string;name:string;version:number}}
interface UiGraderDesign {planningAttempts?:UiPlanningAttempt[];covered?:UiCoveredMeasure[];gaps?:UiGraderGap[];editableMethods:UiDesignMethod[];draftId:string;checks:UiProposedGrader[];automatic:string[];summary:string;designer:UiModelIdentity|null}
interface UiEditableGrader extends Omit<UiProposedGrader,"threshold"> {threshold:number|string;included:boolean;judgeId:string;derivationStarted?:boolean;native?:UiNativeJudgeDraft;rubricCriteria?:string;rubricThreshold?:number|string;binaryCriteria?:string;decisionView?:UiDecisionView}
interface UiGraderDraft {activity?:UiWorkflow["activity"];covered?:UiCoveredMeasure[];gaps?:UiGraderGap[];planner?:UiWorkflow;editableMethods:UiDesignMethod[];objectiveEdited:boolean;metricsEdited:boolean;objective:string;metrics:string;industry:string;target:"response"|"agent";checks:UiEditableGrader[];draftId:string;
 automatic:string[];summary:string;designer:UiModelIdentity|null;error:string;saved:{id:string;label:string}[];busy:string;hasPlan:boolean}
interface UiNativeJudgeDraft {endpoint:string;protocol:UiDecisionProtocol;model:string;failAt:string;models?:string[]}
interface UiReviewedRubric {decision?:UiDecisionConfig;decisionView?:UiDecisionView;evidenceView?:UiDecisionView;type?:UiDesignMethod;industry?:string;name:string;category:string;criteria:string;threshold:number;judgeId?:string|null}
type UiReviewChoice={index:number;action:"reuse"}|{index:number;action:"create"|"derive";definition:UiReviewedRubric};
interface UiPlanApproval {draftId:string;choices:UiReviewChoice[]}

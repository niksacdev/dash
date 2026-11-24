type UiDesignMethod="opik"|"contains"|"exact"|"field"|"trajectory";
type UiPlanAction = "create" | "derive" | "reuse";
interface UiPlanSource {id:string;name:string;scope:"general"|"industry"|"customer";version:number;criteria:string;hosted:boolean;model:string|null}
interface UiProposedGrader {name:string;category:string;industry:string;type:UiGradeType;criteria:string;threshold:number;
 evidenceView?:"answer-only"|"case";requiredEvidence?:("reference"|"trajectory")[];action:UiPlanAction;source:UiPlanSource|null;reason:string}
interface UiGraderGap {measure:string;reason:string}
interface UiCoveredMeasure {measure:string;reason:string;grader:{id:string;name:string;version:number}}
interface UiGraderDesign {covered?:UiCoveredMeasure[];gaps?:UiGraderGap[];editableMethods:UiDesignMethod[];draftId:string;checks:UiProposedGrader[];automatic:string[];summary:string;designer:UiModelIdentity|null}
interface UiEditableGrader extends Omit<UiProposedGrader,"threshold"> {threshold:number|string;included:boolean;judgeId:string}
interface UiGraderDraft {covered?:UiCoveredMeasure[];gaps?:UiGraderGap[];planner?:UiWorkflow;editableMethods:UiDesignMethod[];objectiveEdited:boolean;metricsEdited:boolean;objective:string;metrics:string;industry:string;target:"response"|"agent";checks:UiEditableGrader[];draftId:string;
 automatic:string[];summary:string;designer:UiModelIdentity|null;error:string;saved:{id:string;label:string}[];busy:string;hasPlan:boolean}
interface UiReviewedRubric {evidenceView?:"answer-only"|"case";type?:UiDesignMethod;industry?:string;name:string;category:string;criteria:string;threshold:number;judgeId?:string|null}
type UiReviewChoice={index:number;action:"reuse"}|{index:number;action:"create"|"derive";definition:UiReviewedRubric};
interface UiPlanApproval {draftId:string;choices:UiReviewChoice[]}

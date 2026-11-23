type UiPlanAction = "create" | "derive" | "reuse";
interface UiPlanSource {id:string;name:string;scope:"general"|"industry"|"customer";version:number;criteria:string;hosted:boolean;model:string|null}
interface UiProposedGrader {name:string;category:string;industry:string;type:UiGradeType;criteria:string;threshold:number;
 action:UiPlanAction;source:UiPlanSource|null;reason:string}
interface UiGraderDesign {draftId:string;checks:UiProposedGrader[];automatic:string[];summary:string;designer:UiModelIdentity|null}
interface UiEditableGrader extends Omit<UiProposedGrader,"threshold"> {threshold:number|string;included:boolean;judgeId:string}
interface UiGraderDraft {objective:string;metrics:string;industry:string;target:"response"|"agent";checks:UiEditableGrader[];draftId:string;
 automatic:string[];summary:string;designer:UiModelIdentity|null;error:string;saved:{id:string;label:string}[];busy:string;hasPlan:boolean}
interface UiReviewedRubric {name:string;category:string;criteria:string;threshold:number;judgeId?:string|null}
type UiReviewChoice={index:number;action:"reuse"}|{index:number;action:"create"|"derive";definition:UiReviewedRubric};
interface UiPlanApproval {draftId:string;choices:UiReviewChoice[]}

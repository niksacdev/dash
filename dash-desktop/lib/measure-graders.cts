import {z} from "zod";
import type {ApprovedPrompt} from "./outcome-workflow.cjs";
import type {GraderDefinition,GraderSpec} from "./grader-types.cjs";
import {isExternalOutcomeMetric} from "./metric-audit.cjs";

export const rubricEvidenceInstruction = "For a factual decision, establish the expected result from the supplied case facts or verified reference. Only the candidate output establishes what the candidate said or did. Do not credit a fact found only in the task, reference or rubric. In the reason, state the expected detail and quote the decisive words or value from the candidate, or name the missing detail.";

const metricText=z.string().min(1).max(2000);
export const measureGraderRequest=z.array(z.discriminatedUnion("kind",[
  z.strictObject({metric:metricText,kind:z.literal("skip")}),
  z.strictObject({metric:metricText,kind:z.literal("saved"),graderId:z.string().min(1).max(200)}),
  z.strictObject({metric:metricText,kind:z.literal("rubric"),judgeId:z.string().min(1).max(400),
    threshold:z.number().gt(0).max(1),criteria:z.string().trim().min(1).max(6000).optional(),
    evidence:z.enum(["task-answer","reference"]).optional()}),
])).max(8);
export type MeasureGraderRequest=z.infer<typeof measureGraderRequest>;
export const pinnedMeasure=z.object({
  metric:metricText,criterion:metricText.nullable(),graderId:z.string().min(1).nullable(),
  graderVersion:z.number().int().positive().nullable(),reason:z.string().min(1).nullable(),
});
export type PinnedMeasure=z.infer<typeof pinnedMeasure>;
export interface MeasureOption {
  canMapRequestedItems?:boolean;metric:string;criterion:string|null;generated:GraderDefinition|null;reason:string|null;
}

type ApprovedMeasures=Pick<ApprovedPrompt,"domain"|"metrics"|"metricCriteria"|"metricAudit">;
export function measureOptions(approved:ApprovedMeasures,preferredJudge:string|null):MeasureOption[] {
  const pairs=approved.metricCriteria ?? approved.metricAudit;
  if(!pairs)return [];
  return approved.metrics.map(metric=>{
    const criterion=pairs.find(pair=>pair.metric===metric)?.criterion ?? null;
    const audit=approved.metricAudit?.find(row=>row.metric===metric);
    const external=audit?.status==="external" ||
      isExternalOutcomeMetric(metric) || (criterion!==null && isExternalOutcomeMetric(criterion));
    const reason=external ? "This business outcome needs observations outside this run." :
      !criterion ? "Approve a per-answer success criterion for this measure before mapping a grader." : null;
    if(reason || !criterion)return {metric,criterion,generated:null,reason};
    const generated:GraderDefinition={
      name:metric.slice(0,100),category:"Approved measure",industry:approved.domain,type:"opik",judgeId:preferredJudge,threshold:1,
      ...(audit?.evidenceBasis!=="task-answer" && {requiredEvidence:["reference"]}),
      criteria:["Success measure: "+metric,"Per-answer success criterion: "+criterion,
        rubricEvidenceInstruction,
        "Score this measure alone. Full credit (10) requires every requested element to be present and correct. Zero credit (0) if any required element is missing, contradicted or wrong. A correct field elsewhere cannot offset a wrong decision. Use only 0 or 10."].join("\n"),
    };
    const option={metric,criterion,generated,reason:null};
    return {...option,canMapRequestedItems:matchesCompletenessMeasure(option,approved)};
  });
}

// A whole-task coverage check cannot establish the correctness of a named field or one selected deliverable.
function matchesCompletenessMeasure(row:MeasureOption,approved:ApprovedMeasures):boolean {
  const audit=approved.metricAudit?.find(entry=>entry.metric===row.metric);
  if(!row.generated || !row.criterion || audit?.evidenceBasis!=="task-answer" || row.reason)return false;
  const label=row.metric.trim().toLowerCase().replace(/[.!?]$/,"");
  const coverageLabel=/^(?:requested (?:items|deliverables) present|(?:requested |explicit )(?:item|deliverable) coverage|(?:all |requested )deliverables addressed)$/;
  const criterion=row.criterion.toLowerCase().trim().replace(/[.!?]$/,"");
  const object="(?:all|each|every) (?:the )?(?:(?:explicitly )?requested |explicit |required )?(?:deliverables?|items?|parts?)(?: (?:of|in|from) the (?:task|request|checklist))?";
  const covers=new RegExp("^(?:(?:the |a )?(?:answer|response|candidate(?: answer| response)?) (?:explicitly )?)?(?:address(?:es)?|covers?|includes?|lists?|provides?) "+object+"$");
  const covered=new RegExp("^"+object+" (?:are|is) (?:addressed|covered|included|provided)(?: in the (?:answer|response))?$");
  return coverageLabel.test(label) && (covers.test(criterion) || covered.test(criterion));
}

export function pinMeasure(option:MeasureOption,grader:GraderSpec|null):PinnedMeasure {
  return {metric:option.metric,criterion:option.criterion,graderId:grader?.id ?? null,
    graderVersion:grader?.version ?? null,reason:grader ? null : option.reason ?? "Left unscored for this run."};
}

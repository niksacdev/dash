import {z} from "zod";
import type {ApprovedPrompt} from "./outcome-workflow.cjs";
import type {GraderDefinition,GraderSpec} from "./grader-types.cjs";
import {isExternalOutcomeMetric} from "./metric-audit.cjs";

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
  metric:string;criterion:string|null;generated:GraderDefinition|null;reason:string|null;
}

export function measureOptions(approved:ApprovedPrompt,preferredJudge:string|null):MeasureOption[] {
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
        "Score this criterion alone. The criterion states the test. Evidence of what the candidate did must come from its answer.",
        "Full credit (10) when the answer satisfies the criterion. Zero credit (0) when it fails. Use only 0 or 10 and cite the decisive detail."].join("\n"),
    };
    return {metric,criterion,generated,reason:null};
  });
}

export function pinMeasure(option:MeasureOption,grader:GraderSpec|null):PinnedMeasure {
  return {metric:option.metric,criterion:option.criterion,graderId:grader?.id ?? null,
    graderVersion:grader?.version ?? null,reason:grader ? null : option.reason ?? "Left unscored for this run."};
}

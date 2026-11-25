import { z } from "opik";
import type {MeasureOption} from "./measure-graders.cjs";
import {decodeAgentPin} from "../agents/registry.cjs";
import { decisionConfig, observationSchema, protocolSchema, fallbackAttemptSchema, type DecisionConfig } from "./decision-model.cjs";
import {jsonField,type ScoredPack,type CaseRow} from "./run-types.cjs";
import {getOpikTemplate,hasEvidence,opikMetricKey,opikMetricResult, type OpikMetricKey} from "./opik-library.cjs";
import type { LocalCandidate } from "./runtime-types.cjs";

export const graderType = z.enum(["contains", "exact", "field", "trajectory", "judge", "opik", "decision", "catalog", "opik-metric"]);
export type GraderMethod = z.infer<typeof graderType>;
export type JudgeMethod = "judge" | "opik";
export const rubricOrigin = z.object({
  kind: z.literal("approved-outcome"), promptId: z.string(), promptFamilyId: z.string(), promptVersion: z.number().int(), measure:z.string().min(1).max(2000).optional(),
});
export type RubricOrigin = z.infer<typeof rubricOrigin>;
const judgeModel = z.object({
  id: z.string(), model: z.string(), provider: z.enum(["lmstudio", "ollama"]), kind: z.literal("model").default("model"),
  revision: z.string().nullable().optional(), quantization: z.string().nullable().optional(),
  nativeChat:z.boolean().optional(), reasoningOff:z.boolean().optional(),
}).passthrough();
export const graderLibrary = z.object({
  scope:z.enum(["general","industry","customer"]), familyId:z.string().min(1),
  parentRevisionId:z.string().min(1).optional(), automatic:z.boolean().optional(), scenario:z.string().min(1).optional(),
});
export type GraderLibrary = z.infer<typeof graderLibrary>;
export const graderProducer=z.object({agent:z.unknown().transform(decodeAgentPin),
  model:z.object({provider:z.string().min(1),model:z.string().min(1),revision:z.string().nullable()})});
export type GraderProducer=z.infer<typeof graderProducer>;
const base = z.object({
  id:z.string(),name:z.string(),category:z.string(),industry:z.string().default("Unclassified"),criteria:z.string(),version:z.number().int(),
  threshold:z.number().min(0).max(1),opikEngine:z.string().optional(),origin:rubricOrigin.optional(),library:graderLibrary.optional(),producer:graderProducer.optional(),
});
export const rubricEvidenceView=z.enum(["case","task-answer","answer-only"]);
const evidenceRequirement = z.enum(["reference","trajectory"]);
export const requiredEvidence = z.array(evidenceRequirement).max(2)
  .refine(values => new Set(values).size === values.length, "Choose each evidence requirement once.");
export const decisionSettings = z.object({
  decision:decisionConfig, threshold:z.number().gt(0).max(1), requiredEvidence:requiredEvidence.optional(),
}).refine(g => g.decision.failAt < g.threshold, "The fail cutoff must be below the pass cutoff.");
export const savedGrader = z.union([
  base.extend({type:z.literal("catalog"),ruleKey:z.string().min(1),ruleVersion:z.number().int().positive(),judge:z.null()}),
  base.extend({type:z.literal("opik-metric"),metricKey:opikMetricKey,judge:judgeModel}),
  base.extend({type:z.literal("decision"),judge:z.null(),decision:decisionConfig,decisionView:rubricEvidenceView.optional(),requiredEvidence:requiredEvidence.optional()})
    .refine(g => g.decision.failAt < g.threshold, "Invalid decision cutoffs."),
  base.extend({type:z.enum(["judge","opik"]),judge:judgeModel,requiredEvidence:requiredEvidence.optional(),evidenceView:rubricEvidenceView.optional()}),
  base.extend({type:z.enum(["contains","exact","field","trajectory"]),judge:z.null()}),
]);
export type GraderSpec = z.infer<typeof savedGrader>;
export function graderEvidenceView(source:GraderSpec|undefined) {
  return source?.type==="decision" ? source.decisionView : source?.type==="opik" ? source.evidenceView : undefined;
}
export function graderRequiredEvidence(source:GraderSpec|undefined):("reference"|"trajectory")[] {
  if(source?.type==="opik" || source?.type==="decision")return source.requiredEvidence ?? [];
  if(source?.type==="trajectory")return ["trajectory"];
  if(source?.type==="field" || (source?.type==="catalog" && source.library?.scenario) ||
    (source?.type==="opik-metric" && getOpikTemplate(source.metricKey).requiresReference))return ["reference"];
  return [];
}
const inputSource = z.enum(["recorded-dispatch", "reconstructed-case", "fixture-case"]);
export interface GraderEvidence {
  quickOutputSchema?:import("./quick-structure.cjs").QuickOutputSchema;
  input:unknown; reference:unknown; output:string; inputSource?:z.infer<typeof inputSource>;
  finishReason?:string|null; caseContext?:{pack:ScoredPack;row:CaseRow};
  trajectory?:readonly unknown[]; rubric?:string; sme_rationale?:string;
  evaluationBrief?:{objective:string;metrics:readonly string[];criteria:readonly string[]};
}
const fieldRule=z.object({outputField:z.string().regex(/^[\w.-]+$/),referenceField:z.string().regex(/^[\w.-]+$/)});
export function parseFieldRule(criteria:string) {return fieldRule.parse(JSON.parse(criteria));}

// An explicit Test or Grade action can ask for evidence before creating an assessment.
export function requireAssessmentEvidence(grader:GraderSpec,evidence:GraderEvidence):void {
  if (grader.type==="catalog" && grader.library?.scenario && !evidence.caseContext)
    throw Error("Choose a labeled case from this grader’s industry dataset to test its scenario rule.");
  const needs=graderRequiredEvidence(grader);
  if (grader.type==="field") {
    const {referenceField}=parseFieldRule(grader.criteria);
    if (jsonField(evidence.reference,referenceField)===undefined)
      throw Error("Enter an expected answer as JSON containing the field "+referenceField+" before grading.");
  } else if (needs.includes("reference") && !hasEvidence(evidence.reference))
    throw Error("Enter an expected answer before grading. Supply the correct answer or verified facts for this task in Test one output.");
  if (needs.includes("trajectory") && !Array.isArray(evidence.trajectory))
    throw Error("Enter the recorded agent steps in Test one output before using this grader.");
}
const datasetCaseSource = z.object({
  datasetId:z.string(),datasetName:z.string(),datasetVersion:z.string(),caseId:z.string(),
  scenarioId:z.string(),scenarioVersion:z.string(),contractHash:z.string(),
});
export type DatasetCaseSource = z.infer<typeof datasetCaseSource>;
export const storedAssessment = z.object({
  datasetCase:datasetCaseSource.optional(),
  graderId:z.string(),name:z.string(),version:z.number(),category:z.string(),engine:graderType,threshold:z.number(),
  judge:z.string().nullable(),value:z.number().min(0).max(1).nullable(),pass:z.boolean().nullable(),reason:z.string(),
  decisionRequest:z.object({
    provider:z.enum(["local","openrouter"]), requestedModel:z.string().min(1), endpoint:z.string().optional(),
    protocol:protocolSchema.optional(), fallbackModel:z.string().min(1).optional(),
    failAt:z.number().min(0).lt(1), passAt:z.number().gt(0).max(1),
  }).optional(),
  decision:observationSchema.optional(), decisionAttempt:fallbackAttemptSchema.optional(),
  evaluator:z.string().optional(),opikMetric:opikMetricResult.optional(),inputSource:inputSource.optional(),id:z.string(),created:z.string(),
  evidence:z.object({output:z.string()}).passthrough().optional(),
});
export type AssessmentEntry = z.infer<typeof storedAssessment>;
export type GraderAssessment = Omit<AssessmentEntry,"id"|"created"|"evidence"|"datasetCase">;
export type RecordedAssessment = AssessmentEntry & {candidate:string;caseId:string};
interface DefinitionFields {
  name:string;category:string;industry:string;criteria:string;threshold:number;
  intent?:"create"|"derive"|"revise";sourceGraderId?:string;evidenceView?:z.infer<typeof rubricEvidenceView>;
}
export type GraderDefinition = DefinitionFields & (
  | {type:"decision"; judgeId?:null; decision:DecisionConfig; decisionView?:z.infer<typeof rubricEvidenceView>; requiredEvidence?:z.infer<typeof evidenceRequirement>[]}
  | {type:"catalog";ruleKey?:string;ruleVersion?:number;judgeId?:null}
  | {type:"opik-metric";metricKey:OpikMetricKey;judgeId?:string|null}
  | {type:"opik"; judgeId?:string|null; requiredEvidence?:z.infer<typeof evidenceRequirement>[]}
  | {type:Exclude<GraderMethod,"decision"|"catalog"|"opik-metric"|"opik">; judgeId?:string|null}
);
export interface QuickGraderChoices {
  measures:MeasureOption[];
  automatic:GraderSpec[];recommended:(GraderSpec & {reason:string})[];available:GraderSpec[];generated:GraderDefinition|null;judges:LocalCandidate[];
}

import { z } from "opik";
import { decisionConfig, observationSchema, protocolSchema, fallbackAttemptSchema, type DecisionConfig } from "./decision-model.cjs";
import type { LocalCandidate } from "./runtime-types.cjs";

export const graderType = z.enum(["contains", "exact", "field", "trajectory", "judge", "opik", "decision"]);
export type GraderMethod = z.infer<typeof graderType>;
export type JudgeMethod = "judge" | "opik";
export const rubricOrigin = z.object({
  kind: z.literal("approved-outcome"), promptId: z.string(), promptFamilyId: z.string(), promptVersion: z.number().int(),
});
export type RubricOrigin = z.infer<typeof rubricOrigin>;
const judgeModel = z.object({
  id: z.string(), model: z.string(), provider: z.enum(["lmstudio", "ollama"]), kind: z.literal("model").default("model"),
  revision: z.string().nullable().optional(), quantization: z.string().nullable().optional(),
  nativeChat:z.boolean().optional(), reasoningOff:z.boolean().optional(),
}).passthrough();
const base = z.object({
  id:z.string(),name:z.string(),category:z.string(),industry:z.string().default("Unclassified"),criteria:z.string(),version:z.number().int(),
  threshold:z.number().min(0).max(1),opikEngine:z.string().optional(),origin:rubricOrigin.optional(),
});
const evidenceRequirement = z.enum(["reference","trajectory"]);
const requiredEvidence = z.array(evidenceRequirement).max(2)
  .refine(values => new Set(values).size === values.length, "Choose each evidence requirement once.");
export const decisionSettings = z.object({
  decision:decisionConfig, threshold:z.number().gt(0).max(1), requiredEvidence:requiredEvidence.optional(),
}).refine(g => g.decision.failAt < g.threshold, "The fail cutoff must be below the pass cutoff.");
export const savedGrader = z.union([
  base.extend({type:z.literal("decision"),judge:z.null(),decision:decisionConfig,requiredEvidence:requiredEvidence.optional()})
    .refine(g => g.decision.failAt < g.threshold, "Invalid decision cutoffs."),
  base.extend({type:z.enum(["judge","opik"]),judge:judgeModel}),
  base.extend({type:z.enum(["contains","exact","field","trajectory"]),judge:z.null()}),
]);
export type GraderSpec = z.infer<typeof savedGrader>;
const inputSource = z.enum(["recorded-dispatch", "reconstructed-case", "fixture-case"]);
export interface GraderEvidence {
  input:unknown; reference:unknown; output:string; inputSource?:z.infer<typeof inputSource>;
  trajectory?:readonly unknown[]; rubric?:string; sme_rationale?:string;
  evaluationBrief?:{objective:string;metrics:readonly string[];criteria:readonly string[]};
}
export const storedAssessment = z.object({
  graderId:z.string(),name:z.string(),version:z.number(),category:z.string(),engine:graderType,threshold:z.number(),
  judge:z.string().nullable(),value:z.number().min(0).max(1).nullable(),pass:z.boolean().nullable(),reason:z.string(),
  decisionRequest:z.object({
    provider:z.enum(["local","openrouter"]), requestedModel:z.string().min(1), endpoint:z.string().optional(),
    protocol:protocolSchema.optional(), fallbackModel:z.string().min(1).optional(),
    failAt:z.number().min(0).lt(1), passAt:z.number().gt(0).max(1),
  }).optional(),
  decision:observationSchema.optional(), decisionAttempt:fallbackAttemptSchema.optional(),
  evaluator:z.string().optional(),inputSource:inputSource.optional(),id:z.string(),created:z.string(),
  evidence:z.object({output:z.string()}).passthrough().optional(),
});
export type AssessmentEntry = z.infer<typeof storedAssessment>;
export type GraderAssessment = Omit<AssessmentEntry,"id"|"created"|"evidence">;
export type RecordedAssessment = AssessmentEntry & {candidate:string;caseId:string};
interface DefinitionFields {
  name:string;category:string;industry:string;criteria:string;threshold:number;
}
export type GraderDefinition = DefinitionFields & (
  | {type:"decision"; judgeId?:null; decision:DecisionConfig; requiredEvidence?:z.infer<typeof evidenceRequirement>[]}
  | {type:Exclude<GraderMethod,"decision">; judgeId?:string|null}
);
export interface QuickGraderChoices {
  recommended:(GraderSpec & {reason:string})[];available:GraderSpec[];generated:GraderDefinition;judges:LocalCandidate[];
}

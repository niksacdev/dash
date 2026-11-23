import { z } from "opik";
import type { LocalCandidate } from "./runtime-types.cjs";

export const graderType = z.enum(["contains", "exact", "field", "trajectory", "judge", "opik"]);
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
export const savedGrader = z.union([
  base.extend({type:z.enum(["judge","opik"]),judge:judgeModel}),
  base.extend({type:z.enum(["contains","exact","field","trajectory"]),judge:z.null()}),
]);
export type GraderSpec = z.infer<typeof savedGrader>;
export interface GraderEvidence {
  input:unknown; reference:unknown; output:string;
  trajectory?:readonly unknown[]; rubric?:string; sme_rationale?:string;
  evaluationBrief?:{objective:string;metrics:readonly string[];criteria:readonly string[]};
}
export const storedAssessment = z.object({
  graderId:z.string(),name:z.string(),version:z.number(),category:z.string(),engine:graderType,threshold:z.number(),
  judge:z.string().nullable(),value:z.number().min(0).max(1).nullable(),pass:z.boolean().nullable(),reason:z.string(),
  evaluator:z.string().optional(),id:z.string(),created:z.string(),
  evidence:z.object({output:z.string()}).passthrough().optional(),
});
export type AssessmentEntry = z.infer<typeof storedAssessment>;
export type GraderAssessment = Omit<AssessmentEntry,"id"|"created"|"evidence">;
export type RecordedAssessment = AssessmentEntry & {candidate:string;caseId:string};
export interface GraderDefinition {
  name:string;category:string;industry:string;type:GraderMethod;criteria:string;threshold:number;judgeId?:string|null;
}
export interface QuickGraderChoices {
  recommended:(GraderSpec & {reason:string})[];available:GraderSpec[];generated:GraderDefinition;judges:LocalCandidate[];
}

import { AnswerRelevance, Hallucination, Moderation, OpikBaseModel, Usefulness, z, type EvaluationScoreResult } from "opik";
import type { GraderEvidence } from "./grader-types.cjs";

export const opikMetricKey = z.enum(["answer-relevance", "usefulness", "hallucination", "moderation"]);
export type OpikMetricKey = z.infer<typeof opikMetricKey>;

const direction = z.enum(["higher-is-better", "higher-is-risk"]);
export const opikMetricResult = z.object({
  metricKey: opikMetricKey,
  nativeScore: z.number().min(0).max(1),
  direction,
});

export type OpikMetricResult = z.infer<typeof opikMetricResult>;

export interface OpikMetricTemplate {
  key: OpikMetricKey;
  name: string;
  category: string;
  criteria: string;
  requiresReference: boolean;
  direction: z.infer<typeof direction>;
  docsUrl: string;
}

export const opikLibraryTemplates: readonly OpikMetricTemplate[] = [
  {
    key: "answer-relevance", name: "Answer relevance", category: "Relevance",
    criteria: "Assess how directly the response addresses the supplied input.",
    requiresReference: false, direction: "higher-is-better",
    docsUrl: "https://www.comet.com/docs/opik/evaluation/metrics/answer_relevance",
  },
  {
    key: "usefulness", name: "Usefulness", category: "Response quality",
    criteria: "Assess how well the response helps the user accomplish the task in the input.",
    requiresReference: false, direction: "higher-is-better",
    docsUrl: "https://www.comet.com/docs/opik/evaluation/metrics/usefulness",
  },
  {
    key: "hallucination", name: "Hallucination", category: "Grounding",
    criteria: "Check whether the response contradicts or adds claims unsupported by the case reference. DASH subtracts the Opik hallucination score from one before applying the pass threshold.",
    requiresReference: true, direction: "higher-is-risk",
    docsUrl: "https://www.comet.com/docs/opik/evaluation/metrics/hallucination",
  },
  {
    key: "moderation", name: "Moderation", category: "Content safety",
    criteria: "Check the response against Opik’s moderation policy. DASH subtracts the Opik moderation score from one before applying the pass threshold.",
    requiresReference: false, direction: "higher-is-risk",
    docsUrl: "https://www.comet.com/docs/opik/evaluation/metrics/moderation",
  },
];

export function getOpikTemplate(key: OpikMetricKey) {
  const template = opikLibraryTemplates.find(item => item.key === key);
  if (!template) throw Error("Unknown Opik metric.");
  return template;
}

// Chat turns, document fields and held-out JSON answers are preserved as evidence.
function hasEvidence(value: unknown): boolean {
  if (typeof value === "string") return !!value.trim();
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  return !!value && typeof value === "object" && Object.values(value).some(hasEvidence);
}

function evidenceText(value: unknown, name: string): string {
  if (!hasEvidence(value)) throw Error("Missing " + name + " for the Opik metric.");
  return typeof value === "string" ? value : JSON.stringify(value);
}

// Preserve the precision of the judge's decimal risk at an inclusive pass cutoff.
function qualityFromRisk(risk: number): number {
  const value = 1 - risk;
  const decimal = /^0\.(\d{1,15})$/.exec(String(risk));
  return decimal ? Number(value.toFixed(decimal[1].length)) : value;
}

export async function scoreOpikMetric(key: OpikMetricKey, evidence: GraderEvidence, model: OpikBaseModel) {
  const template = getOpikTemplate(key);
  if (!(model instanceof OpikBaseModel)) throw Error("Select a local judge for the Opik metric.");
  const settings = { model, trackMetric: false, temperature: 0 };
  const output = evidenceText(evidence.output, "candidate output");
  let score: EvaluationScoreResult;
  if (key === "moderation") {
    score = await new Moderation(settings).score({ output });
  } else {
    const input = evidenceText(evidence.input, "case input");
    switch (key) {
      case "answer-relevance":
        score = await new AnswerRelevance({ ...settings, requireContext: false }).score({ input, output });
        break;
      case "usefulness":
        score = await new Usefulness(settings).score({ input, output });
        break;
      case "hallucination": {
        const reference = evidence.reference;
        if (!hasEvidence(reference)) throw Error("Hallucination requires a nonempty case reference for grounding.");
        const context = Array.isArray(reference)
          ? reference.filter(hasEvidence).map(item => evidenceText(item, "case reference"))
          : [evidenceText(reference, "case reference")];
        score = await new Hallucination(settings).score({ input, output, context });
        break;
      }
    }
  }
  const opikMetric = opikMetricResult.parse({ metricKey: key, nativeScore: score.value, direction: template.direction });
  if (!score.reason?.trim()) throw Error("The Opik judge returned no rationale.");
  return {
    value: template.direction === "higher-is-risk" ? qualityFromRisk(opikMetric.nativeScore) : opikMetric.nativeScore,
    reason: score.reason,
    opikMetric,
  };
}

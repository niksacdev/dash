import { z } from "opik";
import type { RunData, RunResult, ScenarioPack } from "./run-types.cjs";
import type { RecordedAssessment, GraderSpec } from "./grader-types.cjs";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeAdapters } from "./runtime-types.cjs";
import {jsonText} from "./run-types.cjs";
import {assistReport} from "./report-agents.cjs";
export const reportCandidate = z.object({id:z.string(),label:z.string()});
const scoreValue = z.object({candidateId:z.string(),score:z.number().nullable(),pass:z.boolean().nullable(),reason:z.string()});
const gradedCase = z.object({caseId:z.string(),values:z.array(scoreValue)});
const method = z.enum(["deterministic","llm-judge","opik-judge"]);
const metricSpec = z.object({id:z.string(),label:z.string(),version:z.union([z.number(),z.string()]).nullable(),method,threshold:z.number(),judge:z.string().nullable(),builtIn:z.boolean()});
const reportMetric = metricSpec.extend({
  totalCases:z.number(), pairedCases:z.number(), caseScores:z.array(gradedCase), values:z.array(z.object({
    candidateId:z.string(),score:z.number().nullable(),passes:z.number(),scoredCases:z.number(),availableCases:z.number(),
  })),
});
const attribution = z.object({name:z.string(),method:z.string()});
const citation = z.object({id:z.string(),metricId:z.string(),caseId:z.string()});
const verdict = z.enum(["winner","tie","mixed","incomplete","single","ungraded"]);
const observation = z.enum(["first_higher","second_higher","equal","missing","single"]);
const stage = z.object({name:z.string(),status:z.enum(["skipped","running","fallback","verified"]),
  provider:z.string().optional(),model:z.string().optional(),revision:z.string().nullable().optional(),reason:z.string().optional(),
  definition:z.object({id:z.string(),version:z.number(),hash:z.string(),path:z.string()}).optional(),
  citations:z.array(citation).optional(),verdict:verdict.optional(),winnerId:z.string().nullable().optional()}).passthrough();
const assistanceSchema = z.object({analyzer:stage,reporter:stage,reason:z.string().optional(),citations:z.array(citation.extend({
  observation,values:z.array(z.object({candidateId:z.string(),score:z.number().nullable()})),
}))});
export type Assistance = z.infer<typeof assistanceSchema>;
export const reportSchema = z.object({version:z.literal(1),analyzer:attribution,reporter:attribution,decisionRule:z.string(),
  caseCount:z.number(),candidates:z.array(reportCandidate),metrics:z.array(reportMetric),targets:z.array(z.string()),summary:z.string(),
  winnerId:z.string().nullable(),verdict,assistance:assistanceSchema.optional(),
  observedOutcomes:z.array(z.object({label:z.string(),values:z.array(z.object({candidateId:z.string(),count:z.number(),total:z.number()}))})),
}).passthrough();
export type RunReport = z.infer<typeof reportSchema>;
type Candidate = z.infer<typeof reportCandidate>;
type MetricSpec = z.infer<typeof metricSpec>;
type Metric = z.infer<typeof reportMetric>;
type Results = Map<string,RunResult>;
type Judgments = Map<string,RecordedAssessment>;


import {createHash} from "node:crypto";

const pendingStatuses = new Set(["queued", "running"]);
const decisionRule = "Compare the mean score for each pinned rubric on the same cases. A winner needs a completed two-candidate run, scores for every rubric and case, and a lead on at least one rubric with no losses. Each case has equal weight within its rubric.";

function coordinate(candidate:string, caseId:string) {
  return JSON.stringify([candidate, caseId]);
}

function methodFor(type:GraderSpec["type"]):MetricSpec["method"] {
  if (type === "judge") return "llm-judge";
  if (type === "opik") return "opik-judge";
  return "deterministic";
}

function gradeAt(result:RunResult|undefined, assessment:RecordedAssessment|undefined, builtIn:boolean) {
  const missing = (reason:string) => ({ score: null, pass: null, reason });
  if (!result) return missing("No response was recorded.");
  if (result.error) return missing(String(result.error));
  if (typeof result.output !== "string" || !result.output.trim()) return missing("No output was available for scoring.");
  if (builtIn) {
    const score = result.score;
    if (typeof score?.pass !== "boolean") return missing("The scenario check has no score.");
    return { score: Number(score.pass), pass: score.pass, reason: score.pass
      ? "The response passed the pinned scenario check."
      : score.reasons?.join(" · ") || "The response failed the pinned scenario check." };
  }
  if (!assessment) return missing("The selected grader has no assessment for this case.");
  if (assessment.value===null || !Number.isFinite(assessment.value) || assessment.value < 0 || assessment.value > 1 || typeof assessment.pass !== "boolean")
    return missing(assessment.reason || "The grader did not return a valid score.");
  return { score: assessment.value, pass: assessment.pass, reason: assessment.reason || "" };
}

function analyzeMetric(spec:MetricSpec, cases:string[], candidates:Candidate[], byCase:Results, judgments:Judgments|undefined):Metric {
  const caseScores = cases.map(caseId => ({
    caseId,
    values: candidates.map(c => {
      const key = coordinate(c.id, caseId);
      return { candidateId: c.id, ...gradeAt(byCase.get(key), judgments?.get(key), spec.builtIn) };
    }),
  }));
  const paired = caseScores.filter(row => row.values.length && row.values.every(v => v.score !== null));
  const values = candidates.map((c, index) => {
    const scores = paired.map(row => row.values[index]);
    return {
      candidateId: c.id,
      score: scores.length ? scores.reduce((sum, v) => sum + (v.score ?? 0), 0) / scores.length : null,
      passes: scores.filter(v => v.pass).length,
      scoredCases: scores.length,
      availableCases: caseScores.filter(row => row.values[index].score !== null).length,
    };
  });
  return { ...spec, pairedCases: paired.length, totalCases: cases.length, values, caseScores };
}

function domainOutcomes(pack:ScenarioPack|null, cases:string[], candidates:Candidate[], byCase:Results) {
  const fields = ["ready", "falseAccept", "review"] as const;
  if (pack?.kind === "reference" || pack?.metrics?.length !== fields.length) return [];
  return fields.map((field, i) => {
    const comparable = cases.filter(caseId => candidates.every(c => {
      const row = byCase.get(coordinate(c.id, caseId));
      return row && !row.error && typeof row.score?.[field] === "boolean";
    }));
    return {
      label: pack.metrics[i],
      values: candidates.map(c => ({
        candidateId: c.id, count: comparable.filter(caseId => byCase.get(coordinate(c.id, caseId))?.score?.[field]).length,
        total: comparable.length,
      })),
    };
  });
}

// Work only with the case IDs, output records and grader revisions pinned to this run.
export function analyzeOutputs({ manifest, results, assessments }:Pick<RunData,"manifest"|"results"|"assessments">) {
  const candidates = (manifest.candidates || []).map(c => ({ id: c.id, label: c.model || c.id }));
  const cases = [...new Set(manifest.caseIds || [])];
  const byCase = new Map(results.map(r => [coordinate(r.candidateId, r.caseId), r]));
  const specs:MetricSpec[] = (manifest.graders || []).map(g => ({
    id: g.id, label: g.name, version: g.version, method: methodFor(g.type), threshold: g.threshold,
    judge: g.judge?.id || null, builtIn: false,
  }));
  if (manifest.pack && manifest.datasetScorer !== "selected-graders") {
    const pack = manifest.pack;
    specs.unshift({ id: "scenario/" + (manifest.policyHash || pack.scorer || pack.id),
      label: manifest.datasetScorer === "exact-reference" ? "Exact reference match" : "Scenario check",
      version: pack.scorer || null, method: "deterministic", threshold: 1, judge: null, builtIn: true });
  }
  const pinned = new Map((manifest.graders || []).map(g => [g.id, g]));
  const judgments = new Map<string,Judgments>();
  for (const a of assessments) {
    const grader = pinned.get(a.graderId);
    if (!grader || a.version !== grader.version || a.engine !== grader.type || (a.judge || null) !== (grader.judge?.id || null)) continue;
    if (!judgments.has(a.graderId)) judgments.set(a.graderId, new Map());
    const map = judgments.get(a.graderId), key = coordinate(a.candidate, a.caseId);
    // A later manual re-grade has a separate identity and never replaces the original verdict.
    if (map && !map.has(key)) map.set(key, a);
  }
  const metrics = specs.map(spec => analyzeMetric(spec, cases, candidates, byCase, judgments.get(spec.id)));
  return {
    analyzer: { name: "Output Analyzer", method: "deterministic" },
    caseCount: cases.length, candidates, metrics, targets: manifest.approvedPrompt?.metrics || [],
    observedOutcomes: domainOutcomes(manifest.pack, cases, candidates, byCase),
  };
}

function comparison(status:string, analysis:ReturnType<typeof analyzeOutputs>):{verdict:RunReport["verdict"];summary:string;winnerId?:string} {
  const { caseCount, candidates, metrics } = analysis;
  if (status !== "completed") return { verdict: "incomplete", summary: "The run ended with status " + status + ". Available case evidence is shown below." };
  if (!metrics.length) return { verdict: "ungraded", summary: "The run has no pinned grading rubric. Its responses are available for inspection." };
  if (!caseCount || !candidates.length || metrics.some(m => m.pairedCases !== caseCount))
    return { verdict: "incomplete", summary: "Some candidate cases have no comparable score. Inspect rubric coverage and the case reasons." };
  if (candidates.length === 1) return { verdict: "single", summary: candidates[0].label + " was assessed on " + caseCount + (caseCount === 1 ? " case." : " cases.") };
  if (candidates.length !== 2) return { verdict: "incomplete", summary: "A head-to-head comparison needs two candidates." };
  const leads = new Set<number>();
  for (const metric of metrics) {
    const [a,b] = metric.values;
    if(a.score===null || b.score===null) return {verdict:"incomplete",summary:"Some rubric means are missing."};
    const delta = a.score - b.score;
    if (Math.abs(delta) > 1e-12) leads.add(delta > 0 ? 0 : 1);
  }
  if (!leads.size) return { verdict: "tie", summary: "The candidates tied on every rubric mean." };
  if (leads.size > 1) return { verdict: "mixed", summary: "Each candidate led on a different rubric. The rubric-level results show the trade-off." };
  const winner = candidates[[...leads][0]];
  return { verdict: "winner", winnerId: winner.id, summary: winner.label + " led on at least one scored rubric and matched or exceeded its opponent on every other rubric." };
}

export function buildReport(run:RunData):RunReport|null {
  if (pendingStatuses.has(run.status)) return null;
  const analysis = analyzeOutputs(run);
  return { version: 1, reporter: { name: "Report agent", method: "deterministic" },
    winnerId: null, ...comparison(run.status, analysis), decisionRule, ...analysis };
}

export class RunReports {
  constructor(readonly db:DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS run_reports(run TEXT PRIMARY KEY, signature TEXT NOT NULL, report TEXT NOT NULL)");
  }
  signature(run:RunData) {
    // Subsequent rescoring is independent of the first assessment used for each pinned rubric.
    const selected = new Map((run.manifest.graders || []).map(g => [g.id, g]));
    const ids = new Map();
    for (const a of run.assessments) {
      const grader = selected.get(a.graderId);
      if (!grader || a.version !== grader.version || a.engine !== grader.type || (a.judge || null) !== (grader.judge?.id || null)) continue;
      const key = JSON.stringify([a.graderId, a.candidate, a.caseId]);
      if (!ids.has(key)) ids.set(key, a.id);
    }
    return createHash("sha256").update(JSON.stringify([2, run.status, run.results.length, [...ids.values()]])).digest("hex");
  }
  save(run:RunData, report:RunReport|null, signature = this.signature(run)) {
    this.db.prepare("INSERT INTO run_reports VALUES(?,?,?) ON CONFLICT(run) DO UPDATE SET signature=excluded.signature,report=excluded.report")
      .run(run.manifest.id, signature, JSON.stringify(report));
    return report;
  }
  get(run:RunData):RunReport|null {
    if (pendingStatuses.has(run.status)) return null;
    const signature = this.signature(run);
    const existing = this.db.prepare("SELECT signature, report FROM run_reports WHERE run=?").get(run.manifest.id);
    if (existing?.signature === signature) return reportSchema.parse(jsonText(existing.report));
    return this.save(run, buildReport(run), signature);
  }
  async finalize(run:RunData, adapters:RuntimeAdapters, signal:AbortSignal, progress:(stage:string)=>void) {
    const report = buildReport(run);
    if (!report) throw Error("Only terminal runs have reports.");
    const enriched = await assistReport(report, adapters, signal, progress);
    signal.throwIfAborted();
    return this.save(run, enriched);
  }
}


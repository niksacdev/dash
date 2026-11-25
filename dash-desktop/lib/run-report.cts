import { z } from "opik";
import type { RunData, RunResult, ScenarioPack } from "./run-types.cjs";
import type { RecordedAssessment, GraderSpec } from "./grader-types.cjs";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeAdapters } from "./runtime-types.cjs";
import {jsonText} from "./run-types.cjs";
import {opikMetricResult,getOpikTemplate} from "./opik-library.cjs";
import {graderLibrary} from "./grader-types.cjs";
import {isInformationalRule} from "./grader-catalog.cjs";
import {observationSchema} from "./decision-model.cjs";
import {assistReport} from "./report-agents.cjs";
export const reportCandidate = z.object({id:z.string(),label:z.string()});
const decisionPolicy = observationSchema.pick({provider:true,requestedModel:true,failAt:true,passAt:true})
  .extend({protocol:z.enum(["systemone","mlx-vlm"]).optional(),fallbackModel:z.string().optional()});
const decisionEvidence = decisionPolicy.extend({
  status:z.enum(["passed","failed","review","unscored"]),
  ...observationSchema.pick({actualModel:true,probabilityYes:true,usage:true,dispatchedModel:true,fallbackReason:true,identityVerification:true}).partial().shape,
});
const scoreValue = z.object({decision:decisionEvidence.optional(),opikMetric:opikMetricResult.optional(),candidateId:z.string(),score:z.number().nullable(),pass:z.boolean().nullable(),reason:z.string()});
const gradedCase = z.object({caseId:z.string(),values:z.array(scoreValue)});
const method = z.enum(["deterministic","llm-judge","opik-judge","opik-metric","decision-model"]);
const lineage = graderLibrary.pick({scope:true,familyId:true,parentRevisionId:true});
const metricSpec = z.object({id:z.string(),label:z.string(),version:z.union([z.number(),z.string()]).nullable(),method,threshold:z.number(),judge:z.string().nullable(),builtIn:z.boolean(),decisionPolicy:decisionPolicy.optional(),lineage:lineage.optional(),informational:z.boolean().optional()});
const reportMetric = metricSpec.extend({
  comparisonIssue:z.string().optional(),totalCases:z.number(), pairedCases:z.number(), caseScores:z.array(gradedCase), values:z.array(z.object({
    candidateId:z.string(),score:z.number().nullable(),passes:z.number(),scoredCases:z.number(),availableCases:z.number(),
  })),
});
const attribution = z.object({name:z.string(),method:z.string()});
const citation = z.object({id:z.string(),metricId:z.string(),caseId:z.string()});
const verdict = z.enum(["winner","tie","mixed","incomplete","single","ungraded","unsafe"]);
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
  winnerId:z.string().nullable(),verdict,assistance:assistanceSchema.optional(),cacheIssue:z.string().optional(),
  observedOutcomes:z.array(z.object({label:z.string(),field:z.enum(["ready","falseAccept","review"]).optional(),
    values:z.array(z.object({candidateId:z.string(),count:z.number(),total:z.number(),caseIds:z.array(z.string()).optional()}))})),
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
  if (type === "decision") return "decision-model";
  if (type === "judge") return "llm-judge";
  if (type === "opik-metric") return "opik-metric";
  if (type === "opik") return "opik-judge";
  return "deterministic";
}

function pinnedJudge(grader:GraderSpec) {
  return grader.type === "decision" ? grader.decision.model : grader.judge?.id ?? null;
}
function matchesGrader(grader:GraderSpec|undefined, a:RecordedAssessment) {
  return grader && a.version === grader.version && a.engine === grader.type && a.judge === pinnedJudge(grader);
}
type DecisionGrader = Extract<GraderSpec,{type:"decision"}>;
function decisionPolicyFor(grader:DecisionGrader) {
  const pin=grader.decision;
  return {provider:pin.provider, requestedModel:pin.model, failAt:pin.failAt, passAt:grader.threshold,
    ...(pin.provider === "local" && {protocol:pin.protocol ?? "systemone",...(pin.fallbackModel && {fallbackModel:pin.fallbackModel})})};
}
function gradeDecision(grader:DecisionGrader, a:RecordedAssessment):Omit<z.infer<typeof scoreValue>,"candidateId"> {
  const pin = grader.decision;
  const policy=decisionPolicyFor(grader);
  const request = a.decisionRequest, observed = a.decision;
  const missing = (reason:string) => ({score:null,pass:null,reason,decision:{...policy,status:"unscored" as const}});
  const protocolMatches = pin.provider === "local"
    ? (request?.protocol ?? "systemone") === policy.protocol : !request?.protocol;
  if (!request || !protocolMatches || request.provider !== pin.provider || request.requestedModel !== pin.model ||
      request.endpoint !== pin.endpoint || request.fallbackModel !== pin.fallbackModel ||
      request.failAt !== pin.failAt || request.passAt !== grader.threshold ||
      a.threshold !== grader.threshold) return missing("The decision request does not match the pinned grader.");
  if (!observed) {
    const unscored=missing(a.reason || "No decision-model response was recorded."), attempt=a.decisionAttempt;
    if (attempt && pin.provider === "local" && attempt.requestedModel === pin.model &&
        attempt.protocol === (pin.protocol ?? "systemone") && attempt.dispatchedModel === pin.fallbackModel)
      return {...unscored,decision:{...unscored.decision,dispatchedModel:attempt.dispatchedModel,fallbackReason:attempt.fallbackReason}};
    return unscored;
  }
  const dispatched=observed.dispatchedModel ?? pin.model;
  const usedFallback=dispatched !== pin.model;
  const identityMatches=pin.provider === "local"
    ? observed.identityVerification !== "openrouter-catalog" && observed.actualModel === dispatched && (observed.protocol ?? "systemone") === (pin.protocol ?? "systemone") &&
      (usedFallback ? dispatched === pin.fallbackModel && !!observed.fallbackReason : !observed.fallbackReason)
    : !observed.protocol && !usedFallback && !observed.fallbackReason &&
      (observed.actualModel === pin.model || observed.identityVerification === "openrouter-catalog");
  if (!identityMatches || observed.provider !== pin.provider || observed.requestedModel !== pin.model ||
      observed.failAt !== pin.failAt || observed.passAt !== grader.threshold || !observed.actualModel.trim() ||
      !Number.isFinite(observed.probabilityYes) || observed.probabilityYes < 0 || observed.probabilityYes > 1)
    return missing("The decision response could not be verified against the pinned grader.");
  const evidence = {...policy,dispatchedModel:dispatched,actualModel:observed.actualModel,probabilityYes:observed.probabilityYes,
    ...(observed.fallbackReason && {fallbackReason:observed.fallbackReason}),
    ...(observed.identityVerification && {identityVerification:observed.identityVerification}),...(observed.usage && {usage:observed.usage})};
  const expected = observed.probabilityYes >= policy.passAt ? true : observed.probabilityYes <= policy.failAt ? false : null;
  if (expected === null && a.pass === null && a.value === null)
    return {score:null,pass:null,reason:a.reason,decision:{...evidence,status:"review"}};
  if (expected === null || a.pass !== expected || a.value !== Number(expected))
    return {score:null,pass:null,reason:a.pass === null && a.value === null ? a.reason : "The recorded grade does not agree with the raw probability and pinned cutoffs.",
      decision:{...evidence,status:"unscored"}};
  return {score:a.value,pass:expected,reason:a.reason,decision:{...evidence,status:expected?"passed":"failed"}};
}
function gradeAt(result:RunResult|undefined, assessment:RecordedAssessment|undefined, builtIn:boolean, grader:GraderSpec|undefined):Omit<z.infer<typeof scoreValue>,"candidateId"> {
  const missing = (reason:string) => ({ score: null, pass: null, reason });
  if (!result) return missing("No response was recorded.");
  if (grader?.type!=="catalog" || !isInformationalRule(grader.ruleKey)) {
    if (result.error) return missing(String(result.error));
    if (typeof result.output !== "string" || !result.output.trim()) return missing("No output was available for scoring.");
  }
  if (builtIn) {
    const score = result.score;
    if (typeof score?.pass !== "boolean") return missing(result.gradingError ?? "The scenario check has no score.");
    return { score: Number(score.pass), pass: score.pass, reason: score.pass
      ? "The response passed the pinned scenario check."
      : score.reasons?.join(" · ") || "The response failed the pinned scenario check." };
  }
  if (!assessment) return missing("The selected grader has no assessment for this case.");
  if (grader?.type === "decision") return gradeDecision(grader, assessment);
  if (assessment.value===null || !Number.isFinite(assessment.value) || assessment.value < 0 || assessment.value > 1 || typeof assessment.pass !== "boolean")
    return missing(assessment.reason || "The grader did not return a valid score.");
  if (grader?.type === "opik-metric") {
    const native=assessment.opikMetric, expected=getOpikTemplate(grader.metricKey).direction;
    if (!native || native.metricKey!==grader.metricKey || native.direction!==expected || assessment.threshold!==grader.threshold ||
        Math.abs(assessment.value-(expected==="higher-is-risk" ? 1-native.nativeScore : native.nativeScore))>1e-12 ||
        assessment.pass!==(assessment.value>=grader.threshold)) return missing("The native Opik metric receipt does not match the pinned grader.");
    return {score:assessment.value,pass:assessment.pass,reason:assessment.reason,opikMetric:native};
  }
  return { score: assessment.value, pass: assessment.pass, reason: assessment.reason || "" };
}

function analyzeMetric(spec:MetricSpec, cases:string[], candidates:Candidate[], byCase:Results, judgments:Judgments|undefined, grader:GraderSpec|undefined):Metric {
  const caseScores = cases.map(caseId => ({
    caseId,
    values: candidates.map(c => {
      const key = coordinate(c.id, caseId);
      return { candidateId: c.id, ...gradeAt(byCase.get(key), judgments?.get(key), spec.builtIn, grader) };
    }),
  }));
  // Model aliases can resolve to different served revisions during a run.
  const servedModels = new Set(caseScores.flatMap(row=>row.values.flatMap(v=>v.decision?.actualModel ? [v.decision.actualModel] : [])));
  const comparisonIssue = servedModels.size > 1 ? "The decision grader served multiple model revisions. Each case keeps its recorded grade, but the rubric has no comparable mean." : undefined;
  const paired = comparisonIssue ? [] : caseScores.filter(row => row.values.length && row.values.every(v => v.score !== null));
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
  return { ...spec, ...(comparisonIssue && {comparisonIssue}), pairedCases: paired.length, totalCases: cases.length, values, caseScores };
}

function domainOutcomes(pack:ScenarioPack|null, cases:string[], candidates:Candidate[], byCase:Results) {
  const fields = ["ready", "falseAccept", "review"] as const;
  if (!pack || pack.kind === "reference") return [];
  return fields.map((field,i)=>({
    field, label:pack.metrics[i] || ["Ready","False accepts","Review"][i],
    values:candidates.map(c=>{
      const observed=cases.filter(id=>{
        const r=byCase.get(coordinate(c.id,id));
        return r && !r.error && typeof r.score?.[field]==="boolean";
      });
      const positive=observed.filter(id=>byCase.get(coordinate(c.id,id))?.score?.[field]);
      return {candidateId:c.id,count:positive.length,total:observed.length,...(field==="falseAccept" && {caseIds:positive})};
    }),
  }));
}

// Work only with the case IDs, output records and grader revisions pinned to this run.
export function analyzeOutputs({ manifest, results, assessments }:Pick<RunData,"manifest"|"results"|"assessments">) {
  const candidates = (manifest.candidates || []).map(c => ({ id: c.id, label: c.model || c.id }));
  const cases = [...new Set(manifest.caseIds || [])];
  const byCase = new Map(results.map(r => [coordinate(r.candidateId, r.caseId), r]));
  const specs:MetricSpec[] = (manifest.graders || []).map(g => ({
    id: g.id, label: g.name, version: g.version, method: methodFor(g.type), threshold: g.threshold,
    judge: pinnedJudge(g), builtIn: false,
    ...(g.type==="catalog" && isInformationalRule(g.ruleKey) && {informational:true}),
    ...(g.library && {lineage:{scope:g.library.scope,familyId:g.library.familyId,...(g.library.parentRevisionId && {parentRevisionId:g.library.parentRevisionId})}}),
    ...(g.type === "decision" && {decisionPolicy:decisionPolicyFor(g)}),
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
    if (!matchesGrader(grader, a)) continue;
    if (!judgments.has(a.graderId)) judgments.set(a.graderId, new Map());
    const map = judgments.get(a.graderId), key = coordinate(a.candidate, a.caseId);
    // A later manual re-grade has a separate identity and never replaces the original verdict.
    if (map && !map.has(key)) map.set(key, a);
  }
  const metrics = specs.map(spec => analyzeMetric(spec, cases, candidates, byCase, judgments.get(spec.id), pinned.get(spec.id)));
  return {
    analyzer: { name: "Output Analyzer", method: "deterministic" },
    caseCount: cases.length, candidates, metrics, targets: manifest.approvedPrompt?.metrics || [],
    observedOutcomes: manifest.datasetScorer==="selected-graders" ? [] : domainOutcomes(manifest.pack, cases, candidates, byCase),
  };
}

function comparison(status:string, analysis:ReturnType<typeof analyzeOutputs>, guardFalseAccepts:boolean,unscoredMeasures:number):{verdict:RunReport["verdict"];summary:string;winnerId?:string} {
  const {caseCount,candidates}=analysis;
  const metrics=analysis.metrics.filter(metric=>!metric.informational);
  if (status !== "completed") return { verdict: "incomplete", summary: "The run ended with status " + status + ". Available case evidence is shown below." };
  if (!metrics.length) return { verdict: "ungraded", summary: analysis.metrics.length ? "Only response diagnostics were recorded. A business verdict requires a quality rubric." : "The run has no pinned grading rubric. Its responses are available for inspection." };
  if(unscoredMeasures>0)return {verdict:"incomplete",summary:unscoredMeasures+" approved "+(unscoredMeasures===1 ? "measure was" : "measures were")+" left unscored. Compare the available grades below."};
  if (!caseCount || !candidates.length || metrics.some(m => m.pairedCases !== caseCount))
    return { verdict: "incomplete", summary: "A quality check did not produce matching scores for every candidate and case. The missing scores and available next steps are listed below." };
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
  const safety=guardFalseAccepts && analysis.observedOutcomes.find(m=>m.field==="falseAccept")?.values.find(v=>v.candidateId===winner.id);
  if (safety && safety.count) return {verdict:"unsafe",summary:winner.label+" led on the quality rubrics but falsely accepted "+safety.count+" of "+safety.total+" observed cases. No winner is declared."};
  if (safety && safety.total!==caseCount) return {verdict:"incomplete",summary:winner.label+" led on the quality rubrics. False-accept evidence is missing for "+(caseCount-safety.total)+" cases."};
  return { verdict: "winner", winnerId: winner.id, summary: winner.label + " led on at least one scored rubric and matched or exceeded its opponent on every other rubric." };
}

export function buildReport(run:RunData):RunReport|null {
  if (pendingStatuses.has(run.status)) return null;
  const analysis = analyzeOutputs(run);
  const currentPolicy=!!run.manifest.graders?.some(g=>g.type==="catalog" && g.library?.automatic && isInformationalRule(g.ruleKey));
  const policy=currentPolicy ? "Compare the mean score on each business rubric, with equal weight for every case. A winner requires a completed two-candidate run with every business grade present, at least one lead, and no losses. Response diagnostics are informational. In a scored domain scenario the leading candidate must have zero false accepts across all cases." : decisionRule;
  return { version: 1, reporter: { name: "Report agent", method: "deterministic" },
    winnerId: null, ...(run.manifest.inspectionOnly && run.status==="completed"
      ? {verdict:"ungraded" as const,summary:"Answer inspection was selected before GO. The saved answers and any individual checks are available below."}
      : comparison(run.status,analysis,currentPolicy,run.manifest.measureGraders?.filter(row=>row.graderId===null).length ?? 0)), decisionRule:policy, ...analysis };
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
      if (!matchesGrader(grader, a)) continue;
      const key = JSON.stringify([a.graderId, a.candidate, a.caseId]);
      if (!ids.has(key)) ids.set(key, a.id);
    }
    return createHash("sha256").update(JSON.stringify([2, run.status, run.results.length, [...ids.values()]])).digest("hex");
  }
  save(run:RunData, report:RunReport|null, signature = this.signature(run)) {
    try {
      this.db.prepare("INSERT INTO run_reports VALUES(?,?,?) ON CONFLICT(run) DO UPDATE SET signature=excluded.signature,report=excluded.report")
        .run(run.manifest.id,signature,JSON.stringify(report));
      return report;
    } catch {
      return report && {...report,cacheIssue:"DASH could not cache the report. It can be rebuilt from the saved case results and assessments."};
    }
  }
  get(run:RunData):RunReport|null {
    if (pendingStatuses.has(run.status)) return null;
    const signature = this.signature(run);
    try {
      const existing=this.db.prepare("SELECT signature,report FROM run_reports WHERE run=?").get(run.manifest.id);
      if (existing?.signature===signature) return reportSchema.parse(jsonText(existing.report));
    } catch { /* A missing or damaged cache must leave the primary evidence accessible. */ }
    return this.save(run, buildReport(run), signature);
  }
  async finalize(run:RunData, adapters:RuntimeAdapters, signal:AbortSignal, progress:(stage:string)=>void) {
    const report = buildReport(run);
    if (!report) throw Error("Only terminal runs have reports.");
    let enriched:RunReport;
    try {enriched=await assistReport(report,adapters,signal,progress);}
    catch {
      signal.throwIfAborted();
      enriched={...report,assistance:{
        analyzer:{name:"Output Analyzer",status:"fallback"},reporter:{name:"Report agent",status:"fallback"},citations:[],
        reason:"Report assistance was unavailable. The comparison uses the saved case results and grader assessments.",
      }};
    }
    signal.throwIfAborted();
    return this.save(run,enriched);
  }
}


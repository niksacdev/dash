import {randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";
import type {Graders} from "./graders.cjs";
import {graderEvidence} from "./evaluation-cases.cjs";
import {graderRequiredEvidence,requireAssessmentEvidence,storedAssessment,type GraderSpec} from "./grader-types.cjs";
import {quickGradingReference,hasExpectedAnswerFor} from "./grader-types.cjs";
import {inspectionCaseReference,isInspectionCheck} from "./inspection-decision.cjs";
import {isInformationalRule} from "./grader-catalog.cjs";
import {jsonText,type CaseRow,type RunDetail,type RunData} from "./run-types.cjs";
import {analyzeOutputs,buildReport,type RunReport} from "./run-report.cjs";
import type {RuntimeAdapters} from "./runtime-types.cjs";

export const reviewRequest=z.strictObject({run:z.string().min(1).max(200),caseId:z.string().min(1).max(200),grader:z.string().min(1).max(200),
  expectedAnswer:z.string().trim().min(1).max(12000).optional(),allowHostedDecision:z.literal(true).optional()});
const record=storedAssessment.extend({candidate:z.string(),caseId:z.string()});
const reviewSchema=z.object({id:z.string(),caseId:z.string(),graderId:z.string(),graderName:z.string(),version:z.number(),created:z.string(),
  source:z.enum(["saved run","dataset case","supplied for review","task and answer"]),status:z.enum(["grading","completed","interrupted"]),
  comparisonIssue:z.string().optional(),finding:z.object({status:z.enum(["higher","equal","inconclusive"]),candidateId:z.string().optional()}).optional(),grades:z.array(record).max(2)});
export type SavedReview=z.infer<typeof reviewSchema>;
export type ReviewSummary=Pick<RunReport,"verdict"|"winnerId"|"summary">;

// Reuse the verdict's pinned-receipt validation, including served revision and decision abstention.
function reviewMetric(run:RunData,review:SavedReview,grader:GraderSpec) {
  return analyzeOutputs({
    manifest:{...run.manifest,caseIds:[review.caseId],graders:[grader],pack:null},
    results:run.results.filter(result=>result.caseId===review.caseId),assessments:review.grades,
  }).metrics[0];
}
type CaseScores=RunReport["metrics"][number]["caseScores"][number];
// Called on scores the report has already validated against the pinned grader.
function completeRevision(cell:CaseScores):string|null|undefined {
  if(!cell.values.length || cell.values.some(v=>v.score===null))return undefined;
  const revisions=new Set(cell.values.map(v=>v.decision?.actualModel ?? null));
  return revisions.size===1 ? cell.values[0].decision?.actualModel ?? null : undefined;
}
function reviewCoverage(run:RunData,original:RunReport,history:SavedReview[],grader:GraderSpec) {
  const check=original.metrics.find(m=>m.id===grader.id && !m.informational);
  const originals=new Map<string,string|null>();
  for(const cell of check?.caseScores ?? []) {
    const revision=completeRevision(cell);
    if(revision!==undefined)originals.set(cell.caseId,revision);
  }
  const qualified:{review:SavedReview;revision:string|null}[]=[];
  for(const review of history) {
    if(review.status!=="completed" || review.graderId!==grader.id || review.version!==grader.version ||
       review.grades.length!==run.manifest.candidates.length)continue;
    const metric=reviewMetric(run,review,grader);
    if(metric?.pairedCases===1)qualified.push({review,revision:metric.caseScores[0].values[0].decision?.actualModel ?? null});
  }
  // Fix the serving revision without considering who passed. Prefer an original complete pair.
  // With no complete original, the earliest independently comparable saved pair establishes the revision.
  const originalRevisions=new Set(originals.values());
  const revision=grader.type!=="decision" ? null : originalRevisions.has(grader.decision.model) ?
    grader.decision.model : originals.values().next().value ?? qualified[0]?.revision ?? null;
  const covered=new Set([...originals].filter(([,served])=>served===revision).map(([id])=>id));
  const selected:SavedReview[]=[];
  for(const pair of qualified) {
    if(pair.revision!==revision || covered.has(pair.review.caseId))continue;
    selected.push(pair.review);covered.add(pair.review.caseId);
  }
  return {revision,covered,selected};
}
export interface DecisionReviewTarget {model:string;caseIds:string[]}
export function reviewResults(run:RunData,original:RunReport|null,history:SavedReview[]) {
  const evidence=history.length ? {savedReviews:history} : {};
  if(!original || original.verdict!=="incomplete" || run.status!=="completed" || run.manifest.inspectionOnly)return evidence;
  const targets:Record<string,DecisionReviewTarget>={};
  const replacements=new Map<string,SavedReview>();
  for(const grader of run.manifest.graders) {
    if(grader.type!=="decision" && !history.some(r=>r.graderId===grader.id))continue;
    const coverage=reviewCoverage(run,original,history,grader);
    if(coverage.revision)targets[grader.id]={model:coverage.revision,caseIds:run.manifest.caseIds.filter(id=>!coverage.covered.has(id))};
    for(const r of coverage.selected)replacements.set(JSON.stringify([r.caseId,r.graderId]),r);
  }
  const decisionReviewTargets=Object.keys(targets).length ? targets : undefined;
  if(!replacements.size)return {...evidence,decisionReviewTargets};
  const unchanged=run.assessments.filter(a=>!replacements.has(JSON.stringify([a.caseId,a.graderId])));
  const revised=buildReport({...run,assessments:[...unchanged,...[...replacements.values()].flatMap(r=>r.grades)]});
  const reviewedVerdict:ReviewSummary|undefined=revised && revised.verdict!=="incomplete" ?
    {verdict:revised.verdict,winnerId:revised.winnerId,summary:revised.summary} : undefined;
  return {...evidence,decisionReviewTargets,reviewedVerdict};
}

export function canChallengeVerdict(report:RunReport,run:RunData) {
  return run.status==="completed" && report.candidates.length===2 && ["tie","winner","mixed","unsafe"].includes(report.verdict);
}

export class SavedScoreReviews {
  private readonly active=new Set<string>();
  get busy() {return this.active.size>0;}
  constructor(private readonly db:DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS saved_score_reviews(id TEXT PRIMARY KEY,run TEXT NOT NULL,record TEXT NOT NULL,expected_answer TEXT); CREATE INDEX IF NOT EXISTS score_reviews_by_run ON saved_score_reviews(run)");
    db.prepare("UPDATE saved_score_reviews SET record=json_set(record,'$.status','interrupted') WHERE json_extract(record,'$.status')='grading'").run();
  }
  list(run:string):SavedReview[] {
    return this.db.prepare("SELECT record FROM saved_score_reviews WHERE run=? ORDER BY rowid").all(run).map(r=>reviewSchema.parse(jsonText(r.record)));
  }
  async assess(request:z.infer<typeof reviewRequest>,run:RunDetail,g:GraderSpec,row:CaseRow,
    originalAnswer:string|null,graders:Graders,adapters:RuntimeAdapters) {
    if(this.busy)throw Error("A saved-answer review is already running. Wait for it to finish.");
    if(!run.report || (!["incomplete","ungraded"].includes(run.report.verdict) && !canChallengeVerdict(run.report,run)))
      throw Error("Open a finished comparison with saved answers before requesting a review.");
    if(g.type==="catalog" && isInformationalRule(g.ruleKey))throw Error("Choose a business quality grader for the saved answers.");
    if(g.type==="decision" && g.decision.provider==="openrouter" && !request.allowHostedDecision)
      throw Error("Confirm the hosted decision grader before sending saved answers and any grading facts.");
    if(!graders.appliesToDataset(g,run.manifest.industry ?? "",run.manifest.pack?.id ?? "") && !run.manifest.graders.some(pin=>pin.id===g.id))
      throw Error("Choose a grader for this run’s industry and scenario.");
    const needs=graderRequiredEvidence(g).includes("reference");
    const captured=run.manifest.mode==="quick" ? quickGradingReference(g,originalAnswer) :
      isInspectionCheck(g) ? inspectionCaseReference(g,row,run.manifest.pack) : row.reference ?? row.gold;
    const sourced=isInspectionCheck(g) && run.hasSourcedInspectionDecision;
    if(request.expectedAnswer && (!needs || sourced || hasExpectedAnswerFor(g,captured)))
      throw Error("This check uses the evidence already saved for the case. Clear the additional expected answer.");
    const reference=request.expectedAnswer ? quickGradingReference(g,request.expectedAnswer) : captured;
    const prepared=run.manifest.candidates.map(c=>{
      const result=run.results.find(r=>r.caseId===request.caseId && r.candidateId===c.id);
      if(!result || result.dispatchState || result.error || !result.output?.trim())throw Error("A candidate has no saved answer for this case. Open its trace and rerun that candidate if you need its response.");
      const evidence=graderEvidence(run.manifest,row,result,g.type==="catalog",g.id);
      if(needs)evidence.reference=reference;
      requireAssessmentEvidence(g,evidence);
      return {candidate:c.id,evidence};
    });
    const id=randomUUID(),created=new Date().toISOString();
    const review:SavedReview={id,created,caseId:request.caseId,graderId:g.id,graderName:g.name,version:g.version,
      status:"grading",source:request.expectedAnswer?"supplied for review":!needs?"task and answer":run.manifest.mode==="quick"?"saved run":"dataset case",grades:[]};
    const prior=this.list(run.manifest.id);
    const coverage=reviewCoverage(run,run.report,prior,g);
    if(coverage.covered.has(request.caseId))throw Error("The original run or a completed review already scores this case with that grader"+
      (coverage.revision?" using "+coverage.revision:"")+". See the recorded grades and review a case still missing a comparable score.");
    this.db.prepare("INSERT INTO saved_score_reviews VALUES(?,?,?,?)").run(id,run.manifest.id,JSON.stringify(review),request.expectedAnswer ?? null);
    this.active.add(run.manifest.id);
    const save=()=>this.db.prepare("UPDATE saved_score_reviews SET record=? WHERE id=?").run(JSON.stringify(review),id);
    try {
      for(const {candidate,evidence} of prepared) {
        const grade=await graders.assess(g,evidence,adapters,AbortSignal.timeout(190000),!!request.allowHostedDecision);
        review.grades.push({...grade,id:randomUUID(),created:new Date().toISOString(),candidate,caseId:request.caseId});
        save();
      }
      review.status="completed";
      const metric=reviewMetric(run,review,g);
      review.comparisonIssue=metric?.comparisonIssue;
      if(run.manifest.candidates.length===2 && metric) {
        const [a,b]=metric.values;
        if(metric.pairedCases!==1 || a.score===null || b.score===null)review.finding={status:"inconclusive"};
        else if(Math.abs(a.score-b.score)<=1e-12)review.finding={status:"equal"};
        else review.finding={status:"higher",candidateId:a.score>b.score ? a.candidateId : b.candidateId};
      }
      save();
    } catch(error) {
      review.status="interrupted";save();throw error;
    } finally {this.active.delete(run.manifest.id);}
    return id;
  }
}

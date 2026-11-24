import {z} from "zod";
import type {ScenarioContract, EvidenceCoverage} from "./outcome-contracts.cjs";
export const auditRow = z.object({
  metric:z.string().trim().min(1).max(2000), criterion:z.string().trim().min(1).max(2000),
  status:z.enum(["proposed","needs-evidence","external"]),
  evidence:z.string().trim().min(1).max(700), method:z.string().trim().min(1).max(700), reason:z.string().trim().min(1).max(700),
});
export type MetricAudit = z.infer<typeof auditRow>;
export const persistedAudit = z.array(auditRow).max(16);
export const rationaleSchema = z.object({original:z.string().max(12000),addition:z.string().max(24000),reason:z.string().min(1).max(800)});
export type PromptRationale = z.infer<typeof rationaleSchema>;
export const metricsAuditSchema = {type:"object",properties:{audit:{type:"array",minItems:1,maxItems:8,items:{
  type:"object",additionalProperties:false,required:["metric","criterion","status","evidence","method","reason"],properties:{
    metric:{type:"string",maxLength:180},criterion:{type:"string",maxLength:300},status:{type:"string",enum:["proposed","needs-evidence","external"]},
    evidence:{type:"string",maxLength:240},method:{type:"string",maxLength:240},reason:{type:"string",maxLength:240},
  }}}},required:["audit"],additionalProperties:false};
const externalOutcome=/\b(?:ROI|return on investment|(?:money|dollars?|hours?|minutes?|time|costs?) saved|(?:revenue|profit|sales) (?:growth|increase|gain|uplift)|(?:realized|realised|actual|annual) savings|(?:reduce[ds]?|lower|cut|saving|savings? in) (?:operating costs?|costs?|(?:analyst|handling|review) (?:time|hours)|downtime|scrap)|(?:investor confidence|employee morale|brand reputation|customer satisfaction|plant downtime|scrap reduction|stock returns?|market share))\b/i;
const genericTerms=new Set("a the candidate model business overall answer response its is high good better output task meet meets achieve achieves fulfill fulfills satisfy satisfies quality correctness accurate accuracy successful success requirement requirements objective outcome correct complete metric score pass rate as expected improve improves improved of goal goals".split(" "));
function words(text:string) {return (text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");}
export function isExternalOutcomeMetric(metric:string):boolean {
  const text=words(metric);
  // Extraction accuracy can be tested against a source reporting an operational outcome.
  if (/\b(?:extract(?:ed|ing|ion)?|captur(?:e|ing)|transcrib(?:e|ing)|match(?:es|ing)?|correctly reports?)\b.{0,90}\b(?:reported|disclosed|stated|quoted|supplied (?:filing|release|record|source))\b/.test(text) ||
      /\b(?:reported|disclosed|stated)\b.{0,70}\b(?:extraction|capture) (?:accuracy|errors?)\b/.test(text)) return false;
  return externalOutcome.test(text) || /\b(?:warranty|operating|operational|service|production|maintenance) costs? (?:reduction|savings|decrease)|\b(?:reduce|cut|lower) (?:warranty|operating|service|production|maintenance) costs?\b|\b(?:reduction|decrease) in (?:warranty|operating|service|production|maintenance) costs?\b/.test(text);
}
export function instructionEcho(text:string,sources:string[]):boolean {
  const tokens=words(text).split(" ");
  if (tokens.length<7) return false;
  const source=sources.map(words).join(" | ");
  for (let i=0;i+7<=tokens.length;i++) if (source.includes(tokens.slice(i,i+7).join(" "))) return true;
  return false;
}
export function knownScorer(pack:Pick<ScenarioContract,"id"|"scorer">|null|undefined):boolean {
  return (pack?.id==="earnings" && pack.scorer==="earnings-record-v1") ||
    (pack?.id==="manufacturing" && pack.scorer==="incoming-inspection-v1");
}
export interface Proposal {metric:string;criterion:string}
export function proposals(metrics:string[],criteria:string[]):Proposal[] {
  return Array.from({length:Math.max(metrics.length,criteria.length)},(_,i)=>({metric:metrics[i]||"",criterion:criteria[i]||""}));
}
interface PriorMeasures {metrics:string[];criteria:string[];pairs:Proposal[]|undefined}
export function pairSelection(metrics:string[],criteria:string[],prior:PriorMeasures|null):Proposal[] {
  if (!metrics.length) return [];
  const emptyCriteria=metrics.map(metric=>({metric,criterion:""}));
  if (!criteria.length) return emptyCriteria;
  const guidance="Pair one success criterion with each selected metric. Keep existing pairs together, change one pair at a time, or clear the criteria to request new checks.";
  const pairs=new Map(prior?.pairs?.map(row=>[row.metric,row.criterion]));
  if (prior && JSON.stringify(criteria)===JSON.stringify(prior.criteria)) {
    if (!prior.pairs) throw Error(guidance);
    return metrics.map(metric=>({metric,criterion:pairs.get(metric)??""}));
  }
  if (metrics.length!==criteria.length) throw Error(guidance);
  if (!prior || JSON.stringify(metrics)===JSON.stringify(prior.metrics))
    return proposals(metrics,criteria);
  // Both lists changed. Match known pairs by identity before assigning any new wording.
  const unused=new Set(criteria);
  const result=emptyCriteria.map(row=>{
    const old=pairs.get(row.metric);
    if (old && unused.delete(old)) return {...row,criterion:old};
    return row;
  });
  const missing=result.filter(row=>!row.criterion);
  if (missing.length===1 && unused.size===1) {
    const remaining=[...unused][0];
    if (prior.pairs?.some(row=>row.criterion===remaining && row.metric!==missing[0].metric)) throw Error(guidance);
    missing[0].criterion=remaining;
  } else if (missing.length || unused.size) throw Error(guidance);
  return result;
}
function anchors(text:string) {
  const stop=new Set("about across against among answer assess available based business case cases check compare dataset correct correctly each evaluate evidence expected from goal input labeled match measure measures metric model objective output performance provide proposed rate records reference reported required response source supplied task that the their this under using value with".split(" "));
  return new Set(words(text).split(" ").filter(w=>w.length>2 && !stop.has(w)).map(w=>w.replace(/(?:ing|ed|s)$/,"")));
}
function external(text:string):MetricAudit {
  const metric=text.slice(0,1500);
  return {metric,criterion:"Verify "+metric+" against observed operational records.",status:"external",
    evidence:"Operational observations and a comparable baseline for the requested outcome.",
    method:"Compare the external observations over a defined period.",reason:"Candidate responses alone do not establish this business outcome."};
}
export function validateMetricAudit(result:Record<string,unknown>, objective:string, pack:ScenarioContract|null|undefined,
  coverage:EvidenceCoverage|undefined, requested:string, instructions:string[], selected:Proposal[]|null):MetricAudit[] {
  const checked=z.array(auditRow).min(1).max(8).safeParse(result.audit);
  if (!checked.success) throw Error("return audit entries with metric, criterion, status, evidence, method and reason");
  const objectiveAnchors=anchors(objective+" "+requested);
  const quantities=(text:string)=>text.replace(/\bper\s+100\b/gi,"per hundred").match(/[-+]?\d+(?:[.,]\d+)*/g) ?? [];
  const supplied=new Set(quantities([objective,requested,pack?.system??""].join(" ")));
  const supported=checked.data.filter(row=>{
    // An operator can set a count for one check without establishing that
    // count as a fact or target for any other check in this review.
    const exact=selected?.find(pair=>pair.metric===row.metric && pair.criterion===row.criterion);
    const allowed=exact ? new Set([...supplied,...quantities(exact.metric),...quantities(exact.criterion)]) : supplied;
    return [row.metric,row.criterion,row.evidence,row.method,row.reason].every(text=>quantities(text).every(value=>allowed.has(value)));
  });
  if (!supported.length && !selected?.length) throw Error("the metric auditor introduced an unsupported number or year; refer to the supplied reporting period and source value without inventing a date, figure or threshold");
  const rows=supported.map(row=>{
    if (instructionEcho(row.criterion,instructions) || /\[\s*(?:for|when|example)\b/i.test(row.criterion) || words(row.criterion).split(" ").every(term=>genericTerms.has(term)))
      throw Error("replace generic or copied instructions with a check of a specific candidate answer against a source");
    if (isExternalOutcomeMetric(row.metric) || isExternalOutcomeMetric(row.criterion) || row.status==="external") return {...row,status:"external" as const};
    // Reviewer checks may legitimately describe cross-case scoring. Candidate instructions cannot.
    const named=knownScorer(pack) && pack?.metrics.some(name=>words(name)===words(row.metric));
    const relevant=[...anchors(row.criterion+" "+row.metric)].some(word=>objectiveAnchors.has(word));
    if (/\b(?:assume|default threshold|industry.standard tolerance|standard margin)\b/i.test(row.criterion))
      throw Error("the metric auditor introduced an unverified decision threshold");
    if (row.status==="proposed" && !(named && relevant && coverage && coverage.referenceCases>0))
      return {...row,status:"needs-evidence" as const, reason:(row.reason.slice(0,500)+" "+(pack ? "This measure has no confirmed match to a labeled scenario score." : "Quick compare has no attached labeled dataset or scoring rule."))};
    return row;
  });
  if (!selected && isExternalOutcomeMetric(objective) && !/\b(?:extract|cite|classify|route|identify|compute|read|compare|verify|summari[sz]e|triage|flag|report whether)\b/i.test(objective)) return [external(objective)];
  const unique = new Set(rows.map(r=>r.metric.toLowerCase()));
  if (unique.size!==rows.length) throw Error("combine duplicate metrics");
  if (selected) {
    return selected.map(item=>{
      const match=rows.find(r=>(!item.metric||r.metric===item.metric) && (!item.criterion||r.criterion===item.criterion));
      if (match) return match;
      if (isExternalOutcomeMetric(item.metric) || isExternalOutcomeMetric(item.criterion)) return {...external(item.metric||item.criterion),criterion:item.criterion||item.metric};
      return {metric:item.metric,criterion:item.criterion||"Define a case-level test for this measure.",
        status:"needs-evidence",evidence:"A case-level reference or rubric aligned with the operator’s wording.",
        method:"Confirm the grading procedure for the edited measure.",reason:"The audit did not verify this exact selection."};
    });
  }
  for (const metric of requested.split(/\r?\n/).map(s=>s.trim()).filter(Boolean))
    if (isExternalOutcomeMetric(metric) && !rows.some(r=>r.metric===metric)) rows.push(external(metric));
  return rows.slice(0,16);
}

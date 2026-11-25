import {isRecord,jsonText,duplicateKey} from "./run-types.cjs";
import {inspectionHandoffObjectiveV1,starterInspectionV1} from "./domain-starters.cjs";
import {quickSchemaInstruction,decodeQuickOutputSchema} from "./quick-structure.cjs";
import type {GraderEvidence} from "./grader-types.cjs";

export const inspectionRuleKey="inspection-sample-decision";
export const inspectionRuleId="dash/"+inspectionRuleKey+"/v1";
export const isInspectionDecision=(g:{type:string;ruleKey?:string}|undefined)=>g?.type==="catalog" && g.ruleKey===inspectionRuleKey;
export const inspectionHelp='Supply an approved JSON disposition such as {"disposition":"review","required_action":"signed_recheck","recheck_complete":false}, or an inclusive-limits record with lower_mm, upper_mm and measured_mm as decimal strings and rule "inclusive_limits".';

interface Decision {sample?:string;route:"accept"|"review";action:boolean;completed?:boolean;basis:string}
function readJson(text:string):unknown {
  try {return duplicateKey(text)===null ? jsonText(text) : undefined;} catch {return undefined;}
}
function decimal(value:unknown):bigint|undefined {
  if(typeof value!=="string" || !/^-?\d{1,12}(?:\.\d{1,9})?$/.test(value))return undefined;
  const [integer,fraction=""]=value.replace(/^-/,"").split(".");
  return BigInt(integer+fraction.padEnd(9,"0"))*(value.startsWith("-")?-1n:1n);
}
function usesMillimetres(record:Record<string,unknown>):boolean {
  return [record.unit,record.units].every(unit=>unit===undefined || (typeof unit==="string" && /^(?:mm|millimet(?:er|re)s?)$/i.test(unit.trim())));
}
export function inspectionReference(raw:unknown):Decision|undefined {
  const v=typeof raw==="string"?readJson(raw):raw;
  if(!isRecord(v) || !usesMillimetres(v))return undefined;
  const route=v.disposition ?? v.routing;
  if(route!==undefined && route!=="accept" && route!=="review")return undefined;
  if(v.routing!==undefined && v.disposition!==undefined && v.routing!==v.disposition)return undefined;
  if(v.required_action!==undefined && v.required_action!=="signed_recheck")return undefined;
  if(v.recheck_complete!==undefined && typeof v.recheck_complete!=="boolean")return undefined;
  const sample=v.sample;
  if(sample!==undefined && (typeof sample!=="string" || !/^[A-Za-z0-9_-]{1,64}$/.test(sample)))return undefined;
  const action=v.required_action==="signed_recheck", completed=v.recheck_complete;
  if(v.rule!==undefined || ["lower_mm","upper_mm","measured_mm"].some(key=>Object.hasOwn(v,key))) {
    // A range on its own does not establish inclusivity, a guard band, or a receiving policy.
    if(v.rule!=="inclusive_limits")return undefined;
    const lo=decimal(v.lower_mm),hi=decimal(v.upper_mm),reading=decimal(v.measured_mm);
    if(lo===undefined || hi===undefined || reading===undefined || lo>hi)return undefined;
    const derived=lo<=reading && reading<=hi?"accept":"review";
    if(route!==undefined && route!==derived)return undefined;
    return {sample,route:derived,action:action && derived==="review",completed,
      basis:(typeof v.active==="string" && /^[A-Za-z0-9._-]{1,24}$/.test(v.active) ? "Active drawing "+v.active+". " : "")+"Reading "+v.measured_mm+" mm is "+(derived==="accept"?"within":"outside")+" the inclusive "+v.lower_mm+"–"+v.upper_mm+" mm limits."};
  }
  if(!route || (action && route!=="review"))return undefined;
  return {sample,route,action,completed,basis:"Approved case disposition: "+route+"."};
}

export function hasInspectionSource(input:unknown,objective?:string):boolean {
  const original=inspectionHandoffObjectiveV1;
  if(objective!==original || !Array.isArray(input) || input.length<1 || input.length>2)return false;
  if(input.length===2){
    const system:unknown=input[0];
    if(!isRecord(system) || system.role!=="system" || typeof system.content!=="string" || !system.content.startsWith(quickSchemaInstruction))return false;
    const raw=readJson(system.content.slice(quickSchemaInstruction.length));
    try{decodeQuickOutputSchema(raw);}catch{return false;}
  }
  const last:unknown=input.at(-1);
  if(!isRecord(last) || last.role!=="user" || typeof last.content!=="string")return false;
  let task:unknown=last.content;
  if(typeof task!=="string")return false;
  if(task.startsWith("{")){
    const decoded=readJson(task);
    if(!isRecord(decoded) || Object.keys(decoded).some(key=>key!=="task" && key!=="inputs"))return false;
    task=decoded.task;
    // Named inputs in DASH Quick must be exact extracts from the approved task.
    const bindings:Record<string,string>={lot:starterInspectionV1.lot,current_drawing:starterInspectionV1.active,previous_drawing:starterInspectionV1.previous,reading_value:starterInspectionV1.measured_mm};
    if(!isRecord(decoded.inputs) || Object.entries(decoded.inputs).some(([key,value])=>!Object.hasOwn(bindings,key) || bindings[key]!==value))return false;
  }
  if(typeof task!=="string")return false;
  if(task===original)return true;
  // Structured optimization may repeat the operator's task instruction after the record.
  if(!task.startsWith(original+"\n\n"))return false;
  const repeated=task.slice(original.length+2);
  return !!repeated && original.split("\n\n")[0].includes(repeated);
}
function publicDispatch(e:GraderEvidence):boolean {
  return !e.caseContext && e.inputSource==="recorded-dispatch" && hasInspectionSource(e.input,e.evaluationBrief?.objective);
}
export function inspectionFacts(e:GraderEvidence):Decision|undefined {
  if(publicDispatch(e)){
    return inspectionSourceConflict(e.reference) ? undefined : inspectionReference(starterInspectionV1);
  }
  const context=e.caseContext;
  const saved=context && inspectionCaseReference({type:"catalog",ruleKey:inspectionRuleKey},context.row,context.pack);
  return inspectionReference(saved) ?? inspectionReference(e.reference);
}
function cleaned(value:unknown):string|undefined {
  return typeof value==="string" ? value.trim().toLowerCase().replace(/[.!]$/,"").replace(/\s+/g," ") : undefined;
}
function disposition(value:unknown):Decision["route"]|undefined {
  const v=cleaned(value);
  if(!v)return undefined;
  if(/^(?:accept(?:ed)?|pass(?:ed)?|within[_ -]limits)$/.test(v))return "accept";
  if(/^(?:review|hold|quality review|out(?:side| of)[_ -]limits?)$/.test(v))return "review";
  if(/^(?:(?:reject|hold)(?: for out-of-limit)?; )?(?:send|refer|route) to quality for (?:a )?signed recheck$/.test(v))return "review";
  return undefined;
}
function recheck(value:unknown,sample?:string):boolean|undefined {
  const v=cleaned(value);
  if(!v || /^(?:none|n\/a|no (?:further )?action(?: required)?|accept|release)$/.test(v))return false;
  if(/^signed[_ ]recheck$/.test(v))return true;
  const handoff=/^(?:send|refer|route)(?: (?:the )?sample(?: ([a-z_-]*[0-9][a-z0-9_-]*))?)? to quality for (?:a )?signed recheck$/.exec(v);
  if(handoff)return handoff[1]===undefined ? true : sample===undefined ? undefined : handoff[1]===sample.toLowerCase();
  return undefined;
}
function checkDecision(e:GraderEvidence):{value:number|null;reason:string} {
  const facts=inspectionFacts(e);
  if(!facts)return {value:null,reason:inspectionHelp};
  const answer=readJson(e.output);
  if(!isRecord(answer))return {value:null,reason:"The disposition rule needs an unambiguous JSON answer. Use a reviewed rubric for a prose answer."};
  const route=disposition(answer.disposition ?? answer.routing);
  const action=recheck(answer.next_action,facts.sample);
  const completion=answer.shift_note_completes_disposition;
  const measurement=(value:unknown)=>(typeof value==="string" || typeof value==="number") && /^-?\d{1,12}(?:\.\d{1,9})?$/.test(String(value)) ? String(value) : null;
  const reading=measurement(answer.reading),limit=measurement(answer.limit_range);
  const expected=" Expected "+facts.route+(facts.action?" with a signed recheck by Quality":"")+
    (facts.completed===undefined ? "." : facts.completed ? "; the recheck is recorded complete." : "; no completed recheck is recorded.");
  const observed=" Answer disposition: "+(route ?? "unrecognized")+
    (facts.action ? "; next action: "+(action===true?"signed recheck by Quality":action===false?"none, missing or for another sample":"unrecognized"):"")+
    (facts.completed===undefined ? "" : "; completion: "+(typeof completion==="boolean"?String(completion):"unspecified"))+"."+
    (reading!==null?" Answer reading: "+reading+".":"")+(limit!==null?" Answer supplied one limit value: "+limit+".":"");
  const reason=(message:string)=>facts.basis+expected+observed+" "+message;
  if(!route || (answer.disposition!==undefined && answer.routing!==undefined && disposition(answer.routing)!==route))
    return {value:null,reason:reason("The answer has no unambiguous supported disposition. Review its wording.")};
  if(route!==facts.route)return {value:0,reason:reason("The sample decision is incorrect.")};
  if(facts.action){
    const found=action;
    if(found===undefined)return {value:null,reason:reason("The action wording needs review to establish whether it calls for the required signed recheck.")};
    if(!found)return {value:0,reason:reason("The answer did not request the required signed recheck for this sample.")};
  }
  if(facts.completed!==undefined && answer.shift_note_completes_disposition!==facts.completed)
    return {value:0,reason:reason("The answer did not report the supported completion status of the recheck.")};
  return {value:1,reason:reason("The required decision and handoff checks passed.")};
}

export const inspectionRangeKey="inspection-active-range";
export const inspectionRangeId="dash/"+inspectionRangeKey+"/v1";
type Check={type:string;ruleKey?:string};
export const isInspectionCheck=(g:Check|undefined)=>isInspectionDecision(g) || (g?.type==="catalog" && g.ruleKey===inspectionRangeKey);
const rangeHelp='Supply the approved active revision and its lower_mm, upper_mm and measured_mm as decimal strings, for example {"active":"C","lower_mm":"1.0","upper_mm":"1.2","measured_mm":"1.1"}.';
export const inspectionEvidenceHelp=(g:Check)=>g.ruleKey===inspectionRangeKey?rangeHelp:inspectionHelp;
interface InspectionRange {active:string;lower:string;upper:string;reading:string}
export function inspectionRangeReference(raw:unknown):InspectionRange|undefined {
  const v=typeof raw==="string"?readJson(raw):raw;
  if(!isRecord(v) || !usesMillimetres(v))return undefined;
  const active=v.active ?? v.revision;
  if(typeof active!=="string" || !/^[A-Za-z0-9_-]{1,24}$/.test(active) || (v.active!==undefined && v.revision!==undefined && v.active!==v.revision))return undefined;
  const {lower_mm:lower,upper_mm:upper,measured_mm:reading}=v;
  if(typeof lower!=="string" || typeof upper!=="string" || typeof reading!=="string")return undefined;
  const lo=decimal(lower),hi=decimal(upper);
  if(lo===undefined || hi===undefined || hi<lo || decimal(reading)===undefined)return undefined;
  return {active,lower,upper,reading};
}
export function hasInspectionReferenceFor(g:Check,raw:unknown):boolean {
  return g.ruleKey===inspectionRangeKey ? !!inspectionRangeReference(raw) : !!inspectionReference(raw);
}
export function inspectionCaseReference(g:Check,row:{gold?:Record<string,unknown>;reference?:unknown},pack?:{id:string;scorer:string}|null):unknown{
  if(pack?.id==="manufacturing" && pack.scorer==="incoming-inspection-v1")
    return g.ruleKey===inspectionRangeKey ? row.gold : {disposition:row.gold?.routing};
  return row.reference ?? row.gold;
}
// A mixed-grade Quick can also carry a private reference for other criteria. When
// that reference asserts inspection facts, contradictory claims invalidate the public source.
export function inspectionSourceConflict(raw:unknown):boolean {
  const v=typeof raw==="string"?readJson(raw):raw;
  // A malformed object may carry a conflicting answer key. Prose for unrelated rubrics is allowed.
  if(!isRecord(v))return typeof raw==="string" && raw.trimStart().startsWith("{");
  const source=starterInspectionV1;
  if(!usesMillimetres(v))return true;
  for(const key of ["lower_mm","upper_mm","measured_mm"] as const){
    if(Object.hasOwn(v,key) && decimal(v[key])!==decimal(source[key]))return true;
  }
  for(const key of ["active","sample","lot","previous","rule","required_action","recheck_complete"] as const){
    if(Object.hasOwn(v,key) && v[key]!==source[key])return true;
  }
  if(Object.hasOwn(v,"revision") && v.revision!==source.active)return true;
  const decision=inspectionReference(source);
  return [v.disposition,v.routing].some(value=>value!==undefined && value!==decision?.route);
}
function rangeFor(e:GraderEvidence){
  if(publicDispatch(e))return inspectionSourceConflict(e.reference) ? undefined : inspectionRangeReference(starterInspectionV1);
  const source=e.caseContext;
  return (source && inspectionRangeReference(inspectionCaseReference({type:"catalog",ruleKey:inspectionRangeKey},source.row,source.pack))) ?? inspectionRangeReference(e.reference);
}
export function canScoreInspection(g:Check,e:GraderEvidence):boolean {
  return g.ruleKey===inspectionRangeKey ? !!rangeFor(e) : !!inspectionFacts(e);
}

const intervalRoots=new Set(["limitrange","drawingrange","activedrawingrange","permittedrange","allowablerange","tolerancerange","drawinglimits"]);
// Recognize the schema designer's paired fields only when their root denotes inspection limits.
function inspectionIntervalFields(record:Record<string,unknown>):[string,string][] {
  const roots=new Set<string>();
  for(const key of Object.keys(record)){
    const part=/^([A-Za-z][\w]*)_(lower|upper)$/.exec(key);
    if(part && intervalRoots.has(part[1].toLowerCase().replace(/_/g,"")))roots.add(part[1]);
  }
  return [...roots].map(root=>[root+"_lower",root+"_upper"]);
}

// Only the explicitly active revision and its associated range count. Numbers in an obsolete
// revision, in the input, or in a judge's explanation are never candidate citations.
function checkRange(e:GraderEvidence):{value:number|null;reason:string} {
  const expected=rangeFor(e);
  if(!expected)return {value:null,reason:rangeHelp};
  const header="Active drawing "+expected.active+" requires both "+expected.lower+" and "+expected.upper+" mm; the recorded reading is "+expected.reading+" mm. ";
  const answer=readJson(e.output);
  if(!isRecord(answer))return {value:null,reason:header+"Use a reviewed rubric for an unstructured answer."};
  const label=answer.applicable_drawing ?? answer.revision;
  const rawLabel=typeof label==="string"?label.trim():"";
  const retired=/\s*\((?:superseded|obsolete|retired|previous)\s+drawing\s+([A-Za-z0-9_-]{1,24})\s+(?:was|permitted|allowed)\s+-?\d+(?:\.\d+)?\s*(?:–|—|to)\s*-?\d+(?:\.\d+)?\s*mm\)$/i.exec(rawLabel);
  const clause=retired && retired[1]!==expected.active ? rawLabel.slice(0,retired.index).trim() : rawLabel;
  const drawing=/^(?:(?:active\s+)?drawing\s+)?([A-Za-z0-9_-]{1,24})(?=$|\s)/i.exec(clause);
  const stated=typeof answer.limit_range==="string"?answer.limit_range.trim():"";
  const range=/^(-?\d+(?:\.\d+)?)\s*(?:–|—|to|\s-\s)\s*(-?\d+(?:\.\d+)?)\s*mm(?:\s+inclusive)?\.?$/i;
  const inClause=drawing ? range.exec(clause.slice(drawing[0].length).trim().replace(/^(?:permits|allows|specifies)\s+/i,"")) : null;
  const inField=range.exec(stated);
  const candidateDecimal=(x:unknown)=>decimal(typeof x==="number" && Number.isFinite(x) ? String(x) : typeof x==="string" ? x.replace(/\s*mm$/i,"").trim() : undefined);
  const supports=(first:unknown,second:unknown)=>candidateDecimal(first)===decimal(expected.lower) && candidateDecimal(second)===decimal(expected.upper);
  const ranges: [unknown,unknown][]=[];
  for(const [lower,upper] of inspectionIntervalFields(answer))ranges.push([answer[lower],answer[upper]]);
  if(inClause)ranges.push([inClause[1],inClause[2]]);
  if(inField)ranges.push([inField[1],inField[2]]);
  if(Object.hasOwn(answer,"lower_mm") || Object.hasOwn(answer,"upper_mm"))ranges.push([answer.lower_mm,answer.upper_mm]);
  const reading=answer.measured_mm ?? answer.reading;
  const activeMatches=drawing?.[1]===expected.active && (drawing[0]===clause || !!inClause) && (answer.revision===undefined || answer.revision===expected.active);
  const scalar=candidateDecimal(answer.limit_range);
  const supportedRangeField=answer.limit_range===undefined || (scalar!==undefined || !!inField);
  const rangeMatches=usesMillimetres(answer) && supportedRangeField && (scalar===undefined || scalar===decimal(expected.lower) || scalar===decimal(expected.upper)) &&
    ranges.length>0 && ranges.every(([lo,hi])=>supports(lo,hi));
  const readingMatches=usesMillimetres(answer) && candidateDecimal(reading)===decimal(expected.reading) && (answer.reading===undefined || candidateDecimal(answer.reading)===decimal(expected.reading));
  return {value:Number(activeMatches && rangeMatches && readingMatches),reason:header+
    "Answer revision: "+(drawing?.[1] ?? "missing")+"; both active bounds: "+(rangeMatches?"matched":ranges.length?"differed or incomplete":"not supplied together")+
    "; recorded reading: "+(readingMatches?"matched":"missing or different")+"."+
    (scalar!==undefined ? " Answer’s single limit field: "+String(answer.limit_range)+"." : "")};
}

// The public example can explain its known values in a shareable receipt. A private
// answer key is local grading evidence and must never be copied into a report or export.
function shareableScore(e:GraderEvidence,score:{value:number|null;reason:string},key:string){
  const privateFacts=hasInspectionReferenceFor({type:"catalog",ruleKey:key},e.reference);
  if(publicDispatch(e) && !privateFacts)return score;
  const name=key===inspectionRuleKey?"Inspection sample decision":"Active drawing range and reading";
  const outcome=score.value===null ? "The available evidence did not establish a score." :
    score.value===1 ? "The candidate satisfied the approved case check." : "The candidate did not satisfy the approved case check.";
  return {value:score.value,reason:name+". "+outcome};
}
export function scoreInspectionDecision(e:GraderEvidence){return shareableScore(e,checkDecision(e),inspectionRuleKey);}
export function scoreInspectionRange(e:GraderEvidence){return shareableScore(e,checkRange(e),inspectionRangeKey);}

export function inspectionSchemaIssue(g:Check, schema:import("./quick-structure.cjs").QuickOutputSchema|undefined, raw:unknown):string|undefined {
  if(!schema)return "Select structured JSON output before using this inspection check.";
  const fields=schema.properties;
  const admits=(name:string,...acceptable:string[])=>{
    const type=fields[name]?.type;
    return !!type && acceptable.includes(Array.isArray(type)?type[0]:type);
  };
  const required=new Set(schema.required);
  if(g.ruleKey===inspectionRangeKey){
    const expected=inspectionRangeReference(raw);
    // Use the same decimal representation as the scorer. A number that rounds or
    // serializes in exponential notation cannot replace an exact decimal-string citation.
    const quantity=(field:string,value?:string)=>{
      if(admits(field,"string"))return true;
      if(!admits(field,"number","integer"))return false;
      if(value===undefined)return true;
      const n=Number(value);
      return decimal(String(n))===decimal(value) && (admits(field,"number") || Number.isInteger(n));
    };
    const pairs=inspectionIntervalFields(fields);
    if(fields.lower_mm || fields.upper_mm)pairs.push(["lower_mm","upper_mm"]);
    const usablePair=([lo,hi]:[string,string])=>quantity(lo,expected?.lower) && quantity(hi,expected?.upper);
    for(const pair of pairs){
      if(pair.some(f=>required.has(f)) && !usablePair(pair))
        return "The active-range grader needs both "+pair.join(" and ")+" to represent their respective drawing limits. Use number or decimal text fields.";
    }
    for(const key of ["applicable_drawing","revision","unit","units"]){
      if(required.has(key) && !admits(key,"string"))return "The active-range grader needs a text field for "+key+".";
    }
    for(const key of ["reading","measured_mm"]){
      if(required.has(key) && !quantity(key,expected?.reading))return "The "+key+" field cannot represent the recorded reading. Use a number or decimal text field.";
    }
    if(required.has("limit_range") && !quantity("limit_range",expected?.lower) && !quantity("limit_range",expected?.upper))
      return "The limit_range field cannot represent either active drawing bound. Use number or decimal text fields for the bounds.";
    if(!(admits("applicable_drawing","string") || admits("revision","string")) ||
      !(quantity("reading",expected?.reading) || quantity("measured_mm",expected?.reading)) ||
      !(admits("applicable_drawing","string") || admits("limit_range","string") || pairs.some(usablePair)))
      return "The active-range grader needs JSON fields for the revision, both limits and the reading. Review the candidate output schema.";
    return;
  }
  if(!(admits("disposition","string") || admits("routing","string")) ||
      ["disposition","routing"].some(key=>required.has(key) && !admits(key,"string")))
    return "The inspection decision grader needs a JSON disposition or routing field with a text value.";
  const facts=inspectionReference(raw);
  if(facts?.action && !admits("next_action","string"))return "The signed recheck requires a next_action text field in the output schema.";
  if(facts?.completed!==undefined && !admits("shift_note_completes_disposition","boolean"))return "The verification of completion needs a shift_note_completes_disposition boolean in the output schema.";
  return undefined;
}

export function suggestedInspectionGrader(metric:string,criterion:string|null):string|undefined {
  if(!criterion)return;
  // Match the decision being requested as well as its approved test. A citation and a
  // handoff are independently scorable. This lookup is used only for the verified starter.
  const label=metric.trim().toLowerCase(),test=criterion.toLowerCase();
  const mentions=(text:string,words:RegExp[])=>words.every(word=>word.test(text));
  const range=[/\b(?:drawing|revision|limits?|range)\b/,/\b(?:readings?|measurements?)\b/];
  if(mentions(label,range) && mentions(test,[...range,/\b(?:range|both (?:limits|bounds)|lower and upper)\b/]))
    return inspectionRangeId;
  const handoff=[/\b(?:next (?:action|step)|disposition|recheck)\b/,/\b(?:completion|completed|establishes|signed|shift note)\b/];
  if(mentions(label,handoff) && mentions(test,[/\b(?:recheck|quality)\b/,/\b(?:out.of.limit|disposition|receiving rule)\b/,/\b(?:complet\w*|signed|signoff)\b/]))
    return inspectionRuleId;
  return undefined;
}

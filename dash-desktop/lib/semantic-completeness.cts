import {z} from "opik";
import {decisionConfig,evaluateDecision,observationSchema,type DecisionConfig} from "./decision-model.cjs";
import {isRecord,ProviderFailure,type ChatTurn} from "./runtime-types.cjs";
import type {GraderEvidence} from "./grader-types.cjs";

export const completenessId="dash/semantic-completeness/v1";
export const completenessPreset={
  id:completenessId,name:"Requested items present",category:"Deliverable coverage",industry:"General",
  criteria:"Ask local D1 whether the candidate supplies each explicitly requested deliverable. A heading or promise is insufficient. This check measures presence only. Verify factual accuracy with a separate grader.",
} as const;
export function isCompleteness(g:{type:string;presetId?:string}) {return g.type==="decision" && g.presetId===completenessId;}
export const checklistHelp="Deliverable coverage needs 1–8 explicit deliverables, each up to 200 characters. Add “Required deliverables:” followed by one bullet per item to the candidate task or supply input.required_deliverables in a versioned case.";
const maxItems=8;
const itemText=z.string().trim().min(1).max(200).refine(s=>!/[\u0000-\u001f\u007f]/u.test(s));
const itemsSchema=z.array(itemText).min(1).max(maxItems).refine(xs=>new Set(xs).size===xs.length);
export const checklistSchema=z.object({source:z.string().min(1).max(160),items:itemsSchema});
export type CompletenessChecklist=z.infer<typeof checklistSchema>;
const itemReceipt=z.object({requirement:itemText,value:z.union([z.literal(0),z.literal(1)]).nullable(),pass:z.boolean().nullable(),
  reason:z.string().max(800),decision:observationSchema.optional()});
const usageCount=z.number().safe().int().nonnegative().nullable();
export const completenessReceipt=z.object({presetId:z.literal(completenessId),source:checklistSchema.shape.source,
  items:z.array(itemReceipt).min(1).max(maxItems),usage:z.object({inputTokens:usageCount,outputTokens:usageCount,totalTokens:usageCount}),
});
export type CompletenessReceipt=z.infer<typeof completenessReceipt>;
export const activation=z.object({presetId:z.literal(completenessId),decision:decisionConfig,threshold:z.literal(0.8)}).strict()
  .refine(v=>v.decision.provider==="local" && !v.decision.fallbackModel && v.decision.failAt===0.2 &&
    /(?:^|[-_.])d1(?:$|[-_.])/i.test(v.decision.model.split("/").at(-1) ?? ""),
    "Choose a discovered local D1 decision model with fail cutoff 0.2 and pass cutoff 0.8. The preset pins one model.");

interface ChecklistInput {
  approved?:{prompt?:string;outputSchema?:unknown;input?:{task:string}}|null;
  row?:{prompt?:string;messages?:readonly {role:string;content:string}[];input?:unknown}|null;
  pack?:{kind?:string;outputSchema?:unknown}|null;
  input?:unknown;
}
// Only a marked block defines obligations in free text. Do not infer targets from gold, metrics or the answer.
function textItems(text:unknown):unknown[][] {
  if(typeof text!=="string")return [];
  const lines=text.split(/\r?\n/);
  const lists:unknown[][]=[];
  for(let i=0;i<lines.length;i++){
    if(!/^\s*(?:required deliverables|deliverables)\s*:\s*$/i.test(lines[i]))continue;
    const items:string[]=[];
    while(i+1<lines.length){
      const line=lines[i+1];
      if(!line.trim()){i++;continue;}
      const bullet=/^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/.exec(line);
      if(bullet){items.push(bullet[1]);i++;continue;}
      if(items.length && /^\s+\S/.test(line)){items[items.length-1]+=" "+line.trim();i++;continue;}
      break;
    }
    lists.push(items);
  }
  return lists;
}
// Only the persistent system instruction and final user request define this answer's deliverables.
function activeTurns(input:unknown):ChatTurn[]|undefined {
  if(!Array.isArray(input) || !input.length)return undefined;
  const first:unknown=input[0],last:unknown=input.at(-1);
  if(!isRecord(last) || last.role!=="user" || typeof last.content!=="string")return undefined;
  const user:ChatTurn={role:"user",content:last.content};
  return isRecord(first) && first.role==="system" && typeof first.content==="string"
    ? [{role:"system",content:first.content},user] : [user];
}
export function completenessChecklist({approved,row,pack,input}:ChecklistInput):CompletenessChecklist|null {
  const lists:{source:string;values:unknown}[]=[];
  const fromTask=(task:unknown,source="candidate task")=>{for(const values of textItems(task))lists.push({source,values});};
  const fromTurns=(messages:unknown)=>{for(const turn of activeTurns(messages) ?? [])fromTask(turn.content,turn.role==="system" ? "system instruction" : "candidate task");};
  if(approved && (!row || (pack && pack.kind!=="reference")))
    fromTask(!row && approved.input && approved.outputSchema ? approved.input.task : approved.prompt);
  if(row?.messages)fromTurns(row.messages);
  else if(row){
    fromTask(row.prompt);
    if(isRecord(row.input) && Object.hasOwn(row.input,"required_deliverables"))
      lists.push({source:"case input",values:row.input.required_deliverables});
    else if(typeof row.input==="string")fromTask(row.input);
  }
  if(!approved && !row){
    if(Array.isArray(input))fromTurns(input);
    else if(isRecord(input) && Object.hasOwn(input,"required_deliverables"))lists.push({source:"case input",values:input.required_deliverables});
    else fromTask(input);
  }
  if(!lists.length)return null;
  const items=new Set<string>(), sources=new Set<string>();
  for(const {source,values} of lists){
    const checked=itemsSchema.safeParse(values);
    if(!checked.success)return null;
    sources.add(source);
    for(const item of checked.data)items.add(item);
  }
  const checked=checklistSchema.safeParse({source:[...sources].join(" + "),items:[...items]});
  return checked.success ? checked.data : null;
}

function totalUsage(items:CompletenessReceipt["items"]) {
  const completed=items.flatMap(x=>x.decision ? [x.decision] : []);
  function sum(key:"inputTokens"|"outputTokens"|"totalTokens"){
    if(!completed.length || completed.length!==items.length)return null;
    let total=0;
    for(const d of completed){
      const usage=d.usage;
      const n=usage?.[key] ?? (key==="totalTokens" && usage?.inputTokens!==undefined && usage.outputTokens!==undefined ? usage.inputTokens+usage.outputTokens : undefined);
      if(n===undefined || !Number.isSafeInteger(total+n))return null;
      total+=n;
    }
    return total;
  }
  return {inputTokens:sum("inputTokens"),outputTokens:sum("outputTokens"),totalTokens:sum("totalTokens")};
}
// Recompute from actual native receipts, including on replay. Never synthesize P(all requested items).
export function coverageValue(receipt:CompletenessReceipt,config:DecisionConfig,passAt:number):0|1|null|undefined {
  if(!receipt.items.length || config.provider!=="local" || config.fallbackModel || new Set(receipt.items.map(x=>x.requirement)).size!==receipt.items.length)return undefined;
  const usage=totalUsage(receipt.items);
  if(usage.totalTokens!==receipt.usage.totalTokens || usage.inputTokens!==receipt.usage.inputTokens || usage.outputTokens!==receipt.usage.outputTokens)return undefined;
  const results:(boolean|null)[]=[];
  for(const item of receipt.items){
    const d=item.decision;
    if(!d){
      if(item.pass!==null || item.value!==null)return undefined;
      continue;
    }
    if(d.provider!=="local" || d.actualModel!==config.model || d.requestedModel!==config.model ||
        (d.protocol ?? "systemone")!==(config.protocol ?? "systemone") || d.identityVerification!=="exact" ||
        d.dispatchedModel || d.fallbackReason || d.failAt!==config.failAt || d.passAt!==passAt)return undefined;
    const passed=d.probabilityYes>=passAt ? true : d.probabilityYes<=config.failAt ? false : null;
    if(item.pass!==passed || item.value!==(passed===null ? null : Number(passed)))return undefined;
    results.push(passed);
  }
  if(results.length!==receipt.items.length)return null;
  return results.includes(false) ? 0 : results.includes(null) ? null : 1;
}
export async function assessCompleteness(config:DecisionConfig,passAt:number,e:GraderEvidence,signal:AbortSignal) {
  const checklist=e.completenessChecklist===undefined ? completenessChecklist({input:e.input}) : e.completenessChecklist;
  if(!checklist || !checklistSchema.safeParse(checklist).success)return {value:null,pass:null,reason:checklistHelp};
  if(!e.output.trim())return {value:null,pass:null,reason:"The candidate answer is empty. Deliverable coverage is unscored."};
  const taskAndAnswer={input:activeTurns(e.input) ?? e.input,output:e.output,reference:undefined};
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(90000)]);
  const items:CompletenessReceipt["items"]=[];
  let failure:string|undefined;
  for(const requirement of checklist.items){
    if(!failure){
      try {
        const result=await evaluateDecision(config,passAt,{kind:"requested-item",item:requirement},taskAndAnswer,deadline);
        items.push({requirement,pass:result.pass,value:result.pass===null ? null : result.pass ? 1 : 0,reason:result.reason,decision:result.decision});
        continue;
      } catch(error) {
        failure=deadline.aborted ? deadline.reason?.name==="TimeoutError" ? "Deliverable grading timed out." : "Deliverable grading canceled." :
          error instanceof ProviderFailure ? error.message.slice(0,700) : "The local decision server did not produce a verified receipt.";
        items.push({requirement,value:null,pass:null,reason:failure});
        continue;
      }
    }
    items.push({requirement,value:null,pass:null,reason:"This deliverable was not submitted."});
  }
  const completeness:CompletenessReceipt={presetId:completenessId,source:checklist.source,items,usage:totalUsage(items)};
  const value=coverageValue(completeness,config,passAt) ?? null;
  const reason=failure ?? (value===1 ? "The answer supplies every listed deliverable." :
    value===0 ? "The answer is missing at least one listed deliverable." : "One or more deliverables need review.");
  return {value,pass:value===null ? null : value===1,reason,completeness};
}

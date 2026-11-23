import {z} from "opik";
import {PlanningRoute,type PlannerAdapters} from "./planner-routing.cjs";
import {isRecord,type RuntimeInventory} from "./runtime-types.cjs";
import {loadAgent,agentPin} from "../agents/registry.cjs";
import type {DatabaseSync} from "node:sqlite";
import type {GraderDefinition} from "./grader-types.cjs";
import type {Graders} from "./graders.cjs";
import type {ApprovedPrompt} from "./outcome-workflow.cjs";
import type {DatasetSnapshot,ScenarioPack} from "./run-types.cjs";
import type {PlannerSettings} from "./planner-settings.cjs";
interface DesignerBench {
  active:unknown;designing:boolean;readonly adapters:PlannerAdapters;readonly db:DatabaseSync;readonly graders:Graders;
  workflow:{get(id:string):ApprovedPrompt};dataset(id:string):DatasetSnapshot;pack(id:string):{pack:ScenarioPack};
  plannerSettings:Pick<PlannerSettings,"fallback">;servers:RuntimeInventory[];
}
const designRequest=z.object({promptId:z.string().optional(),datasetId:z.string().optional(),objective:z.string().optional(),
  metrics:z.string().optional(),industry:z.string().optional(),target:z.enum(["response","agent"]).optional()});
const methodSchema=z.enum(["contains","exact","judge","field","trajectory"]);
type Method=z.infer<typeof methodSchema>;
const checkSchema=z.object({name:z.string(),method:methodSchema,metric:z.string(),criteria:z.string(),reason:z.string(),threshold:z.number().gt(0).lte(1)});


function bounded(value:unknown, limit:number, label:string):string {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw Error("Enter " + label + " (up to " + limit + " characters).");
  return value.trim();
}

function gradingBrief(bench:DesignerBench, request:z.infer<typeof designRequest>) {
  const approved = request.promptId ? bench.workflow.get(request.promptId) : null;
  const datasetId = approved?.datasetId || request.datasetId;
  const dataset = datasetId ? bench.dataset(datasetId) : null;
  const pack = dataset ? bench.pack(dataset.pack).pack : null;
  const objective = bounded(approved?.objective ?? request.objective, 12000, "a task objective");
  const metrics = approved?.metrics || bounded(request.metrics, 3000, "the success metrics").split("\n").map(x=>x.trim()).filter(Boolean);
  const industry = bounded(approved?.domain || dataset?.metadata.industry || request.industry || "Cross-industry",100,"an industry");
  const target = approved || dataset ? "response" : request.target === "agent" ? "agent" : "response";
  const references = dataset?.rows.map(r=>r.reference ?? r.gold) || [];
  const referenceFields = Object.keys(references[0] && typeof references[0]==="object" && !Array.isArray(references[0]) ? references[0] : {})
    .filter(k=>references.every(item=>isRecord(item) && Object.hasOwn(item,k)));
  return { objective, metrics, industry, target, criteria:approved?.requirements || [], referenceFields,
    outputFields:Object.keys(pack?.outputSchema?.properties || {}), existingScorer:pack?.kind==="reference"?null:pack?.scorer };
}

// A literal metric scores the same string on every case. Conditional instructions need a judge
// or a labeled reference so a response taking another valid branch can earn full credit.
function literalRules(brief:ReturnType<typeof gradingBrief>) {
  const rules:Record<"exact"|"contains",string[]> = {exact:[], contains:[]};
  for (const instruction of [brief.objective, ...brief.criteria, ...brief.metrics]) {
    if (/\b(if|when|whenever|unless|otherwise|depending|except|only for)\b/i.test(instruction)) continue;
    const clauses = instruction.split(/[.\n;]/);
    for (const clause of clauses) {
      const match = /\b(?:(?:respond|reply|answer|output|return)\s+(?:only with|with exactly|exactly|only)|(?:must\s+)?(?:include|contain|say))\s+(?:(?:the\s+)?(?:exact\s+)?(?:word|phrase|literal|string)\s+)?(?:["“]([^"”]+)["”]|['‘]([^'’]+)['’]|([A-Z][A-Z0-9_-]+)\b)/i.exec(clause);
      if (!match) continue;
      const literal = match[1] || match[2] || match[3];
      if (match[3] && literal !== literal.toUpperCase()) continue;
      const method = /^(?:respond|reply|answer|output|return)\b/i.test(match[0]) ? "exact" : "contains";
      if (!rules[method].includes(literal)) rules[method].push(literal);
    }
  }
  return rules;
}

export async function designGraderPlan(bench:DesignerBench, request:unknown) {
  if (bench.active || bench.designing) throw Error("Wait for the current run or planning request to finish.");
  bench.designing = true;
  try {
    const brief = gradingBrief(bench, designRequest.parse(request));
    const literals = literalRules(brief);
    const methods:Method[] = (["exact","contains"] as const).filter(method=>literals[method].length>0);
    methods.push("judge");
    if (brief.referenceFields.length) methods.push("field");
    if (brief.target==="agent") methods.push("trajectory");
    const grade = {type:"object",additionalProperties:false,
      required:["name","metric","method","criteria","reason","threshold"],properties:{
        name:{type:"string"},metric:{type:"string",enum:brief.metrics},method:{type:"string",enum:methods},
        criteria:{type:"string"},reason:{type:"string"},threshold:{type:"number",minimum:0.001,maximum:1}
      }};
    const schema = {type:"object",additionalProperties:false,required:["summary","checks"],properties:{
      summary:{type:"string"},checks:{type:"array",maxItems:8,items:grade}
    }};
    const route = await PlanningRoute.start(bench.adapters,{openaiFallback:()=>bench.plannerSettings.fallback()},AbortSignal.timeout(150000),()=>{});
    const role=loadAgent("grader-designer");
    const prompt=role.instructions;
    const result = await route.ask("Grader designer",prompt,{...brief,allowedLiterals:literals},schema,1600,output=>{
      const summary = bounded(output.summary,1500,"a coverage explanation");
      if (!Array.isArray(output.checks) || output.checks.length>8) throw Error("Propose up to eight graders.");
      const names = new Set();
      const checks = output.checks.map((value:unknown):GraderDefinition & {reason:string}=>{
        const item=checkSchema.parse(value);
        const name = bounded(item.name,100,"a grader name"), method=item.method;
        if (names.has(name.toLowerCase()) || !methods.includes(method)) throw Error("Choose distinct names and compatible methods.");
        names.add(name.toLowerCase());
        if (!brief.metrics.includes(item.metric)) throw Error("Choose one of the approved success measures.");
        let criteria=bounded(item.criteria,6000,"grading criteria");
        if (method==="exact" || method==="contains") {
          const allowed=literals[method];
          if (allowed.length===1) criteria=allowed[0];
          else if (!allowed.includes(criteria)) throw Error("Choose the literal specified in the objective.");
        }
        if (!Number.isFinite(item.threshold) || item.threshold<=0 || item.threshold>1) throw Error("Choose a pass threshold between zero and one.");
        if (method==="field") {
          const rule=z.object({outputField:z.string(),referenceField:z.string()}).parse(JSON.parse(criteria));
          if (!brief.referenceFields.includes(rule.referenceField) || (brief.outputFields.length && !brief.outputFields.includes(rule.outputField))) throw Error("Use a field present in the dataset schema and reference.");
        }
        return {name,category:item.metric.slice(0,100),industry:brief.industry,
          type:method==="judge" ? "opik" : method,criteria,threshold:item.threshold,
          reason:bounded(item.reason,1200,"a rationale")};
      });
      return {summary,checks};
    });
    return {...result,designer:route.designer,agent:agentPin(role),industry:brief.industry};
  } finally { bench.designing=false; }
}

export function confirmGraderPlan(bench:DesignerBench, definitions:unknown) {
  if (!Array.isArray(definitions) || !definitions.length || definitions.length>8) throw Error("Choose one to eight graders.");
  const models=bench.servers.flatMap(s=>s.models).filter(m=>["lmstudio","ollama"].includes(m.provider));
  const db=bench.db;
  db.exec("BEGIN IMMEDIATE");
  try {
    const ids=definitions.map(def=>bench.graders.save(def,models));
    if (new Set(ids).size!==ids.length) throw Error("Remove duplicate graders before confirming.");
    db.exec("COMMIT");
    return ids;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}


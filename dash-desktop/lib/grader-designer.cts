import {z} from "opik";
import {PlanningRoute,type PlannerAdapters} from "./planner-routing.cjs";
import {isRecord,type RuntimeInventory} from "./runtime-types.cjs";
import {loadAgent,agentPin,isDomain} from "../agents/registry.cjs";
import type {DatabaseSync} from "node:sqlite";
import type {GraderSpec} from "./grader-types.cjs";
import {randomUUID,createHash} from "node:crypto";
import {getOpikTemplate} from "./opik-library.cjs";
import type {Graders} from "./graders.cjs";
import type {ApprovedPrompt} from "./outcome-workflow.cjs";
import type {DatasetSnapshot,ScenarioPack} from "./run-types.cjs";
import type {PlannerSettings} from "./planner-settings.cjs";
interface CatalogOptions {automatic:GraderSpec[];available:GraderSpec[]}
interface DesignerBench {
  active:unknown;designing:boolean;readonly adapters:PlannerAdapters;readonly db:DatabaseSync;readonly graders:Graders;
  workflow:{get(id:string):ApprovedPrompt};dataset(id:string):DatasetSnapshot;pack(id:string):{pack:ScenarioPack};
  quickGraderOptions(id:string):CatalogOptions;datasetGraderOptions(id:string):CatalogOptions;
  plannerSettings:Pick<PlannerSettings,"fallback">;servers:RuntimeInventory[];
}
const textId=z.string().trim().min(1).max(250);
const designRequest=z.strictObject({promptId:textId.optional(),datasetId:textId.optional(),domainId:textId.optional(),
  objective:z.string().max(12000).optional(),metrics:z.string().max(3000).optional(),industry:z.string().max(100).optional(),
  target:z.enum(["response","agent"]).optional()}).refine(r=>[r.promptId,r.datasetId,r.domainId].filter(Boolean).length<=1,"Choose a single prompt, dataset, or domain.");
const methodSchema=z.enum(["contains","exact","judge","field","trajectory"]);
type Method=z.infer<typeof methodSchema>;
const checkSchema=z.strictObject({name:z.string(),method:methodSchema,metric:z.string(),criteria:z.string(),
  reason:z.string(),threshold:z.number().gt(0).lte(1)});
const sourceSchema=z.object({id:textId,name:z.string(),version:z.number().int().positive(),scope:z.enum(["general","industry","customer"]),
  criteria:z.string(),hosted:z.boolean(),model:z.string().nullable()});
const proposedSchema=z.object({name:z.string(),category:z.string(),industry:z.string(),criteria:z.string(),threshold:z.number().gt(0).lte(1),
  type:z.enum(["contains","exact","field","trajectory","judge","opik","decision","catalog","opik-metric"]),reason:z.string(),
  action:z.enum(["reuse","derive","create"]),source:sourceSchema.nullable()});
type Proposed=z.infer<typeof proposedSchema>;
const draftSchema=z.object({request:designRequest,checks:z.array(proposedSchema).max(8)});
const reviewFields=z.strictObject({name:z.string().trim().min(1).max(100),category:z.string().trim().min(1).max(100),
  criteria:z.string().trim().min(1).max(6000),threshold:z.number().gt(0).lte(1),judgeId:textId.nullable().optional()});
const index=z.number().int().min(0).max(7);
const confirmationSchema=z.strictObject({draftId:z.string().uuid(),choices:z.array(z.discriminatedUnion("action",[
  z.strictObject({index,action:z.literal("reuse")}),
  z.strictObject({index,action:z.literal("create"),definition:reviewFields}),
  z.strictObject({index,action:z.literal("derive"),definition:reviewFields}),
])).min(1).max(8)});
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
  if (request.domainId && !isDomain(request.domainId)) throw Error("Choose a registered domain.");
  const domain = approved?.domain || dataset?.metadata.industry || request.domainId || "Cross-industry";
  const industry = bounded(domain,100,"an industry");
  const target = approved || dataset ? "response" : request.target === "agent" ? "agent" : "response";
  const references = dataset?.rows.map(r=>r.reference ?? r.gold) || [];
  const referenceFields = Object.keys(references[0] && typeof references[0]==="object" && !Array.isArray(references[0]) ? references[0] : {})
    .filter(k=>references.every(item=>isRecord(item) && Object.hasOwn(item,k)));
  const referenceCount=references.filter(value=>value!=null && value!=="").length;
  const referenceCoverage=referenceCount===0?"none":referenceCount===references.length?"all":"partial";
  return { objective, metrics, industry, target, criteria:approved?.requirements || [], referenceFields,referenceCoverage,
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

type Request=z.infer<typeof designRequest>;
function choicesFor(bench:DesignerBench,request:Request,industry:string):CatalogOptions {
  if(request.promptId){
    const prompt=bench.workflow.get(request.promptId);
    if(prompt.mode==="quick") return bench.quickGraderOptions(request.promptId);
    if(!prompt.datasetId) throw Error("The approved dataset prompt has no saved snapshot.");
    return bench.datasetGraderOptions(prompt.datasetId);
  }
  if(request.datasetId) return bench.datasetGraderOptions(request.datasetId);
  const entries=bench.graders.list();
  return {automatic:entries.filter(g=>g.library?.automatic && g.type==="catalog" && g.ruleKey!=="json-valid"),available:entries.filter(g=>{
    const scope=g.library?.scope ?? "customer";
    if (scope==="general" || g.library?.scenario || scope==="industry") return false;
    if(!["Cross-industry","General","Unclassified",industry].includes(g.industry)) return false;
    if(g.type==="field" || (g.type==="trajectory" && request.target!=="agent")) return false;
    return g.type!=="decision" || !g.requiredEvidence?.some(e=>e==="reference" || (e==="trajectory" && request.target!=="agent"));
  })};
}
function reviewedSource(g:GraderSpec) {
  const hosted=g.type==="decision" && g.decision.provider==="openrouter";
  return {id:g.id,name:g.name,version:g.version,scope:g.library?.scope ?? "customer",criteria:g.criteria,
    hosted,model:hosted && g.type==="decision" ? g.decision.model : null};
}
function hasRequiredEvidence(g:GraderSpec,brief:ReturnType<typeof gradingBrief>):boolean {
  if(g.type==="trajectory")return brief.target==="agent";
  if(g.type==="field")return brief.referenceFields.length>0;
  if(g.type==="opik-metric")return !getOpikTemplate(g.metricKey).requiresReference || brief.referenceCoverage!=="none";
  if(g.type==="decision")return !g.requiredEvidence?.some(e=>e==="reference" ? brief.referenceCoverage==="none" : brief.target!=="agent");
  return true;
}
function candidatesFor(options:CatalogOptions,brief:ReturnType<typeof gradingBrief>) {
  const terms=(value:string)=>new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g)||[]);
  const wanted=terms([brief.objective,...brief.metrics,...brief.criteria].join(" "));
  const seen=new Set<string>();
  return options.available.filter(g=>hasRequiredEvidence(g,brief) && !options.automatic.some(a=>a.id===g.id) && !g.library?.automatic)
    .sort((a,b)=>b.version-a.version).filter(g=>{
      const family=g.library?.familyId ?? g.id;
      if(seen.has(family))return false;
      seen.add(family);return true;
    }).map(g=>({g,overlap:[...terms([g.name,g.category,g.criteria].join(" "))].filter(t=>wanted.has(t)).length}))
    .sort((a,b)=>b.overlap-a.overlap || a.g.id.localeCompare(b.g.id)).slice(0,24).map(x=>x.g);
}
function checkCriteria(method:Method,criteria:string,brief:ReturnType<typeof gradingBrief>,literals:ReturnType<typeof literalRules>) {
  if(method==="contains" || method==="exact"){
    if(!literals[method].includes(criteria)) throw Error("Choose a literal required by the approved objective.");
  } else if(method==="field"){
    const rule=z.strictObject({outputField:z.string(),referenceField:z.string()}).parse(JSON.parse(criteria));
    if(!brief.referenceFields.includes(rule.referenceField) || (brief.outputFields.length && !brief.outputFields.includes(rule.outputField)))
      throw Error("Use a field present in the dataset schema and reference.");
  } else if(method==="trajectory" && brief.target!=="agent")throw Error("This grader requires an observed agent trajectory.");
}
function draftTable(db:DatabaseSync){
  db.exec(`CREATE TABLE IF NOT EXISTS grader_design_drafts(id TEXT PRIMARY KEY,created INTEGER NOT NULL,draft TEXT NOT NULL,approval TEXT,ids TEXT)`);
}
export async function designGraderPlan(bench:DesignerBench,raw:unknown) {
  if (bench.active || bench.designing) throw Error("Wait for the current run or planning request to finish.");
  bench.designing=true;
  try{
    const request=designRequest.parse(raw);
    const brief=gradingBrief(bench,request), literals=literalRules(brief), options=choicesFor(bench,request,brief.industry);
    const candidates=candidatesFor(options,brief);
    const choices=candidates.map((g,i)=>({option:"G"+(i+1),name:g.name,version:g.version,scope:g.library?.scope ?? "customer",
      method:g.type,criterion:g.criteria.slice(0,1000),category:g.category}));
    const automatic=options.automatic.map(g=>({name:g.name,criteria:g.criteria}));
    const methods:Method[]=(["exact","contains"] as const).filter(m=>literals[m].length);
    methods.push("judge");if(brief.referenceFields.length) methods.push("field");if(brief.target==="agent") methods.push("trajectory");
    const metric={type:"string",enum:brief.metrics};
    const grade={type:"object",additionalProperties:false,required:["name","metric","method","criteria","reason","threshold"],
      properties:{name:{type:"string"},metric,method:{type:"string",enum:methods},criteria:{type:"string"},reason:{type:"string"},threshold:{type:"number",minimum:.001,maximum:1}}};
    function proposalSchema(visible:typeof choices){
    const catalogChoice={type:"object",additionalProperties:false,required:["option","action","metric","reason","criteria"],
      properties:{option:{type:"string",enum:visible.map(x=>x.option)},action:{type:"string",enum:["reuse","derive"]},metric,
        reason:{type:"string"},criteria:{type:"string"}}};
    return {type:"object",additionalProperties:false,required:["summary","checks",...(visible.length?["catalogChoices"]:[])],
      properties:{summary:{type:"string"},checks:{type:"array",maxItems:8,items:grade},
        ...(visible.length && {catalogChoices:{type:"array",maxItems:8,items:catalogChoice}})}};
    }
    const route=await PlanningRoute.start(bench.adapters,{openaiFallback:()=>bench.plannerSettings.fallback()},AbortSignal.timeout(150000),()=>{});
    const agent=loadAgent("grader-designer");
    function parsePlan(output:Record<string,unknown>,visible:typeof choices){
      const parsed=z.strictObject({summary:z.string(),checks:z.array(checkSchema).max(8),catalogChoices:z.array(z.strictObject({
        option:z.string(),action:z.enum(["reuse","derive"]),metric:z.string(),reason:z.string(),criteria:z.string()})).max(8).optional()}).parse(output);
      const summary=bounded(parsed.summary,1500,"a coverage explanation");
      const checks:Proposed[]=[];
      const used=new Set<string>();
      for(const item of parsed.catalogChoices || []){
        const pos=choices.findIndex(c=>c.option===item.option), source=candidates[pos];
        if(!source || !visible.some(v=>v.option===item.option) || used.has(source.id))throw Error("Choose distinct catalog options from the supplied list.");
        used.add(source.id);
        if(!brief.metrics.includes(item.metric))throw Error("Choose an approved success measure.");
        const exact=item.action==="reuse";
        checks.push({action:item.action,source:reviewedSource(source),name:source.name,category:exact?source.category:item.metric.slice(0,100),
          industry:brief.industry,type:exact?source.type:"opik",criteria:exact?source.criteria:bounded(item.criteria,6000,"the customized criterion"),
          threshold:source.threshold,reason:bounded(item.reason,1200,"the link to the approved measure")});
      }
      for(const item of parsed.checks){
        const method=item.method,name=bounded(item.name,100,"a grader name");
        if(!methods.includes(method) || !brief.metrics.includes(item.metric)) throw Error("Choose an allowed method and approved measure.");
        let criteria=bounded(item.criteria,6000,"grading criteria");
        if((method==="contains" || method==="exact") && literals[method].length===1)criteria=literals[method][0];
        checkCriteria(method,criteria,brief,literals);
        // Attaching an automatic rule again gives it double weight in result summaries.
        const equal=(a:string,b:string)=>a.trim().toLowerCase()===b.trim().toLowerCase();
        if(automatic.some(g=>equal(g.name,name)||equal(g.criteria,criteria)))continue;
        if(choices.some(g=>equal(g.name,name) && equal(g.criterion,criteria)))throw Error("Reuse the matching pinned catalog option.");
        checks.push({action:"create",source:null,name,category:item.metric.slice(0,100),industry:brief.industry,
          type:method==="judge"?"opik":method,criteria,threshold:item.threshold,reason:bounded(item.reason,1200,"a rationale")});
      }
      if(checks.length>8 || new Set(checks.map(c=>c.name.toLowerCase())).size!==checks.length)throw Error("Choose up to eight distinct checks.");
      return {summary,checks};
    }
    const publicChoices=choices.filter(c=>c.scope!=="customer");
    const publicAutomatic=options.automatic.filter(g=>g.library?.scope==="general").map(g=>({name:g.name,criteria:g.criteria}));
    const publicDefaults=options.automatic.flatMap(g=>g.type==="opik-metric" ? [getOpikTemplate(g.metricKey)] : []);
    const payload={...brief,allowedLiterals:literals,automatic,catalog:choices};
    const result=await route.ask("Grader designer",agent.instructions,payload,proposalSchema(choices),2000,
      output=>parsePlan(output,choices),{
        payload:{...payload,automatic:[...publicAutomatic,...publicDefaults.map(g=>({name:g.name,criteria:g.criteria}))],catalog:publicChoices},
        schema:proposalSchema(publicChoices),validate:output=>parsePlan(output,publicChoices),
      });
    const draftId=randomUUID();draftTable(bench.db);
    bench.db.prepare("DELETE FROM grader_design_drafts WHERE created < ?").run(Date.now()-7*24*60*60*1000);
    bench.db.prepare("INSERT INTO grader_design_drafts(id,created,draft) VALUES(?,?,?)").run(draftId,Date.now(),JSON.stringify(draftSchema.parse({request,checks:result.checks})));
    return {draftId,...result,automatic:automatic.map(g=>g.name),designer:route.designer,agent:agentPin(agent),industry:brief.industry};
  } finally {bench.designing=false;}
}
export function confirmGraderPlan(bench:DesignerBench,raw:unknown):string[]{
  const {draftId,choices}=confirmationSchema.parse(raw);
  if(new Set(choices.map(c=>c.index)).size!==choices.length) throw Error("Choose each proposal once.");
  const db=bench.db;draftTable(db);db.exec("BEGIN IMMEDIATE");
  try{
    const row=db.prepare("SELECT draft,approval,ids FROM grader_design_drafts WHERE id=?").get(draftId);
    if(!row || typeof row.draft!=="string")throw Error("This grading plan expired. Propose a new plan.");
    const signature=createHash("sha256").update(JSON.stringify(choices)).digest("hex");
    if(typeof row.ids==="string"){
      if(signature!==row.approval)throw Error("This plan has already been approved. Design a new plan to change it.");
      const ids=z.array(textId).parse(JSON.parse(row.ids));db.exec("COMMIT");return ids;
    }
    const draft=draftSchema.parse(JSON.parse(row.draft)),brief=gradingBrief(bench,draft.request),literal=literalRules(brief);
    const options=choicesFor(bench,draft.request,brief.industry);
    const available=options.available.filter(g=>hasRequiredEvidence(g,brief) && !options.automatic.some(a=>a.id===g.id));
    const models=bench.servers.flatMap(s=>s.models);
    const ids=choices.map(choice=>{
      const check=draft.checks[choice.index];
      if(!check)throw Error("This proposal is outside the reviewed plan.");
      const source=check.source && available.find(g=>g.id===check.source?.id);
      if(check.source && !source)throw Error("The source grader is no longer applicable. Propose a new plan.");
      if(choice.action==="reuse"){
        if(!source)throw Error("This proposal has no pinned source to reuse.");
        return source.id;
      }
      if((choice.action==="derive")!==!!source)throw Error("Keep the source grader attached when customizing.");
      const type=source?"opik":check.type;
      const {name,category,criteria,threshold,judgeId}=choice.definition;
      if(type==="catalog" || type==="decision" || type==="opik-metric")throw Error("Choose a supported new customer rubric.");
      checkCriteria(type==="opik"?"judge":type,criteria,brief,literal);
      return bench.graders.save({intent:source?"derive":"create",...(source && {sourceGraderId:source.id}),
        type,name,category,criteria,threshold,judgeId,industry:brief.industry},models);
    });
    if(new Set(ids).size!==ids.length)throw Error("Remove duplicate graders before confirming.");
    db.prepare("UPDATE grader_design_drafts SET ids=?,approval=? WHERE id=?").run(JSON.stringify(ids),signature,draftId);
    db.exec("COMMIT");return ids;
  }catch(error){db.exec("ROLLBACK");throw error;}
}

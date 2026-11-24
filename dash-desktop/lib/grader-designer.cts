import {z} from "opik";
import {PlanningRoute,type PlannerAdapters} from "./planner-routing.cjs";
import {isRecord,type RuntimeInventory} from "./runtime-types.cjs";
import {loadAgent,agentPin,isDomain} from "../agents/registry.cjs";
import type {DatabaseSync} from "node:sqlite";
import {graderProducer,rubricEvidenceView,type GraderSpec} from "./grader-types.cjs";
import {randomUUID,createHash} from "node:crypto";
import {isExternalOutcomeMetric} from "./metric-audit.cjs";
import {getOpikTemplate} from "./opik-library.cjs";
import type {Graders} from "./graders.cjs";
import type {ApprovedPrompt} from "./outcome-workflow.cjs";
import type {DatasetSnapshot,ScenarioPack} from "./run-types.cjs";
import type {PlannerSettings} from "./planner-settings.cjs";
interface CatalogOptions {automatic:GraderSpec[];available:GraderSpec[]}
interface DesignerBench {
  active:unknown;designing:boolean;readonly modelLoading:boolean;readonly adapters:PlannerAdapters;readonly db:DatabaseSync;readonly graders:Graders;
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
const baseAssignment={choice:z.string(),reason:z.string()};
const anchorText=z.string().trim().min(1).max(600);
const anchorSchema=z.strictObject({full:anchorText,partial:anchorText,zero:anchorText,evidence:z.enum(["response","reference","trajectory","reference-and-trajectory"])});
const assignmentSchema=z.union([
  z.strictObject(baseAssignment),
  z.strictObject({...baseAssignment,name:z.string(),criteria:z.string(),threshold:z.number().gt(0).lte(1),anchors:anchorSchema.optional()}),
]);
const sourceSchema=z.object({id:textId,name:z.string(),version:z.number().int().positive(),scope:z.enum(["general","industry","customer"]),
  criteria:z.string(),hosted:z.boolean(),model:z.string().nullable()});
const proposedSchema=z.object({name:z.string(),category:z.string(),industry:z.string(),criteria:z.string(),threshold:z.number().gt(0).lte(1),
  type:z.enum(["contains","exact","field","trajectory","judge","opik","decision","catalog","opik-metric"]),reason:z.string(),
  evidenceView:rubricEvidenceView.optional(),requiredEvidence:z.array(z.enum(["reference","trajectory"])).optional(),action:z.enum(["reuse","derive","create"]),source:sourceSchema.nullable()});
type Proposed=z.infer<typeof proposedSchema>;
const draftSchema=z.object({request:designRequest,producer:graderProducer.optional(),checks:z.array(proposedSchema).max(8)});
const editableMethod=z.enum(["opik","contains","exact","field","trajectory"]);
const reviewFields=z.strictObject({evidenceView:rubricEvidenceView.optional(),type:editableMethod.optional(),industry:z.string().trim().min(1).max(100).optional(),name:z.string().trim().min(1).max(100),category:z.string().trim().min(1).max(100),
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
  const metrics = approved?.metrics || (request.metrics?.trim() ? request.metrics.split("\n").map(x=>x.trim()).filter(Boolean) : [objective]);
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
  if(g.type==="opik" && g.requiredEvidence?.some(e=>e==="reference" ? brief.referenceCoverage==="none" : brief.target!=="agent"))return false;
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
function supportedMethods(brief:ReturnType<typeof gradingBrief>, literals:ReturnType<typeof literalRules>):Method[] {
  const methods:Method[]=[];
  if(literals.exact.length) methods.push("exact");
  if(literals.contains.length) methods.push("contains");
  methods.push("judge");
  if(brief.referenceFields.length) methods.push("field");
  if(brief.target==="agent") methods.push("trajectory");
  return methods;
}

// A measure asking if a generated artifact includes specified details can be checked
// directly. Accuracy or provenance of those details is a different evidence requirement.
function asksForAnswerContent(metric:string):boolean {
  if(/\b(?:verified?|verif(?:y|ies|ication)|accurac\w*|correct\w*|true|valid\w*|authoritative|actual|current|active|superseded|ground\w*|match\w*|consisten\w*|supported|source|reference|observed|executed)\b/i.test(metric))return false;
  const artifact=/\b(?:candidate(?:'s)? (?:responses?|outputs?|answers?)|handoff notes?|recommendations?|responses?|answers?|summar(?:y|ies)|reports?)\b/i;
  const obligation=/\b(?:name[sd]?|identify|identifies|specif(?:y|ies)|state[sd]?|mention(?:s|ed)?|cit(?:e[sd]?|ing)|include[sd]?|contain(?:s|ed)?|list(?:s|ed)?)\b/i;
  return artifact.test(metric) && obligation.test(metric);
}

// A planning request precedes inference. A missing future answer must not hide a measurable response requirement.
function skipsFutureAnswer(reason:string):boolean {
  const answer="(?:candidate(?:'s)? (?:answer|response|output)|(?:actual|generated|future) (?:answer|response|output)|(?:handoff|inspection) note(?: text)?)s?";
  const missing="(?:no|without|missing|absent|unavailable|not (?:yet )?(?:present|provided|supplied|include[ds]?|contain(?:s|ed)?|available|generated|have)|lack(?:s|ing)?)";
  const qualifier="(?:(?:an?|the|any|actual|example of|previous|completed|text of|explicit)\\s+){0,4}";
  return new RegExp("\\b"+missing+"\\s+"+qualifier+answer+"\\b|\\b"+answer+"\\b\\s+(?:(?:itself|is|was|has|been|are|were|yet|currently)\\s+){0,4}"+missing,"i").test(reason);
}

// Inspect positive scoring conditions. An explicit instruction to exclude an external
// outcome does not make that outcome part of the grade.
function rewardsExternalOutcome(criteria:string,full:string,partial:string):boolean {
  return [criteria,full,partial].some(text=>text.split(/[.;\n]|\bbut\b/i).some(clause=>{
    const positive=clause.replace(/\b(?:(?:do|must|should) not (?:score|grade|assess|judge|require|reward)|exclude|ignore)\b[^,]+/gi,"");
    return isExternalOutcomeMetric(positive);
  }));
}

function draftTable(db:DatabaseSync){
  db.exec(`CREATE TABLE IF NOT EXISTS grader_design_drafts(id TEXT PRIMARY KEY,created INTEGER NOT NULL,draft TEXT NOT NULL,approval TEXT,ids TEXT)`);
}
export async function designGraderPlan(bench:DesignerBench,raw:unknown) {
  if (bench.modelLoading) throw Error("Wait for the LM Studio model load to finish before designing graders.");
  if (bench.active || bench.designing) throw Error("Wait for the current run or planning request to finish.");
  bench.designing=true;
  try{
    const request=designRequest.parse(raw);
    const brief=gradingBrief(bench,request), literals=literalRules(brief), options=choicesFor(bench,request,brief.industry);
    const candidates=candidatesFor(options,brief);
    const choices=candidates.map((g,i)=>({option:"G"+(i+1),name:g.name,version:g.version,scope:g.library?.scope ?? "customer",
      method:g.type,criterion:g.criteria.slice(0,1000),category:g.category}));
    const automatic=options.automatic.map(g=>({name:g.name,criteria:g.criteria}));
    const methods=supportedMethods(brief,literals);
    const goals=[...new Set(brief.metrics)].map((metric,i)=>({key:"M"+(i+1),metric,external:isExternalOutcomeMetric(metric),answerContent:asksForAnswerContent(metric)}));
    if(!goals.length)throw Error("Enter at least one success measure.");
    const numberedAutomatic=(rows:typeof automatic)=>rows.map((g,i)=>({...g,option:"A"+(i+1)}));
    const route=await PlanningRoute.start(bench.adapters,{openaiFallback:()=>bench.plannerSettings.fallback()},AbortSignal.timeout(150000),()=>{});
    const agent=loadAgent("grader-designer");
    type Visible=typeof choices;
    type Defaults=ReturnType<typeof numberedAutomatic>;
    function proposalSchema(visible:Visible,defaults:Defaults){
      const catalogOptions=visible.map(x=>x.option);
      const simple=["SKIP",...catalogOptions,...defaults.map(x=>x.option)];
      const comment={type:"string",minLength:1,maxLength:400};
      const writeFields={reason:comment,name:{type:"string",minLength:1,maxLength:100},criteria:{type:"string",minLength:1,maxLength:1900},
        threshold:{type:"number",exclusiveMinimum:0,maximum:1}};
      const anchor={type:"string",minLength:1,maxLength:600};
      const evidence=["response",...(brief.referenceCoverage==="none"?[]:["reference"]),...(brief.target==="agent"?["trajectory"]:[]),
        ...(brief.referenceCoverage!=="none" && brief.target==="agent"?["reference-and-trajectory"]:[])];
      const mechanical=methods.filter(m=>m!=="judge").map(m=>"NEW:"+m);
      const resolution=(answerContent:boolean)=>({anyOf:[
        ...(!answerContent || catalogOptions.length?[{type:"object",additionalProperties:false,required:["choice","reason"],properties:{choice:{type:"string",enum:answerContent?catalogOptions:simple},reason:comment}}]:[]),
        ...(mechanical.length?[{type:"object",additionalProperties:false,required:["choice","reason","name","criteria","threshold"],
          properties:{choice:{type:"string",enum:mechanical},...writeFields}}]:[]),
        {type:"object",additionalProperties:false,required:["choice","reason","name","criteria","threshold","anchors"],properties:{
          choice:{type:"string",enum:["NEW:judge",...visible.map(x=>"ADAPT:"+x.option)]},...writeFields,
          anchors:{type:"object",additionalProperties:false,required:["full","partial","zero","evidence"],
            properties:{full:anchor,partial:anchor,zero:anchor,evidence:{type:"string",enum:evidence}}}}},
      ]});
      return {type:"object",additionalProperties:false,required:goals.map(g=>g.key),
        properties:Object.fromEntries(goals.map(g=>[g.key,g.external?{anyOf:[{type:"object",additionalProperties:false,required:["choice","reason"],properties:{choice:{type:"string",enum:["SKIP"]},reason:comment}}]}:resolution(g.answerContent)]))};
    }
    function parsePlan(output:Record<string,unknown>,visible:Visible,defaults:Defaults){
      if(Object.keys(output).length!==goals.length || goals.some(g=>!Object.hasOwn(output,g.key)))
        throw Error("Return one assignment per measure key. Do not return lists of new checks and catalog choices.");
      const checks:Proposed[]=[];
      const summaries:string[]=[];
      const byDefinition=new Map<string,Proposed>();
      const sameText=(a:string,b:string)=>a.trim().toLowerCase()===b.trim().toLowerCase();
      for(const {key,metric,external,answerContent} of goals){
        if(external){
          summaries.push(metric+" — unscored. Verify the realized outcome with operating records and a comparable baseline.");
          continue;
        }
        const pick=assignmentSchema.parse(output[key]);
        const rationale=bounded(pick.reason,400,"a short reason for this measure");
        const auto=defaults.find(d=>d.option===pick.choice);
        const editing=pick.choice.startsWith("ADAPT:"), creating=pick.choice.startsWith("NEW:");
        if(!editing && !creating && "criteria" in pick)throw Error("An exact reuse or skip cannot contain modified criteria. Choose ADAPT for a changed rubric.");
        if(pick.choice==="SKIP"){
          if(answerContent || /\bskip (?:is not|isn\x27t) appropriate\b/i.test(rationale) || skipsFutureAnswer(rationale))throw Error(key+": the candidate answer is guaranteed at scoring time. Design the per-answer check. Skip only if a specific independent source is required and unavailable");
          summaries.push(metric+" — unscored. "+rationale);continue;
        }
        if(auto && answerContent)throw Error("A general completion or response-presence diagnostic cannot grade the requested details in an answer. Select a fitting catalog check or design a rubric");
        if(auto){summaries.push(metric+" — already checked by "+auto.name+".");continue;}
        const handle=editing?pick.choice.slice(6):pick.choice;
        const existing=visible.find(v=>v.option===handle);
        const source=existing?candidates[choices.indexOf(existing)]:undefined;
        if(!creating && !source)throw Error("Choose only a catalog option offered for this measure.");
        let check:Proposed;
        if(source && !editing){
          check={action:"reuse",source:reviewedSource(source),name:source.name,category:source.category,industry:brief.industry,
            type:source.type,criteria:source.criteria,threshold:source.threshold,reason:rationale,...(source.type==="opik" && {evidenceView:source.evidenceView,requiredEvidence:source.requiredEvidence})};
        }else{
          if(!("criteria" in pick))throw Error("A new or adapted check needs its name, criteria and pass threshold.");
          const method=editing?"judge":methodSchema.parse(pick.choice.slice(4));
          if(!methods.includes(method))throw Error("Choose a method supported by the supplied evidence.");
          let criteria=bounded(pick.criteria,6000,"grading criteria");
          if((method==="contains" || method==="exact") && literals[method].length===1)criteria=literals[method][0];
          checkCriteria(method,criteria,brief,literals);
          const name=bounded(pick.name,100,"a grader name");
          if(creating && defaults.some(d=>sameText(d.name,name) || sameText(d.criteria,criteria)))
            throw Error("Choose the existing automatic check for this measure.");
          if(creating && visible.some(v=>sameText(v.name,name) || sameText(v.criterion,criteria)))
            throw Error("Choose the offered catalog option for exact reuse or ADAPT its criterion explicitly.");
          const anchors=pick.anchors;
          let requiredEvidence:("reference"|"trajectory")[]|undefined;
          if(method==="judge"){
            if(!anchors || new Set([anchors.full,anchors.partial,anchors.zero].map(v=>v.toLowerCase())).size!==3)
              throw Error("Provide three distinct observable anchors for full, partial and zero credit.");
            if(rewardsExternalOutcome(criteria,anchors.full,anchors.partial))
              throw Error("Grade the observable success measure. A candidate answer cannot earn credit for achieving or claiming a real-world financial or operational outcome");
            requiredEvidence=[];
            if(anchors.evidence==="reference" || anchors.evidence==="reference-and-trajectory")requiredEvidence.push("reference");
            if(anchors.evidence==="trajectory" || anchors.evidence==="reference-and-trajectory")requiredEvidence.push("trajectory");
            if(requiredEvidence.includes("reference") && brief.referenceCoverage==="none" || requiredEvidence.includes("trajectory") && brief.target!=="agent")
              throw Error("The proposed semantic rubric depends on unavailable evidence. Use an observable criterion or skip it.");
            // A share counts whether each response qualifies. Partial membership cannot contribute to that numerator.
            const binaryCount=answerContent && /^(?:the\s+)?(?:share|percent(?:age)?|proportion|fraction|number|count)\s+of\b/i.test(metric);
            const instructions=binaryCount?["Count this answer once if it meets every stated condition in the measure.",
              "Full credit (10): the candidate answer explicitly includes every element required by this measure.","Partial credit (5): unavailable for this binary count.",
              "Zero credit (0): one or more required conditions are absent. Use only 0 or 10."]:
              [criteria,"Full credit (10): "+anchors.full,"Partial credit (5): "+anchors.partial,"Zero credit (0): "+anchors.zero,
              "Apply the zero-credit condition first. Use partial credit only if that condition is absent. For a binary policy, use only 0 or 10."];
            criteria=bounded(["Success measure: "+metric,...instructions,requiredEvidence.length?"Missing "+requiredEvidence.join(" or ")+" evidence leaves the case unscored.":
                "Use the selected evidence view. External outcomes require separate records."].join("\n"),6000,"grading criteria");
          } else if(anchors)throw Error("Select a rubric to use semantic scoring anchors.");
          check={action:editing?"derive":"create",source:source?reviewedSource(source):null,name,category:metric.slice(0,100),
            industry:brief.industry,type:method==="judge"?"opik":method,criteria,threshold:pick.threshold,reason:rationale,...(method==="judge" && {evidenceView:answerContent && !requiredEvidence?.length?"answer-only":"case"}),...(requiredEvidence?.length && {requiredEvidence})};
        }
        const identity=check.action==="reuse"?JSON.stringify(["reuse",check.source?.id]):
          JSON.stringify([check.action,check.source?.id,check.name,check.type,check.criteria,check.threshold,check.industry,check.category]);
        const duplicate=byDefinition.get(identity);
        if(duplicate){
          duplicate.reason+="\n"+metric+" — "+rationale;
        }else{
          check.reason=metric+" — "+rationale;
          checks.push(check);byDefinition.set(identity,check);
        }
        summaries.push(metric+" — "+(check.action==="reuse"?"reuse ":check.action==="derive"?"customize ":"create ")+check.name+
          (check.action==="reuse"?" v"+check.source?.version:"")+".");
      }
      if(checks.length>8)throw Error("These measures require more than eight distinct graders. Group related measures or use separate runs.");
      return {summary:summaries.join("\n"),checks};
    }
    const publicChoices=choices.filter(c=>c.scope!=="customer");
    const publicDefaults=numberedAutomatic(options.automatic.flatMap(g=>g.library?.scope==="general"?[{name:g.name,criteria:g.criteria}]:
      g.type==="opik-metric"?[getOpikTemplate(g.metricKey)]:[]));
    const localDefaults=numberedAutomatic(automatic);
    const payload={evaluationPhase:{now:"Design a grader BEFORE inference.",atScoring:"Every grader receives the dispatched task and the candidate's generated answer, even without a dataset.",
      aggregate:"For a share or rate of answers meeting a stated requirement, score the requirement once per answer. The run counts those cases.",
      references:brief.referenceCoverage,observedAgentSteps:brief.target==="agent"?"when recorded":"none"},
      ...brief,goals,allowedLiterals:literals,automatic:localDefaults,catalog:choices};
    const externalOnly=goals.every(goal=>goal.external);
    const result=externalOnly?parsePlan(Object.fromEntries(goals.map(({key})=>[key,null])),[],[]):await route.ask("Grader designer",agent.instructions,payload,proposalSchema(choices,localDefaults),
      Math.min(4500,820*goals.length+320),output=>parsePlan(output,choices,localDefaults),{
        payload:{...payload,automatic:publicDefaults,catalog:publicChoices},schema:proposalSchema(publicChoices,publicDefaults),
        validate:output=>parsePlan(output,publicChoices,publicDefaults),
      });
    const draftId=randomUUID();draftTable(bench.db);
    bench.db.prepare("DELETE FROM grader_design_drafts WHERE created < ?").run(Date.now()-7*24*60*60*1000);
    bench.db.prepare("INSERT INTO grader_design_drafts(id,created,draft) VALUES(?,?,?)").run(draftId,Date.now(),JSON.stringify(draftSchema.parse({request,checks:result.checks,...(route.designer && {producer:{agent:agentPin(agent),model:route.designer}})})));
    return {draftId,...result,editableMethods:methods.map(m=>m==="judge"?"opik" as const:m),automatic:automatic.map(g=>g.name),designer:route.designer,agent:agentPin(agent),industry:brief.industry};
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
      const type=choice.definition.type ?? (source?"opik":check.type);
      const industry=choice.definition.industry ?? brief.industry;
      const industryLocked=!!(source || draft.request.promptId || draft.request.datasetId);
      if ((industryLocked && industry!==brief.industry) || (!industryLocked && !["General","Cross-industry"].includes(industry) && !isDomain(industry)))
        throw Error("Keep the grader applicable to the reviewed domain and source.");
      if(source && type!=="opik")throw Error("Customize this source as an Opik rubric or reuse its exact version.");
      const {name,category,criteria,threshold,judgeId}=choice.definition;
      if(type==="catalog" || type==="decision" || type==="opik-metric")throw Error("Choose a supported new customer rubric.");
      const method=type==="opik"?"judge":type;
      if(!supportedMethods(brief,literal).includes(method))throw Error("Choose a method supported by the available evidence.");
      checkCriteria(method,criteria,brief,literal);
      return bench.graders.save({intent:source?"derive":"create",...(source && {sourceGraderId:source.id}),
        type,name,category,criteria,threshold,judgeId,industry,...(type==="opik" && check.requiredEvidence && {requiredEvidence:check.requiredEvidence}),...(type==="opik" && {evidenceView:choice.definition.evidenceView ?? check.evidenceView})},models,null,draft.producer);
    });
    if(new Set(ids).size!==ids.length)throw Error("Remove duplicate graders before confirming.");
    db.prepare("UPDATE grader_design_drafts SET ids=?,approval=? WHERE id=?").run(JSON.stringify(ids),signature,draftId);
    db.exec("COMMIT");return ids;
  }catch(error){db.exec("ROLLBACK");throw error;}
}

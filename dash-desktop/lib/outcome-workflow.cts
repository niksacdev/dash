import {decodeQuickOutputSchema, decodeQuickTaskInput, inputsFromTask, plannerFieldsSchema, plannerInputsSchema, schemaFromFields, type QuickOutputSchema, type QuickTaskInput} from "./quick-structure.cjs";
import {randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {hash} from "./packs.cjs";
import {RoleStore,transaction,type DomainRole} from "./domain-profiles.cjs";
import {bundledAgents,agentPin,isRecord,domains,isDomain,type Domain,type AgentRegistry} from "../agents/registry.cjs";
import {instructionEcho,knownScorer,proposals,pairSelection,metricsAuditSchema,validateMetricAudit,type MetricAudit} from "./metric-audit.cjs";
import {candidateGuidance,inspectionCheck} from "./prompt-fidelity.cjs";
import {PlanningRoute,repetitive,tokens,type PlannerAdapters,type PlannerOptions,type PlannerIdentity,type PlanningAttempt} from "./planner-routing.cjs";
import {required,optional,lines,cap,decodeRequest,decodeApprovedPrompt,type ApprovedPrompt,type DesignRequest,type DesignContext,type PlanningPurpose,type ScenarioContract,type PromptDraft,type MetricSuggestion} from "./outcome-contracts.cjs";
export {decodeApprovedPrompt} from "./outcome-contracts.cjs";
export type {ApprovedPrompt,PromptDraft,DesignRequest,DesignContext,PlanningPurpose,MetricSuggestion} from "./outcome-contracts.cjs";
export type {DomainRole} from "./domain-profiles.cjs";
const string = { type: "string" };
const strings = { type: "array", minItems: 1, maxItems: 3, items: { type: "string", maxLength: 180 } };
function objectSchema(properties:Record<string,unknown>) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
const routeSchema = objectSchema({ domain: { type: "string", enum: domains } });
const measureSchema = objectSchema({ requirements: strings, metrics: strings });
const expertSchema = objectSchema({ title: string, metrics: strings, requirements: strings });
const implementerSchema = objectSchema({ prompt: { type: "string", maxLength: 900 }, reason:{type:"string",maxLength:180} });
export function contractHash(pack:Pick<ScenarioContract,'id'|'system'|'outputSchema'|'metrics'>) {
  return hash({ id:pack.id, system:pack.system, outputSchema:pack.outputSchema, metrics:pack.metrics });
}
function datasetContext(request:DesignRequest, context:DesignContext) {
  if (request.mode === "quick") {
    if (request.datasetId) throw Error("Use a dataset run to attach a dataset.");
    return null;
  }
  const id = required(request.datasetId, "Dataset snapshot", 256);
  const pack = context?.pack;
  if (!pack || context.datasetId !== id) throw Error("Select a current dataset snapshot before drafting.");
  return {
    datasetId:id, packId:pack.id, contractHash:contractHash(pack), title:pack.title,
    description:pack.description, scorer:pack.scorer, system:pack.system, outputSchema:pack.outputSchema, metrics:pack.metrics,
    industry:context.industry ?? null, version:context.version ?? null, split:context.split ?? null,
  };
}
function titleFor(raw:unknown, objective:string) {
  if (typeof raw === "string" && raw.trim() && raw.length <= 180 && !repetitive(raw)) return raw.trim();
  const sentence = objective.replace(/\s+/g, " ").trim();
  return sentence.length <= 96 ? sentence : sentence.slice(0, 95).trimEnd() + "…";
}
function measureLines(value:unknown, label:string) {
  const entries = lines(value, label);
  for (const entry of entries) {
    const namedMetric = label === "Expert metrics" && /^(precision|recall|latency|throughput|accuracy|mae|rmse|f1)$/i.test(entry);
    if (new Set(tokens(entry)).size < 2 && !namedMetric)
      throw Error(label + " must describe a meaningful measure or success condition");
  }
  return entries;
}
// Some small planners return a useful per-case criterion but copy an unrelated aggregate.
// A pass rate for that specific criterion has a defined numerator and denominator.
const commonMeasureWords = new Set(("a an and are as at by case cases count each for from in is it of on or per rate records " +
  "responses results share supplied that the their this to with answers candidate correctly correct applicable accuracy").split(" "));
function measureTerms(text:string) {
  return new Set(tokens(text).filter(t => t.length > 2 && !commonMeasureWords.has(t)).map(t => t.replace(/s$/, "")));
}
function evaluationMeasures(result:Record<string,unknown>, objective:string, requestedMetrics:string, domain:Domain, dataset:ReturnType<typeof datasetContext>, instructions:string[]):Findings {
  const original = measureLines(result?.requirements ?? result?.criteria, "Expert criteria");
  const criteria = [], omissions = [];
  for (const criterion of original) {
    try {
      if (instructionEcho(criterion,instructions)) { omissions.push("copied planning instructions"); continue; }
      const check = candidateGuidance(criterion,{objective,dataset,expert:true});
      if (check.omitted) omissions.push(...check.reasons);
      else criteria.push(check.text);
    } catch { omissions.push("an unsupported case rule"); }
  }
  let supplementSource;
  if (!criteria.length) {
    const supplement = inspectionCheck(domain,objective,dataset);
    if (supplement) { criteria.push(supplement.criterion); supplementSource = supplement.source; }
  }
  // A meaningful criterion can still be audited when its proposed aggregate is unusable.
  const proposed = Array.isArray(result.metrics) ? result.metrics.slice(0,8).map((v:unknown)=>
    typeof v==="string" && v.trim().length<=1000 && !repetitive(v) && new Set(tokens(v)).size>=2 ? v.trim() : "") : [];
  const metrics = criteria.map((criterion, index) => {
    const metric = proposed[index];
    if (!omissions.length && metric && proposed.length === criteria.length) {
      const terms = measureTerms(metric);
      const relevant = [...measureTerms([criterion, objective, requestedMetrics].join(" "))].some(t => terms.has(t));
      const aggregate = /\b(?:rate|ratio|share of|percentage|percent|fraction|proportion|count|number of|accuracy|precision|recall|coverage|per (?!share\b)\w+|false (?:accepts|releases))\b/i.test(metric);
      if (!/^(?:pass test|requirement|criterion)\b/i.test(metric) && aggregate && relevant &&
          /correct|accura|error|miss|false|true|match|precis|recal|support|cited|complet|cover|pass|agreement|verified/i.test(metric)) return metric;
      if (requestedMetrics && requestedMetrics.includes(metric)) return metric;
    }
    return "";
  });
  return { title:titleFor(result?.title, objective), metrics, requirements:criteria, ...(omissions.length && {criteriaReview:{omitted:original.length-(supplementSource ? 0 : criteria.length),reasons:[...new Set(omissions)],supplementSource}}) };
}
interface Findings {title:string;metrics:string[];requirements:string[];criteriaReview?:{omitted:number;reasons:string[];supplementSource?:string}}
interface CachedSuggestion {scope:string;domain:Domain;domainSource:string;expert:DomainRole;designer:PlannerIdentity;findings:Findings;metricAudit:MetricAudit[];auditDesigner:PlannerIdentity;planningAttempts:PlanningAttempt[]}
function decodeSaved(spec:unknown):ApprovedPrompt {
  if (typeof spec!=="string") throw Error("Invalid saved prompt.");
  return decodeApprovedPrompt(JSON.parse(spec));
}
export class OutcomeWorkflow {
  private readonly drafts = new Map<string,PromptDraft>();
  private readonly suggestions = new Map<string,CachedSuggestion>();
  private readonly controllers = new Set<AbortController>();
  private readonly roleStore:RoleStore;
  constructor(private readonly db:DatabaseSync,private readonly adapters:PlannerAdapters,private readonly planning:PlannerOptions={},
              private readonly registry:AgentRegistry=bundledAgents) {
    this.roleStore=new RoleStore(db,registry);
    db.exec("CREATE TABLE IF NOT EXISTS outcome_prompts(id TEXT PRIMARY KEY, family TEXT NOT NULL, version INTEGER NOT NULL, draft TEXT UNIQUE NOT NULL, approval_hash TEXT NOT NULL, spec TEXT NOT NULL, UNIQUE(family, version))");
  }
  roles() {return this.roleStore.roles();}
  saveRole(input:unknown) {return this.roleStore.save(input);}
  get(id:unknown):ApprovedPrompt {
    const row = typeof id === "string" && this.db.prepare("SELECT spec FROM outcome_prompts WHERE id=?").get(id);
    if (!row) throw Error("This approved prompt could not be found. Refresh the prompt catalogue.");
    return decodeSaved(row.spec);
  }
  list() {
    return this.db.prepare("SELECT spec FROM outcome_prompts ORDER BY rowid DESC").all().map(row => decodeSaved(row.spec));
  }
  history(id:unknown) {
    const { familyId } = this.get(id);
    return this.db.prepare("SELECT spec FROM outcome_prompts WHERE family=? ORDER BY version").all(familyId).map(row => decodeSaved(row.spec));
  }
  cancel() {
    for (const controller of this.controllers) controller.abort();
  }
  design(input:unknown,context?:DesignContext,purpose?:"draft"):Promise<PromptDraft>;
  design(input:unknown,context:DesignContext,purpose:"suggest"):Promise<MetricSuggestion>;
  design(input:unknown,context:DesignContext,purpose:PlanningPurpose):Promise<PromptDraft|MetricSuggestion>;
  async design(input:unknown, context:DesignContext = {}, purpose:PlanningPurpose = "draft"):Promise<PromptDraft|MetricSuggestion> {
    const request=decodeRequest(input);
    const objective = required(request.objective, "Business outcome", 12000);
    const requestedMetrics = optional(request.metrics, "Business metrics", 2000);
    const inputCap = cap(request.inputCap, "Input budget");
    const outputCap = cap(request.outputCap, "Output budget");
    const dataset = datasetContext(request, context);
    const selectedDomain = optional(request.domain, "Planning domain", 100);
    const manual = selectedDomain && selectedDomain.toLowerCase() !== "auto" ? selectedDomain : null;
    if (manual && !isDomain(manual)) throw Error("Choose Financial Services, Manufacturing or General.");
    const pinned = isDomain(dataset?.industry) ? dataset.industry : null;
    if (pinned && manual && manual !== pinned) throw Error("Use the domain assigned to this dataset snapshot.");
    const parent = request.parentId ? this.get(request.parentId) : null;
    if (parent && (parent.mode !== request.mode || parent.datasetId !== (dataset?.datasetId ?? null)))
      throw Error("Revise this prompt with its original run type and dataset snapshot.");
    const structuredOutput = request.structuredOutput ?? !!parent?.outputSchema;
    const scope = hash([request.mode, objective, requestedMetrics, manual, dataset?.datasetId, dataset?.contractHash, dataset?.scorer, context.coverage, parent?.id, context.priorRun?.id]);
    const prior = request.suggestionId ? this.suggestions.get(request.suggestionId) : undefined;
    if (request.suggestionId && prior?.scope !== scope)
      throw Error("The objective or scenario changed, or the suggestions expired. Choose Suggest Metrics again.");
    const choices = request.measures == null ? null : {
      metrics: lines(request.measures.metrics, "Selected metrics", 2000, 0),
      criteria: lines(request.measures.criteria, "Success criteria", 2000, 0),
    };
    const previousRows=prior?.metricAudit.filter(row=>row.status!=="external");
    const previous=previousRows ? {metrics:previousRows.map(r=>r.metric),criteria:previousRows.map(r=>r.criterion),pairs:previousRows} :
      parent ? {metrics:parent.metrics,criteria:parent.requirements,
        pairs:parent.metricCriteria ?? parent.metricAudit?.filter(r=>r.status!=="external") ??
          (parent.metrics.length===parent.requirements.length ? proposals(parent.metrics,parent.requirements) : undefined)} : null;
    const selected=choices ? pairSelection(choices.metrics,choices.criteria,previous) : null;
    const explicitlyEmpty=purpose==="draft" && selected?.length===0;
    // Snapshot IDs, versions and splits describe the catalogue. They are never case evidence.
    const publicTask:(Pick<ScenarioContract,'title'|'description'|'system'|'outputSchema'|'metrics'> & {scoringDefinitions?:Record<string,string>})|null = dataset && {
      title:dataset.title, description:dataset.description, system:dataset.system,
      outputSchema:dataset.outputSchema, metrics:dataset.metrics,
    };
    if (publicTask?.metrics?.length === 3 && knownScorer(context.pack)) {
      const [ready, incorrect, review] = publicTask.metrics;
      publicTask.scoringDefinitions = {
        [ready]: "Count of candidate proposals to accept or auto-route that pass the scenario grader.",
        [incorrect]: "Count of candidate proposals to accept or auto-route that fail the scenario grader.",
        [review]: "Fraction of scored responses that either require review or fail the grader.",
      };
    }
    const brief:{mode:DesignRequest['mode'];objective:string;requestedMetrics:string;inputCap:number|null;outputCap:number|null;dataset:typeof publicTask;successCriteria?:string[];previousApproved?:{prompt:string;metrics:string[]};priorRun?:DesignContext['priorRun']} = { mode:request.mode, objective, requestedMetrics, inputCap, outputCap, dataset:publicTask };
    if (choices) {
      brief.requestedMetrics = choices.metrics.join("\n");
      brief.successCriteria = selected?.map(item=>item.criterion).filter(Boolean) ?? [];
    }
    if (parent && !explicitlyEmpty) brief.previousApproved = { prompt:parent.prompt, metrics:parent.metrics };
    if (parent && context.priorRun) brief.priorRun = context.priorRun;

    // Snapshot each role before starting asynchronous inference. An admin edit takes effect on the next draft.
    const configs = this.roles();
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const requestId = request.requestId || randomUUID();
      const route = await PlanningRoute.start(this.adapters, this.planning, controller.signal,
        event => context.onStage?.({ mode:request.mode, ...event }), requestId);
      const ask = route.ask.bind(route);
      const promptAsset=(id:string)=>this.registry.get(id);

      let domain:Domain|null=prior?.domain || pinned || (isDomain(manual)?manual:null);
      const domainSource = prior?.domainSource || (pinned ? "dataset" : manual ? "user" : "inferred");
      if (!domain) {
        domain = await ask("Domain routing",
          promptAsset("workflow-router").instructions,
          { objective, requestedMetrics, scenario:dataset?.title ?? null, datasetIndustry:dataset?.industry ?? null }, routeSchema, 48, result => {
            if (!isDomain(result.domain)) throw Error("the router returned an unknown domain");
            return result.domain;
          });
      }
      const agents = configs.filter(c => c.domain === domain);
      const expert = prior?.expert ?? agents.find(c => c.role === "expert");
      const implementer = agents.find(c => c.role === "implementer");
      if (!expert || !implementer) throw Error("Missing configured domain role.");
      const grounding = (role:DomainRole) => role.instructions + "\nReference material behind this profile: " + JSON.stringify(role.sources);
      const findings = prior?.findings ?? await ask(domain + " expert", grounding(expert) +
        "\n" + promptAsset("workflow-expert").instructions +
        (purpose === "suggest" ? "\nReturn only the metrics and requirements arrays." : "\nGive the brief a short title."),
        { ...brief, assignment:promptAsset("workflow-expert-assignment").instructions.replace("{{objective}}",()=>objective) },
        purpose === "suggest" ? measureSchema : expertSchema, 550, result => evaluationMeasures(result, objective, requestedMetrics, domain, dataset, [expert.instructions,promptAsset("workflow-expert").instructions,promptAsset("workflow-expert-assignment").instructions]), undefined, {advisoryMetrics:true});
      const expertDesigner = prior?.designer ?? route.designer;
      if (!expertDesigner) throw Error("Missing expert planning identity.");
      const auditor=promptAsset("workflow-metric-auditor");
      const priorSelected=prior?.metricAudit.filter(row=>row.status!=="external");
      const sameSelection=!!prior && (!choices || (
        JSON.stringify(choices.metrics)===JSON.stringify(priorSelected?.map(row=>row.metric)) &&
        JSON.stringify(choices.criteria)===JSON.stringify(priorSelected?.map(row=>row.criterion))));
      const edited=purpose==="suggest" && !selected?.length ? null : selected;
      const inputs=edited ?? proposals(findings.metrics,findings.requirements);
      const metricAudit=sameSelection && prior ? prior.metricAudit : explicitlyEmpty ? [] :
        await ask("Evaluation metric audit",auditor.instructions,{
          objective,requestedMetrics,mode:request.mode,proposals:inputs,
          scenario:dataset ? {title:dataset.title,scorer:dataset.scorer,metrics:dataset.metrics,coverage:context.coverage}:null,
          preserveSelectedWording:!!choices,
        },metricsAuditSchema,1100,result=>validateMetricAudit(result,objective,context.pack,context.coverage,requestedMetrics,
          [expert.instructions,promptAsset("workflow-expert").instructions,promptAsset("workflow-expert-assignment").instructions,auditor.instructions],edited));
      const auditDesigner=sameSelection && prior ? prior.auditDesigner : explicitlyEmpty ? null : route.designer;
      if (!auditDesigner && !explicitlyEmpty) throw Error("Missing metric auditor identity.");
      const accepted=metricAudit.filter(row=>row.status!=="external");
      const metrics=accepted.map(row=>row.metric), requirements=accepted.map(row=>row.criterion);
      if (purpose === "suggest") {
        if (!auditDesigner) throw Error("Missing metric auditor identity.");
        const id = randomUUID();
        this.suggestions.set(id, { scope, domain, domainSource, expert, designer:expertDesigner, findings, metricAudit, auditDesigner, planningAttempts:route.attempts });
        if (this.suggestions.size > 64) this.suggestions.delete(this.suggestions.keys().next().value ?? '');
        return structuredClone({ id, domain, expertVersion:expert.version, model:expertDesigner.model, designer:expertDesigner, planningAttempts:route.attempts,
          metrics, criteria:requirements, metricAudit, ...(context.coverage && {auditCoverage:{...context.coverage}}), auditDesigner, auditAgent:agentPin(auditor), criteriaReview:findings.criteriaReview });
      }
      // Audit targets can be numbers, dates, category names or arbitrary expected text.
      // Build the candidate-writing brief from a public allowlist, never by filtering targets.
      const priorEvidence:unknown=brief.priorRun;
      const implementerTask={
        objective,mode:request.mode,inputCap,outputCap,
        dataset:dataset ? {title:dataset.title,description:dataset.description,system:dataset.system,outputSchema:dataset.outputSchema}:null,
        ...(isRecord(priorEvidence) && {refinement:{
          inputLimitExceeded:isRecord(priorEvidence.tokenConstraint),
          outputTruncated:Array.isArray(priorEvidence.truncatedOutputs) && priorEvidence.truncatedOutputs.length>0,
        }}),
        assignment:promptAsset("workflow-implementer-assignment").instructions,
        ...(structuredOutput && {formatInstructions:promptAsset("workflow-structured-output").instructions,
          ...(parent?.outputSchema && {previousOutputSchema:parent.outputSchema})}),
      };
      const guidance = await ask(domain + " implementer", grounding(implementer) +
        "\n" + promptAsset("workflow-implementer").instructions,
        implementerTask,
        structuredOutput ? objectSchema({...implementerSchema.properties,fields:plannerFieldsSchema,inputs:plannerInputsSchema}) : implementerSchema,
        structuredOutput ? 1050 : 650, result => {
          const outputSchema = structuredOutput ? schemaFromFields(result.fields) : undefined;
          const inputs = structuredOutput ? inputsFromTask(result.inputs,objective) : undefined;
          const generated=required(result?.prompt, "Implementer prompt", 1500);
          const withoutLabel=generated.replace(/^\s*(?:(?:business )?objective|business outcome)\s*:\s*/i,"");
          const repeatedObjective=withoutLabel.startsWith(objective) &&
            (!withoutLabel.slice(objective.length) || /[.!?]$/.test(objective) || /^[\s.:;–—-]/.test(withoutLabel.slice(objective.length)));
          const prompt=repeatedObjective ? withoutLabel.slice(objective.length).replace(/^[\s.:;–—-]+/,"").trim() : generated;
          if (repeatedObjective && !prompt) return {outputSchema,inputs,text:"",omitted:1,reasons:["repeated operator objective"],
            reason:"The implementer repeated the original objective. DASH kept it unchanged."};
          if (new Set(tokens(prompt)).size < 3) throw Error("the implementer returned an incomplete instruction");
          const sources=[implementer.instructions,promptAsset("workflow-implementer").instructions,promptAsset("workflow-implementer-assignment").instructions];
          const sentences=prompt.split(/(?<=[.!?])\s+|[;\r\n]+/).map(line=>line.trim()).filter(Boolean);
          const retained=sentences.filter(sentence=>!instructionEcho(sentence,sources) &&
            !/^(?:write .*sentences?\b|leave the decision to the candidate\b|(?:tell|ask) the candidate\b|the metrics belong to the evaluator\b)/i.test(sentence));
          if (!retained.length || (sentences.length!==retained.length && !retained.some(line=>
            [...measureTerms(objective)].some(word=>measureTerms(line).has(word))))) {
            return {outputSchema,inputs,text:"",omitted:sentences.length,reasons:["copied instructions for the implementer"],
              reason:"The implementer supplied no additional task-specific instruction. DASH kept the original objective."};
          }
          const reviewed=candidateGuidance(retained.join(" "), {objective,dataset,domain});
          if (repeatedObjective) {
            reviewed.omitted++;
            reviewed.reasons.push("repeated operator objective");
          }
          if (sentences.length!==retained.length) {
            reviewed.omitted+=sentences.length-retained.length;
            reviewed.reasons.push("copied instructions for the implementer");
          }
          const rawReason=typeof result.reason==="string" ? result.reason.trim() : "";
          const safeReason=rawReason && rawReason.length<=220 && !reviewed.omitted &&
            !/\b(?:improv\w*|guarantee\w*|boost\w*|increas\w*|reduc\w*|ensur\w*|saved|verified|proved)\b/i.test(rawReason) &&
            [...measureTerms(rawReason)].some(word=>measureTerms(reviewed.text).has(word)) && !instructionEcho(rawReason,sources);
          const reason=safeReason ? rawReason : reviewed.supplementSource ? "DASH retained the supported inspection instruction after checking the generated guidance against the task."
            : "The implementer added these case-level instructions to the operator’s objective.";
          return {outputSchema,inputs,...reviewed,reason};
        });
      const prompt=guidance.text ? objective + "\n\n" + guidance.text : objective;
      const draft:PromptDraft = {
        draftId:randomUUID(), mode:request.mode, objective, requestedMetrics, metrics, inputCap, outputCap,
        ...(guidance.outputSchema && {outputSchema:guidance.outputSchema,input:{task:prompt,inputs:guidance.inputs ?? {}}}),
        metricAudit,...(context.coverage && {auditCoverage:{...context.coverage}}),...(auditDesigner && {auditAgent:agentPin(auditor),auditDesigner}),promptRationale:{original:objective,addition:guidance.text,reason:guidance.reason},
        domain, domainSource, title:findings.title, requirements,
        prompt, criteriaReview:findings.criteriaReview ?? null, guidanceReview:{omitted:guidance.omitted,reasons:guidance.reasons,...(guidance.supplementSource && {supplementSource:guidance.supplementSource})}, parentId:parent?.id ?? null,
        datasetId:dataset?.datasetId ?? null, packId:dataset?.packId ?? null, contractHash:dataset?.contractHash ?? null, dataset,
        sourceRunId:brief.priorRun?.id ?? null, priorRun:brief.priorRun ?? null,
        suggestions:prior ? { domain, expertVersion:expert.version, designer:prior.designer, metrics:findings.metrics, criteria:findings.requirements } : null,
        agents:[expert, implementer].map(({domain,role,version,hash,sources,origin,bundle}) => ({domain,role,version,hash,sources,origin,bundle})),
        workflowAgents:[...(domainSource==="inferred"?["workflow-router"]:[]),"workflow-expert","workflow-expert-assignment",...(auditDesigner?["workflow-metric-auditor"]:[]),"workflow-implementer","workflow-implementer-assignment",...(structuredOutput?["workflow-structured-output"]:[])].map(id=>agentPin(promptAsset(id))),
        designer:route.designer, expertDesigner, planningAttempts:[...(prior?.planningAttempts ?? []), ...route.attempts],
        createdAt:new Date().toISOString(),
      };
      this.drafts.set(draft.draftId, draft);
      if (this.drafts.size > 64) this.drafts.delete(this.drafts.keys().next().value ?? '');
      return structuredClone(draft);
    } finally {
      this.controllers.delete(controller);
    }
  }
  approve(input:unknown):ApprovedPrompt {
    if (!isRecord(input)) throw Error('Invalid prompt approval.');
    const {draftId,prompt,metrics}=input;
    const draftKey = required(draftId, "Draft ID", 128);
    const approvedText = required(prompt, "Approved prompt");
    const approvedMetrics = metrics == null ? null : lines(metrics, "Approved metrics", 2000, 0);
    const approvedSchema=(proposed:QuickOutputSchema|undefined)=>{
      if (input.outputSchema === undefined) return proposed;
      if (!proposed) throw Error("Prepare a structured Quick compare draft before editing its output schema.");
      return decodeQuickOutputSchema(input.outputSchema);
    };
    const approvedInput=(proposed:QuickTaskInput|undefined)=>{
      if (!proposed && input.input===undefined) return undefined;
      if (!proposed) throw Error("Prepare a structured Quick compare draft before editing its JSON input.");
      return decodeQuickTaskInput(input.input===undefined ? {task:approvedText,inputs:proposed.inputs} : input.input,approvedText);
    };
    const approved = transaction(this.db, () => {
      const previous = this.db.prepare("SELECT spec,approval_hash FROM outcome_prompts WHERE draft=?").get(draftKey);
      if (previous) {
        const entry = decodeSaved(previous.spec);
        if (previous.approval_hash !== hash({ prompt:approvedText, metrics:approvedMetrics ?? entry.metrics, outputSchema:approvedSchema(entry.outputSchema), input:approvedInput(entry.input) }))
          throw Error("This draft was already approved with different edits. Create a revision to save your changes.");
        return entry;
      }
      const draft = this.drafts.get(draftKey);
      if (!draft) throw Error("This draft has expired. Prepare the prompt again before approval.");
      const parent = draft.parentId ? this.get(draft.parentId) : null;
      if (parent) {
        const latest = this.db.prepare("SELECT MAX(version) AS version FROM outcome_prompts WHERE family=?").get(parent.familyId);
        if (latest?.version !== parent.version) throw Error("A newer revision was approved. Start from the latest catalogue version.");
      }
      const id = randomUUID();
      const finalMetrics=approvedMetrics ?? draft.metrics;
      const outputSchema=approvedSchema(draft.outputSchema);
      const taskInput=approvedInput(draft.input);
      const {metricAudit,promptRationale,...record}=draft;
      const sameMetrics=JSON.stringify(finalMetrics)===JSON.stringify(draft.metrics);
      // Edited metrics may be reordered, renamed, or newly authored. Only carry a
      // prior criterion when the operator kept its exact reviewed metric.
      const reviewedCriteria=new Map(metricAudit?.filter(row=>row.status!=="external").map(row=>[row.metric,row.criterion]));
      const finalRequirements=sameMetrics ? draft.requirements : finalMetrics.flatMap(metric=>{
        const criterion=reviewedCriteria.get(metric);
        return criterion ? [criterion] : [];
      });
      const unchanged=approvedText===draft.prompt;
      const addition=approvedText.startsWith(draft.objective+"\n\n") ? approvedText.slice(draft.objective.length+2) : "";
      const finalRationale=unchanged ? promptRationale : addition ? {original:draft.objective,addition,reason:"The operator edited the added instructions before approval."} : undefined;
      const entry = {
        ...record,...(outputSchema && {outputSchema,input:taskInput}),...(finalRationale && {promptRationale:finalRationale}),
        ...(metricAudit && unchanged && sameMetrics && {metricAudit}), id, familyId:parent?.familyId ?? id, version:parent ? parent.version + 1 : 1,
        prompt:approvedText, metrics:finalMetrics, requirements:finalRequirements,
        metricCriteria:finalMetrics.flatMap(metric=>{
          const criterion=reviewedCriteria.get(metric);
          return criterion ? [{metric,criterion}] : [];
        }),
        approvedAt:new Date().toISOString(),
      };
      this.db.prepare("INSERT INTO outcome_prompts VALUES(?,?,?,?,?,?)")
        .run(id, entry.familyId, entry.version, draftKey, hash({ prompt:entry.prompt, metrics:entry.metrics, outputSchema:entry.outputSchema, input:entry.input }), JSON.stringify(entry));
      return entry;
    });
    this.drafts.delete(draftKey);
    return approved;
  }
}


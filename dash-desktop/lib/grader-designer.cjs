const { PlanningRoute } = require("./planner-routing.cjs");

function bounded(value, limit, label) {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw Error("Enter " + label + " (up to " + limit + " characters).");
  return value.trim();
}

function gradingBrief(bench, request) {
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
    .filter(k=>references.every(item=>item && Object.hasOwn(item,k)));
  return { objective, metrics, industry, target, criteria:approved?.requirements || [], referenceFields,
    outputFields:Object.keys(pack?.outputSchema?.properties || {}), existingScorer:pack?.kind==="reference"?null:pack?.scorer };
}

// A literal metric scores the same string on every case. Conditional instructions need a judge
// or a labeled reference so a response taking another valid branch can earn full credit.
function literalRules(brief) {
  const rules = {exact:[], contains:[]};
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

async function designGraderPlan(bench, request) {
  if (bench.active || bench.designing) throw Error("Wait for the current run or planning request to finish.");
  bench.designing = true;
  try {
    const brief = gradingBrief(bench, request);
    const literals = literalRules(brief);
    const methods = Object.keys(literals).filter(method => literals[method].length > 0);
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
    const prompt = "You design inference graders. Read the objective, success measures, approved criteria and available evidence. Select the smallest set of independent checks needed. Explain coverage and unmeasurable business outcomes in summary. A rate or aggregate KPI is not an individual response score. Do not duplicate the existing scenario scorer. Zero checks is valid when evidence is insufficient. A judge rubric needs observable full, partial and zero-credit anchors. For exact or contains, criteria is only a literal explicitly required by the objective. For field, criteria is a JSON string with outputField and referenceField using the supplied field names. For trajectory, list only explicitly required tool names in order, one per line. Use only measures listed in metrics. Give each observable measure one focused check unless two independent checks are essential. Approved criteria describe the domain expert guidance the operator accepted. Never introduce additional industry policies or requirements. Use judge for conditional instructions and for evidence expressed in natural language. For contains or exact select one of the allowed literals for that method. Use no invented reference values, policy thresholds, or tool names.";
    const result = await route.ask("Grader designer",prompt,{...brief,allowedLiterals:literals},schema,1600,output=>{
      const summary = bounded(output.summary,1500,"a coverage explanation");
      if (!Array.isArray(output.checks) || output.checks.length>8) throw Error("Propose up to eight graders.");
      const names = new Set();
      const checks = output.checks.map(item=>{
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
          const rule=JSON.parse(criteria);
          if (!brief.referenceFields.includes(rule.referenceField) || (brief.outputFields.length && !brief.outputFields.includes(rule.outputField))) throw Error("Use a field present in the dataset schema and reference.");
        }
        return {name,category:item.metric.slice(0,100),industry:brief.industry,
          type:method==="judge" ? "opik" : method,criteria,threshold:item.threshold,
          reason:bounded(item.reason,1200,"a rationale")};
      });
      return {summary,checks};
    });
    return {...result,designer:route.designer,industry:brief.industry};
  } finally { bench.designing=false; }
}

function confirmGraderPlan(bench, definitions) {
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
module.exports={designGraderPlan,confirmGraderPlan};

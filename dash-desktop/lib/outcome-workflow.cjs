const { randomUUID } = require("node:crypto");
const { hash } = require("./packs.cjs");
const { profiles } = require("./domain-profiles.cjs");
const { candidateGuidance, inspectionCheck } = require("./prompt-fidelity.cjs");
const { PlanningRoute, repetitive, tokens } = require("./planner-routing.cjs");

const domains = ["Financial Services", "Manufacturing", "General"];
const string = { type: "string" };
const strings = { type: "array", minItems: 1, maxItems: 3, items: { type: "string", maxLength: 180 } };
function objectSchema(properties) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
const routeSchema = objectSchema({ domain: { type: "string", enum: domains } });
const measureSchema = objectSchema({ requirements: strings, metrics: strings });
const expertSchema = objectSchema({ title: string, metrics: strings, requirements: strings });
const implementerSchema = objectSchema({ prompt: { type: "string", maxLength: 900 } });
const expertEvaluationInstructions = [
  "Your task is to design an evaluator. Inspect what the ANSWER does, never inventory what happens to appear in an input document. The operator's objective controls the scope.",
  "For each explicitly requested action, write a single-case pass test under requirements. State what in the candidate answer must match what in the supplied case. Then write the corresponding cross-case metric under metrics in the same order. Each metric measures correct decisions, errors, or coverage of its pass test.",
  "For an extraction, compare the answer value to the case evidence. For a citation, verify that its source supports the answer. For a requested exception, count correct referrals among cases containing that exception. Apply only the relevant checks and name the specific business field or exception requested.",
  "Use specific terms from this operator's goal. Match each metric to its requirement. Use only supplied case material and the user's measures. External filings, conversions, targets and other domain-profile examples apply only if the operator asks for them. All quantities are proposed checks for a future run.",
].join("\n");


function required(value, name, max = 24000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw Error(name + " must be text between 1 and " + max + " characters.");
  return value.trim();
}
function optional(value, name, max) {
  return value == null || value === "" ? "" : required(value, name, max);
}
function lines(value, label, maxLength = 1000, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 8)
    throw Error(label + " must contain between " + minimum + " and eight entries.");
  return [...new Set(value.map(x => required(x, label, maxLength)))];
}
function cap(value, name) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000000)
    throw Error(name + " must be a whole number between 1 and 1,000,000 tokens.");
  return value;
}
function contractHash(pack) {
  return hash({ id:pack.id, system:pack.system, outputSchema:pack.outputSchema, metrics:pack.metrics });
}
function datasetContext(request, context) {
  if (request.mode === "quick") {
    if (request.datasetId) throw Error("Use a dataset run to attach a dataset.");
    return null;
  }
  const id = required(request.datasetId, "Dataset snapshot", 256);
  const pack = context?.pack;
  if (!pack || context.datasetId !== id) throw Error("Select a current dataset snapshot before drafting.");
  return {
    datasetId:id, packId:pack.id, contractHash:contractHash(pack), title:pack.title,
    description:pack.description, system:pack.system, outputSchema:pack.outputSchema, metrics:pack.metrics,
    industry:context.industry ?? null, version:context.version ?? null, split:context.split ?? null,
  };
}
function configuredRole(profile, version, instructions) {
  const spec = { domain:profile.domain, role:profile.role, instructions, sources:profile.sources };
  return { ...spec, version, hash:hash(spec) };
}
function titleFor(raw, objective) {
  if (typeof raw === "string" && raw.trim() && raw.length <= 180 && !repetitive(raw)) return raw.trim();
  const sentence = objective.replace(/\s+/g, " ").trim();
  return sentence.length <= 96 ? sentence : sentence.slice(0, 95).trimEnd() + "…";
}
function measureLines(value, label) {
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
function measureTerms(text) {
  return new Set(tokens(text).filter(t => t.length > 2 && !commonMeasureWords.has(t)).map(t => t.replace(/s$/, "")));
}
function evaluationMeasures(result, objective, requestedMetrics, domain, dataset) {
  const original = measureLines(result?.requirements ?? result?.criteria, "Expert criteria");
  const criteria = [], omissions = [];
  for (const criterion of original) {
    try {
      const check = candidateGuidance(criterion,{objective,dataset,expert:true});
      if (check.omitted) omissions.push(...check.reasons);
      else criteria.push(check.text);
    } catch { omissions.push("an unsupported case rule"); }
  }
  let supplementSource;
  if (!criteria.length) {
    const supplement = inspectionCheck(domain,objective,dataset);
    if (!supplement) throw Error("the expert introduced an unsupported case rule; base the pass checks only on the stated objective");
    criteria.push(supplement.criterion);
    supplementSource = supplement.source;
  }
  const proposed = measureLines(result?.metrics, "Expert metrics");
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
    return "Pass rate among applicable cases · " + criterion;
  });
  return { title:titleFor(result?.title, objective), metrics, requirements:criteria, ...(omissions.length && {criteriaReview:{omitted:original.length-(supplementSource ? 0 : criteria.length),reasons:[...new Set(omissions)],supplementSource}}) };
}
function metricList(typed, suggested) {
  return [...new Set([...(typed ? [typed] : []), ...suggested])].slice(0, 8);
}
function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

class OutcomeWorkflow {
  constructor(db, adapters, planning = {}) {
    this.db = db;
    this.adapters = adapters;
    this.planning = planning;
    this.drafts = new Map();
    this.suggestions = new Map();
    this.controllers = new Set();
    db.exec([
      "CREATE TABLE IF NOT EXISTS outcome_agent_roles(domain TEXT NOT NULL, role TEXT NOT NULL, version INTEGER NOT NULL, spec TEXT NOT NULL, PRIMARY KEY(domain, role, version))",
      "CREATE TABLE IF NOT EXISTS outcome_prompts(id TEXT PRIMARY KEY, family TEXT NOT NULL, version INTEGER NOT NULL, draft TEXT UNIQUE NOT NULL, approval_hash TEXT NOT NULL, spec TEXT NOT NULL, UNIQUE(family, version))",
    ].join(";"));
    const seed = db.prepare("INSERT OR IGNORE INTO outcome_agent_roles(domain,role,version,spec) VALUES(?,?,1,?)");
    for (const profile of profiles)
      seed.run(profile.domain, profile.role, JSON.stringify(configuredRole(profile, 1, profile.instructions)));
  }
  roles() {
    return this.db.prepare("SELECT a.spec FROM outcome_agent_roles a JOIN (SELECT domain,role,MAX(version) AS version FROM outcome_agent_roles GROUP BY domain,role) b USING(domain,role,version) ORDER BY domain,role")
      .all().map(row => JSON.parse(row.spec));
  }
  saveRole({ domain, role, instructions, expectedVersion }) {
    const profile = profiles.find(p => p.domain === domain && p.role === role);
    if (!profile) throw Error("Choose an existing domain agent.");
    const updated = required(instructions, "Agent instructions", 12000);
    return transaction(this.db, () => {
      const row = this.db.prepare("SELECT spec FROM outcome_agent_roles WHERE domain=? AND role=? ORDER BY version DESC LIMIT 1").get(domain, role);
      const current = JSON.parse(row.spec);
      if (current.version !== expectedVersion) throw Error("This agent changed. Refresh its instructions before saving.");
      if (current.instructions === updated) return current;
      const next = configuredRole(current, current.version + 1, updated);
      this.db.prepare("INSERT INTO outcome_agent_roles VALUES(?,?,?,?)").run(domain, role, next.version, JSON.stringify(next));
      return next;
    });
  }
  get(id) {
    const row = typeof id === "string" && this.db.prepare("SELECT spec FROM outcome_prompts WHERE id=?").get(id);
    if (!row) throw Error("This approved prompt could not be found. Refresh the prompt catalogue.");
    return JSON.parse(row.spec);
  }
  list() {
    return this.db.prepare("SELECT spec FROM outcome_prompts ORDER BY rowid DESC").all().map(row => JSON.parse(row.spec));
  }
  history(id) {
    const { familyId } = this.get(id);
    return this.db.prepare("SELECT spec FROM outcome_prompts WHERE family=? ORDER BY version").all(familyId).map(row => JSON.parse(row.spec));
  }
  cancel() {
    for (const controller of this.controllers) controller.abort();
  }
  async design(request, context = {}, purpose = "draft") {
    if (!request || !["quick", "dataset"].includes(request.mode)) throw Error("Choose Quick compare or Dataset run.");
    const objective = required(request.objective, "Business outcome", 12000);
    const requestedMetrics = optional(request.metrics, "Business metrics", 2000);
    const inputCap = cap(request.inputCap, "Input budget");
    const outputCap = cap(request.outputCap, "Output budget");
    const dataset = datasetContext(request, context);
    const selectedDomain = optional(request.domain, "Planning domain", 100);
    const manual = selectedDomain && selectedDomain.toLowerCase() !== "auto" ? selectedDomain : null;
    if (manual && !domains.includes(manual)) throw Error("Choose Financial Services, Manufacturing or General.");
    const pinned = domains.includes(dataset?.industry) ? dataset.industry : null;
    if (pinned && manual && manual !== pinned) throw Error("Use the domain assigned to this dataset snapshot.");
    const parent = request.parentId ? this.get(request.parentId) : null;
    if (parent && (parent.mode !== request.mode || parent.datasetId !== (dataset?.datasetId ?? null)))
      throw Error("Revise this prompt with its original run type and dataset snapshot.");
    const scope = hash([request.mode, objective, manual, dataset?.datasetId, dataset?.contractHash, parent?.id, context.priorRun?.id]);
    const prior = request.suggestionId && this.suggestions.get(request.suggestionId);
    if (request.suggestionId && prior?.scope !== scope)
      throw Error("The objective or scenario changed, or the suggestions expired. Choose Suggest Metrics again.");
    const choices = request.measures == null ? null : {
      metrics: lines(request.measures.metrics, "Selected metrics", 2000, 0),
      criteria: lines(request.measures.criteria, "Success criteria", 2000, 0),
    };
    // Snapshot IDs, versions and splits describe the catalogue. They are never case evidence.
    const publicTask = dataset && {
      title:dataset.title, description:dataset.description, system:dataset.system,
      outputSchema:dataset.outputSchema, metrics:dataset.metrics,
    };
    if (publicTask?.metrics?.length === 3) {
      const [ready, incorrect, review] = publicTask.metrics;
      publicTask.scoringDefinitions = {
        [ready]: "Count of candidate proposals to accept or auto-route that pass the scenario grader.",
        [incorrect]: "Count of candidate proposals to accept or auto-route that fail the scenario grader.",
        [review]: "Fraction of scored responses that either require review or fail the grader.",
      };
    }
    const brief = { mode:request.mode, objective, requestedMetrics, inputCap, outputCap, dataset:publicTask };
    if (choices) {
      brief.requestedMetrics = choices.metrics.join("\n");
      brief.successCriteria = choices.criteria;
    }
    if (parent) brief.previousApproved = { prompt:parent.prompt, metrics:parent.metrics };
    if (parent && context.priorRun) brief.priorRun = context.priorRun;

    // Snapshot each role before starting asynchronous inference. An admin edit takes effect on the next draft.
    const configs = this.roles();
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const route = await PlanningRoute.start(this.adapters, this.planning, controller.signal,
        event => context.onStage?.({ mode:request.mode, ...event }));
      const ask = (...args) => route.ask(...args);

      let domain = prior?.domain || pinned || manual;
      const domainSource = prior?.domainSource || (pinned ? "dataset" : manual ? "user" : "inferred");
      if (!domain) {
        domain = await ask("Domain routing",
          "Select the domain that best fits the outcome and its task context. Use General for unsupported industries or ambiguous work. Do not perform the task.",
          { objective, requestedMetrics, scenario:dataset?.title ?? null, datasetIndustry:dataset?.industry ?? null }, routeSchema, 48, result => {
            if (!domains.includes(result?.domain)) throw Error("the router returned an unknown domain");
            return result.domain;
          });
      }
      const agents = configs.filter(c => c.domain === domain);
      const expert = prior?.expert ?? agents.find(c => c.role === "expert");
      const implementer = agents.find(c => c.role === "implementer");
      const grounding = role => role.instructions + "\nReference material behind this profile: " + JSON.stringify(role.sources);
      const findings = prior?.findings ?? await ask(domain + " expert", grounding(expert) +
        "\n" + expertEvaluationInstructions +
        (purpose === "suggest" ? "\nReturn only the metrics and requirements arrays." : "\nGive the brief a short title."),
        { ...brief, assignment:"Grade only these requested actions: " + objective +
          ". Return matching pass tests and answer-quality metrics. Skip background details and unrequested procedures." },
        purpose === "suggest" ? measureSchema : expertSchema, 550, result => evaluationMeasures(result, objective, requestedMetrics, domain, dataset));
      const expertDesigner = prior?.designer ?? route.designer;
      if (purpose === "suggest") {
        const id = randomUUID();
        this.suggestions.set(id, { scope, domain, domainSource, expert, designer:expertDesigner, findings, planningAttempts:route.attempts });
        if (this.suggestions.size > 64) this.suggestions.delete(this.suggestions.keys().next().value);
        return structuredClone({ id, domain, expertVersion:expert.version, model:expertDesigner.model, designer:expertDesigner, planningAttempts:route.attempts,
          metrics:findings.metrics, criteria:findings.requirements, criteriaReview:findings.criteriaReview });
      }
      const metrics = choices ? choices.metrics : metricList(requestedMetrics, findings.metrics);
      const requirements = choices ? choices.criteria : findings.requirements;
      const expertBrief = { title:findings.title, metrics: choices ? metrics : findings.metrics, requirements };
      const guidance = await ask(domain + " implementer", grounding(implementer) +
        "\nWrite three to six short sentences of executable instructions addressed to the evaluated model. The original business outcome is included verbatim by DASH, so do not repeat the objective or its input material. Specify observable requirements, evidence and handling of missing input where relevant. Use the selected metrics and success criteria to shape the instructions. Leave aggregate scoring to the evaluator. Respect both optional token budgets. If a prior run contains a tokenConstraint or truncatedOutputs, reduce repetition and request a concise answer that fits the indicated budget. Preserve the objective, source material and required fields. For a dataset, the case input and protected response contract will be supplied at dispatch. Refer to case-specific fields by their meaning and leave their values to each case. Do not repeat the schema or its field list, change the grader, add an answer, invent facts, use placeholder syntax or manufacture a case. Return the instructions in prompt.",
        { ...brief, expertBrief, metrics, assignment:"Write two standalone sentences. In the first, tell the candidate where to find the requested field in the supplied case. In the second, ask it to explain its decision using the supplied evidence. Leave the decision to the candidate. Use only the values, units and decision rules explicitly given in the case or task. Refer to them by meaning without restating their numbers. Never invent a tolerance or assume customary practice. The metrics belong to the evaluator; omit cross-case counts and rates. Ask for review if a necessary rule is absent." },
        implementerSchema, 650, result => {
          const prompt = required(result?.prompt, "Implementer prompt", 1500);
          if (new Set(tokens(prompt)).size < 3) throw Error("the implementer returned an incomplete instruction");
          return candidateGuidance(prompt, {objective,dataset,domain});
        });
      const draft = {
        draftId:randomUUID(), mode:request.mode, objective, requestedMetrics, metrics, inputCap, outputCap,
        domain, domainSource, title:findings.title, requirements,
        prompt:objective + "\n\n" + guidance.text, criteriaReview:findings.criteriaReview ?? null, guidanceReview:{omitted:guidance.omitted,reasons:guidance.reasons,...(guidance.supplementSource && {supplementSource:guidance.supplementSource})}, parentId:parent?.id ?? null,
        datasetId:dataset?.datasetId ?? null, packId:dataset?.packId ?? null, contractHash:dataset?.contractHash ?? null, dataset,
        sourceRunId:brief.priorRun?.id ?? null, priorRun:brief.priorRun ?? null,
        suggestions:prior ? { domain, expertVersion:expert.version, designer:prior.designer, metrics:findings.metrics, criteria:findings.requirements } : null,
        agents:[expert, implementer].map(({domain,role,version,hash,sources}) => ({domain,role,version,hash,sources})),
        designer:route.designer, expertDesigner, planningAttempts:[...(prior?.planningAttempts ?? []), ...route.attempts],
        createdAt:new Date().toISOString(),
      };
      this.drafts.set(draft.draftId, draft);
      if (this.drafts.size > 64) this.drafts.delete(this.drafts.keys().next().value);
      return structuredClone(draft);
    } finally {
      this.controllers.delete(controller);
    }
  }
  approve({ draftId, prompt, metrics }) {
    const draftKey = required(draftId, "Draft ID", 128);
    const approvedText = required(prompt, "Approved prompt");
    const approvedMetrics = metrics == null ? null : lines(metrics, "Approved metrics", 2000, 0);
    const approved = transaction(this.db, () => {
      const previous = this.db.prepare("SELECT spec,approval_hash FROM outcome_prompts WHERE draft=?").get(draftKey);
      if (previous) {
        const entry = JSON.parse(previous.spec);
        if (previous.approval_hash !== hash({ prompt:approvedText, metrics:approvedMetrics ?? entry.metrics }))
          throw Error("This draft was already approved with different edits. Create a revision to save your changes.");
        return entry;
      }
      const draft = this.drafts.get(draftKey);
      if (!draft) throw Error("This draft has expired. Prepare the prompt again before approval.");
      const parent = draft.parentId ? this.get(draft.parentId) : null;
      if (parent) {
        const latest = this.db.prepare("SELECT MAX(version) AS version FROM outcome_prompts WHERE family=?").get(parent.familyId);
        if (latest.version !== parent.version) throw Error("A newer revision was approved. Start from the latest catalogue version.");
      }
      const id = randomUUID();
      const entry = {
        ...draft, id, familyId:parent?.familyId ?? id, version:parent ? parent.version + 1 : 1,
        prompt:approvedText, metrics:approvedMetrics ?? draft.metrics,
        approvedAt:new Date().toISOString(),
      };
      this.db.prepare("INSERT INTO outcome_prompts VALUES(?,?,?,?,?,?)")
        .run(id, entry.familyId, entry.version, draftKey, hash({ prompt:entry.prompt, metrics:entry.metrics }), JSON.stringify(entry));
      return entry;
    });
    this.drafts.delete(draftKey);
    return approved;
  }
}
module.exports = { OutcomeWorkflow, contractHash };

const { DatabaseSync } = require("node:sqlite");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const os = require("node:os");
const { loadPacks, parseDataset, grade, hash } = require("./packs.cjs");
const { Catalog } = require("./catalog.cjs");
const providers = require("./providers.cjs");
const { OutcomeWorkflow, contractHash } = require("./outcome-workflow.cjs");
const replayCandidate = {
  id: "fixture/replay-v1",
  kind: "fixture",
  provider: "fixture",
  model: "Fixture replay",
  revision: "v1",
};
const now = () => new Date().toISOString();
const scorerDigest = hash(readFileSync(require.resolve("./packs.cjs"), "utf8"));
const systemPrompt = (pack) =>
  pack.system +
  "\nOutput schema: " +
  JSON.stringify(pack.outputSchema) +
  "\nReturn only the raw JSON object. Start with { and end with }. Omit Markdown code fences, labels, comments and surrounding prose.";

const { referencePack, caseMessages: candidateMessages, graderEvidence, exactReference } = require("./evaluation-cases.cjs");

class Bench {
  constructor(file, adapters = providers, powerSampler = require("./power.cjs").startPower) {
    this.powerSampler = powerSampler;
    this.adapters = adapters;
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, created TEXT, status TEXT, manifest TEXT); CREATE TABLE IF NOT EXISTS results(run TEXT,candidate TEXT,case_id TEXT,record TEXT,PRIMARY KEY(run,candidate,case_id)); CREATE TABLE IF NOT EXISTS datasets(id TEXT PRIMARY KEY,pack TEXT,name TEXT,rows TEXT); UPDATE runs SET status='interrupted' WHERE status IN ('running','queued');",
    );
    this.reports = new (require("./run-report.cjs").RunReports)(this.db);
    this.packs = loadPacks();
    for (const { pack, rows } of this.packs)
      this.saveDataset(pack.id, pack.dataset, rows);
    this.packs.push({pack:referencePack, rows:[], replay:{}});
    this.graders = new (require("./graders.cjs").Graders)(this.db);
    this.endpoints = new (require("./endpoints.cjs").Endpoints)(this.db);
    this.catalog = new Catalog(this.db, this.packs);
    this.plannerSettings = new (require("./planner-settings.cjs").PlannerSettings)(this.db,this.endpoints);
    this.workflow = new OutcomeWorkflow(this.db, adapters, {openaiFallback:()=>this.plannerSettings.fallback()});
    this.designing = false;
    this.servers = [];
    this.active = null;
  }
  saveDataset(pack, name, rows) {
    const id = pack + "-" + hash(rows);
    this.db
      .prepare("INSERT OR IGNORE INTO datasets VALUES(?,?,?,?)")
      .run(id, pack, name, JSON.stringify(rows));
    return id;
  }
  pack(id) {
    const p = this.packs.find((x) => x.pack.id === id);
    if (!p) throw Error("Unknown scenario");
    return p;
  }
  previewImport(packId, text) {
    return parseDataset(text, this.pack(packId).pack);
  }
  import(packId, name, text, meta) {
    return this.importRows(packId, name, this.previewImport(packId, text), meta);
  }
  importRows(packId, name, rows, meta) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const id = this.saveDataset(packId, name, rows);
      this.catalog.register(id, packId, rows[0], meta ?? {
        family: name, category: "Uncategorized", source: name
      }, meta ? "import" : "legacy");
      this.db.exec("COMMIT");
      return id;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  dataset(id) {
    const d = this.db.prepare("SELECT * FROM datasets WHERE id=?").get(id);
    if (!d) throw Error("Unknown dataset snapshot");
    return { ...d, metadata: this.catalog.get(id), rows: JSON.parse(d.rows) };
  }
  async designPrompt(request, onStage, purpose = "draft") {
    if (this.active || this.designing) throw Error("Wait for the current run or prompt preparation to finish.");
    this.designing = true;
    try {
      let context = {};
      if (request?.mode === "dataset") {
        const snapshot = this.dataset(request.datasetId);
        const { id, title, description, system, outputSchema, metrics } = this.pack(snapshot.pack).pack;
        context = {
          datasetId: snapshot.id, industry: snapshot.metadata.industry,
          version: snapshot.rows[0].dataset_version, split: snapshot.rows[0].split,
          pack: { id, title, description, system, outputSchema, metrics },
        };
      }
      if (request?.sourceRunId)
        context.priorRun = this.refinementEvidence(request.sourceRunId, request.parentId);
      return await this.workflow.design(request, { ...context, onStage }, purpose);
    } finally {
      this.designing = false;
    }
  }
  refinementEvidence(id, approvedPromptId) {
    const saved = this.db.prepare("SELECT status,manifest FROM runs WHERE id=?").get(id);
    if (!saved || !approvedPromptId || JSON.parse(saved.manifest).approvedPromptId !== approvedPromptId)
      throw Error("Choose a saved run of the prompt revision you want to refine.");
    if (["running", "queued"].includes(saved.status)) throw Error("Wait for this run to finish before refining it.");
    // Only aggregated observations go back into the planner. Case inputs, reference
    // answers, candidate text and judge rationales stay in the run record.
    const candidates = this.db.prepare(`SELECT candidate, COUNT(*) AS responses,
      SUM(json_extract(record,'$.error') IS NOT NULL) AS errors,
      COUNT(json_extract(record,'$.score.pass')) AS scored,
      SUM(json_extract(record,'$.score.pass')) AS passed,
      SUM(json_extract(record,'$.score.falseAccept')) AS falseAccepts,
      SUM(json_extract(record,'$.score.review')) AS sentForReview
      FROM results WHERE run=? GROUP BY candidate`).all(id);
    const graders = this.db.prepare(`SELECT candidate, json_extract(record,'$.name') AS grader,
      json_extract(record,'$.version') AS version, COUNT(json_extract(record,'$.pass')) AS scored,
      SUM(json_extract(record,'$.pass')) AS passed
      FROM assessments WHERE run=? GROUP BY candidate,json_extract(record,'$.graderId')`).all(id);
    const failure = JSON.parse(saved.manifest).guardrailFailure;
    const stopped = this.db.prepare("SELECT candidate, max(json_extract(record,'$.telemetry.output_tokens')) AS tokens FROM results WHERE run=? AND json_extract(record,'$.finishReason')='length' GROUP BY candidate").all(id);
    const constraint = failure ? {
      candidate:failure.candidateId,inputTokens:failure.inputTokens,contextTokens:failure.contextTokens,
      inputCap:failure.requestedInputCap, outputCap:failure.requestedOutputCap,
    } : null;
    return { id, status: saved.status, candidates, graders, ...(constraint && {tokenConstraint:constraint}), ...(stopped.length && {truncatedOutputs:stopped}) };
  }
  quickGraderOptions(approvedPromptId) {
    return this.graders.quickOptions(this.workflow.get(approvedPromptId), this.servers.flatMap(s => s.models));
  }
  async previewQuickBudget(approvedPromptId, candidateIds) {
    if (!Array.isArray(candidateIds) || candidateIds.length > 2 || new Set(candidateIds).size !== candidateIds.length)
      throw Error("Choose up to two distinct models.");
    const approved = this.workflow.get(approvedPromptId);
    if (approved.mode !== "quick") throw Error("Choose a Quick compare prompt.");
    const available = [...this.servers.flatMap(s=>s.models), ...this.endpoints.list()];
    const signal = AbortSignal.timeout(20000);
    return Promise.all(candidateIds.map(async candidateId=>{
      const candidate=available.find(c=>c.id===candidateId);
      if (!candidate) return {candidateId,status:"blocked",message:"This model is unavailable. Refresh the starting line."};
      try {
        const {guardrail}=await require("./guardrail.cjs").assessCase({
          candidate,mode:"quick",messages:candidateMessages({prompt:approved.prompt},{}),budget:approved,
          defaultOutput:providers.settings.maxTokens,checkInputBudget:this.adapters.checkInputBudget,signal,
        });
        return {candidateId,...guardrail};
      } catch (err) {
        return {candidateId,...(err.guardrail || {status:"unverified",message:"The token preview could not finish. DASH will check again at dispatch."})};
      }
    }));
  }
  async refresh() {
    this.servers = await this.adapters.discover();
    return this.servers;
  }
  list() {
    const datasets = this.db
      .prepare(
        "SELECT d.id,d.pack,d.name,json_array_length(d.rows) AS count, CASE WHEN d.pack='reference' THEN (SELECT COUNT(*) FROM json_each(d.rows) item WHERE json_extract(item.value,'$.reference') IS NULL AND json_extract(item.value,'$.rubric') IS NULL) ELSE 0 END AS casesWithoutReference,c.version,c.split,c.metadata,c.origin FROM datasets d JOIN dataset_catalog c ON c.dataset_id=d.id ORDER BY d.rowid",
      )
      .all();
    const runs = this.db
      .prepare(
        "SELECT id,created,status,json_extract(manifest,'$.title') AS title,json_extract(manifest,'$.mode') AS mode,json_extract(manifest,'$.fixture') AS fixture,json_extract(manifest,'$.industry') AS industry,json_extract(manifest,'$.datasetId') AS datasetId FROM runs ORDER BY created DESC",
      )
      .all();
    return {
      packs: this.packs.map((p) => p.pack),
      datasets: datasets.map(d => ({ ...d, metadata: JSON.parse(d.metadata) })),
      runs,
      prompts: this.workflow.list(),
      domainRoles: this.workflow.roles(),
      plannerFallback: this.plannerSettings.status(),
      servers: this.servers,
      endpoints: this.endpoints.list(),
      graders: this.graders.list(),
      opikReady: require('./graders.cjs').sdkEnabled(),
      active: this.active?.id ?? null,
      device: os.platform() + " / " + os.arch(),
      fixtureId: replayCandidate.id,
    };
  }
  start({
    mode,
    datasetId,
    candidateIds,
    approvedPromptId,
    datasetScorer,
    caseJudgeId,
    inputCap,
    outputCap,
    caseId,
    parentId,
    graderIds = [],
    outcomeRubric,
    animation = true,
  }) {
    if (this.designing) throw Error("Wait for the prompt preparation to finish.");
    if (this.active)
      throw Error("A job is active. Stop it or wait for completion.");
    if (
      !["quick", "dataset"].includes(mode) ||
      !Array.isArray(candidateIds) ||
      candidateIds.length < 1 ||
      candidateIds.length > 2 ||
      (mode === "quick" && candidateIds.length !== 2) ||
      new Set(candidateIds).size !== candidateIds.length
    )
      throw Error(mode === "quick" ? "Choose two different models for the starting line." : "Select one or two distinct candidates.");
    const all = [...this.servers.flatMap((s) => s.models), ...this.endpoints.list(), replayCandidate];
    const candidates = candidateIds.map((id) => {
      const c = all.find((x) => x.id === id);
      if (!c)
        throw Error("Refresh local runtimes and select an available model.");
      if (c.needsKey) throw Error("Enter the session key for " + c.model + " before starting.");
      return c;
    });
    const fixture = candidateIds.includes(replayCandidate.id);
    if (fixture && (mode !== "dataset" || candidates.length !== 1))
      throw Error("Fixture replay requires a separate dataset run.");
    let original = null;
    if (parentId) {
      original = this.detail(parentId).manifest;
      if (mode !== "dataset" || original.mode !== mode || original.datasetId !== datasetId ||
          !caseId || !original.caseIds.includes(caseId) || original.fixture !== fixture ||
          !candidateIds.every(id => original.candidates.some(candidate => candidate.id === id)))
        throw Error("Rerun a saved case using its original dataset and candidate.");
      if (approvedPromptId && approvedPromptId !== original.approvedPromptId)
        throw Error("A case rerun uses its original approved prompt.");
      approvedPromptId = original.approvedPromptId;
    }
    if (fixture && approvedPromptId) throw Error("A recorded replay uses its original saved responses.");
    if (mode === "quick" && !approvedPromptId && !original)
      throw Error("Approve a prompt before choosing models and starting the run.");
    const approved = approvedPromptId ? this.workflow.get(approvedPromptId) : null;
    if (approved && (approved.mode !== mode || approved.datasetId !== (datasetId || null)))
      throw Error("This prompt revision belongs to a different run type or dataset snapshot.");
    const prompt = approved?.prompt;
    let rows,
      pack = null,
      replay = {},
      dataset = null;
    if (mode === "dataset") {
      dataset = this.dataset(datasetId);
      const bundle = this.pack(dataset.pack);
      pack = original?.pack ?? bundle.pack;
      if (approved && (approved.packId !== pack.id || approved.contractHash !== contractHash(pack)))
        throw Error("The scenario contract has changed. Prepare and approve a prompt for this version.");
      if (pack.kind === "reference" && approved) throw Error("This dataset supplies each case prompt directly.");
      replay = bundle.replay;
      if (fixture && datasetId !== pack.id + "-" + hash(bundle.rows))
        throw Error(
          "Fixture replay is available for the bundled dataset only.",
        );
      rows = caseId
        ? dataset.rows.filter((r) => r.case_id === caseId)
        : dataset.rows;
      if (!rows.length) throw Error("Unknown case.");
    } else {
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 24000)
        throw Error("Enter a prompt up to 24,000 characters.");
      rows = [{ case_id: "prompt", input: { text: prompt } }];
    }
    const pinnedGraders = original?.graders ?? this.graders.select(graderIds);
    if (pack?.kind === "reference") {
      datasetScorer = original?.datasetScorer ?? datasetScorer ?? "selected-graders";
      if (!["selected-graders","exact-reference"].includes(datasetScorer)) throw Error("Choose a reference scoring method.");
      if (datasetScorer === "exact-reference" && rows.some(r=>r.reference == null || r.rubric))
        throw Error("Exact matching requires a reference on every case and no case rubric. Choose a rubric judge instead.");
      const selected = pinnedGraders;
      if (caseJudgeId && !original) {
        if (rows.some(row=>row.reference == null && !row.rubric)) throw Error("Some cases supply only an input. Choose a saved grader with its own success criteria.");
        if (datasetScorer !== "selected-graders") throw Error("Choose reference and rubric scoring to use a case judge.");
        const judge=this.servers.flatMap(s=>s.models).find(m=>m.id===caseJudgeId);
        selected.push(require("./evaluation-cases.cjs").caseJudgeSpec(judge));
      }
      if (datasetScorer === "selected-graders" && !selected.length) throw Error("Choose a grader to evaluate the saved case responses.");
      if (rows.some(r=>r.rubric) && !selected.some(g=>["judge","opik"].includes(g.type)))
        throw Error("Choose a local LLM or Opik judge to evaluate the case-level rubrics.");
    } else datasetScorer = pack ? "scenario" : null;
    const caps = original?.tokenBudget ?? (approved || {inputCap,outputCap});
    for (const cap of [caps.inputCap, caps.outputCap]) {
      if (cap != null && (!Number.isSafeInteger(cap) || cap < 1 || cap > 1000000)) throw Error("Token limits must be whole numbers from 1 to 1,000,000.");
    }
    const effectiveSystem = pack && pack.kind !== "reference" ? (approved ? approved.prompt +
      "\n\nRequired scenario instructions and output format (apply to every case):\n" : "") + systemPrompt(pack) : null;
    const id = randomUUID();
    const manifest = {
      format: 2,
      id,
      created: now(),
      mode,
      fixture,
      graders: pinnedGraders,
      title: pack?.kind==="reference" ? dataset.metadata.family : pack?.title || approved?.title || "Quick compare",
      approvedPromptId: approved?.id ?? null,
      approvedPrompt: approved,
      objective: approved?.objective ?? pack?.description ?? null,
      effectiveSystem,
      datasetScorer,
      promptSource: fixture ? "recorded" : approved ? "approved-variant" : "dataset",
      tokenBudget: { inputCap: caps.inputCap ?? null, outputCap: caps.outputCap ?? null },
      pack,
      datasetId: dataset?.id ?? null,
      industry: dataset?.metadata?.industry ?? approved?.domain ?? null,
      datasetMetadata: dataset?.metadata ?? null,
      datasetVersion: rows[0].dataset_version ?? null,
      split: rows[0].split ?? null,
      caseIds: rows.map((r) => r.case_id),
      candidates,
      policyHash: pack ? hash([pack, scorerDigest, datasetScorer, pinnedGraders.map(g=>g.id)]) : null,
      promptHash: hash(pack ? [effectiveSystem, rows.map(r=>candidateMessages({pack,effectiveSystem},r))] : prompt),
      caseSetHash: hash(rows),
      prompt: mode === "quick" ? prompt : null,
      invocations: candidates.map((c) => ({
        candidateId: c.id,
        adapter:
          c.provider === "lmstudio" && c.loaded && this.adapters.checkInputBudget
            ? "LM Studio SDK · verified model template"
            : c.provider === "lmstudio" && mode === "dataset" && c.nativeChat
            ? "LM Studio native chat"
            : c.provider === "lmstudio"
              ? "LM Studio chat completions"
              : c.provider,
        template: fixture ? null : "Runtime model chat template",
        reasoning: require("./guardrail.cjs").reasoningPolicy(c, {
          mode, outputCap: caps.outputCap, structured: pack?.outputSchema, verifiedAdapter: !!this.adapters.checkInputBudget,
        }),
      })),
      outputPolicy: fixture ? null : {mode:caps.outputCap == null ? "automatic" : "explicit", automaticTarget:require("./guardrail.cjs").autoOutputTarget, providerFallback:providers.settings.maxTokens},
      parameters: fixture ? {} : { ...providers.settings, maxTokens: caps.outputCap ?? original?.parameters?.maxTokens ?? providers.settings.maxTokens },
      device: {
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
      },
      animation: !!animation,
      replayHash: fixture ? hash(replay) : null,
      parentId: parentId || null,
    };
    const insertRun = () => this.db.prepare("INSERT INTO runs VALUES(?,?,?,?)")
      .run(id, manifest.created, "queued", JSON.stringify(manifest));
    if (mode === "quick") {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        manifest.graders = this.graders.resolveQuick(approved, manifest.graders, outcomeRubric, this.servers.flatMap(s => s.models));
        insertRun();
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } else {
      insertRun();
    }
    const job = { id, controller: new AbortController(), partial: null };
    this.active = job;
    job.done = new Promise((resolve) => setImmediate(resolve)).then(() =>
      this.execute(job, manifest, rows, replay),
    );
    return id;
  }
  async execute(job, m, rows, replay) {
    const signal = job.controller.signal;
    const status = (value) =>
      this.db.prepare("UPDATE runs SET status=? WHERE id=?").run(value, m.id);
    let errors = 0;
    try {
      status("running");
      // Complete all lane/case checks before generating the first candidate response.
      const { assessCase, lengthFailure } = require("./guardrail.cjs");
      const decisions = new Map();
      if (!m.fixture) {
        for (const candidate of m.candidates) {
          const cases = new Map();
          decisions.set(candidate.id, cases);
          for (const row of rows) {
            signal.throwIfAborted();
            try {
              const decision = await assessCase({
                candidate, messages: candidateMessages(m, row), serializedCaseInput: !!m.pack && m.pack.kind !== "reference" && !row.prompt && !row.messages,
                mode: m.mode, structured: m.pack?.outputSchema, budget: m.tokenBudget,
                defaultOutput: m.parameters.maxTokens, checkInputBudget: this.adapters.checkInputBudget, signal,
              });
              cases.set(row.case_id, decision);
            } catch (error) {
              if (error.guardrail)
                m.guardrailFailure = { ...error.guardrail, candidateId: candidate.id, caseId: row.case_id };
              throw Error(candidate.model + " · " + row.case_id + " — " + error.message);
            }
          }
        }
      }
      for (const c of m.candidates)
        for (const row of rows) {
          if (signal.aborted) break;
          const trace = {
            id: randomUUID(),
            runId: m.id,
            candidateId: c.id,
            caseId: row.case_id,
            started: now(),
            steps: [],
          };
          const rec = {
            candidateId: c.id,
            caseId: row.case_id,
            trace,
            output: null,
            score: null,
            error: null,
            telemetry: null,
          };
          job.partial = { candidateId: c.id, caseId: row.case_id, text: "" };
          try {
            trace.steps.push({
              at: now(),
              action: m.fixture
                ? "Read recorded fixture response"
                : "Invoke " + c.provider,
            });
            if (m.fixture) rec.output = JSON.stringify(replay[row.case_id]);
            else {
              const { receipt: inputBudget, guardrail, preparedMessages } = decisions.get(c.id).get(row.case_id);
              const messages = preparedMessages ?? candidateMessages(m, row);
              rec.guardrail = guardrail;
              trace.steps.unshift({ at: trace.started, action: "Check model capacity", guardrail });
              if (inputBudget) rec.inputBudget = { cap: m.tokenBudget.inputCap, tokens: inputBudget.tokens, source: inputBudget.source };
              const finishPower = await this.powerSampler();
              let response;
              try {
                rec.dispatchedMessages = messages;
                response = await this.adapters.invoke(c, messages, {
                  signal,
                  apiKey: this.endpoints.keys.get(c.id),
                  maxTokens: guardrail.outputReserve,
                  inputBudget,
                  structured: m.pack?.outputSchema,
                  onText: (text) => { job.partial.text = text; },
                });
              } finally {
                rec.telemetry = { ...response?.telemetry, device_power: await finishPower() };
              }
              rec.output = response.output;
              if (m.tokenBudget.inputCap != null && response.telemetry?.input_tokens > m.tokenBudget.inputCap)
                throw Error("The runtime reported input usage above the approved cap.");
              if (response.telemetry?.output_tokens > guardrail.outputReserve)
                throw Error(`The runtime reported ${response.telemetry.output_tokens} output tokens above its ${guardrail.outputReserve}-token allocation.`);
              rec.finishReason = response.finishReason ?? null;
              if (rec.finishReason === "length")
                throw Error(lengthFailure(guardrail, rec.telemetry));
              if (!rec.output.trim())
                throw Error(
                  "Provider completed without visible response content.",
                );
            }
            if (signal.aborted) break;
            if (m.pack && m.datasetScorer !== "selected-graders") {
              rec.score = m.datasetScorer === "exact-reference" ? await exactReference(row,rec.output) : grade(m.pack, row, rec.output);
              trace.steps.push({
                at: now(),
                action: "Grade with " + m.pack.scorer,
              });
            }
          } catch (e) {
            if (signal.aborted) break;
            errors++;
            rec.error = e.message;
          }
          trace.finished = now();
          if (!signal.aborted && !rec.error) {
            for (const scorer of m.graders || []) {
              if (signal.aborted) break;
              const evidence = graderEvidence(m,row,rec);
              if (m.mode === "quick" && m.approvedPrompt) {
                const { objective, metrics, requirements } = m.approvedPrompt;
                evidence.evaluationBrief = { objective, metrics, criteria:requirements };
              }
              await this.graders.record(scorer,evidence,
                {run:m.id,candidate:c.id,caseId:row.case_id},this.adapters,signal);
            }
          }
          this.db
            .prepare("INSERT INTO results VALUES(?,?,?,?)")
            .run(m.id, c.id, row.case_id, JSON.stringify(rec));
        }
      if (!m.fixture && !errors && !signal.aborted && typeof this.adapters.reportStage === "function") {
        const completed = { ...this.detail(m.id), status: "completed" };
        await this.reports.finalize(completed, this.adapters, signal, stage => {
          job.partial = { stage, text: "" };
        });
      }
      status(signal.aborted ? "canceled" : errors ? "failed" : "completed");
    } catch (e) {
      if (signal.aborted) status("canceled");
      else {
        m.error = e.message;
        this.db.prepare("UPDATE runs SET status='failed', manifest=? WHERE id=?").run(JSON.stringify(m), m.id);
      }
    } finally {
      this.active = null;
      // Save the terminal report even if the user never opens the run.
      this.detail(m.id);
    }
  }
  stop(id) {
    if (id !== this.active?.id) throw Error("This run is no longer active.");
    this.active.controller.abort();
  }
  detail(id) {
    const run = this.db
      .prepare("SELECT status,manifest FROM runs WHERE id=?")
      .get(id);
    if (!run) throw Error("Run not found");
    const detail = {
      status: run.status,
      manifest: JSON.parse(run.manifest),
      results: this.db
        .prepare("SELECT record FROM results WHERE run=? ORDER BY rowid")
        .all(id)
        .map((r) => JSON.parse(r.record)),
      assessments: this.graders.recorded(id),
      partial: this.active?.id === id ? this.active.partial : null,
    };
    detail.report = this.reports.get(detail);
    return detail;
  }
  exportRun(id) {
    const { status, manifest, results, assessments, report } = this.detail(id);
    return {
      format: "dash-run/1",
      report,
      assessments,
      status,
      manifest,
      results,
      cases: manifest.datasetId
        ? this.dataset(manifest.datasetId).rows.filter((r) =>
            manifest.caseIds.includes(r.case_id),
          )
        : [],
    };
  }
}
module.exports = { Bench, replayCandidate };

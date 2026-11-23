const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { buildReport, RunReports } = require("../lib/run-report.cjs");
const { Bench } = require("../lib/bench.cjs");

const candidates = [{ id: "a", model: "Alpha" }, { id: "b", model: "Beta" }];
const cases = ["lot-1", "lot-2"];
const judge = { id: "rubric/3", name: "Evidence citation", type: "judge", version: 3, threshold: .6, judge: { id: "judge/model-v2" } };
const results = candidates.flatMap(c => cases.map(caseId => ({
  candidateId: c.id, caseId, output: "A response from " + c.id,
  score: { pass: c.id === "a", reasons: c.id === "a" ? [] : ["Mismatch in lot identifier"],
    ready: c.id === "a", falseAccept: c.id === "b", review: c.id === "b" },
})));
function run(scores = [.9, .7, .6, .4]) {
  return {
    status: "completed",
    manifest: { id: "run", candidates, caseIds: cases, pack: { id: "inspection", scorer: "inspection-v1", metrics: ["Ready", "False accepts", "Review"] },
      graders: [judge], policyHash: "policy", approvedPrompt: { metrics: ["Fewer line stoppages"] } },
    results: structuredClone(results),
    assessments: results.map((r, i) => ({
      id: "verdict-" + i, graderId: judge.id, engine: judge.type, version: judge.version,
      judge: judge.judge.id, candidate: r.candidateId, caseId: r.caseId, value: scores[i],
      pass: scores[i] >= judge.threshold, reason: "Judged using inspection evidence.",
    })),
  };
}

test("two-stage report uses paired case scores, transparent rubric means and distinct judge provenance", () => {
  const report = buildReport(run());
  assert.equal(report.verdict, "winner");
  assert.equal(report.winnerId, "a");
  assert.equal(report.analyzer.name, "Output Analyzer");
  assert.equal(report.reporter.name, "Report agent");
  assert.deepEqual(report.metrics.map(m => m.method), ["deterministic", "llm-judge"]);
  assert.equal(report.metrics[1].judge, judge.judge.id);
  assert.equal(report.metrics[1].values[0].score, .8);
  assert.equal(report.metrics[1].values[1].passes, 1);
  assert.equal(report.metrics[1].caseScores[1].values[1].reason, "Judged using inspection evidence.");
  assert.deepEqual(report.targets, ["Fewer line stoppages"]);
  assert.equal(report.observedOutcomes[1].values[1].count, 2);
});

test("a missing or differently versioned judgment is never averaged as zero or compared on different cases", () => {
  const input = run();
  input.assessments[3].version++;
  const report = buildReport(input);
  assert.equal(report.verdict, "incomplete");
  assert.equal(report.winnerId, null);
  const metric = report.metrics[1];
  assert.equal(metric.pairedCases, 1);
  assert.deepEqual(metric.values.map(v => v.availableCases), [2, 1]);
  assert.deepEqual(metric.values.map(v => v.score), [.9, .6]);
  assert.equal(metric.caseScores[1].values[1].score, null);
  input.assessments[3].version = judge.version;
  input.assessments[3].judge = "another judge";
  assert.equal(buildReport(input).verdict, "incomplete");
  input.assessments[3].judge = judge.judge.id;
  input.assessments[3].value = null;
  input.assessments[3].reason = "Judge unavailable";
  assert.equal(buildReport(input).metrics[1].caseScores[1].values[1].reason, "Judge unavailable");
});

test("ties, mixed leads, ungraded comparisons and nonterminal or incomplete runs never declare a winner", () => {
  const input = run([.2, .2, .9, .9]);
  assert.equal(buildReport(input).verdict, "mixed");
  input.manifest.datasetScorer = "selected-graders";
  input.manifest.pack.kind = "reference";
  input.assessments.forEach(a => { a.value = .8; a.pass = true; });
  assert.equal(buildReport(input).verdict, "tie");
  assert.equal(buildReport(input).metrics.length, 1);
  for (const status of ["failed", "canceled", "interrupted"]) {
    assert.equal(buildReport({ ...input, status }).verdict, "incomplete");
    assert.equal(buildReport({ ...input, status }).winnerId, null);
  }
  assert.equal(buildReport({ ...input, status: "running" }), null);
  input.manifest.graders = [];
  assert.equal(buildReport(input).verdict, "ungraded");
  input.manifest.datasetScorer = "exact-reference";
  input.manifest.candidates = [candidates[0]];
  assert.equal(buildReport(input).verdict, "single");
  assert.equal(buildReport(input).metrics[0].label, "Exact reference match");
});

test("stored reports are reproducible when reopened; later manual grades do not duplicate cases or replace the first assessment", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new RunReports(db), input = run();
    const original = store.get(input);
    assert.deepEqual(new RunReports(db).get(input), original);
    input.assessments.push({ ...input.assessments[0], id: "manual-second", value: 0, pass: false });
    assert.deepEqual(store.get(input), original);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_reports").get().n, 1);
  } finally { db.close(); }
});

test("normal fixture completion persists a report before detail is opened; old runs backfill and exports include the report", async () => {
  const bench = new Bench(":memory:");
  try {
    const dataset = bench.list().datasets.find(d => d.pack === "earnings");
    const id = bench.start({ mode: "dataset", datasetId: dataset.id, candidateIds: [bench.list().fixtureId] });
    assert.equal(bench.detail(id).report, null);
    await bench.active.done;
    const persisted = JSON.parse(bench.db.prepare("SELECT report FROM run_reports WHERE run=?").get(id).report);
    assert.equal(persisted.verdict, "single");
    assert.equal(persisted.caseCount, 8);
    bench.db.prepare("DELETE FROM run_reports WHERE run=?").run(id);
    assert.deepEqual(bench.detail(id).report, persisted);
    assert.deepEqual(bench.exportRun(id).report, persisted);
  } finally { bench.db.close(); }
});

test("a two-model run compares actual persisted judge and deterministic assessments without sending judge evidence to candidates", async t => {
  const local = candidates.map(c => ({ ...c, model: c.id === "a" ? "lfm3-qa" : c.model, provider: "lmstudio", loaded: true }));
  const requests = [];
  const bench = new Bench(":memory:", {
    discover: async () => [{ models: local }],
    async reportStage(model, messages, options) {
      assert.equal(model.model, "lfm3-qa");
      assert.equal(bench.detail(bench.active.id).status, "running");
      assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_RUBRIC_MARKER/);
      const data = JSON.parse(messages[1].content);
      if (options.structured.properties.evidence)
        return { output: JSON.stringify({ evidence: [data.evidence[0].id] }) };
      return { output: JSON.stringify({ verdict: "winner", winner: "A", highlights: [
        { evidence: data.selected[0].id, observation: "first_higher" },
      ] }) };
    },
    async invoke(candidate, messages, opts) {
      if (opts.planning) {
        const payload = opts.structured.properties.requirements
          ? { title: "Traceability", metrics: ["Traceable evidence"], requirements: ["Cite the lot number"] }
          : { prompt: "Describe the next inspection step." };
        return { output: JSON.stringify(payload) };
      }
      if (messages[0].role === "system" && messages[0].content.includes("PRIVATE_RUBRIC_MARKER")) {
        const evidence = JSON.parse(messages[1].content);
        return { output: JSON.stringify({ score: evidence.output.includes("Traceable") ? .9 : .2, reason: "Assessed against the cited lot." }) };
      }
      requests.push(messages);
      return { output: candidate.id === "a" ? "Traceable to lot 712." : "No evidence." };
    },
  }, async () => async () => null);
  t.after(() => bench.db.close());
  await bench.refresh();
  const draft = await bench.designPrompt({ mode: "quick", domain: "Manufacturing", objective: "Find the incoming lot needing review." });
  const approval = bench.workflow.approve({ draftId: draft.draftId, prompt: draft.prompt });
  const grader = { industry: "Manufacturing", category: "Traceability", threshold: .6 };
  const judgeId = bench.graders.save({ ...grader, name: "Evidence", type: "judge", judgeId: "a", criteria: "PRIVATE_RUBRIC_MARKER" }, local);
  const ruleId = bench.graders.save({ ...grader, name: "Cites lot", type: "contains", criteria: "712" }, []);
  const runId = bench.start({ mode: "quick", candidateIds: ["a", "b"], approvedPromptId: approval.id, graderIds: [judgeId, ruleId] });
  await bench.active.done;
  const detail = bench.detail(runId);
  assert.equal(detail.status, "completed");
  assert.equal(detail.assessments.length, 4);
  assert.equal(detail.report.winnerId, "a");
  assert.equal(detail.report.assistance.analyzer.status, "verified");
  assert.equal(detail.report.assistance.reporter.status, "verified");
  assert.equal(detail.report.assistance.citations[0].metricId, judgeId);
  assert.deepEqual(bench.exportRun(runId).report.assistance, detail.report.assistance);
  assert.deepEqual(detail.report.metrics.map(m => m.values.map(v => v.score)), [[.9, .2], [1, 0]]);
  assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify(requests), /PRIVATE_RUBRIC_MARKER/);
});

test("a reference dataset compares the original case prompts using only the operator's selected scoring method", async t => {
  const local = candidates.map(c => ({ ...c, provider: "ollama", loaded: true }));
  const candidateMessages = [], judgeEvidence = [];
  const bench = new Bench(":memory:", {
    discover: async () => [{ models: local }],
    async invoke(candidate, messages) {
      if (messages[0].role === "system" && messages[0].content.includes("Compare the output")) {
        const evidence = JSON.parse(messages[1].content);
        judgeEvidence.push(evidence);
        return { output: JSON.stringify({ score: evidence.output === evidence.reference ? .95 : .1, reason: "Compared with the supplied SME reference." }) };
      }
      candidateMessages.push(messages);
      return { output: candidate.id === "a" ? "Operator review" : "Automatic release" };
    },
  }, async () => async () => null);
  t.after(() => bench.db.close());
  await bench.refresh();
  const row = { case_id: "inspection", dataset_version: "1", split: "development", prompt: "Which disposition should be selected?", reference: "Operator review", sme_rationale: "PRIVATE_SME_HOLD" };
  const graderId = bench.graders.save({ name: "SME disposition", category: "Quality", industry: "Manufacturing", criteria: "Compare the output to the SME disposition.", type: "judge", threshold: .8, judgeId: "a" }, local);
  for (const mode of ["exact-reference", "selected-graders"]) {
    const item = mode === "exact-reference" ? row : { ...row, dataset_version: "2", rubric: "PRIVATE_RUBRIC: check the disposition." };
    const datasetId = bench.import("reference", "Reference " + mode, JSON.stringify(item));
    const id = bench.start({ mode: "dataset", datasetId, candidateIds: ["a","b"], datasetScorer: mode, graderIds: mode === "selected-graders" ? [graderId] : [] });
    await bench.active.done;
    const { report, status, manifest, results } = bench.detail(id);
    assert.equal(status, "completed", manifest.error);
    assert.equal(report.verdict, "winner");
    assert.equal(report.winnerId, "a");
    assert.equal(report.metrics.length, 1);
    assert.equal(report.metrics[0].method, mode === "exact-reference" ? "deterministic" : "llm-judge");
    assert.equal(report.metrics[0].label, mode === "exact-reference" ? "Exact reference match" : "SME disposition");
    assert.deepEqual(report.observedOutcomes, []);
    if (mode === "selected-graders") assert.ok(results.every(r => r.score === null));
  }
  assert.equal(judgeEvidence.length, 2);
  assert.ok(judgeEvidence.every(e => e.sme_rationale === row.sme_rationale && e.rubric.includes("PRIVATE_RUBRIC")));
  assert.equal(candidateMessages.length, 4);
  for (const messages of candidateMessages)
    assert.deepEqual(messages, [{ role: "user", content: row.prompt }], "Dispatch only the unchanged, authored input to the candidate");
});

test("local stages reject invented citations, reversed observations and unsupported verdicts while persisting the audited result", async t => {
  const db = new DatabaseSync(":memory:"), store = new RunReports(db);
  t.after(() => db.close());
  const input = run(), model = { id: "ollama/lfm3", provider: "ollama", model: "lfm3-test", loaded: true };
  const examples = [
    { analyzer: { evidence: ["invented-case"] }, reporter: null, status: ["fallback", "skipped"] },
    { analyzer: { evidence: ["E1"] }, reporter: { verdict: "winner", winner: "B", highlights: [{ evidence:"E1", observation:"first_higher" }] }, status:["verified","fallback"] },
    { analyzer: { evidence: ["E1"] }, reporter: { verdict: "winner", winner: "A", highlights: [{ evidence:"E1", observation:"second_higher" }] }, status:["verified","fallback"] },
  ];
  for (const example of examples) {
    let calls = 0;
    const saved = await store.finalize(input, {
      discover: async () => [{ models: [model] }],
      reportStage: async () => ({ output: JSON.stringify(++calls === 1 ? example.analyzer : example.reporter) }),
    }, new AbortController().signal);
    assert.equal(saved.winnerId, "a");
    assert.deepEqual([saved.assistance.analyzer.status, saved.assistance.reporter.status], example.status);
    assert.deepEqual(saved.assistance.citations, []);
    assert.equal(calls, example.reporter ? 2 : 1);
    assert.deepEqual(new RunReports(db).get(input), saved);
  }
  const offline = await store.finalize(input, {
    discover: async () => [], reportStage: () => assert.fail("offline should not call a model"),
  }, new AbortController().signal);
  assert.equal(offline.winnerId, "a");
  assert.equal(offline.assistance.analyzer.status, "skipped");
  assert.match(offline.assistance.reason, /No loaded local LFM3/);
});

test("a canceled local review cannot claim a completed comparison or save partial citations", async t => {
  const db = new DatabaseSync(":memory:"), store = new RunReports(db), controller = new AbortController();
  t.after(() => db.close());
  await assert.rejects(store.finalize(run(), {
    discover: async () => [{ models: [{ provider:"ollama", model:"lfm3-test", loaded:true }] }],
    reportStage: async () => { controller.abort(); throw Error("Canceled"); },
  }, controller.signal), /abort/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_reports").get().n, 0);
});

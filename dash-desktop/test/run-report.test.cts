import {auditReply} from "./audit-fixture.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { z } from "opik";
import { buildReport, RunReports, reportSchema } from "../lib/run-report.cjs";
import { assistReport } from "../lib/report-agents.cjs";
import {domainStarters} from "../lib/domain-starters.cjs";
import {inspectionRuleId} from "../lib/inspection-decision.cjs";
import { Bench } from "../lib/bench.cjs";
import { loadPacks } from "../lib/packs.cjs";
import { referencePack } from "../lib/evaluation-cases.cjs";
import type { RunData, RunResult } from "../lib/run-types.cjs";
import { isRecord, type ChatTurn, type LocalCandidate } from "../lib/runtime-types.cjs";
import type { GraderSpec } from "../lib/grader-types.cjs";
import { inventory, present, reply, withoutPower } from "./runtime-fixtures.cjs";

const candidates: LocalCandidate[] = [
  { id: "a", model: "Alpha", provider: "lmstudio", kind: "model" },
  { id: "b", model: "Beta", provider: "lmstudio", kind: "model" },
];
const cases = ["lot-1", "lot-2"];
const judge = { industry: "Manufacturing", category: "Traceability", criteria: "Cite the lot.", id: "rubric/3", name: "Evidence citation", type: "judge", version: 3, threshold: .6, judge: { id: "judge/model-v2", kind:"model", provider:"lmstudio", model:"model-v2" } } satisfies GraderSpec;
const recordedAt = "2026-01-01T00:00:00Z";
const results: RunResult[] = candidates.flatMap(c => cases.map(caseId => ({
  error:null, telemetry:null, trace:{id:c.id+"-"+caseId,runId:"run",candidateId:c.id,caseId,started:recordedAt,steps:[]},
  candidateId: c.id, caseId, output: "A response from " + c.id,
  score: { pass: c.id === "a", reasons: c.id === "a" ? [] : ["Mismatch in lot identifier"],
    ready: c.id === "a", falseAccept: c.id === "b", review: c.id === "b" },
})));
function run(scores = [.9, .7, .6, .4]): RunData {
  const { pack } = present(loadPacks().find(bundle => bundle.pack.id === "manufacturing"));
  assert.notEqual(pack.kind, "reference");
  return {
    status: "completed", partial:null,
    manifest: { format:1, mode:"dataset", fixture:false, title:"Inspection report", created:recordedAt,
      datasetId:"inspection",datasetVersion:"1",split:"development", prompt:null,promptHash:"prompt-v1",caseSetHash:"lots",
      parameters:{},device:{platform:"test",arch:"test",release:"test"},animation:false,id: "run", candidates, caseIds: cases, pack: { ...pack,id: "inspection", scorer: "inspection-v1", metrics: ["Ready", "False accepts", "Review"] },
      graders: [judge], policyHash: "policy", approvedPrompt: {
        id:"prompt-v1",familyId:"inspection-prompts",version:1,mode:"dataset",prompt:"Review the lot.",
        objective:"Reduce line stoppages",title:"Inspection",domain:"Manufacturing",requirements:["Cite the lot"],
        datasetId:"inspection",packId:"inspection",contractHash:"contract",inputCap:null,outputCap:null,designer:null,
        metrics: ["Fewer line stoppages"] } },
    results: structuredClone(results),
    assessments: results.map((r, i) => ({
      id: "verdict-" + i, created:recordedAt, name:judge.name,threshold:judge.threshold,category:judge.category, graderId: judge.id, engine: judge.type, version: judge.version,
      judge: judge.judge.id, candidate: r.candidateId, caseId: r.caseId, value: scores[i],
      pass: scores[i] >= judge.threshold, reason: "Judged using inspection evidence.",
    })),
  };
}

test("two-stage report uses paired case scores, transparent rubric means and distinct judge provenance", () => {
  const report = present(buildReport(run()));
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

const diagnostic = { id:"diag/completion",name:"Generation completed",industry:"General",category:"Response",criteria:"Check the runtime stop reason.",
  threshold:1,version:1,type:"catalog",ruleKey:"completion",ruleVersion:1,judge:null,
  library:{scope:"general",familyId:"diagnostics-completion",automatic:true} } satisfies GraderSpec;

test("response diagnostics retain case evidence without choosing a winner or blocking a business grade",async ()=>{
  const input=run();
  input.manifest.graders=[judge,diagnostic];
  let report=present(buildReport(input));
  assert.equal(report.winnerId,"a");
  const metric=present(report.metrics.find(m=>m.id===diagnostic.id));
  assert.equal(metric.informational,true);assert.equal(metric.pairedCases,0);
  const derived={...diagnostic,id:"customer-diagnostic-v1",library:{scope:"customer",familyId:"derived",parentRevisionId:diagnostic.id}} satisfies GraderSpec;
  input.manifest.graders=[derived];input.manifest.pack=null;
  input.assessments=input.assessments.map(a=>({...a,graderId:derived.id,version:1,threshold:1,engine:"catalog",judge:null,
    pass:a.candidate==="a",value:a.candidate==="a"?1:0,reason:"Recorded completion evidence."}));
  input.results[2].output="";input.results[2].error="Candidate returned an empty response.";
  report=present(buildReport(input));assert.equal(report.verdict,"ungraded");assert.equal(report.winnerId,null);
  assert.deepEqual(report.metrics[0].values.map(v=>v.score),[1,0]);
  assert.deepEqual(report.metrics[0].lineage,derived.library);
  const assisted=await assistReport(report,{discover:async()=>assert.fail("A diagnostic cannot warrant a quality review"),
    invoke:async()=>assert.fail("Diagnostic-only review cannot call inference")},new AbortController().signal);
  assert.deepEqual(assisted.assistance?.citations,[]);
});

test("an unsafe leading candidate retains its case outcomes without a quality winner; prior policies keep their verdicts", ()=>{
  const historical=run();
  const first=present(historical.results[0].score);first.falseAccept=true;first.pass=false;
  assert.equal(present(buildReport(historical)).winnerId,"a");
  const current=structuredClone(historical);
  current.manifest.graders=[judge,diagnostic];
  let report=present(buildReport(current));
  assert.equal(report.verdict,"unsafe");assert.equal(report.winnerId,null);assert.match(report.summary,/falsely accepted 1 of 2/);
  present(current.results[0].score).falseAccept=false;
  delete present(current.results[1].score).falseAccept;
  report=present(buildReport(current));
  assert.equal(report.verdict,"incomplete");assert.equal(report.winnerId,null);
  present(current.results[0].score).falseAccept=true;
  current.results[2].error="Other candidate failed";current.results[2].score=null;
  report=present(buildReport(current));
  assert.deepEqual(report.observedOutcomes.find(o=>o.field==="falseAccept")?.values,
    [{candidateId:"a",count:1,total:1,caseIds:["lot-1"]},{candidateId:"b",count:1,total:1,caseIds:["lot-2"]}]);
});

test("Opik risk metrics compare the pinned normalized score and preserve original risk evidence",()=>{
  const data=run(),g={...judge,type:"opik-metric",metricKey:"moderation"} satisfies GraderSpec;
  data.manifest.graders=[g];data.manifest.pack=null;
  data.assessments=data.assessments.map(a=>{
    const pass=a.candidate==="a",raw=pass ? .1 : .8;
    return {...a,engine:g.type,metricKey:g.metricKey,opikMetric:{metricKey:g.metricKey,nativeScore:raw,direction:"higher-is-risk"},
      pass,value:1-raw};
  });
  let report=present(buildReport(data));assert.equal(report.winnerId,"a");
  const metric=report.metrics[0];assert.equal(metric.method,"opik-metric");
  assert.deepEqual(metric.caseScores[0].values[0].opikMetric,{metricKey:"moderation",nativeScore:.1,direction:"higher-is-risk"});
  data.assessments[0].value=.1;
  report=present(buildReport(data));assert.equal(report.winnerId,null);
  assert.equal(report.metrics[0].caseScores[0].values[0].score,null);
});

test("a missing or differently versioned judgment is never averaged as zero or compared on different cases", () => {
  const input = run();
  input.assessments[3].version++;
  const report = present(buildReport(input));
  assert.equal(report.verdict, "incomplete");
  assert.equal(report.winnerId, null);
  const metric = report.metrics[1];
  assert.equal(metric.pairedCases, 1);
  assert.deepEqual(metric.values.map(v => v.availableCases), [2, 1]);
  assert.deepEqual(metric.values.map(v => v.score), [.9, .6]);
  assert.equal(metric.caseScores[1].values[1].score, null);
  input.assessments[3].version = judge.version;
  input.assessments[3].judge = "another judge";
  assert.equal(present(buildReport(input)).verdict, "incomplete");
  input.assessments[3].judge = judge.judge.id;
  input.assessments[3].value = null;
  input.assessments[3].reason = "Judge unavailable";
  assert.equal(present(buildReport(input)).metrics[1].caseScores[1].values[1].reason, "Judge unavailable");
});

test("decision rubrics compare recorded categorical grades from a consistent served revision and preserve raw probabilities", () => {
  const input=run();
  const g={...judge,type:"decision",judge:null,threshold:.8,decision:{provider:"openrouter",model:"test/model",failAt:.2}} satisfies GraderSpec;
  input.manifest.graders=[g];
  input.manifest.datasetScorer="selected-graders";
  const pin={provider:g.decision.provider,requestedModel:g.decision.model,failAt:g.decision.failAt,passAt:g.threshold};
  const actualModel="test/model-rev1";
  input.assessments=input.assessments.map(a=>{
    const pass=a.candidate==="a";
    return {...a,engine:g.type,judge:g.decision.model,threshold:g.threshold,pass,value:Number(pass),
      decisionRequest:pin,decision:{...pin,actualModel,identityVerification:"openrouter-catalog",probabilityYes:pass ? .8 : .2,usage:{inputTokens:3}}};
  });
  const db=new DatabaseSync(":memory:");
  try {
    const store=new RunReports(db), report=present(store.get(input)), metric=report.metrics[0];
    assert.equal(metric.method,"decision-model");
    assert.equal(metric.judge,"test/model");
    assert.deepEqual(metric.decisionPolicy,pin);
    assert.deepEqual(metric.values.map(v=>v.score),[1,0]);
    assert.deepEqual(metric.caseScores[0].values[0].decision,{...pin,status:"passed",actualModel,identityVerification:"openrouter-catalog",dispatchedModel:pin.requestedModel,probabilityYes:.8,usage:{inputTokens:3}});
    assert.equal(report.winnerId,"a");
    assert.deepEqual(new RunReports(db).get(input),report);
  } finally { db.close(); }
  const last=input.assessments[3], original=structuredClone(last);
  const checkMissing = (status:"review"|"unscored"|undefined) => {
    const report=present(buildReport(input));
    assert.equal(report.winnerId,null);
    assert.equal(report.verdict,"incomplete");
    const metric=report.metrics[0];
    assert.equal(metric.pairedCases,1);
    assert.equal(metric.caseScores[1].values[1].score,null);
    assert.equal(metric.caseScores[1].values[1].decision?.status,status);
  };
  last.pass=null;last.value=null;present(last.decision).probabilityYes=.5;
  checkMissing("review");
  last.decision=undefined;last.reason="Decision grader unavailable.";
  checkMissing("unscored");
  assert.equal(present(buildReport(input)).metrics[0].caseScores[1].values[1].reason,last.reason);
  Object.assign(last,structuredClone(original));
  last.value=.2;
  checkMissing("unscored");
  Object.assign(last,structuredClone(original));
  present(last.decisionRequest).requestedModel="test/other";
  checkMissing("unscored");
  Object.assign(last,structuredClone(original));
  last.judge="test/other";
  checkMissing(undefined);
  Object.assign(last,structuredClone(original));
  last.decision={...present(original.decision),identityVerification:"exact"};
  checkMissing("unscored");
  last.decision={...present(original.decision),actualModel:"test/model-rev2"};
  const mixed=present(buildReport(input));
  assert.equal(mixed.winnerId,null);assert.equal(mixed.metrics[0].pairedCases,0);
  assert.deepEqual(mixed.metrics[0].values.map(v=>v.score),[null,null]);
  assert.deepEqual(mixed.metrics[0].values.map(v=>v.availableCases),[2,2]);
  assert.match(present(mixed.metrics[0].comparisonIssue),/multiple model revisions/);
});

test("a local fallback grade requires the pinned alternate and transport; mixed judges or a failed switch cannot declare a winner", async ()=>{
  const input=run();
  const primary="/synthetic/models/primary", alternate="/synthetic/models/alternate";
  const g={...judge,type:"decision",judge:null,threshold:.8,decision:{provider:"local",protocol:"mlx-vlm",model:primary,fallbackModel:alternate,failAt:.2}} satisfies GraderSpec;
  const request={provider:g.decision.provider,requestedModel:g.decision.model,failAt:g.decision.failAt,passAt:g.threshold,
    protocol:g.decision.protocol,fallbackModel:g.decision.fallbackModel};
  input.manifest.graders=[g];input.manifest.datasetScorer="selected-graders";
  input.assessments=input.assessments.map(a=>{
    const pass=a.candidate==="a";
    return {...a,engine:g.type,judge:g.decision.model,threshold:g.threshold,value:Number(pass),pass,decisionRequest:request,
      decision:{provider:request.provider,requestedModel:request.requestedModel,protocol:request.protocol,
        failAt:request.failAt,passAt:request.passAt,dispatchedModel:alternate,actualModel:alternate,identityVerification:"exact",
        fallbackReason:"primary-unavailable",probabilityYes:pass ? .91 : .08}};
  });
  const grades=()=>present(buildReport(input));
  assert.equal(grades().winnerId,"a");
  const grade=present(grades().metrics[0].caseScores[0].values[0].decision);
  assert.deepEqual([grade.protocol,grade.requestedModel,grade.dispatchedModel,grade.actualModel,grade.fallbackReason],
    ["mlx-vlm",primary,alternate,alternate,"primary-unavailable"]);
  const last=input.assessments[3],fallback=present(last.decision);
  last.decision={...fallback,actualModel:primary,dispatchedModel:primary,fallbackReason:undefined};
  assert.equal(grades().winnerId,null);assert.equal(grades().metrics[0].pairedCases,0);
  const reviewed=await assistReport(grades(),{
    discover:async()=>assert.fail("No comparable rubric was available to review"),
    invoke:async()=>assert.fail("No inference should run"),
  },new AbortController().signal);
  assert.equal(reviewed.verdict,"incomplete");
  assert.deepEqual(reviewed.assistance?.citations,[]);
  assert.equal(reviewed.assistance?.analyzer.status,"skipped");
  assert.equal(reviewed.assistance?.reporter.status,"skipped");
  for (const invalid of [{...fallback,protocol:"systemone" as const},
      {...fallback,actualModel:"unexpected",dispatchedModel:"unexpected"},{...fallback,fallbackReason:undefined}]) {
    last.decision=invalid;
    assert.equal(grades().metrics[0].caseScores[1].values[1].score,null);
    assert.equal(grades().metrics[0].pairedCases,1);
  }
  last.pass=null;last.value=null;last.decision=undefined;
  last.decisionAttempt={requestedModel:primary,dispatchedModel:alternate,protocol:"mlx-vlm",fallbackReason:"primary-unavailable"};
  const failed=present(grades().metrics[0].caseScores[1].values[1].decision);
  assert.equal(failed.status,"unscored");assert.equal(failed.dispatchedModel,alternate);
  assert.equal(failed.actualModel,undefined);assert.equal(failed.probabilityYes,undefined);
  assert.equal(grades().winnerId,null);
});

test("ties, mixed leads, ungraded comparisons and nonterminal or incomplete runs never declare a winner", () => {
  const input = run([.2, .2, .9, .9]);
  assert.equal(present(buildReport(input)).verdict, "mixed");
  input.manifest.datasetScorer = "selected-graders";
  input.manifest.pack = { ...referencePack, id:"inspection" };
  input.assessments.forEach(a => { a.value = .8; a.pass = true; });
  assert.equal(present(buildReport(input)).verdict, "tie");
  assert.equal(present(buildReport(input)).metrics.length, 1);
  for (const status of ["failed", "canceled", "interrupted"] as const) {
    assert.equal(present(buildReport({ ...input, status })).verdict, "incomplete");
    assert.equal(present(buildReport({ ...input, status })).winnerId, null);
  }
  assert.equal(buildReport({ ...input, status: "running" }), null);
  input.manifest.graders = [];
  assert.equal(present(buildReport(input)).verdict, "ungraded");
  input.manifest.datasetScorer = "exact-reference";
  input.manifest.candidates = [candidates[0]];
  assert.equal(present(buildReport(input)).verdict, "single");
  assert.equal(present(buildReport(input)).metrics[0].label, "Exact reference match");
});

test("stored reports are reproducible when reopened; later manual grades do not duplicate cases or replace the first assessment", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new RunReports(db), input = run();
    const original = store.get(input);
    assert.deepEqual(new RunReports(db).get(input), original);
    input.assessments.push({ ...input.assessments[0], id: "manual-second", value: 0, pass: false });
    assert.deepEqual(store.get(input), original);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_reports").get()?.n, 1);
  } finally { db.close(); }
});

test("normal fixture completion persists a report before detail is opened; old runs backfill and exports include the report", async () => {
  const bench = new Bench(":memory:");
  try {
    const dataset = bench.list().datasets.find(d => d.pack === "earnings");
    const id = bench.start({ mode: "dataset", datasetId: present(dataset).id, candidateIds: [bench.list().fixtureId] });
    assert.equal(bench.detail(id).report, null);
    await present(bench.active).done;
    const raw = bench.db.prepare("SELECT report FROM run_reports WHERE run=?").get(id)?.report;
    assert.ok(typeof raw === "string");
    const persisted = reportSchema.parse(JSON.parse(raw));
    assert.equal(persisted.verdict, "single");
    assert.equal(persisted.caseCount, 8);
    bench.db.prepare("DELETE FROM run_reports WHERE run=?").run(id);
    assert.deepEqual(bench.detail(id).report, persisted);
    assert.deepEqual(bench.exportRun(id).report, persisted);
  } finally { bench.db.close(); }
});

test("a two-model run compares actual persisted judge and deterministic assessments without sending judge evidence to candidates", async t => {
  const local: LocalCandidate[] = candidates.map(c => ({ ...c, model: c.id === "a" ? "lfm3-qa" : c.model, provider: "lmstudio", loaded: true }));
  const requests: ChatTurn[][] = [];
  const bench: Bench = new Bench(":memory:", {
    discover: async () => [inventory(local)],
    async reportStage(model, messages, options) {
      assert.equal(model.model, "lfm3-qa");
      assert.equal(bench.detail(present(bench.active).id).status, "running");
      assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_RUBRIC_MARKER/);
      const ids = z.array(z.object({id:z.string()}));
      const data = z.object({evidence:ids.optional(),selected:ids.optional()}).parse(JSON.parse(messages[1].content));
      if (isRecord(options.structured?.properties) && options.structured.properties.evidence)
        return reply(JSON.stringify({ evidence: [present(data.evidence)[0].id] }));
      return reply(JSON.stringify({ verdict: "winner", winner: "A", highlights: [
        { evidence: present(data.selected)[0].id, observation: "first_higher" },
      ] }));
    },
    async invoke(candidate, messages, opts) {
      if (opts.planning) {
        if (isRecord(opts.structured?.properties) && opts.structured.properties.audit) return reply(JSON.stringify(auditReply(messages)));
        const payload = isRecord(opts.structured?.properties) && opts.structured.properties.requirements
          ? { title: "Traceability", metrics: ["Traceable evidence"], requirements: ["Cite the lot number"] }
          : { prompt: "Describe the next inspection step." };
        return reply(JSON.stringify(payload));
      }
      if (messages[0].role === "system" && messages[0].content.includes("PRIVATE_RUBRIC_MARKER")) {
        const evidence = z.object({output:z.string()}).parse(JSON.parse(messages[1].content));
        return reply(JSON.stringify({ score: evidence.output.includes("Traceable") ? .9 : .2, reason: "Assessed against the cited lot." }));
      }
      requests.push(messages);
      return reply(candidate.id === "a" ? "Traceable to lot 712." : "No evidence.");
    },
  }, withoutPower);
  t.after(() => bench.db.close());
  await bench.refresh();
  const draft = await bench.designPrompt({ mode: "quick", domain: "Manufacturing", objective: "Find the incoming lot needing review." });
  const approval = bench.workflow.approve({ draftId: draft.draftId, prompt: draft.prompt });
  const grader = { industry: "Manufacturing", category: "Traceability", threshold: .6 };
  const judgeId = bench.graders.save({ ...grader, name: "Evidence", type: "judge", judgeId: "a", criteria: "PRIVATE_RUBRIC_MARKER" }, local);
  const ruleId = bench.graders.save({ ...grader, name: "Cites lot", type: "contains", criteria: "712" }, []);
  const runId = bench.start({ mode: "quick", candidateIds: ["a", "b"], approvedPromptId: approval.id, graderIds: [judgeId, ruleId], measureGraders: [{metric:approval.metrics[0],kind:"saved",graderId:judgeId}] });
  await present(bench.active).done;
  const detail = bench.detail(runId);
  assert.equal(detail.status, "completed");
  assert.equal(detail.assessments.filter(a=>a.graderId===judgeId || a.graderId===ruleId).length,4);
  assert.ok(detail.assessments.some(a=>a.engine==="catalog"));
  assert.ok(detail.report?.assistance);
  assert.equal(detail.report.winnerId, "a");
  assert.equal(detail.report.assistance.analyzer.status, "verified");
  assert.equal(detail.report.assistance.reporter.status, "verified");
  assert.equal(detail.report.assistance.citations[0].metricId, judgeId);
  assert.deepEqual(present(bench.exportRun(runId).report).assistance, detail.report.assistance);
  assert.deepEqual(detail.report.metrics.filter(m=>!m.informational).map(m => m.values.map(v => v.score)), [[.9, .2], [1, 0]]);
  assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify(requests), /PRIVATE_RUBRIC_MARKER/);
});

test("a reference dataset compares the original case prompts using only the operator's selected scoring method", async t => {
  const local: LocalCandidate[] = candidates.map(c => ({ ...c, provider: "ollama", loaded: true }));
  const candidateMessages: ChatTurn[][] = [], judgeEvidence: {sme_rationale:string;rubric:string}[] = [];
  const bench: Bench = new Bench(":memory:", {
    discover: async () => [inventory(local)],
    async invoke(candidate, messages) {
      if (messages[0].role === "system" && messages[0].content.includes("Compare the output")) {
        const evidence = z.object({output:z.string(),reference:z.string(),sme_rationale:z.string(),rubric:z.string()}).parse(JSON.parse(messages[1].content));
        judgeEvidence.push(evidence);
        return reply(JSON.stringify({ score: evidence.output === evidence.reference ? .95 : .1, reason: "Compared with the supplied SME reference." }));
      }
      candidateMessages.push(messages);
      return reply(candidate.id === "a" ? "Operator review" : "Automatic release");
    },
  }, withoutPower);
  t.after(() => bench.db.close());
  await bench.refresh();
  const row = { case_id: "inspection", dataset_version: "1", split: "development", prompt: "Which disposition should be selected?", reference: "Operator review", sme_rationale: "PRIVATE_SME_HOLD" };
  const graderId = bench.graders.save({ name: "SME disposition", category: "Quality", industry: "Manufacturing", criteria: "Compare the output to the SME disposition.", type: "judge", threshold: .8, judgeId: "a" }, local);
  for (const mode of ["exact-reference", "selected-graders"] as const) {
    const item = mode === "exact-reference" ? row : { ...row, dataset_version: "2", rubric: "PRIVATE_RUBRIC: check the disposition." };
    const datasetId = bench.import("reference", "Reference " + mode, JSON.stringify(item),{industry:"Manufacturing",family:"Reference inspection "+mode,category:"Lot disposition"});
    const id = bench.start({ mode: "dataset", datasetId, candidateIds: ["a","b"], datasetScorer: mode, graderIds: mode === "selected-graders" ? [graderId] : [] });
    await present(bench.active).done;
    const { report, status, manifest, results } = bench.detail(id);
    assert.equal(status, "completed", manifest.error);
    assert.ok(report);
    assert.equal(report.verdict, "winner");
    assert.equal(report.winnerId, "a");
    const quality=report.metrics.filter(m=>!m.informational);
    assert.equal(quality.length,1);assert.ok(report.metrics.some(m=>m.informational));
    assert.equal(quality[0].method, mode === "exact-reference" ? "deterministic" : "llm-judge");
    assert.equal(quality[0].label, mode === "exact-reference" ? "Exact reference match" : "SME disposition");
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
  const input = run(), model: LocalCandidate = {kind:"model", id: "ollama/lfm3", provider: "ollama", model: "lfm3-test", loaded: true };
  const examples = [
    { analyzer: { evidence: ["invented-case"] }, reporter: null, status: ["fallback", "skipped"] },
    { analyzer: { evidence: ["E1"] }, reporter: { verdict: "winner", winner: "B", highlights: [{ evidence:"E1", observation:"first_higher" }] }, status:["verified","fallback"] },
    { analyzer: { evidence: ["E1"] }, reporter: { verdict: "winner", winner: "A", highlights: [{ evidence:"E1", observation:"second_higher" }] }, status:["verified","fallback"] },
  ];
  for (const example of examples) {
    let calls = 0;
    const saved = await store.finalize(input, {
      discover: async () => [inventory([model])],
      invoke: async () => assert.fail("report stages own inference"),
      reportStage: async () => reply(JSON.stringify(++calls === 1 ? example.analyzer : example.reporter)),
    }, new AbortController().signal, () => {});
    assert.ok(saved?.assistance);
    assert.equal(saved.winnerId, "a");
    assert.deepEqual([saved.assistance.analyzer.status, saved.assistance.reporter.status], example.status);
    assert.deepEqual(saved.assistance.citations, []);
    assert.equal(calls, example.reporter ? 2 : 1);
    assert.deepEqual(new RunReports(db).get(input), saved);
  }
  const offline = await store.finalize(input, {
    invoke: async () => assert.fail("offline cannot generate"),
    discover: async () => [], reportStage: () => assert.fail("offline should not call a model"),
  }, new AbortController().signal, () => {});
  assert.ok(offline?.assistance?.reason);
  assert.equal(offline.winnerId, "a");
  assert.equal(offline.assistance.analyzer.status, "skipped");
  assert.match(offline.assistance.reason, /No loaded local LFM3/);
});

test("a canceled local review cannot claim a completed comparison or save partial citations", async t => {
  const db = new DatabaseSync(":memory:"), store = new RunReports(db), controller = new AbortController();
  t.after(() => db.close());
  await assert.rejects(store.finalize(run(), {
    discover: async () => [inventory([{id:"ollama/lfm3-test",kind:"model",provider:"ollama",model:"lfm3-test",loaded:true}])],
    invoke: async () => assert.fail("report stages own inference"),
    reportStage: async () => { controller.abort(); throw Error("Canceled"); },
  }, controller.signal, () => {}), /abort/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_reports").get()?.n, 0);
});

test("challenging equal judge receipts scores a saved inspection decision independently without changing the original run",async t=>{
  const bench=new Bench(":memory:",{discover:async()=>[],invoke:async()=>assert.fail("A deterministic challenge called inference.")},withoutPower);
  t.after(()=>bench.db.close());
  const task=present(domainStarters.find(starter=>starter.packId==="manufacturing")).quickObjective;
  const original=run([1,1,1,1]);
  const m=original.manifest;
  Object.assign(m,{mode:"quick",pack:null,industry:"Manufacturing",caseIds:["prompt"],datasetId:null,datasetVersion:null,split:null,
    prompt:task,approvedPrompt:{...m.approvedPrompt,mode:"quick",objective:task,prompt:task,datasetId:null,packId:null},graders:[judge]});
  const outputs=[
    {disposition:"review",next_action:"send to quality for a signed recheck",shift_note_completes_disposition:false},
    {disposition:"accept",next_action:"None",shift_note_completes_disposition:false},
  ];
  bench.db.prepare("INSERT INTO runs VALUES(?,?,?,?)").run(m.id,m.created,"completed",JSON.stringify(m));
  for(const [index,c] of candidates.entries()){
    const result={...results[index*2],caseId:"prompt",output:JSON.stringify(outputs[index]),score:null,dispatchedMessages:[{role:"user",content:task}]};
    bench.db.prepare("INSERT INTO results VALUES(?,?,?,?)").run(m.id,c.id,"prompt",JSON.stringify(result));
    const receipt={...original.assessments[index*2],caseId:"prompt",value:1,pass:true,reason:"Original judge credited the disposition."};
    bench.db.prepare("INSERT INTO assessments VALUES(?,?,?,?,?,?)").run(receipt.id,m.id,c.id,"prompt",m.created,JSON.stringify(receipt));
  }
  const before=bench.detail(m.id),exported=bench.exportRun(m.id);
  assert.equal(before.report?.verdict,"tie");
  assert.equal(before.hasQuickExpectedAnswer,false);
  assert.equal(before.hasSourcedInspectionDecision,true);
  const request={run:m.id,caseId:"prompt",grader:inspectionRuleId};
  await assert.rejects(bench.reviewSavedCase({...request,expectedAnswer:'{"disposition":"accept"}'}),/evidence already saved/);
  await bench.reviewSavedCase(request);
  const saved=bench.detail(m.id),review=present(saved.savedReviews?.[0]);
  assert.equal(review.source,"saved run");
  assert.deepEqual(review.finding,{status:"higher",candidateId:candidates[0].id});
  assert.deepEqual(review.grades.map(g=>[g.candidate,g.value,g.pass]),[[candidates[0].id,1,true],[candidates[1].id,0,false]]);
  assert.match(review.grades[1].reason,/outside|chose accept/i);
  assert.equal(saved.reviewedVerdict,undefined);
  assert.deepEqual(saved.assessments,before.assessments);
  assert.deepEqual(saved.report,before.report);
  assert.deepEqual(bench.exportRun(m.id),exported);
  await assert.rejects(bench.reviewSavedCase({...request,grader:judge.id}),/different grader version/);
  await assert.rejects(bench.reviewSavedCase(request),/already scores/);
});

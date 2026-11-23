import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { OpikBaseModel, z } from "opik";
import { Graders } from "../lib/graders.cjs";
import type { LocalCandidate, RuntimeAdapters } from "../lib/runtime-types.cjs";
import { reply } from "./runtime-fixtures.cjs";
import { getOpikTemplate, opikLibraryTemplates, scoreOpikMetric, type OpikMetricKey } from "../lib/opik-library.cjs";
import type { GraderEvidence } from "../lib/grader-types.cjs";

class SyntheticJudge extends OpikBaseModel {
  readonly prompts: string[] = [];
  constructor(private readonly verdict: {reason: string | string[]; score?: number; answer_relevance_score?: number}) {
    super("local-synthetic-judge");
  }
  async generateString(prompt: string, schema?: Parameters<OpikBaseModel["generateString"]>[1]) {
    this.prompts.push(prompt);
    assert.ok(schema, "The native Opik evaluator requests a structured verdict");
    return JSON.stringify(schema.parse(this.verdict));
  }
  async generateProviderResponse(): Promise<never> {
    throw Error("Unexpected provider dispatch.");
  }
}

const input = "Report the result in inspection record LOT-17.";
const output = "LOT-17 passed final inspection.";
const reference = "LOT-17 met every inspection criterion on October 3.";
const evidence: GraderEvidence = {input, output, reference};

test("General Opik templates describe four fixed metrics without inventing judge revisions", () => {
  assert.deepEqual(opikLibraryTemplates.map(t => t.key).sort(), ["answer-relevance", "hallucination", "moderation", "usefulness"]);
  assert.deepEqual(opikLibraryTemplates.filter(t => t.requiresReference).map(t => t.key), ["hallucination"]);
  for (const template of opikLibraryTemplates) {
    assert.ok(template.criteria && template.docsUrl);
    assert.equal("judge" in template, false);
    assert.equal("id" in template, false);
  }
});

for (const key of ["answer-relevance", "usefulness", "hallucination", "moderation"] as const) {
  test("Opik " + key + " uses its native judge prompt, schema and score direction", async () => {
    const reason = "Evidence assessed for LOT-17.";
    const judge = new SyntheticJudge(key === "answer-relevance" ? {answer_relevance_score:0.25,reason} :
      {score:0.25,reason:key === "hallucination" ? [reason] : reason});
    const grade = await scoreOpikMetric(key, evidence, judge);
    assert.equal(judge.prompts.length, 1);
    const [prompt] = judge.prompts;
    assert.ok(prompt.includes(output));
    assert.equal(prompt.includes(input), key !== "moderation");
    assert.equal(prompt.includes(reference), key === "hallucination");
    const risk = key === "moderation" || key === "hallucination";
    assert.equal(grade.reason, reason);
    assert.equal(grade.value, risk ? 0.75 : 0.25);
    assert.deepEqual(grade.opikMetric, {metricKey:key, nativeScore:0.25, direction:risk ? "higher-is-risk" : "higher-is-better"});
  });
}

test("Hallucination leaves absent references unscored before inference and accepts structured reference facts", async () => {
  const judge = new SyntheticJudge({score:1, reason:"The answer contradicts the inspection record."});
  for (const missing of [undefined, null, "  ", {}, [], {fact:null}, [null, ""]]) {
    await assert.rejects(scoreOpikMetric("hallucination", {...evidence, reference:missing}, judge), /case reference/);
  }
  assert.equal(judge.prompts.length, 0);
  const grade = await scoreOpikMetric("hallucination", {...evidence, reference:{lot:"LOT-17", passed:false}}, judge);
  assert.equal(grade.value, 0);
  assert.equal(grade.opikMetric.nativeScore, 1);
  assert.ok(judge.prompts[0].includes("LOT-17") && judge.prompts[0].includes("false"));
});

test("An Opik risk of 0.8 yields exactly 0.2 quality at the inclusive pass threshold", async () => {
  const judge = new SyntheticJudge({score:0.8, reason:"The response includes an unsupported claim."});
  const result = await scoreOpikMetric("hallucination", evidence, judge);
  assert.equal(result.opikMetric.nativeScore, 0.8);
  assert.equal(result.value, 0.2);
});

test("Native metrics propagate missing inputs and judge failures as unscored", async () => {
  const judge = new SyntheticJudge({score:1, reason:""});
  for (const key of ["usefulness", "answer-relevance"] satisfies OpikMetricKey[]) {
    await assert.rejects(scoreOpikMetric(key, {...evidence, input:null}, judge), /case input/);
  }
  await assert.rejects(scoreOpikMetric("moderation", {...evidence, output:"  "}, judge), /candidate output/);
  assert.equal(judge.prompts.length, 0);
  await assert.rejects(scoreOpikMetric("moderation", evidence, judge), /no rationale/);
  assert.equal(getOpikTemplate("moderation").direction, "higher-is-risk");
});

test("A customer-pinned Opik metric dispatches the native schema locally and stores its native score in SQLite", async t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const grades = new Graders(db);
  const judge: LocalCandidate = {id:"lmstudio/local-inspector", model:"local-inspector", kind:"model", provider:"lmstudio", revision:"weights-17"};
  const template = getOpikTemplate("answer-relevance");
  const request = {intent:"create",name:"Inspection relevance",category:template.category,industry:"Manufacturing",
    type:"opik-metric",metricKey:template.key,threshold:0.7,judgeId:judge.id};
  assert.throws(() => grades.save(request,[]), /connected local judge/);
  assert.throws(() => grades.save({...request,criteria:"An unrelated custom rubric"},[judge]), /metric|criteria/i);
  const saved = grades.get(grades.save(request,[judge]));
  assert.equal(saved.type,"opik-metric");
  assert.equal(saved.judge?.revision,"weights-17");
  assert.equal(saved.library?.scope,"customer");
  const packet = {answer_relevance_score:0.75,reason:"The answer identifies the requested lot and its inspection result."};
  const schemas: unknown[] = [];
  const adapters:RuntimeAdapters = {
    discover: async () => [],
    invoke: async (candidate,messages,options) => {
      assert.equal(candidate.id,judge.id);
      assert.equal(candidate.revision,judge.revision);
      assert.equal(options.judging,true);
      assert.equal(messages.length,1);
      assert.ok(messages[0].content.includes(output));
      schemas.push(options.structured);
      return reply(JSON.stringify(packet));
    },
  };
  const entry = await grades.record(saved,evidence,{run:"run-17",candidate:"candidate",caseId:"lot-17"},adapters,new AbortController().signal);
  assert.deepEqual(schemas.map(s => z.object({properties:z.record(z.string(),z.unknown())}).parse(s).properties).map(Object.keys),
    [["answer_relevance_score","reason"]],entry.reason);
  assert.equal(entry.value,0.75,entry.reason);
  assert.equal(entry.pass,true);
  const [receipt] = grades.recorded("run-17");
  assert.equal(receipt.judge,judge.id);
  assert.deepEqual(receipt.opikMetric, {metricKey:template.key,nativeScore:0.75,direction:"higher-is-better"});
  assert.equal(receipt.evaluator,"opik-js@2.2.144 · answer-relevance");
});

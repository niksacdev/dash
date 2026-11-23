const test = require("node:test");
const assert = require("node:assert/strict");
const { createTokenBudget } = require("../lib/token-budget.cjs");

const candidate = { provider: "lmstudio", model: "station-qa", reasoningOff: true };
const messages = [
  { role: "system", content: "Identify the work order." },
  { role: "user", content: "Case WO-402 at station B7" },
];
const schema = { type: "object", properties: { workOrder: { type: "string" } } };

function fixture() {
  const calls = [];
  const model = {
    identifier: candidate.model,
    async applyPromptTemplate(chat) {
      return chat.map(m => `<${m.role}>${m.content}</${m.role}>`).join("") + "<assistant>";
    },
    async countTokens(text) {
      calls.push({ method: "count", text });
      return 41;
    },
    async respond(chat, options) {
      calls.push({ method: "respond", chat, options });
      options.onPredictionFragment({ content: "hidden", reasoningType: "reasoning" });
      options.onPredictionFragment({ content: "WO-402", reasoningType: "none" });
      return { stats: { promptTokensCount: 41, predictedTokensCount: 4, stopReason: "maxPredictedTokensReached" }, nonReasoningContent: "WO-402" };
    },
  };
  return { ...createTokenBudget(async () => [model]), calls };
}

test("uses the loaded tokenizer on complete rendered case and instructions, and blocks over the cap before inference", async () => {
  const f = fixture();
  await assert.rejects(f.checkInputBudget({ candidate, messages, cap: 40 }), /needs 41 input tokens.*cap is 40/);
  assert.deepEqual(f.calls, [{ method: "count", text: "<system>Identify the work order.</system><user>Case WO-402 at station B7</user><assistant>" }]);
});

test("dispatches the original messages once through the checked model with the exact output cap", async () => {
  const f = fixture(), seen = [];
  const inputBudget = await f.checkInputBudget({ candidate, messages, cap: 41 });
  const result = await f.invokeBudgeted(candidate, messages, { inputBudget, maxTokens: 4, structured: schema, onText: s => seen.push(s) });
  assert.deepEqual(Object.keys(inputBudget).sort(), ["source", "tokens"]);
  assert.equal(f.calls[1].chat, messages);
  assert.equal(f.calls[1].options.maxTokens, 4);
  assert.deepEqual(f.calls[1].options.structured.jsonSchema, schema);
  assert.deepEqual(seen, ["WO-402"]);
  assert.equal(result.telemetry.input_tokens, inputBudget.tokens);
  assert.equal(result.telemetry.output_tokens, 4);
  assert.equal(result.output, "WO-402");
  assert.equal(result.finishReason, "length");
});

test("a receipt cannot be reused for another case or another candidate", async () => {
  const f = fixture();
  const inputBudget = await f.checkInputBudget({ candidate, messages, cap: 42 });
  await assert.rejects(f.invokeBudgeted(candidate, [messages[0], { role: "user", content: "Different case" }], { inputBudget }), /changed/);
  await assert.rejects(f.invokeBudgeted({ ...candidate, model: "other" }, messages, { inputBudget }), /does not match/);
  await assert.rejects(f.invokeBudgeted(candidate, messages, { inputBudget: { ...inputBudget } }), /does not match/);
  assert.ok(f.calls.every(c => c.method !== "respond"));
});

test("unsupported tokenizer, unloaded instance and canceled preflight never generate", async () => {
  let loads = 0;
  const b = createTokenBudget(async () => { loads++; return []; });
  for (const provider of ["ollama", "compatible", "agent"]) {
    await assert.rejects(b.checkInputBudget({ candidate: { ...candidate, provider }, messages, cap: 9 }), /remove the input cap/);
  }
  assert.equal(await b.checkInputBudget({ candidate, messages, cap: null }), null);
  await assert.rejects(b.checkInputBudget({ candidate, messages, cap: 0 }), /positive whole/);
  await assert.rejects(b.checkInputBudget({ candidate, messages, cap: 10, signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(loads, 0);
  await assert.rejects(b.checkInputBudget({ candidate, messages, cap: 9 }), /Load station-qa/);
  assert.equal(loads, 1);
});


test("planning constrains generation on the loaded instance and forwards the stage cancellation signal", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const r = await f.invokePlanner(candidate, messages, { maxTokens: 400, signal, structured: schema });
  assert.equal(r.output, "WO-402");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.structured.jsonSchema, schema);
  assert.equal(f.calls[0].options.signal, signal);
  assert.equal(f.calls[0].options.reasoningBudget, 0);
  await assert.rejects(f.invokePlanner(candidate, messages, { maxTokens: 400, signal: AbortSignal.abort(), structured: schema }), { name: "AbortError" });
  assert.equal(f.calls.length, 1);
});

test("short visible replies use the same thinking-disabled template at preflight and dispatch", async () => {
  const base = {
    identifier: candidate.model, internalKVConfigStack: { layers: [] },
    predictionConfigInputToKVConfig(config) { return config; },
    async applyPromptTemplate() {
      const disable = this.internalKVConfigStack.layers.some(layer => layer.config.enableThinking === false);
      return disable ? "no-thinking-template" : "thinking-template";
    },
    async countTokens(raw) { return raw === "no-thinking-template" ? 12 : 15; },
    async getContextLength() { return 1024; },
    async respond(chat, options) {
      assert.equal(options.enableThinking, false);
      return { nonReasoningContent: "12 mm", reasoningContent: "", stats: { stopReason: "eosFound", promptTokensCount: 12, predictedTokensCount: 3 } };
    },
  };
  const b = createTokenBudget(async () => [base]);
  const receipt = await b.checkInputBudget({ candidate, messages, cap: 12, measureContext: true, disableThinking: true });
  assert.equal(receipt.tokens, 12);
  const run = await b.invokeBudgeted(candidate,messages,{inputBudget:receipt,maxTokens:384});
  assert.equal(run.output, "12 mm");
  assert.equal(run.telemetry.reasoning_control, "enableThinking=false");
  assert.equal(run.telemetry.reasoning_content_present, false);
  assert.deepEqual(base.internalKVConfigStack.layers, []);
  await assert.rejects(b.checkInputBudget({candidate,messages,cap:12,measureContext:true}), /needs 15 input tokens/);
});

import { test, type TestContext } from "node:test";
import assert = require("node:assert/strict");
import { LMStudioClient, type LLMRespondOpts, type LLMPredictionStats } from "@lmstudio/sdk";
import { createTokenBudget, invokeJudge } from "../lib/token-budget.cjs";
import { isRecord, type ChatTurn, type LocalCandidate } from "../lib/runtime-types.cjs";

const candidate: LocalCandidate = { id:"lmstudio/station-qa", kind:"model", provider:"lmstudio", model:"station-qa", reasoningOff:true };
const messages: ChatTurn[] = [
  { role:"system", content:"Identify the work order." },
  { role:"user", content:"Case WO-402 at station B7" },
];
const schema = { type: "object", properties: { workOrder: { type: "string" } } };
const signal = new AbortController().signal;
type ResponseCall = { method:"respond"; chat:ChatTurn[]; options:LLMRespondOpts };
type Call = { method:"count"; text:string } | ResponseCall;
interface SimulatedResponse {
  stats: LLMPredictionStats;
  nonReasoningContent: string;
  reasoningContent?: string;
}
interface SimulatedRuntime {
  template: (this: unknown, chat: ChatTurn[]) => string;
  count: (text:string) => number;
  context: number;
  respond: (chat:ChatTurn[], opts:LLMRespondOpts) => SimulatedResponse;
}

// Use a genuine SDK handle and namespace. Mock only the methods that would
// contact LM Studio, including the namespace lookup used by the judge path.
function sdkFixture(t: TestContext, identifier: string, simulated: SimulatedRuntime) {
  const client = new LMStudioClient({ baseUrl:"ws://127.0.0.1:1234" });
  t.after(() => client[Symbol.asyncDispose]());
  const model = Object.assign(client.llm.createDynamicHandle(identifier), { identifier });
  t.mock.method(model, "applyPromptTemplate", async function(this: unknown, chat: ChatTurn[]) {
    return simulated.template.call(this, chat);
  });
  t.mock.method(model, "countTokens", async (text:string) => simulated.count(text));
  t.mock.method(model, "getContextLength", async () => simulated.context);
  t.mock.method(model, "respond", async (chat:ChatTurn[], opts:LLMRespondOpts) => simulated.respond(chat,opts));
  t.mock.method(client.llm, "model", async (key:string) => { assert.equal(key,identifier); return model; });
  return { model, llm:client.llm };
}
function responseCall(calls: Call[], index: number): ResponseCall {
  const call = calls[index];
  assert.ok(call?.method === "respond");
  return call;
}
function responseSchema(opts: LLMRespondOpts): Record<string, unknown> {
  const structured: unknown = opts.structured;
  assert.ok(isRecord(structured) && isRecord(structured.jsonSchema));
  return structured.jsonSchema;
}
function fixture(t: TestContext) {
  const calls: Call[] = [];
  const { model } = sdkFixture(t, candidate.model, {
    template(chat) { return chat.map(m => `<${m.role}>${m.content}</${m.role}>`).join("") + "<assistant>"; },
    count(text) { calls.push({method:"count", text}); return 41; },
    context: 1024,
    respond(chat, options) {
      calls.push({method:"respond", chat, options});
      assert.ok(options.onPredictionFragment);
      options.onPredictionFragment({content:"hidden",tokensCount:1,containsDrafted:false,isStructural:false,reasoningType:"reasoning"});
      options.onPredictionFragment({content:"WO-402",tokensCount:3,containsDrafted:false,isStructural:false,reasoningType:"none"});
      return {stats:{promptTokensCount:41,predictedTokensCount:4,stopReason:"maxPredictedTokensReached"},nonReasoningContent:"WO-402"};
    },
  });
  return { ...createTokenBudget(async () => [model]), calls };
}

test("uses the loaded tokenizer on complete rendered case and instructions, and blocks over the cap before inference", async t => {
  const f = fixture(t);
  await assert.rejects(f.checkInputBudget({ candidate, messages, cap: 40 }), /needs 41 input tokens.*cap is 40/);
  assert.deepEqual(f.calls, [{ method: "count", text: "<system>Identify the work order.</system><user>Case WO-402 at station B7</user><assistant>" }]);
});

test("dispatches the original messages once through the checked model with the exact output cap", async t => {
  const f = fixture(t), seen: string[] = [];
  const inputBudget = await f.checkInputBudget({ candidate, messages, cap: 41 });
  assert.ok(inputBudget);
  const result = await f.invokeBudgeted(candidate, messages, { signal, inputBudget, maxTokens: 4, structured: schema, onText: s => seen.push(s) });
  assert.deepEqual(Object.keys(inputBudget).sort(), ["source", "tokens"]);
  assert.equal(responseCall(f.calls,1).chat, messages);
  assert.equal(responseCall(f.calls,1).options.maxTokens, 4);
  assert.deepEqual(responseSchema(responseCall(f.calls,1).options), schema);
  assert.deepEqual(seen, ["WO-402"]);
  assert.equal(result.telemetry.input_tokens, inputBudget.tokens);
  assert.equal(result.telemetry.output_tokens, 4);
  assert.equal(result.output, "WO-402");
  assert.equal(result.finishReason, "length");
});

test("a receipt cannot be reused for another case or another candidate", async t => {
  const f = fixture(t);
  const inputBudget = await f.checkInputBudget({ candidate, messages, cap: 42 });
  assert.ok(inputBudget);
  await assert.rejects(f.invokeBudgeted(candidate, [messages[0], { role: "user", content: "Different case" }], { inputBudget, maxTokens:4, signal }), /changed/);
  await assert.rejects(f.invokeBudgeted({ ...candidate, model: "other" }, messages, { inputBudget, maxTokens:4, signal }), /does not match/);
  await assert.rejects(f.invokeBudgeted(candidate, messages, { inputBudget: { ...inputBudget }, maxTokens:4, signal }), /does not match/);
  assert.ok(f.calls.every(c => c.method !== "respond"));
});

test("unsupported tokenizer, unloaded instance and canceled preflight never generate", async () => {
  let loads = 0;
  const b = createTokenBudget(async () => { loads++; return []; });
  for (const provider of ["ollama", "compatible", "agent"]) {
    // Exercise the JavaScript runtime boundary, including an unknown provider.
    const attempt: unknown = Reflect.apply(b.checkInputBudget, undefined, [{ candidate:{...candidate,provider}, messages, cap:9 }]);
    assert.ok(attempt instanceof Promise);
    await assert.rejects(attempt, /remove the input cap/);
  }
  assert.equal(await b.checkInputBudget({ candidate, messages, cap: null }), null);
  await assert.rejects(b.checkInputBudget({ candidate, messages, cap: 0 }), /positive whole/);
  await assert.rejects(b.checkInputBudget({ candidate, messages, cap: 10, signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(loads, 0);
  await assert.rejects(b.checkInputBudget({ candidate, messages, cap: 9 }), /Load station-qa/);
  assert.equal(loads, 1);
});


test("planning constrains generation on the loaded instance and forwards the stage cancellation signal", async t => {
  const f = fixture(t);
  const signal = new AbortController().signal;
  const r = await f.invokePlanner(candidate, messages, { maxTokens: 400, signal, structured: schema });
  assert.equal(r.output, "WO-402");
  assert.equal(f.calls.length, 1);
  assert.equal(responseSchema(responseCall(f.calls,0).options), schema);
  assert.equal(responseCall(f.calls,0).options.signal, signal);
  assert.equal(responseCall(f.calls,0).options.reasoningBudget, 0);
  await assert.rejects(f.invokePlanner(candidate, messages, { maxTokens: 400, signal: AbortSignal.abort(), structured: schema }), { name: "AbortError" });
  assert.equal(f.calls.length, 1);
});

test("short visible replies use the same thinking-disabled template at preflight and dispatch", async t => {
  function layers(handle: unknown): unknown[] {
    assert.ok(isRecord(handle) && isRecord(handle.internalKVConfigStack) && Array.isArray(handle.internalKVConfigStack.layers));
    return handle.internalKVConfigStack.layers;
  }
  const {model:base} = sdkFixture(t, candidate.model, {
    template() {
      const disabled = layers(this).some(layer => isRecord(layer) && isRecord(layer.config) &&
        Array.isArray(layer.config.fields) && layer.config.fields.some((field:unknown) =>
          isRecord(field) && typeof field.key === "string" && field.key.endsWith("enableThinking") && field.value === false));
      return disabled ? "no-thinking-template" : "thinking-template";
    },
    count: text => text === "no-thinking-template" ? 12 : 15,
    context:1024,
    respond(_chat, options) {
      assert.equal(options.enableThinking,false);
      return {nonReasoningContent:"12 mm",reasoningContent:"",stats:{stopReason:"eosFound",promptTokensCount:12,predictedTokensCount:3}};
    },
  });
  const b = createTokenBudget(async () => [base]);
  const receipt = await b.checkInputBudget({ candidate, messages, cap: 12, measureContext: true, disableThinking: true });
  assert.ok(receipt);
  assert.equal(receipt.tokens, 12);
  const run = await b.invokeBudgeted(candidate,messages,{signal,inputBudget:receipt,maxTokens:384});
  assert.equal(run.output, "12 mm");
  assert.equal(run.telemetry.reasoning_control, "enableThinking=false");
  assert.equal(run.telemetry.reasoning_content_present, false);
  assert.deepEqual(layers(base), []);
  await assert.rejects(b.checkInputBudget({candidate,messages,cap:12,measureContext:true}), /needs 15 input tokens/);
});

test("Opik checklist and verdict use the measured one-turn chat template and fit the active judge context",async t=>{
  const calls: ResponseCall[] = [];
  const {llm} = sdkFixture(t, "qa", {
    template:chat=>JSON.stringify(chat), count:()=>31, context:128,
    respond(chat,opts){
      calls.push({method:"respond",chat,options:opts});
      const properties = responseSchema(opts).properties;
      assert.ok(isRecord(properties));
      return {nonReasoningContent:properties.steps?'{"steps":["Compare the measurement."]}':'{"score":10,"reason":"Within limits."}',
        stats:{promptTokensCount:31,predictedTokensCount:12,stopReason:"eosFound"}};
    },
  });
  const j: LocalCandidate={id:"lmstudio/qa",kind:"model",provider:"lmstudio",model:"qa",maxOutputTokens:100};
  const prompt: ChatTurn[]=[{role:"user",content:"Assess the lot."}],opts={maxTokens:1024,signal:AbortSignal.timeout(2000)};
  const checklist=await invokeJudge(j,prompt,opts,llm);
  assert.equal(checklist.output,"Compare the measurement.");
  assert.equal(calls[0].options.maxTokens,97);
  assert.equal(calls[0].chat.length,1);
  assert.match(calls[0].chat[0].content,/steps array/);
  assert.equal(prompt[0].content,"Assess the lot.");
  const schema={type:"object",properties:{score:{type:"integer"}}};
  const verdict=await invokeJudge(j,prompt,{...opts,structured:schema},llm);
  assert.deepEqual(calls[1].chat,prompt);
  assert.deepEqual(responseSchema(calls[1].options),schema);
  const score: unknown = JSON.parse(verdict.output);
  assert.ok(isRecord(score));
  assert.equal(score.score,10);
});

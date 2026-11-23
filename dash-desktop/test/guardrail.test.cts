import { test } from "node:test";
import assert = require("node:assert/strict");
import { assessCase, lengthFailure, GuardrailError, reasoningPolicy, autoOutputTarget } from "../lib/guardrail.cjs";
import type { ChatTurn, LocalCandidate, CompatibleCandidate, CheckInputBudget } from "../lib/runtime-types.cjs";

const candidate: LocalCandidate = { id:"lmstudio/reasoner", kind:"model", model: "reasoner", provider: "lmstudio", loaded: true, maxContextTokens: 262144 };
const signal = new AbortController().signal;
const messages: ChatTurn[] = [{ role: "user", content: "Preserve my  approved prompt\nexactly." }];

function assess(options: Partial<Parameters<typeof assessCase>[0]> = {}) {
  return assessCase({
    candidate, messages, signal, defaultOutput: 2048, budget: {},
    checkInputBudget: async () => ({ tokens: 750, contextTokens: 32000, source: "test tokenizer" }),
    ...options,
  });
}

test("auto allocation uses the measured active context and available output ceiling", async () => {
  assert.equal((await assess()).guardrail.outputReserve, 8192);
  const check = await assess({ candidate: { ...candidate, maxOutputTokens: 3000 } });
  assert.equal(check.guardrail.maxOutputTokens, 3000);
  assert.equal(check.guardrail.outputReserve, 3000);
  assert.equal(check.guardrail.contextTokens, 32000);
  assert.equal(check.guardrail.inputTokens, 750);
  assert.equal(check.guardrail.status, "verified");
  assert.equal(check.preparedMessages, null);
  const short = await assess({ checkInputBudget: async () => ({ tokens: 900, contextTokens: 1024, source: "live" }) });
  assert.equal(short.guardrail.outputReserve, 124);
  assert.equal(short.guardrail.maxOutputTokens, null);
});

test("explicit caps are honored exactly or fail before dispatch with a reproducible reason", async () => {
  assert.equal((await assess({ budget:{ inputCap:800, outputCap:40 } })).guardrail.outputReserve, 40);
  await assert.rejects(assess({ budget:{ inputCap:10 } }), (e: unknown) =>
    e instanceof GuardrailError && e.guardrail.status === "blocked" && e.guardrail.inputTokens === 750 && /approve a shorter prompt/.test(e.message));
  await assert.rejects(assess({ budget:{ outputCap:32000 } }), (e: unknown) =>
    e instanceof GuardrailError && e.guardrail.contextTokens === 32000 && /31250 for output/.test(e.message));
  await assert.rejects(assess({ candidate:{ ...candidate, maxOutputTokens:500 }, budget:{ outputCap:501 } }), /ceiling of 500/);
  await assert.rejects(assess({ checkInputBudget: async () => ({ tokens: 1024, contextTokens: 1024, source:"test tokenizer" }) }), /larger context/);
});

test("unsupported runtimes never claim exact tokenization or use a published maximum as their active context", async () => {
  const unknown: CompatibleCandidate = { id:"compatible/remote", kind:"model", endpoint:"https://example.invalid/v1", section:"Hosted", keyRequired:false, model:"remote", provider:"compatible", maxContextTokens:100000 };
  const r = await assess({ candidate:unknown });
  assert.equal(r.guardrail.status, "unverified");
  assert.equal(r.guardrail.contextTokens, null);
  assert.equal(r.guardrail.inputTokens, null);
  assert.equal(r.receipt, null);
  await assert.rejects(assess({ candidate:unknown, budget:{inputCap:100} }), /strict input limit/);
  assert.equal((await assess({ candidate:{ ...unknown, maxOutputTokens:700 } })).guardrail.outputReserve, 700);
});

test("compacts only case-envelope whitespace without changing quotation, duplicate fields, numbers or approved instructions", async () => {
  const system: ChatTurn = { role: "system", content: "  Cite the exact  text.\n" };
  const source = '{\n  "n": 1.00, "n": 1e+3, "input": { "evidence": "t  a\\n\\" sample" }\n}';
  const chat: ChatTurn[] = [system, { role:"user", content:source }];
  const observed: ChatTurn[][] = [];
  const checkInputBudget: CheckInputBudget = async ({ messages, measureContext }) => {
    assert.equal(measureContext, true);
    observed.push(messages);
    return { tokens:6, contextTokens:10000, source:"test" };
  };
  const r = await assess({ serializedCaseInput:true, messages: chat, checkInputBudget });
  const [seen] = observed;
  assert.ok(seen);
  assert.equal(r.preparedMessages, seen);
  assert.equal(seen[0], system);
  assert.equal(seen[1].content, '{"n":1.00,"n":1e+3,"input":{"evidence":"t  a\\n\\" sample"}}');
  assert.equal(chat[1].content, source);
  assert.deepEqual(JSON.parse(seen[1].content), JSON.parse(source));
  assert.ok(r.guardrail.inputOptimization.charactersSaved > 0);
  assert.equal(r.guardrail.inputOptimization.status, "compacted");
  const again = await assess({ serializedCaseInput:true, messages:seen });
  assert.deepEqual(again.guardrail.inputOptimization, { status:"already_compact", charactersSaved:0 });
  const quick = await assess({ messages:chat });
  assert.equal(quick.preparedMessages, null);
  assert.equal(quick.guardrail.inputOptimization.status, "preserved");
});

test("truncated output retains context on the effective reserve and next action", async () => {
  const reason = lengthFailure((await assess()).guardrail, { output_tokens:8192 });
  assert.match(reason, /8192 generated tokens/);
  assert.match(reason, /saved without a score/);
  assert.match(reason, /shorter answer/);
});


test("authored reference messages, plain-text prefixes and JSON examples are preserved byte for byte", async () => {
  const messages: ChatTurn[] = [
    { role: "system", content: "Use the source  as-is." },
    { role: "user", content: 'Please explain  this case.\n\n{"input": 99}' },
  ];
  assert.equal((await assess({ messages, serializedCaseInput: true })).preparedMessages, null);
  const jsonExample: ChatTurn[] = [messages[0], { role: "user", content: '{ "input": 99 }' }];
  assert.equal((await assess({ messages:jsonExample, serializedCaseInput:false })).preparedMessages, null);
});

test("short-answer thinking control is specific to verified Quick calls with an advertised off switch", async () => {
  assert.equal(autoOutputTarget, 8192);
  const model = { ...candidate, reasoningOff: true };
  const opts: Parameters<typeof reasoningPolicy>[1] = { mode: "quick", outputCap: 384, verifiedAdapter: true };
  assert.equal(reasoningPolicy(model, opts), "thinking disabled for short answer");
  for (const overrides of [{ outputCap: null }, { outputCap: 8192 }, { verifiedAdapter: false }, { mode: "dataset" }] as const)
    assert.equal(reasoningPolicy(model, { ...opts, ...overrides }), "runtime default");
  assert.equal(reasoningPolicy({ ...model, reasoningOff:false }, opts), "runtime default");
  let disabled: boolean | undefined;
  await assess({ candidate:model, mode:"quick", budget:{outputCap:384}, checkInputBudget:async args=>{
    disabled = args.disableThinking;
    return { tokens:20, contextTokens:4096, source:"test" };
  } });
  assert.equal(disabled, true);
});

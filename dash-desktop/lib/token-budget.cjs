const { createHash } = require("node:crypto");

let client;
function lmClient() {
  const { LMStudioClient } = require("@lmstudio/sdk");
  client ??= new LMStudioClient({ baseUrl: "ws://127.0.0.1:1234" });
  return client;
}

const loadedModels = () => lmClient().llm.listLoaded();

// In SDK 2.1.0 applyPromptTemplate() has no prediction-options argument.
// Its formatter reads the instance's config stack. Scope a copy to this one
// receipt using the SDK's own config converter. Keep the shared handle and
// the LM Studio session's model defaults untouched. Fail closed on SDK drift.
function withoutThinking(model) {
  if (!Array.isArray(model.internalKVConfigStack?.layers) || typeof model.predictionConfigInputToKVConfig !== "function")
    throw Error("This LM Studio SDK cannot verify the thinking-disabled prompt template. Update DASH or increase the output cap.");
  const config = model.predictionConfigInputToKVConfig({ enableThinking: false });
  return Object.create(model, {
    internalKVConfigStack: { value: { layers: [...model.internalKVConfigStack.layers, { layerName: "apiOverride", config }] } },
  });
}

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

// The SDK's template and tokenizer RPCs do not accept a cancellation signal.
function untilAborted(work, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function createTokenBudget(listLoaded) {
  // Only the count and its provenance belong in run history. Keep the actual
  // instance and rendered-text fingerprint private to the main process.
  const receipts = new WeakMap();

  async function checkInputBudget({ candidate, messages, cap, signal, measureContext = false, disableThinking = false }) {
    if (cap == null && !measureContext) return null;
    if (cap != null && (!Number.isSafeInteger(cap) || cap < 1)) throw Error("Input budget must be a positive whole number of tokens.");
    if (candidate.provider !== "lmstudio")
      throw Error(`DASH cannot verify an input cap for ${candidate.model || candidate.id} on this connection. Choose a loaded LM Studio model or remove the input cap.`);
    const timeout = AbortSignal.timeout(15000);
    const limit = signal ? AbortSignal.any([signal, timeout]) : timeout;
    limit.throwIfAborted();

    let model, formatted, tokens, contextTokens;
    try {
      const models = await untilAborted(listLoaded(), limit);
      model = models.find(item => item.identifier === candidate.model);
      if (model) {
        if (disableThinking) model = withoutThinking(model);
        formatted = await untilAborted(model.applyPromptTemplate(messages), limit);
        tokens = await untilAborted(model.countTokens(formatted), limit);
        if (measureContext) {
          contextTokens = await untilAborted(model.getContextLength(), limit);
          if (!Number.isSafeInteger(contextTokens) || contextTokens < 1)
            throw Error("LM Studio did not report a valid active context length.");
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      throw Error(`LM Studio could not count the complete input for ${candidate.model}. Check its connection and chat template, or remove the input cap. ${error.message}`);
    }
    if (!model)
      throw Error(`Load ${candidate.model} in LM Studio before using an input cap, or remove the cap.`);
    if (!Number.isSafeInteger(tokens) || tokens < 0)
      throw Error(`LM Studio returned an invalid input count for ${candidate.model}.`);
    if (cap != null && tokens > cap) {
      const error = Error(`${candidate.model} needs ${tokens} input tokens after applying its chat template. The cap is ${cap}. Shorten the input or raise the cap.`);
      error.inputTokens = tokens;
      error.contextTokens = contextTokens;
      throw error;
    }

    const receipt = Object.freeze({ tokens, ...(measureContext ? { contextTokens } : {}), source: "LM Studio model tokenizer and chat template" });
    receipts.set(receipt, { model, fingerprint: digest(formatted), disableThinking });
    return receipt;
  }

  async function invokeBudgeted(candidate, messages, { inputBudget, maxTokens, signal, structured, onText }) {
    const checked = receipts.get(inputBudget);
    if (!checked || candidate.provider !== "lmstudio" || checked.model.identifier !== candidate.model)
      throw Error("The token check does not match this model. Run the input check again.");

    const idle = new AbortController();
    const limit = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
    limit.throwIfAborted();
    const { model } = checked;
    const templateLimit = AbortSignal.any([limit, AbortSignal.timeout(15000)]);
    const rendered = await untilAborted(model.applyPromptTemplate(messages), templateLimit);
    if (digest(rendered) !== checked.fingerprint)
      throw Error("The case input or model template changed after the token check. Run the input check again.");
    limit.throwIfAborted();

    // A long response that is still emitting tokens must survive the old
    // three-minute request timeout. A silent/stalled runtime remains bounded.
    const stall = setTimeout(() => idle.abort(Error("LM Studio stopped reporting prediction progress for three minutes.")), 180000);
    try {
      return await predict(model, candidate, messages, {
        limit, maxTokens, structured, onText, disableThinking: checked.disableThinking, expectedTokens: inputBudget.tokens, progress: () => stall.refresh(),
      });
    } finally {
      clearTimeout(stall);
    }
  }

  async function invokePlanner(candidate, messages, { maxTokens, signal, structured }) {
    signal.throwIfAborted();
    if (!structured) throw Error("The planning stage requires a response schema.");
    const models = await untilAborted(listLoaded(), signal);
    const model = models.find(item => item.identifier === candidate.model);
    if (!model) throw Error(`Load ${candidate.model} in LM Studio before preparing a prompt.`);
    return predict(model, candidate, messages, { limit: signal, maxTokens, structured });
  }

  async function predict(model, candidate, messages, { limit, maxTokens, structured, onText, disableThinking = false, expectedTokens, progress }) {
    limit.throwIfAborted();
    const start = performance.now();
    let output = "", firstTokenMs = null;
    const options = {
      signal: limit, temperature: 0, maxTokens, contextOverflowPolicy: "stopAtLimit",
      onPromptProcessingProgress: progress,
      onPredictionFragment(fragment) {
        progress?.();
        if (fragment.reasoningType && fragment.reasoningType !== "none") return;
        if (!fragment.content) return;
        firstTokenMs ??= Math.round(performance.now() - start);
        output += fragment.content;
        onText?.(output);
      },
    };
    if (disableThinking) options.enableThinking = false;
    if (structured) {
      options.structured = { type: "json", jsonSchema: structured };
      if (candidate.reasoningOff) options.reasoningBudget = 0;
    }
    // respond takes semantic turns. Passing rendered text here would apply
    // the template twice and change both the input and its token count.
    const result = await untilAborted(Promise.resolve(model.respond(messages, options)), limit);
    limit.throwIfAborted();
    const stats = result.stats;
    if (["failed", "modelUnloaded", "userStopped"].includes(stats.stopReason))
      throw Error(`LM Studio stopped the prediction (${stats.stopReason}).`);
    if (expectedTokens != null && stats.promptTokensCount !== expectedTokens)
      throw Error(`LM Studio reported ${stats.promptTokensCount ?? "unknown"} input tokens after verifying ${expectedTokens}. The run cannot be scored. Check the model's runtime and template.`);
    return {
      output: result.nonReasoningContent,
      finishReason: ["maxPredictedTokensReached", "contextLengthReached"].includes(stats.stopReason) ? "length" : "stop",
      telemetry: {
        latency_ms: Math.round(performance.now() - start),
        first_token_ms: firstTokenMs,
        provider_first_token_ms: Number.isFinite(stats.timeToFirstTokenSec) ? stats.timeToFirstTokenSec * 1000 : null,
        input_tokens: stats.promptTokensCount,
        output_tokens: stats.predictedTokensCount ?? null,
        tokens_per_second: stats.tokensPerSecond ?? null,
        runtime_stop_reason: stats.stopReason,
        reasoning_control: disableThinking ? "enableThinking=false" : options.reasoningBudget === 0 ? "reasoningBudget=0" : "runtime default",
        reasoning_content_present: !!result.reasoningContent,
        model_instance_id: model.identifier,
      },
    };
  }

  return { checkInputBudget, invokeBudgeted, invokePlanner };
}

// Opik supplies its own chat turns for both G-Eval stages. Measure and dispatch those exact
// turns through the chosen model's template, including a one-turn scoring request.
async function invokeJudge(candidate, messages, { maxTokens, signal, structured }, llm = lmClient().llm) {
  const model = await llm.model(candidate.model, { signal });
  const active = { ...candidate, model:model.identifier };
  const scoped = createTokenBudget(async () => [model]);
  const checklist = !structured;
  if (checklist) {
    // The SDK's first G-Eval stage asks for a reusable evaluation checklist.
    // Bound its representation for small models, then return plain steps to Opik.
    structured = {type:"object", additionalProperties:false, required:["steps"], properties:{
      steps:{type:"array", minItems:1, maxItems:4, items:{type:"string", minLength:1, maxLength:160}},
    }};
    messages = messages.map((turn, i) => i === messages.length - 1
      ? {...turn, content:turn.content + "\nReturn a JSON object with a steps array. Write one brief, observable check per step."} : turn);
  }
  const inputBudget = await scoped.checkInputBudget({
    candidate:active, messages, measureContext:true, disableThinking:!!candidate.reasoningOff, signal,
  });
  const room = inputBudget.contextTokens - inputBudget.tokens;
  if (room < 1) throw Error("The judge input fills the active model context. Choose a judge with a larger context.");
  const response = await scoped.invokeBudgeted(active, messages, {
    inputBudget, maxTokens:Math.min(room, maxTokens, candidate.maxOutputTokens || maxTokens), signal, structured,
  });
  if (checklist && response.finishReason !== "length") {
    const {steps} = JSON.parse(response.output);
    if (!Array.isArray(steps) || !steps.length || steps.some(step=>typeof step!=="string" || !step.trim()))
      throw Error("The local Opik judge returned an invalid evaluation checklist.");
    response.output = steps.join("\n");
  }
  return response;
}

module.exports = { ...createTokenBudget(loadedModels), createTokenBudget, invokeJudge };

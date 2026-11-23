import { createHash } from "node:crypto";
import type { LLM, LLMNamespace, LMStudioClient, LLMRespondOpts } from "@lmstudio/sdk";
import { errorText, isRecord, type Candidate, type ChatTurn, type InferenceResult, type InvokeOptions,
  type OutputSchema, type TokenCheck, type TokenReceipt } from "./runtime-types.cjs";

let client: Promise<LMStudioClient> | undefined;
function lmClient(): Promise<LMStudioClient> {
  client ??= import("@lmstudio/sdk").then(({ LMStudioClient }) => new LMStudioClient({ baseUrl: "ws://127.0.0.1:1234" }));
  return client;
}
type ModelHandle = Pick<LLM, "identifier" | "applyPromptTemplate" | "countTokens" | "getContextLength" | "respond">;
const loadedModels = async (): Promise<ModelHandle[]> => (await lmClient()).llm.listLoaded();

interface CheckedInput { model: ModelHandle; fingerprint: string; disableThinking: boolean }
type CallOptions = Pick<InvokeOptions, "structured" | "onText" | "signal"> & { maxTokens: number };
interface PredictionOptions {
  limit: AbortSignal; maxTokens: number; structured?: OutputSchema | null; onText?: (text: string) => void;
  disableThinking?: boolean; expectedTokens?: number; progress?: () => void;
}
class InputCapError extends Error {
  constructor(message: string, readonly inputTokens: number, readonly contextTokens?: number) { super(message); }
}
// In SDK 2.1.0 applyPromptTemplate() has no prediction-options argument.
// Its formatter reads the instance's config stack. Scope a copy to this one
// receipt using the SDK's own config converter. Keep the shared handle and
// the LM Studio session's model defaults untouched. Fail closed on SDK drift.
function withoutThinking(model: ModelHandle): ModelHandle {
  const internal: unknown = model;
  if (!isRecord(internal) || !isRecord(internal.internalKVConfigStack) || !Array.isArray(internal.internalKVConfigStack.layers) ||
      typeof internal.predictionConfigInputToKVConfig !== "function")
    throw Error("This LM Studio SDK cannot verify the thinking-disabled prompt template. Update DASH or increase the output cap.");
  const config: unknown = internal.predictionConfigInputToKVConfig({ enableThinking: false });
  if (!isRecord(config)) throw Error("The LM Studio SDK returned an invalid prediction configuration.");
  const stack = { layers: [...internal.internalKVConfigStack.layers, { layerName: "apiOverride", config }] };
  return new Proxy(model, {
    get(target, key, receiver) { return key === "internalKVConfigStack" ? stack : Reflect.get(target, key, receiver); },
  });
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// The SDK's template and tokenizer RPCs do not accept a cancellation signal.
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createTokenBudget(listLoaded: () => Promise<ModelHandle[]>) {
  // Only the count and its provenance belong in run history. Keep the actual
  // instance and rendered-text fingerprint private to the main process.
  const receipts = new WeakMap<TokenReceipt, CheckedInput>();

  async function checkInputBudget({ candidate, messages, cap, signal, measureContext = false, disableThinking = false }: TokenCheck): Promise<TokenReceipt | null> {
    if (cap == null && !measureContext) return null;
    if (cap != null && (!Number.isSafeInteger(cap) || cap < 1)) throw Error("Input budget must be a positive whole number of tokens.");
    if (candidate.provider !== "lmstudio")
      throw Error(`DASH cannot verify an input cap for ${candidate.model || candidate.id} on this connection. Choose a loaded LM Studio model or remove the input cap.`);
    const timeout = AbortSignal.timeout(15000);
    const limit = signal ? AbortSignal.any([signal, timeout]) : timeout;
    limit.throwIfAborted();

    let model: ModelHandle | undefined, formatted: string | undefined, tokens: number | undefined, contextTokens: number | undefined;
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
      throw Error(`LM Studio could not count the complete input for ${candidate.model}. Check its connection and chat template, or remove the input cap. ${errorText(error)}`);
    }
    if (!model)
      throw Error(`Load ${candidate.model} in LM Studio before using an input cap, or remove the cap.`);
    if (typeof formatted !== "string" || typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0)
      throw Error(`LM Studio returned an invalid input count for ${candidate.model}.`);
    if (cap != null && tokens > cap) {
      throw new InputCapError(`${candidate.model} needs ${tokens} input tokens after applying its chat template. The cap is ${cap}. Shorten the input or raise the cap.`, tokens, contextTokens);
    }

    const receipt = Object.freeze({ tokens, ...(measureContext ? { contextTokens } : {}), source: "LM Studio model tokenizer and chat template" });
    receipts.set(receipt, { model, fingerprint: digest(formatted), disableThinking });
    return receipt;
  }

  async function invokeBudgeted(candidate: Candidate, messages: ChatTurn[], { inputBudget, maxTokens, signal, structured, onText }: CallOptions & { inputBudget: TokenReceipt }): Promise<InferenceResult> {
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

  async function invokePlanner(candidate: Candidate, messages: ChatTurn[], { maxTokens, signal, structured }: CallOptions): Promise<InferenceResult> {
    signal.throwIfAborted();
    if (!structured) throw Error("The planning stage requires a response schema.");
    const models = await untilAborted(listLoaded(), signal);
    const model = models.find(item => item.identifier === candidate.model);
    if (!model) throw Error(`Load ${candidate.model} in LM Studio before preparing a prompt.`);
    return predict(model, candidate, messages, { limit: signal, maxTokens, structured });
  }

  async function predict(model: ModelHandle, candidate: Candidate, messages: ChatTurn[], { limit, maxTokens, structured, onText, disableThinking = false, expectedTokens, progress }: PredictionOptions): Promise<InferenceResult> {
    limit.throwIfAborted();
    const start = performance.now();
    let output = "", firstTokenMs: number | null = null;
    const options: LLMRespondOpts = {
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
        provider_first_token_ms: stats.timeToFirstTokenSec !== undefined && Number.isFinite(stats.timeToFirstTokenSec) ? stats.timeToFirstTokenSec * 1000 : null,
        input_tokens: stats.promptTokensCount ?? null,
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
export async function invokeJudge(candidate: Candidate, messages: ChatTurn[], { maxTokens, signal, structured }: CallOptions, llm?: Pick<LLMNamespace, "model">): Promise<InferenceResult> {
  const local = llm ?? (await lmClient()).llm;
  const model = await local.model(candidate.model, { signal });
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
  if (!inputBudget?.contextTokens) throw Error("The runtime did not report its active judge context.");
  const room = inputBudget.contextTokens - inputBudget.tokens;
  if (room < 1) throw Error("The judge input fills the active model context. Choose a judge with a larger context.");
  const response = await scoped.invokeBudgeted(active, messages, {
    inputBudget, maxTokens:Math.min(room, maxTokens, candidate.maxOutputTokens || maxTokens), signal, structured,
  });
  if (checklist && response.finishReason !== "length") {
    const record: unknown = JSON.parse(response.output);
    const steps = isRecord(record) ? record.steps : null;
    if (!Array.isArray(steps) || !steps.length || steps.some(step=>typeof step!=="string" || !step.trim()))
      throw Error("The local Opik judge returned an invalid evaluation checklist.");
    response.output = steps.join("\n");
  }
  return response;
}

export const { checkInputBudget, invokeBudgeted, invokePlanner } = createTokenBudget(loadedModels);

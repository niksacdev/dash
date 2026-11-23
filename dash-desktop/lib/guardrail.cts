// A guardrail decision is per candidate and case. Only the local adapter can
// establish the exact count of a templated request before generation.
import { isPositiveInteger as positive, errorText, isRecord, finite, type Candidate, type ChatTurn, type CheckInputBudget, type OutputSchema, type TokenReceipt } from "./runtime-types.cjs";

export const autoOutputTarget = 8192;
interface ReasoningOptions {
  mode?: "quick" | "dataset";
  outputCap?: number | null;
  structured?: OutputSchema | null;
  verifiedAdapter: boolean;
}
interface InputOptimization {
  status: "preserved" | "already_compact" | "compacted";
  charactersSaved: number;
}
export interface Guardrail {
  reasoningPolicy: string;
  status: "unverified" | "blocked" | "verified";
  requestedInputCap: number | null;
  requestedOutputCap: number | null;
  inputTokens: number | null;
  contextTokens: number | null;
  maxOutputTokens: number | null;
  inputOptimization: InputOptimization;
  outputReserve: number;
  source: string;
  message: string;
}
export interface GuardrailDecision {
  guardrail: Guardrail;
  receipt: TokenReceipt | null;
  preparedMessages: ChatTurn[] | null;
}
export class GuardrailError extends Error {
  constructor(readonly guardrail: Guardrail) { super(guardrail.message); }
}
interface AssessmentOptions {
  candidate: Candidate;
  messages: ChatTurn[];
  serializedCaseInput?: boolean;
  mode?: "quick" | "dataset";
  structured?: OutputSchema | null;
  budget?: { inputCap?: number | null; outputCap?: number | null };
  defaultOutput: number;
  checkInputBudget?: CheckInputBudget;
  signal: AbortSignal;
}

export function reasoningPolicy(candidate: Candidate, { mode, outputCap, structured, verifiedAdapter }: ReasoningOptions): string {
  if (candidate.provider !== "lmstudio" || !candidate.reasoningOff) return "runtime default";
  if (verifiedAdapter && candidate.loaded) {
    if (mode === "quick" && positive(outputCap) && outputCap <= 1024) return "thinking disabled for short answer";
    return structured ? "zero reasoning-token budget requested" : "runtime default";
  }
  return structured && candidate.nativeChat ? "off" : "runtime default";
}

export function prepareInput(messages: ChatTurn[], serializedCaseInput: boolean): { messages: ChatTurn[]; optimization: InputOptimization } {
  const original = { messages, optimization: { status: "preserved" as const, charactersSaved: 0 } };
  // Authored chat turns, even those containing JSON examples, are kept verbatim.
  if (!serializedCaseInput || messages.length !== 2 || messages[0].role !== "system" || messages[1].role !== "user")
    return original;
  const text = messages[1].content;
  if (typeof text !== "string") return original;
  try {
    const envelope: unknown = JSON.parse(text);
    if (!envelope || typeof envelope !== "object" || !Object.hasOwn(envelope, "input"))
      return original;
  } catch {
    return original;
  }
  // Match entire JSON strings first. Escapes, numeric spelling, duplicate
  // keys and whitespace inside quoted source evidence all survive unchanged.
  const compact = text.replace(/"(?:\\[\s\S]|[^"\\])*"|[ \t\r\n]+/g, match => match[0] === '"' ? match : "");
  const charactersSaved = text.length - compact.length;
  const prepared = charactersSaved ? [messages[0], { ...messages[1], content: compact }] : messages;
  return { messages: prepared, optimization: { status: charactersSaved ? "compacted" : "already_compact", charactersSaved } };
}

export async function assessCase({ candidate, messages, serializedCaseInput = false, mode, structured, budget, defaultOutput, checkInputBudget, signal }: AssessmentOptions): Promise<GuardrailDecision> {
  signal.throwIfAborted();
  const requestedInputCap = budget?.inputCap ?? null;
  const requestedOutputCap = budget?.outputCap ?? null;
  const prepared = prepareInput(messages, serializedCaseInput);
  const preparedMessages = prepared.messages === messages ? null : prepared.messages;
  const maxOutputTokens = positive(candidate.maxOutputTokens) ? candidate.maxOutputTokens : null;
  const guardrail: Guardrail = {
    reasoningPolicy: reasoningPolicy(candidate, { mode, outputCap: requestedOutputCap, structured, verifiedAdapter: !!checkInputBudget }),
    status: "unverified", requestedInputCap, requestedOutputCap, inputTokens: null,
    contextTokens: positive(candidate.contextTokens) ? candidate.contextTokens : null,
    inputOptimization: prepared.optimization, maxOutputTokens,
    outputReserve: requestedOutputCap ?? Math.min(defaultOutput, maxOutputTokens ?? Infinity), source: "Provider", message: "",
  };
  function block(message: string): never {
    throw new GuardrailError({ ...guardrail, status: "blocked", message });
  }
  if (maxOutputTokens !== null && requestedOutputCap !== null && requestedOutputCap > maxOutputTokens)
    block(`The model advertises an output ceiling of ${maxOutputTokens} tokens. Lower the requested ${requestedOutputCap}-token output cap or choose a model with a higher ceiling.`);
  const canInspect = candidate.provider === "lmstudio" && candidate.loaded === true && checkInputBudget;
  if (!canInspect) {
    if (requestedInputCap !== null)
      block("A strict input limit needs the loaded model's tokenizer. Choose a loaded LM Studio model or remove the input cap.");
    if (guardrail.contextTokens !== null && requestedOutputCap !== null && requestedOutputCap >= guardrail.contextTokens)
      block(`The requested ${requestedOutputCap}-token output leaves no space for input in the ${guardrail.contextTokens}-token active context. Lower the output cap or load a larger context.`);
    if (guardrail.contextTokens !== null && requestedOutputCap === null) {
      if (guardrail.contextTokens < 2)
        block("The active context cannot hold both an input and a response. Load a larger context.");
      guardrail.outputReserve = Math.min(guardrail.outputReserve, guardrail.contextTokens - 1);
    }
    guardrail.message = "This connection cannot verify the complete input before dispatch. The output limit is sent to the provider.";
    return { guardrail, receipt: null, preparedMessages };
  }

  let receipt: TokenReceipt | null;
  try {
    // Obtain both measurements before enforcing policy so blocked decisions
    // carry the actual count and active limit in the run record.
    receipt = await checkInputBudget({ candidate, messages: prepared.messages, cap: requestedInputCap, measureContext: true, disableThinking: guardrail.reasoningPolicy === "thinking disabled for short answer", signal });
  } catch (error) {
    signal.throwIfAborted();
    guardrail.inputTokens = isRecord(error) ? finite(error.inputTokens) : null;
    if (isRecord(error) && positive(error.contextTokens)) guardrail.contextTokens = error.contextTokens;
    guardrail.source = "LM Studio local runtime";
    block(errorText(error));
  }
  if (!receipt || !Number.isSafeInteger(receipt.tokens) || receipt.tokens < 0)
    block("The runtime could not verify the token count. Refresh the model connection and retry.");
  guardrail.inputTokens = receipt.tokens;
  guardrail.source = receipt.source;
  if (requestedInputCap !== null && receipt.tokens > requestedInputCap)
    block(`The templated input requires ${receipt.tokens} tokens. Raise the ${requestedInputCap}-token input cap or approve a shorter prompt.`);
  if (!positive(receipt.contextTokens)) {
    guardrail.message = "The model verified the input count. Its active context length was unavailable to the adapter.";
    return { guardrail, receipt, preparedMessages };
  }

  guardrail.contextTokens = receipt.contextTokens;
  const room = receipt.contextTokens - receipt.tokens;
  if (room < 1)
    block(`The input takes ${receipt.tokens} tokens in a ${receipt.contextTokens}-token active context. Load a larger context or approve a shorter prompt.`);
  if (requestedOutputCap !== null && requestedOutputCap > room)
    block(`The input takes ${receipt.tokens} of ${receipt.contextTokens} tokens, leaving ${room} for output. Lower the requested ${requestedOutputCap}-token output cap, load a larger context, or approve a shorter prompt.`);
  guardrail.outputReserve = requestedOutputCap ?? Math.min(autoOutputTarget, room, maxOutputTokens ?? Infinity);
  guardrail.status = "verified";
  guardrail.message = `Verified ${receipt.tokens} input tokens and reserved ${guardrail.outputReserve} output tokens within the ${receipt.contextTokens}-token active context.`;
  return { guardrail, receipt, preparedMessages };
}

export function lengthFailure(check: Guardrail, telemetry: { output_tokens?: number | null } | null | undefined): string {
  const produced = telemetry?.output_tokens;
  const amount = Number.isSafeInteger(produced) ? ` after ${produced} generated tokens` : "";
  const next = check.requestedOutputCap == null
    ? "Set a larger output budget if the model has room, request a shorter answer in a new prompt revision, or choose another model."
    : "Raise the explicit output cap in a new revision or request a shorter answer.";
  return `Output stopped at the generation or context limit${amount} (output allocation ${check.outputReserve}). The partial response was saved without a score. ${next}`;
}


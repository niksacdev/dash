import { checkInputBudget, invokeBudgeted, invokeJudge, invokePlanner } from "./token-budget.cjs";
import { readProviderJson, parseProviderObject } from "./provider-response.cjs";
import { ProviderRejectedError, isRecord, finite, errorText, isPositiveInteger, type LocalProvider, type LocalCandidate, type RuntimeInstance,
  type RuntimeInventory, type ModelCandidate, type InvokeOptions, type ChatTurn, type InferenceResult, type InferenceTelemetry } from "./runtime-types.cjs";
export { checkInputBudget };

const localProviders = ["ollama", "lmstudio"] as const;
const servers: Record<LocalProvider,string> = {
  ollama: "http://127.0.0.1:11434", lmstudio: "http://127.0.0.1:1234",
};
const titles = { ollama: "Ollama", lmstudio: "LM Studio" };
export const settings = { temperature: 0, maxTokens: 2048 };

function entries(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw Error("Provider returned an invalid model or response list.");
  return value;
}
const string = (value: unknown): string | null => typeof value === "string" ? value : null;
const tokens = (value: unknown): number | null => isPositiveInteger(value) ? value : null;
const count = (value: unknown): number | null => value === 0 ? 0 : tokens(value);
function modelId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 300) throw Error("Invalid model ID");
  return value;
}
function httpFailure(status:number, message:string):Error {
  // A timeout or server error does not confirm that generation was rejected.
  return [400,401,403,404,405,413,415,422,429].includes(status) ? new ProviderRejectedError(message) : Error(message);
}
async function providerErrorMessage(response: Response): Promise<string> {
  try {
    const data = await readProviderJson(response, 16384);
    const msg = (isRecord(data.error) ? data.error.message : undefined) ?? data.message ?? data.error;
    return typeof msg === "string" ? msg.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0,800) : "";
  } catch { return ""; }
}
async function request(provider: LocalProvider, route: string, options: RequestInit = {}): Promise<Response> {
  const response = await fetch(servers[provider] + route, { ...options, redirect:"error" });
  if (!response.ok) {
    const detail = await providerErrorMessage(response);
    throw httpFailure(response.status, titles[provider] + " " + route + " returned HTTP " + response.status + (detail ? " · " + detail : ""));
  }
  return response;
}

interface NativeModel {
  key: string; type: string | null; quantization: string | null; parameterSize: string | null;
  maxContextTokens: number | null; maxOutputTokens: number | null; reasoningOff: boolean; instances: RuntimeInstance[];
}
function nativeModel(raw: Record<string,unknown>): NativeModel {
  const key = modelId(raw.key), type = string(raw.type);
  const quantization = isRecord(raw.quantization) ? string(raw.quantization.name) : null;
  const reasoning = isRecord(raw.capabilities) ? raw.capabilities.reasoning : null;
  const modes = isRecord(reasoning) ? reasoning.allowed_options : null;
  return { key, type, quantization, parameterSize:string(raw.params_string), maxContextTokens:tokens(raw.max_context_length),
    maxOutputTokens:tokens(raw.max_output_tokens), reasoningOff:Array.isArray(modes) && modes.includes("off"),
    instances:entries(raw.loaded_instances ?? []).map(i=>({ model:key, type, id:modelId(i.id), quantization,
      context:isRecord(i.config) ? tokens(i.config.context_length) : null })),
  };
}
async function inventory(provider: LocalProvider): Promise<RuntimeInventory> {
  const native = provider === "ollama";
  const status = { provider, title:titles[provider], address:servers[provider] };
  try {
    const r = await request(provider, native ? "/api/tags" : "/v1/models", { signal:AbortSignal.timeout(2500) });
    const data = await readProviderJson(r, 4_000_000);
    const available = entries(native ? data.models : data.data);
    let running: Map<string, number | null> | null = null;
    let nativeModels: NativeModel[] | null = null;
    if (native && available.length) {
      try {
        const active = await request(provider, "/api/ps", { signal:AbortSignal.timeout(2000) });
        running = new Map(entries((await readProviderJson(active,4_000_000)).models).map(m=>[modelId(m.name || m.model),tokens(m.context_length)]));
      } catch { /* Older Ollama runtimes may lack active inventory. */ }
    }
    if (!native) {
      try {
        const active = await request(provider, "/api/v1/models", { signal:AbortSignal.timeout(2000) });
        nativeModels = entries((await readProviderJson(active,4_000_000)).models).map(nativeModel);
      } catch { /* Retain the compatible inventory on older LM Studio versions. */ }
    }
    const models: LocalCandidate[] = [];
    for (const m of available) {
      const name = string(native ? m.name : m.id);
      if (m.remote_host || m.remote_model || /(:|-|\/)cloud($|:)/i.test(name ?? "")) continue;
      const model = modelId(name);
      const meta = nativeModels?.find(item => item.key === model || item.instances.some(i=>i.id === model));
      if (meta?.type === "embedding") continue;
      const details = isRecord(m.details) ? m.details : {};
      models.push({
        id:provider + "/" + model, kind:"model", provider, model, revision:string(m.digest),
        parameterSize:meta?.parameterSize ?? string(details.parameter_size),
        quantization:string(details.quantization_level) ?? meta?.quantization ?? null,
        loaded:native ? running?.has(model) ?? null : meta ? meta.instances.length > 0 : null,
        contextTokens:(native ? running?.get(model) : meta?.instances.find(i=>i.id === model)?.context) ?? null,
        maxOutputTokens:meta?.maxOutputTokens ?? tokens(m.max_output_tokens), maxContextTokens:meta?.maxContextTokens ?? null,
        nativeChat:!!meta, reasoningOff:meta?.reasoningOff === true,
      });
      if (models.length === 200) break;
    }
    return { ...status, checkedAt:new Date().toISOString(), online:true, models, instances:nativeModels?.flatMap(m=>m.instances) ?? null };
  } catch (error) {
    return { ...status, checkedAt:new Date().toISOString(), online:false, models:[], instances:null, error:errorText(error) };
  }
}
export function discover(): Promise<RuntimeInventory[]> {
  return Promise.all(localProviders.map(inventory));
}
async function nativeDataset(candidate: ModelCandidate, messages: ChatTurn[], signal: AbortSignal, maxTokens: number): Promise<InferenceResult> {
  if (messages.length !== 2 || messages[0].role !== "system" || messages[1].role !== "user") throw Error("LM Studio native chat requires a system turn followed by a user turn.");
  const start = performance.now();
  const options = {
    model: candidate.model,
    ...(candidate.reasoningOff ? { reasoning:"off" } : {}),
    store: false,
    stream: false,
    temperature: settings.temperature,
    max_output_tokens: maxTokens,
    system_prompt: messages[0].content,
    input: messages[1].content,
  };
  const response = await request("lmstudio", "/api/v1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
    signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
  });
  const payload = await readProviderJson(response, 4_000_000);
  const output = entries(payload.output).map(item => item.type === "message" ? string(item.content) ?? "" : "").join("");
  const stats = isRecord(payload.stats) ? payload.stats : {};
  const ttft = finite(stats.time_to_first_token_seconds);
  const loadSeconds = finite(stats.model_load_time_seconds);
  return {
    output,
    reportedFinishReason: string(stats.stop_reason) ?? null,
    finishReason:
      (finite(stats.total_output_tokens) ?? -1) >= maxTokens
        ? "length"
        : null,
    telemetry: {
      latency_ms: Math.round(performance.now() - start),
      first_token_ms: null,
      provider_first_token_ms:
        ttft === null
          ? null
          : ttft * 1000,
      input_tokens: finite(stats.input_tokens),
      output_tokens: finite(stats.total_output_tokens),
      reasoning_tokens: finite(stats.reasoning_output_tokens),
      tokens_per_second: finite(stats.tokens_per_second),
      load_ms:
        loadSeconds === null
          ? null
          : loadSeconds * 1000,
      model_instance_id:
        typeof payload.model_instance_id === "string"
          ? payload.model_instance_id
          : null,
    },
  };
}
export async function invoke(candidate: ModelCandidate, messages: ChatTurn[], { signal, structured, onText, apiKey, inputBudget, planning, judging, maxTokens = settings.maxTokens }: InvokeOptions): Promise<InferenceResult> {
  if (inputBudget != null)
    return invokeBudgeted(candidate, messages, { inputBudget, maxTokens, signal, structured, onText });
  if (judging && candidate.provider === "lmstudio")
    return invokeJudge(candidate, messages, { maxTokens, signal, structured });
  if (planning && candidate.provider === "lmstudio")
    return invokePlanner(candidate, messages, { maxTokens, signal, structured });
  if (structured && candidate.provider === "lmstudio" && candidate.nativeChat && messages.length === 2 && messages[0].role === "system" && messages[1].role === "user")
    return nativeDataset(candidate, messages, signal, maxTokens);
  const native = candidate.provider === "ollama";
  const body = native
    ? {
        model: candidate.model,
        messages,
        stream: true,
        ...(structured ? {format:structured} : {}),
        options: {
          temperature: settings.temperature,
          num_predict: maxTokens,
        },
      }
    : {
        model: candidate.model,
        messages,
        stream: true,
        ...(structured ? {response_format:{type:"json_schema", json_schema:{name:"case_output", schema:structured}}} : {}),
        stream_options: { include_usage: true },
        temperature: settings.temperature,
        max_tokens: maxTokens,
      };
  const start = performance.now();
  const options = {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(candidate.provider === "compatible" && apiKey ? { Authorization: "Bearer " + apiKey } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
  };
  const r = candidate.provider === "compatible"
    ? await fetch(candidate.endpoint + "/chat/completions", { ...options, redirect: "error" })
    : await request(candidate.provider, native ? "/api/chat" : "/v1/chat/completions", options);
  if (!r.ok) {
    await r.body?.cancel().catch(()=>{});
    throw httpFailure(r.status,"Model endpoint returned HTTP " + r.status);
  }
  let output = "",
    first: number | null = null,
    ended = false,
    inputTokens: number | null = null,
    outputTokens: number | null = null,
    bytes = 0;
  let timing: Pick<InferenceTelemetry, "load_ns" | "prompt_ns" | "generation_ns"> = {},
    finishReason: string | null = null, reportedFinishReason: string | null = null;
  function line(raw: string): void {
    let text = raw.trim();
    if (!text) return;
    if (!native) {
      if (!text.startsWith("data:")) return;
      text = text.slice(5).trim();
      if (text === "[DONE]") {
        ended = true;
        return;
      }
    }
    const d = parseProviderObject(text);
    if (d.error) {
      // Streaming errors may echo authorization headers, model inputs or provider internals.
      throw Error("Model provider reported an error during generation.");
    }
    if (native && d.done === true) {
      ended = true;
      reportedFinishReason = string(d.done_reason) ?? null;
      finishReason = reportedFinishReason ?? "stop";
      inputTokens = count(d.prompt_eval_count);
      outputTokens = count(d.eval_count);
      timing = {
        load_ns: finite(d.load_duration),
        prompt_ns: finite(d.prompt_eval_duration),
        generation_ns: finite(d.eval_duration),
      };
    }
    const choice = !native && Array.isArray(d.choices) && isRecord(d.choices[0]) ? d.choices[0] : null;
    if (choice && typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
    if (!native && isRecord(d.usage)) {
      inputTokens = count(d.usage.prompt_tokens);
      outputTokens = count(d.usage.completion_tokens);
    }
    const delta = native ? d.message : choice?.delta;
    const chunk = isRecord(delta) ? delta.content : null;
    if (typeof chunk === "string" && chunk) {
      first ??= performance.now() - start;
      output += chunk;
      onText?.(output);
    }
  }
  const decoder = new TextDecoder();
  const fragments:string[] = [];
  if (!r.body) throw Error("Provider returned an empty streaming response.");
  for await (const chunk of r.body) {
    bytes += chunk.byteLength;
    if (bytes > 4_000_000) throw Error("Provider response exceeds 4 MB");
    const lines = decoder.decode(chunk, {stream:true}).split("\n");
    const tail = lines.pop() ?? "";
    for (const item of lines) {
      fragments.push(item);
      line(fragments.join(""));
      fragments.length = 0;
      if (ended) break;
    }
    // Breaking the async iterator cancels its reader, even if the server keeps the socket open.
    if (ended) break;
    if (tail) fragments.push(tail);
  }
  if (!ended) {
    fragments.push(decoder.decode());
    line(fragments.join(""));
  }
  if (!ended)
    throw Error("Provider disconnected before completing the response");
  return {
    output,
    finishReason,
    reportedFinishReason: native ? reportedFinishReason : finishReason,
    telemetry: {
      latency_ms: Math.round(performance.now() - start),
      first_token_ms: first === null ? null : Math.round(first),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...timing,
    },
  };
}
export async function reportStage(candidate: ModelCandidate, messages: ChatTurn[], options: InvokeOptions): Promise<InferenceResult> {
  if (!candidate.loaded || !["lmstudio", "ollama"].includes(candidate.provider))
    throw Error("Report agents require a loaded local model.");
  return invoke(candidate, messages, { ...options, planning: true });
}


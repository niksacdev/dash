import { checkInputBudget, invokeBudgeted, invokeJudge, invokePlanner } from "./token-budget.cjs";
import { readProviderJson, parseProviderObject, providerChunks } from "./provider-response.cjs";
import {httpGuidance, reportsTemplateFailure, templateAdvice} from "./provider-errors.cjs";
import { ProviderFailure, ProviderPreflightError, ProviderRejectedError, isRecord, finite, errorText, isPositiveInteger, type LocalProvider, type LocalCandidate, type RuntimeInstance,
  type RuntimeInventory, type ModelLoadReceipt, type ModelCandidate, type InvokeOptions, type ChatTurn, type InferenceResult, type InferenceTelemetry } from "./runtime-types.cjs";
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
  return [400,401,403,404,405,413,415,422,429].includes(status) ? new ProviderRejectedError(message) : new ProviderFailure(message);
}
async function hasTemplateError(response: Response): Promise<boolean> {
  try {
    const data = await readProviderJson(response, 16384);
    const msg = (isRecord(data.error) ? data.error.message : undefined) ?? data.message ?? data.error;
    return reportsTemplateFailure(msg);
  } catch { return false; }
}
async function request(provider: LocalProvider, route: string, options: RequestInit = {}): Promise<Response> {
  let response:Response;
  try {
    response=await fetch(servers[provider] + route, { ...options, redirect:"error" });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (isRecord(error) && isRecord(error.cause) && error.cause.code==="ECONNREFUSED")
      throw new ProviderPreflightError(titles[provider]+" refused the local connection. Start the local server and refresh Local runtimes.");
    throw new ProviderFailure(titles[provider]+" connection failed. Check Local runtimes and the server activity.");
  }
  if (!response.ok) {
    let advice=httpGuidance(response.status);
    if (options.method==="POST" && [400,422].includes(response.status) && route.includes("chat")) {
      if (await hasTemplateError(response)) advice=templateAdvice;
    } else await response.body?.cancel().catch(()=>{});
    throw httpFailure(response.status, titles[provider] + " " + route + " returned HTTP " + response.status + ". " + advice);
  }
  return response;
}

function isRemoteModel(row:Record<string,unknown>,id:string):boolean {
  return !!(row.remote_host || row.remote_model || /(?:^|[:/-])cloud(?:$|[:/])/i.test(id));
}
interface NativeModel {
  key: string; type: string | null; remote:boolean; quantization: string | null; parameterSize: string | null;
  maxContextTokens: number | null; maxOutputTokens: number | null; reasoningOff: boolean; instances: RuntimeInstance[];
}
function nativeModel(raw: Record<string,unknown>): NativeModel {
  const key = modelId(raw.key), type = string(raw.type);
  const quantization = isRecord(raw.quantization) ? string(raw.quantization.name) : null;
  const reasoning = isRecord(raw.capabilities) ? raw.capabilities.reasoning : null;
  const modes = isRecord(reasoning) ? reasoning.allowed_options : null;
  const instances=entries(raw.loaded_instances);
  const remote=isRemoteModel(raw,key) || instances.some(i=>isRemoteModel(i,modelId(i.id)));
  return { key, type, remote, quantization, parameterSize:string(raw.params_string), maxContextTokens:tokens(raw.max_context_length),
    maxOutputTokens:tokens(raw.max_output_tokens), reasoningOff:Array.isArray(modes) && modes.includes("off"),
    instances:instances.map(i=>({ model:key, type, id:modelId(i.id), quantization,
      context:isRecord(i.config) ? tokens(i.config.context_length) : null })),
  };
}
async function nativeInventory():Promise<NativeModel[]> {
  const response=await request("lmstudio","/api/v1/models",{signal:AbortSignal.timeout(3000)});
  const rows=entries((await readProviderJson(response,4_000_000)).models);
  return rows.map(nativeModel);
}

function localLoadKey(value:string):boolean {
  return !!value && value.length<=300 && value===value.trim() && !/[\u0000-\u001f\u007f\\]/u.test(value) &&
    !value.startsWith("/") && !value.includes("://") && !value.split("/").some(part=>!part || part==="." || part==="..");
}
function nativeSelection(catalog:NativeModel[],key:string):NativeModel {
  const matches=catalog.filter(m=>m.key===key);
  if (matches.length!==1 || matches[0].remote || matches[0].type!=="llm" || !localLoadKey(key))
    throw Error("Choose a downloaded chat model from the current LM Studio inventory.");
  return matches[0];
}
async function loadVerified(key:string):Promise<ModelLoadReceipt> {
  let catalog:NativeModel[];
  try { catalog=await nativeInventory(); }
  catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw Error("DASH could not verify the native LM Studio inventory. Check the local server on port 1234 or load the model in LM Studio, then refresh Local runtimes.");
  }
  const current=nativeSelection(catalog,key);
  if (current.instances.length) return {status:"already-loaded",instanceId:current.instances[0].id};
  let acknowledged:string|undefined;
  try {
    const response=await request("lmstudio","/api/v1/models/load",{method:"POST",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({model:key}),signal:AbortSignal.timeout(120000)});
    const body=await readProviderJson(response,64_000);
    if (body.status==="loaded" && body.type==="llm") acknowledged=modelId(body.instance_id);
  } catch(error) {
    if (error instanceof ProviderRejectedError) throw error;
    // A lost acknowledgement can follow a successful load. Only read inventory from here.
  }
  try {
    const refreshed=nativeSelection(await nativeInventory(),key);
    const instance=acknowledged ? refreshed.instances.find(i=>i.id===acknowledged) : refreshed.instances[0];
    if (instance) return {status:"loaded",instanceId:instance.id};
  } catch { /* The request may have succeeded while the server became unreachable. */ }
  return {status:"unconfirmed"};
}
let loading:{key:string;task:Promise<ModelLoadReceipt>}|null=null;
export function loadLocalModel(key:string):Promise<ModelLoadReceipt> {
  if (!localLoadKey(key)) return Promise.reject(Error("Invalid local model key."));
  if (loading) {
    if (loading.key===key) return loading.task;
    return Promise.reject(Error("Wait for the current LM Studio load to finish."));
  }
  const task=loadVerified(key).finally(()=>{loading=null;});
  loading={key,task};
  return task;
}

async function inventory(provider: LocalProvider): Promise<RuntimeInventory> {
  const ollama = provider === "ollama";
  const status = { provider, title:titles[provider], address:servers[provider] };
  try {
    let nativeModels: NativeModel[] | null = null;
    if (!ollama) {
      try { nativeModels=await nativeInventory(); }
      catch { /* Older LM Studio servers can still expose the compatible inventory. */ }
    }
    let available:Record<string,unknown>[];
    try {
      const response=await request(provider,ollama?"/api/tags":"/v1/models",{signal:AbortSignal.timeout(2500)});
      const data=await readProviderJson(response,4_000_000);
      available=entries(ollama?data.models:data.data);
    } catch(error) {
      if (!nativeModels) throw error;
      available=[];
    }
    if (nativeModels) {
      const identifiers=new Set(available.map(item=>item.id));
      for (const m of nativeModels.filter(m=>m.type==="llm" && !m.remote)) {
        if (!identifiers.has(m.key) && !m.instances.some(i=>identifiers.has(i.id))) available.push({id:m.key});
      }
    }
    let running: Map<string, number | null> | null = null;
    if (ollama && available.length) {
      try {
        const active=await request(provider,"/api/ps",{signal:AbortSignal.timeout(2000)});
        running=new Map(entries((await readProviderJson(active,4_000_000)).models).map(m=>[modelId(m.name || m.model),tokens(m.context_length)]));
      } catch { /* Older Ollama runtimes may lack active inventory. */ }
    }
    const models:LocalCandidate[]=[];
    for (const m of available) {
      const name=string(ollama ? m.name : m.id);
      if (isRemoteModel(m,name ?? "")) continue;
      const id=modelId(name);
      const matches=nativeModels?.filter(row=>row.key===id || row.instances.some(i=>i.id===id));
      if (matches?.some(row=>row.remote || (row.type!==null && row.type!=="llm"))) continue;
      const meta=matches?.length===1?matches[0]:undefined;
      const instance=meta?.instances.find(i=>i.id===id) ?? meta?.instances[0];
      const model=instance?.id ?? id;
      if (models.some(c=>c.model===model)) continue;
      const details=isRecord(m.details)?m.details:{};
      models.push({
        id:provider+"/"+id, kind:"model", provider, model, revision:string(m.digest),
        ...(meta?.type==="llm" && localLoadKey(meta.key) && {nativeKey:meta.key}),
        parameterSize:meta?.parameterSize ?? string(details.parameter_size),
        quantization:string(details.quantization_level) ?? meta?.quantization ?? null,
        loaded:ollama ? running?.has(model) ?? null : meta ? meta.instances.length > 0 : null,
        contextTokens:(ollama ? running?.get(model) : instance?.context) ?? null,
        maxOutputTokens:meta?.maxOutputTokens ?? tokens(m.max_output_tokens), maxContextTokens:meta?.maxContextTokens ?? null,
        nativeChat:!!meta, reasoningOff:meta?.reasoningOff===true,
      });
      if (models.length===200) break;
    }
    return {...status,checkedAt:new Date().toISOString(),online:true,models,instances:nativeModels?.filter(m=>!m.remote).flatMap(m=>m.instances) ?? null};
  } catch(error) {
    return {...status,checkedAt:new Date().toISOString(),online:false,models:[],instances:null,error:errorText(error)};
  }
}
export function discover(): Promise<RuntimeInventory[]> {
  return Promise.all(localProviders.map(inventory));
}
async function nativeDataset(candidate: ModelCandidate, messages: ChatTurn[], signal: AbortSignal, maxTokens: number): Promise<InferenceResult> {
  if (messages.length !== 2 || messages[0].role !== "system" || messages[1].role !== "user") throw new ProviderPreflightError("LM Studio native chat requires a system turn followed by a user turn.");
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
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(180000)]);
  const response = await request("lmstudio", "/api/v1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
    signal: deadline,
  });
  const payload = await readProviderJson(response, 4_000_000,deadline);
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
  let r:Response;
  if(candidate.provider==="compatible") {
    try { r=await fetch(candidate.endpoint+"/chat/completions",{...options,redirect:"error"}); }
    catch {
      options.signal.throwIfAborted();
      throw new ProviderFailure("Model endpoint connection failed. Check its configuration and activity before starting another request.");
    }
  } else r=await request(candidate.provider,native?"/api/chat":"/v1/chat/completions",options);
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
      throw new ProviderFailure(reportsTemplateFailure(d.error) ? templateAdvice : "Model provider reported an error during generation. Check the server activity before starting another request.");
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
  for await (const chunk of providerChunks(r.body,options.signal)) {
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


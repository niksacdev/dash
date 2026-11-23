const servers = {
  ollama: "http://127.0.0.1:11434",
  lmstudio: "http://127.0.0.1:1234",
};
const titles = { ollama: "Ollama", lmstudio: "LM Studio" };
const settings = { temperature: 0, maxTokens: 2048 };

async function providerErrorMessage(response) {
  let bytes = 0;
  const chunks = [];
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 16384) return "";
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const msg = data.error?.message ?? data.message ?? data.error;
    return typeof msg === "string"
      ? msg
          .replace(/[\u0000-\u001f]+/g, " ")
          .trim()
          .slice(0, 800)
      : "";
  } catch {
    return "";
  }
}
async function request(provider, route, options = {}) {
  const response = await fetch(servers[provider] + route, {
    ...options,
    redirect: "error",
  });
  if (!response.ok) {
    const detail = await providerErrorMessage(response);
    throw Error(
      titles[provider] +
        " " +
        route +
        " returned HTTP " +
        response.status +
        (detail ? " · " + detail : ""),
    );
  }
  return response;
}
async function discover() {
  return Promise.all(
    Object.keys(servers).map(async (provider) => {
      try {
        const native = provider === "ollama";
        const r = await request(provider, native ? "/api/tags" : "/v1/models", {
          signal: AbortSignal.timeout(2500),
        });
        const data = await r.json();
        const entries = native ? data.models : data.data;
        if (!Array.isArray(entries)) throw Error("Invalid model inventory");
        let runningOllama = null;
        if (native && entries.length) {
          try {
            const running = await request("ollama", "/api/ps", { signal: AbortSignal.timeout(2000) });
            const list = (await running.json()).models;
            if (Array.isArray(list)) runningOllama = new Map(list.map(m => [m.name || m.model, m.context_length]));
          } catch { /* Keep the load state unknown on older runtimes. */ }
        }
        let nativeModels = null;
        if (!native) {
          try {
            const inventory = await request(provider, "/api/v1/models", {
              signal: AbortSignal.timeout(2000),
            });
            const list = (await inventory.json()).models;
            if (Array.isArray(list)) nativeModels = list;
          } catch {
            /* Older LM Studio versions expose only the compatible API. */
          }
        }
        const meta = (id) =>
          nativeModels?.find(
            (m) => m.key === id || m.loaded_instances?.some((i) => i.id === id),
          );
        const models = entries
          .filter(
            (m) =>
              meta(m.id)?.type !== "embedding" &&
              !m.remote_host &&
              !m.remote_model &&
              !/(:|-|\/)cloud($|:)/i.test(m.name || m.id || ""),
          )
          .slice(0, 200)
          .map((m) => {
            const model = native ? m.name : m.id;
            if (
              typeof model !== "string" ||
              !model.length ||
              model.length > 300
            )
              throw Error("Invalid model ID");
            return {
              id: provider + "/" + model,
              kind: "model",
              provider,
              model,
              revision: m.digest || null,
              parameterSize: meta(model)?.params_string || m.details?.parameter_size || null,
              quantization:
                m.details?.quantization_level ||
                meta(model)?.quantization?.name ||
                null,
              loaded: native
                ? runningOllama?.has(model) ?? null
                : meta(model)
                  ? !!meta(model).loaded_instances?.length
                  : null,
              contextTokens: (native ? runningOllama?.get(model) : meta(model)?.loaded_instances?.find(i => i.id === model)?.config?.context_length) ?? null,
              maxOutputTokens: meta(model)?.max_output_tokens ?? m.max_output_tokens ?? null,
              maxContextTokens: meta(model)?.max_context_length ?? null,
              nativeChat: !!meta(model),
              reasoningOff:
                meta(model)?.capabilities?.reasoning?.allowed_options?.includes(
                  "off",
                ) === true,
            };
          });
        return {
          provider,
          title: titles[provider],
          address: servers[provider],
          online: true,
          models,
          checkedAt: new Date().toISOString(),
          instances:
            native || !Array.isArray(nativeModels)
              ? null
              : nativeModels.flatMap((m) =>
                  (m.loaded_instances || []).map((i) => ({
                    model: m.key,
                    id: i.id,
                    type: m.type,
                    context: i.config?.context_length ?? null,
                    quantization: m.quantization?.name ?? null,
                  })),
                ),
        };
      } catch (e) {
        return {
          provider,
          title: titles[provider],
          address: servers[provider],
          online: false,
          models: [],
          checkedAt: new Date().toISOString(),
          instances: null,
          error: e.message,
        };
      }
    }),
  );
}
async function nativeDataset(candidate, messages, signal, maxTokens) {
  const start = performance.now();
  const options = {
    model: candidate.model,
    store: false,
    stream: false,
    temperature: settings.temperature,
    max_output_tokens: maxTokens,
    system_prompt: messages[0].content,
    input: messages[1].content,
  };
  if (candidate.reasoningOff) options.reasoning = "off";
  const response = await request("lmstudio", "/api/v1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
    signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
  });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 4_000_000) throw Error("Provider response exceeds 4 MB");
    chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(payload.output))
    throw Error("LM Studio returned an invalid response.");
  const output = payload.output
    .filter(
      (item) => item.type === "message" && typeof item.content === "string",
    )
    .map((item) => item.content)
    .join("");
  const stats = payload.stats || {};
  const finite = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
  return {
    output,
    finishReason:
      stats.total_output_tokens >= maxTokens
        ? "length"
        : null,
    telemetry: {
      latency_ms: Math.round(performance.now() - start),
      first_token_ms: null,
      provider_first_token_ms:
        finite(stats.time_to_first_token_seconds) === null
          ? null
          : stats.time_to_first_token_seconds * 1000,
      input_tokens: finite(stats.input_tokens),
      output_tokens: finite(stats.total_output_tokens),
      reasoning_tokens: finite(stats.reasoning_output_tokens),
      tokens_per_second: finite(stats.tokens_per_second),
      load_ms:
        finite(stats.model_load_time_seconds) === null
          ? null
          : stats.model_load_time_seconds * 1000,
      model_instance_id:
        typeof payload.model_instance_id === "string"
          ? payload.model_instance_id
          : null,
    },
  };
}
async function invoke(candidate, messages, { signal, structured, onText, apiKey, inputBudget, planning, maxTokens = settings.maxTokens }) {
  if (inputBudget != null)
    return require("./token-budget.cjs").invokeBudgeted(candidate, messages, { inputBudget, maxTokens, signal, structured, onText });
  if (planning && candidate.provider === "lmstudio")
    return require("./token-budget.cjs").invokePlanner(candidate, messages, { maxTokens, signal, structured });
  if (structured && candidate.provider === "lmstudio" && candidate.nativeChat)
    return nativeDataset(candidate, messages, signal, maxTokens);
  const native = candidate.provider === "ollama";
  const body = native
    ? {
        model: candidate.model,
        messages,
        stream: true,
        options: {
          temperature: settings.temperature,
          num_predict: maxTokens,
        },
      }
    : {
        model: candidate.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: settings.temperature,
        max_tokens: maxTokens,
      };
  if (structured) {
    if (native) body.format = structured;
    else
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "case_output", schema: structured },
      };
  }
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
  if (!r.ok) throw Error("Model endpoint returned HTTP " + r.status);
  let output = "",
    pending = "",
    first = null,
    ended = false,
    inputTokens = null,
    outputTokens = null,
    bytes = 0;
  let timing = {},
    finishReason = null;
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  function line(raw) {
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
    const d = JSON.parse(text);
    if (d.error)
      throw Error(
        typeof d.error === "string"
          ? d.error
          : d.error.message || "Provider error",
      );
    if (native && d.done) {
      ended = true;
      finishReason = d.done_reason ?? "stop";
      inputTokens = count(d.prompt_eval_count);
      outputTokens = count(d.eval_count);
      timing = {
        load_ns: d.load_duration ?? null,
        prompt_ns: d.prompt_eval_duration ?? null,
        generation_ns: d.eval_duration ?? null,
      };
    }
    if (!native && d.choices?.[0]?.finish_reason)
      finishReason = d.choices[0].finish_reason;
    if (!native && d.usage) {
      inputTokens = count(d.usage.prompt_tokens);
      outputTokens = count(d.usage.completion_tokens);
    }
    const chunk = native ? d.message?.content : d.choices?.[0]?.delta?.content;
    if (typeof chunk === "string" && chunk) {
      first ??= performance.now() - start;
      output += chunk;
      onText?.(output);
    }
  }
  const decoder = new TextDecoder();
  for await (const chunk of r.body) {
    bytes += chunk.byteLength;
    if (bytes > 4_000_000) throw Error("Provider response exceeds 4 MB");
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const item of lines) line(item);
  }
  line(pending + decoder.decode());
  if (!ended)
    throw Error("Provider disconnected before completing the response");
  return {
    output,
    finishReason,
    telemetry: {
      latency_ms: Math.round(performance.now() - start),
      first_token_ms: first === null ? null : Math.round(first),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...timing,
    },
  };
}
async function reportStage(candidate, messages, options) {
  if (!candidate.loaded || !["lmstudio", "ollama"].includes(candidate.provider))
    throw Error("Report agents require a loaded local model.");
  return invoke(candidate, messages, { ...options, planning: true });
}

module.exports = { discover, invoke, reportStage, settings, checkInputBudget: require("./token-budget.cjs").checkInputBudget };

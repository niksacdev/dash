import {loadAgent, agentPin, isRecord, type AgentPin} from "../agents/registry.cjs";
import type {RuntimeAdapters, ModelCandidate} from "./runtime-types.cjs";
export type GuideResult = {status:"canceled"|"offline"|"unavailable"} | {status:"ready";model:string;kind:"check"|"question";text:string;agent:AgentPin};
const schema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["check", "question"] },
    text: { type: "string" },
  },
  required: ["kind", "text"],
  additionalProperties: false,
};

const guide = loadAgent("prompt-guide");

function capacity(model:ModelCandidate) {
  const size = /([0-9]+(?:\.[0-9]+)?)\s*([bmt])/i.exec(model.parameterSize || "");
  return size ? Number(size[1]) * (size[2].toLowerCase() === "b" ? 1e9 : size[2].toLowerCase() === "m" ? 1e6 : 1e12) : 0;
}

export class PromptGuide {
  private controller:AbortController|null = null;
  constructor(private readonly adapters:Pick<RuntimeAdapters,"discover"|"invoke">) {}
  cancel() {
    this.controller?.abort();
    this.controller = null;
  }
  async suggest(draft:unknown):Promise<GuideResult> {
    if (typeof draft !== "string" || !draft.trim() || draft.length > 24000)
      throw Error("Enter a prompt up to 24,000 characters.");
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    try {
      const servers = await this.adapters.discover();
      const loaded = servers.flatMap(s => s.models).filter(c =>
        c.loaded === true && (c.provider === "lmstudio" || c.provider === "ollama"));
      const model = loaded.sort((a,b) => capacity(b) - capacity(a))[0];
      if (controller.signal.aborted) return { status: "canceled" };
      if (!model) return { status: "offline" };
      const response = await this.adapters.invoke(model, [
        { role: "system", content: guide.instructions },
        { role: "user", content: JSON.stringify({ draft: draft.trim() }) },
      ], {
        structured: schema, maxTokens: 512,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      });
      if (controller.signal.aborted) return { status: "canceled" };
      const raw = response.output.trim();
      const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
      const suggestion:unknown = JSON.parse(fenced ? fenced[1] : raw);
      if (!isRecord(suggestion) || (suggestion.kind !== 'check' && suggestion.kind !== 'question') ||
          typeof suggestion.text !== "string" || !suggestion.text.trim() || suggestion.text.length > 700)
        throw Error("Invalid guidance");
      return { status: "ready", model: model.model, kind: suggestion.kind, text: suggestion.text.trim(), agent:agentPin(guide) };
    } catch (error) {
      return { status: controller.signal.aborted ? "canceled" : "unavailable" };
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}


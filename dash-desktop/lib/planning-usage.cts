import {isRecord} from "./runtime-types.cjs";

// Standard USD per million tokens for the dated snapshots. See ADR 0021 for sources.
const standardRates = new Map<string, readonly [number, number, number]>([
  ["gpt-4.1-2025-04-14", [2, 0.50, 8]],
  ["gpt-4.1-mini-2025-04-14", [0.40, 0.10, 1.60]],
  ["gpt-4.1-nano-2025-04-14", [0.10, 0.025, 0.40]],
]);
function tokenCount(value:unknown):number|null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function localPlanningUsage(input:unknown, output:unknown):PlanningUsage {
  return {inputTokens:tokenCount(input),outputTokens:tokenCount(output),estimatedCostUsd:null};
}
export function hostedPlanningUsage(body:Record<string,unknown>):PlanningUsage {
  const raw = isRecord(body.usage) ? body.usage : {};
  const input = tokenCount(raw.prompt_tokens);
  const output = tokenCount(raw.completion_tokens);
  const cached = isRecord(raw.prompt_tokens_details) ? tokenCount(raw.prompt_tokens_details.cached_tokens) : null;
  const rates = typeof body.model === "string" && body.service_tier === "default" ? standardRates.get(body.model) : undefined;
  const estimate = rates && input !== null && output !== null && cached !== null && cached <= input
    ? ((input - cached) * rates[0] + cached * rates[1] + output * rates[2]) / 1_000_000 : null;
  return {inputTokens:input,outputTokens:output,estimatedCostUsd:estimate};
}

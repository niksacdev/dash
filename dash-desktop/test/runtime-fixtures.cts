import assert from "node:assert/strict";
import type { InferenceResult, InferenceTelemetry, LocalCandidate, LocalProvider, RuntimeInventory } from "../lib/runtime-types.cjs";
import type { startPower } from "../lib/power.cjs";

export function present<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null, "Expected a value");
  return value;
}

export function inventory(models: LocalCandidate[], provider: LocalProvider = models[0]?.provider ?? "lmstudio"): RuntimeInventory {
  return { provider, models, online: true, instances: null, title: provider,
    address: "http://127.0.0.1", checkedAt: "2026-01-01T00:00:00Z" };
}

export function reply(output: string, telemetry: Partial<InferenceTelemetry> = {}, finishReason: string | null = null): InferenceResult {
  return { output, finishReason, telemetry: {
    latency_ms: 1, first_token_ms: null, output_tokens: null, input_tokens: null, ...telemetry,
  } };
}

export const withoutPower: typeof startPower = async () => async () => ({
  source: null, scope: "Whole device", interval_ms: 1000, samples: [],
  average_w: null, peak_w: null, sampled_seconds: 0, estimated_energy_j: null,
});

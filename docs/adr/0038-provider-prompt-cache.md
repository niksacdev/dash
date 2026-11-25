# 0038. Measure provider prompt cache reads per request

**Status** Accepted

## Context

A domain prompt or rubric can share the same prefix across many cases. An operator wants to understand how much repeated prompt processing a runtime reused and whether a hosted cost estimate accounts for that reuse.

## Decision

Extend [ADR 0036](0036-live-candidate-usage.md) and [ADR 0021](0021-planning-activity.md). Keep the full prompt count for budgeting, comparisons and totals. Store a separate cache-read count when the provider reports a nonnegative whole number within that request's input total. Recognize explicit zero. A runtime that omits this counter leaves it unreported. Validate native SDK progress against the final input total. Scope observations to one attempt, model and case. Keep an available provider count independently of currency rate availability. Send it in Opik's numeric span usage as `cache_read_input_tokens`.

Eligible providers can automatically reuse stable prompt prefixes. Keep the approved instruction and case ordering, avoid inserting dynamic run identifiers, and leave cache contents in the selected runtime. For supported Claude models at the canonical OpenRouter endpoint, allow a saved endpoint to opt in to marking a scenario dataset's shared system instructions as an ephemeral cache block. Leave that control off until the operator selects it. Do not mark case-authored turns, references, or responses. The provider controls minimum prefix length, write charges and retention. A repeated evaluation still calls its candidate and produces a fresh answer. Local records contain counts, not copies of provider cache entries.

## Alternatives and verification

Inferring cache hits from elapsed time would confuse model warm-up, inference load and actual reuse. Subtracting hits from the prompt budget could make a candidate exceed its context window. Replaying cached answers would invalidate an evaluation of generation. The [operator scenario](../reviews/outcome-workflow.md#read-prompt-cache-usage-on-a-repeated-case) records the live LFM3 measurement. Tests cover missing, zero and inconsistent counts, usage-only stream events, pinned SDK serialization, and older saved results. [OpenAI guide](https://developers.openai.com/api/docs/guides/prompt-caching) · [OpenRouter guide](https://openrouter.ai/docs/guides/best-practices/prompt-caching) · [Ollama API](https://docs.ollama.com/api/chat)

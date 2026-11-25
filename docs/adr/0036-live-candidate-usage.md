# 0036. Show provider observations during an active candidate request

**Status** Accepted

## Context

An operator could see a saved output-token count after inference, while a running comparison streamed answer text and showed a static input-budget check. The native LM Studio SDK also exposes how many tokens a prediction fragment represents. A reference dataset could spend several seconds generating tokens before its final usage appeared.

## Decision

Extend the per-request receipt in [ADR 0021](0021-planning-activity.md) and the durable outcome in [ADR 0011](0011-checkpoint-model-outcomes.md). Carry reported input counts, reported or approximate output counts and first-visible-output timing in a request-local observation. Use the existing run poll with an optional usage cursor so an idle poll sends no duplicate figures. Quick responses can also receive new answer text. The dataset poll sends measurements for the active case without exposing its partial output. Existing renderers retain the original poll contract. Completed results and charts use the final provider receipt.

## Alternatives and evidence

A per-fragment IPC push or SQLite write would add traffic proportional to model throughput. Counting characters or text chunks could misstate token usage for a provider that only reports it at completion. A tokenizer preflight can measure formatted input independently and is labeled **checked**. SDK fragment totals carry **≈** until the provider reports final usage. The [acceptance scenario](../reviews/outcome-workflow.md#observe-candidate-usage-during-dispatch) and runner, adapter and Electron tests distinguish these cases.

In a fresh Electron profile on an Apple Silicon Mac, a synthetic reference case dispatched to the loaded `lfm3-1.7b` instance. The active Dataset screen showed 28 input tokens throughout and 19 distinct output updates, including approximately 11, 69 and 125 tokens. The final receipt recorded 28 input and 128 output at the requested cap. This verifies the live display independently of the case grade.

# 0029. Approve a shared JSON contract for a Quick comparison

**Status** Accepted

## Operator decision

An inspection lead asks two models to extract a part identifier and a measured diameter from the same observation. A consumer needs consistent field names and types. A pass on the response format and an accurate measurement are separate outcomes.

## Decision

Extend [metric and prompt review](0022-review-metrics-and-grader-drafts.md) and [inference checkpointing](0011-checkpoint-model-outcomes.md). Give the operator an optional structured-output mode when drafting a Quick compare prompt. The implementer proposes a task input and a response schema in the existing drafting call. The operator reviews these before approval. Quick compare sends the identical approved JSON user input and response contract to both candidates. Preserve the input, schema and provider result with the run. A reference answer, metric, judge rubric or expected disposition belongs to the evaluation process. Candidate messages contain only the task, the material provided for it and its public response contract.

Use a closed object with a bounded number of typed fields for this first release. Nullable fields let a model report that evidence is missing. Validate responses against the approved contract and retain the actual provider output and failure reason. The operator can still choose free-form responses. A dataset scenario owns its existing case contract.

## Alternatives and trade-offs

Prompting for JSON in prose leaves the runtime unaware of the contract. Forcing JSON on every task would also constrain open-ended answers. A provider schema and local validation let us record whether each response conforms. Shape alone cannot establish that the measurement is correct. A task-specific grader can compare its value to a supplied observation. This decision makes no latency or accuracy improvement claim. Run a representative task on the chosen model to measure either.

## Evidence

See the [operator walkthrough](../reader/src/models.md#request-structured-json) and [Quick compare acceptance scenario](../reviews/outcome-workflow.md#approve-a-structured-extraction).

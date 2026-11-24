# 0023. Report failure at the step that owns the outcome

**Status** Proposed

## Context

A Financial Services planning error told an operator to load LFM3 after LM Studio had already returned a response. Elsewhere, loss of the Opik status read could hide a usable local report, and a grader failure could make a confirmed candidate answer look like a failed inference. These cases require different recovery actions.

## Decision

Extend [durable candidate outcomes](0011-checkpoint-model-outcomes.md) and [metric feasibility review](0022-review-metrics-and-grader-drafts.md). The component that knows whether a request was dispatched classifies its failure. It supplies safe, specific text and preserves the original uncertainty. A transport rejection, an invalid completed reply and an unconfirmed dispatch carry different implications for repeating work. Grading and optional reporting each own their outcomes.

Show the affected operation and recovery in its own view. A failure to read optional data leaves local results accessible. A retry of status or a saved sync cannot start another model evaluation. The desktop handles stale Electron commands and local storage errors even when a usable renderer is unavailable. Keep raw third-party messages, parser excerpts, private file paths and credentials outside shared diagnostics.

A global exception handler cannot discover which case was saved or whether the endpoint accepted the request. A single generic retry button can duplicate inference or mislead an operator about persistence. Component-specific classification requires tests at each external boundary and a review of future SDK changes.

## Evidence

The [audit and acceptance scenarios](../reviews/error-handling.md) connect each defect to its owner and verification. The [operator guide](../reader/src/results.md) explains how to find the last saved result.

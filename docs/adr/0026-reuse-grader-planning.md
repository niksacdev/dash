# 0026. Share objective planning between runs and grader authoring

**Status** Accepted

## Context

The grader workspace accepted an objective and free-text measures. Quick compare and Dataset run already provided domain routing, metric suggestions with an independent feasibility audit, prompt optimization, and explicit approval. An inspection reviewer could receive different guidance for the same objective depending on where the work began.

## Decision

Extend [metric feasibility and grader design](0022-review-metrics-and-grader-drafts.md) and [using a saved grader](0024-use-a-saved-grader.md). Create a grader reuses the run planner’s objective editor, Suggest Metrics action, editable prompt review, version approval, planning receipts and explanations. Each source has its own draft. A workspace planning action must leave in-progress run configuration and model selections alone.

Prompt approval in the workspace creates a catalogue version and passes its identity to the existing grader designer. The design uses the original objective, approved task instructions, reviewed metrics and success criteria, scoped to the selected snapshot when present. The operator reviews the proposed graders before saving. Selecting an existing approved prompt skips planning. Manual rule entry remains available.

Separate planning pipelines would allow audit behavior and privacy settings to diverge. Moving the operator to Quick compare would interrupt grader creation and could change a run draft. Shared controls with separate draft state require routing progress events to the originating request, while preserving one authoritative approval and grader confirmation path.

## Verification

An [Electron acceptance case](../../dash-desktop/test/workflow-smoke.cts) uses simulated models to suggest inspection measures, edit the prepared prompt, approve two success metrics, and inspect the grader designer’s real request. It checks that unchanged suggestions reuse the prior expert result, both reviewed measures reach the designer, changing industry excludes the previous source’s suggestions, an existing prompt can design a grader for an agent without replanning, and the model roster and grader library stay intact until their respective actions. [Workflow specification](../reviews/outcome-workflow.md)

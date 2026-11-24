# 0034. Choose the evaluator while reviewing a grader

**Status** Proposed

## Decision

Extend [grader planning](0026-reuse-grader-planning.md) and [local decision defaults](0030-local-decision-defaults.md). The model that proposes a grading plan and the model that scores candidate outputs have separate responsibilities. Persist the reviewed scoring method, evaluator and evidence scope on each new grader revision. Reuse the local Opik model adapter and native decision transport. The designer may propose Opik partial-credit rubrics. An operator choosing a binary evaluator writes an explicit yes/no criterion and selects a locally discovered native decision model. Leaving a saved grader unchanged preserves the version in earlier runs.

## Alternatives and trade-offs

Ordinary chat inventory can include a checkpoint without a native decisions endpoint. New reviewed local decisions use native discovery. Judging an answer from the complete case could disclose the SME solution, so the operator can restrict a decision to the task and answer or the answer alone. Older versions retain their saved evidence behavior. Native probability cutoffs distinguish pass, fail and abstention. A binary probability cannot supply the partial-credit levels of a rubric. Built-in Opik metrics continue to offer relevance, usefulness, moderation and hallucination.

The product and technical critics identified two risks. Automatically importing a graded rubric into a binary decision would lose its anchors. Giving a new backend the full case could also disclose evidence hidden from the previous judge. The review screen preserves the graded rubric while the operator edits a distinct binary question, exposes evidence scope and keeps mandatory reference and trajectory requirements. Experimental starting questions require calibration and remain outside profile defaults. The exact-model selection and evidence gates have [synthetic transport coverage](../../dash-desktop/test/decision-model.test.cts). The [operator scenario](../reviews/grader-library.md#review-the-scoring-backend) covers both authoring paths.

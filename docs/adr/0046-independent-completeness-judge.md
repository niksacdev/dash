# 0046. Grade requested deliverables with an independent decision model

**Status** Proposed

## Operator decision

An operator comparing two handoff notes needs to know whether each answer supplies every requested deliverable. Saying that an answer arrived cannot establish that it includes a disposition. A complete but incorrect disposition also needs a separate factual check.

## Decision

Extend the [native decision grader](0005-decision-model-graders.md) and the [grading evidence policy](0045-shared-grading-evidence.md). Offer the native local decision endpoint for an explicitly selected list of deliverables. Grade each item separately. Keep whole-answer adequacy in its domain rubric. JSON syntax and runtime completion already have deterministic checks. Keep each run bound to its grader revision and judge. Validate the scoring judge against both candidates before dispatch. Preserve earlier scores and their provenance when an operator reviews saved answers.

## Alternatives and trade-offs

A rule suffices for exact keys or an exact label. It misses free-text paraphrases and can pass a present but empty field. A generative judge is useful for interpretation, although a candidate grading its own comparison introduces bias. Native Choice can select a category, and native Score reports an expected level across ordered anchors. The open Omni checkpoint confidently endorsed an incorrect financial answer under both modes in a small local experiment. A confidence number alone cannot settle factual correctness. Keep the simpler native yes/no mode for this grader and retain uncertainty for operator review. Broader use depends on independently labeled, held-out cases from the deployment domain.

## Verification

Exercise complete, missing-item, wrong-but-complete and missing-checklist examples. Check Quick, Dataset and grading saved answers, including overlaps between a candidate and a selected judge. [Calibration and operator scenario](../reviews/decision-model-graders.md#grade-completeness-with-an-independent-judge)

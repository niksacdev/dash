# 0022. Review metric feasibility before approving a prompt or grader

**Status** Accepted

## Context

A local LFM3 replied to a synthetic earnings objective with language copied from the expert instructions. The prior workflow accepted that language as a per-case criterion. Transport success and a parseable proposal provide little evidence that the measure will distinguish a good answer from a poor one. The grader library also had two authoring surfaces, leaving operators who opened the manual form to reconstruct the designer’s recommendations.

## Decision

Extend [grader revision ownership](0006-grader-library.md) and [planning query receipts](0021-planning-activity.md). After the domain expert proposes checks, a separate versioned auditor reviews them against the objective and the evidence available to the workflow. One shared local planner may perform both roles. A new model or framework is unnecessary. Show the required inputs and scoring method, and identify business outcomes that require external measurements. A proposed metric remains a design decision until a selected grader actually scores eligible cases.

Use collapsed explanations in Suggest Metrics and prompt review. Preserve the original objective, the actual guidance added, and the provenance of the review. Editing a proposal or prompt changes what the explanation can support. Historical versions retain the evidence recorded at approval.

Workspace grader creation uses the existing designer and its versioned confirmation path. Operators review the proposed checks, reuse eligible immutable versions or edit new definitions and explicitly save them. Workspace authoring leaves the run’s choices under the operator’s control. A manual entry remains available when the operator already has a rubric. For semantic checks, tie the rubric to a specific measure and give observable conditions for full, partial and zero credit. Missing case evidence can prevent scoring. When a labeled field or existing domain rule directly implements the measure, reuse it. Opik G-Eval handles custom semantic scoring through its TypeScript SDK. [SDK metric contracts](https://www.comet.com/docs/opik/reference/typescript-sdk/evaluation/metrics)

Runtime setup uses LM Studio’s loopback catalogue and explicit load operation. A model validation failure and an unavailable runtime require different recovery steps. A downloaded model becomes ready for inference only when native inventory reports its instance. [LM Studio load](https://lmstudio.ai/docs/developer/rest/load) · [Model inventory](https://lmstudio.ai/docs/developer/rest/list)

## Trade-offs and review

The audit adds a planning call. Reuse an unchanged audited proposal when drafting, and retain per-query usage. Rejecting a weak check can leave an operator with no runnable measure. The explanation should identify the evidence to supply. A single earnings case can test agreement on GAAP EPS. Estimating a reduction in analyst time needs a measured baseline and follow-up.

The product review used an unlabeled earnings objective and a supplier-lot disposition. The technical review examined instruction echo, reference leakage, stale explanations, model/instance identity, and duplicate load requests. The operator walkthrough and the grader guide describe the corresponding behavior. [Outcome workflow](../reviews/outcome-workflow.md) · [Grader guide](../reader/src/graders.md)

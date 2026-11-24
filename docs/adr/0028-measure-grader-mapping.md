# 0028. Pin a grader for each approved Quick compare measure

**Status** Accepted

## Operator decision

A Financial Services analyst wants to compare how two models handle the value, basis and period in an earnings release. An overall rubric can grade the entire answer but its single score cannot establish which individual checks passed. The operator needs to see the measure, its per-answer pass condition and the grader that will produce its score before starting inference.

## Decision

Extend [grader revision ownership](0006-grader-library.md), [metric feasibility](0022-review-metrics-and-grader-drafts.md) and [shared grader planning](0026-reuse-grader-planning.md). Keep candidate instructions in the approved task prompt. Use the approved measure and pass condition to configure a specific grader. For each runnable measure in Quick compare, the operator can select a compatible saved grader or a dedicated Opik G-Eval rubric. Capture the assignments and immutable grader versions in the run. Apply each mapped check to every candidate’s returned output. Use those recorded scores, explanations and outputs in the comparison. Preserve missing observations and historical holistic scores.

## Alternatives, trade-offs and review

Displaying one overall rubric score on every metric row would invent independent measurements. Matching grader names or keywords after the run would make earlier results depend on the current library. Replacing the run engine would duplicate evaluation and Opik code that already applies each pinned grader to each candidate. Reuse that path and record the missing mapping. Independent semantic measures require additional judge calls; an eligible deterministic rule can avoid that cost. A single prompt compares answers on that case. Use a versioned dataset for an aggregate pass rate.

The product and technical review followed a pair of earnings answers with complementary errors from approval through the comparison. Verify the two independent per-answer scores for each candidate, recorded grader identities, absent evidence and historical compatibility. [Acceptance scenario](../reviews/outcome-workflow.md)

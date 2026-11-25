# 0044. Challenge a recorded verdict using saved responses

**Status** Proposed

## Operator decision

A judge can award equal scores to conflicting inspection decisions. A Manufacturing operator needs to see what the original rubric required, which response it graded and what its reason actually says. An independent decision check can expose an incorrect pass without running the candidates again.

## Decision

Extend [saved-answer reviews](0039-score-readiness-and-recovery.md) to completed two-candidate comparisons. Display the candidate answers, the actual judge or rule receipts and the original rubric. Offer a case-specific challenge with a different grader version. An explicitly requested check scores both saved answers and records one local review with the grader revision, evidence source and individual reasons. Compare numeric scores only when both receipts validate under the same grader and serving revision. Present the supplementary finding separately from the original verdict and synchronized experiment.

The Manufacturing inspection rules use facts from an identifiable versioned sample or verified facts for the individual case. One rule verifies the reported active limits and measurement. Another distinguishes a supported hold decision from an incorrect acceptance. Inconclusive evidence remains unscored.

## Alternatives and evidence

Rewriting the original grade would conceal the judge error. A second free-form opinion cannot verify a numeric boundary without governing facts. Reuse the saved-answer review API, pinned grader execution and receipt validation. The synthetic regression challenges an original judge tie, verifies both deterministic receipts and checks that the original export and verdict match. The Electron workflow exercises the challenge from Run history. [Report tests](../../dash-desktop/test/run-report.test.cts) · [Workflow checks](../../dash-desktop/test/workflow-smoke.cts) · [Operator instructions](../reader/src/results.md#challenge-a-completed-verdict)

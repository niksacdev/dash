# 0039. Verify score coverage before inference and review saved answers

**Status** Accepted

## Decision

A Manufacturing operator comparing two inspection decisions needs to know whether DASH can score both answers against the approved acceptance criteria before buying candidate tokens. In a historical Quick comparison, both candidates produced answers and passed one business check. Their second check required verified facts that the run had never collected. Generating those answers again would not supply the missing facts.

Extend [per-measure mapping](0028-measure-grader-mapping.md), [Quick setup](0031-quick-evaluation-setup.md) and [expected answers](0037-grader-expected-answers.md). Show the coverage of the selected business checks across the starting line. At run creation, validate required measure assignments, declared evidence, pinned evaluators, local judge availability and configured hosted decision credentials. Verify local native decision-model inventory before generating a candidate response. Completion and response-format diagnostics cannot stand in for an approved business measure. Quick compare can explicitly collect answers for inspection without a quality verdict. Dataset scoring uses the snapshot's own cases, evidence and scoring method.

A terminal report can grade a case's saved answers together. Apply one immutable grader version to all completed responses for that case. A missing expected answer can be supplied once for the review. Keep the source of those facts, the grader revision and its lane-specific scores in local supplemental records. A reviewed verdict can use a complete pair of supplemental scores on a previously incomplete original grader. It must satisfy the original comparison policy across the entire case set. A new rubric can produce a supplemental assessment but cannot change the original policy. For a decision grader, all cases must use one actual serving revision. Choose the pinned primary when it supplied a complete original case, otherwise the first complete original case in manifest order. If there were none, the earliest comparable saved pair establishes the revision. Keep every original pair on that revision and use the first qualifying review for each remaining case. This choice is independent of the scores.

## Alternatives and trade-offs

Automatically rerunning the candidates spends tokens and may produce different responses. Replacing historical scores would destroy the distinction between evidence collected at inference and facts supplied later. Treating a failed judge or an abstention as a score would reward or penalize a candidate without evidence. Setup can find missing prerequisites. A judge can still disconnect, return an invalid verdict or abstain after dispatch.

Keep review evidence in local storage and keep separate review receipts out of the original export and Opik experiment. Each completed review lane is saved independently. Opening the report or restarting DASH does not repeat a judge request. The operator can inspect interrupted receipts before requesting another review.

The independent critique identified silent skips in the renderer, direct IPC without measure assignments, response diagnostics counted as business coverage, and generic instructions on historical incomplete runs. The [acceptance scenario](../reviews/outcome-workflow.md#recover-a-comparison-with-a-missing-business-score) reproduces the historical failure with synthetic evidence. [Operator guide](../reader/src/results.md#grade-saved-answers)

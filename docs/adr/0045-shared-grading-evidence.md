# 0045. Share evidence rules across grading agents

**Status** Proposed

## Operator decision

An earnings answer can quote the adjusted figure under a GAAP label. An agent can claim that an order succeeded when its only receipt records a rejection. For either task, the operator needs a grader that identifies which source settles the claim, and a report that accurately describes what the score establishes.

## Decision and alternatives

Extend [decision-model graders](0005-decision-model-graders.md) and [saved-answer challenges](0044-challenge-a-verdict.md). Version one short evidence guide and include it in the effective instructions of the shared expert, metric auditor, grader designer, output analyzer and reporter. Each participating agent’s existing pin hashes its complete instructions. Put domain knowledge about specific evidence in the appropriate pack or case. A shared text reduces drift between stages and adds context tokens only for those agents.

A reusable or Quick rubric may declare the reference it will need before a case exists. Preserve a measure’s approved reference requirement from design through confirmation. A fixed dataset with no answer key cannot supply that evidence.

Use a deterministic check when an authoritative comparison is available. A calibrated decision model can answer one bounded question. G-Eval is available for criteria that need semantic interpretation or partial credit. Retain the operator’s approved grader, observed serving model and any abstention. A supplementary review grades both saved answers and retains both sets of receipts.

We considered automatically forwarding uncertain decision scores to a chat judge. The five-case local decision pilot referred both a correct and an incorrect answer for review. In a later six-case Finance and order-agent smoke test, both judges left the same false EPS claim unresolved. Neither exercise establishes an accuracy gain for a cascade. Missing source evidence and provider failures cannot establish correctness. An automatic handoff would also require its own version, consent for its destination, comparable evaluation of both candidates, and separate receipts for each stage.

## Evidence for revisiting the decision

Compare standalone decision, standalone G-Eval and conditional escalation on the same blinded, independently labeled holdout. Split by source document or workflow so near-duplicate cases stay together. Tune thresholds on a separate calibration set. Keep the second judge blind to the first score. Sample confident decisions as well as abstentions. Compare false accepts among known negatives, false rejects among positives, coverage, accuracy on decided cases, unresolved cases, calls, cost and latency. Prefer a cascade only if it improves the operator’s declared error and resource targets on the held-out cases. [Design critique and calibration](../reviews/decision-model-graders.md) · [Operator guidance](../reader/src/graders.md#match-a-grader-to-the-claim)

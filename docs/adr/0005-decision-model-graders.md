# 0005. Grade a bounded criterion with a selectable decision model

**Status** Proposed

## Objective

An inspection engineer wants to compare two candidates on whether they held a lot that exceeded the current drawing tolerance. A financial reviewer wants to catch an answer that substitutes adjusted EPS for reported GAAP EPS. Each can express the decision as one yes/no question and supply a reference. The same question can be tried with another judge while earlier assessments remain reproducible.

## Decision

Save the domain, criterion, required evidence, pass and fail thresholds, provider and requested model in an immutable grader revision. Select that revision for a dataset run, Quick compare or a manual assessment of a saved output. Keep the candidate and the judge independent. Send the candidate’s actual dispatched input and output with the available reference, case rubric, SME rationale, approved business measures and observed agent actions. A missing required reference or trajectory leaves the criterion unscored.

A local revision can also pin one alternate model on the same server. Use that model only when preflight establishes that the primary is unavailable, before sending case evidence. Record the requested, dispatched and reported model identities when switching. A refused, failed or uncertain inference ends the assessment.

The TypeScript runner calls the selected provider’s native decision API and uses Opik’s `BaseMetric` for scored feedback. A probability at or above the upper threshold passes, and a probability at or below the lower threshold fails. The interval between them abstains. Record the probability, thresholds, selected and reported model IDs, grader revision, and any reported usage. Errors, missing evidence and abstentions produce no numeric feedback. Opik synchronization replays the saved assessment and its provenance. A case rerun pins the original revision and requests fresh permission before using a hosted grader.

## Acceptance

An operator can save the inspection question, grade the same synthetic case under two pinned judge versions, and revisit both results. Rerunning the original case still uses its original grader. A missing drawing leaves a required-reference assessment unscored. If an approved local alternate serves one candidate while the primary serves the other, the report retains both observations and withholds the winner. Local Opik readback must show feedback for a definite outcome, trace provenance for an abstention, and no additional inference when synchronization is retried.

## Apple Silicon verification

DASH graded the five bundled Manufacturing replay answers through the native MLX-VLM 0.8.0 HTTP server using Liquid d1 Omni 2B FP16. Candidate answers came from the saved fixture. Judge probabilities came from the real local checkpoint. At fail ≤ 0.20 and pass ≥ 0.80 the judge passed three answers and referred two for review. It gave the incorrect release on a superseded shaft drawing 0.2828 and the correct unit-conversion answer 0.4482. The deterministic scenario grader caught the false release. Keep that exact revision and tolerance check alongside the probabilistic grader.

The five grading requests used 3,650 reported input tokens and zero generated tokens. A separate check with an unavailable primary selected the preauthorized local alternate and saved its actual identity. The five recorded cases synchronized to the local Opik dashboard with five scenario grades and three numeric decision grades. This exercise verifies the integration and illustrates abstention. It supplies no estimate of production accuracy or relative cost.

## Review findings

- A catalog entry alone cannot establish that a runtime serves a decision model. Verify the responding model and validate its typed probability. Keep the candidate output and the grader failure separately if the runtime rejects the model.
- A decision probability expresses the judge’s confidence for that criterion. A report compares the recorded pass/fail results and coverage. Suppress a winner when judged cases are missing or the served judge identity changes within the comparison.
- A hosted grader can receive held-out business evidence. The operator chooses the hosted model and confirms disclosure for each grading operation. Local grading uses loopback. Failure never switches the provider automatically.
- Domain labels determine whether a grader works for its intended purpose. Before promoting a rubric, compare it with SME-labeled positive, negative and ambiguous cases. Evaluate false passes and abstention rates. Hosted API pricing, token usage and judge confidence alone establish neither accuracy nor local cost savings.

DASH already uses Opik for feedback, versioned datasets and experiments in its self-hosted dashboard. DASH supplies its own reviewed industry rubrics and reuses native Opik metrics for general evaluation. The [grader library decision](0006-grader-library.md) records the implementation. This feature needs one typed probability, a recorded abstention and a switchable serving backend. [Opik metrics](https://www.comet.com/docs/opik/reference/typescript-sdk/evaluation/metrics) · [DeepEval JevEval](https://deepeval.com/docs/metrics-jev-eval) · [Operator guide](../guides/workbench.md#use-a-decision-model-as-a-grader)

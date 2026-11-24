# 0030. Pin local decision graders as cross-industry run defaults

**Status** Proposed

## Decision

Extend [0005](0005-decision-model-graders.md) and [0006](0006-grader-library.md). An operator may enable a local binary decision grader for new Quick compare and Dataset runs when the grader is explicitly cross-industry, independent of a scenario, and requires neither a reference nor an agent trajectory. Use one default slot per decision grader family. Pin the chosen revision alongside configured Opik metrics and the existing deterministic checks. A profile begins with zero automatic decision graders. Record the IDs added automatically in the manifest. Each of those judges receives only the candidate-visible task and answer with the fixed criterion. Explicit selections and measure mappings retain the normal grading evidence. Pin that disclosure on case reruns and include it in the dataset scoring policy fingerprint.

## Alternatives and consequences

Selecting the grader on every run made the same reviewed check easy to omit. Running all catalogue entries would apply industry rules to unrelated tasks and could send case evidence to a hosted judge. The operator chooses a compatible criterion and its local endpoint. New revisions change the dataset scoring policy fingerprint. A rerun retains the earlier decision model, rubric and thresholds. The existing native decision adapter records unavailability and abstention without a numeric score. A general criterion can grade an input-only case, while a case bearing a specific SME rubric still requires an explicitly selected rubric-aware judge.

## Review and evidence

The product, security and technical reviews identified evidence minimization, family identity, policy hashing and case-rubric eligibility as prerequisites for shared defaults. The [workflow specification](../reviews/grader-library.md) and [runner regression](../../dash-desktop/test/quick-graders.test.cts) cover explicit enablement, exclusion of hosted decisions, paired candidate assessments, unavailable judges and pinned case reruns.

A local MLX-VLM service running D1 Omni 2B FP16 assigned a synthetic hold answer a probability of 0.9498 and a release answer 0.0668. With pass at 0.80 and fail at 0.20, those decisions separated the two fixture answers. This two-answer calibration established the local judge path. An isolated wire test checks that automatic requests omit held-out evidence and that explicitly selected graders receive the saved case contract. [Evidence-scope regression](../../dash-desktop/test/grader-defaults.test.cts)

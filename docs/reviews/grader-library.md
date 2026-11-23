# A reusable grader library for domain outcomes

## Operator workflow

A team evaluating an earnings extractor or an inspection reviewer needs to see which checks run automatically, which concern its domain, and which were approved for this particular objective. The local DASH workspace is the customer boundary. Financial Services and Manufacturing are the initial industry packs.

| Library section | What an operator can do | Execution |
| --- | --- | --- |
| General | Inspect standard output checks and configure common Opik metrics using a local judge | Fresh evaluations automatically pin response presence and completion. A declared JSON contract adds syntax validation. An operator can enable an approved cross-industry Opik metric revision for future runs. |
| Industry | Select an expert-authored check from the scenario it understands, inspect its criterion, or customize it | The runner verifies the domain and scenario before it pins the selection. The built-in scenario acceptance policy also runs. |
| My graders | Write a new grader, review a proposal from an outcome and metrics, fork a shipped grader, or revise a workspace grader | Each run records the immutable revision. The same revision can appear on many runs. An edit creates a new revision or an independent family with a parent link. |

## Acceptance examples

- A generic Quick comparison accepts prose. A syntactically valid reply alone cannot win a business-outcome evaluation. A missing provider stop reason stays unknown.
- On the Financial Services earnings fixture, a basis/value check catches adjusted EPS of 0.85 substituted for GAAP EPS of 0.74. A labeled nondisclosure can have a correct null value.
- On the Manufacturing fixture, an inspection using the superseded drawing remains a false accept even when a general quality metric rewards the prose. Cases include a boundary measurement, converted units and a missing rule.
- A customer can accept an applicable existing revision or review new criteria from a business outcome. A fork records its parent, remains independently editable and cannot change earlier runs. An old case rerun retains its original manifest even after a library upgrade.
- Opik owns its SDK metrics, datasets, experiments and feedback. DASH owns domain applicability, the reviewed definitions and local pins. Never infer readiness, factual accuracy or observed agent tool use from response syntax. Never send held-out grading context to a candidate.

## Review findings

The product and technical reviewers found that keyword overlap could attach a literal grader to an unrelated Quick task and that lowercased display names coupled unrelated grader histories. Require an explicit business selection, stable family identity and an exact saved revision. Score structural checks as diagnostics and preserve domain-specific failures in the comparison. Inspect both working paths and missing-evidence cases with synthetic data. Use the actual SDK behind scoring and verify the Electron review, version and reuse flow.

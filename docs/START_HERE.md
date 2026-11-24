# DASH documentation

For installation and a first evaluation, start with the [project README](../README.md). The [workbench guide](guides/workbench.md) covers model selection, grader approval, dataset imports, case reruns, and device measurements.

The [runtime agent guide](guides/agents.md) explains how to edit, version and ship agent instructions. The [TypeScript architecture decision](adr/0003-typescript-runtime.md) records the UI, runner and Opik boundaries.

## Specifications and original artifacts

These seven Library artifacts were verified on November 22, 2026. Revisions refer to the original Library files. The earnings pack reads the original synthetic seed directly.

| Artifact | Purpose | Library revision |
| --- | --- | --- |
| [Platform specification](specs/Financial_AI_Eval_Lab_Spec.md) | Desktop architecture, workflows, design and acceptance criteria | 12 |
| [Earnings release scenario](specs/DASH_Use_Case_01_Earnings_Release.md) | Business outcomes, financial evidence and scoring policy for the first domain scenario | 0 |
| [Synthetic earnings cases](../dash-desktop/packs/earnings/financial_eval_dev_seed.jsonl) | Eight development cases with model input and held-out labels | 0 |
| [Offline prototype](design/DASH_Design_Prototype.html) | Simulated UI and placeholder results | 0 |
| [Approved design preview](design/DASH_Design_Preview.png) | Original visual reference | 8 |
| [Race animation](design/DASH_Run_Animation.gif) | Simulated in-progress comparison | 2 |
| [Archived logo exploration](design/archive/Eval_Bench_Logo_Concepts.png) | Early concepts retained for provenance | 0 |

## Design and architecture

Read the [chronological decision log](adr/README.md) for status, rationale, related decisions and the PR that reviewed each material product, design or architecture choice.

The [design assets](design/README.md) include screenshots of the running app and the source of the circuit artwork. Accepted decisions cover the [domain hierarchy](adr/0001-domain-workbench.md) and [Opik integration](adr/0002-opik-and-offline-runs.md). The [decision grader ADR](adr/0005-decision-model-graders.md) explains model selection, missing evidence and abstention.

The [grader library ADR](adr/0006-grader-library.md) and [feature specification](reviews/grader-library.md) explain automatic checks, industry criteria, customer forks and review.

The product reviews cover the [domain workbench](reviews/domain-workbench.md), [outcome-to-run workflow](reviews/outcome-workflow.md), [live agent feasibility](reviews/agent-runs-feasibility.md), and [local decision models for domain grading](reviews/decision-model-graders.md). For implementation changes, follow the [contributor guide](../.github/CONTRIBUTING.md).

For development, follow the [pre-commit review workflow](guides/precommit-review.md) and its [acceptance scenarios](reviews/repository-quality.md).

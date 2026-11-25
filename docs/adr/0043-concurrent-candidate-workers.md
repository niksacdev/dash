# 0043. Schedule candidates independently within one evaluation

**Status** Proposed

## Context

Gemma and LFM3 can both be loaded in LM Studio on the same workstation. Previously DASH submitted their cases in series. A long first answer or judge assessment could keep the second candidate from receiving its first prompt. The runtime decides when each submitted request gets compute time. DASH can observe response events and durations but has no view of the provider’s queue or GPU scheduling.

## Decision

Keep one active evaluation job. After whole-run preflight, give each selected candidate one asynchronous worker, up to two. In Quick compare each worker handles one prompt. In Dataset run each worker walks the same case order, including the grading for its current answer before advancing. Bind events, saved responses, measurements and assessments to the candidate and case. The final report waits for the workers to settle and uses the pinned graders to compare business outcomes.

Each worker follows the [durable dispatch policy](0011-checkpoint-model-outcomes.md). Stop applies to both workers. A provider error belongs to its case. A fatal storage failure aborts the sibling worker and the job waits for both to settle. Keep confirmed replies and the last durable state for interrupted calls. Reopening an interrupted evaluation never automatically repeats a possibly executed request.

Extend the [host energy policy](0035-request-energy.md) and [live evaluation lanes](0040-evaluation-race-lanes.md). A two-candidate evaluation observes one whole-device power window spanning worker activity and grading, between preflight and report preparation. Keep per-case tokens and response latency with their request. Shared joules have no per-model allocation. A host that supplies too few valid samples has no energy estimate.

## Alternatives and consequences

Serial evaluation avoids competition for the same host at the cost of delaying the other candidate. For the [earnings scenario’s isolated hardware comparison](../specs/DASH_Use_Case_01_Earnings_Release.md), operators can repeat a fixed snapshot in two one-candidate Dataset runs, using the same warm-up and host conditions. Dispatching every case at once would multiply outstanding model and judge requests on a workstation and could overload a hosted endpoint. Two independent workers bound the requests and preserve each candidate’s case order. A shared runtime can still serialize the requests or slow both of them down. Completion order provides no evidence about which model meets the objective.

The [inspection scenario](../reviews/outcome-workflow.md#run-two-candidates-against-the-same-inspection) defines acceptance for cross-candidate overlap, case order, recovery and energy attribution. The [Dataset guide](../reader/src/dataset-runs.md) explains what operators can observe.

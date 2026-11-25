# 0042. Show measured timing and case progress

**Status** Proposed

## Decision

Use the circuit photograph for the model comparison slide on Overview. Use a calibrated scale for recorded case counts, score comparisons and performance measurements. The zero and maximum share the same endpoints for both candidates. During an open-ended request, show its observed stage and respond briefly to incoming output. Remove the simulated vehicles, exhaust and scrolling road from the application.

This revises the presentation in [0040](0040-evaluation-race-lanes.md). Keep its contracts for candidate identity, units, missing values and the final verdict. The original design artifacts remain historical references.

## Alternatives and consequences

The earlier continuous drive cycle made a waiting model look busy. A percentage extrapolated from elapsed time would imply knowledge of when the runtime will stop. The selected design needs only the progress events DASH already receives. An unknown reading has no numeric marker, and a completed measurement stays still. The same labels are readable when motion is reduced.

For a Manufacturing comparison, verify that two different dispositions are legible with their recorded grader checks before performance and the detailed correctness report. A long latency or energy reading indicates a larger quantity in the stated units. [Operator scenario](../reviews/outcome-workflow.md#follow-the-selected-candidates-during-a-run)

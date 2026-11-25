# 0040. Connect race lanes to observed work

**Status** Accepted

## Decision

An operator comparing two models needs to see which one is answering, which grader is scoring it and how many cases have completed. Extend [live candidate usage](0036-live-candidate-usage.md) and the [carousel visual language](0015-industry-carousel.md). Reuse the existing car silhouette. Bind each lane to the candidate identifier in the run manifest and the current runner checkpoint. Scoring identifies its judge. Preparing the report parks the candidates.

In an open-ended call, drifting road markings and a short exhaust trail indicate activity. A provider-reported preprocessing percentage or saved dataset case count places the car at the measured position. Completed results and historical measurements are static. All states have text equivalents and support the system reduced-motion preference.

[0042](0042-motorsport-timing-display.md) revisits the visual treatment of these measurements.

## Alternatives and consequences

Advancing a car using elapsed time or the maximum output tokens would present an unsupported estimate. Animating every lane would misrepresent sequential inference. Independent review identified both risks and the distinction between an assessment receipt and a passing grade. Existing result charts retain their original units and measured values. The renderer uses CSS animations and the existing progress subscription; tracking the lane adds no polling or inference requests. [Acceptance scenario](../reviews/outcome-workflow.md#follow-the-selected-candidates-during-a-run)

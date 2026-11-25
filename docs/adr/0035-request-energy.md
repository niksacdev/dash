# 0035. Show sampled host energy for each observed request

**Status** Proposed

## Context

When an operator compares two responses or reviews AI preparation, token counts describe model usage. The host’s latest watt reading describes instantaneous power. A request can end before the sensor returns two observations, and the host can be running other workloads.

## Decision

Extend [planning activity receipts](0021-planning-activity.md) with an optional whole-device energy estimate, its source and sampled seconds per planning attempt. Show existing per-case energy beside input and output counts. Integrate consecutive valid watt readings using the trapezoidal rule, omit gaps over three seconds, and preserve missing values. The candidate runner already owns its sensor lifetime and records the answer before finishing telemetry. Planning collects reads in the background during each provider attempt and cancels outstanding reads when it settles. It adds no sampling delay to short calls. The server stores only the summary for planning. Existing Opik synchronization uses the candidate’s recorded telemetry after operator approval.

## Alternatives and consequences

Multiplying the current watts by request latency assumes constant power and invents coverage for gaps. Estimating from tokens misses background load and cannot identify a hosted provider’s energy use. DASH labels the host and coverage, shows an average over measured cases in history and grades outcomes separately. Supported Apple hosts currently use the AppleSmartBattery SystemLoad sensor. Hosts without that sensor show an unavailable value. Existing receipts stay readable. [Acceptance scenario](../reviews/outcome-workflow.md#read-energy-for-an-observed-request)

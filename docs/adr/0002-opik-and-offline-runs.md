# 0002. Use Opik for evaluation and experiment management

**Status** Accepted

## Context

DASH must run on an offline device and measure local inference. Teams also need portable grader definitions and comparable experiments on a shared service.

## Decision

Use the official Opik TypeScript SDK from Electron’s main process. Opik implements ExactMatch, Contains and G-Eval. A DASH adapter connects G-Eval to a selected local model. DASH owns the domain brief, the review step, case-specific checks and the immutable list of graders attached to a run.

The local SQLite record makes a disconnected run inspectable and preserves token allocation, device samples and approvals. A configured Opik destination receives native datasets, experiment items and feedback for finished runs. Use native Opik versions for case additions, edits, and removals within the same domain, scenario, and dataset family. Pin each candidate experiment to its measured version. Use the SDK’s experiment logging API to attach existing responses, timings, token counts, and feedback scores. Stable identities and local delivery receipts allow a retry to resume after a lost acknowledgement.

## Alternatives considered

Reimplementing the evaluator or experiment APIs in the desktop UI would create a second incompatible system. Depending on a reachable Opik server for every run would prevent offline work and couple inference timing to telemetry delivery. An evaluator that invokes the candidate again during sync would produce a different response and latency from the locally measured run.

## Consequences

Measurement and synchronization errors must be distinguishable. Record a missing grade as unscored. Require an explicit destination before sending case data, references, outputs or traces. Keep Opik credentials outside the repository. Changes to scoring or synchronization must be tested against the SDK’s actual contract.

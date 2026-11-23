# 0002. Use Opik for evaluation and experiment management

**Status** Accepted

## Context

DASH must run on an offline device and measure local inference. Teams also need portable grader definitions and comparable experiments on a shared service.

## Decision

Use the official Opik TypeScript SDK from Electron’s main process. Opik implements ExactMatch, Contains and G-Eval. A DASH adapter connects G-Eval to a selected local model. DASH owns the domain brief, the review step, case-specific checks and the immutable list of graders attached to a run.

The local SQLite record makes a disconnected run inspectable and preserves token allocation, device samples and approvals. A configured Opik destination receives native datasets, experiment items and feedback for finished runs. Keep case and candidate identities stable so recorded results can be synced and compared without running inference again.

## Alternatives considered

Reimplementing the evaluator or experiment APIs in the desktop UI would create a second incompatible system. Depending on a reachable Opik server for every run would prevent offline work and couple inference timing to telemetry delivery.

## Consequences

Measurement and synchronization errors must be distinguishable. Record a missing grade as unscored. Require an explicit destination before sending case data, references, outputs or traces. Keep Opik credentials outside the repository. Changes to scoring or synchronization must be tested against the SDK’s actual contract.

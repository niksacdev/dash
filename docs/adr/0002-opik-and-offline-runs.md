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

## Resuming an upload with Opik 2.2.144

A synchronization attempt can lose an HTTP response after Opik has accepted the write. The documented experiment bulk endpoint accepts traces, spans and feedback together. Its open-source ingestion service generates a fresh experiment-item ID for every input on every call. Retrying the same payload can therefore add a second experiment item for a case whose trace already exists. [Opik post-hoc experiment guide](https://www.comet.com/docs/opik/evaluation/advanced/log_experiments_with_rest_api) · [Bulk ingestion implementation](https://github.com/comet-ml/opik/blob/main/apps/opik-backend/src/main/java/com/comet/opik/domain/ExperimentItemBulkIngestionService.java#L329-L339)

DASH uses the SDK's batch trace, span, experiment-item and feedback endpoints separately. It allocates IDs with the SDK's `generateId()`, saves them locally before the request, and reconciles conflicting experiment-item acknowledgements against the experiment, case and trace IDs. Native dataset versions and approved prompt versions are pinned at experiment creation. The SDK's experiment update contract cannot attach a prompt to an experiment created without a prompt link. Existing experiment IDs remain usable.

The loopback SDK regression runs without a live service. It simulates committed writes with lost acknowledgements, a restart, duplicate delivery and a later run pinned to an older version. It checks that each experiment links the intended dataset items, exact prompt revision, recorded traces and genuine scores.

The live self-hosted API requires a metadata-only first version with `override=true`. It rejects a second initialization of an existing dataset, even with the override. Subsequent case changes always name their base, use `override=false` and verify exact content by reading the new version. Querying by experiment ID during retry reconciliation already selects its version. Opik rejects a simultaneous dataset-version filter. A live synthetic retry preserved exactly one experiment item per candidate and feedback of 1 and 0. [Upstream initialization and locking](https://github.com/comet-ml/opik/blob/cbc0c11195a51951ad472dde4bb82cab47b21ab6/apps/opik-backend/src/main/java/com/comet/opik/domain/DatasetItemService.java#L1469-L1510)

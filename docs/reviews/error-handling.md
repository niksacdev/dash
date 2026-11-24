# Error handling across the workbench

An operator asks the Financial Services expert for a measurable earnings check and then evaluates a dataset. The expert might return unusable criteria, a candidate might disconnect after dispatch, and an Opik service might fail after DASH saved the answers. The operator needs to know which step failed, what evidence survived and which next action is safe.

## Acceptance

- A successful connection followed by invalid model output identifies the failed planning step. A missing model, authentication failure, timeout and an uncertain dispatch have different recovery actions.
- An interruption after dispatch keeps its last saved evidence. A grader, reporting, sensor or sync failure leaves a confirmed answer available without repeating model inference.
- A failed read has a visible recovery action. The run status and local results remain accessible when an optional service fails. Raw IPC wrappers, provider response bodies, credentials and parser excerpts have no place in operator guidance.
- Failure to open the desktop shows a native recovery message. Missing commands in a stale Electron process direct the operator to preserve edits and reopen the app.
- Checks use fresh profiles, simulated failures and synthetic cases. Coverage describes exercised paths. Live service failures and disk damage are never induced on an operator's workspace.

## Boundary review

| Boundary and finding | Operator impact and verification |
| --- | --- |
| Planning and provider transport (high). An endpoint could echo a private prompt in its exception. An uncertain generation could trigger the configured hosted fallback. | Exercise invalid JSON, schema violations, template rejection, authentication, quota, disconnect and cancellation. Check the model and failed stage, use bounded validation retries only where the response is known, and count calls after an uncertain dispatch. [Planner](../../dash-desktop/lib/planner-routing.cts) · [Transport tests](../../dash-desktop/test/provider-transport.test.cts) |
| Runner, graders and storage (high). A scorer or report-cache fault could hide a saved answer. A truncated direct judge reply could be parsed as a verdict. | Preserve candidate output. Record grader errors as missing grades, and keep derived reports readable when the cache fails. A failed primary write stops further dispatch. Inject scorer, sensor and SQLite faults and inspect the saved evidence. [Runner failure checks](../../dash-desktop/test/runner-failures.test.cts) |
| Opik and export (high). The original publisher could report success after another session acquired its lease. Different HTTP failures had the same credentials advice. Older saved exceptions could contain case text. | Verify ownership before confirming progress or completion. Exercise two sessions, status-specific messages, redaction of shared diagnostics and resume using recorded data. [Opik sync checks](../../dash-desktop/test/opik-experiments.test.cts) |
| Navigation and forms (medium). A failed progress read stopped live updates. Reading optional Opik status could prevent the entire saved report from rendering. A temporary toast could disappear before an operator corrected a field. | Exercise inline form errors, retained field values, retrying the read, continued access to local scores and navigation during an asynchronous request. [Electron checks](../../dash-desktop/test/desktop-smoke.cts) |
| Startup and desktop commands (high when startup fails). A dependency read could fail before a window existed. Raw IPC wrappers and local paths obscured the recovery step. | Catch initialization and activation failures, route startup errors to a native dialog and preserve meaningful validation messages across the sandboxed bridge. Distinguish missing commands, storage access, full disks and malformed input. [Desktop boundary checks](../../dash-desktop/test/desktop-errors.test.cts) |

## Independent review findings

Three regression checks came from review. A second SQLite connection renews the incumbent Opik lease between a contender’s read and claim, then verifies that the contender makes zero SDK calls. Canceling during LM Studio template validation leaves a preparation trace and zero predictions. When the saved run and performance cache disagree after a failed terminal write, Run history uses the recoverable run status and distinguishes recorded cases from confirmed answers.

## Coverage and limits

The review covered the desktop entry and bridge, renderer actions, planning and fallback, local and hosted model adapters, decision models, dataset jobs, grading, reporting, sensors, import and export, Opik synchronization and local service setup. Existing safeguards worth retaining include checkpoint-before-dispatch, isolated provider timeouts, bounded response reads and atomic export replacement. Security work focused on error disclosure, correctness on dispatch and persistence, performance on bounded reads and retry traffic, and maintainability on keeping classification beside the operation that can establish what happened.

Synthetic faults allow repeatable checks of conditions such as full disks, a truncated judge reply and a service returning a private test string. The suite exercises the shipping paths with isolated state. It cannot reproduce every vendor outage or OS failure. An operating-system kill can prevent a final message, and a remote service may finish after a timeout. The last durable checkpoint is the evidence for recovery.

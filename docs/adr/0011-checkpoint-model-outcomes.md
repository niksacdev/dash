# 0011. Persist the model outcome before optional work

**Status** Proposed

This extends the [offline run policy](0002-opik-and-offline-runs.md). A candidate can return a complete reply while a sensor is slow or unavailable. A transport can also disconnect after producing partial output. Operators need durable evidence of which case finished and which request may still have executed.

Checkpoint the dispatch before contacting the runtime. Persist a confirmed response, its measured usage and its reported finish reason before awaiting final telemetry or grading. Keep an unconfirmed dispatch visible with its observed partial output. A bounded, explicitly rejected request can be recorded as a terminal error. A lost response gets no inferred completion, grade or automatic retry. An operator can explicitly rerun a saved case as a linked run.

If LM Studio confirms an answer but reports an input count that differs from preflight, save both counts, the text and the runtime’s finish reason. Exclude the answer from business grading. Response diagnostics can still describe what the runtime returned. A judge using a verified token budget must reject a mismatched result.

If SQLite cannot checkpoint streamed text, abort the active candidate request and fail the job before dispatching another case. Retain the first storage error across SDK callbacks and cancellation. The last durable checkpoint remains available after restart.

Automatically repeating every failed request can duplicate charges or agent side effects. Coupling sensor failures to inference can erase a successful answer. The selected policy trades automatic recovery of ambiguous requests for an auditable record of what actually happened. Safe reads or idempotent service writes may have their own bounded retry and reconciliation policy. [Reproduction and acceptance criteria](../reviews/repository-quality.md)

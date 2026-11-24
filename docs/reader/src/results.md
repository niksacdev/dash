# Read scores and timings

Open **Run history**, filter by industry if useful, and select **Run to inspect**. Use **Evaluation result** to see each candidate’s scores, then **Open run details** to find the case behind a number.

The **Traceability and Observability** slide uses a GAAP-versus-adjusted EPS mismatch as an example. Inspect the grader reason locally or [sync the run to Opik OSS](opik.md) to follow a case trace with latency, available token counts and grader scores.

## Explain a failed case

1. Open the metric in **Evaluation report** and expand **Case scores and rationale**. Check the grader revision, judged case, candidate and explanation.
2. Open the case. Compare the actual dispatched input, returned answer and held-out reference. A missing reference or interrupted request can leave a case **Unscored**. A score of zero records an evaluated failure.
3. For Opik risk metrics such as Hallucination, higher native values mean higher risk. DASH also shows a quality score, calculated as one minus risk, so higher quality reads consistently across the comparison.

A winner requires complete scores on the same cases, a lead on at least one rubric and no losses on the others. Read the coverage and missing evidence when the report shows a tie, mixed results or an inconclusive comparison.

## Find measured performance

| Question | Where to look |
| --- | --- |
| How quickly does each candidate answer? | **Run history → Performance → Response latency** shows median and 95th percentile per response, alongside the measured count. |
| How long did one call take? | **Open run details → Telemetry** shows case latency and time to first visible output when available. **Developer → Case telemetry** provides additional detail. |
| How much work did the model do? | The report shows input and output tokens when supplied. Power reflects the whole DASH host during the call on supported devices. |
| How long did preflight, all inference, judges and reporting take together? | DASH currently has no end-to-end elapsed-time chart or separate duration for each stage. Per-response latency alone cannot answer this question. |

These charts use local records. A recorded-answer replay has no measured candidate inference timing. An unavailable sensor reading stays missing. To inspect the same run as experiments in Opik, [sync the saved run](opik.md).

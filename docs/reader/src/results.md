# Read scores and timings

Open **Run history**, filter by industry if useful, and select **Run to inspect**. Use **Evaluation result** to see each candidate’s scores, then **Open run details** to find the case behind a number.

The **Traceability and Observability** slide uses a GAAP-versus-adjusted EPS mismatch as an example. Inspect the grader reason locally or [sync the run to Opik OSS](opik.md) to follow a case trace with latency, available token counts and grader scores.

## Follow a running Quick comparison

After starting the evaluation, **Evaluation in progress** identifies the candidate answering or the grader scoring it. **Answers received** counts completed responses. **Grader assessments recorded** counts recorded assessments, including an unscored assessment when a judge lacks evidence. An activity bar keeps moving while a call is pending. The counters advance when DASH records evidence. Open the final results to inspect each response, criterion and score.

## Compare two answers by business measure

In Quick compare, the report pairs each approved measure with the criterion and grader version used on both answers. Inspect the two scores, the corresponding outputs and the assessment evidence. For example, one earnings answer might give the correct GAAP EPS and omit the reporting period. A second might cite the period and use adjusted EPS. If these are separate pass/fail checks, the scores are 1 and 0 for the EPS check, and 0 and 1 for the period check. The verdict is mixed. Use a labeled dataset when you need a pass rate over many cases.

A measure left unscored has no numeric value. The report retains historical overall rubrics at the granularity at which DASH recorded them.

## Explain a failed case

1. Open the metric in **Evaluation report** and expand **Case scores and rationale**. Check the grader revision, judged case, candidate and explanation.
2. Open the case. Compare the actual dispatched input, returned answer and held-out reference. A missing reference or interrupted request can leave a case **Unscored**. A score of zero records an evaluated failure.
3. For Opik risk metrics such as Hallucination, higher native values mean higher risk. DASH also shows a quality score, calculated as one minus risk, so higher quality reads consistently across the comparison.

A winner requires complete scores on the same cases, a lead on at least one rubric and no losses on the others. Read the coverage and missing evidence when the report shows a tie, mixed results or an inconclusive comparison.

## Recover from a failed step

| What happened | What to do |
| --- | --- |
| DASH lost contact with a candidate after sending a case. | Open the case and inspect its last saved output. The model may have executed. Choose a linked rerun only if you want a second request. |
| The candidate answered but a grader could not complete. | Open the case to see its saved answer and the grader’s reason. Review the required evidence, judge and output budget before testing the grader again. Missing grades remain unscored. |
| The run screen could not read progress. | Refresh the run status to check the existing job. A failed status read alone says nothing about whether the model completed. |
| The local result is available but the Opik service failed. | Inspect the case scores in DASH. Follow the sync message for the selected destination and resume the saved sync when available. |
| DASH reports a workspace write failure. | Check drive space and folder access. Inspect the last durable case in Run history before deciding which work to repeat. |

## Find measured performance

| Question | Where to look |
| --- | --- |
| How quickly does each candidate answer? | **Run history → Performance → Response latency** shows median and 95th percentile per response, alongside the measured count. |
| How long did one call take? | **Open run details → Telemetry** shows case latency and time to first visible output when available. **Developer → Case telemetry** provides additional detail. |
| How much work did the model do? | The report shows input and output tokens when supplied. Power reflects the whole DASH host during the call on supported devices. |
| How long did preflight, all inference, judges and reporting take together? | DASH currently has no end-to-end elapsed-time chart or separate duration for each stage. Per-response latency alone cannot answer this question. |

These charts use local records. A recorded-answer replay has no measured candidate inference timing. An unavailable sensor reading stays missing. To inspect the same run as experiments in Opik, [sync the saved run](opik.md).

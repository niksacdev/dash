# Read scores and timings

Open **Run history**, filter by industry if useful, and select **Run to inspect**. Use **Evaluation result** to see each candidate’s scores, then **Open run details** to find the case behind a number.

The **Traceability and Observability** slide uses a GAAP-versus-adjusted EPS mismatch as an example. Inspect the grader reason locally or [sync the run to Opik OSS](opik.md) to follow a case trace with latency, available token counts and grader scores.

## Follow a running evaluation

In **Evaluation in progress**, each selected model has a labeled lane. During preflight both cars are parked. When DASH calls a candidate, its lane shows **Waiting for response**, then **Generating** when the provider reports output. **Scoring** names the active grader and its version. After DASH saves an answer the car parks while the next candidate runs. During report preparation the heading identifies the current step.

On a Dataset run, each car’s position marks the number of case results saved for that candidate, including errors. In Quick compare the moving road indicates an open call with an unknown duration. **Answers received** counts successful responses. **Grader assessments recorded** includes unscored checks. The final report determines the verdict. During prompt preparation a provider may also report the percentage of the prompt it has read. Reduced-motion settings keep every label and measurement with the cars parked.

A live candidate can show **Input tokens** with the label **checked** when its local tokenizer measured the formatted prompt before dispatch. Quick compare and the active Dataset case show counts as the runtime reports them. The input total usually stays fixed for one request. A native LM Studio run can show a growing **≈** output count from its prediction fragments, including tokens spent on reasoning. Only the answer text is displayed. First visible output records the delay before answer text arrived. An endpoint that only supplies final usage leaves the running token count pending. Completed results use the provider’s final receipt. In **Run history**, the two token charts show per-model averages over the responses that reported each count. An unreported count stays out of its average.

## Compare two answers by business measure

In Quick compare, the report pairs each approved measure with the criterion and grader version used on both answers. Inspect the two scores, the corresponding outputs and the assessment evidence. For example, one earnings answer might give the correct GAAP EPS and omit the reporting period. A second might cite the period and use adjusted EPS. If these are separate pass/fail checks, the scores are 1 and 0 for the EPS check, and 0 and 1 for the period check. The verdict is mixed. Use a labeled dataset when you need a pass rate over many cases.

Each parked car marks the measured score. In **Response diagnostics**, two cars at 100% on **Response present** mean that both models returned an answer. Their business grades appear separately. An unscored answer has no car. For a missing comparison, select **See why cases have no comparable score** to inspect the recorded reason for each candidate. A measured zero puts the car at the start. The report retains historical overall rubrics at the granularity at which DASH recorded them.

## Grade saved answers

If a report says **Incomplete comparison**, open **Grade saved answers**. Choose the affected case when the run has several. DASH lists which candidate and business check lack a score. For example, both candidates may have supplied a reporting period, while the period grader lacked an expert-confirmed date.

1. Keep the original grader version selected to review that measure. If you want to ask a different question, choose a different saved grader version.
2. Enter the **Expected answer or verified facts** when required. The same facts go to the grader for both saved answers. For a dataset case that already has verified facts, leave the additional field empty. Confirm the destination if the grader uses OpenRouter.
3. Choose **Grade saved answers**. A model-based grader may use judge tokens. DASH reads the recorded candidate responses and saves each graded lane. See the scores under **Saved-answer reviews**.

When every missing case has a complete review under the original rubric versions and the original decision rule can resolve the result, DASH shows a separate **Reviewed verdict**. A supplementary rubric, a judge abstention or a still-missing case cannot establish the original winner. If the decision server selected different model revisions for the two answers, both receipts stay visible. Make one revision available for both and grade the saved pair again. In a dataset, use the serving revision named above the grader for every outstanding case. DASH preserves cases already scored on that revision. A case with two scores from a different revision remains available for an explicit review. The original run, export and synchronized Opik experiment retain their recorded scores. If a lane has no completed answer, inspect its trace. A Dataset case can be rerun explicitly to generate a new response.

## Explain a failed case

1. Open the metric in **Evaluation report** and expand **Case scores and rationale**. Check the grader revision, judged case, candidate and explanation.
2. Open the case. Compare the actual dispatched input, returned answer and held-out reference. If an earlier run reports a missing case reference, the grader lacked the correct answer for that case. Return to **Grade saved answers** to provide it once for all saved responses. Use **Test one output** in the Grader library for a separate single-response trial. An interrupted request can also leave a case **Unscored**. A score of zero records an evaluated failure.
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

## Read device energy

**Device energy (est.)** appears beside input and output tokens on candidate responses, in case telemetry, and in AI planning query details. For example, **12 J · 1.5 s sampled** means that the DASH host used an estimated 12 joules during 1.5 seconds covered by whole-device power readings. The observation window can include adapter preparation or a failed request. Other applications contribute to the reading. For a hosted request, the value covers your local device only. The provider’s server energy is unavailable.

DASH integrates successive power readings about one second apart. A sensor failure or a gap longer than three seconds breaks the interval. A single watt reading can show device power but cannot establish energy. A short planning query may finish before two readings arrive. **Pending** changes to the recorded estimate or **Unmeasured** when the observation ends. Older runs display any energy already recorded. Fixture replay supplies no inference measurements.

Run history shows the mean energy per measured case and the number of measured cases. Compare the sampled durations along with the joules. The grader verdict depends on the approved success measures.

## Find measured performance

| Question | Where to look |
| --- | --- |
| How quickly does each candidate answer? | **Run history → Performance → Response latency** shows median and 95th percentile per response, alongside the measured count. |
| How long did one call take? | **Open run details → Telemetry** shows case latency and time to first visible output when available. **Developer → Case telemetry** provides additional detail. |
| How much work did the model do? | The report shows input and output tokens when supplied. Power reflects the whole DASH host during the call on supported devices. |
| How long did preflight, all inference, judges and reporting take together? | DASH currently has no end-to-end elapsed-time chart or separate duration for each stage. Per-response latency alone cannot answer this question. |

In **Performance**, each card uses a shared scale for the candidates shown. A car farther right on **Response latency** means the model took longer. On **Device energy (est.)**, it means more joules were measured on the host. The car's position describes the quantity in the card's units. **Pass rate across runs** uses the same 0–100% scale across run dates. In a Dataset run, choose a compatible **Saved baseline** to compare passed cases and false accepts. The two lanes use only cases measured on both sides. **Change in count** gives the current count minus the baseline count.

These charts use local records. A recorded-answer replay has no measured candidate inference timing. An unavailable sensor reading stays missing. To inspect the same run as experiments in Opik, [sync the saved run](opik.md).

## Read cached input tokens

Open a candidate response or its case telemetry and look beside **Input tokens**. **Cached input tokens** tells you how much of that same prompt the runtime reused. For example, **503 cached** out of **1,019 input** means the model received all 1,019 input tokens. Keep the full input count when setting a context budget. **0** means the runtime reported a cache miss. **Pending** means a live request is waiting for a measurement. **Unreported** means the completed request supplied no usable count.

A provider may report cache use during prompt processing or only with the final receipt. Each model, case and planning attempt has its own count. A cache read can reduce prompt processing time or the input charge under a provider's pricing plan. DASH shows an estimated monetary cost only when it has the required usage and supported rates. [Prompt caching at OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching)

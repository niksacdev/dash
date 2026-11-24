# Sync a run to Opik

Use this when you want a saved DASH evaluation in the self-hosted Opik dashboard. DASH can run models, apply supported native Opik metrics with a local judge, and show the scores locally before you sync anything.

## Start the local service

With Docker running and Compose 2.24.4 or later available, run `npm run setup:local` from `dash-desktop/`. Wait for **Local dashboard and API ready**. If DASH was open during the first setup, reopen it. Use `npm run opik:status` to check the services. For setup, storage and troubleshooting, see the [local Opik guide](https://github.com/niksacdev/dash/blob/main/docs/guides/local-opik.md).

## Publish one saved evaluation to your chosen destination

1. In **Run history**, select the finished run. Open **Opik experiments** and review the workspace, project, API destination and disclosure.
2. **Sync saved run to Opik** sends the **full saved dataset snapshot**, including references and SME guidance, plus inputs, outputs, timing, usage and scores for evaluated cases. When the run has an approved candidate-facing prompt, sync also versions that prompt in Opik’s prompt registry and links it to the experiments. A one-case rerun still sends the full snapshot. Sync uses recorded results and does not repeat candidate inference.
3. Choose **Open Opik dashboard** to see a candidate experiment for each model on the pinned dataset version. After an interrupted sync, use **Resume saved run sync** for that same run and destination.

To show a metric in the DASH report, [attach its grader revision before starting the run](graders.md#add-an-opik-score-to-a-dataset-run). A score added independently in Opik does not flow back into the saved DASH report.

## Which engine grades a response?

| Grader chosen in DASH | What executes |
| --- | --- |
| Opik G-Eval | The official TypeScript SDK applies the approved criteria through the selected local judge. It returns a normalized score and explanation. DASH applies the saved pass threshold. |
| Answer relevance, usefulness, hallucination or moderation | The corresponding Opik metric scores the response. DASH keeps the native score and direction. A high hallucination or moderation risk translates into a low quality score. |
| Exact match or contains | The Opik matching metric compares the response with the expected text. This needs no judge call. |
| Industry rule, field comparison or ordered tool calls | DASH checks the domain evidence or the recorded actions with the versioned rule. A decision-model grader calls its configured decision endpoint. The separate local LLM judge method uses DASH’s score-and-reason request. |

Before reusing a judgment-heavy rubric, try a known pass, a decisive failure and a case missing the evidence it requires. Check both the score and the explanation. For example, if using adjusted EPS in place of reported GAAP EPS must receive zero, a judge that awards partial credit still misses the rubric even when its score falls below the pass threshold. Use a field comparison or the earnings scenario rule when the expected value and basis are available in structured data.

Grading runs in the workbench using the selected inference destination. You can grade locally with self-hosted Opik stopped. Synchronization later publishes recorded experiments, traces and scores to the configured Opik service. A planning suggestion is a draft rubric. To use it for scoring, save its version and select it for the run. [Choose graders](graders.md) · [Opik TypeScript metrics](https://www.comet.com/docs/opik/reference/typescript-sdk/evaluation/metrics)

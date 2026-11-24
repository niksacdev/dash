# Sync a run to Opik

Use this when you want a saved DASH evaluation in the self-hosted Opik dashboard. DASH can run models, apply supported native Opik metrics with a local judge, and show the scores locally before you sync anything.

## Start the local service

With Docker running and Compose 2.24.4 or later available, run `npm run setup:local` from `dash-desktop/`. Wait for **Local dashboard and API ready**. If DASH was open during the first setup, reopen it. Use `npm run opik:status` to check the services. For setup, storage and troubleshooting, see the [local Opik guide](https://github.com/niksacdev/dash/blob/main/docs/guides/local-opik.md).

## Publish one saved evaluation to your chosen destination

1. In **Run history**, select the finished run. Open **Opik experiments** and review the workspace, project, API destination and disclosure.
2. **Sync saved run to Opik** sends the **full saved dataset snapshot**, including references and SME guidance, plus inputs, outputs, timing, usage and scores for evaluated cases. When the run has an approved candidate-facing prompt, sync also versions that prompt in Opik’s prompt registry and links it to the experiments. A one-case rerun still sends the full snapshot. Sync uses recorded results and does not repeat candidate inference.
3. Choose **Open Opik dashboard** to see a candidate experiment for each model on the pinned dataset version. After an interrupted sync, use **Resume saved run sync** for that same run and destination.

To show a metric in the DASH report, [attach its grader revision before starting the run](graders.md#add-an-opik-score-to-a-dataset-run). A score added independently in Opik does not flow back into the saved DASH report.

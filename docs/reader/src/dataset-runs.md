# Run a dataset

Choose this workflow when you want to ask the same questions again after changing a model, prompt or grader. One run can use one or two candidates.

When a grader needs an expected answer, setup checks coverage across the selected snapshot. Each row supplies its own verified answer or facts. Complete missing rows in a new dataset version, or select a grader whose rule can be applied to the task and response alone. Review **Verdict coverage** to see which check applies to each selected candidate. DASH verifies native decision-server availability before candidate inference.

## Run a bundled scenario

1. Open **Dataset run**. Choose **Earnings release capture** for financial extraction or **Incoming inspection triage** for manufacturing, then verify the dataset snapshot and split.
2. Review the authored inputs and scenario grader. Use the saved case prompts for a baseline. **Test a prompt variant** is for an intentional change to the prompt.
3. Open **Choose graders** beside the Model roster. Select a saved version and choose **Attach and return to Dataset run**. **Selected graders** shows the pinned versions for this snapshot. Use **Change** to replace a version or **×** to remove it. Each case keeps its own input and held-out grading evidence.
4. Select one or two connected models in the **Model roster**, check the **Starting line**, and choose **Run evaluation**. With five cases and two candidates, expect ten candidate responses on a completed run. **Automatic checks** and the optional **Design graders** action appear in the same place as in Quick compare. [Choose a grader](graders.md)
5. In the completed run, inspect **Business outcomes** and **Cases**. In the Manufacturing example, check the active drawing, its limits, and the part disposition. A plausible measurement alone cannot justify release against an older drawing.

## Compare a change

Keep the same case IDs, snapshot, split and grader revisions when comparing a new candidate. When testing a prompt revision, hold the candidates and grader revisions fixed. Run history retains the selected versions.

DASH runs the job in the background and processes the candidate/case calls sequentially. You can inspect progress while it works. If a connection drops, check the saved case trace and partial output before choosing **Rerun case**. A rerun creates a linked run and uses the original pins. [Read scores and timings](results.md)

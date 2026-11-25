# Choose a workflow

<div class="circuit" aria-hidden="true"></div>

DASH helps you test whether a model makes the right business decision. A Financial Services team can check whether an earnings extractor reports GAAP EPS. A Manufacturing team can check whether an inspector releases a part against the correct drawing revision.

The header shows the app version and, in Git builds, the short commit ID beside **Light** and **Dark**. Include both when reporting a problem.

Use the banner arrows on **Overview** to walk through the six slides in order.

1. **Run domain-specific use cases** opens the tour. Financial Services and Manufacturing have runnable scenarios. Automotive is planned.
2. **Task Objective, Success Metrics (AI Optimized)** uses a Manufacturing example. The goal is to flag bearings outside tolerance. The AI suggests measuring the share of defective parts caught and the share of good parts incorrectly flagged. You can edit both metrics.
3. **Compare and benchmark multiple models** shows how to compare two local on-premises or closed API models using the same prompt and rubric.
4. **Grade each answer against your rubric** shows an answer passing through **AI Industry Graders** to produce a case score. Choose an industry grader or review criteria drafted by AI.
5. **Traceability and Observability** shows why a GAAP earnings check failed when the model returned adjusted EPS. DASH uses Opik OSS for per-case tracing. [Sync a run](opik.md) to inspect its traces, latency, available token counts and grader scores.
6. **Hardware in the Loop**, labeled **FUTURES**, illustrates a planned test. A real controller sends commands to a simulated motor, which returns speed feedback for the next control step.

**New to DASH?** [Start with a recorded earnings case](first-run.md). See why a recorded answer fails the scenario grader before choosing a live model.

| What do you want to learn? | Where to start |
| --- | --- |
| How would two models answer one business objective? | [Quick compare and the starting line](models.md#try-one-objective-in-quick-compare) |
| Does a model handle an entire scenario consistently? | [Run the same dataset on one or two candidates](dataset-runs.md) |
| Can I test my own labeled cases? | [Download an example and import a versioned dataset](datasets.md) |
| Which grader measures success for my task? | [Choose a grader and a judge](graders.md) |
| Why did a model fail, and how long did it take? | [Read the case evidence and timing charts](results.md) |
| Can I inspect the experiment in self-hosted Opik? | [Sync a saved run](opik.md) |

The steps in this guide take place in the DASH desktop app. The reader works on a phone or desktop. For domain specifications, design decisions and original artifacts, visit the [project documentation index](https://github.com/niksacdev/dash/blob/main/docs/START_HERE.md).

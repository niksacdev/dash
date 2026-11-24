# Choose a grader for a run

The **AI Industry Graders** step in the Overview uses versions from **Workspace → Graders**. Choose an existing industry check or review a proposal from the grader designer. Start with the evidence a domain expert needs to decide whether the answer is correct.

| Success criterion | Grader to use |
| --- | --- |
| The model must return a specific label such as `HOLD`. | Match the reference exactly on a labeled dataset. |
| The model must use the requested GAAP figure or the active drawing revision. | Attach the matching **Industry** grader. Inspect the expected fields or evidence for that scenario. |
| The answer should address the user’s question or help them act. | Configure Opik **Answer relevance** or **Usefulness** with a local judge. |
| The response must be grounded in the approved evidence. | Use Opik **Hallucination** with a nonempty case reference. DASH also offers **Moderation** for content-risk checks. |
| An SME describes several qualities in plain English. | Use an Opik G-Eval rubric, or ask the grader designer to propose checks from your objective and success measures. Review thresholds and evidence before confirming a revision. |

## Add an Opik score to a dataset run

1. Open **Workspace → Graders → General → Opik metric templates**. Pick **Configure metric** on **Answer relevance**.
2. Choose a local **Judge model**, review the pass threshold and select **Save grader version**. The version fixes the judge and grading policy used for the run.
3. In **Dataset run**, expand **Optional graders** and select the saved version. Use **Use on new runs** in the library only if you want that metric to become a cross-industry default for eligible future runs.
4. Run your candidates, then open **Run history → Evaluation result**. Open **Case scores and rationale** in the detailed report to see the native score, direction and judge’s explanation.

For earnings extraction, pair relevance with a grader that checks the requested accounting basis. An answer can address EPS directly and still quote adjusted EPS when the question asks for GAAP.

## Reuse or revise a policy

The **General** library also supplies response diagnostics, including response presence and completion. **Industry** contains reusable scenario checks. **My graders** holds your own definitions and versions. A change to a threshold or judge belongs in a new revision so earlier scores remain interpretable.

### Create a grader with an agent

In **Graders → Create a grader**, choose **Design with an agent**. Describe the task, choose its domain, and add a success measure per line when you have several. You can also choose a saved prompt or dataset snapshot under **Design for**.

For example, choose a Manufacturing inspection snapshot and ask the agent to check whether the response cites the active drawing revision. Select **Propose graders**. An existing check shows its pinned version and offers reuse or a customer copy. For a new check, review the suggested name, category, industry, method, criterion and pass threshold. Judge-based methods suggest a loaded local judge when one is available. For a semantic rubric, the draft names the success measure and describes what earns full, partial and zero credit. A required reference or agent trajectory must be present for the judge to score. You can edit each proposal, change methods when the evidence supports them, and exclude any check. A prompt or dataset fixes its industry.

For a measure such as “Share of handoff notes that identify the lot and state the next action,” the grader checks both details in each generated note. The proposal selects **Answer only**. The judge sees the candidate’s text, so an action in the original task cannot count as an action written in the note. For a rubric that checks factual correctness against a source, choose **Task, answer and available case evidence**. The saved version records the evidence view.

A note that contains both earns full credit. A note missing either earns zero. For “actual reduction in warranty costs six months after dispatch,” DASH leaves the outcome unscored. Verifying savings needs post-dispatch records and a comparable baseline.

Select **Save** to confirm the reviewed checks together. The workspace saves them to the library. Select a saved version in Quick compare or Dataset run to use it. **Write manually** opens the grader form when you already know the rule.

For an observed agent output, you can supply ordered tool actions to a trajectory grader. Live execution of an external hosted agent is a separate planned workflow. [Decision-model grading and other methods](https://github.com/niksacdev/dash/blob/main/docs/guides/workbench.md#use-a-decision-model-as-a-grader)

## Calibrate an AI rubric

Use one known pass, one near miss, and one case with the required evidence missing. Compare the numerical score with the saved rubric boundaries. If the metric is the share of inspection notes containing both a lot ID and a next action, a note earns one only when both are present. A note giving just the lot ID contributes zero to that numerator. If you want partial credit, define a separate graded completeness measure. For a rule with a decisive failure, specify which condition takes precedence. Set the pass threshold separately. [How Opik scores answers](opik.md#which-engine-grades-a-response)

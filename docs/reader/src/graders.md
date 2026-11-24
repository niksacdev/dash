# Choose a grader for a run

Choose a grader by asking what evidence would convince a domain expert that the answer was correct.

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

Use the grader designer when a business outcome has several requirements. Write one measurable criterion per line, review the proposed existing or new checks, and confirm the ones you want to save. For an observed agent output, you can supply ordered tool actions to a trajectory grader. Live execution of an external hosted agent is a separate planned workflow. [Decision-model grading and other methods](https://github.com/niksacdev/dash/blob/main/docs/guides/workbench.md#use-a-decision-model-as-a-grader)

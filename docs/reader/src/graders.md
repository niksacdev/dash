# Choose a grader for a run

The **AI Industry Graders** step in the Overview uses versions from **Workspace → Graders**. Choose an existing industry check or review a proposal from the grader designer. Start with the evidence a domain expert needs to decide whether the answer is correct.

## Find an industry grader

Open **Workspace → Graders**. **Create a grader** stays at the top. The **Industry catalogue** groups the shipped checks under Financial Services and Manufacturing. Each card shows a short description and the saved version. Hover over a card, focus **Details** with the keyboard, or tap **Details** to read its criterion and pass threshold.

- **Test** lets you pick a compatible dataset snapshot and case, inspect the source and expected response format, and paste an answer. Scoring uses the selected case and rubric and returns its score and explanation. An earlier model run is optional.
- **Use in Run** carries the exact grader version into Dataset run. Choose your candidates and press **GO** when ready.
- **Create Version** opens an editable copy of a shipped grader. Save it to **My Graders**. Earlier run reports keep the revision they used.

**My Graders** includes your own rules, saved rubric versions and copies of industry checks. **General** contains cross-industry diagnostics and Opik metric templates.

## From an objective to a score

1. Open **Create a grader**. Describe what a good response must do. Choose **Suggest Metrics** to have the domain expert propose measures and the auditor review their evidence. Edit the measures, draft the evaluation prompt, then choose **Approve prompt & propose graders**. If you choose an existing approved prompt, go straight to **Propose graders**. **Write manually** is available when you already have a rule.
2. Open **Reasoning summary** to see which measures an automatic grader covers, its version and why it applies. If all measures are covered, choose **Done**. Select **Save** on the new or reused checks you want. **Ready to evaluate** shows each saved name and version. You can also pick an existing version directly from the library.
3. Choose **Test one output** to paste a task and an existing answer. Select **Score this output** to see the grade and rationale. You can browse elsewhere in DASH while scoring is in progress and return to **Test one output** for the result. If the assessment fails, the draft stays in the current DASH session for editing, retry or discard. When the grader needs a reference answer or the agent’s observed tool calls, DASH opens the fields for that evidence.
4. To evaluate model responses across cases, choose **Use in a dataset run** on the save receipt, or **Use in Run** on its card. DASH opens its source snapshot when applicable. If several snapshots match, choose the family, version, split and industry. Review the selected grader versions, select the candidate models, and press **GO**. You can add or remove graders before starting. Each run records the versions used.
5. Open the completed run’s **Case scores and rationale** to see which answer passed, failed or lacked enough evidence to score.

### Understand the proposed rubric

The proposed grader shows the **Scoring rubric** or **Scoring rule** and the threshold it will use. Open **Reasoning summary** beneath the designer model name to see the recorded justification for each choice and any measures that lack sufficient evidence.

For an earnings task, a grader can check whether the answer identifies diluted GAAP EPS as **$0.74**, identifies **$0.85** as adjusted EPS, and flags a missing reconciliation if the supplied release says none is available. Whether the team reduced analyst review time requires separate timing records. An unmeasurable business figure can stay unscored while an observable answer requirement gets its own rubric.

**Runtime and format checks** are diagnostics. **Generation completed** means the runtime reported a normal stop. **Response present** means the model returned text. Inspect the domain rubric and case result to assess the quality of that text.

## Map a Quick compare measure

From an approved Quick comparison, choose **Choose graders** to open the catalogue for that specific draft. Attach a compatible version, then return to the comparison to see it beside the two chosen models. When you open the catalogue independently, **Use in Run** still offers the dataset workflow.

After approving the task prompt, inspect each measure and its pass condition before selecting **Run evaluation**. A saved deterministic check can answer a literal question. Choose a dedicated Opik rubric and judge when several phrasings can satisfy the condition. Read its full-credit and failure conditions. A check requiring a separate reference answer can be evaluated on a labeled dataset. A business outcome that needs later operational data stays unscored until you have that evidence.

Both candidates receive the same task and each returned answer goes to the same pinned grader versions. A prompt with two independent model-judged measures and two candidates can require four assessments. Additional automatic diagnostics appear separately in the results. Earlier prompt versions can still use their original combined rubric.

## Choose the grading method

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
3. Choose **Use in a dataset run** on the receipt or **Use in Run** on the saved card. In a run you already have open, **Add optional graders** opens the same selection. Under **Manage version**, **Use on new runs** enables the revision as a cross-industry default for eligible future runs.
4. Run your candidates, then open **Run history → Evaluation result**. Open **Case scores and rationale** in the detailed report to see the native score, direction and judge’s explanation.

For earnings extraction, pair relevance with a grader that checks the requested accounting basis. An answer can address EPS directly and still quote adjusted EPS when the question asks for GAAP.

## Run a local decision check on both candidates

Save a **Decision model · yes/no** grader under **Cross-industry** with a local decision server and a criterion you can judge from the prompt and answer. For example, “Does the answer cite a value supplied in the prompt to support its conclusion?” can work across industries when that is part of your team’s policy. Use **Test** to check a known pass, a near miss and a case with insufficient evidence. In **My graders → Manage version**, select **Use on new runs**. Quick compare and Dataset run show the selected revision among their automatic checks and score each candidate separately. Automatic local decisions receive the same task the candidate saw, its answer and the fixed yes/no criterion. If you explicitly select that grader for a run or map it to a success measure, it can also use the available case evidence. A judge failure or a probability between cutoffs leaves that assessment unscored.

Each decision criterion has its own default. Enabling another revision of the same grader replaces the revision for new runs. Case reruns use the versions in the original run. For a domain-specific rule, a criterion that requires reference evidence or agent actions, or a hosted decision model, choose the saved grader explicitly for the run.

## Reuse or revise a policy

The **General** library also supplies response diagnostics, including response presence and completion. **Industry** contains reusable scenario checks. **My graders** holds your own definitions and versions. A change to a threshold or judge belongs in a new revision so earlier scores remain interpretable.

### Create a grader with an agent

In **Graders → Create a grader**, use **AI-assisted**. Describe the task, choose its domain, and add a success measure per line when you have several. You can also choose a saved prompt or dataset snapshot under **Design for**.

For example, choose a Manufacturing inspection snapshot and ask the agent to check whether the response cites the active drawing revision. Review the suggested metrics and draft prompt, then approve the prompt to propose graders. An existing check shows its pinned version and offers reuse or a customer copy. For a new check, review the suggested name, category, industry, method, criterion and pass threshold. Judge-based methods suggest a loaded local judge when one is available. For a semantic rubric, the draft names the success measure and describes what earns full, partial and zero credit. A required reference or agent trajectory must be present for the judge to score. You can edit each proposal, change methods when the evidence supports them, and exclude any check. A prompt or dataset fixes its industry.

For a measure such as “Share of handoff notes that identify the lot and state the next action,” the grader checks both details in each generated note. The proposal selects **Answer only**. The judge sees the candidate’s text, so an action in the original task cannot count as an action written in the note. For a rubric that checks factual correctness against a source, choose **Task, answer and available case evidence**. The saved version records the evidence view.

A note that contains both earns full credit. A note missing either earns zero. For “actual reduction in warranty costs six months after dispatch,” DASH leaves the outcome unscored. Verifying savings needs post-dispatch records and a comparable baseline.

Select **Save** to confirm the reviewed checks together. The workspace saves them to the library. Select **Use in a dataset run** for that version or choose it when setting up Quick compare. **Write manually** opens the grader form when you already know the rule.

For an observed agent output, you can supply ordered tool actions to a trajectory grader. Live execution of an external hosted agent is a separate planned workflow. [Decision-model grading and other methods](https://github.com/niksacdev/dash/blob/main/docs/guides/workbench.md#use-a-decision-model-as-a-grader)

## Calibrate an AI rubric

Use one known pass, one near miss, and one case with the required evidence missing. Compare the numerical score with the saved rubric boundaries. If the metric is the share of inspection notes containing both a lot ID and a next action, a note earns one only when both are present. A note giving just the lot ID contributes zero to that numerator. If you want partial credit, define a separate graded completeness measure. For a rule with a decisive failure, specify which condition takes precedence. Set the pass threshold separately. [How Opik scores answers](opik.md#which-engine-grades-a-response)

In a local LFM3 1.7B test with a synthetic earnings release, the judge awarded full credit to an answer that omitted a required reconciliation warning. Test this omission explicitly when calibrating your own judge. For a labeled earnings dataset, **Requested financial fact** and **Analyst review routing** can check the recorded figure and routing decision directly.

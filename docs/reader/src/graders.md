# Choose a grader for a run

The **AI Industry Graders** step in the Overview uses versions from **Workspace → Graders**. Choose an existing industry check or review a proposal from the grader designer. Start with the evidence a domain expert needs to decide whether the answer is correct.

## Find an industry grader

Open **Workspace → Graders**. **Create a grader** stays at the top. The **Industry catalogue** groups the shipped checks under Financial Services and Manufacturing. General, Industry and My Graders use the same card layout. Each saved version previews its scoring rule. Open **Inspect scoring** to expand the complete rubric, see the evidence it uses and read the pass condition. Decision cards show the yes/no question and cutoffs. Opik metric cards explain how DASH interprets the native score.

From Quick compare or Dataset run, open **Choose graders**. The return panel identifies the approved prompt or dataset snapshot and its selected lanes. **Add to comparison** or **Add to dataset run** attaches a saved version in place. Use **Attach and return** when reviewing its assignment. **Back to evaluation setup** returns to the same draft. If a measure assignment has unapplied edits, **Stay here** lets you finish it.

Both setups show **Selected graders** even when empty. **Change** opens the catalogue to replace a specific revision and keeps the current grader until you confirm. **×** removes that version from the run. **Restore** undoes the most recent removal during editing. **Automatic checks** lists the defaults that will run. Open **Design graders** directly beneath that list to propose another check. When an older running version cannot verify coverage, quit and reopen DASH to resume the saved setup. A temporary catalogue read error offers **Retry**.

In **Quick compare → Graders**, select **×** beside a measure to remove its grader for this comparison. The measure stays visible as **Unscored**. **Restore** brings its grader back during editing. After a reload, use **Choose** to select a grader again. Removing the last check that needs verified facts also removes the reference requirement. You can remove an additional saved grader with **×** and add it again from the catalogue. In **Design graders for this prompt**, use **×** or **Restore** before confirming the proposals to save. Automatic checks remain active, and saved library versions stay available for other runs.

When you edit a manual grader or type a new answer for an industry case or a single-output test, DASH asks before navigation discards those edits. Choose **Stay here** to keep typing, or discard the edits to open the destination. An assessment you already submitted continues while you browse. Its result appears under **Test one output**.


- **Test** lets you pick a compatible dataset snapshot and case, inspect the source and expected response format, and paste an answer. Scoring uses the selected case and rubric and returns its score and explanation. An earlier model run is optional.
- **Use in Run** carries the exact grader version into Dataset run. Choose your candidates and press **Run evaluation** when ready.
- **Create Version** opens an editable copy of a shipped grader. Save it to **My Graders**. Earlier run reports keep the revision they used.

**My Graders** includes your own rules, saved rubric versions and copies of industry checks. **General** contains cross-industry diagnostics and Opik metric templates.

## From an objective to a score

1. Open **Create a grader**. Describe what a good response must do. Choose **Suggest Metrics** to have the domain expert propose measures and the auditor review their evidence. Edit the measures, draft the evaluation prompt, then choose **Approve prompt & propose graders**. If you choose an existing approved prompt, go straight to **Propose graders**. **Write manually** is available when you already have a rule.
2. Open **Reasoning summary** to see which measures an automatic grader covers, its version and why it applies. If all measures are covered, choose **Done**. Select **Save** on the new or reused checks you want. **Ready to evaluate** shows each saved name and version. You can also pick an existing version directly from the library.
3. Choose **Test one output** to paste a task and an existing answer. Select **Score this output** to see the grade and rationale. You can browse elsewhere in DASH while scoring is in progress and return to **Test one output** for the result. If the assessment fails, the draft stays in the current DASH session for editing, retry or discard. When a grader requires an expected answer or recorded agent steps, supply them before scoring. You can make this test using an answer you already have.
4. To evaluate model responses across cases, choose **Use in a dataset run** on the save receipt, or **Use in Run** on its card. DASH opens its source snapshot when applicable. If several snapshots match, choose the family, version, split and industry. Review the selected grader versions, select the candidate models, and press **GO**. You can add or remove graders before starting. Each run records the versions used.
5. Open the completed run’s **Case scores and rationale** to see which answer passed, failed or lacked enough evidence to score.

### Understand the proposed rubric

The proposed grader shows the **Scoring rubric** or **Scoring rule** and the threshold it will use. Open **Reasoning summary** beneath the designer model name to see the recorded justification for each choice and any measures that lack sufficient evidence.

For an earnings task, a grader can check whether the answer identifies diluted GAAP EPS as **$0.74**, identifies **$0.85** as adjusted EPS, and flags a missing reconciliation if the supplied release says none is available. Whether the team reduced analyst review time requires separate timing records. An unmeasurable business figure can stay unscored while an observable answer requirement gets its own rubric.

**Runtime and format checks** are diagnostics. **Generation completed** means the runtime reported a normal stop. **Response present** means the model returned text. Inspect the domain rubric and case result to assess the quality of that text.

## What counts as an expected answer?

An expected answer, also called a *case reference*, is what a reviewer considers correct for this particular task. It can be a short fact or an accepted decision. For example, “The active drawing caps the diameter at 10.03 mm. The 10.04 mm sample goes to Quality for a signed recheck.” The **rubric** says which parts of a response earn credit. The **expected answer** supplies the facts needed to apply that rule.

Quick compare shows the names of the checks that need your expected answer. You can also choose a grader that works from the task and response, or leave that measure unscored. Before GO, an unsent expected answer stays in the current editing session. Enter it again after reloading. Once you start, DASH saves it with the local run. A selected hosted decision grader can receive it after you confirm its destination.

## Map a Quick compare measure

From an approved Quick comparison, choose **Choose graders** to open the catalogue for that specific draft. Attach a compatible version, then return to the comparison to see it beside the two chosen models. When you open the catalogue independently, **Use in Run** still offers the dataset workflow.

After approving the task prompt, inspect each measure and its pass condition before selecting **Run evaluation**. A saved deterministic check can answer a literal question. Choose a dedicated Opik rubric and judge when several phrasings can satisfy the condition. Read its full-credit and failure conditions. For a check that needs a known correct answer, enter **Expected answer or verified facts** once. Both candidates receive the same approved task. DASH supplies what you entered to the graders that require it after the candidates respond. For a dataset, supply the answer on each row. A business outcome that needs later operational data stays unscored until you have that evidence.

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
3. Choose **Use in a dataset run** on the receipt or **Use in Run** on the saved card. In a run you already have open, **Choose graders** opens the catalogue for that evaluation. Under **Manage version**, **Use on new runs** enables the revision as a cross-industry default for eligible future runs.
4. Run your candidates, then open **Run history → Evaluation result**. Open **Case scores and rationale** in the detailed report to see the native score, direction and judge’s explanation.

For earnings extraction, pair relevance with a grader that checks the requested accounting basis. An answer can address EPS directly and still quote adjusted EPS when the question asks for GAAP.

## Choose the scoring model

In **Create a grader**, the AI designer can propose a rubric. Review **Scoring method** on each proposed check. **Judge model · local scoring runtime** chooses the model that will score answers with Opik. You can choose a different model from the one that drafted the rubric or the candidates you plan to compare. **Write manually** uses the same local judge list. Saving pins the grader version, runtime and model identity, including a model revision when the runtime reports one. **Use this exact version** keeps an existing judge. Derive a customer version to change it.

For a single yes/no question, choose **Decision model · yes/no**, write the question so “yes” means pass, and select the native protocol and loopback endpoint. **Find decision models** lists the models that endpoint advertises for native decisions. Choose one, check the fail and pass cutoffs, and review which evidence it will receive. **Task and candidate answer** hides held-out labels, SME notes and agent traces, even when a case has them. **Candidate answer only** also hides the task. If a task-and-answer grader receives an empty task, DASH records the case as unscored without calling either scoring backend. If dataset rows have individual SME rubrics, also select a grader that receives case evidence. The decisions protocol returns a probability. Scores are 1 above or at the pass cutoff, 0 below or at the fail cutoff, and unscored between them. Switching a proposed multi-level rubric to a binary check asks you to write the new criterion. Switching back restores the original rubric. A derived grader inherits the source evidence scope and any required reference or agent trace. Review the evidence setting to change which fields the scoring model receives.

| What you want to measure | Suggested method and evidence |
| --- | --- |
| A required literal, exact answer, valid JSON, or required JSON fields | Use a deterministic check or the approved JSON contract. Answer presence and generation completion are separate diagnostics. |
| Financial values, basis, period, currency, citation locator or review routing | Use the Financial Services catalogue with its labeled release. Manufacturing has corresponding labeled checks for drawing and lot identity, normalized readings, disposition and routing. |
| Whether the response addresses *each requested deliverable* | Under **Write manually → Start with a yes/no grader**, try **Requested deliverables addressed**. It evaluates coverage from the task and answer. Check factual accuracy separately against trusted evidence. |
| Whether the response flags a missing source and withholds a dependent conclusion | Try **Requested missing-evidence disclosure** only on cases that explicitly identify the gap and request both actions. You decide whether that prerequisite applies. Omit this check on other cases. |
| Overall answer relevance, usefulness, moderation or hallucination | Configure the available Opik metric with a local judge. Hallucination needs source context. Choose G-Eval with anchored scores for partial credit or several dimensions. |
| Whether an agent called a tool in the required order | Use the deterministic trajectory check with recorded calls. To judge whether the returned tool evidence supports the answer, explicitly require observed agent actions and calibrate a separate decision or rubric against labeled traces. |

The cross-industry decision questions are editable experimental starters. They have no measured accuracy rating or default attachment. Use **Test one output** with a labeled pass, a plausible near miss and a missing-evidence case before attaching a version. For example, ask for the lot ID and hold instruction. An answer listing only the ID should fail completeness. If the task says the drawing is missing and asks whether the lot can be released, a disclosure check should distinguish an explicit hold pending the drawing from an answer that notes the missing drawing but approves release. Missing evidence required by a reference-based grader leaves that case unscored before inference. [Repeat the synthetic grader checks](https://github.com/niksacdev/dash/blob/main/docs/reviews/decision-model-graders.md#repeat-the-synthetic-grader-checks).

## Try an industry decision example

Open **Workspace → Graders → Create a grader → Write manually → Decision examples · grade an answer**. Select **GAAP diluted EPS support** to judge whether an answer uses the correct period and accounting basis from the release. Select **Inspection disposition evidence** to judge whether the answer supports its sample disposition with the active drawing, reading and receiving rule. Inspect the editable yes/no question and select a native decision model such as local D1. Save the grader version, then use **Test one output** with a candidate answer and a reference.

Both industry decision examples need a known correct answer. In Quick compare, attach the version and enter **Expected answer or verified facts** before GO. In a Dataset run, use cases that each have their own expected answer. To grade an answer you already have, use **Test one output** and provide the expected facts separately. The two cross-industry examples can instead use just the task and answer. The deterministic dataset checks remain useful for exact figures, unit conversion and drawing limits. [Synthetic handoffs and checks](https://github.com/niksacdev/dash/blob/main/docs/reviews/outcome-workflow.md#evaluate-a-language-model-handoff-and-its-decision)

## Run a local decision check on both candidates

Save a **Decision model · yes/no** grader under **Cross-industry** with a local decision server and a criterion you can judge from the prompt and answer. For example, “Does the answer cite a value supplied in the prompt to support its conclusion?” can work across industries when that is part of your team’s policy. Use **Test** to check a known pass, a near miss and a case with insufficient evidence. In **My graders → Manage version**, select **Use on new runs**. Quick compare and Dataset run show the selected revision among their automatic checks and score each candidate separately. Automatic local decisions receive the fixed yes/no criterion and at most the task the candidate saw and its answer. An answer-only version receives only the criterion and the answer. When you explicitly select or map a grader, its saved evidence setting applies. Older versions without an evidence setting use the available case evidence. A judge failure or a probability between cutoffs leaves that assessment unscored.

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

# DASH outcome workflow

## What a user can do

Start Quick compare or Dataset run with a sentence describing a decision and what a good answer would accomplish. A receiving inspector might ask, “Flag incoming lots outside the active drawing tolerance and send uncertain readings to review.” A financial analyst might ask, “Extract reported diluted EPS with its period and basis, and flag any adjusted figure presented as GAAP.”

The Overview track reads **Business outcome → Success metrics → Evaluation runs → Refine & rerun**.

## Reviewed workflow

| Step | What happens | What the workbench keeps |
| --- | --- | --- |
| Describe the outcome | The operator writes the objective and, optionally, a plain-English measure and per-response input or output limit. Quick compare infers the industry. A supported dataset industry selects its profile automatically. | Original objective and requested measure |
| Prepare the prompt | The expert proposes measures and a second agent audits their measurability. The implementer drafts candidate instructions from the operator’s objective, public scenario contract and token limits. The grader retains the reviewed measures and expected answers. | Model identity, role versions, requirements, proposed measures and draft |
| Review and approve | The operator edits the candidate prompt and measures. Dataset runs show the separate, fixed scenario contract. Model selection opens after approval. | An immutable catalog revision with its domain, limits, parent and applicable dataset snapshot |
| Evaluate | Quick compare runs two selected models on the same approved text. Dataset runs evaluate one or two candidates on the chosen snapshot. Runtimes apply their own chat templates. | Prompt revision, inputs, scenario and grader versions, replies, scores, available telemetry and errors |
| Refine | On a finished run, the operator can start the next revision. For a same-domain revision, the expert receives aggregate observed counts for the previous candidates and graders. The implementer can receive a budget or truncation signal. The operator reviews the resulting revision again. | Source run, measured counts and prompt lineage. Historical prompts can also be reused exactly. |

## Inspect a planning query

In Quick compare or a dataset prompt variant, **Suggest Metrics** and **Draft evaluation prompt** show the active stage and the local or hosted model. A small animated indicator stops when the call settles and becomes static when reduced motion is enabled. The latest call stays visible after completion. Each retry or hosted fallback gets its own entry with the input and output tokens reported for that attempt, even when DASH rejects the generated text. Local inference has no API charge. A supported hosted model can show a labeled estimate from reported usage and standard pricing. Missing counts and prices stay unavailable. Suggested metrics are attributed to the AI expert with a review notice, and built-in supplementary criteria retain their source.

## Review the evidence behind a proposal

For a synthetic earnings release, an expert can propose checking the reported GAAP EPS. The auditor should identify the expected value and basis needed to grade the answer, and how the grader would compare them. A downstream goal such as increasing investor confidence needs observations outside the run. Unsupported KPIs stay outside the default run checks. A successful model call alone must never certify a metric.

The operator can expand **Why these metrics?** before drafting. Edits to the selected checks require a fresh assessment or a clear indication that the explanation describes the original proposal. **Why this prompt?** shows the starting objective, the instruction added and the basis for the change. Explanations are separate from candidate instructions. Dataset reference answers, protected grader data and private model deliberation do not belong in the prompt.

## Decisions from specification and critique

- **Keep suggested measures distinct from evidence.** “Reduce false accepts” is an objective. The inspection grader can count incorrect proposed accepts on a labeled case set. Broader operational effects require their own measurements.
- **Give each role domain-specific work.** The Financial Services pair handles periods, units, GAAP versus adjusted measures and source attribution. The Manufacturing pair handles active drawing revisions, tolerances, unit conversion and ambiguous inspection rules. These profiles include sources and can refer to relevant industry tools. Live industry systems are not connected by this workflow.
- **Protect the evaluation.** Preparation gets the public scenario contract. Storage identifiers, case rows and gold answers are excluded from the model-visible dataset brief. At evaluation, the candidate receives the case input and source locator. Reference answers reach the grader. Run-informed revision passes only measured aggregates back to the planner.
- **Make approval authoritative.** The runner resolves the approved revision on the main process. Case reruns pin the original prompt. Later role edits affect future preparations. The administrator is the owner of this local desktop workspace.
- **Make a strict budget meaningful.** Before a capped run generates any candidate response, every lane and case must pass a count with its loaded LM Studio model and template. Output limits work independently. A budget or provider failure is visible in the run evidence.

## Verification

A live LM Studio test used LFM3 1.7B to prepare and execute the five synthetic Manufacturing inspection cases. Two passed the scenario grader, two returned incorrect proposed accepts and one further response failed grading. Tokenizer preflight matched reported input usage on all five. This test used an isolated database.

The desktop integration tests exercise the Quick compare and Dataset interfaces, approval, prompt and role revisions, request formatting across two adapters, dataset grading, run-informed revision, and historical replay. Their model responses are deterministic. See the [contributor guide](../../.github/CONTRIBUTING.md) for test commands.

## Author a grader from the same business outcome

In Create a grader, an inspection lead selects a Manufacturing snapshot, asks the shared domain expert to suggest success metrics, and reviews the metric auditor’s evidence requirements. The operator can edit the draft to require an active drawing citation and the actual lot ID before approving it. The grader designer receives that exact approved prompt version and the final measures. Proposals remain editable until the operator saves them. Choosing an existing approved prompt uses that version directly. Changing source keeps prepared suggestions scoped to their originating objective and snapshot. Grader planning leaves a simultaneous Quick compare draft and its candidate selections intact. [Decision record](../adr/0026-reuse-grader-planning.md)

## Compare the same measures across model outputs

An earnings analyst defines two measures before selecting candidates. One checks whether the response reports the diluted GAAP EPS from the supplied excerpt; another checks whether the response names the correct reporting period. Each has its own observable pass condition. Both candidates receive the approved task. Each returned answer goes through the same immutable grader revision for a given measure. The report can therefore show a model passing the EPS check and failing the period check while its competitor does the reverse. One evaluated prompt supplies two per-answer results for each model. Estimating success rates across production cases requires a representative dataset.

Before GO the operator can inspect which grader will score each measure, review its criterion, or leave a measure unscored. The run retains the approved metric-to-grader assignments. A failed candidate, absent reference or unavailable judge stays visible with its measured coverage. Historical composite rubrics keep the single score actually recorded. The planning activity should identify the active model and stage, distinguish corrective attempts, and disclose measured timings and usage without copying private generated content into progress events.

## Approve a structured extraction

A Manufacturing lead compares two models on extracting a part ID and diameter from a supplied observation. With structured output selected, the operator can inspect the task data and required response fields during prompt review. The same approved JSON input and schema reach both candidates. An answer with a missing field, a wrong type or an extra field fails conformance and remains inspectable. An incorrect diameter with a valid numeric type needs a content grader to detect it. Approval and run history preserve the original contract when the operator later revises a prompt. Free-form Quick comparisons and existing dataset contracts continue to work. [Decision record](../adr/0029-approved-json-contract.md)

## Finish a Quick evaluation after approving the prompt

An inspection lead has approved a two-field extraction prompt. They want to pick two models, attach a specific saved grader, and run both answers through it without starting over. The approved objective and its version identify the draft setup. Opening the grader catalogue, viewing a grader, using Back, navigating through the sidebar and returning to Quick compare must preserve that setup. Before dispatch, show both selected models, the attached grader versions and what is still required to start. A measured setup step may show a count. A pending model operation without a denominator uses an indeterminate indicator. Once dispatch begins, use observed candidate and assessment records to show progress.

For structured extraction the prompt review should make field selection understandable without knowledge of JSON Schema. Show who proposed the contract, what task evidence supports each field, and how to inspect the actual schema instruction and JSON user message before approval. Indicate operator edits. A historical approval without recorded reasoning must never acquire an invented model explanation. [Decision record](../adr/0031-quick-evaluation-setup.md)

For a live LM Studio planning call, the input total reported while reading the prompt stays visible as output arrives. When the final receipt supplies different counts, it takes precedence. With no reported input total, the UI waits for usage. A verified pre-dispatch candidate count is labeled separately from final usage. [Planning activity](../adr/0021-planning-activity.md)

## Return from grader selection and protect unsaved edits

An operator adds an inspection grader to one approved Manufacturing comparison, changes a second assignment and then uses the return action. The panel identifies the prompt version, model lanes and attached count. Staying preserves the edited assignment. Discarding returns to the same setup with the first attachment intact. Choosing **Attach and return** applies the selected measure directly.

A manual grader author can use the sidebar or browser Back, keep an unsaved rule with focus on its field, then discard it on a second attempt. Forward reopens the grader page from its saved state. Normal navigation retains the task objective and both lanes. Replacing an unapproved objective with a different prompt requires a separate decision. The navigation decision issues no model or scoring requests. [Decision record](../adr/0032-workflow-navigation.md)

A runtime refresh can finish while the leave dialog is open. Accepting the original destination opens it once. Saving a grader while a separate test answer is being edited shows the new version’s receipt and retains the test answer. During a settings or grader save, the submitted controls remain locked until the write completes. In the dataset catalogue, cancelling a replacement file picker preserves the original metadata; selecting a new file opens its own form. A form from the previous file cannot register rows under the replacement file’s metadata.

## Route an industry decision to the right expert

An inspection lead starts **Inspect a supplier lot**. Both **Suggest Metrics** and the draft use the Manufacturing expert, the implementer uses the same pack, and the approved version filters graders and categorizes runs under Manufacturing. The earnings starter follows the same path under Financial Services. Appending or changing the task returns it to inference unless an operator explicitly selects a domain. On free text, a manufacturer’s GAAP disclosure and a factory’s drawing tolerance require different verification work. An unclassified summary can use General. A cross-domain correction retains the original prompt and source run links. Its expert and implementer start without the previous domain’s generated measures, grader observations or output fields.

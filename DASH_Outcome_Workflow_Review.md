# DASH outcome workflow

## What a user can do

Start Quick compare or Dataset run with a sentence describing a decision and what a good answer would accomplish. A receiving inspector might ask, “Flag incoming lots outside the active drawing tolerance and send uncertain readings to review.” A financial analyst might ask, “Extract reported diluted EPS with its period and basis, and flag any adjusted figure presented as GAAP.”

The Overview track reads **Business outcome → Success metrics → Evaluation runs → Refine & rerun**.

## Reviewed workflow

| Step | What happens | What the workbench keeps |
| --- | --- | --- |
| Describe the outcome | The operator writes the objective and, optionally, a plain-English measure and per-response input or output limit. Quick compare infers the industry. A supported dataset industry selects its profile automatically. | Original objective and requested measure |
| Prepare the prompt | A local chat model runs the expert and implementer in sequence. The expert identifies evidence requirements and observable measures. The implementer uses that brief to write candidate instructions. | Model identity, role versions, requirements, proposed measures and draft |
| Review and approve | The operator edits the candidate prompt and measures. Dataset runs show the separate, fixed scenario contract. Model selection opens after approval. | An immutable catalog revision with its domain, limits, parent and applicable dataset snapshot |
| Evaluate | Quick compare runs two selected models on the same approved text. Dataset runs evaluate one or two candidates on the chosen snapshot. Runtimes apply their own chat templates. | Prompt revision, inputs, scenario and grader versions, replies, scores, available telemetry and errors |
| Refine | On a finished run, the operator can start the next revision. The agents receive aggregate observed counts for the previous candidates and graders. The operator reviews the resulting revision again. | Source run, measured counts and prompt lineage. Historical prompts can also be reused exactly. |

## Decisions from specification and critique

- **Keep suggested measures distinct from evidence.** “Reduce false accepts” is an objective. The inspection grader can count incorrect proposed accepts on a labeled case set. Broader operational effects require their own measurements.
- **Give each role domain-specific work.** The Financial Services pair handles periods, units, GAAP versus adjusted measures and source attribution. The Manufacturing pair handles active drawing revisions, tolerances, unit conversion and ambiguous inspection rules. These profiles include sources and can refer to relevant industry tools. Live industry systems are not connected by this workflow.
- **Protect the evaluation.** Preparation gets the public scenario contract. Storage identifiers, case rows and gold answers are excluded from the model-visible dataset brief. At evaluation, the candidate receives the case input and source locator. Reference answers reach the grader. Run-informed revision passes only measured aggregates back to the planner.
- **Make approval authoritative.** The runner resolves the approved revision on the main process. Case reruns pin the original prompt. Later role edits affect future preparations. The administrator is the owner of this local desktop workspace.
- **Make a strict budget meaningful.** Before a capped run generates any candidate response, every lane and case must pass a count with its loaded LM Studio model and template. Output limits work independently. A budget or provider failure is visible in the run evidence.

## Verification

A live LM Studio test used LFM3 1.7B to prepare and execute the five synthetic Manufacturing inspection cases. Two passed the scenario grader, two returned incorrect proposed accepts and one further response failed grading. Tokenizer preflight matched reported input usage on all five. This test used an isolated database.

The desktop integration tests exercise the Quick compare and Dataset interfaces, approval, prompt and role revisions, request formatting across two adapters, dataset grading, run-informed revision, and historical replay. Their model responses are deterministic. See the [desktop guide](dash-desktop/README.md) for test commands.

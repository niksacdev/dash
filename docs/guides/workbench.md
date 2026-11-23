# Using the workbench

## Evaluate a business outcome

**Quick compare** starts with a business outcome. **Suggest Metrics** asks the industry expert for editable success measures. LFM3 drafts the prompt. If local planning fails validation, DASH can use direct OpenAI with the model and key configured in **Workspace → Domain agents → Prompt creation**. Prompts and metrics show which planner produced them. Approving a version saves it in the prompt catalog.

Select two models and review the proposed outcome rubric, judge and pass threshold. You can edit the rubric, attach a saved grader or switch off grading. The Output Analyzer pairs scores by case and rubric. On supported live runs, local LFM3 selects cases that explain the result and the Report agent interprets those cases. DASH verifies their citations and verdict against the recorded scores. The report awards a win when one candidate leads on at least one rubric and matches or exceeds the other on the rest, with complete coverage. The report shows ties, mixed results and missing evidence separately. Latency, tokens and measured device power are available alongside the verdict.

**Dataset run** starts from a saved snapshot. Choose the models and run the cases. Each bundled scenario supplies the instructions, schema and grader. **Test a prompt variant** lets you compare an approved revision on the same structured cases. Candidates receive only the authored request and case evidence. Grading can use a held-out SME answer, rationale or rubric. Case reruns use the original snapshot and grader versions.

Quick compare previews the approved prompt’s measured input and available output budget as models take their lanes. The guardrail checks every candidate and case again before dispatch. On loaded LM Studio models it measures the full templated input and active context, then reserves output space. With an automatic budget it targets up to 8,192 output tokens within verified capacity. For short Quick answers with an explicit cap of up to 1,024 tokens, DASH requests thinking off when the loaded LM Studio model supports it and counts the resulting template. The run records the actual allocation and any provider-reported output ceiling. For a connection without an exact tokenizer check, an explicit input cap blocks dispatch. Explicit output caps also work with Ollama and compatible endpoints. Truncated output is retained for inspection.

## Explore the bundled datasets

**Earnings release capture** has eight synthetic cases, **Incoming inspection triage** has five and **Support ticket routing** exercises a different schema. The optional recorded replay runs saved answers through the scenario grader without asking a model. One earnings replay substitutes adjusted EPS for GAAP EPS. One manufacturing replay accepts a part using a superseded drawing revision. Select a case to inspect the source, reference, output, grade and trace. Exporting a run includes its manifest and recorded cases. At dispatch, DASH checkpoints the adapter request. Stop saves any streamed text received so far. If DASH exits unexpectedly, reopening it recovers the latest checkpoint with the final response marked unknown. The first streamed text is checkpointed immediately and later text at most once per second. Canceled or interrupted requests with an unknown outcome receive no score or completion time.

For a structured scenario, import JSONL with the scenario’s input and gold fields. For authored cases choose **Prompt and reference evaluation**. Each JSONL row has a unique `case_id`, a shared `dataset_version` and `split`, either `prompt` or `messages` ending in a user turn, and an optional `reference` or `rubric`. Input-only cases require a saved grader that defines success independently. An optional `sme_rationale` explains the expected behavior. Use exact matching for fixed answers, Opik G-Eval with a local judge for case rubrics, or a saved grader. The import screen includes an example. DASH stores versioned snapshots and dataset family metadata in local SQLite. Scenario contracts, deterministic scoring rules and recorded responses live in [packs](../../dash-desktop/packs/).

Grading uses the chat turns saved at dispatch, including changes made to fit the token budget. For an older run without those turns, DASH marks the reconstructed case input in the new assessment. Recorded replays use fixture case inputs. In **Graders**, paste a candidate’s ordered tool calls to grade its actions. A blank trajectory leaves an action-order check unscored. An explicit empty array records that the agent took zero actions. DASH keeps its own execution steps in the developer trace.

## Use a decision model as a grader

1. Open **Workspace → Graders** and select **Decision model · yes/no**. Choose an earnings or inspection starter, or enter one question yourself. If the answer depends on a held-out reference or an observed agent trajectory, mark that evidence as required.
2. Choose the local runtime, its loopback URL, and the exact decision model. With a compatible LM Studio or llama.cpp server, the native API is `/v1/systemone`. Some servers omit decision capabilities in discovery. You can enter their model ID manually. A successful grade requires the server to return a typed answer for that model. [LM Studio decisions](https://lmstudio.ai/docs/developer/jev-compat/systemone)
3. Choose the fail and pass probabilities. For example, with 0.20 and 0.80 a probability of 0.64 requests review and contributes no score. Save the grader and select its version on a run, or assess a saved output. To compare a second judge, edit the saved grader, change the selected model and save a new version. A case rerun keeps the grader version from the original run.
4. For an explicitly hosted judge, select OpenRouter and a decision model such as Liquid d1.2 or TypeSafe Jev. Set `OPENROUTER_API_KEY` in the environment of the process launching DASH. Confirm the evidence disclosure when grading. Each result identifies the model that served the assessment. [OpenRouter Decisions](https://openrouter.ai/docs/guides/features/decisions)

**Apple Silicon with MLX weights.** MLX-VLM supports Liquid d1 Omni on its native `/v1/decisions` endpoint. From a terminal with `uv` installed and the complete FP16 checkpoint in LM Studio’s model folder, start an isolated server. The first launch downloads the runtime dependencies. The checkpoint is read from disk.

```sh
HF_HUB_OFFLINE=1 uv run --no-project --python 3.12 --with mlx-vlm==0.8.0 \
  python -m mlx_vlm server --host 127.0.0.1 --port 52991 \
  --decision-model "$HOME/.lmstudio/models/LiquidAI/d1-Omni-2B-MLX-fp16"
```

Select the MLX-VLM protocol in the grader, enter `http://127.0.0.1:52991`, and discover the preloaded checkpoint. Keep the terminal open while grading. A model showing up in LM Studio’s chat catalog may still require the MLX runtime for decision inference. [MLX-VLM decision server](https://github.com/Neywa-Labs/mlx-vlm/pull/2657) · [Liquid’s FP16 checkpoint](https://huggingface.co/LiquidAI/d1-Omni-2B-MLX-fp16)

An optional alternate local model on the same server can grade the case if the primary is unavailable during discovery. DASH records which model actually answered. DASH keeps absolute weight paths on the device and sends stable opaque model identifiers to Opik. Give different checkpoint revisions distinct paths or aliases. A runtime that reuses the same identifier can hide a weight change. A failed request or a probability in the review band ends that assessment without a second inference.

For example, ask “Does the answer report the GAAP diluted EPS in the reference for this period?” Include a labeled case where adjusted and GAAP figures differ. Inspect the raw confidence and pass/fail or review outcome in the case results. Check the rubric on held-out SME decisions before relying on it for a business outcome.

## Developer view

Open **Workspace → Developer** to inspect LM Studio's loaded instances, model adapter, trace, runtime errors and case-level measurements. Time to first visible output, provider-reported time to first token, token usage and hardware readings appear when available. Device power is measured across the whole host when the sensor is supported. Fixture runs have no model telemetry. The **Graders** workspace includes a grader-design agent and native Opik SDK metrics. See the [project setup guide](../../README.md) for grader confirmation, local judge configuration and Opik experiment sync.

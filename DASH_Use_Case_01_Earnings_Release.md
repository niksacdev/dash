# DASH Use Case 01 · Earnings Release Capture
## Business workflow and benchmark pack · v1.0

**Decision:** Can a small model on Nik’s M4 turn an earnings release into an analyst-ready, evidence-backed record, within the review burden and compute budget of a research or risk team? Compare Liquid LFM3, Qwen and Gemma 4. Do not automate trading, underwriting or client advice.

**Starting point:** [Liquid Field Lab design review](https://chatgpt.com/c/6b01685a-9304-83ea-9d19-b8ad08be287e?messageId=dd922a4d-69ae-5c17-9992-f0006d4e6d01) and [SHIVA financial-institution priorities](https://chatgpt.com/c/6abac76a-597c-83ea-be0b-c8412ca1edf9?messageId=694c2c10-e9f8-4c89-9ccb-f193c8fdef12). Start here rather than a generic finance Q&A benchmark. Public or synthetic data only.

### 1. Business workflow

1. Analyst selects issuer, fiscal period, and fields: revenue, diluted GAAP EPS, operating income initially; sector-specific metrics can follow. Scope v1 to supplied release text or tables so retrieval and OCR do not confound model comparison.
2. Model returns structured facts with the original table or paragraph locator, original display value/unit and normalized decimal. Preserve currency, current versus comparative period, GAAP versus adjusted basis, sign and displayed precision.
3. Deterministic checks gate routing. Keep the fact-level statuses **supported**, **not disclosed**, **ambiguous**, and **source conflict** distinct. A supported fact contradicting a later filing is routed to review rather than silently overwritten. If no later filing is available, record reconciliation as not run. Do not treat a missing XBRL fact as missing in the source. An approved human owns final publishing.
4. The analyst sees each accepted record or a review queue with a reason and evidence. Keep proposed workflow improvements separate from realized savings.

### 2. Dataset from requirements

| Requirement | Construct cases | Evidence / acceptance |
| --- | --- | --- |
| Correct reported figure | Standard GAAP tables; same number used for a different metric, prior-period column and YTD distractor | Exact label, fiscal period, basis and value within source display precision; the cited locator must entail the claim |
| Safe normalization | Thousands/millions, negative values, per-share data, mixed currencies and unit boundaries | Use decimal arithmetic; normalize the stated unit and sign, never apply a blanket percentage tolerance |
| Evidence-backed coverage | Value omitted; value only present in adjusted table; ambiguous source label | No invented number; classify absent versus ambiguous and route according to a pinned policy |
| Reconciled and auditable | Later filing agrees, conflicts or has no comparable tag; possible revised figure | Label release first; record reconciliation separately; route conflict to review with both sources |
| Operational usefulness | Full records with easy and difficult fields, missing references, malformed outputs or failures | Full-record gate, false accepts, human-review load and time to analyst-ready record |

Data contract: immutable `case_id`, `group_id`, `dataset_version`, `source_type` (public or synthetic), `source_url`, publication/as-of date, document hash, stable locator, model-visible input and separate gold labels. Gold includes field, period, basis, currency, display value/unit, canonical value, evidence, field status, and expected routing. Fix answer keys by dual review or explicit adjudication. Only pass model-visible inputs to models. Build a development set and frozen held-out set grouped by issuer/release, including paired perturbations grouped with the original. Start with a 10-case smoke run, then at least 50 held-out cases as an initial pilot, treating that sample as exploratory. Keep a stable overlap when comparing dataset versions; rerun all candidates on new versions. The attached mini-fixture is a **synthetic development seed**, not real company data or a holdout.

### 3. Three-model experiment

- Baseline first: LFM3-1.7B, one small Qwen, and one small Gemma 4. [Liquid official model card](https://huggingface.co/LiquidAI/LFM3-1.7B). Verify exact Qwen and Gemma checkpoint names, device fit, licenses and runtime support, then pin revision, quantization/hash, runtime and prompt/scorer versions. Prefer a single native Mac runtime for the baseline; use comparable memory tiers and label any mismatch. A larger quality ceiling or runtime swap is a separate experiment.
- Starting Ollama profiles (verify on the M4; published tags are not immutable): [LFM3 1.7B](https://ollama.com/library/lfm3:1.7b), [Qwen 3.5 2B](https://ollama.com/library/qwen3.5:2b), [Gemma 4 E2B](https://ollama.com/library/gemma4:e2b). Record resolved digest, quantization, backend and effective settings; equal tag sizes do not imply equal memory use. Run measured candidates sequentially. Before a full run, check one supported case and one missing-evidence case end to end. If a hosted comparison is later enabled, pin provider, disable fallback and require needed parameter support.
- Same business input, JSON output contract and scorer. Record template, output budget and sampling settings. Separate cold model load, warmed model with fresh prompts and any warm prompt-cache measurements. Retain per-case outputs and failure reasons.
- Compare both **raw model** and **model + identical validator**. In a later milestone, compare a read-only agent v1/v2 with the same tools and fixtures, logging tool choices and retries. Do not mix agent and raw-model scores. For fine-tuning, pin adapter lineage and keep the holdout untouched until final evaluation.
- Evaluate accuracy by field, evidence support and complete-record acceptance. Report false auto-accepts, review rate, misses and p50/p95 latency, time to first visible output and throughput. Retain native token counts with tokenizer caveat. Measure scoped memory/power only where supported. Keep wall energy distinct from chip estimates; record hosted device metrics as unknown. Divide overall energy or cost, including retries/failures, by accepted tasks; undefined if zero pass. Report API charges, judge spend and any illustrative local electricity estimate separately.
- Use a paired comparison and show volume and uncertainty. Report time saved as a scenario with explicit assumptions about current handling time and review time, not as observed ROI. Define thresholds with the workflow owner; do not promote a model with a critical false acceptance on the smoke suite.

### 4. Interface and delivery

Use DASH for quick same-query comparisons and dataset experiments; native Ollama on M4 for the first controlled baseline, with optional Opik trace export. OpenRouter is optional for a hosted comparison or judge with approved public/synthetic inputs only. Start with one local runner and add a native telemetry adapter only if needed. Persist run configuration and per-item outcomes, link each result to its trace, and export portable JSON. UI should make it easy to pick a baseline, open failed evidence and rerun a case. See [Opik Playground](https://www.comet.com/docs/opik/development/prompt-playground).

**First acceptance test:** From DASH, compare one prompt on the three checkpoints, run the same pinned smoke dataset, then reopen one failed case and verify the source and score. The result must show per-model accepted records, false accepts, cases needing review and device/latency measurements that were actually collected. Include a versioned export and a separate offline fixture test. No real-model run, training, or device measurements are claimed by this spec.

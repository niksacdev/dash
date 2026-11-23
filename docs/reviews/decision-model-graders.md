# Decision models as domain graders

Feasibility review · November 23, 2026

**Does the cited evidence support the candidate’s conclusion?** Use that single question on already saved answers for the first pilot. Start with Liquid’s open-weight `d1-2B` in a local `llama.cpp` process. Compare its decisions with independent subject-matter expert (SME) labels, the existing scenario checks and an approved Opik G-Eval rubric. The proposed feature belongs in the reusable grader library. Local integration, latency, power and grading quality on DASH remain unmeasured. [DASH grading workflow](../guides/workbench.md) · [Liquid decision model guide](https://docs.liquid.ai/lfm/models/d1-2b)

## Local runtime

Liquid built d1-2B on its LFM3-VL-2B vision-language backbone. The decision model accepts a text or JSON state on its own. A grading request can supply an earnings excerpt, the candidate’s answer and a question about the EPS basis entirely as text. An inspection image is optional for a scenario that actually requires visual evidence. [Liquid model card](https://huggingface.co/LiquidAI/d1-2B)

| Route | Published capability | What to verify in DASH |
| --- | --- | --- |
| **First pilot** · `LiquidAI/d1-2B-GGUF:Q8_0` | Liquid documents `llama.cpp` 0.8.0, build b11960 or later, with a loopback `POST /v1/systemone` endpoint. Send a state containing the case and candidate response plus named questions. Noul returns a probability of yes, Choice returns probabilities over supplied labels, and Score expresses a position on a supplied scale. The model generates zero output tokens. | A TypeScript HTTP adapter can call an independently started runtime. Check the selected model and build, then validate the reply against the requested question IDs, types, labels and probability ranges. Python is unnecessary for this route. Register the decision endpoint explicitly. Discovery of a GGUF in a chat server alone establishes no decision-API support. [Liquid runtime guide](https://docs.liquid.ai/lfm/models/d1-2b) · [GGUF artifact](https://huggingface.co/LiquidAI/d1-2B-GGUF) |
| **Alternate Apple Silicon route** · `LiquidAI/d1-2B-MLX-8bit` | Liquid publishes 2.22 GB of weights for `mlx-vlm` 0.7.11 or later. This runtime also supports typed extraction and image grounding. Liquid’s 8-bit conversion preserved all 52 decisions in its validation set, with a largest probability change of 0.008 against float32. Its 4-bit MLX conversion changed three decisions and shifted a probability by up to 0.25. | Record MLX as a separate grader revision and calibrate its thresholds independently. The 52-example results cover the MLX conversions only. The GGUF Q8_0 path needs its own agreement and calibration measurements. [8-bit model card](https://huggingface.co/LiquidAI/d1-2B-MLX-8bit) · [4-bit model card](https://huggingface.co/LiquidAI/d1-2B-MLX-4bit) |

The checkpoint has 1.92 billion parameters and accepts text, images and video. Liquid publishes Apple Silicon measurements, including a warm one-question result of 18.6 ms using bf16 on an M5 Pro. Different runtime, precision, context length and hardware can change that result. The **LFM Open License v1.0** sets a $10 million annual-revenue threshold for free commercial use. Liquid directs organizations crossing the threshold to obtain a commercial license. Check applicability for the organization deploying the grader. [Original model card and benchmark protocol](https://huggingface.co/LiquidAI/d1-2B) · [LFM license, definitions and section 5](https://www.liquid.ai/lfm-license)

## What the grader measures

| Scenario | Deterministic checks first | Decision-model question and held-out label |
| --- | --- | --- |
| Financial Services · earnings capture | Check fiscal period, reported basis, units and value against the versioned reference at source precision. | Supply the passage and the candidate’s claim. Ask whether the cited words support the claim that the figure is GAAP diluted EPS for that quarter. An SME labels support, contradiction or insufficient evidence. Include a plausible adjusted EPS figure and a prior-period figure. [Earnings scenario](../specs/DASH_Use_Case_01_Earnings_Release.md) |
| Manufacturing · incoming inspection | Convert units and compare the measured dimension with the limits from the applicable drawing revision. Keep a hard failure on an incorrect acceptance. | Supply the inspection record and candidate disposition. Ask whether its evidence supports holding or releasing this lot under the cited revision. Include stale revisions, boundary readings and missing limits. The SME labels the support for the disposition independently. [Manufacturing scenario](../../dash-desktop/packs/manufacturing/pack.json) |

**Confidence and grade answer different questions.** A high probability of “contradicted” is strong evidence for a failing grade. The pinned rubric maps labels to a grade and defines when uncertainty or missing evidence requires review. A mandatory deterministic failure retains precedence. Preserve the original distribution, selected label, threshold and reason for abstention. A decision model supplies a typed judgment. Show the case evidence and applied rule alongside it without generating a purported model explanation.

## Blind test and acceptance

1. Have two SMEs label responses independently, with candidate identities and grader predictions hidden. Adjudicate disagreements and keep ambiguous or insufficient-evidence examples. Keep SME verdicts out of the decision request. Calibrate rules on a development split. Freeze them before opening a separate holdout split grouped by issuer and release or by lot and drawing revision. The bundled examples exercise the pipeline. Add independently labeled cases to assess quality.
2. Run the same saved candidate outputs through deterministic scoring, G-Eval and the proposed grader. For each industry, report counts and denominators for auto-graded coverage (graded / all), review share (abstained / all), and wrong-pass rate (SME failures automatically passed / all SME failures). Also report the share of automated passes that SMEs rejected, agreement on graded cases, and confidence-bin reliability. Show uncertainty intervals and label counts, particularly for costly false accepts.
3. Agree on each scenario’s maximum acceptable wrong-pass rate and minimum useful coverage with its domain owner before unblinding. Compare coverage at that risk budget. Keep the grader advisory whenever the holdout cannot establish the agreed limit. Review time or cost saved is a separate outcome requiring observed workflow data.
4. Measure cold model-load time, then warm end-to-end p50/p95 per case across realistic context lengths and batch sizes. Record actual artifact size, peak resident memory, input usage, typed decisions per second, and whole-device watts and joules per case where sensors permit. Measure idle power and candidate-only runs separately, identify the measurement scope, and leave unsupported sensor readings missing. Keep candidate time and judge time separate. [DASH device measurements](../guides/workbench.md)

## Reuse the run and Opik contracts

Snapshot the domain, scenario, case version, rubric, question definitions, threshold policy, model artifact revision and quantization, runtime build, and submitted evidence with each local assessment. Opik’s official TypeScript `BaseMetric` supports a validated custom scorer over this narrow adapter. Use the installed `opik` SDK’s `EvaluationScoreResult` for an observed grade. Keep abstentions and transport errors unscored in DASH. Reuse the existing experiment and trace feedback path for actual scores when the operator chooses to sync. Retain the raw distribution as evidence, separate from the rubric’s business metric. A sync retry reuses the recorded assessment. [Opik TypeScript metrics](https://www.comet.com/docs/opik/reference/typescript-sdk/evaluation/metrics) · [DASH synchronization decision](../adr/0002-opik-and-offline-runs.md)

## Optional hosted comparison

OpenRouter publishes these list prices in USD, checked November 23, 2026. Its Decisions API uses `POST /api/alpha/decisions`. TypeSafe’s direct service calls the current pinned Jev release `jev-1.14.0`. Its official catalog documents hosted access. Public weights, a local inference license and an Apple Silicon runtime for TypeSafe Jev were unverified. The MIT license covers TypeSafe’s client SDK. [OpenRouter Decisions API](https://openrouter.ai/docs/guides/features/decisions) · [TypeSafe catalog](https://docs.typesafe.ai/models) · [TypeSafe SDK](https://github.com/typesafe-ai/typesafe-sdk-js)

| OpenRouter model ID | Per million input tokens | Per million output tokens |
| --- | ---: | ---: |
| [`liquid/d1.2`](https://openrouter.ai/liquid/d1.2) | $0.020 | $0 |
| [`liquid/d1.2-ultra`](https://openrouter.ai/liquid/d1.2-ultra) | $0.042 | $0 |
| [`typesafe/jev-1.14`](https://openrouter.ai/typesafe/jev-1.14) | $0.042 | $0 |

Keep hosted grading opt-in for each run. Before dispatch, show the destination, provider, model, rate, and fields it will receive, including any scoped reference excerpt, candidate response, or inspection image. Disclose applicable provider retention and routing settings. A failed local grader stays local unless the operator explicitly selects a hosted run. Opik synchronization has its own destination and approval. [OpenRouter data collection](https://openrouter.ai/docs/guides/privacy/data-collection) · [Provider retention controls](https://openrouter.ai/docs/guides/features/zdr)

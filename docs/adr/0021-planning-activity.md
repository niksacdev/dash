# 0021. Show activity and usage for each planning query

**Status** Accepted

Suggest Metrics and prompt drafting previously showed one line containing the stage and model. Nik requested a chat-style activity indicator, a distinct model label, per-query usage and cost, and explicit AI attribution. This extends the stage and model provenance in the [outcome workflow](../reviews/outcome-workflow.md) and the [local evidence policy](0002-opik-and-offline-runs.md).

Use the existing stage events, with one request ID per user action and one query ID per actual model call. Replace each running row with its terminal receipt. A reported token count belongs to the call even if its output fails validation. Reusing a metric suggestion preserves its original receipts. Keep the current request separate from the full prompt history. Use an aria-hidden CSS animation, honor reduced motion, announce stage changes and retain keyboard cancellation. The operator sees an AI expert attribution and a review notice for suggested metrics.

A time-based counter cannot measure tokens. Local model calls incur no API charge. For the direct OpenAI fallback use the standard text prices only when the response reports the default service tier, an exact supported snapshot, the cache breakdown, and output usage. The stored estimate excludes energy, credits, taxes and negotiated rates. Other model/tier combinations show unreported cost. The three supported 2025-04-14 snapshots are [GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1), [mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini) and [nano](https://developers.openai.com/api/docs/models/gpt-4.1-nano). Rates checked November 24, 2026. Store each estimate with its original receipt so changes to the price table do not reprice saved history.

[Planning implementation](../../dash-desktop/lib/planner-routing.cts) · [Operator guide](../reader/src/models.md)

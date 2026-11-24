# 0033. Bind known industry examples before inferring a planning domain

**Status** Proposed

## Context

An operator using the bundled supplier inspection example received a Financial Services tag. The renderer supplied only the example text. A valid but incorrect model classification selected the expert, propagated into prompt approval and categorized its Quick runs. A revision also treated a prior inference as an explicit operator selection.

## Decision

Extend [domain scenarios](0001-domain-workbench.md) and [the Quick setup](0031-quick-evaluation-setup.md). Domain corrections follow [the existing revision and navigation flow](0032-workflow-navigation.md). Keep the starter task, its source excerpt and the domain it represents together. Expose the same catalog entry on the existing scenario list and compare the complete standalone Quick objective before model routing. A supported dataset domain takes precedence, followed by an explicit operator selection, an exact starter, and inference. Preserve the dataset industry independently when it lacks a dedicated planning pack.

For other objectives, the versioned router selects the kind of verification required. DASH maps that result to the appropriate expert and implementer. Record the attribution with the prompt. Revising an inferred or historical domain returns it to automatic routing. A changed snapshot industry invalidates earlier suggestions. Changing domains starts fresh expert preparation. The source run stays linked while its grader aggregates, response fields and untouched generated measures stay with their original domain. Existing approvals and their run history retain their original domain. See the [acceptance scenario](../reviews/outcome-workflow.md#route-an-industry-decision-to-the-right-expert).

## Alternatives and evidence

A keyword override can confuse a manufacturer’s financial disclosure with inspection work. Binding every click to the starter’s domain can also mislabel an appended or rewritten objective. Using exact shipped objectives avoids both assumptions. Free-text inference can still be wrong, so the operator can select a different planning domain before approval. Synthetic local calibration on LFM3 and regression tests cover inspection, financial review, general work, explicit overrides, changed objectives and stale suggestions.

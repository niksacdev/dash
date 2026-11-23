# 0006. Pin reusable grader revisions to domain runs

**Status** Proposed

## Decision

A workspace has three sources of graders. General checks describe the response and its runtime completion. An industry starter encodes a decision for a specific scenario and specifies the evidence that makes it measurable. A customer can accept a designer’s proposal, write a grader, fork a starter or revise a customer grader. The current domain packs cover earnings releases and manufacturing inspections.

Use the official Opik TypeScript metrics for response matching and semantic evaluation. Local judges can run Opik answer relevance, usefulness, hallucination and moderation. The operator chooses which approved cross-industry semantic metrics to enable by default. Store the native risk score and direction alongside the normalized quality value. Keep missing evidence unscored. Exclude response diagnostics from business winner selection.

Identify a grader by family and immutable revision. A fork gets a new family and a link to the parent revision. A revision preserves its family. New runs resolve workspace defaults and explicit selections once. Case reruns preserve the original pins. Multiple runs can share a revision. The library links back to those runs. Historical records without a family retain their original identity, scoring policy and report.

DASH implements the domain criteria directly and uses Opik to evaluate common metrics. This workflow has no JevEval dependency.

## Consequences

Scenario checks can inspect held-out labels and domain evidence only after inference. A generic imported dataset needs its own success criteria or a compatible general grader. Sharing an industry name does not establish that two scenarios use the same field definitions. A structural success or a high relevance score cannot override a recorded false acceptance of an earnings figure or inspected part.

The designer proposes only criteria the available evidence can support. Local planning may reuse eligible customer definitions. The optional hosted planning fallback uses public catalog descriptions for its library choices. Each proposed new definition requires review before it enters the library.

The [feature specification and critic findings](../reviews/grader-library.md) describe the acceptance cases. The [workbench guide](../guides/workbench.md) documents the operator workflow.

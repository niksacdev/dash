# 0001. Organize inference evaluation around domain scenarios

**Status** Accepted

## Context

The same model can extract a valid number and still make the wrong business decision. In earnings reports, adjusted and reported earnings can both be present. In inspection records, a correct dimension can be paired with a superseded drawing.

## Decision

Use the domain, scenario, and run as the organizing hierarchy. Scenario packs define the case contract, deterministic checks, and synthetic examples. Domain experts propose measurable criteria. The user approves and versions the prompt and graders before running candidates. One shared model picker supports two candidates for Quick compare and one or two for datasets.

## Alternatives considered

A prompt-only benchmark loses the decision context. A separate application for each industry duplicates the runner, model adapters and grading interface.

## Consequences

New domains need grounded examples and evaluation contracts. A supplied agent trace can be assessed with the same evidence model. Live hosted-agent connections require their own session and trace adapters. The original financial and manufacturing examples remain development fixtures.

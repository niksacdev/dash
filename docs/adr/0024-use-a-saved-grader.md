# 0024 · Use a saved grader in an evaluation

**Status** Accepted

Extends [0006 · Grader library](0006-grader-library.md) and [0022 · Review metrics and grader drafts](0022-review-metrics-and-grader-drafts.md).

## Problem

An operator could save a Manufacturing inspection grader, yet had to navigate away, find a compatible snapshot, and recognize the right version again to score even one model. Proposing a rule, saving a version and evaluating an answer looked like interchangeable actions.

## Decision

Expose one creation entry. The operator can review AI suggestions or write a rule, then explicitly save. Present the saved name and version with two actions as applicable. A single-output test accepts an existing answer and the evidence that rule requires. Dataset evaluation opens the ordinary run setup with the chosen revision attached to a compatible snapshot or approved prompt for that snapshot. It preserves the normal model choice, start action and hosted-evidence consent. The app reads the existing catalog scope and uses the existing runner and scoring engines.

## Alternatives and trade-offs

A tutorial could explain how to find the grader again, but it cannot carry the version through to the runner. Starting a job at save time would choose a dataset and model before the operator has reviewed them. The additional dataset choice is needed when several versions fit and the operator has not specified one. Reference-dependent and agent-action checks require the corresponding evidence.

## Review and verification

The product critique followed an inspection grader through planning, confirmation, a sample output and a dataset evaluation. It identified the need to keep the saved version visible, separate output testing from new inference, and avoid changing global defaults. The Electron workflow exercises these actions with synthetic inputs and simulated model transports. [Grader library scenarios](../reviews/grader-library.md) · [Operator guide](../reader/src/graders.md)

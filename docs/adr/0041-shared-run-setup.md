# 0041. Share the final run setup across Quick compare and Dataset run

**Status** Accepted

## Context

Quick compare and Dataset run already shared the roster. Their grader controls and route back from the library diverged. The Dataset screen could score a case with saved graders, but an operator familiar with Quick compare could miss the selection panel entirely.

## Decision

Extend [ADR 0020](0020-selection-controls.md) and [ADR 0037](0037-grader-expected-answers.md). Give both workflows one Starting line, Model roster, visible grader selection and launch action. Show automatic checks, place **Design graders** directly below them, and show the selected immutable grader versions at setup. The library picker represents one active draft and returns to it on attach, cancel, or Back. Browser reload restores the same draft selection. Keep the existing common run-detail and report route.

A Quick draft can map its approved success measures to individual graders and supply private expected facts for its single prompt. A Dataset draft can use scenario scoring or snapshot references for multiple cases. Express these differences inside the shared launch controls. Keep private expected answers out of navigation URLs and model prompts.

## Alternatives and verification

Keeping two pages with the same labels would preserve the original opportunity for drift. Flattening the scoring policies into one mode could cause an authored dataset reference to be sent to a candidate or a Quick grader to use evidence from another draft. Review both workflows from their normal entry points, including a catalogue round trip, reload, version removal and assessment of the saved answer. The [operator scenario](../reviews/outcome-workflow.md#use-the-same-starting-line-for-a-prompt-and-a-dataset) records the expected behavior. [Dataset guide](../reader/src/dataset-runs.md) · [Grader guide](../reader/src/graders.md)

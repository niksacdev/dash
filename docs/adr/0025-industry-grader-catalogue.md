# 0025. Browse and test graders by industry

**Status** Accepted

## Context

An earnings analyst and a receiving inspector need to identify checks for their own scenario and know what evidence each check uses. The previous flat library placed personal versions first and hid customization inside version management. A standalone pasted answer lacked the labeled scenario case that a shipped industry rule needs.

## Decision

Keep Create a grader at the top. Show shipped grader families in named, icon-led industry collections, personal revisions in My Graders, and cross-industry checks in General. Keep the name, revision, short description and applicable actions visible on each industry card. Operators can inspect details with a pointer, keyboard or tap.

Creating a version uses the existing immutable revision operation. A standalone industry test pairs a pasted response with the selected snapshot and case. The main process verifies applicability and resolves the stored source and labels for the existing scorer. Use in Run opens the existing dataset setup with the exact grader revision attached.

## Alternatives and consequences

A navigation tab per industry would hide other available packs. A hover-only menu would hide actions on touch screens. Free-text reference entry would bypass the schema, source and labels that establish how a domain check scores. Snapshot selection adds a step when several packs or versions are present and makes the test reproducible without an earlier run.

This extends [0006](0006-grader-library.md) and [0024](0024-use-a-saved-grader.md). The product and technical critics walked through first-use testing, forks, and missing evidence. [Acceptance scenarios](../reviews/grader-library.md)

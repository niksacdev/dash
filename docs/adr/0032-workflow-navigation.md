# 0032. Return to the active evaluation and protect unsaved edits

**Status** Proposed

## Context

A Manufacturing operator attaching a grader needs to recognize the destination and see which assignments already apply. Navigating between workbench pages also mixes approved versions, session-owned workflow state, and input held only in a form. The browser drops that last group when the renderer replaces the page.

## Decision

Extend [Quick evaluation setup](0031-quick-evaluation-setup.md) and [using a saved grader](0024-use-a-saved-grader.md). Put **Back to evaluation setup**, the prompt version, the lanes, and the attached grader count together. Keep the existing renderer hash routes and one destination refresh. Track edits to volatile fields on their DOM elements. The navigation guard records no field values or credentials in browser history. Existing renderer and main-process owners retain their own state.

Ask before discarding actual changes to an unapplied assignment, manual grader, initial test input, import metadata, or connection form. The same decision also applies when intentionally replacing an unapproved prompt setup. Staying preserves the input and focus. Leaving opens the requested route and reads current workspace state. An already dispatched run or assessment keeps its existing lifecycle.

## Alternatives and consequences

A warning on every route would interrupt visits to the grader catalogue and imply that the starting line had been lost. Persisting entire forms would copy private test data and credentials into storage. Detecting DOM-only changes requires each newly added form to declare whether its drafts survive a route change. The [workflow acceptance scenario](../reviews/outcome-workflow.md#return-from-grader-selection-and-protect-unsaved-edits) exercises both a safe detour and a real discard.

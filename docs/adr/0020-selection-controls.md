# 0020. Reserve racing yellow for workflow actions

**Status** Accepted

Nik identified a screen of yellow model cards in the shared Quick compare and Dataset run roster. Every card looked like a command to start a run. The shared button styles also gave that appearance to planning choices. This extends [0007](0007-racing-yellow-actions.md) and [0017](0017-overview-controls-and-photography.md).

Use the theme’s neutral surfaces for choices and an accent outline for the current selection. Model cards also show a checkmark. Keyboard focus has a separate outer ring. Once both lanes are full, the remaining cards keep their status text and hide their add symbols. Standard commands such as **GO**, **Refresh** and **New run** retain their racing yellow.

Styling the roster alone would leave other choice controls with the same ambiguity. Use the existing pressed and checked states to apply the shared palette. Keep native button and radio behavior. [Operator guide](../reader/src/models.md) · [Workflow checks](../../dash-desktop/test/workflow-smoke.cts)

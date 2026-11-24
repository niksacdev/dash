# DASH decision log

Start here to learn why DASH works the way it does. Each numbered record explains one durable product, design or architecture choice. The table follows the decision events in chronological order. Read the latest entry for a record to find its current status. The initial entries reconstruct the history from the existing records and linked PRs.

| Date (UTC) | Record | Event | Decision and lineage | Review |
| --- | --- | --- | --- | --- |
| 2026-11-23 | [0001 · Domain scenarios](0001-domain-workbench.md) | Accepted | Organize runs under scenarios and domains so outcomes retain their business context. First workflow decision. | [#1](https://github.com/niksacdev/dash/pull/1) |
| 2026-11-23 | [0002 · Opik and offline runs](0002-opik-and-offline-runs.md) | Accepted | Extend 0001 with local run ownership, native Opik grading and optional synchronization. | [#1](https://github.com/niksacdev/dash/pull/1) |
| 2026-11-23 | [0003 · TypeScript runtime](0003-typescript-runtime.md) | Accepted | Extend 0002 with a standalone Electron app, typed IPC and the official Opik SDK. | [#3](https://github.com/niksacdev/dash/pull/3) · [main integration #5](https://github.com/niksacdev/dash/pull/5) |
| 2026-11-23 | [0004 · Local Opik service](0004-local-opik-service.md) | Accepted | Extend 0002 and 0003 by making a self-hosted Opik service part of DASH setup. | [#4](https://github.com/niksacdev/dash/pull/4) · [main integration #5](https://github.com/niksacdev/dash/pull/5) |
| 2026-11-23 | [0007 · Racing yellow actions](0007-racing-yellow-actions.md) | Accepted | Apply a shared action color in both themes. Retrospective record of the merged UX choice. | [#8](https://github.com/niksacdev/dash/pull/8) |
| 2026-11-23 | [0005 · Decision-model graders](0005-decision-model-graders.md) | Proposed | Extend 0002 with bounded decisions, abstention and switchable judges. The original ADR records this status. Its implementation merged into the test branch after that branch had merged into main. | [#9](https://github.com/niksacdev/dash/pull/9) · [main integration #10](https://github.com/niksacdev/dash/pull/10) |
| 2026-11-23 | [0006 · Grader library](0006-grader-library.md) | Proposed | Extend 0001, 0002 and 0005 with general, industry and customer revisions shared across runs. | [#10](https://github.com/niksacdev/dash/pull/10) |
| 2026-11-23 | [0008 · Opik dataset ownership](0008-opik-dataset-identity.md) | Proposed | Extend 0002 and 0004 after a cross-project name collision. Reuse a dataset only when the native project and family can be verified. | [#10](https://github.com/niksacdev/dash/pull/10) |
| 2026-11-23 | [0009 · Pull request destination](0009-main-pr-target.md) | Accepted | Nik chose `main` for every PR after the decision-grader change merged into an already integrated feature branch. Replaces the earlier dependent-branch review workflow. | [#10](https://github.com/niksacdev/dash/pull/10) |

## Maintaining the history

Use the next unused four-digit identifier. Start a new ADR as **Proposed**. Include context, alternatives, the decision, consequences, evidence and its relationship to earlier records. Add a table row in the same PR and link the review. When an identified maintainer accepts or rejects the proposal, append the corresponding event and update the ADR’s status. The merged PR can serve as acceptance evidence when it adopts the decision on the default branch. Check the actual merge destination.

Use **Deprecated** when an accepted choice is being retired. Use **Superseded** when another numbered record replaces it. Link the old and new records in both directions, keep both files, and preserve the earlier entries. A change that adds a compatible capability extends the preceding ADR and leaves its status intact. Routine implementation commits belong in Git and can refer to the governing record.

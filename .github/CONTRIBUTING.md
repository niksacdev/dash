# Contributing to DASH

Start a branch from the current `main`. Group changes by behavior and commit each coherent change with a short imperative subject. A schema change, a new evaluator, and a presentation change can be reviewed independently when each commit includes its own verification.

Open a pull request against `main`. Describe the user-visible behavior, how it was verified, and any limits on what was tested. Include a small screenshot for visual work and synthetic examples for grader or scoring changes. Use the PR for review before merging. Keep run databases, credentials, real customer inputs, downloaded models, and dependency directories out of Git.

When a change needs several reviews, branch each dependent PR from the preceding PR and name its dependency in the description. Each PR must pass checks on its own. After a squash merge, move only the remaining commits onto current `main`, retarget the next PR, and verify its diff and checks again. Finish the agreed sequence before introducing another feature.

Run `npm ci` and `npm run check` inside `dash-desktop/`. Desktop tests require a graphical session. The CI job runs them in an isolated profile.

Add a numbered Markdown record in [docs/adr](../docs/adr/) for decisions that change where data lives, how an evaluation is scored, what leaves the device, or which SDK owns a capability. State the context, decision, alternatives considered, and consequences. When revisiting a decision, link the superseding record.

For an evaluator or experiment feature, check Opik’s existing TypeScript primitives first. Document any DASH-specific behavior needed for domain evidence, hardware telemetry, offline operation, or reproducibility.

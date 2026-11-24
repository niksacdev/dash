# Contributing to DASH

Start a branch from the current `main`. Group changes by behavior and commit each coherent change with a short imperative subject. A schema change, a new evaluator, and a presentation change can be reviewed independently when each commit includes its own verification.

Target `main` for every pull request, including drafts. Use `gh pr create --base main` or choose `main` as the base in GitHub. Describe the user-visible behavior, how it was verified, and any limits on what was tested. Include a small screenshot for visual work and synthetic examples for grader or scoring changes. Use the PR for review before merging. Keep run databases, credentials, real customer inputs, downloaded models, and dependency directories out of Git.

For dependent batches, merge the prerequisite into `main`, fetch `origin/main`, and verify it contains that change. Then open the next PR against `main` and review its remaining diff. Independent changes can each have a PR open against `main`. [Merge policy](../docs/adr/0009-main-pr-target.md)

Run `npm ci`, `npm run docs:check` and `npm run check` inside `dash-desktop/`. Desktop tests require a graphical session. The CI job runs them in an isolated profile.

For a material product, UX or architecture decision, add a numbered ADR and append its dated event to the [decision log](../docs/adr/README.md) in the same PR. Cite the governing ADR for work that implements an existing choice. On a status change, preserve earlier events and link the review and any predecessor or successor. The repository documentation check verifies that every numbered record appears in the log with its current status.

For an evaluator or experiment feature, check Opik’s existing TypeScript primitives first. Document any DASH-specific behavior needed for domain evidence, hardware telemetry, offline operation, or reproducibility.

Before each commit, follow the [independent staged review workflow](../docs/guides/precommit-review.md). It covers the complete repository, including Electron, the runner, domain packs, Opik, build tooling and documentation.

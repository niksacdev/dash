# 0009. Target main for every pull request

**Status** Accepted

## Decision

Nik selected `main` as the only merge destination for DASH pull requests, including drafts. Contributors work on feature branches. Independent changes can be reviewed in parallel. For dependent changes, merge the prerequisite into `main`, verify it there and open the next review against the updated `main`.

## Reason and consequences

The previous workflow targeted a preceding feature branch. GitHub marked the decision-grader PR merged into the test branch after the test branch had already been merged into `main`. That left the reviewed grader absent from the release tree and required a separate integration step. [PR #6](https://github.com/niksacdev/dash/pull/6) · [PR #9](https://github.com/niksacdev/dash/pull/9)

A single destination keeps each PR’s diff and merge result tied to the release branch. Dependent reviews may need to wait for their prerequisite. CI checks the target when a PR opens, changes, reopens or receives a new commit. This decision replaces the earlier branching instructions in the contributor and agent guides. [Policy change in PR #10](https://github.com/niksacdev/dash/pull/10)

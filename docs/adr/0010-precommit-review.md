# 0010. Review the staged change before committing

**Status** Accepted

Nik requested independent Codex review across DASH before every commit. This extends [the main-only review workflow](0009-main-pr-target.md). A pull request remains the merge and CI boundary. Pre-commit review catches defects while the author still owns the complete local change.

Stage the intended change and identify the exact parent and staged Git tree. Three independent Codex reviewers assess security, code quality and reliability. Each records a verdict for those identifiers. The local pre-commit hook checks the receipts. A change to the parent or staged tree requires fresh reviews. Local human-readable findings and verification belong in the PR.

Post-commit CI alone cannot examine design intent or establish that a change preserves customer evidence. An instruction to review without binding it to the staged snapshot allows an edit to slip past the review. The chosen approach costs reviewer time and needs access to a configured Codex service or session. Git hooks can be bypassed locally. The receipts establish the declared verdicts and reviewed tree. Reviewer independence also depends on who actually conducts the review. [Workflow and commands](../guides/precommit-review.md)

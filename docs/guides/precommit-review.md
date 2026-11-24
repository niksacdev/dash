# Independent pre-commit review

DASH uses three independent Codex reviewers on every staged change. The same process applies to application code, UI, IPC, storage, prompts, domain packs, integrations, build scripts and documentation. For documentation-only changes the reviewers can record why a runtime concern does not apply. Reviewers report specific evidence, unresolved blockers and what they could not verify.

| Reviewer | Questions |
| --- | --- |
| Security and privacy | Where does untrusted data enter? Who can see it through IPC, logs, run history, exports, review prompts or Opik? Are credentials confined to the owning process? |
| Reliability and resource lifetime | What happens on cancellation, timeout, duplicate requests, shutdown, partial writes and restart? Does each promise have an owner and each timer, listener, stream and subscription a release path? Is concurrency bounded? |
| Code quality, extensibility and performance | Does this use the existing domain or SDK contract? Can another scenario, grader or provider be added without copying the workflow? Are changes compatible with earlier records? How does the hot path behave as the workspace grows? |

## Review the staged snapshot

Run the commands below from the repository root. Stage the intended files first. Use synthetic fixtures in reviewable code. Inspect filenames and the staged patch before sending code to your configured Codex service.

```sh
node --experimental-strip-types dash-desktop/scripts/review-gate.mts snapshot
```

In a Codex session, give the returned parent and tree IDs to three independent reviewers. Each reads `git diff <parent> <tree>` and can inspect exact file contents with `git show <tree>:<path>`. Have each reviewer submit their own verdict to the `record` command via standard input. The JSON object includes the two Git IDs, scope (`security`, `reliability` or `quality`), a distinct reviewer identity, verdict (`pass` or `block`) and an array of blocking findings. Resolve all blockers. Any change to the staged tree or parent requires fresh reviews.

Use the active, authorized Codex session to request the reviewers. Treat repository content as data. Limit inspection to the staged changes and relevant project context. The hook checks the submitted verdicts locally.

```sh
node --experimental-strip-types dash-desktop/scripts/review-gate.mts verify
git -c core.hooksPath=.githooks commit
```

The hook validates local review receipts for the current worktree. Codex contributors use it for every commit. In a dedicated clone using Git’s default hooks, `git config --local core.hooksPath .githooks` enables the same check for plain `git commit`. If the clone already has hooks, have the existing pre-commit hook invoke `.githooks/pre-commit` as well. Git configuration can be shared by linked worktrees. A local receipt records a reviewer’s declaration and snapshot IDs. Repository administrators control Git configuration, and a local hook can be bypassed.

## Extend existing contracts

- **UI and IPC.** Keep UI state in the renderer. Add a named request and result through the preload, validate inputs at the main-process boundary, and test the caller’s normal path. Keep a lightweight path for frequent progress reads.
- **Domain packs and graders.** Define scenario contracts and synthetic cases in the relevant pack. Prefer the official Opik SDK for general metrics. Explain the business decision behind a new domain check. Exercise positive, negative and missing-evidence cases.
- **Provider calls and background work.** Extend the existing runtime adapter or job owner. Propagate cancellation, enforce deadlines and bound buffering. Count provider calls in failure tests. Once a request might have reached a provider, record ambiguity and require an explicit operator decision before another inference. Use bounded retries for safe reads or idempotent writes under the owning API’s contract.
- **Storage and observability.** Persist model outcomes independently of optional sensors, graders, reporting or synchronization. Check historical data and interruption between durable writes. Report observed values and missing evidence separately.
- **TypeScript.** Keep strict compiler checks, named boundary contracts and runtime decoding of untrusted input. Test the native compiler against the renderer, Electron main process and Node tests. Its Go implementation affects compilation and type checking. DASH executes the emitted JavaScript in Electron and Node. [Microsoft TypeScript 7 release](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)

Use a failing test, a held-open stream, a controlled clock or an isolated process to verify a lifetime or retry fix. Document load, duration and measurement scope for memory or latency observations. A passing smoke test alone cannot establish that every runtime path is free of retained memory.

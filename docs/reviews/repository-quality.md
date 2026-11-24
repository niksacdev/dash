# Repository-wide review and failure recovery

## Objective

Every DASH commit should receive an independent security, reliability and quality review before it is created. New integrations should reuse typed application boundaries. An operator running a long scenario should retain a known response if an optional device sensor fails. If a provider disconnects after receiving the request, the operator needs the observed evidence and control over whether another request goes out.

## Acceptance

1. Three independent reviewers inspect the same staged tree and parent. A staged edit, changed parent, blocked review or missing verdict prevents a reviewed commit. Unstaged edits do not change the reviewed snapshot. The procedure works in a linked worktree.
2. On a synthetic provider that streams then disconnects, the surviving record shows partial evidence and an unknown outcome. Persist a completed response before awaiting auxiliary work. Check that telemetry failures and restarts never generate a duplicate candidate request.
3. Streamed provider errors must not persist reflected secrets. Remote calls and data exports use the intended transport, bounded reads and trusted boundaries.
4. Changing workspace size should not force full workspace and run-history projections through IPC on every idle poll. Exercise cancellation, resource cleanup and the behavior of a sensor that never resolves.
5. Validate compiler changes on all three compilation targets and both fresh-profile Electron tests. Compare equivalent type-check commands and characterize any build-time benefit separately from inference performance.

## Independent critique

Reviewers reproduced a lost final response during sensor failure, a transport disconnect mistaken for a confirmed completion, and repeated unchanged multi-megabyte polling. They also found a path where a remote error could persist echoed credentials. These findings determine the scope of the first hardening pass. The [engineering review workflow](../guides/precommit-review.md) applies the same scrutiny to future changes anywhere in DASH.

## Observations on the maintenance baseline

With an isolated synthetic 200-case run, 199 completed answers of 8 KiB each, an unchanged poll previously serialized 1,999,595 bytes. The new progress query returned 20 bytes and issued no SQLite queries on an unchanged tick. Full detail still loads when a durable change needs to be displayed. A synthetic sensor that never settled retained 32 callbacks after 32 polls on the previous path. The fix retained one callback for the single outstanding read.

Two alternating runs of all three strict type-check commands on the same Apple Silicon machine took 4.11 and 5.06 seconds on TypeScript 6.0.3 and 0.67 and 0.96 seconds on TypeScript 7.0.2. These figures describe local compiler invocations under a shared workload. Candidate inference was simulated for the polling experiment. The tests give no estimate of long-term heap growth under production load.

# Working on DASH

DASH is a local-first domain assessment workbench. Keep the domain, scenario, approved business objective, success measures, dataset snapshot, and run connected. Financial Services and Manufacturing are the first domain packs.

## Architecture

- Author application code in TypeScript. Use the existing Electron desktop shell, Node APIs and the official Opik TypeScript SDK. Compile application sources for distribution. Keep generated JavaScript out of version control.
- Keep rendering and interaction in the renderer. Use the sandboxed preload to expose a narrow, typed IPC interface. The main process validates IPC requests, owns secrets and filesystem access, and coordinates the runner. The runner and domain scoring code must be exercisable without an Electron window.
- Use Opik's maintained primitives for datasets and their versions, prompt versions, experiments, traces, feedback and supported metrics. Check the installed SDK types and documentation before building a new integration. Keep any DASH-specific grading logic tied to a concrete domain requirement.
- Keep inference local to the selected runtime or connected endpoint. Record provider, model or agent revision, actual dispatched input, grader versions, model output, and available measurements. Use the measured evidence when comparing runs. A missing score or sensor reading stays missing.
- Support disconnected runs. Show the Opik destination and scope before synchronizing recorded case data. Persist enough state to resume after an interrupted write and avoid duplicate experiments. Keep credentials and personal run databases out of Git.

## TypeScript and data contracts

- Enable strict compiler checks for migrated application code. Give domain concepts and IPC payloads named types. Use discriminated unions when the allowed operations or result shapes differ. Prefer the SDK's exported data contracts to handwritten copies.
- Treat network responses, JSONL, persisted JSON, and IPC inputs as untrusted data. Decode and validate these at their boundaries. Use `unknown` until narrowed. Avoid broad `any`, unchecked casts, and file-wide compiler suppressions.
- Give asynchronous operations explicit success, failure, and cancellation behavior. Keep candidate errors separate from grader, telemetry, and sync errors. Do not retry an inference call to recover a telemetry write.
- Preserve old run records, selected immutable versions and public entry points when changing storage, language, or adapters. A refactor should leave evaluation results comparable.

## Planning, critique, and drift

- Start a substantive feature or architectural change by reading the relevant product specification, ADRs and current implementation. State the operator’s objective, a representative scenario, observable acceptance criteria, and assumptions. Update the existing spec or write a focused one when behavior changes. Straightforward fixes can cite the existing acceptance criterion.
- Before implementing a substantial change, ask an independent product critic to walk through that scenario. Have them challenge whether the feature improves a domain decision, whether the evidence can support the promised outcome, and what can be removed. Resolve findings against the spec.
- Use a technical critic for changes to scoring, data ownership, runtime boundaries, or external integrations. Check SDK reuse, migration and retry behavior, privacy, and the normal user entry points. Record material findings and their resolution in the PR or ADR.
- Recheck the original goal when implementation choices change and before calling work complete. Explain any remaining gap using a concrete example. A working build alone does not establish that a business outcome was achieved.

## Decision records and lineage

- Before planning a material product, UX or architecture change, read the [decision log](docs/adr/README.md) and the records it points to. Record durable choices about operator workflows, interaction patterns, runtime boundaries, data ownership, grading, privacy and reproducibility. Routine fixes that implement an existing decision can cite its ADR.
- In the same PR as the change, add the next numbered ADR and append a dated event to the log. Capture the problem, alternatives, chosen approach, trade-offs, evidence and review or implementation link. Identify which prior ADR it extends or supersedes, or mark it as the first decision on that topic.
- On acceptance, rejection, deprecation or replacement, append a new event and update the record’s status. Preserve earlier events and rationale. Link a replacement in both directions. The reviewer or agent completing a merge reconciles the log with the maintainer’s decision and verifies the implementation on the default branch. Do not infer acceptance from a working prototype.

## Verification and review

- Verify changes through their real entry points. Cover domain regressions with synthetic cases, exercise SDK serialization against an isolated service, and run Electron checks against a fresh test profile. Record which paths used real models, simulated transports, or a live service.
- For a shared Opik destination, verify object ownership and retry behavior using two independent local profiles. Native names can be workspace-wide even when a lookup accepts a project parameter.
- When changing a grader agent or rubric, calibrate it with a known pass, a near miss and missing evidence. Check the numeric score against the rubric anchors as well as the threshold verdict. Record whether the judge was live or simulated. At design time the candidate answer is a future input; distinguish that from evidence the run cannot collect.
- When adding a model capability, distinguish downloaded weights, a runtime catalog entry and a successful native request. Use a small synthetic case to verify the exact operation and returned model identity before describing it as live.
- Use the repository's typecheck, build, tests and documentation-link check. GitHub Actions should exercise the same commands that contributors run locally. Update setup instructions with build changes.
- Work on a feature branch and commit each coherent, verified increment. Keep mechanical moves separate from behavioral changes when practical. Push the feature branch and explicitly set every pull request’s base to `main` (including drafts). Verify the base and CI on its current head. Use the PR for review before merging. Include the user-visible effect, verification evidence and any remaining limitations.
- For dependent batches, merge the prerequisite into `main` first. Fetch `origin/main`, confirm the prerequisite is present, then open the next PR against `main` with only its remaining changes. Independent PRs can target `main` in parallel. [Merge policy](docs/adr/0009-main-pr-target.md)
- Use the [documentation index](docs/START_HERE.md) for the original artifacts and product reviews. Maintain a single source for each dataset fixture and preserve original design/specification files when moving them.

## Independent review before every commit

- Stage the complete change, including documentation. Before committing, request independent Codex reviews of the exact parent commit and staged tree. Apply this to every directory and change type. Run the three reviews in the [pre-commit review guide](docs/guides/precommit-review.md).
- A reviewer must be independent of the changes they approve. Require separate security/privacy, reliability/resource lifetime, and quality/extensibility verdicts. Give reviewers the immutable Git IDs, the objective and the verification evidence. Ask for concrete findings and file locations. Resolve blocking findings, stage the fixes, and review the new tree.
- Run the repository checks relevant to the change. Commit through the tracked review hook. In the PR, summarize what each reviewer checked, findings and fixes, tests run, and any limitations. Keep private data and credentials out of reviews.

## Continuous learning

- When an operator-visible workflow, metric, UI label or setup step changes, update its [operator guide chapter](docs/reader/src/SUMMARY.md) in the same PR. Verify the example and the reader build before committing. Explain in the PR when a change leaves operator guidance unaffected.
- Every merge to `main` republishes the reader. Verify the **Operator guide** deployment for the merged commit and open the affected live chapter and link or download. Recover failed publication using the [publishing guide](docs/reader/README.md).

- Before committing, check the changed behavior against its spec, setup guide, agent instructions and ADRs. Update affected documentation in the same change. If the behavior did not change, record the verification in the PR.
- When a real run, incident or review exposes a repeatable failure, capture the smallest reproducible case with synthetic inputs. Fix the cause, add a regression check, and document what the evidence established. Label assumptions and distinguish a simulated transport from a live integration.
- When a lesson applies across future tasks, Codex should call it out in its update or PR, propose a concrete change to this file, and include the change for review. Put task-specific findings in the owning guide or ADR. Keep instructions short and retire superseded guidance.
- Version runtime agents and their sources alongside the code. Record which revision produced a result. Evaluate changed instructions against representative positive, negative, and missing-evidence cases before adopting them. Preserve earlier revisions and distinguish local administrator overrides from shipped defaults.
- Make changes small enough to test, review and reverse. Link the spec, critic findings, commit, tests and observed run evidence in the PR when relevant. Keep secrets, private prompts and production outputs out of learning notes and fixtures.

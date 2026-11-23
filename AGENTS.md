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

## Verification and review

- Verify changes through their real entry points. Cover domain regressions with synthetic cases, exercise SDK serialization against an isolated service, and run Electron checks against a fresh test profile. Record which paths used real models, simulated transports, or a live service.
- Use the repository's typecheck, build, tests and documentation-link check. GitHub Actions should exercise the same commands that contributors run locally. Update setup instructions with build changes.
- Make focused commits. Use pull requests for review and record decisions affecting architecture, data ownership, scoring or reproducibility in [docs/adr](docs/adr/). Include the user-visible effect, verification evidence and any remaining limitations.
- Use the [documentation index](docs/START_HERE.md) for the original artifacts and product reviews. Maintain a single source for each dataset fixture and preserve original design/specification files when moving them.

# DASH

[**Read the operator guide**](https://niksacdev.github.io/dash/) [![Reader publication](https://github.com/niksacdev/dash/actions/workflows/reader.yml/badge.svg?branch=main)](https://github.com/niksacdev/dash/actions/workflows/reader.yml) [Apache 2.0](LICENSE)

**Domain Assessment & Scoring Harness** is a local-first Electron workbench for evaluating model and agent outputs against a business objective. Start with a domain scenario, agree on what a good answer looks like, then compare candidates on the same evidence. The first domain packs cover financial earnings extraction and manufacturing inspection triage.

![DASH workbench in dark mode](docs/design/overview-dark.png)

## Run it locally

Install Node.js 22.13 or later and npm. The desktop application has been exercised on Apple Silicon macOS. Dependency installation needs an internet connection. The recorded example runs offline.

```sh
git clone https://github.com/niksacdev/dash.git
cd dash/dash-desktop
npm ci
npm start
```

To run the Opik service locally with Docker, use `npm run setup:local` before starting DASH. The command configures the local dashboard and API for this user. [Local Opik guide](docs/guides/local-opik.md)

On macOS, you can also open `Open DASH.command` after installing dependencies. Switch **Light / Dark** beside **New run**. Your choice is saved on this device. [Light appearance](docs/design/overview-light.png)

### Choose a workflow

| If you want to… | Start here |
| --- | --- |
| Understand what DASH catches before connecting a model | [Replay eight earnings cases and investigate a wrong GAAP figure](https://niksacdev.github.io/dash/first-run.html) |
| Compare two answers to one objective | [Connect models and use Quick compare](https://niksacdev.github.io/dash/models.html) |
| Repeat an evaluation across models or versions | [Start a dataset run](https://niksacdev.github.io/dash/dataset-runs.html) or [import two labeled Manufacturing cases](https://niksacdev.github.io/dash/datasets.html) |
| Decide whether an answer meets your criteria | [Choose, configure and reuse a grader](https://niksacdev.github.io/dash/graders.html) |
| Explain a score or slow response | [Read case evidence and timings](https://niksacdev.github.io/dash/results.html) or [inspect the experiment in Opik](https://niksacdev.github.io/dash/opik.html) |

### Design graders and inspect scores

Open **Workspace → Graders**, or design graders from a run setup. Give the grader agent an objective and observable metrics. It proposes a set of distinct checks and explains what each measures. Edit the criteria, threshold, and judge, then confirm the checks you want. Confirmation saves reusable versions in the grader library. Confirming from a run attaches those versions to that run.

The Electron renderer, preload and evaluation runner are written in TypeScript. DASH uses Opik’s TypeScript SDK in the main process for exact matches, substring checks and G-Eval. A G-Eval rubric uses the local judge you select. Scenario-specific JSON-field comparisons and ordered agent-action checks use the corresponding reference or trace. You can grade an existing agent output with its supplied steps in the library. Connecting a hosted agent for live execution is a separate design track. [Agent feasibility review](docs/reviews/agent-runs-feasibility.md)

A **Decision model · yes/no** grader checks one domain criterion with a selected local or hosted decision model. Switch the model by saving another version. Cases with missing required evidence or a probability between the two cutoffs stay unscored. [Decision grader setup](docs/guides/workbench.md#use-a-decision-model-as-a-grader)

Inspect per-case scores and explanations in **Run history**. A winner needs complete scores on the same cases and a lead on at least one rubric with no losses on the others. Ties, mixed results and missing evidence are shown explicitly. [Opik evaluator documentation](https://www.comet.com/docs/opik/reference/typescript-sdk/evaluation/metrics)

### Connect an Opik project

From the desktop directory, run `npm run setup:local` to start the project's Docker services. DASH uses the local dashboard at `http://127.0.0.1:51734`. No Opik account, API key or environment settings are needed. Start and stop the service with `npm run opik:start` and `npm run opik:stop`. Workspace data persists across stops. [Local Opik setup](docs/guides/local-opik.md)

To use an independently managed deployment, set `DASH_OPIK_API_URL` before starting DASH. You can also specify `DASH_OPIK_UI_URL`, `OPIK_WORKSPACE` and `OPIK_PROJECT_NAME`. Only supply `OPIK_API_KEY` if that deployment requires it. **Run history** shows the destination and lets you sync saved inputs, outputs, and scores. Each candidate gets an experiment pinned to the same Opik dataset version. Revisions of an industry/scenario dataset family stay together, including case additions, edits and removals. Syncing a single-case rerun sends the full authored dataset snapshot and the recorded results for the cases actually run. Sync does not repeat inference. [Opik experiment logging](https://www.comet.com/docs/opik/evaluation/advanced/log_experiments_with_rest_api)

## What the Overview measures

| Metric | Source |
| --- | --- |
| Device power | An instantaneous reading for the host running DASH. On supported Macs the AppleSmartBattery SystemLoad sensor reports milliwatts, converted to watts. Hover, focus, or tap to see DASH and host CPU, Electron working-set memory, host free memory and storage on the workspace volume. Unsupported sensors show **Unavailable**. |
| Loaded models | Latest local runtime inventory. LM Studio reports loaded instances and Ollama reports its active models. Downloaded models only count when a runtime confirms they are loaded. |
| Dataset snapshots | Versioned entries in the workspace’s SQLite dataset catalog. |
| Total runs | All saved runs in the workspace, including failed runs and recorded-response tests. |

Run history preserves prompt versions, selected models, grader versions and measured telemetry in the Electron user-data directory. For dataset import, add a family, industry, snapshot version and split. A case can contain a prompt or conversation, an optional reference, an SME rationale and a rubric. Model-visible inputs and held-out evidence are stored separately. [Dataset and runtime guide](docs/guides/workbench.md)

## Development

Browse work by GitHub issue label. [`bug`](https://github.com/niksacdev/dash/labels/bug) [`enhancement`](https://github.com/niksacdev/dash/labels/enhancement) [`documentation`](https://github.com/niksacdev/dash/labels/documentation) [`accessibility`](https://github.com/niksacdev/dash/labels/accessibility) [`good first issue`](https://github.com/niksacdev/dash/labels/good%20first%20issue) · [All labels](https://github.com/niksacdev/dash/labels)

DASH pins the TypeScript 7 native compiler as a development dependency. Install optional npm dependencies so npm can select the compiler for your OS and CPU. From `dash-desktop/`, the compiler checks the renderer, main process, and test suite with strict TypeScript. To build and run all desktop checks:

```sh
npm run docs:check
npm run check
```

Tests and fixtures are authored in TypeScript. The compiler emits CommonJS into the ignored `dist/` directory for Node and Electron. A production build clears the compiled test harness. New G-Eval graders use Opik's TypeScript SDK. The optional Python bridge preserves the evaluator for older grader revisions on machines configured for it.

The desktop tests run Electron against isolated temporary profiles. The workflow test simulates model transport and exercises the approval, inference, scoring and report paths. Live model quality and hardware power readings depend on the device and runtime.

| Directory or file | Purpose |
| --- | --- |
| [dash-desktop/](dash-desktop/) | Electron app, local orchestration, SQLite storage, scenario packs, and tests |
| [Decision log](docs/adr/README.md) | Chronological product, design and architecture decisions, including alternatives, status, related ADRs and review history |
| [Documentation index](docs/START_HERE.md) | Workbench guide, specifications, design references, product reviews and original artifacts |
| [CONTRIBUTING.md](.github/CONTRIBUTING.md) | Branch, commit, verification and pull request workflow |

## License

DASH-owned code, documentation and bundled domain packs (including prompts, graders and synthetic cases) are licensed under the [Apache License 2.0](LICENSE). When redistributing these materials, include the license and retain the relevant [attribution notices](NOTICE). The desktop build includes both files in `dash-desktop/dist/`.

Your own datasets and model responses retain their applicable terms. Sharing scores does not require a DASH badge. A full run export can also contain bundled cases or prompts, which retain their applicable license. Third-party components keep their own licenses. The bundled model logos include [LobeHub’s MIT notice](dash-desktop/ui/assets/model-logos/LICENSE.txt).

Copies obtained under the earlier [MIT license](https://github.com/niksacdev/dash/blob/cd71d3a3de38300421eb6bba76da7e5dc3221a5b/LICENSE) remain available under those terms.

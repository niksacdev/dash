# DASH

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

### First evaluation in five minutes

1. Open **Dataset run** and select **Earnings release capture**. Expand the recorded-response grader test and start it. This scores eight synthetic cases without requiring a model or API key.
2. Open the result for **eps-gaap**. The recorded answer substitutes adjusted EPS for reported GAAP EPS. Compare the candidate output to the held-out reference and inspect the grader’s explanation.
3. For live inference, start the LM Studio local server on port `1234` or Ollama on port `11434`, load a chat model, then use **Local runtimes → Refresh models**. In **Dataset run**, click one or two models onto the starting line and choose **GO**.
4. For **Quick compare**, load an LFM3 chat model for planning. Describe a business objective, such as “Flag incoming parts that exceed the drawing tolerance and cite the measurement.” Choose **Suggest Metrics**, edit the criteria, then draft and approve the prompt. Choose two candidates for the comparison. An OpenAI planning fallback can be configured under **Domain agents**.

### Choose and reuse graders

Open **Workspace → Graders**. General checks follow new evaluations automatically. Industry checks cover earnings extraction in Financial Services and incoming inspection in Manufacturing. **My graders** holds the checks you write, approve from a business outcome or customize from the library. Select an existing revision for another run or save a new revision to change the grading policy. [Grader library guide](docs/guides/workbench.md#choose-a-grader-for-a-run)

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

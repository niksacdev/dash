# Editing and deploying DASH agents

The checked-in [agent manifest](../../dash-desktop/agents/manifest.json) maps stable IDs and release numbers to [Markdown prompts](../../dash-desktop/agents/prompts/). These files supply the instructions DASH actually sends when it designs prompts, suggests a check, designs graders or explains a run. An agent definition can reference source material. DASH configures tool access separately from these references.

These definitions run inside DASH’s existing planning, grading and reporting stages. Changing a prompt changes the instructions for that stage on the next deployment. Adding a new operation or connecting an independently hosted agent requires an execution adapter and an application entry point. The grader workspace can assess previously recorded agent outputs and tool steps. [Agent execution design](../reviews/agent-runs-feasibility.md)

## Where to edit

| Purpose | Agent IDs |
| --- | --- |
| Domain expertise and implementation | `financial-services-expert`, `financial-services-implementer`, `manufacturing-expert`, `manufacturing-implementer`, `general-expert`, `general-implementer` |
| Planning and shared assignments | `workflow-router`, `workflow-expert`, `workflow-expert-assignment`, `workflow-implementer`, `workflow-implementer-assignment` |
| Suggestions, grading and reporting | `prompt-guide`, `grader-designer`, `report-analyzer`, `report-reporter` |

To change how a Manufacturing expert reasons, edit its Markdown. To change how every expert translates a business goal into measurable criteria, edit the shared workflow expert. The expert assignment supports the literal placeholder `{{objective}}`. The runner supplies the operator's objective when preparing the request.

1. Edit the appropriate Markdown or source references. Increment that agent's integer `version` in the manifest and retain its ID. Preserve each domain role's `legacyHash`. It identifies the original SQLite default during migration.
2. Build and test in `dash-desktop` using the commands in the [setup guide](../../README.md). The deployment includes the manifest and its Markdown next to the compiled registry. Review the change and its synthetic test through a pull request.
3. Restart DASH with the new build. Agent definitions are loaded once per process. A new prompt approval records the effective domain role revisions, instruction hashes, and workflow agent pins. A pin records the manifest ID, version, path and SHA-256 of the normalized instructions and definition metadata. Use the matching Git revision to inspect that bundle.

## Optional hosted planning

A fresh workspace uses local planning even when an OpenAI key is available. Under **Domain agents → Prompt creation**, choose a model, enable direct OpenAI fallback and save the settings to authorize metered requests. This preference survives restarts. A key entered in the panel lives in memory for the current session. The app can also use an environment key or a configured OpenAI endpoint’s session key.

When local LFM3 is unavailable or a planning stage cannot produce a valid result, the enabled fallback sends the stage’s messages to `https://api.openai.com/v1/chat/completions`. Each request contains the active agent instructions, applicable source references, request schema, and operator-supplied objective including any text pasted into it. Depending on the operation, the brief includes:

- **Metric suggestions and prompt preparation** send success measures, criteria, token budgets, and the public scenario instructions, output schema and metric definitions. The implementer also receives the expert’s findings.
- **Prompt revisions** can include the preceding approved prompt, its metrics and aggregate results from a selected run, including truncation and token-budget observations.
- **Grader design** sends the objective, measures, requirements, evaluation target, available output and reference field names, existing scorer name and any permitted literal checks derived from the brief.

Planning fallback, a hosted candidate selected for inference, and uploading a completed run to Opik are separate destinations. Review each where you enable it.

## Local overrides and old runs

Editing a domain agent in the desktop workspace writes a new role revision to that workspace's SQLite database. On startup a newer bundled version appends a role revision for an untouched default. An administrator's local override remains active, with its local instructions and previous provenance. To adopt updated wording for that workstation, review the bundled Markdown and save the desired instructions in the workspace as a new local revision.

Historical role rows, approved prompts, and run records keep their original identifiers. Existing workspaces identify original defaults by their content hashes. DASH preserves older customized roles even when their records predate explicit origin metadata. A changed domain definition with an already applied release number stops startup with a request to increment its version.

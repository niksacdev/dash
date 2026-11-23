# Bringing an existing agent to DASH

**Recommendation for review · November 23, 2026.** Make **Evaluate an agent** a first-class action inside a domain scenario. Let the user select a registered agent, run a single example or a pinned dataset, and return later to compare versions on the same cases. One agent is sufficient to establish a baseline. A second lane is useful for a challenger. Quick Compare can keep its two-model starting line.

## What works today, and the missing link

DASH already stores case inputs, private reference answers, candidate results, reusable grader versions and comparisons in SQLite. The current runner accepts quick or dataset mode, invokes model adapters, and records its own invocation and grading steps. A grader that expects an agent’s tool trajectory cannot infer it from those steps. Pasting a final response or a trace into a grader helps inspect an example. The missing operation is to **invoke a registered deployment on DASH cases, capture the evidence it exposes, and attach that evidence to the right case and attempt**. [Runner](dash-desktop/lib/bench.cjs) · [Graders](dash-desktop/lib/graders.cjs)

On this Mac, the Nous Research Hermes setup application and the local Hermes source checkout were present. The checked-out revision `caafe5389ae5` registers capability discovery, run creation, status, events and stop. Read-only health checks at the documented loopback addresses returned connection refused for Hermes (8642) and OpenClaw (18789). These observations establish local source availability and the state of the default ports at the time of review. A live agent run and cloud account access remain unverified.

## Where to start

| Target | How DASH could invoke the owner’s agent | What to demonstrate before calling it supported |
| --- | --- | --- |
| **Hermes on the Mac** | Inspect capabilities, create a native run for each case, save its run ID and subscribe to the event stream. Hermes reports tool lifecycle, outcome previews, final response and stop controls. | A dedicated evaluation profile with read-only sample tools. Verify a completed call, a failed call, a dropped stream and a stop. Tool result previews may be shortened. [Hermes API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) |
| **OpenClaw on the Mac** | Connect to the gateway’s opt-in Responses endpoint with an explicit agent ID. A fresh session key per case separates conversation histories. | Start with final-output grading. Expose internal tool grades once an event source or scenario tool independently supplies the required evidence. A client-side function call in a response is a request for a tool, and still requires a result. Use a dedicated gateway for evaluation given its operator credential scope. [OpenClaw OpenResponses](https://docs.openclaw.ai/gateway/openresponses-http-api) |
| **Microsoft Foundry** | Call a published Agent Application’s Responses endpoint with Entra credentials scoped to invoke that application. | Verify which deployment/version the app currently routes to and capture it where available. Trace access through Application Insights is a separate integration. [Foundry Agent Applications](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/agent-applications) · [Foundry tracing](https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/trace-agent-setup) |
| **OpenAI** | For an OpenAI-managed Agents API application, use the owner’s actual agent configuration, session and event protocol. For an Agents SDK deployment operated by the owner, call the owner’s service endpoint. | Verify the same instructions, tools, permissions and handlers as the deployment being assessed. A model name and API key alone do not identify that deployment. [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview) · [Agent runtimes](https://developers.openai.com/api/docs/guides/agents) |
| **AWS** | For Bedrock AgentCore Runtime, invoke the runtime ARN and endpoint qualifier with an isolated session ID. Its payload belongs to the deployed application. For Bedrock Agents, use the separate InvokeAgent interface with agent ID and alias. | Verify request/response mapping and credentials for the chosen AWS product. Add CloudWatch spans or Bedrock trace data only when configured and accessible. [AgentCore invocation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-invoke-agent.html) · [Bedrock Agents](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-invoke-agent.html) · [AgentCore observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-get-started.html) |

## The experience worth building

**Connect once in Workspace → Agents.** Give the deployment a name and version, select its connection, and test its actual capabilities. Show whether DASH can get final answers, observe completed tool calls, correlate sessions, cancel, or recover from a disconnect. A connection test should be distinct from running a billable or state-changing task. An owner-operated HTTP agent can participate with a request mapping and final-answer mapping, even when it shares no internal traces.

**Run from Domains → Scenario → Evaluate an agent.** Start with one visible example. For a dataset run, send only the scenario instructions, case input, approved evidence and permitted tool configuration. Keep answer keys, hidden cases and grader prompts in DASH. Start a fresh session and tool fixture for each independent case and candidate. For multi-turn cases, retain the session across that case’s scripted turns. Account for cross-session agent memory separately. A loopback endpoint can still call a cloud model or external tools, so the registration should identify the deployment’s actual data path.

**Show what the evidence can support.** Score final correctness, observed tool behavior, and business disposition independently. A tool name in a stream establishes an attempt. A completed call with the matching arguments and a returned record establishes much more. A test tool’s own receipt can verify the revision fetched by a remote agent even when its private trace is unavailable. If a required observation is missing, mark that check *unobserved*. Show evidence coverage alongside pass rate and keep runtime failures in the case count. A strong judge rationale cannot override an incorrect deterministic decision.

### A concrete manufacturing test

Give the agent a lot with a measured dimension of **10.04 mm** and a part number. Serve two revisions of the specification through a read-only lookup. Revision A allowed **10.00 ± 0.05 mm**. Current revision B allows **10.00 ± 0.03 mm**. Keep the expected disposition in DASH.

| Observation | How DASH should grade it |
| --- | --- |
| The agent fetches revision B and flags the lot for review with the 10.03 mm upper bound. | Pass the disposition and arithmetic checks. Pass the lookup check when a correlated tool receipt or sufficiently detailed provider event shows revision B. |
| It answers “hold” correctly, but its host exposes only final text. | Pass the disposition check. Display *lookup unobserved*. |
| It fetches revision A and clears the lot. | Show a missed hold. Link the obsolete lookup to the case when the evidence is available. |

The existing Financial Services earnings seed gives us an earlier end-to-end proof with eight cases and a known grader. Manufacturing is the proof that tool behavior can change a real domain decision. Scenario fixtures should hold approved reference material only. A hosted agent needs an explicitly connected test tool or an importable snapshot to read local reference data.

## What DASH must persist

- **Connection and revision.** Stable agent identity, provider, deployment locator, version or owner-supplied build label with its provenance, and declared model/tool configuration. Keep credentials in the platform credential store and out of exports. Mark unknown revisions explicitly.
- **Attempt.** Run, case, candidate, isolated session, remote run ID, start/finish, terminal outcome, retry relationship and event cursor when available. Persist the attempt before remote dispatch. Deduplicate events and reattach or poll after reconnect. Treat an ambiguous dispatch as unknown until reconciled. Retry automatically only when the provider guarantees the same execution for the same key.
- **Evidence and grades.** Distinguish DASH orchestration events from agent/tool events. Store ordered, redacted evidence with its origin, correlation ID, completeness and fixture revision. Associate each score, rationale and threshold with the exact grader version. A run needing human approval should surface that state. The scenario can expect escalation and grade that behavior.
- **Progress over time.** Compare agent v1 and v2 on identical case IDs, dataset version, fixture/tool permissions, session policy and grader versions. Show fixed cases, regressions, critical misses, ungraded cases and sample sizes. A changed dataset or rubric starts another series or triggers explicit regrading of the same saved outputs. For variable behavior, repeat cases in fresh sessions and report the spread. Attribute remote costs and tokens only where supplied. Whole-Mac watts measure the client or local machine, depending on where inference actually runs.

DASH should own the run, assessments and case-level evidence locally. Opik or OpenTelemetry can contribute additional spans if available. Users can perform final-answer evaluation and compare saved versions without adopting an observability service.

## First release gate

1. Connect a real local Hermes evaluation profile. One click from Earnings Release Capture starts a single case. Verify separation of supplied input and hidden reference.
2. Run all eight cases, reopen the run after restarting DASH, and trace a failure to its original answer and grade.
3. Exercise a read-only lookup, an unavailable tool, user approval and a dropped connection. Verify that an uncertain completion cannot execute twice on an automatic retry. Verify that separate cases cannot recall one another’s inputs.
4. Run a changed agent version against the same snapshot. Find one case-level change in the history view and inspect the two outputs and their observed actions.
5. Add OpenClaw through the same contract. Its final-answer-only path must remain useful with partial tool visibility. Add cloud adapters once a real owner deployment and suitable test credentials are available.

**Decision.** Prioritize the Hermes vertical slice ahead of a multi-cloud connector gallery. The meaningful milestone is reopening a domain regression and showing which agent behavior changed it.

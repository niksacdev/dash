# 0003. Keep DASH independent and use TypeScript across Electron

**Status** Accepted

## Decision

Ship DASH from its own repository. Author the renderer, preload, Electron main process and evaluation runner in TypeScript. Compile the UI separately with browser types. The preload exposes a narrow IPC bridge, and the main process owns local I/O and validates incoming requests. Keep domain and scoring logic importable from Node without opening a window.

Use Opik through its published npm package and native service APIs. A local Opik deployment runs the upstream server in containers and retains its own data volumes. The workbench can still run offline. A configured hosted service remains an operator choice. [Official Opik repository](https://github.com/comet-ml/opik)

## Alternatives and trade-offs

Rust can send traces to Opik via OpenTelemetry and call REST endpoints. Opik maintains evaluation SDKs for Python and TypeScript. Using TypeScript preserves access to its G-Eval implementation and its experiment, prompt and dataset APIs inside the supported Electron/Node environment. Inference runs in the chosen runtime or hosted endpoint. Changing the desktop language alone does not establish a reduction in inference latency. [Opik SDK support](https://www.comet.com/docs/opik/faq) · [Opik OpenTelemetry support](https://www.comet.com/docs/opik/integrations/opentelemetry)

A fork would be justified if DASH needed to modify the upstream server. Domain workflows, local measurements and approval policy can be implemented against the SDK. Keeping those decisions in DASH permits upstream upgrades independently. [Electron process boundaries](https://www.electronjs.org/docs/latest/tutorial/ipc)

## Acceptance

A clean build must typecheck both processes. The same synthetic case must keep its grade and its recorded evidence through the real candidate and grading paths. A saved pre-migration evaluation must remain inspectable. Fresh-profile Electron tests must exercise both run types. Synchronizing existing outputs must keep their dataset/prompt versions and avoid another inference call, including after a retry.

# 0027. Use LM Studio’s SDK for explicit local model loading

**Status** Accepted

Extends [0023 · Workflow failures](0023-workflow-failures.md).

## Operator decision

An operator can load two downloaded checkpoints for comparison and tell which instances are resident. DASH already uses the official LM Studio TypeScript SDK for token measurement and prediction. Its **Load** control previously wrote to the native HTTP interface and separately read the model inventory to verify the result.

## Implementation

Use a short-lived Node worker with its own loopback SDK client for each explicit load. Token measurement and prediction keep their shared client. The operation checks for an exact downloaded local chat model, reuses an existing instance even when it has an alias, and requests a local-device load with the canonical key as its instance identifier. The SDK permits remote resolution by default, so the explicit load sets `deviceIdentifier: null`. Concurrent DASH requests for the same key share one promise. The SDK fixes the requested identifier, which also prevents the server from allocating numbered duplicates for that name.

Authenticate the load connection with a read of SDK instances. Reuse a matching local instance if it appeared since the first check. SDK 2.1.0 keeps unsent messages across a failed handshake. Reconnecting its client during an unrelated read can otherwise send an abandoned load. The worker sends an SDK cancellation at the load deadline when connected. DASH terminates the worker and its sockets before reconciliation, including when authentication stalls. LM Studio can still finish a request it already received.

Keep reading the native inventory to distinguish downloaded, loaded and unconfirmed models. A fresh SDK handle must identify the expected key and a matching active instance before DASH reports success. If the SDK times out or loses its reply, check the inventory once. An inconclusive read produces an unconfirmed status. The operator can refresh just the inventory. A non-DASH client can still change runtime state between reads.

## Alternatives

Maintaining the native HTTP mutation duplicated SDK model management. The SDK’s `.model()` can use just-in-time loading and eviction settings. The explicit `.load()` operation expresses the operator’s decision to keep a checkpoint resident alongside another. Its default behavior can allocate another instance, which is why DASH verifies existing instances and requests a specific identifier. [LM Studio’s model management guide](https://lmstudio.ai/docs/typescript/manage-models/loading)

## Verification

During development, a local Mac probe started with LFM3 1.7B loaded and no running evaluation or queued generation. DASH used SDK 2.1.0 to load Gemma 4 26B A4B QAT. After a second request for Gemma, native inventory still showed one instance of each checkpoint. After isolating the SDK client, a fresh Electron process ran the shipped worker for those same resident checkpoints through a loopback gate that allowed only authentication, `listLoaded` and `getModelInfo`. Each check issued exactly those two reads, returned the expected identifier and left the native inventory unchanged. These probes exercise loading and instance identity. Inference quality requires a separate evaluation.

Tests run the installed SDK against a loopback WebSocket fixture covering denied and stalled authentication, later reads, reuse of a local alias, local-device targeting, a successful reply and cancellation after dispatch. Provider tests cover concurrent requests, occupied names, a lost reply and mismatched handles. An isolated Electron smoke exercises the **Load** control and the visible readiness states. [SDK transport checks](../../dash-desktop/test/lmstudio-load-worker.test.cts) · [Provider checks](../../dash-desktop/test/local-runtime-load.test.cts) · [Operator guide](../reader/src/models.md)

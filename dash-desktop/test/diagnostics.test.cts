import { test } from "node:test";
import assert = require("node:assert/strict");
import { diagnostics } from "../lib/diagnostics.cjs";
import type { RunData, RunResult } from "../lib/run-types.cjs";
import { discover, invoke } from "../lib/providers.cjs";
test("old records retain their recorded scores while developer view separates stages", () => {
  const common: RunResult = {
    output: null, error: null, score: null,
    candidateId: "test",
    caseId: "c",
    trace: { id: "trace", runId: "run", candidateId: "test", caseId: "c", started: "start", finished: "end", steps: [] },
    telemetry: null,
  };
  const failed = { pass: false, reasons: ["Response is invalid JSON"] };
  const results = [
    { ...common, output: "\x60\x60\x60json\n{}\n\x60\x60\x60", score: failed },
    {
      ...common,
      output: "{}",
      score: { pass: false, reasons: ["Mismatch in evidence"] },
    },
    { ...common, error: "Deadline exceeded" },
  ];
  const run: RunData = {
    partial: null, assessments: [],
    status: "completed",
    manifest: {
      id: "run",
      mode: "dataset",
      format: 2, created: "start", fixture: false, title: "Test", caseIds: ["c"],
      pack: null, graders: [], prompt: null, datasetId: null, datasetVersion: null, split: null,
      policyHash: null, promptHash: "prompt", caseSetHash: "case", parameters: {}, animation: false,
      device: {platform:"darwin", arch:"arm64", release:"test"},
      candidates: [{ id: "test", model: "Test", provider:"lmstudio", kind:"model" }],
    },
    results,
  };
  const before = JSON.stringify(run);
  const view = diagnostics(run);
  assert.deepEqual(
    view.traces.map((r) => r.stage),
    ["Output format", "Grading", "Runtime error"],
  );
  assert.match(view.traces[0].note, /Markdown fence/);
  assert.equal(JSON.stringify(run), before);
});
test("session inventory differentiates available models, loaded instances and unavailable inventory", async (t) => {
  let inventory = true;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/api/tags")) return Response.json({ models: [] });
    if (url.endsWith("/v1/models") && !url.includes("/api/"))
      return Response.json({ data: [{ id: "demo" }, { id: "other" }] });
    if (!inventory)
      return Response.json({ error: "unsupported" }, { status: 404 });
    return Response.json({
      models: [
        {
          key: "demo",
          type: "llm",
          loaded_instances: [
            { id: "demo-2", config: { context_length: 8192 } },
          ],
        },
        { key: "other", type: "llm", loaded_instances: [] },
      ],
    });
  });
  const live = (await discover()).find((x) => x.provider === "lmstudio");
  assert.ok(live);
  assert.equal(live.online, true);
  assert.ok(live.instances);
  assert.equal(live.instances[0].id, "demo-2");
  assert.equal(live.instances.length, 1);
  assert.deepEqual(
    live.models.map((x) => x.loaded),
    [true, false],
  );
  inventory = false;
  const legacy = (await discover()).find((x) => x.provider === "lmstudio");
  assert.ok(legacy);
  assert.equal(legacy.online, true);
  assert.equal(legacy.instances, null);
  assert.equal(legacy.models[0].loaded, null);
});
test("a local template rejection identifies the endpoint and a recovery without echoing private runtime text", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: { message: "Template could not render role: SYNTHETIC_CASE_TEXT api_key=secret" } },
      { status: 400 },
    ),
  );
  await assert.rejects(
    invoke({ id:"lmstudio/test", kind:"model", provider: "lmstudio", model: "test" }, [], {
      signal: new AbortController().signal,
    }),
    (error:unknown)=>{
      assert.ok(error instanceof Error);
      assert.match(error.message,/chat\/completions returned HTTP 400.*chat template/);
      assert.doesNotMatch(error.message,/SYNTHETIC_CASE_TEXT|api_key|secret/);
      return true;
    },
  );
});

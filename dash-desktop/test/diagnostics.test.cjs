const { test } = require("node:test");
const assert = require("node:assert/strict");
const { diagnostics } = require("../lib/diagnostics.cjs");
const { discover, invoke } = require("../lib/providers.cjs");
test("old records retain their recorded scores while developer view separates stages", () => {
  const common = {
    candidateId: "test",
    caseId: "c",
    trace: { id: "trace", started: "start", finished: "end" },
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
  const run = {
    status: "completed",
    manifest: {
      id: "run",
      mode: "dataset",
      candidates: [{ id: "test", model: "Test" }],
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
  t.mock.method(globalThis, "fetch", async (url) => {
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
  assert.equal(live.online, true);
  assert.equal(live.instances[0].id, "demo-2");
  assert.equal(live.instances.length, 1);
  assert.deepEqual(
    live.models.map((x) => x.loaded),
    [true, false],
  );
  inventory = false;
  const legacy = (await discover()).find((x) => x.provider === "lmstudio");
  assert.equal(legacy.online, true);
  assert.equal(legacy.instances, null);
  assert.equal(legacy.models[0].loaded, null);
});
test("provider error shows endpoint, HTTP status and the provider's short explanation", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: { message: "Template could not render role" } },
      { status: 400 },
    ),
  );
  await assert.rejects(
    invoke({ provider: "lmstudio", model: "test" }, [], {
      signal: new AbortController().signal,
    }),
    /chat\/completions returned HTTP 400 .*Template could not render role/,
  );
});

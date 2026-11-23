const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Bench, replayCandidate } = require("../lib/bench.cjs");
const { loadPacks, parseDataset, grade } = require("../lib/packs.cjs");
const { invoke } = require("../lib/providers.cjs");
const fixture = (b, d) => ({
  mode: "dataset",
  datasetId: d.id,
  candidateIds: [replayCandidate.id],
});
async function finish(b, config) {
  const id = b.start(config);
  await b.active.done;
  return b.exportRun(id);
}
test("bundled packs score the recorded responses, preserve trace identities and survive a restart", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "runs.db");
  let b = new Bench(file);
  const ids = [];
  for (const d of b.list().datasets) {
    const run = await finish(b, fixture(b, d));
    assert.equal(run.status, "completed");
    assert.equal(run.results.length, d.count);
    assert.equal(run.results.filter((r) => r.score.falseAccept).length, 1);
    assert.equal(run.results.filter((r) => r.score.pass).length, d.count - 1);
    for (const r of run.results) {
      assert.equal(r.trace.caseId, r.caseId);
      assert.equal(r.trace.runId, run.manifest.id);
      assert.equal(r.trace.candidateId, r.candidateId);
      assert.equal(r.telemetry, null);
    }
    ids.push(run.manifest.id);
    const failure = run.results.find((r) => !r.score.pass);
    const rerun = await finish(b, {
      ...fixture(b, d),
      parentId: run.manifest.id,
      caseId: failure.caseId,
    });
    assert.notEqual(rerun.manifest.id, run.manifest.id);
    assert.equal(rerun.results.length, 1);
    assert.equal(rerun.manifest.parentId, run.manifest.id);
  }
  b.db.close();
  b = new Bench(file);
  assert.equal(b.list().runs.length, ids.length * 2);
  assert.ok(ids.every((id) => b.exportRun(id).cases.length > 1));
  b.db.close();
});
test("model boundary excludes reference labels and distinguishes runtime failure from wrong answers", async () => {
  const c = {
    id: "test/local",
    model: "lfm3-local",
    provider: "lmstudio",
    loaded: true,
    kind: "model",
    revision: "v1",
  };
  let calls = 0;
  const b = new Bench(":memory:", {
    discover: async () => [{ models: [c] }],
    invoke: async (candidate, messages, options) => {
      assert.equal(candidate.id, c.id);
      assert.equal(messages.length, 2);
      if (options.structured?.properties?.requirements)
        return { output: JSON.stringify({title: "Extract earnings", metrics: ["Correct values"], requirements: ["Ground answers in the case"]}) };
      if (options.structured?.properties?.prompt)
        return { output: JSON.stringify({prompt: "Use the provided earnings release."}) };
      const payload = JSON.parse(messages[1].content);
      assert.deepEqual(Object.keys(payload).sort(), [
        "input",
        "source_locator",
      ]);
      assert.equal("gold" in payload.input, false);
      if (++calls === 2) throw Error("test provider offline");
      options.onText("invalid");
      return { output: "invalid", telemetry: { latency_ms: 7 } };
    },
  });
  await b.refresh();
  const d = b.list().datasets[0];
  const draft = await b.designPrompt({mode:"dataset", datasetId:d.id, objective:"Extract the disclosed EPS."});
  const approved = b.workflow.approve({draftId:draft.draftId, prompt:draft.prompt});
  const run = await finish(b, {
      approvedPromptId: approved.id,
      mode: "dataset",
      datasetId: d.id,
      candidateIds: [c.id],
    });
  assert.equal(run.status, "failed");
  assert.equal(run.results.length, 8);
  assert.equal(run.results[0].score.review, true);
  assert.equal(run.results[1].score, null);
  assert.equal(run.results[1].error, "test provider offline");
  b.db.close();
});
test("cancellation preserves the run and stops work", async () => {
  const b = new Bench(":memory:"),
    d = b.list().datasets[0],
    id = b.start(fixture(b, d));
  assert.throws(() => b.start(fixture(b, d)), /active/);
  b.stop(id);
  await b.active.done;
  assert.equal(b.detail(id).status, "canceled");
  assert.equal(b.detail(id).results.length, 0);
  b.db.close();
});
test("dataset imports reject duplicates, report line numbers and preserve snapshots", () => {
  const { pack, rows, replay } = loadPacks().find(
    (x) => x.pack.id === "earnings",
  );
  const line = JSON.stringify(rows[0]);
  assert.throws(
    () => parseDataset(line + "\n" + line, pack),
    /Line 2:.*duplicate/,
  );
  assert.throws(() => parseDataset('{"input":', pack), /Line 1/);
  const zero = rows.find((r) => r.case_id === "eps-zero");
  assert.ok(
    grade(
      pack,
      zero,
      JSON.stringify({ ...replay["eps-zero"], value: "-0.000" }),
    ).pass,
  );
  const absent = rows.find((r) => r.case_id === "eps-absent");
  assert.equal(
    grade(
      pack,
      absent,
      JSON.stringify({ ...replay["eps-absent"], value: "0.00" }),
    ).pass,
    false,
  );
  const b = new Bench(":memory:"),
    key = b.import(pack.id, "mini", line);
  assert.equal(b.import(pack.id, "mini", line), key);
  assert.notEqual(
    b.import(
      pack.id,
      "mini",
      JSON.stringify({ ...rows[0], case_id: "another" }),
    ),
    key,
  );
  assert.throws(() => b.start(fixture(b, { id: key })), /bundled dataset/);
  b.db.close();
});
test("both streaming adapters send identical prompt content, reconstruct text and retain usage", async (t) => {
  const messages = [{ role: "user", content: "Short test" }];
  for (const provider of ["ollama", "lmstudio"]) {
    const stream =
      provider === "ollama"
        ? [
            '{"message":{"content":"Hi"}}',
            '{"message":{"content":"!"},"done":true,"prompt_eval_count":4,"eval_count":2}',
          ]
        : [
            'data: {"choices":[{"delta":{"content":"Hi"}}]}',
            "",
            'data: {"choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":4,"completion_tokens":2}}',
            "",
            "data: [DONE]",
          ];
    const mock = t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.ok(url.startsWith("http://127.0.0.1:"));
      assert.deepEqual(JSON.parse(options.body).messages, messages);
      return new Response(stream.join("\n") + "\n");
    });
    const result = await invoke({ provider, model: "test" }, messages, {
      signal: new AbortController().signal,
    });
    assert.equal(result.output, "Hi!");
    assert.equal(result.telemetry.input_tokens, 4);
    assert.equal(result.telemetry.output_tokens, 2);
    mock.mock.restore();
  }
});

test("duplicate JSON keys cannot silently replace a conflicting financial fact", () => {
  const { pack, rows, replay } = loadPacks().find(
    (x) => x.pack.id === "earnings",
  );
  const correct = JSON.stringify(replay["rev-scale"]);
  const ambiguous = correct.replace("{", '{"value":"999",');
  const score = grade(pack, rows[0], ambiguous);
  assert.equal(score.falseAccept, true);
  assert.ok(score.reasons.includes("Duplicate output key: value"));
  assert.equal(grade(pack, rows[0], correct).pass, true);
});
